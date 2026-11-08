import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  _resetUploadsForTest,
  _setUploadBaseForTest,
  discardFiles,
  MAX_FILE_BYTES,
  MAX_HELD_PER_DEVICE,
  receiveUpload,
  takeUploads,
  type Received,
} from './uploads.js';

const BASE = uniqueTmpRoot('mobile-uploads');
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(5000, 7)]);
const JPEG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(5000, 9)]);

let server: http.Server;
let port: number;
/** The device each request uploads as, read by the server as the route would from its send key. */
let device = 'dev-a';

beforeAll(async () => {
  fs.mkdirSync(BASE, { recursive: true });
  _setUploadBaseForTest(BASE);
  server = http.createServer((req, res) => {
    void receiveUpload(req, device).then((answer: Received) => {
      if ('close' in answer && answer.close) res.setHeader('connection', 'close');
      res.writeHead('uploadId' in answer ? 200 : answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(() => {
  vi.useRealTimers();
  _resetUploadsForTest();
  device = 'dev-a';
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  _setUploadBaseForTest(null);
  fs.rmSync(BASE, { recursive: true, force: true });
});

/** Every file the uploads hold on disk, across the host's upload directories. */
const onDisk = () =>
  fs.readdirSync(BASE).flatMap((dir) => fs.readdirSync(`${BASE}/${dir}`).map((file) => `${dir}/${file}`));

function upload(
  body: Buffer | ((req: http.ClientRequest) => void),
  headers: http.OutgoingHttpHeaders,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/uploads', headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> }));
    });
    // A refused body is cut off where it stands, so the write may fail after the answer is on its way.
    req.on('error', (err: NodeJS.ErrnoException) =>
      err.code === 'EPIPE' || err.code === 'ECONNRESET' ? undefined : reject(err),
    );
    if (typeof body === 'function') body(req);
    else req.end(body);
  });
}

/** A file's kind and name as the host kept it, read back through the one take a reply makes. */
async function kept(bytes: Buffer, name: string, declared = 'application/octet-stream') {
  const res = await upload(bytes, { 'content-type': declared, 'x-file-name': encodeURIComponent(name) });
  expect(res.status).toBe(200);
  const [file] = takeUploads(device, [String(res.body.uploadId)])!;
  discardFiles([file!]);
  return { name: file!.name, type: file!.type };
}

const DOCX = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(200), Buffer.from('word/document.xml')]);
const ZIP = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(200), Buffer.from('photos/one.jpg')]);

describe('receiveUpload', () => {
  it('keeps a file for its own device only, once, under the name the phone gave', async () => {
    const res = await upload(PNG, {
      'content-type': 'image/png',
      'x-file-name': encodeURIComponent('Screen shot/1.png'),
    });
    const uploadId = String(res.body.uploadId);

    expect([res.status, takeUploads('dev-b', [uploadId])]).toEqual([200, null]);
    const [file] = takeUploads('dev-a', [uploadId])!;
    expect({ ...file, path: undefined }).toEqual({
      path: undefined,
      name: 'Screen shot1.png',
      type: 'image/png',
      size: PNG.length,
    });
    expect(fs.readFileSync(file!.path).equals(PNG)).toBe(true);
    expect(takeUploads('dev-a', [uploadId])).toBeNull();
    discardFiles([file!]);
  });

  it('reads the kind from the bytes whatever the phone declares, and names the file to match', async () => {
    expect([
      await kept(JPEG, 'photo.webp', 'image/webp'),
      await kept(PNG, 'shot.pdf', 'application/pdf'),
      await kept(DOCX, 'plan', 'text/plain'),
      await kept(Buffer.from('a,b\n1,2\n'), 'data.csv', 'image/png'),
      await kept(Buffer.from('# Notes\n'), 'notes.md'),
      await kept(Buffer.from('café\n'), 'notes'),
    ]).toEqual([
      { name: 'photo.jpg', type: 'image/jpeg' },
      { name: 'shot.png', type: 'image/png' },
      { name: 'plan.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      { name: 'data.csv', type: 'text/csv' },
      { name: 'notes.md', type: 'text/markdown' },
      { name: 'notes.txt', type: 'text/plain' },
    ]);
  });

  it.each([
    ['a program', Buffer.concat([Buffer.from('MZ\x90\x00', 'latin1'), Buffer.alloc(5000)])],
    ['a zip that is no Word, Excel or PowerPoint document', ZIP],
    ['text that is not UTF-8', Buffer.from([0x61, 0xff, 0xfe, 0x62])],
    ['text holding a control character', Buffer.from('a\x1bb')],
  ])('refuses %s, whatever its declared type, keeping nothing', async (_label, bytes) => {
    const res = await upload(bytes, { 'content-type': 'image/png' });

    expect([res.status, res.body.error]).toEqual([
      415,
      'That kind of file cannot be sent. Send a photo, a PDF or a document.',
    ]);
    expect(onDisk()).toEqual([]);
  });

  it('stops reading a file past 25 MB, whether or not it said its size, and keeps nothing', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_FILE_BYTES - PNG.length + 1)]);
    const declared = await upload(big, { 'content-type': 'image/png', 'content-length': big.length });
    const streamed = await upload(
      (req) => {
        for (let at = 0; at < big.length; at += 1024 * 1024) req.write(big.subarray(at, at + 1024 * 1024));
        req.end();
      },
      { 'content-type': 'image/png', 'transfer-encoding': 'chunked' },
    );

    expect([declared.status, streamed.status, streamed.body.error]).toEqual([413, 413, 'That file is over 25 MB.']);
    expect(onDisk()).toEqual([]);
  });

  it('keeps nothing of an upload the phone hangs up on', async () => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/uploads',
      headers: { 'content-length': PNG.length * 2 },
    });
    const gone = new Promise((resolve) => req.on('close', resolve));
    req.on('error', () => undefined);
    req.write(PNG);
    await vi.waitFor(() => expect(onDisk()).toHaveLength(1));
    req.destroy();
    await gone;

    await vi.waitFor(() => expect(onDisk()).toEqual([]));
  });

  it('counts uploads still arriving against the files a device may hold', async () => {
    const open = Array.from({ length: MAX_HELD_PER_DEVICE }, () => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/uploads',
        headers: { 'content-length': PNG.length * 2 },
      });
      req.on('error', () => undefined);
      req.write(PNG);
      return req;
    });
    await vi.waitFor(() => expect(onDisk()).toHaveLength(MAX_HELD_PER_DEVICE));

    const refused = await upload(PNG, {});

    for (const req of open) req.destroy();
    expect(refused.status).toBe(429);
    await vi.waitFor(() => expect(onDisk()).toEqual([]));
  });

  it('lets one device hold three files until a reply takes them', async () => {
    for (let n = 0; n < 3; n++) expect((await upload(PNG, {})).status).toBe(200);
    const refused = await upload(PNG, {});
    device = 'dev-b';
    const other = await upload(PNG, {});

    expect([MAX_HELD_PER_DEVICE, refused.status, other.status]).toEqual([3, 429, 200]);
    expect(onDisk()).toHaveLength(4);
  });

  it('deletes a file no reply took once ten minutes have passed, with nothing else arriving to sweep it', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
    const { body } = await upload(PNG, {});
    expect(onDisk()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);

    expect(onDisk()).toEqual([]);
    expect(takeUploads('dev-a', [String(body.uploadId)])).toBeNull();
  });
});
