import { describe, expect, it } from 'vitest';

import { lintTargets } from './lint-changed.js';

const present = () => true;

describe('lintTargets', () => {
  it.each([
    ['a source file', ['src/router.ts'], ['src/router.ts']],
    ['each linted root', ['src/a.ts', 'scripts/b.mjs', 'setup/c.ts'], ['src/a.ts', 'scripts/b.mjs', 'setup/c.ts']],
    ['a file outside the linted roots', ['container/agent-runner/src/index.ts', 'dashboard/a.ts'], []],
    ['a file eslint cannot read', ['src/schema.sql', 'docs/a.md', 'scripts/run.sh'], []],
    ['a root-level name that only starts like a root', ['setup.sh', 'src.ts'], []],
    ['a nested tsconfig, which is not the project', ['container/agent-runner/tsconfig.json'], []],
    ['no changes', [], []],
  ])('%s', (_name, changed, expected) => {
    expect(lintTargets(changed, present)).toEqual(expected);
  });

  it('skips a file the change deleted, and lints a rename by its new name', () => {
    const exists = (file: string) => file !== 'src/old.ts' && file !== 'src/gone.ts';
    expect(lintTargets(['src/gone.ts', 'src/old.ts', 'src/new.ts'], exists)).toEqual(['src/new.ts']);
  });

  it.each([
    ['eslint.config.js'],
    ['eslint.config.mjs'],
    ['pnpm-lock.yaml'],
    ['tsconfig.json'],
    ['tsconfig.scripts.json'],
  ])('lints the whole tree when %s changes, even when it is gone', (trigger) => {
    const gone = (file: string) => file !== trigger;
    expect(lintTargets(['docs/a.md', trigger], gone)).toEqual(['src/', 'scripts/', 'setup/']);
  });
});
