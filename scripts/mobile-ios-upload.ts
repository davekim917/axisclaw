#!/usr/bin/env -S pnpm exec tsx
/**
 * Upload an iPhone build of the Anderton app to App Store Connect through Apple's Build Uploads API.
 *
 *   pnpm exec tsx scripts/mobile-ios-upload.ts <build.ipa> --build <n> [--version <x.y.z>]
 *
 * EAS assigns the build number, so --build is the build record's appBuildVersion. The version defaults to
 * mobile/app.json at this checkout, so pass it too when the IPA came from another commit. Apple fails the upload when
 * either disagrees with the IPA.
 *
 * It signs with the one individual key in ~/.appstoreconnect/private_keys and exits 0 only when the build is VALID.
 * See docs/mobile.md.
 */
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const API_BASE = 'https://api.appstoreconnect.apple.com';
const KEY_FILE_RE = /^ApiKey_([A-Z0-9]+)\.p8$/;
const TOKEN_LIFETIME_SECONDS = 600;
const API_TIMEOUT_MS = 30_000;
const PART_TIMEOUT_MS = 10 * 60_000;
const PART_ATTEMPTS = 3;
const PART_RETRY_DELAY_MS = 5_000;
const POLL_INTERVAL_MS = 30_000;
const PROCESSING_DEADLINE_MS = 60 * 60_000;
const MAX_CONSECUTIVE_FALSE_404S = 5;

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs: number;
}

export interface HttpResponse {
  status: number;
  text: string;
}

type Transport = (request: HttpRequest) => Promise<HttpResponse>;

export interface UploadDeps {
  transport: Transport;
  mintToken: () => string;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface UploadInput {
  bundleId: string;
  version: string;
  build: string;
  fileName: string;
  ipa: Buffer;
}

interface UploadOperation {
  method: string;
  url: string;
  offset: number;
  length: number;
  requestHeaders?: { name: string; value: string }[];
}

interface StateDetail {
  code?: string;
  description?: string;
}

interface UploadState {
  state?: string;
  errors?: StateDetail[];
  warnings?: StateDetail[];
}

interface BuildUploadResource {
  id: string;
  attributes?: { state?: UploadState };
}

interface IncludedResource {
  type: string;
  attributes?: { processingState?: string };
}

class AppleApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function signToken(key: KeyObject, keyId: string, nowSeconds: number): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = [
    encode({ alg: 'ES256', kid: keyId, typ: 'JWT' }),
    encode({ sub: 'user', iat: nowSeconds, exp: nowSeconds + TOKEN_LIFETIME_SECONDS, aud: 'appstoreconnect-v1' }),
  ].join('.');
  const signature = sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${signature.toString('base64url')}`;
}

export function findUploadKey(dir: string): { keyId: string; key: KeyObject } {
  const names = fs.readdirSync(dir).filter((name) => KEY_FILE_RE.test(name));
  if (names.length !== 1) {
    throw new Error(`expected exactly one ApiKey_<id>.p8 in ${dir}, found ${names.length}`);
  }
  const keyId = names[0].match(KEY_FILE_RE)![1];
  return { keyId, key: createPrivateKey(fs.readFileSync(path.join(dir, names[0]))) };
}

function describeAppleErrors(status: number, text: string): string {
  try {
    const { errors } = JSON.parse(text) as { errors?: { code?: string; title?: string; detail?: string }[] };
    if (errors?.length) {
      return `${status} ${errors.map((e) => `${e.code}: ${e.detail ?? e.title}`).join('; ')}`;
    }
  } catch {
    return `${status}`;
  }
  return `${status}`;
}

function formatDetails(details: StateDetail[] | undefined): string {
  return (details ?? []).map((d) => `${d.code}: ${d.description}`).join('; ');
}

async function apple<T>(deps: UploadDeps, method: string, pathAndQuery: string, body?: object): Promise<T> {
  const response = await deps.transport({
    method,
    url: `${API_BASE}${pathAndQuery}`,
    headers: {
      Authorization: `Bearer ${deps.mintToken()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    timeoutMs: API_TIMEOUT_MS,
  });
  if (response.status >= 300) {
    throw new AppleApiError(
      response.status,
      `${method} ${pathAndQuery.split('?')[0]}: ${describeAppleErrors(response.status, response.text)}`,
    );
  }
  return (response.text ? JSON.parse(response.text) : null) as T;
}

async function findAppId(deps: UploadDeps, bundleId: string): Promise<string> {
  const { data } = await apple<{ data: { id: string; attributes: { bundleId: string } }[] }>(
    deps,
    'GET',
    `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&fields[apps]=bundleId`,
  );
  const app = data.find((candidate) => candidate.attributes.bundleId === bundleId);
  if (!app) throw new Error(`no App Store Connect app visible to this key has bundle id ${bundleId}`);
  return app.id;
}

async function uploadPart(deps: UploadDeps, operation: UploadOperation, partLabel: string, ipa: Buffer): Promise<void> {
  const part = ipa.subarray(operation.offset, operation.offset + operation.length);
  if (part.length !== operation.length) {
    throw new Error(`part ${partLabel} runs past the end of the file`);
  }
  const headers = Object.fromEntries((operation.requestHeaders ?? []).map(({ name, value }) => [name, value]));
  let outcome = '';
  for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt += 1) {
    try {
      // The URL is pre-signed, and it points at a storage host that must never see the API token.
      const response = await deps.transport({
        method: operation.method,
        url: operation.url,
        headers,
        body: part,
        timeoutMs: PART_TIMEOUT_MS,
      });
      if (response.status < 300) return;
      outcome = `HTTP ${response.status}`;
      if (response.status < 500) break;
    } catch (err) {
      outcome = (err as Error).name;
    }
    if (attempt < PART_ATTEMPTS) await deps.sleep(PART_RETRY_DELAY_MS);
  }
  throw new Error(`part ${partLabel} failed: ${outcome}`);
}

async function discardRecord(deps: UploadDeps, uploadId: string): Promise<void> {
  try {
    await apple(deps, 'DELETE', `/v1/buildUploads/${uploadId}`);
    deps.log(`deleted build upload ${uploadId}`);
  } catch (err) {
    deps.log(`could not delete build upload ${uploadId}: ${(err as Error).message}`);
  }
}

async function sendFile(deps: UploadDeps, uploadId: string, input: UploadInput): Promise<void> {
  const { data: file } = await apple<{
    data: { id: string; attributes: { uploadOperations?: UploadOperation[] } };
  }>(deps, 'POST', '/v1/buildUploadFiles', {
    data: {
      type: 'buildUploadFiles',
      attributes: {
        assetType: 'ASSET',
        fileName: input.fileName,
        fileSize: input.ipa.length,
        uti: 'com.apple.ipa',
      },
      relationships: { buildUpload: { data: { type: 'buildUploads', id: uploadId } } },
    },
  });
  const operations = file.attributes.uploadOperations ?? [];
  if (operations.length === 0) throw new Error('Apple returned no upload operations');
  for (const [index, operation] of operations.entries()) {
    const partLabel = `${index + 1} of ${operations.length}`;
    await uploadPart(deps, operation, partLabel, input.ipa);
    deps.log(`sent part ${partLabel}`);
  }
  await apple(deps, 'PATCH', `/v1/buildUploadFiles/${file.id}`, {
    data: { type: 'buildUploadFiles', id: file.id, attributes: { uploaded: true } },
  });
}

async function waitForValidBuild(deps: UploadDeps, uploadId: string): Promise<string> {
  const deadline = deps.now() + PROCESSING_DEADLINE_MS;
  let lastStatus = '';
  let false404s = 0;
  while (deps.now() < deadline) {
    let response: { data: BuildUploadResource; included?: IncludedResource[] } | null = null;
    try {
      response = await apple(deps, 'GET', `/v1/buildUploads/${uploadId}?include=build`);
      false404s = 0;
    } catch (err) {
      if (!(err instanceof AppleApiError)) throw err;
      // Build Upload reads intermittently answer 404 for a record that exists.
      if (err.status === 404) {
        false404s += 1;
        if (false404s >= MAX_CONSECUTIVE_FALSE_404S) throw err;
      } else if (err.status !== 429 && err.status < 500) {
        throw err;
      }
    }
    if (response) {
      const state = response.data.attributes?.state;
      const buildState = response.included?.find((item) => item.type === 'builds')?.attributes?.processingState;
      const status = `state ${state?.state ?? 'unknown'}${buildState ? `, build ${buildState}` : ''}`;
      if (status !== lastStatus) deps.log(status);
      lastStatus = status;
      const warnings = formatDetails(state?.warnings);
      if (warnings) deps.log(`warnings: ${warnings}`);
      if (state?.state === 'FAILED') {
        throw new Error(`Apple rejected the upload: ${formatDetails(state.errors) || 'no detail given'}`);
      }
      if (buildState === 'VALID') return buildState;
      if (buildState === 'FAILED' || buildState === 'INVALID') {
        throw new Error(`Apple marked the build ${buildState}: ${formatDetails(state?.errors) || 'no detail given'}`);
      }
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`build upload ${uploadId} is still processing after the deadline (last: ${lastStatus || 'none'})`);
}

export async function uploadBuild(input: UploadInput, deps: UploadDeps): Promise<{ uploadId: string }> {
  const appId = await findAppId(deps, input.bundleId);
  const { data: upload } = await apple<{ data: BuildUploadResource }>(deps, 'POST', '/v1/buildUploads', {
    data: {
      type: 'buildUploads',
      attributes: {
        cfBundleShortVersionString: input.version,
        cfBundleVersion: input.build,
        platform: 'IOS',
      },
      relationships: { app: { data: { type: 'apps', id: appId } } },
    },
  });
  deps.log(`build upload ${upload.id} for ${input.version} (${input.build})`);
  try {
    await sendFile(deps, upload.id, input);
  } catch (err) {
    await discardRecord(deps, upload.id);
    throw err;
  }
  await waitForValidBuild(deps, upload.id);
  return { uploadId: upload.id };
}

const fetchTransport: Transport = async ({ method, url, headers, body, timeoutMs }) => {
  const response = await fetch(url, {
    method,
    headers,
    body: body as RequestInit['body'],
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, text: await response.text() };
};

function readAppConfig(): { bundleId: string; version: string } {
  const appJson = path.join(import.meta.dirname, '..', 'mobile', 'app.json');
  const { expo } = JSON.parse(fs.readFileSync(appJson, 'utf8')) as {
    expo: { version: string; ios: { bundleIdentifier: string } };
  };
  return { bundleId: expo.ios.bundleIdentifier, version: expo.version };
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { version: { type: 'string' }, build: { type: 'string' } },
  });
  if (positionals.length !== 1 || !positionals[0].endsWith('.ipa') || !values.build) {
    console.error('usage: mobile-ios-upload.ts <build.ipa> --build <n> [--version <x.y.z>]');
    return 2;
  }
  const config = readAppConfig();
  const { keyId, key } = findUploadKey(path.join(os.homedir(), '.appstoreconnect', 'private_keys'));
  const { uploadId } = await uploadBuild(
    {
      bundleId: config.bundleId,
      version: values.version ?? config.version,
      build: values.build,
      fileName: path.basename(positionals[0]),
      ipa: fs.readFileSync(positionals[0]),
    },
    {
      transport: fetchTransport,
      mintToken: () => signToken(key, keyId, Math.floor(Date.now() / 1000)),
      log: (line) => console.log(line),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    },
  );
  console.log(`build upload ${uploadId} is VALID`);
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: Error) => {
      console.error(`mobile-ios-upload: ${err.message}`);
      process.exitCode = 1;
    },
  );
}
