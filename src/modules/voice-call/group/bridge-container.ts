import path from 'path';

import { WebSocket } from 'undici';

import { CONTAINER_IMAGE } from '../../../config.js';
import { runRuntime } from '../../../container-runtime.js';
import { log } from '../../../log.js';
import { BRIDGE_SCRIPT, livekitClientScript } from './bridge-page.js';
import { VOICE_LABEL, VOICE_NETWORK } from './livekit.js';

const RUNTIME_TIMEOUT_MS = 30_000;
const CDP_TIMEOUT_MS = 20_000;
/** Docker's default seccomp profile plus the four calls Chromium's namespace sandbox needs. */
const SECCOMP_PROFILE = path.resolve(process.cwd(), 'container', 'voice-bridge', 'seccomp-chromium.json');
// Chromium binds its debugging port to loopback, so a forwarder publishes it; the blank page on the container's own
// localhost is a secure context, which getUserMedia-free WebRTC and AudioWorklet still require.
const FORWARDER =
  "const n=require('net');n.createServer(c=>{const u=n.connect(9222,'127.0.0.1');c.pipe(u);u.pipe(c);" +
  "c.on('error',()=>u.destroy());u.on('error',()=>c.destroy())}).listen(9223,'0.0.0.0');" +
  "require('http').createServer((q,s)=>{s.writeHead(200,{'content-type':'text/html'});" +
  "s.end('<!doctype html><title>bridge</title>')}).listen(8080,'127.0.0.1')";

export interface BridgeSnapshot {
  frames: number[][];
  pieces: Array<{ at: number; startMs: number; endMs: number; text: string }>;
  delegations: Array<{ id: string; at: number }>;
  slots: Record<string, number>;
  live: string | null;
  /** The voice's track in the room: published, or heard once someone in the room has it connected. */
  voice: 'published' | 'heard' | null;
  room: string | null;
  people: string[];
}

class Cdp {
  private seq = 0;
  private readonly waiting = new Map<number, (message: Record<string, unknown>) => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      const message = JSON.parse(event.data) as { id?: number };
      if (message.id) this.waiting.get(message.id)?.(message);
    };
    socket.onclose = () => {
      for (const resolve of this.waiting.values()) resolve({ error: { message: 'closed' } });
      this.waiting.clear();
    };
  }

  static async attach(port: number): Promise<Cdp> {
    const deadline = Date.now() + CDP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const targets = (await (
          await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) })
        ).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
        const page = targets.find((target) => target.type === 'page');
        if (page) {
          const socket = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise<void>((resolve, reject) => {
            socket.onopen = () => resolve();
            socket.onerror = () => reject(new Error('debugger connection failed'));
          });
          return new Cdp(socket);
        }
      } catch {
        /* not up yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('The call bridge browser did not start.');
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method} timed out`));
      }, CDP_TIMEOUT_MS);
      this.waiting.set(id, (message) => {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve(message);
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval<T>(expression: string): Promise<T> {
    const message = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const result = message.result as
      | { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } }
      | undefined;
    if (message.error || !result) throw new Error(`bridge: ${JSON.stringify(message.error ?? 'no result')}`);
    if (result.exceptionDetails)
      throw new Error(`bridge: ${result.exceptionDetails.exception?.description?.slice(0, 300) ?? 'exception'}`);
    return result.result?.value as T;
  }

  async navigate(url: string): Promise<void> {
    await this.send('Page.navigate', { url });
    const deadline = Date.now() + CDP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = await this.eval<string>('location.href + "|" + document.readyState').catch(() => '');
      if (state.startsWith(url) && state.endsWith('|complete')) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`bridge: ${url} did not load`);
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      /* already closed */
    }
  }
}

export class BridgeBrowser {
  private constructor(
    readonly name: string,
    private readonly cdp: Cdp,
  ) {}

  static async start(callId: string, maxSeconds: number): Promise<BridgeBrowser> {
    const name = `nanoclaw-voice-bridge-${callId.slice(0, 12)}`;
    await runRuntime(['rm', '-f', name], RUNTIME_TIMEOUT_MS).catch(() => undefined);
    await runRuntime(
      [
        'run',
        '-d',
        '--rm',
        '--name',
        name,
        '--label',
        VOICE_LABEL,
        '--network',
        VOICE_NETWORK,
        '--user',
        'node',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--security-opt',
        `seccomp=${SECCOMP_PROFILE}`,
        '--memory',
        '1g',
        '--pids-limit',
        '512',
        '-p',
        '127.0.0.1::9223',
        '--entrypoint',
        'sh',
        CONTAINER_IMAGE,
        '-c',
        `node -e "${FORWARDER}" & exec timeout ${maxSeconds} chromium --headless=new --disable-gpu ` +
          '--remote-debugging-port=9222 --autoplay-policy=no-user-gesture-required about:blank',
      ],
      RUNTIME_TIMEOUT_MS,
    );
    let cdp: Cdp | null = null;
    try {
      const mapped = (await runRuntime(['port', name, '9223/tcp'], RUNTIME_TIMEOUT_MS)).trim().split('\n')[0];
      const port = Number(mapped.split(':').pop());
      if (!Number.isInteger(port) || port <= 0) throw new Error(`bridge: no debugging port (${mapped})`);
      cdp = await Cdp.attach(port);
      await cdp.navigate('chrome://sandbox');
      const sandbox = await cdp.eval<string>('document.body.innerText');
      if (!/adequately sandboxed/i.test(sandbox)) throw new Error('bridge: Chromium is not sandboxed');
      await cdp.navigate('http://localhost:8080/');
      await cdp.eval(`${livekitClientScript()};true`);
      await cdp.eval(BRIDGE_SCRIPT);
      return new BridgeBrowser(name, cdp);
    } catch (err) {
      cdp?.close();
      await runRuntime(['rm', '-f', name], RUNTIME_TIMEOUT_MS).catch(() => undefined);
      throw err;
    }
  }

  join(url: string, token: string): Promise<boolean> {
    return this.cdp.eval(`B.join(${JSON.stringify(url)}, ${JSON.stringify(token)})`);
  }

  liveOffer(): Promise<string> {
    return this.cdp.eval('B.liveOffer()');
  }

  liveAnswer(sdp: string): Promise<boolean> {
    return this.cdp.eval(`B.liveAnswer(${JSON.stringify(sdp)})`);
  }

  collect(): Promise<BridgeSnapshot> {
    return this.cdp.eval('B.collect()');
  }

  async stop(): Promise<void> {
    await this.cdp.eval('B.leave()').catch(() => undefined);
    this.cdp.close();
    await runRuntime(['rm', '-f', this.name], RUNTIME_TIMEOUT_MS).catch((err: unknown) =>
      log.warn('Group call: could not remove the bridge', { name: this.name, err }),
    );
  }
}
