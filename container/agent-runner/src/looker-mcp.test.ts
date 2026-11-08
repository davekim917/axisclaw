import { afterEach, describe, expect, it } from 'bun:test';

import { lookerOrigin, makeLookerForwarder, serveLookerForwarder } from './looker-mcp.js';

const ORIGIN = 'https://looker.example.com';

describe('lookerOrigin', () => {
  it.each([
    ['https://looker.example.com', 'https://looker.example.com'],
    ['https://looker.example.com/', 'https://looker.example.com'],
    ['https://looker.example.com:19999', 'https://looker.example.com:19999'],
  ])('accepts %s', (raw, origin) => {
    expect(lookerOrigin(raw)).toBe(origin);
  });

  it.each([
    [undefined, /required/],
    ['looker.example.com', /not a URL/],
    ['http://looker.example.com', /bare https origin/],
    [`https://user:pw${'@'}looker.example.com`, /bare https origin/],
    ['https://looker.example.com/api/4.0', /no path/],
    ['https://looker.example.com/?x=1', /bare https origin/],
  ])('refuses %s', (raw, reason) => {
    expect(() => lookerOrigin(raw)).toThrow(reason);
  });
});

describe('makeLookerForwarder', () => {
  const SELF = '127.0.0.1:4100';
  const calls: Array<{
    url: string;
    method: string;
    headers: Headers;
    body: string | undefined;
    redirect: RequestRedirect | undefined;
  }> = [];
  const fakeFetch = async (input: URL, init: RequestInit): Promise<Response> => {
    calls.push({
      url: input.toString(),
      method: String(init.method),
      headers: new Headers(init.headers),
      body: init.body === undefined ? undefined : new TextDecoder().decode(init.body as ArrayBuffer),
      redirect: init.redirect,
    });
    return new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': '999' },
    });
  };
  const forward = makeLookerForwarder(ORIGIN, () => SELF, fakeFetch);

  afterEach(() => {
    calls.length = 0;
  });

  it('sends the path, query, method, headers and body to the configured origin only', async () => {
    const res = await forward(
      new Request(`http://${SELF}/api/4.0/queries/run/json?limit=5`, {
        method: 'POST',
        headers: {
          Authorization: 'token onecli-managed',
          'X-Forwarded-For': '10.0.0.9',
          'X-Real-IP': '10.0.0.9',
          'Proxy-Authorization': 'Basic example',
          'Content-Type': 'application/json',
        },
        body: '{"model":"m"}',
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${ORIGIN}/api/4.0/queries/run/json?limit=5`);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toBe('{"model":"m"}');
    expect(calls[0].headers.get('authorization')).toBe('token onecli-managed');
    expect(calls[0].headers.get('x-forwarded-for')).toBeNull();
    expect(calls[0].headers.get('x-real-ip')).toBeNull();
    expect(calls[0].headers.get('proxy-authorization')).toBeNull();
    expect(calls[0].redirect).toBe('manual');
    expect(calls[0].headers.get('host')).toBeNull();
  });

  it('keeps a path that looks like another host on the configured origin', async () => {
    await forward(new Request(`http://${SELF}//evil.example.net/api/4.0/me`));
    expect(calls.map((c) => new URL(c.url).origin)).toEqual([ORIGIN]);
  });

  it.each([
    ['a request addressed to another host', new Request('http://evil.example.net/api/4.0/me')],
    ['a request addressed to another loopback port', new Request('http://127.0.0.1:4200/api/4.0/me')],
    ['an https request for the Looker host itself', new Request(`${ORIGIN}/api/4.0/me`)],
  ])('refuses %s without calling out', async (_name, req) => {
    const res = await forward(req);
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  async function rawRequest(
    lines: string,
    fetchImpl: typeof fakeFetch = fakeFetch,
  ): Promise<{ status: string; selfHost: string }> {
    const { server, host: selfHost } = serveLookerForwarder(ORIGIN, fetchImpl);
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        let data = '';
        Bun.connect({
          hostname: '127.0.0.1',
          port: server.port!,
          socket: {
            open(socket) {
              socket.write(lines.replaceAll('SELF', selfHost));
            },
            data(_socket, chunk) {
              data += new TextDecoder().decode(chunk);
            },
            close() {
              resolve(data);
            },
            error(_socket, err) {
              reject(err);
            },
          },
        }).catch(reject);
      });
      return { status: reply.split('\r\n')[0], selfHost };
    } finally {
      server.stop(true);
    }
  }

  it('refuses a raw request whose Host names another host, whatever its request line says', async () => {
    const { status } = await rawRequest(
      'GET http://evil.example.net/api/4.0/me HTTP/1.1\r\nHost: evil.example.net\r\nConnection: close\r\n\r\n',
    );
    expect(status).toContain('403');
    expect(calls).toEqual([]);
  });

  it.each([
    ['its own authority', 'CONNECT SELF HTTP/1.1'],
    ['another host', 'CONNECT evil.example.net:443 HTTP/1.1'],
    ['a path', 'CONNECT /api/4.0/me HTTP/1.1'],
  ])('refuses a CONNECT naming %s', async (_name, line) => {
    const { status } = await rawRequest(`${line}\r\nHost: SELF\r\nConnection: close\r\n\r\n`);
    expect(status).toContain('403');
    expect(calls).toEqual([]);
  });

  it('answers a call that outlasts the idle limit a Bun server has by default', async () => {
    const { status } = await rawRequest(
      'GET /api/4.0/queries/run/json HTTP/1.1\r\nHost: SELF\r\nConnection: close\r\n\r\n',
      async () => {
        await Bun.sleep(14_000);
        return new Response('late');
      },
    );
    expect(status).toContain('200');
  }, 20_000);

  it('sends an absolute-form request line naming another host to the configured origin only', async () => {
    await rawRequest('GET http://evil.example.net/api/4.0/me HTTP/1.1\r\nHost: SELF\r\nConnection: close\r\n\r\n');
    expect(calls.map((c) => new URL(c.url).origin)).toEqual([ORIGIN]);
  });
});
