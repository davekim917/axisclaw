/** Which approved run a migration card compares the executor with. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { baselineFor, recordExecutor } from './migrate-drift.js';
import { loadTarget, type ApprovedRunTarget, type MigrateTarget } from './targets.js';
import { MIGRATE_TARGET, migrateTargetConfig } from '../../test-fixtures/migrate-target.js';

const PROD: MigrateTarget = {
  ...MIGRATE_TARGET,
  id: 'acme-migrate',
  compareWith: 'acme-migrate-dev',
  approvers: ['slack:U1', 'slack:U2'],
};
const DEV: MigrateTarget = { ...MIGRATE_TARGET, id: 'acme-migrate-dev' };
const DEV_RUN = {
  commit: 'd'.repeat(40),
  blobs: { 'tools/migrate/apply.mjs': 'blob-dev' },
  at: '2026-11-01T00:00:00Z',
};

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-drift-'));
  file = path.join(dir, 'executor-seen.json');
  recordExecutor(DEV.id, DEV_RUN, file);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const loads = (t: ApprovedRunTarget | { error: string }) => () => t;

describe('baselineFor', () => {
  it("uses the comparison target's last run while this target has none, and names it", () => {
    expect(baselineFor(PROD, loads(DEV), file)).toEqual({ ...DEV_RUN, from: 'acme-migrate-dev' });
  });

  it('prefers its own last run once it has one', () => {
    const own = {
      commit: 'e'.repeat(40),
      blobs: { 'tools/migrate/apply.mjs': 'blob-prod' },
      at: '2026-11-02T00:00:00Z',
    };
    recordExecutor(PROD.id, own, file);
    expect(baselineFor(PROD, loads(DEV), file)).toEqual(own);
  });

  it.each<[string, ApprovedRunTarget | { error: string }]>([
    ['the comparison target is missing', { error: 'no such target' }],
    ['it reads another repository', { ...DEV, repo: 'acme/other' }],
    ['it watches different files', { ...DEV, layout: { ...DEV.layout, watched: ['tools/migrate/apply.mjs'] } }],
    ['it extracts different files', { ...DEV, layout: { ...DEV.layout, extract: ['tools/migrate'] } }],
    ['someone can approve there who cannot approve here', { ...DEV, approvers: [...DEV.approvers, 'slack:UMALLORY'] }],
  ])('compares with nothing when %s', (_name, other) => {
    expect(baselineFor(PROD, loads(other), file)).toBeNull();
  });

  it('reaches the dev run through targets loaded from the config file', () => {
    const targetsPath = path.join(dir, 'targets.json');
    fs.writeFileSync(
      targetsPath,
      JSON.stringify({
        targets: [
          { ...migrateTargetConfig(['slack:UALICE'], { compareWith: 'acme-migrate-dev' }), id: 'acme-migrate' },
          { ...migrateTargetConfig(['slack:UALICE']), id: 'acme-migrate-dev' },
        ],
      }),
    );
    const prod = loadTarget('acme-migrate', targetsPath) as MigrateTarget;

    expect(baselineFor(prod, (id) => loadTarget(id, targetsPath), file)).toEqual({
      ...DEV_RUN,
      from: 'acme-migrate-dev',
    });
  });

  it('accepts the same files listed in another order, and fewer approvers there', () => {
    const other = {
      ...DEV,
      approvers: ['slack:U2'],
      layout: { ...DEV.layout, watched: [...DEV.layout.watched].reverse() },
    };
    expect(baselineFor(PROD, loads(other), file)).toEqual({ ...DEV_RUN, from: 'acme-migrate-dev' });
  });

  it('compares with nothing when no comparison target is named', () => {
    expect(baselineFor({ ...PROD, compareWith: undefined }, loads(DEV), file)).toBeNull();
  });
});
