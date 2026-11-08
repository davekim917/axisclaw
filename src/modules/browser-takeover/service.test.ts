import fs from 'fs';
import os from 'os';
import path from 'path';

import { DiscordFormatConverter } from '@chat-adapter/discord';
import { parseMarkdown } from 'chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  origin: 'https://browser.example.test',
  lockdown: false,
  dataDir: '',
  chromiumVersion: 'Chromium 155.0.8059.79 built on Debian GNU/Linux 12 (bookworm)\n',
  dashboardStdout: 'Dashboard started\nhttps://browser.example.test/#dashboard-access-token=dash-token-1\n',
  stateJson: JSON.stringify({
    cookies: [
      { name: 'app', value: 'a', domain: 'app.example.com' },
      { name: 'parent', value: 'p', domain: '.example.com' },
      { name: 'idp', value: 'i', domain: 'login.idp.example' },
      { name: 'sibling', value: 's', domain: 'other.example.com' },
      { name: 'parentHostOnly', value: 'h', domain: 'example.com' },
    ],
    origins: [
      { origin: 'https://app.example.com', localStorage: [{ name: 'token', value: 't' }] },
      { origin: 'https://login.idp.example', localStorage: [{ name: 'idp', value: 'i' }] },
      { origin: 'https://app.example.com:8443', localStorage: [{ name: 'otherPort', value: 'o' }] },
    ],
  }),
  agentMounts: '',
  holdDm: null as Promise<void> | null,
  reached: true,
  dms: [] as string[],
  docker: [] as string[][],
}));

vi.mock('../../config.js', async (orig) => ({
  ...(await orig<typeof import('../../config.js')>()),
  get BROWSER_TAKEOVER_ORIGIN() {
    return h.origin;
  },
  get DATA_DIR() {
    return h.dataDir;
  },
  get GROUPS_DIR() {
    return `${h.dataDir}/groups`;
  },
  get EGRESS_LOCKDOWN() {
    return h.lockdown;
  },
}));
vi.mock('child_process', async (orig) => ({
  ...(await orig<typeof import('child_process')>()),
  execFile: (_bin: string, args: string[], _opts: unknown, cb: (e: null, r: { stdout: string }) => void) => {
    h.docker.push(args);
    const has = (...words: string[]) => words.every((w) => args.includes(w));
    let stdout = '';
    if (args[0] === 'inspect') stdout = args[2].includes('Mounts') ? h.agentMounts : 'sha256:example-agent-image\n';
    else if (has('chromium', '--version')) stdout = h.chromiumVersion;
    else if (has('dashboard', 'start')) stdout = h.dashboardStdout;
    else if (args[0] === 'exec' && args.includes('cat')) stdout = h.stateJson;
    cb(null, { stdout });
  },
}));
vi.mock('../../container-runner.js', () => ({
  containerIdentityFor: () => ({ containerName: 'nanoclaw-v2-example-agent', claimIncarnation: 1 }),
}));
vi.mock('../../operator-alert.js', () => ({
  notifyOperators: async (text: string) => {
    h.dms.push(text);
    const reached = h.reached;
    if (h.holdDm) await h.holdDm;
    return reached;
  },
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: async () => ({ name: 'example-agent', workgroup_id: 'example-wg', folder: 'example-agent' }),
}));

import {
  BINDING_TTL_MS,
  consumeTakeoverLink,
  describeTakeoverLink,
  finishBrowserTakeover,
  LINK_TTL_MS,
  resolveTakeoverBinding,
  startBrowserTakeover,
} from './service.js';
import { scrubSecrets } from '../../secret-scrubber.js';

const REQUEST = {
  sessionId: 'sess-1',
  agentGroupId: 'ag-1',
  url: 'https://app.example.com/login',
  site: 'example',
};

function linkFromLastDm(): string {
  const match = /https:\/\/browser\.example\.test\/t\/([A-Za-z0-9_-]+)/.exec(h.dms.at(-1) ?? '');
  if (!match) throw new Error(`no link in DM: ${h.dms.at(-1)}`);
  return match[1];
}

const sidecarRuns = () => h.docker.filter((a) => a[0] === 'run' && a.includes('-d'));
const sidecarName = (run: string[]) => run[run.indexOf('--name') + 1];
const removed = () => h.docker.filter((a) => a[0] === 'rm').map((a) => a.at(-1));

beforeEach(() => {
  h.origin = 'https://browser.example.test';
  h.lockdown = false;
  h.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takeover-'));
  h.dashboardStdout = 'https://browser.example.test/#dashboard-access-token=dash-token-1\n';
  h.chromiumVersion = 'Chromium 155.0.8059.79 built on Debian GNU/Linux 12 (bookworm)\n';
  h.agentMounts = '';
  h.reached = true;
  h.holdDm = null;
  h.dms = [];
  h.docker = [];
});

afterEach(async () => {
  vi.useRealTimers();
  await finishBrowserTakeover(REQUEST.sessionId).catch(() => {});
  fs.rmSync(h.dataDir, { recursive: true, force: true });
});

describe('startBrowserTakeover', () => {
  it("reads Chromium's version from the agent's image, so the user agent names the browser that actually runs", async () => {
    h.chromiumVersion = 'Chromium 161.0.1.2 built on Debian\n';
    await startBrowserTakeover(REQUEST);
    expect(h.docker).toContainEqual([
      'run',
      '--rm',
      '--entrypoint',
      'chromium',
      'sha256:example-agent-image',
      '--version',
    ]);
    expect(sidecarRuns()[0]).toContain(
      'AGENT_BROWSER_USER_AGENT=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/161.0.0.0 Safari/537.36',
    );
  });

  it('still hides the automation flag when the Chromium version cannot be read, without inventing a user agent', async () => {
    h.chromiumVersion = '';
    await startBrowserTakeover(REQUEST);
    const run = sidecarRuns()[0];
    expect(run).toContain('AGENT_BROWSER_ARGS=--disable-blink-features=AutomationControlled');
    expect(run.some((a) => a.startsWith('AGENT_BROWSER_USER_AGENT='))).toBe(false);
  });

  it("opens the URL in a bare sidecar from the agent's image, never in the agent's own container", async () => {
    await startBrowserTakeover(REQUEST);
    const [run] = sidecarRuns();
    const name = sidecarName(run);
    expect(run).toContain('sha256:example-agent-image');
    expect(run.some((a) => a === '-v' || a.startsWith('--mount') || a === '--volume')).toBe(false);
    expect(run.filter((_, i) => run[i - 1] === '-e')).toEqual([
      'AGENT_BROWSER_ARGS=--disable-blink-features=AutomationControlled',
      'AGENT_BROWSER_USER_AGENT=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
    ]);
    expect(h.docker).toContainEqual(['exec', name, 'agent-browser', 'open', 'https://app.example.com/login']);
    expect(h.docker).toContainEqual(['exec', name, 'agent-browser', 'set', 'viewport', '430', '900']);
    expect(h.docker).toContainEqual([
      'exec',
      name,
      'agent-browser',
      'dashboard',
      'start',
      '--port',
      '4848',
      '--allowed-origins',
      'https://browser.example.test',
    ]);
    expect(h.docker.some((a) => a[0] === 'exec' && a[1] === 'nanoclaw-v2-example-agent')).toBe(false);

    expect(h.dms.at(-1)).toContain('example-agent needs you to sign in to app.example.com');
    const link = linkFromLastDm();
    const spent = consumeTakeoverLink(link);
    expect(resolveTakeoverBinding(spent!.bindingId)).toEqual({ containerName: name, dashboardToken: 'dash-token-1' });
    expect(consumeTakeoverLink(link)).toBeNull();
  });

  it.each([
    ['no takeover origin', { origin: '' }, {}, /BROWSER_TAKEOVER_ORIGIN/],
    ['egress lockdown, which the sidecar would escape', { lockdown: true }, {}, /egress lockdown/],
    ['a site name that is a path', {}, { site: '../x' }, /--site/],
    ['a non-http URL', {}, { url: 'file:///etc/passwd' }, /--url/],
  ])('refuses %s before starting anything', async (_label, env, input, error) => {
    Object.assign(h, env);
    await expect(startBrowserTakeover({ ...REQUEST, ...input })).rejects.toThrow(error);
    expect(h.docker).toEqual([]);
  });

  it('removes the sidecar and sends nothing when the dashboard prints no access URL', async () => {
    h.dashboardStdout = 'something else';
    await expect(startBrowserTakeover(REQUEST)).rejects.toThrow(/no access URL/);
    expect(removed()).toEqual([sidecarName(sidecarRuns()[0])]);
    expect(h.dms).toEqual([]);
  });

  it('removes the sidecar and kills the link when no owner could be reached', async () => {
    h.reached = false;
    await expect(startBrowserTakeover(REQUEST)).rejects.toThrow(/reached by DM/);
    expect(removed()).toEqual([sidecarName(sidecarRuns()[0])]);
    expect(consumeTakeoverLink(linkFromLastDm())).toBeNull();
  });

  it("a new request replaces the session's open takeover: its sidecar, link and binding all go", async () => {
    await startBrowserTakeover(REQUEST);
    const spent = consumeTakeoverLink(linkFromLastDm());
    await startBrowserTakeover(REQUEST);
    const unspent = linkFromLastDm();
    await startBrowserTakeover(REQUEST);

    const [first, second] = sidecarRuns().map(sidecarName);
    expect(removed()).toEqual([first, second]);
    expect(resolveTakeoverBinding(spent!.bindingId)).toBeNull();
    expect(consumeTakeoverLink(unspent)).toBeNull();
    expect(consumeTakeoverLink(linkFromLastDm())).not.toBeNull();
  });
});

describe('overlapping requests', () => {
  it("an older request's failed DM does not tear down the newer takeover that replaced it", async () => {
    let release!: () => void;
    h.holdDm = new Promise((r) => (release = r));
    h.reached = false;
    const older = startBrowserTakeover(REQUEST);
    await vi.waitFor(() => expect(h.dms).toHaveLength(1));
    h.holdDm = null;
    h.reached = true;
    await startBrowserTakeover(REQUEST);
    const newer = linkFromLastDm();
    release();
    await expect(older).rejects.toThrow(/reached by DM/);

    expect(consumeTakeoverLink(newer)).not.toBeNull();
  });
});

describe('finishBrowserTakeover', () => {
  it("files only the target host's session as a 0600 login, never the identity provider's, then removes the sidecar", async () => {
    await startBrowserTakeover(REQUEST);
    const spent = consumeTakeoverLink(linkFromLastDm());
    const name = sidecarName(sidecarRuns()[0]);

    await expect(finishBrowserTakeover(REQUEST.sessionId)).resolves.toEqual({
      path: '/workspace/browser-state/example.json',
    });
    const file = path.join(h.dataDir, 'browser-state', 'example-wg', 'example.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      cookies: [
        { name: 'app', value: 'a', domain: 'app.example.com' },
        { name: 'parent', value: 'p', domain: '.example.com' },
      ],
      origins: [{ origin: 'https://app.example.com', localStorage: [{ name: 'token', value: 't' }] }],
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(removed()).toEqual([name]);
    expect(resolveTakeoverBinding(spent!.bindingId)).toBeNull();
    await expect(finishBrowserTakeover(REQUEST.sessionId)).rejects.toThrow(/No takeover is open/);
  });

  it('refuses to file a sign-in that left nothing for the target host', async () => {
    const full = h.stateJson;
    h.stateJson = JSON.stringify({ cookies: [{ name: 'idp', value: 'i', domain: 'login.idp.example' }], origins: [] });
    await startBrowserTakeover(REQUEST);
    await expect(finishBrowserTakeover(REQUEST.sessionId)).rejects.toThrow(/no session for app\.example\.com/);
    expect(fs.existsSync(path.join(h.dataDir, 'browser-state', 'example-wg', 'example.json'))).toBe(false);
    h.stateJson = full;
  });

  it('replaces a container-planted symlink at the login path instead of writing through it', async () => {
    const outside = path.join(h.dataDir, 'v2.db');
    fs.writeFileSync(outside, 'central');
    const dir = path.join(h.dataDir, 'browser-state', 'example-wg');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync('../../v2.db', path.join(dir, 'example.json'));
    await startBrowserTakeover(REQUEST);

    await finishBrowserTakeover(REQUEST.sessionId);
    expect(fs.readFileSync(outside, 'utf8')).toBe('central');
    const saved = fs.lstatSync(path.join(dir, 'example.json'));
    expect(saved.isFile()).toBe(true);
    expect(saved.mode & 0o777).toBe(0o600);
  });
});

describe('a site an owner widened with browserSso', () => {
  const IDP_STATE = JSON.stringify({
    cookies: [
      { name: 'app', value: 'a', domain: 'app.example.com' },
      { name: 'idp', value: 'i', domain: 'login.idp.example' },
      { name: 'idpParent', value: 'p', domain: '.idp.example' },
      { name: 'idpSibling', value: 's', domain: 'mail.idp.example' },
      { name: 'unrelated', value: 'u', domain: 'tracker.other.example' },
    ],
    origins: [
      { origin: 'https://app.example.com', localStorage: [], sessionStorage: [{ name: 'token', value: 't' }] },
      { origin: 'https://login.idp.example', localStorage: [{ name: 'idp', value: 'i' }] },
      { origin: 'http://login.idp.example', localStorage: [{ name: 'insecure', value: 'x' }] },
      { origin: 'https://mail.idp.example', localStorage: [{ name: 'mail', value: 'm' }] },
    ],
  });
  const sharedFile = () => path.join(h.dataDir, 'browser-state', 'example-wg', 'example.json');
  const privateFile = () => path.join(h.dataDir, 'browser-state-private', 'example-agent', 'example.json');
  const sidecarStarted = () => h.docker.some((a) => a[0] === 'run');

  function configure(browserSso: unknown): void {
    const dir = path.join(h.dataDir, 'groups', 'example-agent');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'container.json'), JSON.stringify({ browserSso }));
  }

  let original: string;
  beforeEach(() => {
    original = h.stateJson;
    h.stateJson = IDP_STATE;
    h.agentMounts = '/workspace/agent\n/workspace/browser-state-private\n';
  });
  afterEach(() => {
    h.stateJson = original;
  });

  it("keeps the listed host's cookies and origin in a 0600 file no sibling mounts, and drops the rest", async () => {
    configure({ example: ['login.idp.example'] });
    await startBrowserTakeover(REQUEST);

    await expect(finishBrowserTakeover(REQUEST.sessionId)).resolves.toEqual({
      path: '/workspace/browser-state-private/example.json',
      privateToAgent: true,
    });

    expect(JSON.parse(fs.readFileSync(privateFile(), 'utf8'))).toEqual({
      cookies: [
        { name: 'app', value: 'a', domain: 'app.example.com' },
        { name: 'idp', value: 'i', domain: 'login.idp.example' },
        { name: 'idpParent', value: 'p', domain: '.idp.example' },
      ],
      origins: [
        { origin: 'https://app.example.com', localStorage: [], sessionStorage: [{ name: 'token', value: 't' }] },
        { origin: 'https://login.idp.example', localStorage: [{ name: 'idp', value: 'i' }] },
      ],
    });
    expect(fs.statSync(privateFile()).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(sharedFile())).toBe(false);
  });

  it('files the provider session even when the app itself left nothing, as a token held only in memory does', async () => {
    h.stateJson = JSON.stringify({ cookies: [{ name: 'idp', value: 'i', domain: 'login.idp.example' }], origins: [] });
    configure({ example: ['login.idp.example'] });
    await startBrowserTakeover(REQUEST);

    await finishBrowserTakeover(REQUEST.sessionId);

    expect(JSON.parse(fs.readFileSync(privateFile(), 'utf8')).cookies).toHaveLength(1);
  });

  it("leaves another site's takeover exactly as it was, byte for byte", async () => {
    h.stateJson = original;
    configure({ 'other-site': ['login.idp.example'] });
    await startBrowserTakeover(REQUEST);

    expect(h.dms.at(-1)?.replace(/\/t\/\S+/, '/t/LINK')).toBe(
      'example-agent needs you to sign in to app.example.com\n' +
        'https://browser.example.test/t/LINK\n' +
        'The link opens once and expires in 30 minutes. You sign in to a separate browser the agent cannot see; only ' +
        'its session for app.example.com is handed over. Tell the agent in its conversation when you are done.',
    );
    await expect(finishBrowserTakeover(REQUEST.sessionId)).resolves.toEqual({
      path: '/workspace/browser-state/example.json',
    });
    expect(fs.readFileSync(sharedFile(), 'utf8')).toBe(
      '{"cookies":[{"name":"app","value":"a","domain":"app.example.com"},' +
        '{"name":"parent","value":"p","domain":".example.com"}],' +
        '"origins":[{"origin":"https://app.example.com","localStorage":[{"name":"token","value":"t"}]}]}',
    );
    expect(fs.existsSync(privateFile())).toBe(false);
    expect(h.docker.some((a) => a[0] === 'inspect' && a[2].includes('Mounts'))).toBe(false);
  });

  it('names the hosts to the owner before they sign in, in the DM and for the page, spending nothing', async () => {
    configure({ example: ['login.idp.example', 'sso.idp.example'] });
    await startBrowserTakeover(REQUEST);

    expect(h.dms.at(-1)).toContain(
      'example-agent alone gets its session for app.example.com and your sign-in at login.idp.example, ' +
        'sso.idp.example. That sign-in can open other apps that use it, not only app.example.com.',
    );
    const link = linkFromLastDm();
    expect(describeTakeoverLink(link)).toEqual({
      host: 'app.example.com',
      extraHosts: ['login.idp.example', 'sso.idp.example'],
    });
    expect(consumeTakeoverLink(link)).not.toBeNull();
    expect(describeTakeoverLink(link)).toBeNull();
  });

  it('hands over what the owner was told, even if the entry changes before finish', async () => {
    configure({ example: ['login.idp.example'] });
    await startBrowserTakeover(REQUEST);
    configure({ example: ['tracker.other.example'] });

    await finishBrowserTakeover(REQUEST.sessionId);

    const { cookies } = JSON.parse(fs.readFileSync(privateFile(), 'utf8')) as { cookies: Array<{ name: string }> };
    expect(cookies.map((c) => c.name)).toEqual(['app', 'idp', 'idpParent']);
  });

  it.each<[string, unknown]>([
    ['a wildcard', { example: ['*.idp.example'] }],
    ['a wildcard over a long enough name', { example: ['*.login.idp.example'] }],
    ['a bare public suffix', { example: ['co.uk'] }],
    ['a two-label name', { example: ['idp.example'] }],
    ['a private public suffix', { example: ['github.io'] }],
    ['a top-level domain', { example: ['com'] }],
    ['a single label', { example: ['localhost'] }],
    ['an IP address', { example: ['127.0.0.1'] }],
    ['a URL', { example: ['https://login.idp.example'] }],
    ['a trailing dot', { example: ['login.idp.example.'] }],
    ['upper case', { example: ['Login.Idp.Example'] }],
    ['a value that is not text', { example: [42] }],
    ['an entry that is not a list', { example: 'login.idp.example' }],
    ['a map that is not a map', ['login.idp.example']],
  ])('refuses %s before starting anything', async (_label, browserSso) => {
    configure(browserSso);

    await expect(startBrowserTakeover(REQUEST)).rejects.toThrow(/browserSso/);

    expect(sidecarStarted()).toBe(false);
    expect(h.dms).toEqual([]);
  });

  it.each<[string, unknown, string]>([
    ['an unlisted site', {}, 'only its session for app.example.com is handed over'],
    ['a listed site', { example: ['login.idp.example'] }, 'your sign-in at login.idp.example'],
  ])("files the agent's note on %s below the disclosure, as its own words", async (_l, sso, disclosure) => {
    configure(sso);
    await startBrowserTakeover({ ...REQUEST, reason: "use the company tile, it's second" });

    const lines = (h.dms.at(-1) ?? '').split('\n');
    expect(lines[0]).toBe('example-agent needs you to sign in to app.example.com');
    expect(lines.at(-1)).toBe("The agent's own note, unchecked: use the company tile, it's second");
    expect(lines.at(-2)).toContain(disclosure);
  });

  it('adds no note line when the agent gave no reason', async () => {
    await startBrowserTakeover(REQUEST);
    expect(h.dms.at(-1)?.split('\n')).toHaveLength(3);
  });

  it.each([
    ['the listed host', 'https://login.idp.example/'],
    ['the listed host with a trailing dot', 'https://login.idp.example./'],
    ['the listed host with two trailing dots', 'https://login.idp.example../'],
    ['a host below it', 'https://tenant.login.idp.example/'],
    ['a sibling a parent-domain cookie reaches', 'https://other.idp.example/'],
    ['the parent domain', 'https://idp.example/'],
  ])('refuses %s under a different site, before anything starts', async (_label, url) => {
    configure({ vendor: ['login.idp.example'] });

    await expect(startBrowserTakeover({ ...REQUEST, url })).rejects.toThrow(/--site vendor/);

    expect(sidecarStarted()).toBe(false);
    expect(h.dms).toEqual([]);
  });

  it('refuses an ancestor of a deep listed host, which a cookie scoped there reaches', async () => {
    configure({ vendor: ['sso.login.idp.example'] });
    await expect(startBrowserTakeover({ ...REQUEST, url: 'https://idp.example/' })).rejects.toThrow(/--site vendor/);
  });

  it('refuses a host listed under an empty site name', async () => {
    configure({ '': ['login.idp.example'] });
    await expect(startBrowserTakeover({ ...REQUEST, url: 'https://login.idp.example/' })).rejects.toThrow(
      /shares a sign-in/,
    );
  });

  it('does not read a broken entry for another site as a list', async () => {
    configure({ vendor: 'login.idp.example' });
    await expect(startBrowserTakeover({ ...REQUEST, url: 'https://login.idp.example/' })).resolves.toBeDefined();
  });

  it.each([
    ['a sibling of its parent', 'https://other.login.idp.example/'],
    ['a cousin a cookie on a higher parent reaches', 'https://other.idp.example/'],
    ['a host below that cousin', 'https://child.other.idp.example/'],
  ])('refuses %s, however deep the listed host', async (_label, url) => {
    configure({ vendor: ['sso.login.idp.example'] });
    await expect(startBrowserTakeover({ ...REQUEST, url })).rejects.toThrow(/--site vendor/);
  });

  it('lets a site through when its own list reaches the host, even if another list does too', async () => {
    configure({ vendor: ['login.example.com'], example: ['login.example.com'] });
    await expect(startBrowserTakeover(REQUEST)).resolves.toBeDefined();
  });

  it('lets a site with hosts of its own reach another list, because it files privately', async () => {
    configure({ example: ['login.accounts.example'], reports: ['login.suite.example'] });
    await expect(startBrowserTakeover({ ...REQUEST, url: 'https://portal.suite.example/' })).resolves.toBeDefined();
  });

  it('treats a site with an empty list as unlisted, because it files in the shared directory', async () => {
    configure({ example: [], vendor: ['login.idp.example'] });
    await expect(startBrowserTakeover({ ...REQUEST, url: 'https://login.idp.example/' })).rejects.toThrow(
      /--site vendor/,
    );
  });

  it.each([
    ['backticks', 'https://a``b`.forge.example/'],
    ['an asterisk', 'https://a*b.forge.example/'],
    ['a quote', "https://a'b.forge.example/"],
    ['a dollar sign', 'https://$a.forge.example/'],
  ])('refuses a host holding %s before starting anything', async (_label, url) => {
    await expect(startBrowserTakeover({ ...REQUEST, url })).rejects.toThrow(/plain host/);
    expect(sidecarStarted()).toBe(false);
    expect(h.dms).toEqual([]);
  });

  it.each([
    ['a local name', 'http://localhost:3000/'],
    ['an IPv6 address', 'https://[::1]:8443/'],
    ['an underscore', 'https://dev_box.example.com/'],
    ['a punycode name', 'https://\u0430pp.example.com/'],
  ])('still takes over %s', async (_label, url) => {
    await expect(startBrowserTakeover({ ...REQUEST, url })).resolves.toBeDefined();
  });

  it.each([
    ['a markdown link', '[Continue sign-in](https://elsewhere.example/)', 'Continue sign-in https elsewhere example'],
    ['a slack link', '<https://elsewhere.example|Continue>', 'https elsewhere example Continue'],
    ['backticks', 'a `b` ``c', 'a b c'],
    ['a mention', '<!channel> @everyone', '!channel everyone'],
    ['a bare domain', 'open www.elsewhere.example', 'open www elsewhere example'],
    [
      'entities, bold and a pattern the scrubber rewrites',
      '&#10;&#10;**Host verified: only this app is shared.** [Continue sign-in](https://elsewhere.example/) -u a:b',
      '10 10 Host verified only this app is shared Continue sign-in https elsewhere example -u a b',
    ],
  ])("leaves nothing of %s to act as markup after the scrubber and a channel's renderer", async (_l, reason, kept) => {
    await startBrowserTakeover({ ...REQUEST, reason });

    const delivered = scrubSecrets(h.dms.at(-1) ?? '');
    expect(delivered.split('\n').at(-1)).toBe(`The agent's own note, unchecked: ${kept}`);

    const types = new Set<string>();
    const urls: string[] = [];
    const walk = (node: { type: string; url?: string; children?: unknown[] }) => {
      types.add(node.type);
      if (node.url) urls.push(node.url);
      node.children?.forEach((child) => walk(child as typeof node));
    };
    walk(parseMarkdown(delivered));
    expect(urls.filter((url) => url.includes('elsewhere'))).toEqual([]);
    expect(['strong', 'inlineCode', 'html'].filter((type) => types.has(type))).toEqual([]);
    expect(new DiscordFormatConverter().renderPostable({ markdown: delivered }).split('\n').at(-1)).toBe(
      `The agent's own note, unchecked: ${kept}`,
    );
  });

  it('adds no note line for a reason with nothing plain in it', async () => {
    await startBrowserTakeover({ ...REQUEST, reason: '***' });
    expect(h.dms.at(-1)?.split('\n')).toHaveLength(3);
  });

  it("lets a site's own takeover reach its own listed hosts, which file privately", async () => {
    configure({ example: ['login.example.com'] });
    await expect(startBrowserTakeover(REQUEST)).resolves.toBeDefined();
  });

  it('refuses nothing for a group with no entry', async () => {
    await expect(startBrowserTakeover({ ...REQUEST, url: 'https://login.idp.example/' })).resolves.toBeDefined();
  });

  it('does not judge an entry for another site', async () => {
    configure({ 'other-site': ['*.idp.example'] });
    await expect(startBrowserTakeover(REQUEST)).resolves.toBeDefined();
  });

  it('treats a site named like an object method as unlisted', async () => {
    configure({});
    await startBrowserTakeover({ ...REQUEST, site: 'constructor' });
    expect(h.docker.some((a) => a[0] === 'inspect' && a[2].includes('Mounts'))).toBe(false);
  });

  it('refuses a container started before the entry, before an owner signs in for a file it could not read', async () => {
    h.agentMounts = '/workspace/agent\n';
    configure({ example: ['login.idp.example'] });

    await expect(startBrowserTakeover(REQUEST)).rejects.toThrow(/predates/);

    expect(sidecarStarted()).toBe(false);
    expect(h.dms).toEqual([]);
  });
});

describe('takeover lifetime', () => {
  it('a link expires after its TTL, a binding after its own', async () => {
    vi.useFakeTimers();
    await startBrowserTakeover({ ...REQUEST, sessionId: 'sess-late' });
    const late = linkFromLastDm();
    await startBrowserTakeover(REQUEST);
    const spent = consumeTakeoverLink(linkFromLastDm());

    vi.advanceTimersByTime(LINK_TTL_MS + 1);
    expect(consumeTakeoverLink(late)).toBeNull();
    expect(resolveTakeoverBinding(spent!.bindingId)).not.toBeNull();

    vi.advanceTimersByTime(BINDING_TTL_MS);
    expect(resolveTakeoverBinding(spent!.bindingId)).toBeNull();
  });
});
