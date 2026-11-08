#!/usr/bin/env node
// Runs the real gws with inherited stdio and records each Sheets call, with its exit status, to the source ledger.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REAL = process.env.NANOCLAW_GWS_REAL || '/pnpm/gws-real';
const LEDGER = process.env.NANOCLAW_SOURCE_LEDGER || '/tmp/nanoclaw-sources/ledger.jsonl';
const MAX_LEDGER_BYTES = 256 * 1024 * 1024;

const argv = process.argv.slice(2);
const run = spawnSync(REAL, argv, { stdio: 'inherit' });
const status = run.status ?? (run.signal ? 1 : run.error ? 127 : 0);

if (argv.some((a) => a === 'sheets' || a.startsWith('sheets:'))) {
  try {
    let size = 0;
    try {
      size = fs.statSync(LEDGER).size;
    } catch {}
    if (size <= MAX_LEDGER_BYTES) {
      fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
      const entry = { v: 1, ts: new Date().toISOString(), recorder: 'gws', argv, ok: status === 0 };
      fs.appendFileSync(LEDGER, `${JSON.stringify(entry)}\n`);
    }
  } catch {}
}

if (run.error) process.stderr.write(`gws: ${run.error.message}\n`);
if (run.signal) process.kill(process.pid, run.signal);
process.exit(status);
