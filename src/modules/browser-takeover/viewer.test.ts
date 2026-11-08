import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { addressLine, reportedAddress, textEdit, VIEWER_PAGE, virtualKeyCode, watchHost } from './viewer.js';

describe('virtualKeyCode', () => {
  it.each([
    ['a', 65],
    ['Z', 90],
    ['7', 55],
    ['.', 0],
    ['@', 0],
    ['-', 0],
    [' ', 0],
  ])('maps %j to %i, never to a key code that means something else (46 is Delete)', (c, code) => {
    expect(virtualKeyCode(c)).toBe(code);
  });
});

describe('textEdit', () => {
  it.each([
    ['', 'a.b', { deletes: 0, inserts: 'a.b' }],
    ['abc', 'abcd', { deletes: 0, inserts: 'd' }],
    ['abcd', 'ab', { deletes: 2, inserts: '' }],
    ['hello wrold', 'hello world', { deletes: 4, inserts: 'orld' }],
    ['same', 'same', { deletes: 0, inserts: '' }],
    ['pass😀', 'pass', { deletes: 1, inserts: '' }],
    ['pass😀', 'pass😃', { deletes: 1, inserts: '😃' }],
    ['ab👨‍👩‍👧‍👦', 'ab', { deletes: 1, inserts: '' }],
    ['ab🇺🇸', 'ab🇨🇦', { deletes: 1, inserts: '🇨🇦' }],
    ['cafe\u0301', 'caf', { deletes: 2, inserts: '' }],
    ['\u0915\u094D\u0937', '\u0915', { deletes: 2, inserts: '' }],
  ])('turns %j into %j', (prev, cur, edit) => {
    expect(textEdit(prev, cur)).toEqual(edit);
  });
});

describe('reportedAddress', () => {
  it("takes a navigation's url", () => {
    expect(reportedAddress({ type: 'url', url: 'https://login.idp.example/' })).toBe('https://login.idp.example/');
  });

  it("takes the active tab's url and never a title, which the page sets", () => {
    const tabs = [
      { active: false, title: 'other', url: 'https://other.example/' },
      { active: true, title: 'login.idp.example', url: 'https://forge.example/' },
    ];
    expect(reportedAddress({ type: 'tabs', tabs })).toBe('https://forge.example/');
  });

  it.each([
    ['another message', { type: 'status', url: 'https://forge.example/' }],
    ['a frame', { type: 'frame', data: 'x' }],
  ])('reports nothing for %s', (_label, message) => {
    expect(reportedAddress(message)).toBeUndefined();
  });

  it.each([
    ['a url message with no url', { type: 'url' }],
    ['tabs with none active', { type: 'tabs', tabs: [{ active: false, url: 'https://forge.example/' }] }],
    ['no tabs', { type: 'tabs', tabs: [] }],
    ['tabs that are not a list', { type: 'tabs', tabs: 'https://forge.example/' }],
    ['a tab that is not an object', { type: 'tabs', tabs: [null] }],
  ])('reads %s as a report of no address, so a stale host cannot stand', (_label, message) => {
    expect(reportedAddress(message)).toBeNull();
  });
});

describe('addressLine', () => {
  it.each([
    ['https://login.idp.example/path?code=abc#frag', 'You are on login.idp.example'],
    ['https://app.example.com:8443/', 'You are on app.example.com:8443'],
    ['http://app.example.com/', 'You are on http://app.example.com'],
    ['https://forge.example/login.idp.example/sign-in', 'You are on forge.example'],
    ['https://login.idp.example:!@forge.example/', 'You are on forge.example'],
    ['https://\u0430pp.example/', 'You are on xn--pp-6kc.example'],
    ['about:blank', 'This page has no address'],
    ['data:text/html,x', 'This page has no address'],
    ['blob:https://login.idp.example/1', 'This page has no address'],
    ['not a url', 'Address unknown'],
    [undefined, 'Address unknown'],
    [null, 'Address unknown'],
  ])('reads %s', (address, line) => {
    expect(addressLine(address)).toBe(line);
  });
});

describe('watchHost', () => {
  const STOP = 'stop';
  const run = (ping: () => Promise<unknown>, answerWindow: Promise<unknown> = new Promise(() => {})) => {
    const reported: boolean[] = [];
    const done = watchHost(
      ping,
      (stalled) => reported.push(stalled),
      (ms) => (ms === 2000 ? answerWindow : Promise.reject(new Error(STOP))),
    );
    return { reported, done };
  };

  it('reports no stall when the host answers in time', async () => {
    const { reported, done } = run(() => Promise.resolve());
    await expect(done).rejects.toThrow(STOP);
    expect(reported).toEqual([false]);
  });

  it('reports a stall when the answer is late, and clears it when the answer comes', async () => {
    let answer = () => {};
    const late = new Promise<void>((resolve) => (answer = resolve));
    const { reported, done } = run(() => late, Promise.resolve());

    await new Promise((resolve) => setImmediate(resolve));
    expect(reported).toEqual([true]);

    answer();
    await expect(done).rejects.toThrow(STOP);
    expect(reported).toEqual([true, false]);
  });

  it('keeps checking after a failure, and clears the stall when the host recovers', async () => {
    const answers = [Promise.reject(new Error('offline')), Promise.resolve()];
    const reported: boolean[] = [];
    let checks = 0;

    const done = watchHost(
      () => answers.shift() as Promise<void>,
      (stalled) => reported.push(stalled),
      (ms) => {
        if (ms === 2000) return new Promise(() => {});
        return ++checks === 2 ? Promise.reject(new Error(STOP)) : Promise.resolve();
      },
    );

    await expect(done).rejects.toThrow(STOP);
    expect(reported.at(0)).toBe(true);
    expect(reported.at(-1)).toBe(false);
  });

  it('stays stalled when the host cannot be reached', async () => {
    const { reported, done } = run(() => Promise.reject(new Error('offline')));
    await expect(done).rejects.toThrow(STOP);
    expect(reported.at(-1)).toBe(true);
  });
});

describe('the embedded page', () => {
  interface FakeSocket {
    readyState: number;
    send: () => void;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
  }

  async function boot() {
    const elements = new Map<string, { textContent: string; src?: string; addEventListener: () => void }>();
    const element = (id: string) => {
      if (!elements.has(id)) elements.set(id, { textContent: '', addEventListener: () => {} });
      return elements.get(id) as { textContent: string; src?: string; addEventListener: () => void };
    };
    const sockets: FakeSocket[] = [];
    const timers: Array<() => void> = [];
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    const script = /<script>([\s\S]*)<\/script>/.exec(VIEWER_PAGE)?.[1] ?? '';
    new Function('document', 'WebSocket', 'fetch', 'location', 'setTimeout', script)(
      { getElementById: element },
      function (this: FakeSocket) {
        this.readyState = 1;
        this.send = () => {};
        sockets.push(this);
      },
      async () => ({ ok: true, json: async () => [{ session: 'default', port: 1 }] }),
      { protocol: 'https:', host: 'takeover.example' },
      (run: () => void) => timers.push(run),
    );
    await settle();
    const receive = (message: unknown) => sockets.at(-1)?.onmessage?.({ data: JSON.stringify(message) });
    const line = () => element('at').textContent;
    return { element, sockets, timers, settle, receive, line };
  }

  it('starts unknown, takes the active tab on connect, and follows each navigation', async () => {
    const { receive, line } = await boot();
    expect(line()).toBe('');
    expect(VIEWER_PAGE).toContain('<div id="at">Address unknown</div>');

    receive({ type: 'tabs', tabs: [{ active: true, title: 'login.idp.example', url: 'https://forge.example/x' }] });
    expect(line()).toBe('You are on forge.example');

    receive({ type: 'url', url: 'https://login.idp.example/' });
    expect(line()).toBe('You are on login.idp.example');
  });

  it('drops a stale host when a report names none', async () => {
    const { receive, line } = await boot();
    receive({ type: 'url', url: 'https://login.idp.example/' });

    receive({ type: 'tabs', tabs: [] });

    expect(line()).toBe('Address unknown');
  });

  it('drops the host when the stream drops, and takes it back from the next stream', async () => {
    const { sockets, timers, settle, receive, line } = await boot();
    receive({ type: 'url', url: 'https://login.idp.example/' });

    sockets.at(-1)?.onclose?.();
    expect(line()).toBe('Address unknown');

    timers.splice(0).forEach((run) => run());
    await settle();
    expect(sockets).toHaveLength(2);
    receive({ type: 'tabs', tabs: [{ active: true, url: 'https://login.idp.example/' }] });
    expect(line()).toBe('You are on login.idp.example');
  });

  it('keeps showing frames after a malformed message', async () => {
    const { element, sockets, receive, line } = await boot();
    receive({ type: 'url', url: 'https://login.idp.example/' });

    expect(() => sockets.at(-1)?.onmessage?.({ data: 'not json' })).not.toThrow();
    receive({ type: 'tabs', tabs: [null] });
    receive({ type: 'frame', data: 'AAAA' });

    expect(element('v').src).toBe('data:image/jpeg;base64,AAAA');
    expect(line()).toBe('Address unknown');
  });

  it('leaves the host alone on a message that is not a report', async () => {
    const { receive, line } = await boot();
    receive({ type: 'url', url: 'https://login.idp.example/' });

    receive({ type: 'status', viewportWidth: 430, url: 'https://forge.example/' });

    expect(line()).toBe('You are on login.idp.example');
  });
});

describe('VIEWER_PAGE', () => {
  it('starts the type-in box masked, so a phone keyboard treats it as a password', () => {
    expect(VIEWER_PAGE).toMatch(/<input id="t" type="password"/);
  });

  it('inlines the same two functions the tests above exercise, as a parseable script', () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(VIEWER_PAGE)?.[1] ?? '';
    expect(script).toContain(virtualKeyCode.toString());
    expect(script).toContain(textEdit.toString());
    expect(() => new Function(script)).not.toThrow();
  });
});

describe('agent-browser stream contract', () => {
  it('is pinned to the version whose frame, status, input_mouse and input_keyboard messages the viewer was verified against', () => {
    // A bump must rerun the phone takeover end to end (docs/browser-takeover.md) before moving this pin.
    const dockerfile = fs.readFileSync(path.join(process.cwd(), 'container/Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/^ARG AGENT_BROWSER_VERSION=0\.38\.2$/m);
  });
});
