import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: fetchMock,
}));
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));
vi.mock('./onecli-agent-proxy.js', () => ({
  agentProxyUrl: vi.fn(async (agent: string) => `http://x:token-of-${agent}@127.0.0.1:10255`),
}));

import { log } from './log.js';
import { agentProxyUrl } from './onecli-agent-proxy.js';
import { FILES_NOT_ALLOWED, slackReplyApiFor, slackUserApiFor } from './slack-user-api.js';

const TEXT = "It's live.\n<@U0EXAMPLE1> — see <#C0EXAMPLE2>.";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
type Init = { method: string; headers: Record<string, string>; body: unknown; dispatcher: unknown; redirect: string };
const call = (i: number) => fetchMock.mock.calls[i] as [string, Init];

// A function that beforeEach returns runs as its teardown, and mockReset returns the mock itself.
beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(log.warn).mockClear();
});

describe('slackUserApiFor', () => {
  it('posts the exact text once as JSON through the agent proxy, leaving the token to the gateway', async () => {
    fetchMock.mockResolvedValue(json({ ok: true, ts: '1790000000.000100' }));
    const api = await slackUserApiFor('ag-example');

    expect(await api.postMessage('C0EXAMPLE9', TEXT, '1790000000.000001')).toEqual({
      ok: true,
      ts: '1790000000.000100',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = call(0);
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(init.method).toBe('POST');
    expect(Object.keys(init.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
    expect(JSON.parse(init.body as string)).toEqual({
      channel: 'C0EXAMPLE9',
      text: TEXT,
      thread_ts: '1790000000.000001',
    });
    expect(init.dispatcher).toBeDefined();
    expect(init.redirect).toBe('manual');
  });

  it("edits with chat.update, and reports Slack's own error", async () => {
    fetchMock.mockResolvedValue(json({ ok: false, error: 'cant_update_message' }));
    const api = await slackUserApiFor('ag-example');

    expect(await api.updateMessage('C0EXAMPLE9', '1790000000.000222', TEXT)).toEqual({
      ok: false,
      error: 'cant_update_message',
    });
    const [url, init] = call(0);
    expect(url).toBe('https://slack.com/api/chat.update');
    expect(JSON.parse(init.body as string)).toEqual({ channel: 'C0EXAMPLE9', ts: '1790000000.000222', text: TEXT });
  });

  it('asks auth.test, by POST to the fixed slack.com origin, whose token answers, in which workspace, and what it may do', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, user_id: 'U0EXAMPLE1', team_id: 'T0EXAMPLE2', user: 'someone' }), {
        status: 200,
        headers: { 'x-oauth-scopes': 'identify,chat:write, files:write' },
      }),
    );
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: 'invalid_auth' }));
    const api = await slackUserApiFor('ag-example');

    expect(await api.authTest()).toEqual({
      ok: true,
      userId: 'U0EXAMPLE1',
      teamId: 'T0EXAMPLE2',
      scopes: ['identify', 'chat:write', 'files:write'],
    });
    expect(await api.authTest()).toEqual({ ok: false, error: 'invalid_auth' });
    const [url, init] = call(0);
    expect([url, init.method, init.redirect]).toEqual(['https://slack.com/api/auth.test', 'POST', 'manual']);
  });

  it.each([
    ['Slack says the call may have partly succeeded', json({ ok: false, error: 'internal_error' })],
    ['a gateway server error carries JSON', json({ ok: false, error: 'upstream' }, 502)],
    ['a 200 comes back empty', new Response('', { status: 200 })],
    ['a 200 comes back unreadable', new Response('{"ok":tr', { status: 200 })],
  ])('reports an unknown outcome when %s', async (_label, answer) => {
    fetchMock.mockResolvedValue(answer);
    const api = await slackUserApiFor('ag-example');
    expect(await api.postMessage('C0EXAMPLE9', TEXT)).toEqual({ ok: false, error: 'no_answer' });
  });

  it('reports an unknown outcome when the request fails in flight, and does not send it again', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')));
    const api = await slackUserApiFor('ag-example');
    expect(await api.postMessage('C0EXAMPLE9', TEXT)).toEqual({ ok: false, error: 'no_answer' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.warn).mock.calls).toEqual([
      ['Slack call failed in flight', { method: 'chat.postMessage', error: 'TypeError', code: undefined }],
    ]);
  });

  it('answers that nothing left the host when the gateway gives no identity, and makes no request', async () => {
    vi.mocked(agentProxyUrl).mockImplementationOnce(async () => {
      throw new Error('OneCLI gave no proxy identity for agent ag-example');
    });
    const api = await slackUserApiFor('ag-example');
    expect(await api.postMessage('C0EXAMPLE9', TEXT)).toEqual({ ok: false, error: 'no gateway identity', local: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a non-JSON answer (a gateway error page) by its status', async () => {
    fetchMock.mockResolvedValue(new Response('<html>proxy refused</html>', { status: 407 }));
    const api = await slackUserApiFor('ag-example');
    expect(await api.postMessage('C0EXAMPLE9', TEXT)).toEqual({ ok: false, error: 'HTTP 407' });
  });

  it('uploads in Slack’s three steps: reserve with the byte length, send the bytes, then share with the comment', async () => {
    const bytes = Buffer.from('a,b\n1,2\n');
    fetchMock
      .mockResolvedValueOnce(
        json({ ok: true, upload_url: 'https://files.slack.com/upload/v1/abc', file_id: 'F0EXAMPLE' }),
      )
      .mockResolvedValueOnce(new Response('OK', { status: 200 }))
      .mockResolvedValueOnce(json({ ok: true, files: [{ id: 'F0EXAMPLE' }] }));
    const api = await slackUserApiFor('ag-example');

    expect(
      await api.uploadFile(
        'C0EXAMPLE9',
        { name: 'report.csv', bytes },
        { threadTs: '1790000000.000001', title: 'Q3', comment: TEXT },
      ),
    ).toEqual({ ok: true, fileId: 'F0EXAMPLE' });
    expect(call(0)[0]).toBe('https://slack.com/api/files.getUploadURLExternal');
    expect(String(call(0)[1].body)).toBe('filename=report.csv&length=8');
    expect(call(1)[0]).toBe('https://files.slack.com/upload/v1/abc');
    expect(call(1)[1].body).toBe(bytes);
    expect(call(2)[0]).toBe('https://slack.com/api/files.completeUploadExternal');
    expect(JSON.parse(call(2)[1].body as string)).toEqual({
      files: [{ id: 'F0EXAMPLE', title: 'Q3' }],
      channel_id: 'C0EXAMPLE9',
      thread_ts: '1790000000.000001',
      initial_comment: TEXT,
    });
  });

  it('stops an upload whose bytes were not accepted, so nothing is shared', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ ok: true, upload_url: 'https://files.slack.com/upload/v1/abc', file_id: 'F0EXAMPLE' }),
      )
      .mockResolvedValueOnce(new Response('no', { status: 500 }));
    const api = await slackUserApiFor('ag-example');

    expect(await api.uploadFile('C0EXAMPLE9', { name: 'r.csv', bytes: Buffer.from('x') }, {})).toEqual({
      ok: false,
      error: 'upload HTTP 500',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends no bytes when Slack refuses to reserve the upload, and reports its error', async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: 'channel_not_found' }));
    const api = await slackUserApiFor('ag-example');

    expect(await api.uploadFile('C0EXAMPLE9', { name: 'r.csv', bytes: Buffer.from('x') }, {})).toEqual({
      ok: false,
      error: 'channel_not_found',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe('shareFiles', () => {
    const dir = uniqueTmpRoot('slack-share-files');
    const files = [{ name: 'shot.png', type: 'image/png', bytes: Buffer.from('png bytes') }].map(
      ({ name, type, bytes }) => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, name), bytes);
        return { path: path.join(dir, name), name, type, size: bytes.length };
      },
    );
    const THREAD = { threadTs: '1790000000.000001', comment: TEXT };
    afterEach(() => {
      vi.mocked(agentProxyUrl).mockImplementation(
        async (agent: string) => `http://x:token-of-${agent}@127.0.0.1:10255`,
      );
    });
    const slot = (url = 'https://files.slack.com/upload/v1/slot-1', headers: Record<string, string> = {}) =>
      new Response(JSON.stringify({ ok: true, upload_url: url, file_id: 'F0EXAMPLE1' }), { status: 200, headers });

    it('reserves the file through the gateway, sends its bytes straight to Slack with no token, then shares it with the words', async () => {
      let askedToShareAt = 0;
      fetchMock
        .mockResolvedValueOnce(slot())
        .mockResolvedValueOnce(new Response('OK', { status: 200 }))
        .mockImplementationOnce(async () => {
          askedToShareAt = Date.now();
          return json({ ok: true, files: [{ id: 'F0EXAMPLE1' }] });
        });
      const api = await slackUserApiFor('ag-example');

      const shared = await api.shareFiles('C0EXAMPLE9', files, THREAD);
      expect(shared).toEqual({ ok: true, fileId: 'F0EXAMPLE1', sharingFrom: expect.any(String) });
      expect(Date.parse(shared.sharingFrom!)).toBeLessThanOrEqual(askedToShareAt);
      expect(fetchMock.mock.calls.map(([url]) => url as string)).toEqual([
        'https://slack.com/api/files.getUploadURLExternal',
        'https://files.slack.com/upload/v1/slot-1',
        'https://slack.com/api/files.completeUploadExternal',
      ]);
      for (const n of [0, 2]) expect(call(n)[1].dispatcher).toBeDefined();
      const [, upload] = call(1);
      expect(upload.dispatcher).toBeUndefined();
      expect(Object.keys(upload.headers).map((h) => h.toLowerCase())).toEqual(['content-type']);
      expect(Buffer.from(await (upload.body as Blob).arrayBuffer()).toString()).toBe('png bytes');
      expect(String(call(0)[1].body)).toBe('filename=shot.png&length=9');
      expect(JSON.parse(call(2)[1].body as string)).toEqual({
        files: [{ id: 'F0EXAMPLE1', title: 'shot.png' }],
        channel_id: 'C0EXAMPLE9',
        thread_ts: '1790000000.000001',
        initial_comment: TEXT,
      });
    });

    it.each([
      [
        'answers not_authed, as when the gateway injects it on no files path',
        () => json({ ok: false, error: 'not_authed' }),
      ],
      ['answers missing_scope', () => json({ ok: false, error: 'missing_scope' })],
      [
        'holds no files:write by its own scopes header',
        () => slot(undefined, { 'x-oauth-scopes': 'identify,chat:write' }),
      ],
    ])('says files are not allowed, sending no bytes, when the token %s', async (_label, answer) => {
      fetchMock.mockResolvedValueOnce(answer());
      const api = await slackUserApiFor('ag-example');

      expect(await api.shareFiles('C0EXAMPLE9', files, THREAD)).toEqual({ ok: false, error: FILES_NOT_ALLOWED });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reads no answer while reserving an upload as nothing posted, since only the last step shares', async () => {
      fetchMock.mockResolvedValueOnce(json({ ok: false, error: 'internal_error' }));
      const api = await slackUserApiFor('ag-example');

      expect(await api.shareFiles('C0EXAMPLE9', files, THREAD)).toEqual({ ok: false, error: 'upload not reserved' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('shares nothing when sending the bytes throws, and says the upload failed', async () => {
      fetchMock
        .mockResolvedValueOnce(slot())
        .mockRejectedValueOnce(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
      const api = await slackUserApiFor('ag-example');

      expect(await api.shareFiles('C0EXAMPLE9', files, THREAD)).toEqual({ ok: false, error: 'upload failed' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenCalledWith('Slack file upload failed', { error: 'TimeoutError' });
    });

    it.each([
      ['plain http', 'http://files.slack.com/upload/v1/slot-1'],
      ['another host ending like it', 'https://files.slack.com.example.net/upload/v1/slot-1'],
      ['another host it ends like', 'https://evilfiles.slack.com/upload/v1/slot-1'],
      ['a port of its own', 'https://files.slack.com:8443/upload/v1/slot-1'],
      [
        'credentials of its own',
        Object.assign(new URL('https://files.slack.com/upload/v1/slot-1'), { username: 'someone', password: 'pw' })
          .href,
      ],
      ['not a URL at all', 'files.slack.com/upload/v1/slot-1'],
    ])('sends no bytes to an upload URL with %s, and shares nothing', async (_label, url) => {
      fetchMock.mockResolvedValueOnce(slot(url));
      const api = await slackUserApiFor('ag-example');

      expect(await api.shareFiles('C0EXAMPLE9', files, THREAD)).toEqual({ ok: false, error: 'unexpected upload URL' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('slackReplyApiFor', () => {
    it('has the reply calls alone, and they reach only chat.postMessage, auth.test and the two files methods', async () => {
      const dir = uniqueTmpRoot('slack-reply-api');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'shot.png'), 'png bytes');
      fetchMock
        .mockResolvedValueOnce(json({ ok: true, ts: '1790000000.000100' }))
        .mockResolvedValueOnce(json({ ok: true, user_id: 'U0EXAMPLE1', team_id: 'T0EXAMPLE2' }))
        .mockResolvedValueOnce(
          json({ ok: true, upload_url: 'https://files.slack.com/upload/v1/slot-1', file_id: 'F0EXAMPLE1' }),
        )
        .mockResolvedValueOnce(new Response('OK', { status: 200 }))
        .mockResolvedValueOnce(json({ ok: true, files: [{ id: 'F0EXAMPLE1' }] }));
      const api = await slackReplyApiFor('ag-example');

      await api.postMessage('C0EXAMPLE9', TEXT, '1790000000.000001');
      await api.authTest();
      const shot = { path: path.join(dir, 'shot.png'), name: 'shot.png', type: 'image/png', size: 9 };
      await api.shareFiles('C0EXAMPLE9', [shot], { threadTs: '1790000000.000001', comment: '' });

      expect(Object.keys(api).sort()).toEqual(['authTest', 'postMessage', 'shareFiles']);
      expect(
        fetchMock.mock.calls.map(([url]) => url as string).filter((url) => url.startsWith('https://slack.com/')),
      ).toEqual([
        'https://slack.com/api/chat.postMessage',
        'https://slack.com/api/auth.test',
        'https://slack.com/api/files.getUploadURLExternal',
        'https://slack.com/api/files.completeUploadExternal',
      ]);
    });
  });
});
