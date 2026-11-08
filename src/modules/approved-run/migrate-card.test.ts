import { describe, expect, it } from 'vitest';

import {
  migrateCardQuestion,
  migrateInterruptedText,
  migrateOutputForAgent,
  migrateRunReport,
} from './migrate-card.js';
import type { MigrationFacts } from './migrate-facts.js';
import type { MigrateClassification, MigrationProposal } from './migrate-request.js';
import { MIGRATE_TARGET } from '../../test-fixtures/migrate-target.js';

const COMMIT = 'a'.repeat(40);
const LAST = 'b'.repeat(40);
const TARGET = MIGRATE_TARGET;
const APP = { database: 'app', migration: '301_add_widgets', sha256: 'c'.repeat(64) };
const HUB = { database: 'hub', migration: '090_add_sprockets', sha256: 'd'.repeat(64) };
const P: MigrationProposal = { commit: COMMIT, goLink: 'https://example.invalid/go', files: [APP, HUB] };
const PLAIN: MigrationFacts = { refuse: null, classes: [], irreversible: [] };
const EXECUTOR = { 'tools/migrate/apply.mjs': 'blob-1', 'backend/scripts/checks.mjs': 'blob-2' };

function classification(
  p: MigrationProposal,
  facts: MigrationFacts[] = p.files.map(() => PLAIN),
): MigrateClassification {
  return {
    tier: 'card',
    denyReasons: [],
    proposal: p,
    branch: 'develop',
    checked: p.files.map((f, i) => ({
      path: `${f.database === 'hub' ? 'registry' : 'backend'}/migrations/${f.migration}.sql`,
      bytes: 10,
      facts: facts[i],
    })),
    executor: EXECUTOR,
  };
}

describe('migrateCardQuestion', () => {
  it('lists each file in order with its database, a link at the commit, its class and irreversible statements', () => {
    const q = migrateCardQuestion(
      TARGET,
      classification(P, [
        { ...PLAIN, classes: [{ name: 'operator', why: 'run in a window' }], irreversible: ['DELETE FROM widgets'] },
        PLAIN,
      ]),
      ['Alice', 'Bob'],
      { commit: LAST, blobs: EXECUTOR, at: '' },
    );
    expect(q).toContain('Applies these 2 migrations in this order.');
    expect(q).toContain(
      `1. \`app\` [301_add_widgets.sql](https://github.com/acme/widgets/blob/${COMMIT}/backend/migrations/301_add_widgets.sql)`,
    );
    expect(q).toContain('**OPERATOR**: run in a window');
    expect(q).toContain('**irreversible**: `DELETE FROM widgets`');
    expect(q.indexOf('301_add_widgets')).toBeLessThan(q.indexOf('090_add_sprockets'));
    expect(q).toContain('as `approved-run-acme-app`, `approved-run-acme-hub`');
    expect(q).toContain('_Only Alice or Bob can answer.');
    expect(q).not.toContain('⚠️');
  });

  it('warns when the code that runs with the password changed since the last approved run, or there is none', () => {
    const changed = migrateCardQuestion(TARGET, classification(P), ['Alice'], {
      commit: LAST,
      blobs: { ...EXECUTOR, 'tools/migrate/apply.mjs': 'blob-0' },
      at: '',
    });
    expect(changed).toContain('⚠️ `apply.mjs` changed since the last approved run');
    expect(changed).toContain(`https://github.com/acme/widgets/compare/${LAST}...${COMMIT}`);
    expect(migrateCardQuestion(TARGET, classification(P), ['Alice'], null)).toContain(
      '⚠️ No earlier approved run to compare',
    );
  });

  it('names the other target when the comparison comes from its last approved run, with a direct diff', () => {
    const same = migrateCardQuestion(TARGET, classification(P), ['Alice'], {
      commit: LAST,
      blobs: EXECUTOR,
      at: '',
      from: 'acme-migrate-dev',
    });
    expect(same).toContain(
      `apply.mjs and its imports match the last approved run on \`acme-migrate-dev\` (\`${LAST.slice(0, 12)}\`); this target has none of its own. They run with the database password: [read them at this commit](https://github.com/acme/widgets/tree/${COMMIT}/tools/migrate).`,
    );
    expect(same).not.toContain('⚠️');

    const changed = migrateCardQuestion(TARGET, classification(P), ['Alice'], {
      commit: LAST,
      blobs: { ...EXECUTOR, 'tools/migrate/apply.mjs': 'blob-0' },
      at: '',
      from: 'acme-migrate-dev',
    });
    expect(changed).toContain('⚠️ `apply.mjs` changed relative to the last approved run on `acme-migrate-dev`');
    expect(changed).toContain(`(https://github.com/acme/widgets/compare/${LAST}..${COMMIT})`);
  });

  it('shortens repository text to fit, and refuses a list that still cannot fit one card', () => {
    const long = { ...PLAIN, classes: [{ name: 'operator', why: 'x'.repeat(2000) }] };
    const files = Array.from({ length: 8 }, (_, i) => ({ ...APP, migration: `30${i}_add_widgets` }));
    const fits = migrateCardQuestion(
      TARGET,
      classification({ ...P, files: files.slice(0, 2) }, [long, long]),
      ['Alice'],
      null,
    );
    expect(fits).not.toContain('x'.repeat(301));
    const huge = {
      ...PLAIN,
      irreversible: Array.from({ length: 3 }, () => 'y'.repeat(60)),
      classes: Array.from({ length: 4 }, () => ({ name: 'operator', why: 'z'.repeat(400) })),
    };
    expect(() =>
      migrateCardQuestion(
        TARGET,
        classification(
          { ...P, files },
          files.map(() => huge),
        ),
        ['Alice'],
        null,
      ),
    ).toThrow(/smaller lists/);
  });
});

describe('migrateRunReport', () => {
  it('says which files applied, which failed, and what is left to propose', () => {
    const text = migrateRunReport(
      TARGET,
      'run-1',
      { ...P, files: [APP, HUB, { ...HUB, migration: '091_more' }] },
      'Alice',
      {
        kind: 'done',
        total: 3,
        steps: [
          { file: APP, outcome: { status: 'ok', output: 'applied' } },
          { file: HUB, outcome: { status: 'failed', output: 'one\ntwo\nthree\nrefused: already applied' } },
        ],
      },
    );
    expect(text).toBe(
      [
        'Approved by Alice. Acme migrate run `run-1`: 1 of 3 applied.',
        '✓ 1. `301_add_widgets` on `app`: applied, with its ledger row',
        '✗ 2. `090_add_sprockets` on `hub`: not applied: the apply script stopped before sending it',
        '– 3. `091_more` on `hub`: not run',
        'Fix `090_add_sprockets`, then propose `090_add_sprockets`, `091_more` again.',
        '```\ntwo\nthree\nrefused: already applied\n```',
      ].join('\n'),
    );
  });

  it('sends the ledger check first when a file is unknown, and names a refusal as nothing ran', () => {
    const unknown = migrateRunReport(TARGET, 'run-2', { ...P, files: [APP] }, null, {
      kind: 'done',
      total: 1,
      steps: [{ file: APP, outcome: { status: 'unknown', detail: 'the sandbox stopped', output: '' } }],
    });
    expect(unknown).toContain('? 1. `301_add_widgets` on `app`: outcome unknown (the sandbox stopped)');
    expect(unknown).toContain('Check the ledger for `301_add_widgets` before anything else');
    expect(migrateRunReport(TARGET, 'run-3', P, 'Bob', { kind: 'refused', detail: 'commit gone' })).toBe(
      'Approved by Bob. Acme migrate run `run-3`: nothing ran. commit gone',
    );
  });

  it('gives the agent each file’s whole redacted output, and nothing for a refusal', () => {
    const result = {
      kind: 'done' as const,
      total: 2,
      steps: [
        { file: APP, outcome: { status: 'ok' as const, output: 'line a' } },
        { file: HUB, outcome: { status: 'failed' as const, output: '' } },
      ],
    };
    expect(migrateOutputForAgent(result)).toBe('\n\nApply script output for 301_add_widgets:\nline a');
    expect(migrateOutputForAgent({ kind: 'refused', detail: 'x' })).toBe('');
  });
});

describe('migrateInterruptedText', () => {
  it('marks the applied files, the one in flight, and the ones never run', () => {
    const files = [APP, HUB, { ...HUB, migration: '091_more' }];
    expect(migrateInterruptedText('The host restarted during', 'run-4', files, 1, 2, false)).toBe(
      [
        'The host restarted during approved migration run `run-4`: 1 of 3 applied.',
        '✓ 1. `301_add_widgets` on `app`: applied',
        '? 2. `090_add_sprockets` on `hub`: in flight when the host stopped, so check the ledger',
        '– 3. `091_more` on `hub`: not run',
        'A retry is a new proposal for the files not marked ✓.',
      ].join('\n'),
    );
  });

  it('says nothing is known when the step log cannot be read', () => {
    expect(migrateInterruptedText('The host restarted during', 'run-5', [APP, HUB], 0, null, true)).toContain(
      'which files landed is unknown. Check the ledger for `301_add_widgets`, `090_add_sprockets`',
    );
  });
});
