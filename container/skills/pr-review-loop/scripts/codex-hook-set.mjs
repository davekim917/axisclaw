// codex itself answers (`hooks/list`), so feature flags, trust rows and TOML syntax are judged as codex judges them.
//
//   codex-hook-set.mjs <codex-home> [app-server config flags…]
//     prints the hooks codex dispatches under that home: source, home-relative key, handler hash.
//   codex-hook-set.mjs --sync <from-home> <to-home> [app-server config flags…]
//     trusts, under <to-home>, each hook <from-home> already dispatches whose handler in <to-home> is enabled,
//     byte-identical (same hash) and untrusted only; prints the rows it trusted. It never trusts a hook <from-home>
//     does not, never enables one, and writes only <to-home>'s own hook trust rows, through codex's config write.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

const sync = process.argv[2] === '--sync';
const [from, to] = sync ? process.argv.slice(3, 5) : [process.argv[2], undefined];
const flags = process.argv.slice(sync ? 5 : 3);
if (!from || (sync && !to)) {
  console.error('usage: codex-hook-set.mjs [--sync <from-home>] <codex-home> [app-server config flags…]');
  process.exit(2);
}

function fail(home, message) {
  console.error(`codex-hook-set: ${home}: ${message}`);
  process.exit(1);
}

function appServer(home, requests) {
  return new Promise((resolve) => {
    const server = spawn(process.env.CODEX_REAL_BIN || 'codex', ['app-server', '--listen', 'stdio://', ...flags], {
      env: { ...process.env, CODEX_HOME: home },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const stop = (message) => {
      server.kill('SIGKILL');
      fail(home, message);
    };
    const timer = setTimeout(() => stop('no answer within 30s'), 30_000);
    server.on('error', (err) => stop(err.message));
    server.on('close', (code) => stop(`app-server exited (${code}) before answering`));
    const send = (id, method, params) => server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const results = [];
    readline.createInterface({ input: server.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof msg.id !== 'number' || msg.method) return;
      if (msg.error) stop(`${msg.id === 1 ? 'initialize' : requests[msg.id - 2].method} failed: ${msg.error.message}`);
      if (msg.id > 1) results.push(msg.result);
      const next = requests[msg.id - 1];
      if (next) {
        send(msg.id + 1, next.method, next.params);
        return;
      }
      clearTimeout(timer);
      server.removeAllListeners('close');
      server.kill('SIGTERM');
      resolve(results);
    });
    send(1, 'initialize', { clientInfo: { name: 'codex-exec', version: '1.0.0' }, capabilities: {} });
  });
}

const dispatched = (hook) =>
  hook?.enabled === true && ['trusted', 'managed'].includes(String(hook.trustStatus).toLowerCase());

async function hooksOf(home) {
  const [list] = await appServer(home, [{ method: 'hooks/list', params: {} }]);
  if (!Array.isArray(list?.data)) fail(home, 'hooks/list response has no data array');
  const prefixes = [home, fs.realpathSync(home)].map((dir) => `${dir.replace(/\/+$/, '')}/`);
  return list.data
    .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
    .map((hook) => {
      const key = String(hook.key);
      const prefix = prefixes.find((p) => key.startsWith(p));
      return { hook, relativeKey: prefix ? key.slice(prefix.length) : key };
    });
}

if (!sync) {
  const rows = (await hooksOf(from))
    .filter(({ hook }) => dispatched(hook))
    .map(({ hook, relativeKey }) => `${hook.source ?? ''}\t${relativeKey}\t${hook.currentHash ?? ''}`);
  process.stdout.write(rows.length ? `${rows.join('\n')}\n` : '', () => process.exit(0));
} else {
  const source = (await hooksOf(from)).filter(({ hook }) => dispatched(hook));
  const target = await hooksOf(to);
  const trust = {};
  const synced = [];
  for (const { hook, relativeKey } of source) {
    const match = target.find(
      (entry) => entry.relativeKey === relativeKey && (entry.hook.source ?? '') === (hook.source ?? ''),
    );
    if (!match || match.hook.enabled !== true || dispatched(match.hook)) continue;
    if (!hook.currentHash || match.hook.currentHash !== hook.currentHash) continue;
    trust[String(match.hook.key)] = { trusted_hash: hook.currentHash };
    synced.push(`${hook.source ?? ''}\t${relativeKey}`);
  }
  if (synced.length > 0) {
    await appServer(to, [
      {
        method: 'config/batchWrite',
        params: { edits: [{ keyPath: 'hooks.state', mergeStrategy: 'upsert', value: trust }] },
      },
    ]);
  }
  process.stdout.write(synced.length ? `${synced.join('\n')}\n` : '', () => process.exit(0));
}
