import { generateKeyPairSync, verify } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { enforceHermeticity } from '../src/test-hermeticity.js';
import {
  findUploadKey,
  signToken,
  uploadBuild,
  type HttpRequest,
  type HttpResponse,
  type UploadDeps,
  type UploadInput,
} from './mobile-ios-upload.js';

enforceHermeticity();

const API = 'https://api.appstoreconnect.apple.com';
const TOKEN = 'invented.jwt.value';
const INPUT: UploadInput = {
  bundleId: 'example.invented.app',
  version: '9.8.7',
  build: '42',
  fileName: 'invented.ipa',
  ipa: Buffer.from('abcdefgh'),
};
const OPERATIONS = [
  {
    method: 'PUT',
    url: 'https://uploads.example.test/part-1?sig=invented-signature',
    offset: 0,
    length: 5,
    requestHeaders: [{ name: 'Content-Type', value: 'application/octet-stream' }],
  },
  { method: 'PUT', url: 'https://uploads.example.test/part-2?sig=invented-signature', offset: 5, length: 3 },
];

const json = (status: number, value: unknown): HttpResponse => ({ status, text: JSON.stringify(value) });
const state = (value: string, extra: object = {}) => ({
  data: { id: 'upload-1', attributes: { state: { state: value, ...extra } } },
});
const withBuild = (processingState: string) => ({
  ...state('COMPLETE'),
  included: [{ type: 'builds', attributes: { processingState } }],
});

type Step = HttpResponse | Error;

interface Harness {
  deps: UploadDeps;
  requests: HttpRequest[];
  lines: string[];
  calls: () => string[];
}

function harness(script: {
  partResponses?: Step[];
  uploadPolls?: Step[];
  createFile?: HttpResponse;
  sleepAdvanceMs?: number;
}): Harness {
  const requests: HttpRequest[] = [];
  const lines: string[] = [];
  const parts = [...(script.partResponses ?? [])];
  const polls = [...(script.uploadPolls ?? [])];
  let clock = 0;
  const take = (queue: Step[], fallback: HttpResponse): HttpResponse => {
    const step = queue.shift() ?? fallback;
    if (step instanceof Error) throw step;
    return step;
  };
  const respond = (request: HttpRequest): HttpResponse => {
    const pathname = request.url.replace(API, '').split('?')[0];
    if (request.url.startsWith('https://uploads.example.test/')) return take(parts, { status: 200, text: '' });
    if (request.method === 'GET' && pathname === '/v1/apps') {
      return json(200, {
        data: [
          { id: 'other-app', attributes: { bundleId: 'example.invented.app.extension' } },
          { id: 'app-1', attributes: { bundleId: 'example.invented.app' } },
        ],
      });
    }
    if (request.method === 'POST' && pathname === '/v1/buildUploads') return json(201, state('AWAITING_UPLOAD'));
    if (request.method === 'POST' && pathname === '/v1/buildUploadFiles') {
      return script.createFile ?? json(201, { data: { id: 'file-1', attributes: { uploadOperations: OPERATIONS } } });
    }
    if (request.method === 'PATCH' && pathname === '/v1/buildUploadFiles/file-1') {
      return json(200, { data: { id: 'file-1' } });
    }
    if (request.method === 'GET' && pathname === '/v1/buildUploads/upload-1') {
      return take(polls, json(200, state('PROCESSING')));
    }
    if (request.method === 'DELETE' && pathname === '/v1/buildUploads/upload-1') return { status: 204, text: '' };
    throw new Error(`unexpected request ${request.method} ${request.url}`);
  };
  return {
    requests,
    lines,
    calls: () => requests.map((r) => `${r.method} ${r.url.replace(API, '').split('?')[0]}`),
    deps: {
      transport: async (request) => {
        requests.push(request);
        return respond(request);
      },
      mintToken: () => TOKEN,
      log: (line) => lines.push(line),
      sleep: async (ms) => {
        clock += script.sleepAdvanceMs ?? ms;
      },
      now: () => clock,
    },
  };
}

const bodyOf = (h: Harness, call: string) => {
  const request = h.requests.find((r) => `${r.method} ${r.url.replace(API, '').split('?')[0]}` === call);
  return JSON.parse(String(request?.body));
};

const ERROR_404 = json(404, { errors: [{ code: 'NOT_FOUND', detail: 'no resource' }] });

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('uploadBuild', () => {
  it('walks the documented sequence and reports VALID', async () => {
    const h = harness({ uploadPolls: [json(200, state('PROCESSING')), json(200, withBuild('VALID'))] });

    await expect(uploadBuild(INPUT, h.deps)).resolves.toEqual({ uploadId: 'upload-1' });

    expect(h.calls()).toEqual([
      'GET /v1/apps',
      'POST /v1/buildUploads',
      'POST /v1/buildUploadFiles',
      'PUT https://uploads.example.test/part-1',
      'PUT https://uploads.example.test/part-2',
      'PATCH /v1/buildUploadFiles/file-1',
      'GET /v1/buildUploads/upload-1',
      'GET /v1/buildUploads/upload-1',
    ]);
    expect(bodyOf(h, 'POST /v1/buildUploads')).toEqual({
      data: {
        type: 'buildUploads',
        attributes: { cfBundleShortVersionString: '9.8.7', cfBundleVersion: '42', platform: 'IOS' },
        relationships: { app: { data: { type: 'apps', id: 'app-1' } } },
      },
    });
    expect(bodyOf(h, 'POST /v1/buildUploadFiles')).toEqual({
      data: {
        type: 'buildUploadFiles',
        attributes: { assetType: 'ASSET', fileName: 'invented.ipa', fileSize: 8, uti: 'com.apple.ipa' },
        relationships: { buildUpload: { data: { type: 'buildUploads', id: 'upload-1' } } },
      },
    });
    expect(bodyOf(h, 'PATCH /v1/buildUploadFiles/file-1')).toEqual({
      data: { type: 'buildUploadFiles', id: 'file-1', attributes: { uploaded: true } },
    });
    expect(h.lines).toContain('state PROCESSING');
    expect(h.lines).toContain('state COMPLETE, build VALID');
  });

  it('sends each part as its byte range with Apple headers and never the token', async () => {
    const h = harness({ uploadPolls: [json(200, withBuild('VALID'))] });

    await uploadBuild(INPUT, h.deps);

    const [first, second] = h.requests.filter((r) => r.url.startsWith('https://uploads.example.test/'));
    expect(Buffer.from(first.body as Uint8Array).toString()).toBe('abcde');
    expect(Buffer.from(second.body as Uint8Array).toString()).toBe('fgh');
    expect(first.headers).toEqual({ 'Content-Type': 'application/octet-stream' });
    expect(second.headers).toEqual({});
    for (const request of h.requests) {
      if (request.url.startsWith(API)) expect(request.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('retries a part after a 5xx or a dropped connection', async () => {
    const h = harness({
      partResponses: [{ status: 503, text: '' }, new TypeError('fetch failed')],
      uploadPolls: [json(200, withBuild('VALID'))],
    });

    await uploadBuild(INPUT, h.deps);

    expect(h.calls().filter((c) => c.endsWith('/part-1'))).toHaveLength(3);
  });

  it('deletes the record and hides the signed URL when a part is refused', async () => {
    const h = harness({ partResponses: [{ status: 403, text: '<Error/>' }] });

    const failure = await uploadBuild(INPUT, h.deps).catch((err: Error) => err);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('part 1 of 2 failed: HTTP 403');
    expect(h.calls()).toEqual([
      'GET /v1/apps',
      'POST /v1/buildUploads',
      'POST /v1/buildUploadFiles',
      'PUT https://uploads.example.test/part-1',
      'DELETE /v1/buildUploads/upload-1',
    ]);
    expect(h.lines.join('\n')).not.toContain('invented-signature');
  });

  it('refuses an operation that runs past the end of the file', async () => {
    const operation = { method: 'PUT', url: 'https://uploads.example.test/part-1', offset: 6, length: 5 };
    const h = harness({
      createFile: json(201, { data: { id: 'file-1', attributes: { uploadOperations: [operation] } } }),
    });

    await expect(uploadBuild(INPUT, h.deps)).rejects.toThrow('part 1 of 1 runs past the end of the file');
    expect(h.calls()).not.toContain('PUT https://uploads.example.test/part-1');
  });

  it('surfaces Apple errors when the record cannot be created', async () => {
    const h = harness({});
    const transport = h.deps.transport;
    h.deps.transport = async (request) =>
      request.method === 'POST'
        ? json(403, { errors: [{ code: 'FORBIDDEN_ERROR', detail: 'this request is forbidden' }] })
        : transport(request);

    await expect(uploadBuild(INPUT, h.deps)).rejects.toThrow(
      'POST /v1/buildUploads: 403 FORBIDDEN_ERROR: this request is forbidden',
    );
  });

  it('reports Apple processing errors and keeps the committed record', async () => {
    const h = harness({
      uploadPolls: [
        json(200, state('FAILED', { errors: [{ code: 'INVENTED_90000', description: 'invalid bundle' }] })),
      ],
    });

    await expect(uploadBuild(INPUT, h.deps)).rejects.toThrow(
      'Apple rejected the upload: INVENTED_90000: invalid bundle',
    );
    expect(h.calls()).not.toContain('DELETE /v1/buildUploads/upload-1');
  });

  it('fails when the processed build is marked invalid', async () => {
    const h = harness({ uploadPolls: [json(200, withBuild('INVALID'))] });

    await expect(uploadBuild(INPUT, h.deps)).rejects.toThrow('Apple marked the build INVALID');
  });

  it('rides out Apple false 404s while polling', async () => {
    const h = harness({ uploadPolls: [ERROR_404, ERROR_404, json(200, withBuild('VALID'))] });

    await expect(uploadBuild(INPUT, h.deps)).resolves.toEqual({ uploadId: 'upload-1' });
  });

  it('gives up on a 404 that persists', async () => {
    const h = harness({ uploadPolls: Array.from({ length: 5 }, () => ERROR_404) });

    await expect(uploadBuild(INPUT, h.deps)).rejects.toThrow('404 NOT_FOUND: no resource');
  });

  it('stops at the deadline and names the upload', async () => {
    const h = harness({ sleepAdvanceMs: 61 * 60_000 });

    await expect(uploadBuild(INPUT, h.deps)).rejects.toThrow(
      'build upload upload-1 is still processing after the deadline (last: state PROCESSING)',
    );
  });
});

describe('signToken', () => {
  it('signs an individual-key JWT Apple accepts: ES256, sub user, no issuer', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

    const token = signToken(privateKey, 'INVENTEDKEY1', 1_000);

    const [header, payload, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'INVENTEDKEY1',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({
      sub: 'user',
      iat: 1_000,
      exp: 1_600,
      aud: 'appstoreconnect-v1',
    });
    const valid = verify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    );
    expect(valid).toBe(true);
  });
});

describe('findUploadKey', () => {
  const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
    format: 'pem',
    type: 'pkcs8',
  });
  const keyDir = (...names: string[]) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-ios-upload-'));
    tmpDirs.push(dir);
    for (const name of names) fs.writeFileSync(path.join(dir, name), pem);
    return dir;
  };

  it('takes the key id from the one key file', () => {
    expect(findUploadKey(keyDir('ApiKey_INVENTEDKEY1.p8', 'notes.txt')).keyId).toBe('INVENTEDKEY1');
  });

  it.each([
    ['none', []],
    ['two', ['ApiKey_INVENTEDKEY1.p8', 'ApiKey_INVENTEDKEY2.p8']],
  ])('refuses a directory holding %s', (_label, names) => {
    expect(() => findUploadKey(keyDir(...names))).toThrow('expected exactly one ApiKey_<id>.p8');
  });
});
