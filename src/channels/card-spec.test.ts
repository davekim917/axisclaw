import fs from 'node:fs';
import path from 'node:path';

import { cardToBlockKit } from '@chat-adapter/slack';
import { describe, expect, it } from 'vitest';

import {
  CardSpecError,
  discordCardPayload,
  renderCardSpec,
  renderCardGuideModule,
  slackCardBlocks,
} from './card-spec.js';

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
const richDemo = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'docs/examples/card-rich-demo.json'), 'utf8')) as {
  spec: unknown;
};
const linkButton = (label: string, url: string) => ({
  type: 'button',
  text: { type: 'plain_text', text: label, emoji: true },
  action_id: `link-${url}`,
  url,
});
const richCell = (element: Record<string, unknown>) => ({
  type: 'rich_text',
  elements: [{ type: 'rich_text_section', elements: [element] }],
});

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
    [
      'a button on a muted Text, which Slack shows as a context block with no room for one',
      'slack',
      card({
        type: 'Text',
        props: { content: 'Footnote', style: 'muted', button: { label: 'Open', url: 'https://example.com/open' } },
      }),
      'a muted Text cannot carry a button',
    ],
    [
      'a number cell that also links, which Slack cannot show as one cell',
      'discord',
      card({
        type: 'Table',
        props: { headers: ['Revenue'], rows: [[{ text: '$1K', value: 1000, url: 'https://example.com/a' }]] },
      }),
      'takes no url or style',
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

  it('turns a spec using every rich piece into the Block Kit of the hand-built Slack demo', () => {
    const blocks = slackCardBlocks(renderCardSpec(richDemo.spec, 'slack'));
    expect(blocks.map((block) => block.type)).toEqual([
      'section',
      'section',
      'divider',
      'section',
      'data_visualization',
      'data_visualization',
      'data_table',
      'actions',
      'context',
    ]);
    expect(blocks[1]).toEqual({
      type: 'section',
      text: { type: 'mrkdwn', text: '*Q3 revenue at a glance*' },
      accessory: linkButton('View report', 'https://example.com/report'),
    });
    expect(blocks[3]).toEqual({
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*This quarter*\nRevenue: *$4.2M* +18%\nARR: *$16.8M* +12%\nNet retention: *118%*' },
        { type: 'mrkdwn', text: '*Pipeline*\nNew customers: *64*\nAvg deal: *$65.6K*\nWin rate: *31%*' },
      ],
    });
    const table = blocks[6] as unknown as { caption: string; page_size: number; rows: unknown[][] };
    expect(table.caption).toBe('Top accounts this quarter');
    expect(table.page_size).toBe(4);
    expect(table.rows).toHaveLength(7);
    expect(table.rows[0]).toEqual(['Account', 'Region', 'Revenue', 'QoQ'].map((h) => ({ type: 'raw_text', text: h })));
    expect(table.rows[1]).toEqual([
      richCell({ type: 'link', url: 'https://example.com/accounts/northwind', text: 'Northwind Labs' }),
      richCell({ type: 'text', text: 'NA', style: { code: true } }),
      { type: 'raw_number', value: 412000, text: '$412K' },
      richCell({ type: 'text', text: '+22%', style: { bold: true } }),
    ]);
    expect(blocks[7]).toEqual({
      type: 'actions',
      elements: [
        { ...linkButton('Open dashboard', 'https://example.com/dashboard'), style: 'primary' },
        linkButton('Export CSV', 'https://example.com/export.csv'),
      ],
    });
  });

  it('posts a card without the rich pieces as the adapter writes it, and leaves plain neighbours of rich ones alone', () => {
    const plain = renderCardSpec(
      card(
        text('All green'),
        { type: 'Table', props: { headers: ['Service', 'Deploys'], rows: [['ledger-api', 9]] } },
        { type: 'Divider', props: {} },
      ),
      'slack',
    );
    expect(slackCardBlocks(plain)).toEqual([
      { type: 'header', text: { type: 'plain_text', text: 'Report', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: 'All green' } },
      {
        type: 'data_table',
        caption: 'Table',
        rows: [
          [
            { type: 'raw_text', text: 'Service' },
            { type: 'raw_text', text: 'Deploys' },
          ],
          [
            { type: 'raw_text', text: 'ledger-api' },
            { type: 'raw_text', text: '9' },
          ],
        ],
      },
      { type: 'divider' },
    ]);

    const mixed = renderCardSpec(
      card(text('All green'), {
        type: 'Table',
        props: { headers: ['Service', 'Deploys'], rows: [['ledger-api', { text: '9', value: 9 }]] },
      }),
      'slack',
    );
    const [header, note, rich] = slackCardBlocks(mixed);
    expect([header, note]).toEqual(cardToBlockKit(mixed).slice(0, 2));
    expect((rich as unknown as { rows: unknown[][] }).rows[1]).toEqual([
      { type: 'raw_text', text: 'ledger-api' },
      { type: 'raw_number', value: 9, text: '9' },
    ]);
  });

  it('posts the same rich spec on Discord with the button beside its text and every value in the card', () => {
    const [container] = discordCardPayload(renderCardSpec(richDemo.spec, 'discord')).components;
    const parts = container!.components!;
    expect(parts.find((c) => c.type === 9)).toEqual({
      type: 9,
      components: [{ type: 10, content: '**Q3 revenue at a glance**' }],
      accessory: { type: 2, style: 5, label: 'View report', url: 'https://example.com/report' },
    });
    expect(parts.find((c) => c.type === 1)!.components!.map((b) => [b.label, b.url])).toEqual([
      ['Open dashboard', 'https://example.com/dashboard'],
      ['Export CSV', 'https://example.com/export.csv'],
    ]);
    const shown = parts.map((c) => c.content ?? '').join('\n');
    for (const value of [
      '$4.2M',
      'Win rate: **31%**',
      'Northwind Labs   | NA     | $412K   | +22%',
      'Osprey Analytics | LATAM  | $142K   | +15%',
      'Top accounts this quarter',
      'Source: demo data',
    ])
      expect(shown).toContain(value);
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
    [
      'a Text button URL Slack refuses',
      card({
        type: 'Text',
        props: { content: 'Report', button: { label: 'Open', url: `https://example.com/${'x'.repeat(2981)}` } },
      }),
      'which Slack refuses',
      ['URL is over 512'],
    ],
  ])('refuses %s on Slack, and holds it to Discord’s own limits', (_name, spec, issue, discordIssues: string[]) => {
    expect(issuesFor(spec, 'slack')).toEqual([expect.stringContaining(issue)]);
    expect(issuesFor(spec, 'discord')).toEqual(
      discordIssues.map((discordIssue) => expect.stringContaining(discordIssue)),
    );
  });
});
