import { describe, expect, it } from 'vitest';

import { exposedReadonlyOverlays } from './mount-source-gate.js';

const groupFolder = { hostPath: '/groups/a', containerPath: '/workspace/agent', readonly: false };
const pluginsOverlay = { hostPath: '/groups/a/plugins', containerPath: '/workspace/agent/plugins', readonly: true };

describe('exposedReadonlyOverlays', () => {
  it.each([
    ['an overlay on its only route', [groupFolder, pluginsOverlay], []],
    [
      'an overlay two folders down, which must not gain a bind per folder',
      [
        { hostPath: '/session', containerPath: '/workspace', readonly: false },
        { hostPath: '/session/creds/one/keys', containerPath: '/workspace/creds/one/keys', readonly: true },
      ],
      [],
    ],
    [
      'a read-only view elsewhere, which leaves the writable original alone',
      [groupFolder, { hostPath: '/groups/a/voices', containerPath: '/workspace/voices', readonly: true }],
      [],
    ],
    [
      'a second writable bind of the same source',
      [
        groupFolder,
        pluginsOverlay,
        { hostPath: '/groups/a/plugins', containerPath: '/workspace/agent/planted', readonly: false },
      ],
      ['/groups/a/plugins'],
    ],
    [
      'a writable bind inside the overlay',
      [
        groupFolder,
        pluginsOverlay,
        { hostPath: '/groups/a/plugins/inner', containerPath: '/workspace/agent/planted', readonly: false },
      ],
      ['/groups/a/plugins'],
    ],
    [
      'a second writable bind of the folder around it',
      [groupFolder, pluginsOverlay, { hostPath: '/groups/a', containerPath: '/workspace/again', readonly: false }],
      ['/groups/a/plugins'],
    ],
  ])('%s', (_label, mounts, exposed) => {
    expect(exposedReadonlyOverlays(mounts)).toEqual(exposed);
  });
});
