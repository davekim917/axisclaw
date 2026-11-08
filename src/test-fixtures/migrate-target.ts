/**
 * One invented `repo-migrate` target for the migration-lane suites, as `targets.json` holds it and as `loadTarget`
 * parses it. `app` files get the checks script's rules; `hub` files do not.
 */
import type { MigrateTarget } from '../modules/approved-run/targets.js';

const MIGRATE_LAYOUT = {
  applyScript: 'tools/migrate/apply.mjs',
  extract: ['tools/migrate', 'backend/scripts'],
  watched: ['tools/migrate/apply.mjs', 'backend/scripts/checks.mjs'],
  factsModule: 'tools/migrate/facts.mjs',
};

export function migrateTargetConfig(
  approvers: string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'acme-migrate',
    label: 'Acme migrate',
    kind: 'repo-migrate',
    mode: 'execute',
    agentGroups: ['ag-1'],
    approvers,
    repo: 'acme/widgets',
    layout: MIGRATE_LAYOUT,
    databases: {
      app: {
        folder: 'backend/migrations',
        onecliAgent: 'approved-run-acme-app',
        postgresId: 'dpg-aaaaaaaaaaaaaaaaaaaa',
        checked: true,
      },
      hub: {
        folder: 'registry/migrations',
        onecliAgent: 'approved-run-acme-hub',
        postgresId: 'dpg-bbbbbbbbbbbbbbbbbbbb',
        checked: false,
      },
    },
    ...overrides,
  };
}

export const MIGRATE_TARGET: MigrateTarget = {
  id: 'acme-migrate',
  label: 'Acme migrate',
  kind: 'repo-migrate',
  mode: 'execute',
  agentGroups: ['ag-1'],
  approvers: ['slack:U1'],
  entrySha: 'e'.repeat(64),
  repo: 'acme/widgets',
  layout: MIGRATE_LAYOUT,
  databases: ['app', 'hub'],
  folders: { app: 'backend/migrations', hub: 'registry/migrations' },
  checked: ['app'],
  postgresIds: { app: 'dpg-aaaaaaaaaaaaaaaaaaaa', hub: 'dpg-bbbbbbbbbbbbbbbbbbbb' },
  execute: {
    agents: {
      app: { secret: 'approved-run-acme-app token', onecliAgent: 'approved-run-acme-app' },
      hub: { secret: 'approved-run-acme-hub token', onecliAgent: 'approved-run-acme-hub' },
    },
  },
};
