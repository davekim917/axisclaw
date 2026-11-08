import fs from 'fs';
import path from 'path';

import { log } from './log.js';
import type { VolumeMount } from './providers/provider-container-registry.js';
import { isInside, realOrResolved } from './workgroup-readonly-paths.js';

const within = (target: string, roots: readonly string[]): boolean =>
  roots.some((root) => target === root || isInside(target, root));

/**
 * Where a source leads, or null for a dangling link. Docker creates a missing source, walking through any link on the
 * way, so a path that does not exist yet resolves through its deepest existing parent.
 */
function resolveSource(hostPath: string): string | null {
  const missing: string[] = [];
  let current = path.resolve(hostPath);
  while (!fs.lstatSync(current, { throwIfNoEntry: false })) {
    missing.unshift(path.basename(current));
    current = path.dirname(current);
  }
  try {
    return path.join(fs.realpathSync(current), ...missing);
  } catch {
    return null;
  }
}

/** A symlinked writable source is excluded: its own target must not become a tree that vouches for it. */
function agentWritableTrees(mounts: readonly VolumeMount[]): string[] {
  return mounts
    .filter((m) => !m.readonly && resolveSource(m.hostPath) === path.resolve(m.hostPath))
    .map((m) => m.hostPath);
}

/**
 * Every bind whose source sits in a tree an agent can write gets the same treatment, so a new bind cannot skip it:
 * Docker follows a symlinked source as root, and `existsSync` says nothing about where one leads. A source that leaves
 * those trees is dropped. One that stays is bound by its resolved path, which a later swap of the link cannot move.
 * `knownTrees` holds what this spawn's own writable mounts cannot show: folders a sibling's container writes. A source
 * in one records its roots on the mount, so the last check before `docker run` still knows to look at it.
 */
export function pinMountSources(
  mounts: VolumeMount[],
  knownTrees: readonly string[],
  agentGroupId: string,
): VolumeMount[] {
  const writable = agentWritableTrees(mounts).map(realOrResolved);
  const trees = [...knownTrees, ...writable];
  const allowed = trees.map(realOrResolved);
  const lexical = [...trees.map((tree) => path.resolve(tree)), ...allowed];
  const readonlyTargets = new Set(mounts.filter((m) => m.readonly).map((m) => m.containerPath));
  return mounts.flatMap((mount) => {
    if (!mount.readonly && readonlyTargets.has(mount.containerPath)) {
      log.warn('Refusing writable bind over a read-only path', {
        agentGroupId,
        source: mount.hostPath,
        containerPath: mount.containerPath,
      });
      return [];
    }
    if (!within(path.resolve(mount.hostPath), lexical)) return [mount];
    const real = resolveSource(mount.hostPath);
    if (real === null || !within(real, allowed)) {
      log.warn('Refusing bind source that leaves the agent-writable trees', {
        agentGroupId,
        source: mount.hostPath,
        target: real,
        containerPath: mount.containerPath,
      });
      return [];
    }
    const pinned = { ...mount, hostPath: real };
    if (!within(real, writable)) pinned.overlayAllowedRoots ??= allowed;
    return [real === mount.hostPath && pinned.overlayAllowedRoots === mount.overlayAllowedRoots ? mount : pinned];
  });
}

/**
 * Pinning cannot hold for a source that was real when checked: a live container of the same group can rename it and
 * leave a link at the same path. The last look before `docker run` refuses that, and only runc's own resolution, a
 * window of milliseconds, stays open.
 */
export function assertMountSourcesPinned(mounts: readonly VolumeMount[]): void {
  const trees = agentWritableTrees(mounts).map(realOrResolved);
  for (const mount of mounts) {
    const agentReachable = mount.overlayAllowedRoots !== undefined || within(mount.hostPath, trees);
    if (agentReachable && resolveSource(mount.hostPath) !== mount.hostPath) {
      throw new Error(`Bind source changed before spawn: ${mount.hostPath}; aborting spawn`);
    }
  }
}

/**
 * Paths bound read-only over a writable parent that another writable mount still reaches. Listing only those keeps
 * `protectReadonlyHostPaths` from adding binds where the overlay already covers the one route in.
 */
export function exposedReadonlyOverlays(mounts: readonly VolumeMount[]): string[] {
  const writable = mounts.filter((m) => !m.readonly);
  const bound = new Set(mounts.map((m) => m.containerPath));
  const overlays = mounts.filter(
    (m) =>
      m.readonly &&
      writable.some((w) => isInside(m.containerPath, w.containerPath) && isInside(m.hostPath, w.hostPath)),
  );
  const reaches = (w: VolumeMount, source: string): boolean => {
    if (within(w.hostPath, [source])) return true;
    return (
      isInside(source, w.hostPath) &&
      !bound.has(path.posix.join(w.containerPath, ...path.relative(w.hostPath, source).split(path.sep)))
    );
  };
  return overlays.filter((o) => writable.some((w) => reaches(w, o.hostPath))).map((o) => o.hostPath);
}
