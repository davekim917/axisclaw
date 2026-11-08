import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';
import { hostInboundDirFor } from '../mailbox/index.js';

const execFileP = promisify(execFile);

const GWS_ACCOUNTS_DIR = path.join(os.homedir(), '.config', 'gws', 'accounts');
export const SIGNATURE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STATE_FILE = path.join(DATA_DIR, 'email-signature-refresh.json');
const ACCOUNT_FILE = /^(.+)\.json$/;
const SIGNATURE_SUFFIX = '.signature.html';
const MAILBOX_SUFFIX = '.mailbox';
// Read by the plugin's email gate: the SHA-256 of each allowed credentials file's bytes, mapped to its account and the
// address it sends from, so the card names the sender the credentials prove rather than the file's name.
const IDENTITIES_FILE = 'identities.json';

/** The account's Gmail `sendAs` listing, read with that account's own credentials. */
export type ReadSendAs = (credentialsFile: string) => Promise<unknown>;

/**
 * The host's own gws login (its config dir's encrypted credentials and token cache) outranks
 * GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE, so without an empty config dir of its own every account would read the host
 * default's mailbox.
 */
export function gwsAccountEnv(credentialsFile: string, configDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: credentialsFile,
    GOOGLE_WORKSPACE_CLI_CONFIG_DIR: configDir,
  };
  delete env.GOOGLE_WORKSPACE_CLI_TOKEN;
  return env;
}

const readSendAsWithGws: ReadSendAs = async (credentialsFile) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-signature-'));
  try {
    const { stdout } = await execFileP(
      'gws',
      ['gmail', 'users', 'settings', 'sendAs', 'list', '--params', '{"userId":"me"}', '--format', 'json'],
      { env: gwsAccountEnv(credentialsFile, configDir), timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return JSON.parse(stdout.slice(stdout.indexOf('{')));
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
};

/**
 * The default send-as identity's signature ('' when it has none), and the account's primary address when the default is
 * that primary address (null otherwise). Null when the listing names no default.
 *
 * gws sends from the default without `--from`, and the default can be switched to an alias at any time, so only the
 * primary address is fixed for a set of credentials.
 */
function sendAsFacts(listing: unknown): { signature: string; mailbox: string | null } | null {
  const entries = (listing as { sendAs?: unknown })?.sendAs;
  if (!Array.isArray(entries)) return null;
  const chosen = (
    entries as Array<{ isDefault?: unknown; isPrimary?: unknown; sendAsEmail?: unknown; signature?: unknown }>
  ).find((e) => e?.isDefault === true);
  if (!chosen) return null;
  const address = chosen.sendAsEmail;
  return {
    signature: typeof chosen.signature === 'string' ? chosen.signature.trim() : '',
    mailbox:
      chosen.isPrimary === true && typeof address === 'string' && /^[^\s@]+@[^\s@]+$/.test(address) ? address : null,
  };
}

const sha256 = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex');

/** The account's recorded mailbox, valid only for credentials whose bytes hash to `credentialsSha256`. */
function recordedMailbox(file: string): { credentialsSha256: string; mailbox: string } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { credentialsSha256?: unknown; mailbox?: unknown };
    return typeof parsed.credentialsSha256 === 'string' && typeof parsed.mailbox === 'string'
      ? { credentialsSha256: parsed.credentialsSha256, mailbox: parsed.mailbox }
      : null;
  } catch {
    return null;
  }
}

function writeAtomically(target: string, content: string): void {
  const staging = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(staging, content, { mode: 0o644 });
  fs.renameSync(staging, target);
}

/**
 * Where the plugin's email gate reads signatures: the session's host-owned directory, `/workspace/.host` in the
 * container. Every ancestor of that path is a mountpoint or root-owned, so an agent can neither write it nor rename a
 * parent away and recreate it, which a copy beside the credentials under the agent's home would allow.
 */
export function emailSignaturesDirFor(sessionDir: string): string {
  return path.join(hostInboundDirFor(sessionDir), 'email-signatures');
}

/**
 * Replaces the session's signatures and sender identities with the on-file copies for the given accounts ('all': every
 * account); never reads Gmail. An identity is staged only when the credentials the container mounts (`credentialsDir`)
 * are byte-for-byte the ones its mailbox was read with.
 */
export function stageEmailSignatures(
  accountsDir: string,
  targetDir: string,
  accounts: string[] | 'all',
  credentialsDir = accountsDir,
): void {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  let names: string[];
  try {
    names =
      accounts === 'all'
        ? fs
            .readdirSync(accountsDir)
            .map((f) => ACCOUNT_FILE.exec(f)?.[1])
            .filter((a): a is string => a !== undefined)
        : accounts;
  } catch {
    return;
  }
  const identities: Record<string, { account: string; mailbox: string }> = {};
  for (const account of names) {
    const regular = (name: string, dir = accountsDir): string | null => {
      const file = path.join(dir, name);
      try {
        return fs.lstatSync(file).isFile() ? file : null;
      } catch {
        return null;
      }
    };
    const signature = regular(`${account}${SIGNATURE_SUFFIX}`);
    try {
      if (signature) {
        fs.copyFileSync(signature, path.join(targetDir, `${account}${SIGNATURE_SUFFIX}`));
        fs.chmodSync(path.join(targetDir, `${account}${SIGNATURE_SUFFIX}`), 0o644);
      }
      const credentials = regular(`${account}.json`, credentialsDir);
      const mailboxFile = regular(`${account}${MAILBOX_SUFFIX}`);
      const recorded = mailboxFile ? recordedMailbox(mailboxFile) : null;
      if (credentials && recorded) {
        const hash = sha256(fs.readFileSync(credentials));
        if (hash === recorded.credentialsSha256) identities[hash] = { account, mailbox: recorded.mailbox };
      }
    } catch {
      continue;
    }
  }
  fs.writeFileSync(path.join(targetDir, IDENTITIES_FILE), `${JSON.stringify(identities, null, 2)}\n`, { mode: 0o644 });
}

/** Reads the listing with a private copy of the credentials, so the recorded hash is of exactly the bytes that answered. */
async function readSendAsSnapshot(bytes: Buffer, name: string, readSendAs: ReadSendAs): Promise<unknown> {
  const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-credentials-'));
  try {
    fs.writeFileSync(path.join(snapshotDir, name), bytes, { mode: 0o600 });
    return await readSendAs(path.join(snapshotDir, name));
  } finally {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  }
}

export interface SignatureRefreshResult {
  written: string[];
  cleared: string[];
  failed: string[];
}

/** Rewrites every account's on-file signature from Gmail. A failed read leaves that account's file as it was. */
export async function refreshEmailSignatures(
  opts: { accountsDir?: string; readSendAs?: ReadSendAs } = {},
): Promise<SignatureRefreshResult> {
  const dir = opts.accountsDir ?? GWS_ACCOUNTS_DIR;
  const readSendAs = opts.readSendAs ?? readSendAsWithGws;
  const result: SignatureRefreshResult = { written: [], cleared: [], failed: [] };
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return result;
  }
  for (const name of names.sort()) {
    const account = ACCOUNT_FILE.exec(name)?.[1];
    if (!account) continue;
    const credentials = path.join(dir, name);
    const target = path.join(dir, `${account}${SIGNATURE_SUFFIX}`);
    try {
      if (!fs.statSync(credentials).isFile()) continue;
      const bytes = fs.readFileSync(credentials);
      const sendAs = sendAsFacts(await readSendAsSnapshot(bytes, name, readSendAs));
      if (sendAs === null) {
        result.failed.push(account);
        log.warn('Email signature refresh: the listing names no default send-as; the on-file copy is unchanged', {
          account,
        });
        continue;
      }
      const mailboxFile = path.join(dir, `${account}${MAILBOX_SUFFIX}`);
      if (sendAs.mailbox) {
        writeAtomically(
          mailboxFile,
          `${JSON.stringify({ credentialsSha256: sha256(bytes), mailbox: sendAs.mailbox })}\n`,
        );
      } else {
        fs.rmSync(mailboxFile, { force: true });
      }
      if (sendAs.signature) {
        writeAtomically(target, `${sendAs.signature}\n`);
        result.written.push(account);
      } else {
        fs.rmSync(target, { force: true });
        result.cleared.push(account);
      }
    } catch (err) {
      result.failed.push(account);
      log.warn('Email signature refresh failed for an account; its on-file copy is unchanged', {
        account,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

function lastRunMs(stateFile: string): number {
  try {
    return Date.parse((JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { lastRunAt?: string }).lastRunAt ?? '') || 0;
  } catch {
    return 0;
  }
}

export function recordSignatureRefresh(result: SignatureRefreshResult, now = new Date(), stateFile = STATE_FILE): void {
  fs.writeFileSync(stateFile, `${JSON.stringify({ lastRunAt: now.toISOString(), ...result }, null, 2)}\n`);
}

let inFlight: Promise<void> | null = null;
// The state file can be unreadable or unwritable; the last attempt held here still keeps the refresh daily.
const lastAttemptMs = new Map<string, number>();

/** Runs the refresh when the last one is a day old, at most one at a time; the sweep does not wait for it. */
export function refreshEmailSignaturesIfDue(
  now = Date.now(),
  deps: { stateFile?: string; refresh?: () => Promise<SignatureRefreshResult> } = {},
): Promise<void> | null {
  const stateFile = deps.stateFile ?? STATE_FILE;
  const last = Math.max(lastRunMs(stateFile), lastAttemptMs.get(stateFile) ?? 0);
  if (inFlight || now - last < SIGNATURE_REFRESH_INTERVAL_MS) return null;
  lastAttemptMs.set(stateFile, now);
  inFlight = (deps.refresh ?? refreshEmailSignatures)()
    .then((result) => {
      recordSignatureRefresh(result, new Date(now), stateFile);
      log.info('Email signatures refreshed', { ...result });
    })
    .catch((err) => log.warn('Email signature refresh pass failed', { err }))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
