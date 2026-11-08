import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const LINK = 'a'.repeat(32);
const PAGE_TOKEN = 'page-token-3f9c';
const ORIGIN = `https://${LINK}.calls.example`;

vi.mock('../../../log.js', async (orig) => ({
  ...(await orig<typeof import('../../../log.js')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('./service.js', () => ({
  linkFor: (id: string) =>
    id === LINK
      ? { call: { id: 'call-5e1d2c3b4a', agentName: 'Pixel', route: {} }, person: { pageToken: PAGE_TOKEN } }
      : null,
  gate: { handleRequest: () => false },
  groupCallUrl: (id: string) => `https://${id}.calls.example`,
  claimLink: vi.fn(),
  leave: vi.fn(),
  listen: vi.fn(),
}));

const { log } = await import('../../../log.js');
const { handleGroupCallRequest } = await import('./http.js');

let server: http.Server;
let port: number;

function postMic(query: string, body: unknown, origin = ORIGIN) {
  return new Promise<number>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: `/mic${query}`, headers: { origin } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

const micLines = () => vi.mocked(log.info).mock.calls.filter(([msg]) => msg === 'Voice call: microphone');

beforeEach(async () => {
  vi.mocked(log.info).mockClear();
  server = http.createServer((req, res) => {
    if (!handleGroupCallRequest(LINK, req, res)) res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
});

describe('group call POST /mic', () => {
  const report = { echoCancellation: false, autoGainControl: true, browser: 'android-webview', label: 'Example Mic' };

  it('logs the validated report once for this page’s token', async () => {
    expect(await postMic(`?t=${PAGE_TOKEN}`, report)).toBe(200);
    expect(micLines()).toEqual([
      [
        'Voice call: microphone',
        { callId: 'call-5e1', echoCancellation: false, autoGainControl: true, browser: 'android-webview' },
      ],
    ]);
  });

  it.each([
    ['no token', ''],
    ['a wrong token of the same length', `?t=${'x'.repeat(PAGE_TOKEN.length)}`],
    ['a prefix of the token', `?t=${PAGE_TOKEN.slice(0, -1)}`],
  ])('refuses %s and logs nothing', async (_name, query) => {
    expect(await postMic(query, report)).toBe(403);
    expect(micLines()).toEqual([]);
  });

  it('answers a malformed body without logging it', async () => {
    expect(await postMic(`?t=${PAGE_TOKEN}`, '{"echoCancellation": tru')).toBe(200);
    expect(micLines()).toEqual([]);
  });

  it('refuses another origin even with the token', async () => {
    expect(await postMic(`?t=${PAGE_TOKEN}`, report, 'https://other.calls.example')).toBe(403);
    expect(micLines()).toEqual([]);
  });
});
