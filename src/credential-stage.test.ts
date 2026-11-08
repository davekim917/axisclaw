import fs from 'fs';
import os from 'os';
import path from 'path';

import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { stageDbtProfiles, tagSnowflakeConnections } from './credential-stage.js';

let home: string;
let dest: string;

function writeKey(rel: string): void {
  const p = path.join(home, '.snowflake', 'keys', rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `fake-key-${rel}`);
}

function writeProfiles(profiles: Record<string, unknown>): string {
  const p = path.join(home, '.dbt', 'profiles.yml');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, YAML.stringify(profiles));
  return p;
}

function snowflakeProfile(auth: Record<string, unknown>): Record<string, unknown> {
  return { target: 'dev', outputs: { dev: { type: 'snowflake', account: 'acct', user: 'u', ...auth } } };
}

type StagedProfiles = Record<string, { outputs: Record<string, Record<string, unknown>> }>;

function stage(allowedProfiles: string[] | null): StagedProfiles {
  stageDbtProfiles({
    profilesPath: path.join(home, '.dbt', 'profiles.yml'),
    home,
    dest,
    allowedProfiles,
    agent: 't',
    queryTag: 'grp:sess-1',
  });
  return YAML.parse(fs.readFileSync(path.join(dest, 'profiles.yml'), 'utf-8')) as StagedProfiles;
}

function stagedKeys(): string[] {
  const keysDir = path.join(dest, 'keys');
  if (!fs.existsSync(keysDir)) return [];
  return fs
    .readdirSync(keysDir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(keysDir, path.join(e.parentPath, e.name)))
    .sort();
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dbt-stage-home-'));
  dest = fs.mkdtempSync(path.join(os.tmpdir(), 'dbt-stage-dest-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dest, { recursive: true, force: true });
});

describe('stageDbtProfiles', () => {
  it('refuses a profile whose output carries an inline private_key, keeping the others', () => {
    writeKey('ok/rsa_key.p8');
    writeProfiles({
      inline: {
        target: 'dev',
        outputs: {
          dev: { type: 'snowflake', private_key_path: path.join(home, '.snowflake/keys/ok/rsa_key.p8') },
          prod: { type: 'snowflake', private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' },
        },
      },
      pw: snowflakeProfile({ password: 'x' }),
    });

    const staged = stage(null);

    expect(Object.keys(staged)).toEqual(['pw']);
    expect(fs.readFileSync(path.join(dest, 'profiles.yml'), 'utf-8')).not.toContain('PRIVATE KEY');
    expect(stagedKeys()).toEqual([]);
  });

  it('rewrites private_key_path to the container dir and copies only the referenced key at 0600', () => {
    writeKey('qz/rsa_key.p8');
    writeKey('qz/rsa_key.pub');
    writeKey('other/rsa_key.p8');
    writeProfiles({ qz: snowflakeProfile({ private_key_path: path.join(home, '.snowflake/keys/qz/rsa_key.p8') }) });

    const staged = stage(null);

    expect(staged.qz.outputs.dev.private_key_path).toBe('/home/node/.dbt/keys/.snowflake/keys/qz/rsa_key.p8');
    expect(stagedKeys()).toEqual([path.join('.snowflake', 'keys', 'qz', 'rsa_key.p8')]);
    const copied = path.join(dest, 'keys', '.snowflake', 'keys', 'qz', 'rsa_key.p8');
    expect(fs.statSync(copied).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(copied, 'utf-8')).toBe('fake-key-qz/rsa_key.p8');
  });

  it('expands a ~/ private_key_path against home', () => {
    writeKey('t/rsa_key.p8');
    writeProfiles({ t: snowflakeProfile({ private_key_path: '~/.snowflake/keys/t/rsa_key.p8' }) });

    expect(stage(null).t.outputs.dev.private_key_path).toBe('/home/node/.dbt/keys/.snowflake/keys/t/rsa_key.p8');
    expect(stagedKeys()).toEqual([path.join('.snowflake', 'keys', 't', 'rsa_key.p8')]);
  });

  it('scoped staging copies only the keys of the allowed profiles', () => {
    writeKey('a/rsa_key.p8');
    writeKey('b/rsa_key.p8');
    writeProfiles({
      a: snowflakeProfile({ private_key_path: path.join(home, '.snowflake/keys/a/rsa_key.p8') }),
      b: snowflakeProfile({ private_key_path: path.join(home, '.snowflake/keys/b/rsa_key.p8') }),
    });

    const staged = stage(['a']);

    expect(Object.keys(staged)).toEqual(['a']);
    expect(stagedKeys()).toEqual([path.join('.snowflake', 'keys', 'a', 'rsa_key.p8')]);
  });

  it.each([
    ['outside home', '/etc/passwd'],
    ['relative', 'keys/rsa_key.p8'],
    ['traversing out of home', '~/../escape.p8'],
    ['missing', '~/.snowflake/keys/none.p8'],
  ])('refuses a profile whose private_key_path is %s', (_label, keyPath) => {
    writeProfiles({ bad: snowflakeProfile({ private_key_path: keyPath }), pw: snowflakeProfile({ password: 'x' }) });

    expect(Object.keys(stage(null))).toEqual(['pw']);
    expect(stagedKeys()).toEqual([]);
  });

  it('refuses an inline private_key reached through a YAML merge key from a filtered-out profile', () => {
    fs.mkdirSync(path.join(home, '.dbt'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.dbt', 'profiles.yml'),
      [
        'hidden:',
        '  outputs:',
        '    dev: &base',
        '      type: snowflake',
        '      private_key: FAKE_INLINE_KEY',
        'visible:',
        '  outputs:',
        '    dev:',
        '      <<: *base',
        '      user: u',
        '',
      ].join('\n'),
    );

    expect(stage(['visible'])).toEqual({});
    expect(fs.readFileSync(path.join(dest, 'profiles.yml'), 'utf-8')).not.toContain('FAKE_INLINE_KEY');
  });

  it('refuses an inline private_key nested anywhere in a profile or a non-profile entry', () => {
    writeProfiles({
      nested: { target: 'dev', outputs: { dev: { type: 'snowflake', extra: [{ private_key: 'FAKE_INLINE_KEY' }] } } },
      config: { private_key: 'FAKE_INLINE_KEY' },
      pw: snowflakeProfile({ password: 'x' }),
    });

    expect(Object.keys(stage(null))).toEqual(['pw']);
    expect(fs.readFileSync(path.join(dest, 'profiles.yml'), 'utf-8')).not.toContain('FAKE_INLINE_KEY');
  });

  it('refuses a top-level private_key, an alias of an inline key under another field, and a PEM under any field', () => {
    fs.mkdirSync(path.join(home, '.dbt'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.dbt', 'profiles.yml'),
      [
        'private_key: FAKE_ROOT_KEY',
        'hidden:',
        '  outputs:',
        '    dev:',
        '      private_key: &pk FAKE_ALIASED_KEY',
        'aliased:',
        '  outputs:',
        '    dev:',
        '      query_tag: *pk',
        'pem:',
        '  outputs:',
        '    dev:',
        '      token: "-----BEGIN PRIVATE KEY-----\\nabc"',
        'pw:',
        '  outputs:',
        '    dev:',
        '      password: x',
        '',
      ].join('\n'),
    );

    expect(Object.keys(stage(['private_key', 'aliased', 'pem', 'pw']))).toEqual(['pw']);
    const text = fs.readFileSync(path.join(dest, 'profiles.yml'), 'utf-8');
    expect(text).not.toMatch(/FAKE_|PRIVATE KEY/);
  });

  it.each([null, ''])('treats private_key_path %j as absent', (keyPath) => {
    writeProfiles({ oauth: snowflakeProfile({ authenticator: 'oauth', private_key_path: keyPath }) });

    expect(Object.keys(stage(null))).toEqual(['oauth']);
    expect(stagedKeys()).toEqual([]);
  });

  it('refuses a private_key_path that is a symlink inside home to a file outside it', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dbt-stage-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret'), 'outside');
      fs.mkdirSync(path.join(home, 'keys'));
      fs.symlinkSync(path.join(outside, 'secret'), path.join(home, 'keys', 'link.p8'));
      writeProfiles({ bad: snowflakeProfile({ private_key_path: '~/keys/link.p8' }) });

      expect(stage(null)).toEqual({});
      expect(stagedKeys()).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('throws on a profiles.yml that is not a mapping', () => {
    fs.mkdirSync(path.join(home, '.dbt'), { recursive: true });
    fs.writeFileSync(path.join(home, '.dbt', 'profiles.yml'), '- a\n- b\n');

    expect(() => stage(null)).toThrow('not a mapping');
  });
});

describe('dbt query_tag', () => {
  it('tags every snowflake output and leaves an existing query_tag and other adapters alone', () => {
    writeProfiles({
      a: {
        target: 'dev',
        outputs: {
          dev: { type: 'snowflake', account: 'acct', user: 'u' },
          prod: { type: 'snowflake', account: 'acct', user: 'u', query_tag: 'nightly' },
          pg: { type: 'postgres', host: 'h' },
        },
      },
    });
    const outputs = stage(null).a.outputs;
    expect(outputs.dev.query_tag).toBe('grp:sess-1');
    expect(outputs.prod.query_tag).toBe('nightly');
    expect(outputs.pg).toEqual({ type: 'postgres', host: 'h' });
  });
});

describe('tagSnowflakeConnections', () => {
  const tagLine = 'session_parameters = { QUERY_TAG = "grp:sess-1" }';

  it('adds the tag to each connection right under its header', () => {
    expect(tagSnowflakeConnections('[a]\nuser = "u"\n\n[b]\nuser = "v"\n', 'grp:sess-1')).toBe(
      `[a]\n${tagLine}\nuser = "u"\n\n[b]\n${tagLine}\nuser = "v"\n`,
    );
  });

  it('tags a file whose lines carry trailing whitespace', () => {
    expect(tagSnowflakeConnections('[a] \t\nuser = "u"  \n', 'grp:sess-1')).toBe(`[a] \t\n${tagLine}\nuser = "u"  \n`);
  });

  it('keeps a connection that already declares session_parameters and tags the rest', () => {
    const toml = '[own]\nsession_parameters = { QUERY_TAG = "job" }\n[other] # note\r\nuser = "u"\r\n';
    expect(tagSnowflakeConnections(toml, 'grp:sess-1')).toBe(
      `[own]\nsession_parameters = { QUERY_TAG = "job" }\n[other] # note\r\n${tagLine}\nuser = "u"\r\n`,
    );
  });

  it.each([
    ['a dotted session_parameters key', '[a]\nsession_parameters.QUERY_TAG = "job"\n'],
    ['a session_parameters subtable', '[a]\nuser = "u"\n[a.session_parameters]\nQUERY_TAG = "job"\n'],
    ['a quoted session_parameters subtable', '[a]\nuser = "u"\n[a."session_parameters"]\nQUERY_TAG = "job"\n'],
    ['an escaped key', '[a]\n"\\u0073ession_parameters" = { QUERY_TAG = "job" }\n'],
    ['a quoted connection name', '["a"]\nuser = "u"\n'],
    ['a header-shaped line inside a multi-line string', '[a]\npassword = """\n[salt]\n"""\n'],
    ['an array of tables', '[[a]]\nuser = "u"\n'],
    [
      'a multi-line string opened inside an inline table',
      '[a]\nsession_parameters = { QUERY_TAG = """start" }\n[decoy]\nx = { y = "end""" }\n',
    ],
    [
      'a literal multi-line string opened inside an inline table',
      "[a]\nx = { y = '''start' }\n[decoy]\nz = { w = 'end''' }\n",
    ],
  ])('returns null rather than editing a file with %s', (_shape, toml) => {
    expect(tagSnowflakeConnections(toml, 'grp:sess-1')).toBeNull();
  });

  it('changes nothing when there is no connection', () => {
    expect(tagSnowflakeConnections('', 'grp:sess-1')).toBe('');
    expect(tagSnowflakeConnections('# none\n', 'grp:sess-1')).toBe('# none\n');
  });
});
