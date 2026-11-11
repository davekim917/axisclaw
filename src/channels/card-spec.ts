import { defineCatalog, type PromptContext, type Spec } from '@json-render/core';
import { CardSpecError, schema, standardComponentDefinitions, toCard, type CardLimits } from '@json-render/chat';
import { createEmojiConverter } from '@chat-adapter/shared';
import { cardToDiscordPayload, DiscordContentFormat } from '@chat-adapter/discord';
import { ValidationError } from '@chat-adapter/shared';
import { cardToBlockKit } from '@chat-adapter/slack';
import { chartElementToFallbackText, tableElementToAscii, type CardChild, type CardElement } from 'chat';

import { isChannelVariant } from '../types.js';

// A Button sends a click back to the agent, and clicks ride the choice-card flow, so display cards carry links only.
const { Button: _clickBack, ...display } = standardComponentDefinitions;
const components = {
  ...display,
  Actions: { ...display.Actions, description: 'Row of LinkButton elements that open URLs.' },
  Table: {
    ...display.Table,
    description:
      'Table for row data. Every row has one cell per header. Slack and Discord left-align every column, so align is ignored.',
  },
};

// Slack's adapter degrades content past Block Kit's caps instead of refusing it: a second table becomes a code block
// and a chart past a cap becomes text. Refusing tells the agent to split or trim the card.
const SLACK_LIMITS: CardLimits = {
  tables: 1,
  charts: 2,
  fields: 10,
  tableRows: 100,
  tableColumns: 20,
  chartTitle: 50,
  chartLabel: 20,
  chartSeries: 12,
  chartPoints: 20,
};

const isSlack = (channelType: string) => channelType === 'slack' || isChannelVariant(channelType, 'slack');
const isDiscord = (channelType: string) => channelType === 'discord' || isChannelVariant(channelType, 'discord');

function limitsFor(channelType: string): CardLimits | undefined {
  return isSlack(channelType) ? SLACK_LIMITS : undefined;
}

// Block Kit caps: Slack refuses a message past 50 blocks, an actions block past 25 elements or a button URL past
// 3,000 characters, and the adapter cuts
// section and context text at 3,000 characters (two fewer for bold Text) and a field at 2,000 with its markup.
const SLACK_MAX_BLOCKS = 50;
const SLACK_MAX_ACTIONS = 25;
const SLACK_MAX_URL = 3000;
const SLACK_MAX_TEXT = 3000;
const SLACK_MAX_FIELD = 2000;
const slackEmoji = createEmojiConverter('slack');

function flatten(children: CardChild[]): CardChild[] {
  return children.flatMap((child) => (child.type === 'section' ? [child, ...flatten(child.children)] : [child]));
}

/**
 * What would not reach Slack whole, read from the converter the adapter posts with (`cardToBlockKit`), so its own
 * rules decide which tables and charts it shows natively. Text is measured after the adapter's emoji conversion,
 * which only grows it, and before its markdown conversion, which only shrinks it, so a long Text is never cut
 * unnoticed. A title, button label or alt text past its cap is shortened with an ellipsis, and that is allowed.
 */
function slackLosses(card: CardElement): string[] {
  const blocks = cardToBlockKit(card) as Array<{ type: string }>;
  const children = flatten(card.children);
  const count = (types: string[]) => blocks.filter((block) => types.includes(block.type)).length;
  const issues: string[] = [];
  if (blocks.length > SLACK_MAX_BLOCKS)
    issues.push(
      `the card makes ${blocks.length} Slack blocks and Slack takes ${SLACK_MAX_BLOCKS}; merge Text elements`,
    );
  if (count(['table', 'data_table']) < children.filter((child) => child.type === 'table').length)
    issues.push('a Table would reach Slack as plain text: keep its headers and cells under 10,000 characters in all');
  if (children.some((child) => child.type === 'table' && child.caption && child.rows.length === 0))
    issues.push('a Table with no rows loses its caption on Slack; put the caption in a Text');
  if (count(['data_visualization']) < children.filter((child) => child.type === 'chart').length)
    issues.push('a Chart would reach Slack as plain text: give every category and every series a distinct label');
  const over = (text: string, cap: number) => slackEmoji(text).length > cap;
  if (card.subtitle && over(card.subtitle, SLACK_MAX_TEXT))
    issues.push(`the Card subtitle is over ${SLACK_MAX_TEXT} characters, where Slack cuts it`);
  for (const child of children) {
    if (child.type === 'text' && over(child.content, child.style === 'bold' ? SLACK_MAX_TEXT - 2 : SLACK_MAX_TEXT))
      issues.push(`a Text element is over ${SLACK_MAX_TEXT} characters, where Slack cuts it; split it`);
    if (child.type === 'fields')
      for (const field of child.children)
        if (slackEmoji(field.label).length + slackEmoji(field.value).length > SLACK_MAX_FIELD - 3)
          issues.push(
            `the Field "${field.label.slice(0, 40)}" is over ${SLACK_MAX_FIELD} characters, where Slack cuts it`,
          );
    if (child.type === 'actions') {
      if (child.children.length > SLACK_MAX_ACTIONS)
        issues.push(`an Actions element holds ${child.children.length} buttons and Slack takes ${SLACK_MAX_ACTIONS}`);
      for (const button of child.children)
        if (button.type === 'link-button' && button.url.length > SLACK_MAX_URL)
          issues.push(`a LinkButton URL is over ${SLACK_MAX_URL} characters, which Slack refuses`);
    }
  }
  return issues;
}

const codeBlock = (text: string) => `\`\`\`\n${text}\n\`\`\``;

/**
 * Discord markdown has no tables, so a Table or Chart goes out as a monospaced text table in a code block, which keeps
 * its columns lined up; the adapter's own rendering is GFM pipe syntax, which Discord shows as written. A Section is
 * spread into the card, because the adapter's V2 Section puts all its text ahead of its other children.
 */
function discordChildren(children: CardChild[]): CardChild[] {
  return children.flatMap((child): CardChild[] => {
    if (child.type === 'section') return discordChildren(child.children);
    if (child.type === 'table') {
      const table = codeBlock(tableElementToAscii(child.headers, child.rows));
      return [{ type: 'text', content: child.caption ? `*${child.caption}*\n${table}` : table }];
    }
    if (child.type === 'chart') {
      const table = chartElementToFallbackText(child).slice(child.title.length + 1);
      return [{ type: 'text', content: `**${child.title}**\n${codeBlock(table)}` }];
    }
    return [child];
  });
}

/**
 * The Components V2 message an agent card posts as on Discord. A client can hide embeds and still show components, and
 * an embed card there showed only its buttons. Throws the adapter's ValidationError past Discord's 40-component or
 * 4,000-character caps.
 */
type V2Component = {
  type: number;
  components?: V2Component[];
  content?: string;
  description?: string;
  items?: Array<{ description?: string }>;
  label?: string;
  url?: string;
  accessory?: V2Component;
};

export function discordCardPayload(card: CardElement): { flags: number; components: V2Component[] } {
  return cardToDiscordPayload(
    { ...card, children: discordChildren(card.children) },
    { contentFormat: DiscordContentFormat.ComponentsV2 },
  ) as { flags: number; components: V2Component[] };
}

/**
 * Discord's text table shows a repeated Chart category with its first value twice and never shows a yLabel. A line
 * break in a cell or chart label breaks the table's columns, and a code fence in one ends the code block it is drawn in.
 */
function discordLosses(card: CardElement): string[] {
  const children = flatten(card.children);
  const issues: string[] = [];
  const cells = children.flatMap((child) => {
    if (child.type === 'table') return [child.headers, ...child.rows].flat();
    if (child.type !== 'chart') return [];
    const { chart } = child;
    if (chart.type === 'pie') return chart.segments.map((segment) => segment.label);
    return [chart.xLabel ?? '', ...chart.categories, ...chart.series.map((series) => series.name)];
  });
  if (cells.some((cell) => /[\r\n]/.test(cell)))
    issues.push(
      'Discord shows a Table or Chart as text, where a line break in a header or cell breaks its columns; put that content in a Text',
    );
  if (cells.some((cell) => cell.includes('```')))
    issues.push(
      'Discord shows a Table or Chart in a code block, which a ``` in a header or cell would end; put that content in a Text',
    );
  const axisCharts = children.flatMap((child) =>
    child.type === 'chart' && child.chart.type !== 'pie' ? [child.chart] : [],
  );
  if (axisCharts.some((chart) => new Set(chart.categories).size < chart.categories.length))
    issues.push(
      'Discord shows a Chart with repeated categories with the wrong values; give every category a distinct label',
    );
  if (axisCharts.some((chart) => chart.yLabel))
    issues.push('Discord does not show a Chart yLabel; put the unit in the Chart title or a series name');
  return issues;
}

// Discord refuses a message with a link button or image description past these; the adapter checks the component
// and text caps itself.
const DISCORD_MAX_LABEL = 80;
const DISCORD_MAX_URL = 512;
const DISCORD_MAX_MEDIA_DESCRIPTION = 1024;

function discordRefusals(card: CardElement): string[] {
  let payload: { components: V2Component[] };
  try {
    payload = discordCardPayload(card);
  } catch (err) {
    if (err instanceof ValidationError) return [err.message];
    throw err;
  }
  const all = (components: V2Component[]): V2Component[] =>
    components.flatMap((c) => [c, ...all(c.components ?? []), ...(c.accessory ? [c.accessory] : [])]);
  const buttons = all(payload.components).filter((c) => c.url !== undefined || c.label !== undefined);
  const issues: string[] = [];
  const descriptions = all(payload.components).flatMap((c) => [
    c.description,
    ...(c.items ?? []).map((i) => i.description),
  ]);
  if (descriptions.some((description) => (description ?? '').length > DISCORD_MAX_MEDIA_DESCRIPTION))
    issues.push(`an Image alt is over ${DISCORD_MAX_MEDIA_DESCRIPTION} characters, which Discord refuses`);
  if (buttons.some((button) => (button.label ?? '').length > DISCORD_MAX_LABEL))
    issues.push(`a LinkButton label is over ${DISCORD_MAX_LABEL} characters, which Discord refuses`);
  if (buttons.some((button) => (button.url ?? '').length > DISCORD_MAX_URL))
    issues.push(`a LinkButton URL is over ${DISCORD_MAX_URL} characters, which Discord refuses`);
  return issues;
}

/** json-render turns an inner Card into a Section and keeps only its text, so its image would vanish. */
function nestedCards(spec: Spec): string[] {
  return Object.entries(spec.elements ?? {})
    .filter(([key, element]) => key !== spec.root && element?.type === 'Card')
    .map(([key]) => `${key}: only the root may be a Card; group with Section`);
}

export { CardSpecError };

export function renderCardSpec(spec: unknown, channelType: string): CardElement {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new CardSpecError(['spec must be an object']);
  const nested = nestedCards(spec as Spec);
  if (nested.length) throw new CardSpecError(nested);
  const card = toCard(spec as Spec, { components, limits: limitsFor(channelType) });
  const losses = isSlack(channelType)
    ? slackLosses(card)
    : isDiscord(channelType)
      ? [...discordLosses(card), ...discordRefusals(card)]
      : [];
  if (losses.length) throw new CardSpecError(losses);
  return card;
}

export function checkCardContent(
  content: Record<string, unknown>,
  channelType: string,
): { card: CardElement; fallbackText: string } | { issues: string[] } {
  const fallbackText = typeof content.fallbackText === 'string' ? content.fallbackText.trim() : '';
  const issues = fallbackText ? [] : ['fallbackText is required'];
  try {
    const card = renderCardSpec(content.spec, channelType);
    return issues.length ? { issues } : { card, fallbackText };
  } catch (err) {
    if (err instanceof CardSpecError) return { issues: [...issues, ...err.issues] };
    throw err;
  }
}

export function isAgentCardContent(content: Record<string, unknown> | null | undefined): boolean {
  return content?.type === 'card';
}

const SLACK_LIMIT_NOTES = [
  `Slack: at most ${SLACK_LIMITS.tables} Table, ${SLACK_LIMITS.charts} Charts and ${SLACK_LIMITS.fields} Fields per Fields element`,
  `${SLACK_LIMITS.tableRows} rows including the header and ${SLACK_LIMITS.tableColumns} columns per Table`,
  `${SLACK_LIMITS.chartPoints} categories, ${SLACK_LIMITS.chartSeries} series or segments, ${SLACK_LIMITS.chartLabel}-character labels and a ${SLACK_LIMITS.chartTitle}-character title per Chart`,
  `${SLACK_MAX_BLOCKS} blocks per card, ${SLACK_MAX_ACTIONS} LinkButtons per Actions, and ${SLACK_MAX_TEXT} characters per Text.`,
  'Discord: at most 4,000 characters of text, tables and charts included, and 40 components per card.',
].join(', ');

const DISPLAY_RULES: Record<string, string> = {
  'Pick components by the shape of the data: Fields for a few key numbers, Table for row data, Chart for a trend or a share of a whole, Actions for next steps.':
    'Pick components by the shape of the data: Fields for a few key numbers, Table for row data, Chart for a trend or a share of a whole, Actions for links.',
  'Text content uses markdown: **bold**, _italic_, `code` and [label](https://url). Do not use headings inside Text.':
    'Text content uses markdown: **bold**, _italic_ and `code`. Do not use headings inside Text. Put a link in an Actions row as a LinkButton: Slack shows a [label](url) link inside Text as written.',
  'Field elements MUST be children of a Fields element. Button and LinkButton elements MUST be children of an Actions element.':
    'Field elements MUST be children of a Fields element. LinkButton elements MUST be children of an Actions element.',
};

function cardGuide(context: PromptContext): string {
  const defs = (
    context.catalog as { components: Record<string, { props: never; slots?: string[]; description: string }> }
  ).components;
  const lines = [
    'Post a card to the current conversation: a native Slack or Discord message with a header, fields, tables, charts and links. Use it for structured results such as tables, metrics, status and comparisons, not for ordinary conversation.',
    'It returns once the host has posted the card. If the spec breaks a rule below, nothing is posted and the result lists every problem; fix them and call again.',
    '',
    'spec: { "root": "<key>", "elements": { "<key>": { "type": "<component>", "props": { ... }, "children": ["<key>", ...] } } }',
    '',
    'Components:',
    ...Object.entries(defs).map(([name, def]) => {
      const children = def.slots?.includes('default') ? ' [accepts children]' : '';
      return `- ${name}: ${context.formatZodType(def.props)} - ${def.description}${children}`;
    }),
    '',
    'Rules:',
    ...(schema.defaultRules ?? []).map((rule) => `- ${DISPLAY_RULES[rule] ?? rule}`),
    `- ${SLACK_LIMIT_NOTES}`,
    '',
    'fallbackText (required): the same content as plain text. Search, thread history, the mobile app and the terminal show it; Slack and Discord show the card.',
  ];
  return lines.join('\n');
}

export function renderCardGuideModule(): string {
  const unmatched = Object.keys(DISPLAY_RULES).filter((rule) => !(schema.defaultRules ?? []).includes(rule));
  if (unmatched.length) throw new Error(`json-render rules changed; update DISPLAY_RULES: ${unmatched.join(' | ')}`);
  const guide = defineCatalog({ ...schema, promptTemplate: cardGuide }, { components }).prompt();
  return [
    '// Generated from src/channels/card-spec.ts by `pnpm card-guide:generate`. Do not edit.',
    `export const CARD_SPEC_GUIDE = ${JSON.stringify(guide)};`,
    '',
  ].join('\n');
}
