import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  emailSignaturesDirFor,
  gwsAccountEnv,
  stageEmailSignatures,
  refreshEmailSignatures,
  refreshEmailSignaturesIfDue,
  SIGNATURE_REFRESH_INTERVAL_MS,
  type ReadSendAs,
} from './refresh.js';

let root: string;
let dir: string;
const signatureOf = (account: string) => path.join(dir, `${account}.signature.html`);
const mailboxOf = (account: string) => path.join(dir, `${account}.mailbox`);
const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const listing = (...sendAs: object[]) => ({ sendAs });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'email-signatures-'));
  dir = path.join(root, 'accounts');
  fs.mkdirSync(dir);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('refreshEmailSignatures', () => {
  it("writes each account's default send-as signature beside its credentials, and reads with that account's own file", async () => {
    for (const name of ['acme.json', 'beta.json', 'old.json.bak', 'beta.signature.html'])
      fs.writeFileSync(path.join(dir, name), 'x');
    const readWith: string[] = [];
    const readSendAs: ReadSendAs = async (file) => {
      readWith.push(path.basename(file));
      return file.endsWith('acme.json')
        ? listing(
            { isPrimary: true, sendAsEmail: 'pat@acme.example', signature: '<b>Primary</b>' },
            { isDefault: true, sendAsEmail: 'team@acme.example', signature: ' <b>Pat Doe</b>\n' },
          )
        : listing({ isDefault: true, isPrimary: true, sendAsEmail: 'lee@example.org', signature: '' });
    };

    const result = await refreshEmailSignatures({ accountsDir: dir, readSendAs });

    expect(readWith).toEqual(['acme.json', 'beta.json']);
    expect(result).toEqual({ written: ['acme'], cleared: ['beta'], failed: [] });
    expect(fs.readFileSync(signatureOf('acme'), 'utf8')).toBe('<b>Pat Doe</b>\n');
    expect(fs.existsSync(signatureOf('beta'))).toBe(false);
  });

  it('records the primary address with the hash of the credentials it was read with, only while it is the default', async () => {
    fs.writeFileSync(path.join(dir, 'acme.json'), '{"refresh_token":"a"}');
    fs.writeFileSync(path.join(dir, 'beta.json'), '{"refresh_token":"b"}');
    fs.writeFileSync(mailboxOf('beta'), '{"credentialsSha256":"old","mailbox":"lee@example.org"}\n');
    const readSendAs: ReadSendAs = async (file) =>
      file.endsWith('acme.json')
        ? listing({ isDefault: true, isPrimary: true, sendAsEmail: 'pat@example.com', signature: '' })
        : listing(
            { isPrimary: true, sendAsEmail: 'lee@example.org', signature: '' },
            { isDefault: true, sendAsEmail: 'team@example.org', signature: '' },
          );

    await refreshEmailSignatures({ accountsDir: dir, readSendAs });

    expect(JSON.parse(fs.readFileSync(mailboxOf('acme'), 'utf8'))).toEqual({
      credentialsSha256: sha256('{"refresh_token":"a"}'),
      mailbox: 'pat@example.com',
    });
    expect(fs.existsSync(mailboxOf('beta'))).toBe(false);
  });

  it('hashes the bytes that were read, even when the credentials file is replaced during the read', async () => {
    fs.writeFileSync(path.join(dir, 'acme.json'), '{"refresh_token":"a"}');
    const readSendAs: ReadSendAs = async () => {
      fs.writeFileSync(path.join(dir, 'acme.json'), '{"refresh_token":"swapped"}');
      return listing({ isDefault: true, isPrimary: true, sendAsEmail: 'pat@example.com', signature: '' });
    };

    await refreshEmailSignatures({ accountsDir: dir, readSendAs });

    expect(JSON.parse(fs.readFileSync(mailboxOf('acme'), 'utf8')).credentialsSha256).toBe(
      sha256('{"refresh_token":"a"}'),
    );
  });

  it("leaves an account's copy as it was when Gmail can't be read or names no default", async () => {
    fs.writeFileSync(path.join(dir, 'acme.json'), 'x');
    fs.writeFileSync(path.join(dir, 'beta.json'), 'x');
    fs.writeFileSync(signatureOf('acme'), '<b>Old</b>\n');
    fs.writeFileSync(signatureOf('beta'), '<b>Old</b>\n');
    const readSendAs: ReadSendAs = async (file) => {
      if (file.endsWith('acme.json')) throw new Error('network down');
      return listing({ isPrimary: true, signature: '<b>Primary, not default</b>' });
    };

    expect(await refreshEmailSignatures({ accountsDir: dir, readSendAs })).toEqual({
      written: [],
      cleared: [],
      failed: ['acme', 'beta'],
    });
    expect([fs.readFileSync(signatureOf('acme'), 'utf8'), fs.readFileSync(signatureOf('beta'), 'utf8')]).toEqual([
      '<b>Old</b>\n',
      '<b>Old</b>\n',
    ]);
  });

  it('a broken credentials link fails only its own account', async () => {
    fs.symlinkSync(path.join(root, 'missing.json'), path.join(dir, 'acme.json'));
    fs.writeFileSync(path.join(dir, 'zeta.json'), 'x');
    const readSendAs: ReadSendAs = async () =>
      listing({ isDefault: true, sendAsEmail: 'z@example.net', signature: '<b>Z</b>' });

    expect(await refreshEmailSignatures({ accountsDir: dir, readSendAs })).toEqual({
      written: ['zeta'],
      cleared: [],
      failed: ['acme'],
    });
  });

  it('an account named like an email address is refreshed too', async () => {
    fs.writeFileSync(path.join(dir, 'pat@example.com.json'), 'x');
    const readSendAs: ReadSendAs = async () =>
      listing({ isDefault: true, sendAsEmail: 'pat@example.com', signature: '<b>Pat</b>' });

    expect(await refreshEmailSignatures({ accountsDir: dir, readSendAs })).toEqual({
      written: ['pat@example.com'],
      cleared: [],
      failed: [],
    });
    expect(fs.existsSync(signatureOf('pat@example.com'))).toBe(true);
  });
});

describe('gwsAccountEnv', () => {
  it("names the account's credentials and an empty config dir, so the host's own gws login can't answer instead", () => {
    const saved = process.env.GOOGLE_WORKSPACE_CLI_TOKEN;
    process.env.GOOGLE_WORKSPACE_CLI_TOKEN = 'host-token';
    try {
      const env = gwsAccountEnv('/accounts/acme.json', '/tmp/empty');
      expect([
        env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE,
        env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR,
        env.GOOGLE_WORKSPACE_CLI_TOKEN,
      ]).toEqual(['/accounts/acme.json', '/tmp/empty', undefined]);
    } finally {
      if (saved === undefined) delete process.env.GOOGLE_WORKSPACE_CLI_TOKEN;
      else process.env.GOOGLE_WORKSPACE_CLI_TOKEN = saved;
    }
  });
});

describe('refreshEmailSignaturesIfDue', () => {
  it('refreshes when the last run is a day old, and not again within the day', async () => {
    const stateFile = path.join(root, 'state.json');
    let runs = 0;
    const refresh = async () => {
      runs++;
      return { written: [], cleared: [], failed: [] };
    };
    const start = Date.parse('2026-11-05T12:00:00.000Z');

    await refreshEmailSignaturesIfDue(start, { stateFile, refresh });
    expect(refreshEmailSignaturesIfDue(start + SIGNATURE_REFRESH_INTERVAL_MS - 1, { stateFile, refresh })).toBeNull();
    await refreshEmailSignaturesIfDue(start + SIGNATURE_REFRESH_INTERVAL_MS, { stateFile, refresh });

    expect(runs).toBe(2);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastRunAt).toBe('2026-11-06T12:00:00.000Z');
  });

  it('stays daily when the state file cannot be written', async () => {
    const stateFile = path.join(root, 'no-such-dir', 'state.json');
    let runs = 0;
    const refresh = async () => {
      runs++;
      return { written: [], cleared: [], failed: [] };
    };
    const start = Date.parse('2026-11-05T12:00:00.000Z');

    await refreshEmailSignaturesIfDue(start, { stateFile, refresh });
    expect(refreshEmailSignaturesIfDue(start + 60_000, { stateFile, refresh })).toBeNull();

    expect(runs).toBe(1);
  });
});

describe('stageEmailSignatures', () => {
  it("replaces the session's signatures with regular on-file copies of the allowed accounts only", () => {
    const staged = emailSignaturesDirFor(path.join(root, 'session'));
    fs.mkdirSync(staged, { recursive: true });
    fs.writeFileSync(path.join(staged, 'stale.signature.html'), '<b>From a previous spawn</b>\n');
    fs.writeFileSync(signatureOf('acme'), '<b>Pat Doe</b>\n');
    fs.writeFileSync(signatureOf('other'), '<b>Another workgroup</b>\n');
    fs.writeFileSync(path.join(root, 'elsewhere.html'), '<b>Not on file</b>\n');
    fs.symlinkSync(path.join(root, 'elsewhere.html'), signatureOf('link'));

    for (const account of ['acme', 'other']) fs.writeFileSync(path.join(dir, `${account}.json`), `{"a":"${account}"}`);

    stageEmailSignatures(dir, staged, ['acme', 'beta', 'link']);
    expect(fs.readdirSync(staged).sort()).toEqual(['acme.signature.html', 'identities.json']);
    expect(fs.readFileSync(path.join(staged, 'acme.signature.html'), 'utf8')).toBe('<b>Pat Doe</b>\n');

    stageEmailSignatures(dir, staged, 'all');
    expect(fs.readdirSync(staged).sort()).toEqual(['acme.signature.html', 'identities.json', 'other.signature.html']);

    stageEmailSignatures(dir, staged, []);
    expect(fs.readdirSync(staged)).toEqual(['identities.json']);
    expect(JSON.parse(fs.readFileSync(path.join(staged, 'identities.json'), 'utf8'))).toEqual({});
  });

  it("maps an allowed account's mounted credentials to its mailbox only when they are the bytes the mailbox was read with", () => {
    const staged = emailSignaturesDirFor(path.join(root, 'session'));
    const mounted = path.join(root, 'mounted');
    fs.mkdirSync(mounted);
    const record = (account: string, creds: string, mailbox: string) =>
      fs.writeFileSync(mailboxOf(account), `${JSON.stringify({ credentialsSha256: sha256(creds), mailbox })}\n`);
    for (const [account, creds] of [
      ['acme', '{"refresh_token":"a"}'],
      ['beta', '{"refresh_token":"b-replaced"}'],
      ['other', '{"refresh_token":"o"}'],
    ]) {
      fs.writeFileSync(path.join(dir, `${account}.json`), creds);
      fs.writeFileSync(path.join(mounted, `${account}.json`), creds);
    }
    record('acme', '{"refresh_token":"a"}', 'pat@example.com');
    record('beta', '{"refresh_token":"b"}', 'lee@example.org');
    record('other', '{"refresh_token":"o"}', 'x@example.net');
    fs.writeFileSync(path.join(mounted, 'other.json'), '{"refresh_token":"changed after staging copy"}');

    stageEmailSignatures(dir, staged, ['acme', 'beta', 'other'], mounted);

    expect(JSON.parse(fs.readFileSync(path.join(staged, 'identities.json'), 'utf8'))).toEqual({
      [sha256('{"refresh_token":"a"}')]: { account: 'acme', mailbox: 'pat@example.com' },
    });
  });

  it("stages into the session's host-owned directory, the one the container sees read-only at /workspace/.host", () => {
    expect(emailSignaturesDirFor('/data/v2-sessions/ag/s1')).toBe('/data/v2-sessions/ag/s1/.host/email-signatures');
  });
});
