import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../test-hermeticity.js';

import { processAncestry } from './process-ancestry.js';
import { dispatch } from './dispatch.js';
import type { RequestFrame } from './frame.js';
import { markCliServerReady, startCliServer, stopCliServer } from './socket-server.js';

vi.mock('./dispatch.js', () => ({
  dispatch: vi.fn(async (req: RequestFrame) => ({ id: req.id, ok: true, data: null })),
}));

allowSubprocess(['flock']);
enforceHermeticity();

const dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-origin-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await stopCliServer();
  vi.mocked(dispatch).mockClear();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeProcess(root: string, pid: number, argv: string[], stat: string): void {
  fs.mkdirSync(path.join(root, String(pid)));
  fs.writeFileSync(path.join(root, String(pid), 'cmdline'), argv.join('\0') + '\0');
  fs.writeFileSync(path.join(root, String(pid), 'stat'), stat);
}

describe('processAncestry', () => {
  it('walks parents nearest first, reading the parent pid past a comm holding spaces and parentheses, and stops at init', () => {
    const root = tmpDir();
    fakeProcess(root, 300, ['/bin/bash', '-c', 'ncl approvals choose --id appr-1'], '300 (ba sh) S 200 300 0');
    fakeProcess(root, 200, ['/usr/local/bin/fixture-agent', 'exec'], '200 (agent) (x)) S 1 200 0');

    expect(processAncestry(300, root)).toEqual(['300: bash', '200: fixture-agent']);
  });

  it('names each program, never its arguments, so a credential in a command line is not reported', () => {
    const root = tmpDir();
    fakeProcess(root, 300, ['bash', '-c', 'FIXTURE_TOKEN=tok-123 ncl approvals choose'], '300 (bash) S 250 300 0');
    fakeProcess(
      root,
      250,
      ['/usr/bin/node', '/opt/fixture/agent-cli.js', '--key', 'tok-456'],
      '250 (node) S 240 250 0',
    );
    fakeProcess(root, 240, ['python3', '-c', 'print("tok-789")'], '240 (python3) S 1 240 0');

    const ancestry = processAncestry(300, root);

    expect(ancestry).toEqual(['300: bash', '250: node agent-cli.js', '240: python3']);
    expect(ancestry.join('\n')).not.toMatch(/tok-/);
  });

  it('keeps what it read when a parent has already exited', () => {
    const root = tmpDir();
    fakeProcess(root, 300, ['bash'], '300 (bash) S 250 300 0');

    expect(processAncestry(300, root)).toEqual(['300: bash']);
  });
});

async function send(socketPath: string, frame: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const conn = net.connect(socketPath, () => conn.write(JSON.stringify(frame) + '\n'));
    conn.on('data', () => conn.end());
    conn.on('close', () => resolve());
    conn.on('error', reject);
  });
}

describe('the host socket hands the reported origin to the command', () => {
  it.each([
    [['300: bash -c ncl approvals choose'], { caller: 'host', origin: ['300: bash -c ncl approvals choose'] }],
    ['not a list', { caller: 'host' }],
    [undefined, { caller: 'host' }],
  ])('origin %j reaches dispatch as %j', async (origin, ctx) => {
    const socketPath = path.join(tmpDir(), 's.sock');
    await startCliServer(socketPath);
    markCliServerReady();

    await send(socketPath, { id: 'req-1', command: 'approvals-choose', args: {}, origin });

    expect(vi.mocked(dispatch).mock.calls.map((call) => call[1])).toEqual([ctx]);
  });
});
