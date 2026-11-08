/**
 * Files a phone sends with a reply. Each one streams to its own file in this process's own temporary directory, under a
 * size cap checked as the bytes arrive. Its kind is read from its bytes, never from what the phone declares, and it lives
 * only until the reply that names it has been tried, or ten minutes.
 */
import { randomBytes } from 'crypto';
import fs from 'fs';
import type { IncomingMessage } from 'http';
import os from 'os';
import path from 'path';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES_PER_REPLY = 1;
const HELD_TTL_MS = 10 * 60_000;
/** One file a reply, with room for a retry or two whose earlier upload the host never heard named. */
export const MAX_HELD_PER_DEVICE = 3;
const HEAD_BYTES = 4096;
/** A zip's directory of names sits at its end, so a document's kind is read from there. */
const ZIP_TAIL_BYTES = 1024 * 1024;
const MAX_NAME_CHARS = 120;
const DIR_PREFIX = 'nanoclaw-mobile-uploads-';

const at = (head: Buffer, offset: number, text: string) =>
  head.subarray(offset, offset + text.length).toString('latin1') === text;
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx']);
const HEIF_BRANDS = new Set(['mif1', 'msf1', 'heim', 'heis']);
const brand = (h: Buffer) => (at(h, 4, 'ftyp') ? h.subarray(8, 12).toString('latin1') : '');

/** A kind a reply may carry: the type it posts as and the extensions its name may keep. */
interface Kind {
  type: string;
  exts: string[];
}

const kind = (type: string, ...exts: string[]): Kind => ({ type, exts });
/** Tab, newline and carriage return: the control characters text may hold. */
const TEXT_CONTROLS = new Set([0x09, 0x0a, 0x0d]);
const TEXT_KINDS = [kind('text/csv', 'csv'), kind('text/markdown', 'md', 'markdown'), kind('text/plain', 'txt')];

type Family = 'zip' | 'text' | Kind;

/** What the first bytes say a file is, or null for none a reply may carry. */
function familyOf(head: Buffer): Family | null {
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return kind('image/jpeg', 'jpg', 'jpeg');
  if (head.subarray(0, 8).equals(PNG)) return kind('image/png', 'png');
  if (at(head, 0, 'GIF87a') || at(head, 0, 'GIF89a')) return kind('image/gif', 'gif');
  if (at(head, 0, 'RIFF') && at(head, 8, 'WEBP')) return kind('image/webp', 'webp');
  if (HEIC_BRANDS.has(brand(head))) return kind('image/heic', 'heic');
  if (HEIF_BRANDS.has(brand(head))) return kind('image/heif', 'heif');
  if (at(head, 0, '%PDF-')) return kind('application/pdf', 'pdf');
  if (at(head, 0, 'PK\x03\x04')) return 'zip';
  if (!head.includes(0)) return 'text';
  return null;
}

const OFFICE: Array<[marker: string, kind: Kind]> = [
  ['word/document.xml', kind('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx')],
  ['xl/workbook.xml', kind('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx')],
  ['ppt/presentation.xml', kind('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx')],
];

const extOf = (name: string) => /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';

/**
 * The kind a whole file is: a zip only as a Word, Excel or PowerPoint document, and text only when it is all UTF-8 with
 * no control characters but tab, newline and carriage return. Text is CSV or Markdown by its name, else plain.
 */
async function kindOf(filePath: string, size: number, family: Family, name: string): Promise<Kind | null> {
  if (typeof family !== 'string') return family;
  if (family === 'zip') {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const length = Math.min(size, ZIP_TAIL_BYTES);
      const tail = Buffer.alloc(length);
      await handle.read(tail, 0, length, size - length);
      const found = OFFICE.filter(([marker]) => tail.includes(marker));
      return found.length === 1 ? found[0][1] : null;
    } finally {
      await handle.close();
    }
  }
  const bytes = await fs.promises.readFile(filePath);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (err) {
    if (err instanceof TypeError) return null;
    throw err;
  }
  // UTF-8 never encodes another character with a byte below 0x80, so the control characters are these bytes alone.
  if (bytes.some((byte) => (byte < 0x20 && !TEXT_CONTROLS.has(byte)) || byte === 0x7f)) return null;
  return TEXT_KINDS.find(({ exts }) => exts.includes(extOf(name))) ?? TEXT_KINDS[2];
}

/** A file a reply carries, as the post that sends it reads it. */
export interface ReplyFile {
  path: string;
  name: string;
  type: string;
  size: number;
}

interface Held extends ReplyFile {
  deviceId: string;
  expiresAt: number;
}

const held = new Map<string, Held>();
/** Uploads still streaming, by device, which count against its cap as held files do. */
const receiving = new Map<string, number>();

let base = os.tmpdir();
let dir: string | null = null;

export function _setUploadBaseForTest(next: string | null): void {
  base = next ?? os.tmpdir();
  dir = null;
}

/**
 * This process's own directory, made on first use. A host stopped mid-upload leaves its directory behind, so one this
 * host made that has sat untouched past the hold time goes first.
 */
function uploadDir(): string {
  if (dir && fs.existsSync(dir)) return dir;
  const now = Date.now();
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(DIR_PREFIX)) continue;
    const stale = path.join(base, entry.name);
    if (now - fs.statSync(stale).mtimeMs > HELD_TTL_MS) fs.rmSync(stale, { recursive: true, force: true });
  }
  dir = fs.mkdtempSync(path.join(base, DIR_PREFIX));
  return dir;
}

function drop(file: ReplyFile): void {
  fs.rmSync(file.path, { force: true });
}

function sweep(now = Date.now()): void {
  for (const [id, file] of held) {
    if (file.expiresAt > now) continue;
    held.delete(id);
    drop(file);
  }
}

/** The person's own name for the file, kept to one safe path segment; empty when they gave none. */
function safeName(given: string | string[] | undefined): string {
  let name = '';
  try {
    name = decodeURIComponent(typeof given === 'string' ? given : '');
  } catch (err) {
    if (!(err instanceof URIError)) throw err;
  }
  return name
    .replace(/[\p{Cc}\p{Cf}/\\:]/gu, '')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, MAX_NAME_CHARS);
}

/** That name ending in an extension of the kind the bytes are, or one made from the kind. */
function fileName(safe: string, kind: Kind): string {
  if (!safe) return `file.${kind.exts[0]}`;
  if (kind.exts.includes(extOf(safe))) return safe;
  return `${safe.replace(/\.[^.]*$/, '') || 'file'}.${kind.exts[0]}`;
}

export type Received = { uploadId: string } | { status: number; error: string; close?: true };

const TOO_LARGE = `That file is over ${MAX_FILE_BYTES / 1024 / 1024} MB.`;
const WRONG_KIND = 'That kind of file cannot be sent. Send a photo, a PDF or a document.';

/**
 * Streams one file to disk under its caps, answering what the phone should hear. The type the phone declares names
 * nothing: the kind comes from the bytes.
 */
export async function receiveUpload(req: IncomingMessage, deviceId: string): Promise<Received> {
  sweep();
  if (Number(req.headers['content-length']) > MAX_FILE_BYTES) return { status: 413, error: TOO_LARGE, close: true };
  const holding = [...held.values()].filter((file) => file.deviceId === deviceId).length;
  if (holding + (receiving.get(deviceId) ?? 0) >= MAX_HELD_PER_DEVICE) {
    return { status: 429, error: 'That is a lot of files at once. Send the reply first.', close: true };
  }
  receiving.set(deviceId, (receiving.get(deviceId) ?? 0) + 1);
  try {
    return await streamUpload(req, deviceId);
  } finally {
    const left = (receiving.get(deviceId) ?? 1) - 1;
    if (left > 0) receiving.set(deviceId, left);
    else receiving.delete(deviceId);
  }
}

type Ending = 'done' | 'too-large' | 'wrong-kind' | 'unfinished';

async function streamUpload(req: IncomingMessage, deviceId: string): Promise<Received> {
  const id = randomBytes(16).toString('base64url');
  const filePath = path.join(uploadDir(), id);
  const out = fs.createWriteStream(filePath, { flags: 'wx', mode: 0o600 });
  let size = 0;
  let head = Buffer.alloc(0);
  let family: Family | null = null;
  let checked = false;
  let whole = false;
  let settled = false;
  const ending = await new Promise<Ending>((resolve) => {
    const end = (why: Ending) => {
      if (settled) return;
      settled = true;
      if (why !== 'done') req.pause();
      resolve(why);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_FILE_BYTES) return end('too-large');
      if (!checked) {
        head = Buffer.concat([head, chunk]);
        if (head.length >= HEAD_BYTES) {
          checked = true;
          family = familyOf(head.subarray(0, HEAD_BYTES));
          if (!family) return end('wrong-kind');
        }
      }
      if (!out.write(chunk)) {
        req.pause();
        out.once('drain', () => settled || req.resume());
      }
    });
    req.on('end', () => {
      whole = true;
      if (!checked) family = familyOf(head);
      if (!family) return end('wrong-kind');
      out.end(() => end('done'));
    });
    req.on('close', () => whole || end('unfinished'));
    req.on('error', () => end('unfinished'));
    out.on('error', () => end('unfinished'));
  });
  const given = safeName(req.headers['x-file-name']);
  let found: Kind | null = null;
  try {
    if (ending === 'done' && family) found = await kindOf(filePath, size, family, given);
  } catch (err) {
    fs.rmSync(filePath, { force: true });
    throw err;
  }
  if (!found || size === 0) {
    out.destroy();
    fs.rmSync(filePath, { force: true });
    if (ending === 'too-large') return { status: 413, error: TOO_LARGE, close: true };
    if (ending === 'unfinished') return { status: 400, error: 'That file did not arrive whole.', close: true };
    if (size === 0) return { status: 400, error: 'That file is empty.', close: true };
    return { status: 415, error: WRONG_KIND, close: true };
  }
  held.set(id, {
    path: filePath,
    name: fileName(given, found),
    type: found.type,
    size,
    deviceId,
    expiresAt: Date.now() + HELD_TTL_MS,
  });
  // A file no reply takes goes when its time is up, whether or not another upload or reply comes to sweep it.
  setTimeout(() => sweep(), HELD_TTL_MS + 1_000).unref();
  return { uploadId: id };
}

/**
 * Hands over this device's files, by the ids its reply names, to the one request that posts them; null, taking none, if
 * any is gone or another device's. Whatever is handed over is the taker's to `discardFiles`.
 */
export function takeUploads(deviceId: string, ids: string[]): ReplyFile[] | null {
  sweep();
  const files = ids.map((id) => held.get(id));
  if (!files.every((file) => file?.deviceId === deviceId)) return null;
  for (const id of ids) held.delete(id);
  return (files as Held[]).map(({ path: filePath, name, type, size }) => ({ path: filePath, name, type, size }));
}

export function discardFiles(files: ReplyFile[]): void {
  for (const file of files) drop(file);
}

export function _resetUploadsForTest(): void {
  for (const file of held.values()) drop(file);
  held.clear();
}
