import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { enforceHermeticity } from '../src/test-hermeticity.js';
import { findAtImports } from './instruction-surface.js';

enforceHermeticity();

const lines = (...text: string[]) => text.join('\n');
const TAB = '\t';

function fixture(): string {
  const base = globalThis.uniqueTmpRoot('at-imports');
  for (const file of ['docs/rules.md', 'docs/snake_case.md', 'notes.md', 'with space.md', 'LICENSE']) {
    fs.mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
    fs.writeFileSync(path.join(base, file), 'x\n');
  }
  return base;
}

describe('findAtImports', () => {
  // Every form here is one Claude Code 2.1.318 expanded, or a variant of one.
  it.each([
    ['a line-start relative import', '@./notes.md', './notes.md'],
    ['an import mid-line', 'Read @docs/rules.md first.', 'docs/rules.md'],
    ['a heading', '## @notes.md', 'notes.md'],
    ['a list item', '- @notes.md', 'notes.md'],
    ['a bare name that exists beside the file', 'See @LICENSE', 'LICENSE'],
    ['a home path absent on this machine', '@~/absent-here.md', '~/absent-here.md'],
    ['a relative markdown target that does not exist', '@docs/absent.md', 'docs/absent.md'],
    ['a relative text target that does not exist', '@docs/private-rules.txt', 'docs/private-rules.txt'],
    ['an explicit relative path with no extension', '@./absent-rules', './absent-rules'],
    ['an import with a heading anchor', '@docs/rules.md#scope', 'docs/rules.md'],
    ['an escaped space', String.raw`@with\ space.md`, 'with space.md'],
    ['a snake_case file name', '@docs/snake_case.md', 'docs/snake_case.md'],
    ['bold', 'Read **@docs/rules.md** first.', 'docs/rules.md'],
    ['italics', 'Read _@notes.md_ first.', 'notes.md'],
    ['link text', 'Read [@docs/rules.md](docs/rules.md).', 'docs/rules.md'],
    ['a blockquote with no space', '>@notes.md', 'notes.md'],
    ['inline HTML', '<span>hi @notes.md</span>', 'notes.md'],
    ['a code span in a list item', '- Run `cat @docs/rules.md | wc` now', 'docs/rules.md'],
    ['text right after a link', '[doc](x)@notes.md', 'notes.md'],
    ['text right after an image', '![a](b)@notes.md', 'notes.md'],
    ['text right after a code span', 'word`x`@notes.md', 'notes.md'],
    ['text right after underscore emphasis', '_a_@LICENSE', 'LICENSE'],
    ['a backslash escape', String.raw`x\.@notes.md`, 'notes.md'],
    ['a second @ in the same run, after a link', '(@someone)[a](b)@LICENSE', 'LICENSE'],
    ['a second @ after inline HTML', '@</b>@notes.md', 'notes.md'],
    ['an @ after an escaped @', String.raw`\@@notes.md`, 'notes.md'],
    ['a trailing slash Claude normalises away', 'See @LICENSE/', 'LICENSE/'],
    ['an escaped trailing space Claude trims', String.raw`See @LICENSE\ `, 'LICENSE '],
    ['an escaped space after a markdown name', String.raw`x @notes.md\  y`, 'notes.md '],
    ['an absolute path absent on this machine', '@/nonexistent/fixture-rules.md', '/nonexistent/fixture-rules.md'],
  ])('reports %s', (_name, line, target) => {
    expect(findAtImports(lines('# Title', '', line, ''), fixture())).toEqual([{ line: 3, target }]);
  });

  // Claude skips these; reporting them costs a rewording and can never hide an import.
  it.each([
    ['a code span', 'Use `@docs/rules.md` here.'],
    ['an HTML comment', '<!-- @docs/rules.md -->'],
    ['indented code', '    @notes.md'],
    ['tab-indented code', `${TAB}@notes.md`],
  ])('over-reports %s, which Claude skips', (_name, line) => {
    expect(findAtImports(line, fixture())).toHaveLength(1);
  });

  it('over-reports inside a fence, and reports the line after it', () => {
    expect(findAtImports(lines('```', '@notes.md', '```', '@notes.md'), fixture()).map((i) => i.line)).toEqual([2, 4]);
  });

  // Claude cannot expand any of these, wherever they appear.
  it.each([
    ['an email address', 'mail fixture@docs/rules.md'],
    ['a bare mention', 'Ask @someone first.'],
    ['a bare name with no file behind it', '@absent and @docs/absent'],
    ['an extension Claude will not import', '@notes.png and @docs/rules.md.bak'],
    ['a dotted handle', 'Ping @first.last today.'],
    ['a package name', 'Bump @types/node and @fixture-scope/sdk.'],
    ['a bare name before sentence punctuation', 'See @LICENSE.'],
    ['a version tag', 'Pinned at @1.2.3 today.'],
    ['a doubled @', '@@docs/rules.md'],
    ['a dash mention', 'Hand off with an @-mention.'],
  ])('ignores %s', (_name, text) => {
    expect(findAtImports(text, fixture())).toEqual([]);
  });

  it('reports each import on its own line number', () => {
    expect(findAtImports(lines('@notes.md', 'x', 'Then @LICENSE and @docs/rules.md'), fixture())).toEqual([
      { line: 1, target: 'notes.md' },
      { line: 3, target: 'LICENSE' },
      { line: 3, target: 'docs/rules.md' },
    ]);
  });
});
