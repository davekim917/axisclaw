import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  requests: [] as string[],
  bodies: [] as unknown[],
}));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFile: (_bin: string, _argv: string[], _options: unknown, callback: unknown) => {
      const done = callback as (e: Error | null, out: string, err: string) => void;
      return {
        stdin: {
          on: () => undefined,
          end: (config = '') => {
            h.requests.push(String(/--request (\w+)/.exec(config)?.[1]));
            const data = /--data-binary "(.*)"/.exec(config)?.[1];
            if (data) h.bodies.push(JSON.parse(data.replace(/\\(.)/g, '$1')));
            const reply = config.includes('--request GET')
              ? `${JSON.stringify(h.rows)}\n200`
              : config.includes('--request POST')
                ? `{"id":"new","name":"Created"}\n201`
                : '{}\n200';
            queueMicrotask(() => done(null, reply, ''));
          },
        },
      };
    },
  };
});

import { putOnecliBearerSecret, updateOnecliSecretValue } from './onecli-secret-writer.js';

const SPEC = {
  name: 'Example-Bearer',
  hostPattern: 'api.example.test',
  headerName: 'Authorization',
  valueFormat: 'Bearer {value}',
};

describe('putOnecliBearerSecret', () => {
  beforeEach(() => {
    h.rows = [];
    h.requests = [];
  });

  it('creates a secret the vault does not hold', async () => {
    expect(await putOnecliBearerSecret(SPEC, 'token')).toEqual({ id: 'new', name: 'Created' });
    expect(h.requests).toEqual(['GET', 'POST']);
  });

  it('adopts a same-named secret on the same host, whatever the case', async () => {
    h.rows = [{ id: 's1', name: SPEC.name, hostPattern: 'API.Example.test' }];
    expect(await putOnecliBearerSecret(SPEC, 'token')).toEqual({ id: 's1', name: SPEC.name });
    expect(h.requests).toEqual(['GET', 'PATCH']);
  });

  it.each([
    [
      'on another host',
      [{ id: 's1', name: SPEC.name, hostPattern: 'old.example.test' }],
      /injects on old\.example\.test/,
    ],
    ['with no host in the listing', [{ id: 's1', name: SPEC.name }], /injects on an unknown host/],
    [
      'with one copy on the right host and one elsewhere',
      [
        { id: 's1', name: SPEC.name, hostPattern: SPEC.hostPattern },
        { id: 's2', name: SPEC.name, hostPattern: 'old.example.test' },
      ],
      /injects on old\.example\.test/,
    ],
  ])('refuses a same-named secret %s, writing nothing', async (_name, rows, reason) => {
    h.rows = rows;
    await expect(putOnecliBearerSecret(SPEC, 'token')).rejects.toThrow(reason);
    expect(h.requests).toEqual(['GET']);
  });
});

describe('updateOnecliSecretValue', () => {
  beforeEach(() => {
    h.requests = [];
    h.bodies = [];
  });

  it('sends the value alone, or with the host and path the secret moves to', async () => {
    await updateOnecliSecretValue({ id: 's1', name: 'Example' }, 'one');
    await updateOnecliSecretValue({ id: 's1', name: 'Example' }, 'two', {
      hostPattern: 'api.example.test',
      pathPattern: '/v1/*',
    });

    expect(h.requests).toEqual(['PATCH', 'PATCH']);
    expect(h.bodies).toEqual([
      { value: 'one' },
      { value: 'two', hostPattern: 'api.example.test', pathPattern: '/v1/*' },
    ]);
  });
});
