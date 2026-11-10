import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CardSpecError, renderCardSpec, renderCardGuideModule } from './card-spec.js';

function card(...children: Array<{ type: string; props: Record<string, unknown> }>) {
  return {
    root: 'card',
    elements: {
      card: { type: 'Card', props: { title: 'Report' }, children: children.map((_, i) => `c${i}`) },
      ...Object.fromEntries(children.map((child, i) => [`c${i}`, { ...child, children: [] }])),
    },
  };
}

const table = (cell: string) => ({ type: 'Table', props: { headers: ['x'], rows: [[cell]] } });
const text = (content: string) => ({ type: 'Text', props: { content } });

function issuesFor(spec: unknown, channelType: string): string[] {
  try {
    renderCardSpec(spec, channelType);
    return [];
  } catch (err) {
    if (err instanceof CardSpecError) return err.issues;
    throw err;
  }
}

const barChart = (axes: { categories?: string[]; yLabel?: string }) =>
  card({
    type: 'Chart',
    props: {
      title: 'Days',
      chart: { type: 'bar', categories: ['Mon', 'Tue'], series: [{ name: 'n', values: [1, 2] }], ...axes },
    },
  });

describe('card spec', () => {
  it.each([
    [
      'an inner Card, whose image json-render would drop',
      'slack',
      {
        root: 'card',
        elements: {
          card: { type: 'Card', props: { title: 'Report' }, children: ['inner'] },
          inner: { type: 'Card', props: { imageUrl: 'https://example.com/chart.png' }, children: [] },
        },
      },
      'inner: only the root may be a Card',
    ],
    [
      'an Image child, which Discord’s embed drops',
      'discord-example',
      card({ type: 'Image', props: { url: 'https://example.com/chart.png', alt: 'Chart' } }),
      'Discord shows no Image inside a card',
    ],
    [
      'a Table caption, which Discord drops',
      'discord',
      card({ type: 'Table', props: { headers: ['x'], rows: [['1']], caption: 'Week to date' } }),
      'Discord drops a Table caption',
    ],
    [
      'a caption on a Table with no rows, which Slack drops',
      'slack',
      card({ type: 'Table', props: { headers: ['Week'], rows: [], caption: 'No deploys this week' } }),
      'loses its caption on Slack',
    ],
    [
      'repeated Chart categories, which Slack shows as text',
      'slack',
      barChart({ categories: ['Mon', 'Mon'] }),
      'a Chart would reach Slack as plain text',
    ],
    [
      'repeated Chart categories, which Discord shows with the wrong values',
      'discord',
      barChart({ categories: ['Mon', 'Mon'] }),
      'repeated categories',
    ],
    [
      'a Chart yLabel, which Discord drops',
      'discord',
      barChart({ yLabel: 'Seconds' }),
      'Discord does not show a Chart yLabel',
    ],
    [
      'a card past the 4,096 characters Discord’s embed takes',
      'discord',
      card(text('x'.repeat(4097))),
      'characters on Discord, which takes 4096',
    ],
    [
      'Fields past the 25 Discord takes in all, across two groups',
      'discord',
      {
        root: 'card',
        elements: {
          card: { type: 'Card', props: { title: 'KPIs' }, children: ['a', 'b'] },
          a: { type: 'Fields', props: {}, children: Array.from({ length: 13 }, (_, i) => `a${i}`) },
          b: { type: 'Fields', props: {}, children: Array.from({ length: 13 }, (_, i) => `b${i}`) },
          ...Object.fromEntries(
            [...Array.from({ length: 13 }, (_, i) => `a${i}`), ...Array.from({ length: 13 }, (_, i) => `b${i}`)].map(
              (key) => [key, { type: 'Field', props: { label: key, value: '1' }, children: [] }],
            ),
          ),
        },
      },
      'Discord takes 25 in all',
    ],
    [
      'a line break in a Table cell, which Discord’s text table turns into a space',
      'discord',
      card({ type: 'Table', props: { headers: ['query'], rows: [['SELECT 1 -- first\nUNION ALL SELECT 2']] } }),
      'turns a line break in a header or cell into a space',
    ],
  ])('refuses %s', (_name, channelType, spec, issue) => {
    expect(issuesFor(spec, channelType)).toEqual([expect.stringContaining(issue)]);
  });

  it('passes a Chart Discord shows whole, and a yLabel Slack shows', () => {
    expect(issuesFor(barChart({}), 'discord')).toEqual([]);
    expect(issuesFor(barChart({ yLabel: 'Seconds' }), 'slack')).toEqual([]);
  });

  it('is described to agents by the guide generated into the runner tree', () => {
    const generated = path.join(process.cwd(), 'container/agent-runner/src/mcp-tools/card-guide.generated.ts');
    expect(fs.readFileSync(generated, 'utf8')).toBe(renderCardGuideModule());
  });

  it('holds Slack to one table per card, and lets Discord, which renders tables as text, take two', () => {
    const twoTables = card(table('1'), table('2'));
    expect(issuesFor(twoTables, 'slack-example')).toEqual(['at most 1 Table per message']);
    expect(renderCardSpec(twoTables, 'discord').children.map((child) => child.type)).toEqual(['table', 'table']);
  });

  it.each([
    [
      '55 Text elements, past the 50 blocks Slack keeps',
      card(...Array.from({ length: 55 }, () => text('a line'))),
      'Slack blocks',
      [],
    ],
    ['a Text element Slack would cut', card(text('x'.repeat(3001))), 'where Slack cuts it', []],
    [
      'a Text that Slack’s emoji conversion grows past its cap',
      card(text('{{emoji:check}}'.repeat(200))),
      'where Slack cuts it',
      [],
    ],
    [
      'a Table whose cells Slack would show as text',
      card(table('x'.repeat(10_001))),
      'a Table would reach Slack as plain text',
      ['characters on Discord, which takes 4096', 'which takes 6000 in one message'],
    ],
    [
      'a Field Slack would cut once it converts label and value apart',
      {
        root: 'card',
        elements: {
          card: { type: 'Card', props: { title: 'Field' }, children: ['kpis'] },
          kpis: { type: 'Fields', props: {}, children: ['f'] },
          f: { type: 'Field', props: { label: `${'x'.repeat(1983)}{{emoji:`, value: 'smile}}' }, children: [] },
        },
      },
      'where Slack cuts it',
      ['Field label is over 256'],
    ],
    [
      'a LinkButton URL Slack refuses',
      {
        root: 'card',
        elements: {
          card: { type: 'Card', props: { title: 'Link' }, children: ['row'] },
          row: { type: 'Actions', props: {}, children: ['open'] },
          open: {
            type: 'LinkButton',
            props: { label: 'Open', url: `https://example.com/${'x'.repeat(2981)}` },
            children: [],
          },
        },
      },
      'which Slack refuses',
      ['URL is over 512'],
    ],
    [
      '26 LinkButtons in one Actions element',
      {
        root: 'card',
        elements: {
          card: { type: 'Card', props: { title: 'Links' }, children: ['row'] },
          row: { type: 'Actions', props: {}, children: Array.from({ length: 26 }, (_, i) => `b${i}`) },
          ...Object.fromEntries(
            Array.from({ length: 26 }, (_, i) => [
              `b${i}`,
              { type: 'LinkButton', props: { label: `Link ${i}`, url: `https://example.com/${i}` }, children: [] },
            ]),
          ),
        },
      },
      'Slack takes 25',
      ['rows of buttons on Discord'],
    ],
  ])('refuses %s on Slack, and holds it to Discord’s own limits', (_name, spec, issue, discordIssues: string[]) => {
    expect(issuesFor(spec, 'slack')).toEqual([expect.stringContaining(issue)]);
    expect(issuesFor(spec, 'discord')).toEqual(
      discordIssues.map((discordIssue) => expect.stringContaining(discordIssue)),
    );
  });
});
