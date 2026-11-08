/**
 * Slack's Web API over the OneCLI gateway, as the OneCLI agent it is given; the gateway injects that agent's token, so
 * the host never holds it. Each call is sent once: a post or an upload is not idempotent.
 */
import { openAsBlob } from 'fs';

import { ProxyAgent, fetch as undiciFetch } from 'undici';

import { log } from './log.js';
import { agentProxyUrl } from './onecli-agent-proxy.js';

export interface SlackResult {
  ok: boolean;
  error?: string;
  /** Refused on the host before anything reached Slack. */
  local?: true;
  ts?: string;
  fileId?: string;
  /** Whose token answered `authTest`, and in which workspace; present only when Slack said so. */
  userId?: string;
  teamId?: string;
  /** What the token that answered `authTest` may do, from Slack's `x-oauth-scopes` header. */
  scopes?: string[];
  /** The host's time just before it asked Slack to share the files: their message is no older. */
  sharingFrom?: string;
}

/** A file on this host's disk to share, by the name and type it goes up as. */
interface FileToShare {
  path: string;
  name: string;
  type: string;
  size: number;
}

export interface SlackUserApi {
  postMessage(channel: string, text: string, threadTs?: string): Promise<SlackResult>;
  updateMessage(channel: string, ts: string, text: string): Promise<SlackResult>;
  uploadFile(
    channel: string,
    file: { name: string; bytes: Buffer },
    opts: { threadTs?: string; title?: string; comment?: string },
  ): Promise<SlackResult>;
  authTest(): Promise<SlackResult>;
  /**
   * Shares files in one message, with `comment` as its text. The bytes go to Slack's pre-signed upload URL straight from
   * the host, never through the gateway, so no token rides with them. Slack does not say the message's ts, so the
   * answer says when the host asked for the share.
   */
  shareFiles(channel: string, files: FileToShare[], opts: { threadTs: string; comment: string }): Promise<SlackResult>;
}

/** The outcome of a call Slack may or may not have acted on. */
export const NO_ANSWER = 'no_answer';
/** The token cannot send files, by its scopes or because the gateway injects it on no files method; nothing was shared. */
export const FILES_NOT_ALLOWED = 'files_not_allowed';
const FILE_SCOPE = 'files:write';
/** Slack's answers to a token the gateway did not inject, or one without the scope, on a files method. */
const NO_FILE_ACCESS = new Set(['not_authed', 'missing_scope']);

/**
 * The Slack calls a reply from the app may make, and no others: posting, asking whose token it is, and sharing a file,
 * which is `files.getUploadURLExternal` and `files.completeUploadExternal`.
 */
export type SlackReplyApi = Pick<SlackUserApi, 'postMessage' | 'authTest' | 'shareFiles'>;

const ORIGIN = 'https://slack.com/api/';
/** Slack's own errors after which the call may have partly succeeded (its Web API error reference). */
const PARTLY_DONE_ERRORS = new Set(['internal_error', 'fatal_error', 'request_timeout', 'service_unavailable']);
const REQUEST_TIMEOUT_MS = 60_000;
/** Where Slack's pre-signed upload URLs point; any other answer is refused rather than sent the bytes. */
const UPLOAD_HOST = 'files.slack.com';

/** The upload URL, only as https on Slack's files host with no port or credentials of its own. */
function uploadTarget(given: string): string | null {
  let url: URL;
  try {
    url = new URL(given);
  } catch (err) {
    if (err instanceof TypeError) return null;
    throw err;
  }
  const plain = url.protocol === 'https:' && url.hostname === UPLOAD_HOST && url.port === '';
  return plain && url.username === '' && url.password === '' ? url.href : null;
}

const scopesIn = (seen: Headers): string[] | null => {
  const header = seen.get('x-oauth-scopes');
  return header === null
    ? null
    : header
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean);
};

type Body = { json: Record<string, unknown> } | { form: Record<string, string> };

/** Without a gateway identity nothing can be sent, so every call answers that it stayed on the host. */
export async function slackUserApiFor(onecliAgent: string): Promise<SlackUserApi> {
  let dispatcher: ProxyAgent;
  try {
    dispatcher = new ProxyAgent(await agentProxyUrl(onecliAgent));
    // eslint-disable-next-line no-catch-all/no-catch-all -- no request has been made, so every call is known not sent
  } catch {
    const unsent = async (): Promise<SlackResult> => ({ ok: false, error: 'no gateway identity', local: true });
    return { postMessage: unsent, updateMessage: unsent, uploadFile: unsent, authTest: unsent, shareFiles: unsent };
  }
  const call = async (
    method: string,
    body: Body,
    headers?: (seen: Headers) => void,
  ): Promise<Record<string, unknown>> => {
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    let text: string;
    try {
      res = await undiciFetch(ORIGIN + method, {
        method: 'POST',
        dispatcher,
        headers:
          'json' in body
            ? { 'Content-Type': 'application/json; charset=utf-8' }
            : { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'json' in body ? JSON.stringify(body.json) : new URLSearchParams(body.form).toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      headers?.(res.headers as Headers);
      text = await res.text();
      // eslint-disable-next-line no-catch-all/no-catch-all -- a request that failed in flight may already have reached Slack
    } catch (err) {
      const cause = (err as { cause?: { code?: unknown } }).cause;
      log.warn('Slack call failed in flight', {
        method,
        error: err instanceof Error ? err.name : typeof err,
        code: typeof cause?.code === 'string' ? cause.code : undefined,
      });
      return { ok: false, error: NO_ANSWER };
    }
    // A server error, JSON or not, may come after Slack already took the request.
    if (res.status >= 500) return { ok: false, error: NO_ANSWER };
    try {
      return JSON.parse(text) as Record<string, unknown>;
      // eslint-disable-next-line no-catch-all/no-catch-all -- a non-JSON body (a gateway error page) is reported by status
    } catch {
      // Only a 4xx (the gateway refusing the request) is known to have stopped short of Slack.
      return { ok: false, error: res.status >= 400 && res.status < 500 ? `HTTP ${res.status}` : NO_ANSWER };
    }
  };
  const failed = (r: Record<string, unknown>): SlackResult => ({
    ok: false,
    error: typeof r.error !== 'string' || PARTLY_DONE_ERRORS.has(r.error) ? NO_ANSWER : r.error,
  });

  return {
    async postMessage(channel, text, threadTs) {
      const r = await call('chat.postMessage', {
        json: { channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) },
      });
      return r.ok === true ? { ok: true, ts: String(r.ts) } : failed(r);
    },
    async updateMessage(channel, ts, text) {
      const r = await call('chat.update', { json: { channel, ts, text } });
      return r.ok === true ? { ok: true, ts: String(r.ts) } : failed(r);
    },
    async uploadFile(channel, file, opts) {
      const slot = await call('files.getUploadURLExternal', {
        form: { filename: file.name, length: String(file.bytes.length) },
      });
      if (slot.ok !== true || typeof slot.upload_url !== 'string' || typeof slot.file_id !== 'string') {
        return failed(slot);
      }
      const put = await undiciFetch(slot.upload_url, {
        method: 'POST',
        dispatcher,
        body: file.bytes,
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await put.arrayBuffer();
      if (put.status !== 200) return { ok: false, error: `upload HTTP ${put.status}` };
      const done = await call('files.completeUploadExternal', {
        json: {
          files: [{ id: slot.file_id, ...(opts.title ? { title: opts.title } : {}) }],
          channel_id: channel,
          ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
          ...(opts.comment ? { initial_comment: opts.comment } : {}),
        },
      });
      return done.ok === true ? { ok: true, fileId: slot.file_id } : failed(done);
    },
    async authTest() {
      let scopes: string[] = [];
      const r = await call('auth.test', { form: {} }, (seen) => {
        scopes = scopesIn(seen) ?? [];
      });
      return r.ok === true && typeof r.user_id === 'string' && typeof r.team_id === 'string'
        ? { ok: true, userId: r.user_id, teamId: r.team_id, scopes }
        : failed(r);
    },
    async shareFiles(channel, files, { threadTs, comment }) {
      const uploaded: Array<{ id: string; title: string }> = [];
      for (const file of files) {
        let scopes: string[] | null = null;
        const slot = await call(
          'files.getUploadURLExternal',
          { form: { filename: file.name, length: String(file.size) } },
          (seen) => {
            scopes = scopesIn(seen);
          },
        );
        const granted = scopes as string[] | null;
        if (NO_FILE_ACCESS.has(String(slot.error)) || (granted && !granted.includes(FILE_SCOPE))) {
          return { ok: false, error: FILES_NOT_ALLOWED };
        }
        // A reserved upload shares nothing until completeUploadExternal, so no answer here posted nothing either.
        if (slot.ok !== true || typeof slot.upload_url !== 'string' || typeof slot.file_id !== 'string') {
          const { error } = failed(slot);
          return { ok: false, error: error === NO_ANSWER ? 'upload not reserved' : error };
        }
        const target = uploadTarget(slot.upload_url);
        if (!target) return { ok: false, error: 'unexpected upload URL' };
        try {
          const put = await undiciFetch(target, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: await openAsBlob(file.path),
            redirect: 'manual',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          await put.arrayBuffer();
          if (put.status !== 200) return { ok: false, error: `upload HTTP ${put.status}` };
          // eslint-disable-next-line no-catch-all/no-catch-all -- Slack discards an upload never completed, so nothing is shared
        } catch (err) {
          log.warn('Slack file upload failed', { error: err instanceof Error ? err.name : typeof err });
          return { ok: false, error: 'upload failed' };
        }
        uploaded.push({ id: slot.file_id, title: file.name });
      }
      const sharingFrom = new Date().toISOString();
      const done = await call('files.completeUploadExternal', {
        json: {
          files: uploaded,
          channel_id: channel,
          thread_ts: threadTs,
          ...(comment ? { initial_comment: comment } : {}),
        },
      });
      if (NO_FILE_ACCESS.has(String(done.error))) return { ok: false, error: FILES_NOT_ALLOWED };
      return done.ok === true ? { ok: true, fileId: uploaded[0].id, sharingFrom } : failed(done);
    },
  };
}

/** The reply calls alone, so a reply's client has no other method to reach, whatever the token behind it could do. */
export async function slackReplyApiFor(onecliAgent: string): Promise<SlackReplyApi> {
  const { postMessage, authTest, shareFiles } = await slackUserApiFor(onecliAgent);
  return { postMessage, authTest, shareFiles };
}
