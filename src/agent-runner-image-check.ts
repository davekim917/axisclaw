/**
 * Agent-runner deps drift check. Runner source is bind-mounted live but node_modules are baked into the image, so
 * a new dependency without a rebuild crash-loops every fresh spawn silently. `container/build.sh` stamps a hash
 * of package.json + bun.lock as an image LABEL; a mismatch refuses the spawn with the rebuild command.
 *
 * A per-agent image (built FROM the base by install_packages) is also stale when the base it records in its
 * `nanoclaw.baseImageId` label is not the current base's image ID, or when it records none: a base change that is not
 * a deps change (a tool, a file, a security layer) would otherwise never reach it.
 *
 * Only passing results are cached, keyed on imageRef plus the files' mtime+size (so any edit re-checks) and, for a
 * per-agent image, the current base ID (so a base rebuild re-checks), and bounded by a TTL (the image can vanish
 * without a file edit). Failures are never cached: their fix is a rebuild, which touches neither file. Concurrent
 * checks are coalesced.
 *
 * During a containerd image-index rewrite, `docker inspect` can return an empty label map (exit 0), which a
 * single-key read cannot tell from an unlabeled image; the whole map is read and an absent one gets one re-read.
 */
import { createHash } from 'crypto';
import { readFile, stat } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

import { CONTAINER_IMAGE, CONTAINER_IMAGE_BASE, REPO_ROOT } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';

const execFileAsync = promisify(execFile);

const LABEL_KEY = 'nanoclaw.agentRunnerDepsHash';
export const BASE_IMAGE_ID_LABEL = 'nanoclaw.baseImageId';
const PKG_PATH = path.join(REPO_ROOT, 'container/agent-runner/package.json');
const LOCK_PATH = path.join(REPO_ROOT, 'container/agent-runner/bun.lock');

export type LabelLookup =
  | { kind: 'found'; value: string }
  | { kind: 'missing' }
  | { kind: 'unresolved' }
  | { kind: 'no-image' }
  | { kind: 'inspect-error'; reason: string };

export interface DepsDriftCheck {
  ok: boolean;
  imageRef: string;
  expected: string | null;
  actual: string | null;
  lookup: LabelLookup;
  retried: boolean;
  message: string;
}

/** Clears a BuildKit export window while an unlabeled image still fails well inside one sweep cycle. */
export const LABEL_RETRY_DELAY_MS = 2_000;

type InspectRunner = (imageRef: string) => Promise<string>;

export interface DriftCheckOptions {
  inspect?: InspectRunner;
  /** Reads an image's `.Id`; used for the current base when `derivedFromBase` is set. */
  inspectId?: InspectRunner;
  retryDelayMs?: number;
  /** The image is a per-agent build FROM the base, so it is also stale when built on any base but the current one. */
  derivedFromBase?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface DepsFileFingerprint {
  pkgMtimeMs: number;
  pkgSize: number;
  lockMtimeMs: number;
  lockSize: number;
}

interface CachedDriftCheck {
  fingerprint: DepsFileFingerprint;
  /** The base ID a derived image was checked against; null for a check that did not compare bases. */
  baseImageId: string | null;
  result: DepsDriftCheck;
  cachedAt: number;
}

/**
 * One sweep cycle: a `docker rmi`/retag leaves the files untouched, and since a rebuild is requested only when this
 * check fails, an unbounded passing cache would never self-heal.
 */
export const DEPS_DRIFT_CACHE_TTL_MS = 60_000;

const okResultCache = new Map<string, CachedDriftCheck>();

async function currentDepsFileFingerprint(): Promise<DepsFileFingerprint> {
  const [pkgStat, lockStat] = await Promise.all([stat(PKG_PATH), stat(LOCK_PATH)]);
  return {
    pkgMtimeMs: pkgStat.mtimeMs,
    pkgSize: pkgStat.size,
    lockMtimeMs: lockStat.mtimeMs,
    lockSize: lockStat.size,
  };
}

function fingerprintsMatch(a: DepsFileFingerprint, b: DepsFileFingerprint): boolean {
  return (
    a.pkgMtimeMs === b.pkgMtimeMs &&
    a.pkgSize === b.pkgSize &&
    a.lockMtimeMs === b.lockMtimeMs &&
    a.lockSize === b.lockSize
  );
}

export function resetDepsDriftCacheForTests(): void {
  okResultCache.clear();
  inFlightChecks.clear();
}

async function fileSha256Hex(p: string): Promise<string> {
  const buf = await readFile(p);
  return createHash('sha256').update(buf).digest('hex');
}

/** sha256(sha256(package.json) || sha256(bun.lock)), 16 hex chars; must stay byte-identical to container/build.sh. */
export async function computeAgentRunnerDepsHash(): Promise<string> {
  const [pkgHash, lockHash] = await Promise.all([fileSha256Hex(PKG_PATH), fileSha256Hex(LOCK_PATH)]);
  return createHash('sha256')
    .update(pkgHash + lockHash)
    .digest('hex')
    .slice(0, 16);
}

/**
 * The WHOLE label map: an index read prints an empty line for both "no map" and "not our key". `--type=image`
 * keeps a same-named container from answering.
 */
const dockerInspectLabels: InspectRunner = async (imageRef) => {
  const { stdout } = await execFileAsync(
    CONTAINER_RUNTIME_BIN,
    ['inspect', '--type=image', '--format', '{{json .Config.Labels}}', imageRef],
    { timeout: 10_000 },
  );
  return stdout;
};

const dockerInspectId: InspectRunner = async (imageRef) => {
  const { stdout } = await execFileAsync(
    CONTAINER_RUNTIME_BIN,
    ['inspect', '--type=image', '--format', '{{.Id}}', imageRef],
    { timeout: 10_000 },
  );
  return stdout;
};

/** An absent or empty map is 'unresolved' (worth one re-read); a map lacking our key is 'missing' (older build.sh). */
export function classifyLabels(stdout: string, key: string = LABEL_KEY): LabelLookup {
  const raw = stdout.trim();
  if (!raw || raw === 'null' || raw === '<no value>') return { kind: 'unresolved' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'inspect-error', reason: `unparseable label output: ${raw.slice(0, 120)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'unresolved' };
  const labels = parsed as Record<string, unknown>;
  const value = labels[key];
  if (typeof value === 'string' && value !== '') return { kind: 'found', value };
  return Object.keys(labels).length === 0 ? { kind: 'unresolved' } : { kind: 'missing' };
}

/** A `docker inspect` failure that means the image is absent, as opposed to a daemon failure or timeout. */
export function isNoSuchImageError(message: string): boolean {
  return /No such (object|image|container)/i.test(message);
}

function inspectFailure(err: unknown): LabelLookup {
  const msg = err instanceof Error ? err.message : String(err);
  if (isNoSuchImageError(msg)) return { kind: 'no-image' };
  return { kind: 'inspect-error', reason: msg };
}

interface ImageLabels {
  deps: LabelLookup;
  base: LabelLookup;
}

/** Distinguishes daemon failure, missing image, unresolved map and missing label; each has a different remedy. */
async function lookupImageLabels(imageRef: string, inspect: InspectRunner): Promise<ImageLabels> {
  try {
    const stdout = await inspect(imageRef);
    return { deps: classifyLabels(stdout), base: classifyLabels(stdout, BASE_IMAGE_ID_LABEL) };
  } catch (err) {
    const failure = inspectFailure(err);
    return { deps: failure, base: failure };
  }
}

/** The base image's current ID, as `docker inspect` reports it: what a per-agent build records and a check compares. */
export async function readBaseImageId(inspectId: InspectRunner = dockerInspectId): Promise<LabelLookup> {
  try {
    const id = (await inspectId(CONTAINER_IMAGE)).trim();
    return id
      ? { kind: 'found', value: id }
      : { kind: 'inspect-error', reason: `empty image ID for ${CONTAINER_IMAGE}` };
  } catch (err) {
    return inspectFailure(err);
  }
}

function rebuildHint(imageRef: string): string {
  if (imageRef === CONTAINER_IMAGE) {
    return 'cd container/agent-runner && bun install && cd ../.. && ./container/build.sh';
  }
  const manual =
    'rebuild the base first: cd container/agent-runner && bun install && cd ../.. && ./container/build.sh — ' +
    'then `ncl groups restart --id <group-id> --rebuild` so the derived image inherits the new label.';
  if (imageRef.startsWith(`${CONTAINER_IMAGE_BASE}:`)) {
    return `this is a per-agent image (built via install_packages); the host rebuilds it from a current base on its own. By hand, ${manual}`;
  }
  return `this is a per-agent override image (built via install_packages). Rebuild it yourself: ${manual}`;
}

/**
 * In-flight checks keyed on (imageRef, fingerprint): wakeRepositoryMountSessions spawns a burst without awaiting,
 * which would otherwise each pay the full check. A caller joins only a check against the fingerprint it observed,
 * and entries are removed on settle.
 */
const inFlightChecks = new Map<string, Promise<{ fingerprint: DepsFileFingerprint; result: DepsDriftCheck }>>();

function inFlightKey(imageRef: string, derivedFromBase: boolean, fingerprint: DepsFileFingerprint): string {
  return `${imageRef}::${derivedFromBase ? 'derived' : 'plain'}::${fingerprint.pkgMtimeMs}:${fingerprint.pkgSize}:${fingerprint.lockMtimeMs}:${fingerprint.lockSize}`;
}

/**
 * Pass the resolved spawn image: per-agent images from install_packages override the base. Concurrent callers with
 * the same (imageRef, fingerprint) share one check, including the options of whichever call started it.
 */
export async function checkAgentRunnerDepsDrift(
  imageRef: string = CONTAINER_IMAGE,
  options: DriftCheckOptions = {},
): Promise<DepsDriftCheck> {
  const fingerprint = await currentDepsFileFingerprint();
  const key = inFlightKey(imageRef, options.derivedFromBase === true, fingerprint);

  const existing = inFlightChecks.get(key);
  if (existing) {
    return (await existing).result;
  }

  const check = performDriftCheck(imageRef, options, fingerprint)
    .then((result) => ({ fingerprint, result }))
    .finally(() => {
      inFlightChecks.delete(key);
    });
  inFlightChecks.set(key, check);
  return (await check).result;
}

async function performDriftCheck(
  imageRef: string,
  options: DriftCheckOptions,
  fingerprint: DepsFileFingerprint,
): Promise<DepsDriftCheck> {
  const inspect = options.inspect ?? dockerInspectLabels;
  const retryDelayMs = options.retryDelayMs ?? LABEL_RETRY_DELAY_MS;
  const derived = options.derivedFromBase === true;

  // A derived image's pass holds only for the base it was checked against, so the base ID is read even on a hit.
  const currentBase = derived ? await readBaseImageId(options.inspectId) : null;
  if (currentBase?.kind === 'inspect-error') {
    return {
      ok: false,
      imageRef,
      expected: null,
      actual: null,
      lookup: currentBase,
      retried: false,
      message: `agent image check: docker inspect ${CONTAINER_IMAGE} failed, so the base ${imageRef} is built on could not be compared (${currentBase.reason}). This is an inspect failure, NOT drift — verify the container runtime is reachable before rebuilding anything.`,
    };
  }
  const currentBaseId = currentBase?.kind === 'found' ? currentBase.value : null;

  // Two stats (by the caller) skip hashing and `docker inspect` when the files have not moved since a pass.
  const cached = okResultCache.get(imageRef);
  if (
    cached &&
    fingerprintsMatch(cached.fingerprint, fingerprint) &&
    cached.baseImageId === currentBaseId &&
    Date.now() - cached.cachedAt < DEPS_DRIFT_CACHE_TTL_MS
  ) {
    return cached.result;
  }

  const [expected, first] = await Promise.all([computeAgentRunnerDepsHash(), lookupImageLabels(imageRef, inspect)]);

  // Exactly one re-read: a genuinely unlabeled image must still refuse, and the spawn path must not poll.
  let labels = first;
  let retried = false;
  if (labels.deps.kind === 'unresolved') {
    retried = true;
    await sleep(retryDelayMs);
    labels = await lookupImageLabels(imageRef, inspect);
  }
  const lookup = labels.deps;

  const depsResult: DepsDriftCheck = ((): DepsDriftCheck => {
    switch (lookup.kind) {
      case 'inspect-error':
        return {
          ok: false,
          imageRef,
          expected,
          actual: null,
          lookup,
          retried,
          message: `agent-runner deps check: docker inspect ${imageRef} failed, so no label was read (${lookup.reason}). This is an inspect failure, NOT a missing label — verify the container runtime is reachable before rebuilding anything.`,
        };
      case 'no-image':
        return {
          ok: false,
          imageRef,
          expected,
          actual: null,
          lookup,
          retried,
          message: `agent-runner image ${imageRef} not found — build it: ${rebuildHint(imageRef)}`,
        };
      case 'missing':
      case 'unresolved': {
        // Still no deps-hash label: the base image needs a rebuild (fail closed), but an admin image_tag override
        // may be a custom prebuilt image, so that fails open with a warning.
        const evidence =
          lookup.kind === 'missing'
            ? 'the image is labeled but carries no such label'
            : `no label map resolved on two reads ${retryDelayMs}ms apart`;
        if (imageRef !== CONTAINER_IMAGE) {
          return {
            ok: true,
            imageRef,
            expected,
            actual: null,
            lookup,
            retried,
            message: `agent-runner image ${imageRef} has no ${LABEL_KEY} label (${evidence}) — treating admin-set image_tag override as opt-out from drift check. If this is a derived image from ${CONTAINER_IMAGE}, rebuild base then re-run install_packages.`,
          };
        }
        return {
          ok: false,
          imageRef,
          expected,
          actual: null,
          lookup,
          retried,
          message: `agent-runner image ${imageRef} has no ${LABEL_KEY} label (${evidence}; built by an older build.sh) — rebuild: ${rebuildHint(imageRef)}`,
        };
      }
      case 'found': {
        const actual = lookup.value;
        if (actual !== expected) {
          return {
            ok: false,
            imageRef,
            expected,
            actual,
            lookup,
            retried,
            message: `agent-runner deps drift on ${imageRef}: image baked from ${actual}, current files hash to ${expected}. Run: ${rebuildHint(imageRef)}`,
          };
        }
        return { ok: true, imageRef, expected, actual, lookup, retried, message: 'agent-runner deps in sync' };
      }
    }
  })();

  const result = depsResult.ok && derived ? baseDriftResult(imageRef, currentBase, labels.base, retried) : depsResult;
  if (result.ok) {
    okResultCache.set(imageRef, { fingerprint, baseImageId: currentBaseId, result, cachedAt: Date.now() });
  }
  return result;
}

/** A derived image is current only when it records the base ID `docker inspect` reports now; no record is stale. */
function baseDriftResult(
  imageRef: string,
  currentBase: LabelLookup | null,
  recorded: LabelLookup,
  retried: boolean,
): DepsDriftCheck {
  if (currentBase?.kind !== 'found') {
    return {
      ok: false,
      imageRef,
      expected: null,
      actual: recorded.kind === 'found' ? recorded.value : null,
      lookup: { kind: 'no-image' },
      retried,
      message: `base image ${CONTAINER_IMAGE} not found, so per-agent image ${imageRef} cannot be checked against it — build it: ${rebuildHint(CONTAINER_IMAGE)}`,
    };
  }
  const current = currentBase.value;
  if (recorded.kind === 'found' && recorded.value === current) {
    return {
      ok: true,
      imageRef,
      expected: current,
      actual: current,
      lookup: recorded,
      retried,
      message: 'agent image current',
    };
  }
  const actual = recorded.kind === 'found' ? recorded.value : null;
  const was = actual
    ? `was built on base ${actual}`
    : `records no base (no ${BASE_IMAGE_ID_LABEL} label, so it predates base tracking)`;
  return {
    ok: false,
    imageRef,
    expected: current,
    actual,
    lookup: recorded,
    retried,
    message: `per-agent image ${imageRef} ${was}, but ${CONTAINER_IMAGE} is now ${current}: it is rebuilt from the current base before it spawns.`,
  };
}
