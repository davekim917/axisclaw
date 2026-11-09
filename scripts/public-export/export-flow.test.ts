import { describe, expect, it } from 'vitest';

import {
  NO_CHANGES_EXIT,
  redactText,
  runExport,
  type AiHoldRecord,
  type ExportDeps,
  type StatusFields,
} from './export-flow.js';
import type { RunReport } from '../check-public-boundary.js';
import {
  gateCommits,
  RECORDED_HOLD,
  type AcceptedDetail,
  type AiFinding,
  type CommitDiff,
  type GateOutcome,
  type HoldReason,
} from './gate.js';

const cleanScan: RunReport = {
  findings: [],
  mode: 'install-aware',
  registryOrigin: 'explicit',
  identifiersOrigin: 'explicit',
  registryPathsTried: [],
  identifiersPathsTried: [],
  baseline: { held: 0, heldFiles: 0, exceeded: [], below: [], counts: {}, missing: false },
  discoveryProblems: [],
  contextOnlyIdentifiers: 0,
};

type Workflow = 'export' | 'export_squash';

interface World {
  staging: string[];
  remote: string | null;
  pushes: string[];
  workflows: Workflow[];
  gated: string[][];
  status: StatusFields | null;
  accepted?: AcceptedDetail[];
  heldDetails: string[];
  /** Exported file contents by staging commit. */
  trees: Record<string, Record<string, string>>;
  /** The private commit each staging commit came from; `rev-<sha>` when unlisted. */
  origins: Record<string, string>;
  /** Private history, oldest first. */
  originHistory: string[];
  aiHolds: AiHoldRecord[] | null;
  lastHeld: { sha: string; aiFindings: AiFinding[] } | null;
  /** Replaces the harness's gate verdicts; the harness still records the call and reports holds. */
  judge?: (shas: string[]) => GateOutcome | Promise<GateOutcome>;
  /** The saved store as the last judged read began. */
  reservedAtRead?: AiHoldRecord[] | null;
}

function harness(
  world: World,
  opts: {
    publicRemote: boolean;
    copybara: (w: World, workflow: Workflow) => number;
    gate?: (shas: string[]) => GateOutcome;
    writeStatus?: ExportDeps['writeStatus'];
    clearStatus?: ExportDeps['clearStatus'];
  },
): ExportDeps {
  return {
    publicRemote: opts.publicRemote,
    redact: ['https://ghp_fixturetoken@example.com/owner/repo.git'],
    writeStatus:
      opts.writeStatus ??
      ((fields) => {
        world.status = fields;
      }),
    clearStatus:
      opts.clearStatus ??
      (() => {
        world.status = null;
      }),
    writeHeldDetail: (detail) => {
      world.heldDetails.push(detail.sha);
      world.lastHeld = detail;
    },
    writeAcceptedDetail: (accepted) => {
      world.accepted = accepted;
    },
    stagingHead: () => world.staging.at(-1) ?? null,
    resetStaging: (sha) => {
      if (sha === null) world.staging = [];
      else if (world.staging.includes(sha)) world.staging = world.staging.slice(0, world.staging.indexOf(sha) + 1);
      else if (sha === world.remote) world.staging = [sha];
      else throw new Error(`no such commit ${sha}`);
    },
    copybara: (workflow) => {
      world.workflows.push(workflow);
      return opts.copybara(world, workflow);
    },
    newCommits: (base, head) =>
      world.staging.slice(base ? world.staging.indexOf(base) + 1 : 0, world.staging.indexOf(head) + 1),
    fileAt: (sha, file) => world.trees[sha]?.[file] ?? null,
    mentions: (sha, texts) =>
      Object.entries(world.trees[sha] ?? {}).some(([file, content]) =>
        texts.some((text) => `${file}\n${content}`.toLowerCase().includes(text.toLowerCase())),
      ),
    originRev: (sha) => world.origins[sha] ?? `rev-${sha}`,
    originContains: (head, rev) => {
      const at = world.originHistory.indexOf(rev);
      return at >= 0 && at <= world.originHistory.indexOf(head);
    },
    loadAiHolds: () => world.aiHolds,
    saveAiHolds: (records) => {
      world.aiHolds = records;
    },
    readHeldDetail: () => world.lastHeld,
    gate: async (shas, watch) => {
      world.gated.push(shas);
      const judge = world.judge ?? opts.gate ?? ((all: string[]): GateOutcome => ({ lastPassing: all.at(-1) ?? null }));
      for (const sha of shas) watch.reserve(sha);
      world.reservedAtRead = world.aiHolds;
      const outcome = await judge(shas);
      for (const sha of shas) watch.settle(sha, outcome.held?.sha === sha ? outcome.held : undefined);
      return outcome;
    },
    remoteHead: () => world.remote,
    push: (sha) => {
      world.pushes.push(sha);
      world.remote = sha;
    },
  };
}

function world(overrides: Partial<World> = {}): World {
  return {
    staging: [],
    remote: null,
    pushes: [],
    workflows: [],
    gated: [],
    status: null,
    heldDetails: [],
    trees: {},
    origins: {},
    originHistory: [],
    aiHolds: null,
    lastHeld: null,
    ...overrides,
  };
}

const adds =
  (...shas: string[]) =>
  (w: World) => {
    w.staging.push(...shas);
    return 0;
  };
const holdWith =
  (reasons: HoldReason[]) =>
  (...heldShas: string[]) =>
  (shas: string[]): GateOutcome => {
    const index = shas.findIndex((sha) => heldShas.includes(sha));
    if (index < 0) return { lastPassing: shas.at(-1) ?? null };
    return {
      lastPassing: index === 0 ? null : shas[index - 1],
      held: { sha: shas[index], reasons, aiFindings: [] },
    };
  };
const holdOn = holdWith([{ source: 'scanner', where: 'a.ts:1', category: 'private-identifier' }]);
const aiFlag: HoldReason = { source: 'ai', where: 'ai read', category: 'possible-identifier' };
const aiHoldOn = holdWith([aiFlag]);

describe('runExport publishes only what this run gated on top of the public head', () => {
  it('pushes every commit gated after the public head', async () => {
    const w = world({ staging: ['s1'], remote: 's1' });
    expect(await runExport(harness(w, { publicRemote: true, copybara: adds('s2', 's3') }))).toBe(0);
    expect(w.workflows).toEqual(['export']);
    expect(w.gated).toEqual([['s2', 's3']]);
    expect(w.pushes).toEqual(['s3']);
    expect(w.status).toMatchObject({ status: 'ok', lastPublished: 's3' });
  });

  it('re-gates a head an earlier run gated but never pushed, and does not push it once the inventory flags it', async () => {
    const w = world({ staging: ['s1', 's2'], remote: 's1' });
    const code = await runExport(
      harness(w, {
        publicRemote: true,
        copybara: (cw, workflow) => (workflow === 'export' ? adds('s2')(cw) : adds('sq')(cw)),
        gate: holdOn('s2', 'sq'),
      }),
    );
    expect(code).toBe(2);
    expect(w.gated[0]).toEqual(['s2']);
    expect(w.pushes).toEqual([]);
    expect(w.staging).toEqual(['s1']);
  });

  it('re-exports and re-gates everything when there is no public head', async () => {
    const w = world({ staging: ['dry-run-head'] });
    const stagingAtExport: string[][] = [];
    await runExport(
      harness(w, {
        publicRemote: true,
        copybara: (cw) => {
          stagingAtExport.push([...cw.staging]);
          return adds('fresh')(cw);
        },
      }),
    );
    expect(stagingAtExport).toEqual([[]]);
    expect(w.workflows).toEqual(['export_squash']);
    expect(w.gated).toEqual([['fresh']]);
    expect(w.pushes).toEqual(['fresh']);
  });

  it('never publishes a staging commit this run did not gate', async () => {
    const w = world({ staging: ['s1', 'ungated'], remote: 's1' });
    expect(await runExport(harness(w, { publicRemote: true, copybara: () => NO_CHANGES_EXIT }))).toBe(0);
    expect(w.pushes).toEqual([]);
    expect(w.staging).toEqual(['s1']);
  });

  it('pushes nothing on a dry run', async () => {
    const w = world();
    expect(await runExport(harness(w, { publicRemote: false, copybara: adds('s1') }))).toBe(0);
    expect(w.pushes).toEqual([]);
    expect(w.status).toMatchObject({ status: 'ok', lastPassing: 's1', lastPublished: null });
  });
});

describe('runExport holds and recovers within one run', () => {
  it('pushes the passing prefix and holds when the squash of the rest still holds', async () => {
    const w = world({ staging: ['s1'], remote: 's1' });
    const code = await runExport(
      harness(w, {
        publicRemote: true,
        copybara: (cw, workflow) => (workflow === 'export' ? adds('s2', 's3', 's4')(cw) : adds('sq')(cw)),
        gate: holdOn('s3', 'sq'),
      }),
    );
    expect(code).toBe(2);
    expect(w.workflows).toEqual(['export', 'export_squash']);
    expect(w.gated).toEqual([['s2', 's3', 's4'], ['sq']]);
    expect(w.pushes).toEqual(['s2']);
    expect(w.staging).toEqual(['s1', 's2']);
    expect(w.status).toMatchObject({ status: 'held', lastPublished: 's2', held: { sha: 'sq' } });
  });

  it('publishes the squash when a later private commit removed what held', async () => {
    const w = world({ staging: ['s1'], remote: 's1' });
    const code = await runExport(
      harness(w, {
        publicRemote: true,
        copybara: (cw, workflow) => (workflow === 'export' ? adds('s2', 'fix')(cw) : adds('sq')(cw)),
        gate: holdOn('s2'),
      }),
    );
    expect(code).toBe(0);
    expect(w.pushes).toEqual(['sq']);
    expect(w.status).toMatchObject({ status: 'ok', held: undefined });
  });

  it('reports ok when the held delta was fully reverted, so the squash has nothing to add', async () => {
    const w = world({ staging: ['s1'], remote: 's1' });
    const code = await runExport(
      harness(w, {
        publicRemote: true,
        copybara: (cw, workflow) => (workflow === 'export' ? adds('s2', 'revert')(cw) : NO_CHANGES_EXIT),
        gate: holdOn('s2'),
      }),
    );
    expect(code).toBe(0);
    expect(w.pushes).toEqual([]);
    expect(w.status).toMatchObject({ status: 'ok', held: undefined, lastPublished: 's1' });
  });
});

describe('runExport never re-reads an AI hold as a squash', () => {
  it('holds a per-commit AI hold with no quote without a squash retry, publishing none of the prefix', async () => {
    const w = world({ staging: ['s1'], remote: 's1' });
    const code = await runExport(
      harness(w, {
        publicRemote: true,
        copybara: (cw, workflow) => (workflow === 'export' ? adds('s2', 's3', 's4')(cw) : adds('sq')(cw)),
        gate: aiHoldOn('s3'),
      }),
    );
    expect(code).toBe(2);
    expect(w.workflows).toEqual(['export']);
    expect(w.gated).toEqual([['s2', 's3', 's4']]);
    expect(w.pushes).toEqual([]);
    expect(w.heldDetails).toEqual(['s3']);
    expect(w.status).toMatchObject({ status: 'held', workflow: 'export', held: { sha: 's3' } });
  });

  it('holds when an AI reason sits beside a scanner reason', async () => {
    const w = world({ staging: ['s1'], remote: 's1' });
    const code = await runExport(
      harness(w, {
        publicRemote: true,
        copybara: (cw, workflow) => (workflow === 'export' ? adds('s2')(cw) : adds('sq')(cw)),
        gate: holdWith([
          { source: 'scanner', where: 'a.ts:1', category: 'private-identifier' },
          { source: 'ai', where: 'ai read', category: 'possible-identifier' },
        ])('s2'),
      }),
    );
    expect(code).toBe(2);
    expect(w.workflows).toEqual(['export']);
    expect(w.pushes).toEqual([]);
  });

  it('records a scanner hold that the squash retry recovered', async () => {
    const w = world({ staging: ['s1'], remote: 's1' });
    const code = await runExport(
      harness(w, {
        publicRemote: true,
        copybara: (cw, workflow) => (workflow === 'export' ? adds('s2', 'fix')(cw) : adds('sq')(cw)),
        gate: holdOn('s2'),
      }),
    );
    expect(code).toBe(0);
    expect(w.workflows).toEqual(['export', 'export_squash']);
    expect(w.pushes).toEqual(['sq']);
    expect(w.heldDetails).toEqual(['s2']);
    expect(w.status).toMatchObject({ status: 'ok', perCommitHold: { sha: 's2' } });
  });
});

describe('runExport retries an AI hold as a squash only when the held text is provably gone', () => {
  const leak = 'use the zz-acme tile';
  const finding = { file: 'src/browser.ts', line: 1, text: `  ${leak} `, why: 'client name' };
  const aiHoldFinding =
    (...findings: AiFinding[]) =>
    (held: string) =>
    (shas: string[]): GateOutcome => {
      const outcome = aiHoldOn(held)(shas);
      return outcome.held ? { ...outcome, held: { ...outcome.held, aiFindings: findings } } : outcome;
    };
  const leakyRun = (squashTree: Record<string, string>, ...findings: AiFinding[]) => {
    const w = world({
      staging: ['s1'],
      remote: 's1',
      trees: { leak: { 'src/browser.ts': `const help = "${leak}";\nconst tile = "zz-acme";\n` }, sq: squashTree },
    });
    const deps = harness(w, {
      publicRemote: true,
      copybara: (cw, workflow) => (workflow === 'export' ? adds('leak', 'fix')(cw) : adds('sq')(cw)),
      gate: aiHoldFinding(...(findings.length > 0 ? findings : [finding]))('leak'),
    });
    return { w, deps };
  };

  it('publishes the squash when a later commit removed the held text, and never the leaky commit', async () => {
    const { w, deps } = leakyRun({ 'src/browser.ts': 'const help = "use the example tile";\n' });
    expect(await runExport(deps)).toBe(0);
    expect(w.workflows).toEqual(['export', 'export_squash']);
    expect(w.gated).toEqual([['leak', 'fix'], ['sq']]);
    expect(w.pushes).toEqual(['sq']);
    expect(w.staging).toEqual(['s1', 'sq']);
    expect(w.heldDetails).toEqual(['leak']);
    expect(w.status).toMatchObject({
      status: 'ok',
      workflow: 'export_squash',
      perCommitHold: { sha: 'leak' },
      squashReason: 'ai-hold-fixed-forward',
    });
  });

  it('holds without gating the squash when the held text is still in the file', async () => {
    const { w, deps } = leakyRun({ 'src/browser.ts': `const help = "${leak}";\nconst other = 1;\n` });
    expect(await runExport(deps)).toBe(2);
    expect(w.gated).toEqual([['leak', 'fix']]);
    expect(w.pushes).toEqual([]);
    expect(w.staging).toEqual(['s1']);
    expect(w.status).toMatchObject({ status: 'held', workflow: 'export', held: { sha: 'leak' } });
    expect(w.status).not.toHaveProperty('perCommitHold');
  });

  it('holds when the held text moved to another file', async () => {
    const { w, deps } = leakyRun({
      'src/browser.ts': 'const help = "use the example tile";\n',
      'src/moved.ts': `export const help = "${leak}";\n`,
    });
    expect(await runExport(deps)).toBe(2);
    expect(w.gated).toEqual([['leak', 'fix']]);
    expect(w.pushes).toEqual([]);
  });

  it('holds when the held text survives in another case or in a path', async () => {
    const squashTrees: Array<Record<string, string>> = [
      { 'src/browser.ts': `const help = "${leak.toUpperCase()}";\n` },
      { [`docs/${leak}.md`]: 'renamed\n' },
    ];
    for (const squashTree of squashTrees) {
      const { w, deps } = leakyRun(squashTree);
      expect(await runExport(deps)).toBe(2);
      expect(w.pushes).toEqual([]);
    }
  });

  it.each([
    ['empty', { ...finding, text: '   ' }],
    ['too short to be specific', { ...finding, text: 'zz-acme' }],
    ['missing', { file: finding.file, why: 'client name' }],
    ['spread over several lines', { ...finding, text: `${leak}";\nconst tile` }],
    ['not quoted from its file', { ...finding, text: 'the zz-acme okta tile' }],
    ['attributed to no file', { text: finding.text, why: 'client name' }],
    ['attributed to a file that does not hold it', { ...finding, file: 'src/other.ts' }],
    ['attributed to another line of its file', { ...finding, line: 2 }],
    ['attributed to no line', { file: finding.file, text: finding.text, why: 'client name' }],
  ])('holds when a finding text is %s, even though the squash lacks it', async (_name, bad) => {
    const { w, deps } = leakyRun({ 'src/browser.ts': 'const help = "use the example tile";\n' }, finding, bad);
    expect(await runExport(deps)).toBe(2);
    expect(w.gated).toEqual([['leak', 'fix']]);
    expect(w.pushes).toEqual([]);
  });

  it('holds when any AI reason carries no finding to prove gone', async () => {
    const { w, deps } = leakyRun({ 'src/browser.ts': 'const help = "use the example tile";\n' });
    w.judge = (shas) => {
      const outcome = aiHoldFinding(finding)('leak')(shas);
      if (!outcome.held) return outcome;
      const reasons: HoldReason[] = [
        { source: 'ai', where: 'ai read batch 1/2', category: 'possible-identifier' },
        { source: 'ai', where: 'ai read batch 2/2', category: 'hold-without-finding' },
      ];
      return { ...outcome, held: { ...outcome.held, reasons } };
    };
    expect(await runExport(deps)).toBe(2);
    expect(w.gated).toEqual([['leak', 'fix']]);
    expect(w.pushes).toEqual([]);
  });

  it('holds when the squash of a fixed-forward hold flags something new', async () => {
    const { w, deps } = leakyRun({ 'src/browser.ts': 'const help = "use the example tile";\n' });
    const perCommit = aiHoldFinding(finding)('leak');
    w.judge = (shas) => (shas.includes('sq') ? aiHoldFinding(finding)('sq')(shas) : perCommit(shas));
    expect(await runExport(deps)).toBe(2);
    expect(w.pushes).toEqual([]);
    expect(w.staging).toEqual(['s1']);
    expect(w.heldDetails).toEqual(['leak', 'sq']);
    expect(w.status).toMatchObject({ status: 'held', held: { sha: 'sq' }, squashReason: 'ai-hold-fixed-forward' });
  });
});

describe('runExport proves an elided finding by the parts its ellipsis left', () => {
  const line = 'const help = "open the zz-acme tile from the zz-acme portal";';
  const elided = (text: string): AiFinding => ({ file: 'src/browser.ts', line: 1, text, why: 'client name' });
  const elidedRun = (found: AiFinding, squashTree: Record<string, string>) => {
    const w = world({
      staging: ['s1'],
      remote: 's1',
      trees: { leak: { 'src/browser.ts': `${line}\n` }, sq: squashTree },
    });
    const deps = harness(w, {
      publicRemote: true,
      copybara: (cw, workflow) => (workflow === 'export' ? adds('leak', 'fix')(cw) : adds('sq')(cw)),
      gate: (shas) => {
        const outcome = aiHoldOn('leak')(shas);
        return outcome.held ? { ...outcome, held: { ...outcome.held, aiFindings: [found] } } : outcome;
      },
    });
    return { w, deps };
  };
  const fixed = { 'src/browser.ts': 'const help = "open the example tile from the example portal";\n' };

  it.each([
    ['three dots', 'open the zz-acme tile ... zz-acme portal'],
    ['an ellipsis character', 'open the zz-acme tile … zz-acme portal'],
  ])('publishes the squash once every part of a finding elided with %s is gone', async (_name, text) => {
    const { w, deps } = elidedRun(elided(text), fixed);
    expect(await runExport(deps)).toBe(0);
    expect(w.gated).toEqual([['leak', 'fix'], ['sq']]);
    expect(w.pushes).toEqual(['sq']);
    expect(w.status).toMatchObject({ status: 'ok', squashReason: 'ai-hold-fixed-forward' });
  });

  it('records each part as a quote, and holds while any one of them is still published', async () => {
    const found = elided('open the zz-acme tile ... zz-acme portal');
    const { w, deps } = elidedRun(found, { 'src/browser.ts': 'const help = "see the zz-acme portal";\n' });
    expect(await runExport(deps)).toBe(2);
    expect(w.gated).toEqual([['leak', 'fix']]);
    expect(w.pushes).toEqual([]);
    expect(w.aiHolds).toEqual([
      { originRev: 'rev-leak', findings: [found], texts: ['open the zz-acme tile', 'zz-acme portal'] },
    ]);
  });

  it('records only the parts that are on the finding line', async () => {
    const found = elided('open the zz-acme tile ... the zz-acme portals list');
    const { w, deps } = elidedRun(found, { 'src/browser.ts': 'const help = "open the zz-acme tile";\n' });
    expect(await runExport(deps)).toBe(2);
    expect(w.gated).toEqual([['leak', 'fix']]);
    expect(w.aiHolds).toEqual([{ originRev: 'rev-leak', findings: [found], texts: ['open the zz-acme tile'] }]);
  });

  it.each([
    ['too short', 'open ... tile ... portal'],
    ['not on its line', 'show the zz-acme tiles ... the zz-acme portals list'],
  ])('keeps a finding unprovable, holding every commit, when each part is %s', async (_name, text) => {
    const found = elided(text);
    const { w, deps } = elidedRun(found, fixed);
    expect(await runExport(deps)).toBe(2);
    expect(w.gated).toEqual([['leak', 'fix']]);
    expect(w.pushes).toEqual([]);
    expect(w.aiHolds).toEqual([{ originRev: 'rev-leak', findings: [found], texts: null }]);
  });
});

describe('runExport never reads again what an earlier run AI-held', () => {
  const leak = 'use the zz-acme tile';
  const finding = { file: 'src/browser.ts', line: 1, text: leak, why: 'client name' };
  const record = (overrides: Partial<AiHoldRecord> = {}): AiHoldRecord => ({
    originRev: 'rev-leak',
    findings: [finding],
    texts: [leak],
    ...overrides,
  });
  const fixedTree = { 'src/browser.ts': 'const help = "use the example tile";\n' };
  const leakyTree = { 'src/browser.ts': `const help = "${leak}";\n` };
  const nextRun = (overrides: Partial<World>, squashTree: Record<string, string> = fixedTree) => {
    const w = world({ staging: ['s1'], remote: 's1', trees: { leak: leakyTree, sq: squashTree }, ...overrides });
    const deps = harness(w, {
      publicRemote: true,
      copybara: (cw, workflow) => (workflow === 'export' ? adds('leak', 'fix')(cw) : adds('sq')(cw)),
    });
    return { w, deps };
  };

  it('holds the flagged commit without a read, though a fresh read would pass it, and publishes the fix as a squash', async () => {
    const { w, deps } = nextRun({ aiHolds: [record()] });
    expect(await runExport(deps)).toBe(0);
    expect(w.gated).toEqual([['sq']]);
    expect(w.pushes).toEqual(['sq']);
    expect(w.status).toMatchObject({
      status: 'ok',
      perCommitHold: { sha: 'leak', reasons: [{ source: 'ai', category: RECORDED_HOLD }] },
      squashReason: 'ai-hold-fixed-forward',
    });
  });

  it('reads neither the flagged commit nor the squash while the flagged text remains', async () => {
    const { w, deps } = nextRun({ aiHolds: [record()] }, leakyTree);
    expect(await runExport(deps)).toBe(2);
    expect(w.gated).toEqual([]);
    expect(w.pushes).toEqual([]);
    expect(w.status).toMatchObject({ status: 'held', held: { sha: 'leak' } });
  });

  it('holds a later commit that still carries a flagged quote, though its own origin was never flagged', async () => {
    const { w, deps } = nextRun({ aiHolds: [record({ originRev: 'rev-elsewhere' })] }, leakyTree);
    expect(await runExport(deps)).toBe(2);
    expect(w.gated).toEqual([]);
    expect(w.pushes).toEqual([]);
    expect(w.aiHolds).toEqual([record({ originRev: 'rev-elsewhere' })]);
  });

  it('records no new flag for a hold an earlier flag decided, so the fix still publishes as a squash', async () => {
    const { w, deps } = nextRun({ aiHolds: [record({ originRev: 'rev-elsewhere' })] });
    expect(await runExport(deps)).toBe(0);
    expect(w.gated).toEqual([['sq']]);
    expect(w.pushes).toEqual(['sq']);
    expect(w.aiHolds).toEqual([record({ originRev: 'rev-elsewhere' })]);
  });

  it('starts the store from the last held detail, so a hold made before records were kept is not read again', async () => {
    const { w, deps } = nextRun({ lastHeld: { sha: 'leak', aiFindings: [finding] } });
    expect(await runExport(deps)).toBe(0);
    expect(w.gated).toEqual([['sq']]);
    expect(w.pushes).toEqual(['sq']);
    expect(w.aiHolds).toEqual([record()]);
  });

  it('seeds a held commit it cannot resolve as a flag without a provable quote, which holds every commit', async () => {
    for (const aiFindings of [[finding], [{ ...finding, text: 'the zz-acme okta tile, paraphrased' }]]) {
      const { w, deps } = nextRun({ lastHeld: { sha: 'gone', aiFindings } });
      deps.originRev = (sha) => (sha === 'gone' ? null : `rev-${sha}`);
      expect(await runExport(deps)).toBe(2);
      expect(w.workflows).toEqual(['export']);
      expect(w.gated).toEqual([]);
      expect(w.pushes).toEqual([]);
      expect(w.aiHolds).toEqual([{ originRev: null, findings: aiFindings, texts: null }]);
    }
  });

  it('never drops a record whose commit could not be resolved, however far the public head has moved', async () => {
    const unresolved = record({ originRev: null, texts: null });
    const w = world({
      staging: ['s1'],
      remote: 's1',
      origins: { s1: 'rev-s1' },
      originHistory: ['rev-leak', 'rev-s1'],
      aiHolds: [unresolved],
      trees: { s2: fixedTree },
    });
    expect(await runExport(harness(w, { publicRemote: true, copybara: adds('s2') }))).toBe(2);
    expect(w.gated).toEqual([]);
    expect(w.aiHolds).toEqual([unresolved]);
  });

  it('gives the squash its own AI read, and holds when that read flags it', async () => {
    const reads: string[] = [];
    const { w, deps } = nextRun({ aiHolds: [] });
    const diffs: Record<string, CommitDiff> = {
      leak: { message: 'leak', addedLines: [`src/browser.ts:1: const help = "${leak}";`] },
      fix: { message: 'fix', addedLines: ['src/browser.ts:1: const help = "use the example tile";'] },
      sq: { message: 'squash', addedLines: ['src/browser.ts:1: const help = "use the example tile";'] },
    };
    const aiOk = (verdict: 'pass' | 'hold', findings: AiFinding[]) => ({
      exitCode: 0,
      timedOut: false,
      stdout: JSON.stringify({ subtype: 'success', is_error: false, structured_output: { verdict, findings } }),
    });
    deps.gate = (shas, watch) =>
      gateCommits(
        shas,
        (sha) => ({ ...diffs[sha], sha, treeDir: '/nonexistent', binaries: [], dispose: () => {} }),
        {
          scanTree: () => cleanScan,
          scanMessage: () => cleanScan,
          aiRead: async (payload) => {
            const sha = payload.includes('COMMIT MESSAGE:\nsquash') ? 'sq' : payload.includes(leak) ? 'leak' : 'fix';
            reads.push(sha);
            return sha === 'fix' ? aiOk('pass', []) : aiOk('hold', [finding]);
          },
          aiMaxChars: 10_000,
          approvedBinaries: new Set(),
          acceptedFindings: [],
          aiBudget: { cap: 15, spent: 0 },
        },
        (sha) => diffs[sha],
        watch,
      );
    expect(await runExport(deps)).toBe(2);
    expect(reads).toEqual(['leak', 'sq']);
    expect(w.pushes).toEqual([]);
    expect(w.staging).toEqual(['s1']);
    expect(w.status).toMatchObject({ status: 'held', held: { sha: 'sq' }, squashReason: 'ai-hold-fixed-forward' });
  });

  it('keeps a flag whose run failed before it finished, so the next run does not read it again', async () => {
    const { w, deps } = nextRun({ aiHolds: [] });
    w.judge = (shas) =>
      shas.includes('leak')
        ? { lastPassing: null, held: { sha: 'leak', reasons: [aiFlag], aiFindings: [finding] } }
        : { lastPassing: shas.at(-1) ?? null };
    deps.copybara = (workflow) => {
      w.workflows.push(workflow);
      return workflow === 'export' ? adds('leak', 'fix')(w) : 1;
    };
    expect(await runExport(deps)).toBe(1);
    expect(w.aiHolds).toEqual([record()]);
    w.staging = ['s1'];
    w.gated = [];
    deps.copybara = (workflow) => (workflow === 'export' ? adds('leak', 'fix')(w) : adds('sq')(w));
    expect(await runExport(deps)).toBe(0);
    expect(w.gated).toEqual([['sq']]);
    expect(w.pushes).toEqual(['sq']);
  });

  it('keeps a flag when resetting staging after the hold fails', async () => {
    const { w, deps } = nextRun({ aiHolds: [] });
    w.judge = () => ({ lastPassing: null, held: { sha: 'leak', reasons: [aiFlag], aiFindings: [finding] } });
    deps.resetStaging = () => {
      throw new Error('update-ref failed');
    };
    expect(await runExport(deps)).toBe(1);
    expect(w.aiHolds).toEqual([record()]);
  });

  it('records nothing on a dry run, which publishes nothing', async () => {
    const w = world({ trees: { sq: leakyTree } });
    const deps = harness(w, {
      publicRemote: false,
      copybara: adds('sq'),
      gate: () => ({ lastPassing: null, held: { sha: 'sq', reasons: [aiFlag], aiFindings: [finding] } }),
    });
    expect(await runExport(deps)).toBe(2);
    expect(w.aiHolds).toBeNull();
  });

  it('records no flag and tries no squash for a read that failed', async () => {
    const { w, deps } = nextRun({ aiHolds: [] });
    w.judge = holdWith([{ source: 'ai', where: 'ai read', category: 'timeout' }])('leak');
    expect(await runExport(deps)).toBe(2);
    expect(w.workflows).toEqual(['export']);
    expect(w.aiHolds).toEqual([]);
  });

  it('records an AI reason it does not know as a flag that cannot be pinned to a quote', async () => {
    const { w, deps } = nextRun({ aiHolds: [] });
    w.judge = (shas) => ({
      lastPassing: null,
      held: {
        sha: shas[0],
        reasons: [{ source: 'ai', where: 'ai read', category: 'new-kind' }],
        aiFindings: [finding],
      },
    });
    expect(await runExport(deps)).toBe(2);
    expect(w.workflows).toEqual(['export']);
    expect(w.aiHolds).toEqual([record({ texts: null })]);
  });

  it('holds every commit of the run, and tries no squash, while any flag cannot be pinned to a quote', async () => {
    const { w, deps } = nextRun({ aiHolds: [record({ originRev: 'rev-x', texts: null })] });
    expect(await runExport(deps)).toBe(2);
    expect(w.workflows).toEqual(['export']);
    expect(w.gated).toEqual([]);
    expect(w.pushes).toEqual([]);
  });

  it('holds an unpinnable commit flag without a squash retry', async () => {
    const { w, deps } = nextRun({ aiHolds: [record({ texts: null })] });
    expect(await runExport(deps)).toBe(2);
    expect(w.workflows).toEqual(['export']);
    expect(w.pushes).toEqual([]);
  });

  it('records a flag it cannot check against the file as unpinnable, and holds rather than failing the run', async () => {
    const { w, deps } = nextRun({ aiHolds: [] });
    deps.fileAt = () => {
      throw new Error('object is corrupt');
    };
    w.judge = (shas) => ({ lastPassing: null, held: { sha: shas[0], reasons: [aiFlag], aiFindings: [finding] } });
    expect(await runExport(deps)).toBe(2);
    expect(w.workflows).toEqual(['export']);
    expect(w.aiHolds).toEqual([record({ texts: null })]);
    expect(w.status).toMatchObject({ status: 'held', held: { sha: 'leak' } });
  });

  it('reports a hold on a commit before the flagged one as that hold, not as the flag', async () => {
    const w = world({ staging: ['s1'], remote: 's1', trees: { leak: leakyTree, sq: fixedTree }, aiHolds: [record()] });
    const deps = harness(w, {
      publicRemote: true,
      copybara: (cw, workflow) => (workflow === 'export' ? adds('scanned', 'leak')(cw) : adds('sq')(cw)),
      gate: holdOn('scanned'),
    });
    expect(await runExport(deps)).toBe(0);
    expect(w.gated).toEqual([['scanned'], ['sq']]);
    expect(w.status).toMatchObject({
      perCommitHold: { sha: 'scanned', reasons: [{ source: 'scanner' }] },
      squashReason: 'scanner-or-gate-hold',
    });
  });

  it('drops from the passing prefix a commit that carries the quote a later commit was flagged for', async () => {
    const w = world({
      staging: ['s1'],
      remote: 's1',
      aiHolds: [],
      trees: { a: { 'docs/a.md': `${leak}\n` }, b: { 'docs/a.md': `${leak}\n`, ...leakyTree }, sq: fixedTree },
    });
    w.judge = (shas) =>
      shas.includes('b')
        ? { lastPassing: 'a', held: { sha: 'b', reasons: [aiFlag], aiFindings: [finding] } }
        : { lastPassing: shas.at(-1) ?? null };
    const deps = harness(w, {
      publicRemote: true,
      copybara: (cw, workflow) => (workflow === 'export' ? adds('a', 'b', 'c')(cw) : adds('sq')(cw)),
    });
    expect(await runExport(deps)).toBe(0);
    expect(w.pushes).toEqual(['sq']);
    expect(w.staging).toEqual(['s1', 'sq']);
  });

  it('publishes none of the passing prefix while a new flag cannot be pinned to a quote', async () => {
    const w = world({ staging: ['s1'], remote: 's1', aiHolds: [], trees: { a: fixedTree, b: leakyTree } });
    w.judge = (shas) =>
      shas.includes('b')
        ? {
            lastPassing: 'a',
            held: { sha: 'b', reasons: [aiFlag], aiFindings: [finding, { text: leak, why: 'no location' }] },
          }
        : { lastPassing: shas.at(-1) ?? null };
    const deps = harness(w, {
      publicRemote: true,
      copybara: (cw, workflow) => (workflow === 'export' ? adds('a', 'b')(cw) : adds('sq')(cw)),
    });
    expect(await runExport(deps)).toBe(2);
    expect(w.workflows).toEqual(['export']);
    expect(w.pushes).toEqual([]);
    expect(w.aiHolds).toEqual([
      record({ originRev: 'rev-b', findings: [finding, { text: leak, why: 'no location' }], texts: null }),
    ]);
  });

  it('drops from the passing prefix a commit carrying a quote the squash read was flagged for', async () => {
    const w = world({
      staging: ['s1'],
      remote: 's1',
      aiHolds: [],
      trees: { a: { 'docs/a.md': `${leak}\n` }, b: {}, sq: { 'docs/a.md': `${leak}\n`, ...leakyTree } },
    });
    w.judge = (shas) =>
      shas.includes('sq')
        ? { lastPassing: null, held: { sha: 'sq', reasons: [aiFlag], aiFindings: [finding] } }
        : holdOn('b')(shas);
    const deps = harness(w, {
      publicRemote: true,
      copybara: (cw, workflow) => (workflow === 'export' ? adds('a', 'b', 'c')(cw) : adds('sq')(cw)),
    });
    expect(await runExport(deps)).toBe(2);
    expect(w.pushes).toEqual([]);
    expect(w.staging).toEqual(['s1']);
  });

  it('saves a pending hold before each read, so a run that dies mid-read leaves every commit held', async () => {
    const { w, deps } = nextRun({ aiHolds: [] });
    expect(await runExport(deps)).toBe(0);
    expect(w.reservedAtRead).toEqual([
      { originRev: 'rev-leak', findings: [], texts: null, pending: true },
      { originRev: 'rev-fix', findings: [], texts: null, pending: true },
    ]);
    expect(w.aiHolds).toEqual([]);
    const crashed = nextRun({ aiHolds: [{ originRev: 'rev-leak', findings: [], texts: null, pending: true }] });
    expect(await runExport(crashed.deps)).toBe(2);
    expect(crashed.w.gated).toEqual([]);
    expect(crashed.w.pushes).toEqual([]);
  });

  it('records a squash AI hold so the next run reads none of it', async () => {
    const w = world({
      staging: ['s1'],
      remote: 's1',
      trees: { s2: leakyTree, sq: leakyTree },
    });
    const deps = harness(w, {
      publicRemote: true,
      copybara: (cw, workflow) => (workflow === 'export' ? adds('s2')(cw) : adds('sq')(cw)),
      gate: (shas) =>
        shas.includes('sq')
          ? { lastPassing: null, held: { sha: 'sq', reasons: [aiFlag], aiFindings: [finding] } }
          : holdOn('s2')(shas),
    });
    expect(await runExport(deps)).toBe(2);
    expect(w.aiHolds).toEqual([record({ originRev: 'rev-sq' })]);
    w.gated = [];
    expect(await runExport(deps)).toBe(2);
    expect(w.gated).toEqual([]);
  });

  it('drops a record once the public head contains its commit', async () => {
    const w = world({
      staging: ['s1'],
      remote: 's1',
      origins: { s1: 'rev-s1' },
      originHistory: ['rev-leak', 'rev-s1'],
      aiHolds: [record()],
      trees: { s2: leakyTree },
    });
    expect(await runExport(harness(w, { publicRemote: true, copybara: adds('s2') }))).toBe(0);
    expect(w.pushes).toEqual(['s2']);
    expect(w.aiHolds).toEqual([]);
  });

  it('fails the run rather than gate a commit whose origin is unknown while records exist', async () => {
    const { w, deps } = nextRun({ aiHolds: [record()] });
    deps.originRev = (sha) => (sha === 'leak' ? null : `rev-${sha}`);
    expect(await runExport(deps)).toBe(1);
    expect(w.pushes).toEqual([]);
  });
});

describe('runExport when the status cannot be written', () => {
  it('removes the stale status instead of leaving a previous ok behind', async () => {
    const w = world({ staging: ['s1'], remote: 's1' });
    let cleared = false;
    const deps = harness(w, {
      publicRemote: false,
      copybara: adds('s2'),
      writeStatus: () => {
        throw new Error('disk full');
      },
      clearStatus: () => {
        cleared = true;
      },
    });
    await expect(runExport(deps)).resolves.toBe(1);
    expect(cleared).toBe(true);
  });
});

describe('runExport keeps credentials out of the status', () => {
  it('redacts the remote URL and any URL credentials from a failure', async () => {
    const w = world({ staging: ['s1'], remote: 's1' });
    const deps = harness(w, { publicRemote: true, copybara: adds('s2') });
    deps.push = () => {
      throw new Error(
        'Command failed: git push -q https://ghp_fixturetoken@example.com/owner/repo.git s2:refs/heads/main; also https://user:pw@localhost/x',
      );
    };
    expect(await runExport(deps)).toBe(1);
    expect(w.status?.status).toBe('failed');
    expect(w.status?.error).not.toContain('ghp_fixturetoken');
    expect(w.status?.error).not.toContain('user:pw');
  });

  it('leaves text without secrets unchanged', () => {
    expect(redactText('copybara export exited 1', ['https://x@h/r'])).toBe('copybara export exited 1');
  });
});

describe('runExport reports accepted findings as a count only', () => {
  it('counts and records the accepted findings of the per-commit attempt and its squash retry', async () => {
    const w = world({ staging: ['s1'], remote: 's1' });
    const code = await runExport(
      harness(w, {
        publicRemote: true,
        copybara: (cw, workflow) => (workflow === 'export' ? adds('s2')(cw) : adds('sq')(cw)),
        gate: (shas) => ({
          ...holdOn('s2')(shas),
          accepted: [{ sha: shas[0], finding: { file: 'a.ts', line: 1, text: 't', why: 'w' } }],
        }),
      }),
    );
    expect(code).toBe(0);
    expect(w.status).toMatchObject({ status: 'ok', acceptedFindings: 2 });
    expect(w.accepted?.map((entry) => entry.sha)).toEqual(['s2', 'sq']);
  });
});
