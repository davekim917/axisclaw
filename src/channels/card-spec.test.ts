import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CardSpecError, discordCardPayload, renderCardSpec, renderCardGuideModule } from './card-spec.js';

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
      'a card past the 4,000 characters of text Discord takes',
      'discord',
      card(text('x'.repeat(3993))),
      'allow up to 4000 characters across all text',
    ],
    [
      'a card past the 40 components Discord takes',
      'discord',
      card(...Array.from({ length: 39 }, () => text('a line'))),
      'allow up to 40 components',
    ],
    [
      'a line break in a Table cell, which breaks the columns of Discord’s text table',
      'discord',
      card({ type: 'Table', props: { headers: ['query'], rows: [['SELECT 1 -- first\nUNION ALL SELECT 2']] } }),
      'a line break in a header or cell breaks its columns',
    ],
    [
      'an Image alt past the 1,024 characters Discord takes for a media description',
      'discord',
      card({ type: 'Image', props: { url: 'https://example.com/chart.png', alt: 'x'.repeat(1025) } }),
      'an Image alt is over 1024 characters',
    ],
    [
      'a code fence in a Table cell, which would end the code block Discord draws the table in',
      'discord-example',
      card(table('```sql')),
      'a ``` in a header or cell would end',
    ],
    [
      'a code fence in a Chart label, which would end the code block Discord draws the chart in',
      'discord',
      card({
        type: 'Chart',
        props: { title: 'Share', chart: { type: 'pie', segments: [{ label: '```', value: 1 }] } },
      }),
      'a ``` in a header or cell would end',
    ],
  ])('refuses %s', (_name, channelType, spec, issue) => {
    expect(issuesFor(spec, channelType)).toEqual([expect.stringContaining(issue)]);
  });

  it('passes a Chart Discord shows whole, and a yLabel Slack shows', () => {
    expect(issuesFor(barChart({}), 'discord')).toEqual([]);
    expect(issuesFor(barChart({ yLabel: 'Seconds' }), 'slack')).toEqual([]);
  });

  it('posts a Discord card as Components V2 text, with its table and chart lined up in code blocks', () => {
    const report = renderCardSpec(
      {
        root: 'card',
        elements: {
          card: { type: 'Card', props: { title: 'Weekly deploys' }, children: ['note', 'kpis', 'rows', 'days', 'pic'] },
          note: { type: 'Text', props: { content: 'All services green' }, children: [] },
          kpis: { type: 'Fields', props: {}, children: ['total'] },
          total: { type: 'Field', props: { label: 'Deploys', value: '12' }, children: [] },
          rows: {
            type: 'Table',
            props: { headers: ['Service', 'Count'], rows: [['ledger-api', '9']], caption: 'By service' },
            children: [],
          },
          days: {
            type: 'Chart',
            props: {
              title: 'Per day',
              chart: { type: 'bar', categories: ['Mon'], series: [{ name: 'n', values: [3] }] },
            },
            children: [],
          },
          pic: { type: 'Image', props: { url: 'https://example.com/chart.png', alt: 'Chart' }, children: [] },
        },
      },
      'discord',
    );
    const payload = discordCardPayload(report);
    expect(payload.flags).toBe(1 << 15);
    expect(payload.components).toHaveLength(1);
    expect(payload.components[0]!.components!.map((c) => (c.type === 10 ? c.content : c.type))).toEqual([
      '# Weekly deploys',
      'All services green',
      '**Deploys**\n12',
      '*By service*\n```\nService    | Count\n-----------|------\nledger-api | 9\n```',
      '**Per day**\n```\n    | n\n----|--\nMon | 3\n```',
      12,
    ]);
  });

  it('keeps a Discord card in spec order through nested Sections', () => {
    const report = renderCardSpec(
      {
        root: 'card',
        elements: {
          card: { type: 'Card', props: { title: 'Deploys' }, children: ['envs'] },
          envs: { type: 'Section', props: {}, children: ['prod', 'prodRuns', 'stage', 'stageRuns'] },
          prod: { type: 'Text', props: { content: 'Production' }, children: [] },
          prodRuns: { type: 'Section', props: {}, children: ['prodCount'] },
          prodCount: { type: 'Text', props: { content: 'Deploys: 12' }, children: [] },
          stage: { type: 'Text', props: { content: 'Staging' }, children: [] },
          stageRuns: { type: 'Section', props: {}, children: ['stageCount'] },
          stageCount: { type: 'Text', props: { content: 'Deploys: 3' }, children: [] },
        },
      },
      'discord',
    );
    expect(discordCardPayload(report).components[0]!.components!.map((c) => c.content)).toEqual([
      '# Deploys',
      'Production',
      'Deploys: 12',
      'Staging',
      'Deploys: 3',
    ]);
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
      ['allow up to 40 components'],
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
      ['allow up to 4000 characters across all text'],
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
      [],
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
      [],
    ],
  ])('refuses %s on Slack, and holds it to Discord’s own limits', (_name, spec, issue, discordIssues: string[]) => {
    expect(issuesFor(spec, 'slack')).toEqual([expect.stringContaining(issue)]);
    expect(issuesFor(spec, 'discord')).toEqual(
      discordIssues.map((discordIssue) => expect.stringContaining(discordIssue)),
    );
  });
});
