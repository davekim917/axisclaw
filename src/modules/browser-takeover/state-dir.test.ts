import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { browserStateMount, privateBrowserStateMount } from './state-dir.js';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-state-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('browserStateMount', () => {
  it('mounts a host-only 0700 directory per workgroup, tightening one that already exists', () => {
    const existing = path.join(dataDir, 'browser-state', 'example-wg');
    fs.mkdirSync(existing, { recursive: true, mode: 0o755 });
    expect(browserStateMount('example-wg', dataDir)).toEqual({
      hostPath: existing,
      containerPath: '/workspace/browser-state',
      readonly: false,
    });
    expect(fs.statSync(existing).mode & 0o777).toBe(0o700);
  });

  it('mounts nothing for a key that could leave the browser-state root', () => {
    expect(browserStateMount('../example-wg', dataDir)).toBeNull();
    expect(browserStateMount('', dataDir)).toBeNull();
    expect(fs.existsSync(path.join(dataDir, 'browser-state'))).toBe(false);
  });
});

describe('privateBrowserStateMount', () => {
  it("mounts one group's own 0700 directory read-only, outside the workgroup's", () => {
    const existing = path.join(dataDir, 'browser-state-private', 'example-agent');
    fs.mkdirSync(existing, { recursive: true, mode: 0o755 });

    expect(privateBrowserStateMount('example-agent', dataDir)).toEqual({
      hostPath: existing,
      containerPath: '/workspace/browser-state-private',
      readonly: true,
    });
    expect(fs.statSync(existing).mode & 0o777).toBe(0o700);
  });

  it('mounts nothing for a folder that could leave its root', () => {
    expect(privateBrowserStateMount('../example-agent', dataDir)).toBeNull();
    expect(fs.existsSync(path.join(dataDir, 'browser-state-private'))).toBe(false);
  });
});
