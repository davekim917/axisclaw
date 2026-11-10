import { describe, expect, it } from 'vitest';

import type { Adapter } from 'chat';

import { createChatSdkBridge } from './channels/chat-sdk-bridge.js';
import { renderDiscordSubtext } from './channels/discord.js';
import { applySlackSubtext } from './channels/slack-subtext.js';
import {
  attachSourcesFooter,
  buildSourcesFooter,
  renderSourcesFooter,
  scopedLookerOrigin,
  type SourcesFooterContext,
} from './sources-footer.js';

const ORIGIN = 'https://acme.looker.example';
const ctx: SourcesFooterContext = { lookerOrigin: ORIGIN, timezone: 'America/New_York' };
const LAST_CALL = 'last call Nov 3, 2026, 9:02 AM EST';

const payload = {
  version: 1,
  systems: [
    {
      system: 'looker',
      origin: ORIGIN,
      calls: 3,
      lastAt: '2026-11-03T14:01:00.000Z',
      objects: [{ kind: 'explore', model: 'sales', explore: 'orders' }],
    },
    {
      system: 'snowflake',
      calls: 1,
      lastAt: '2026-11-03T14:02:00.000Z',
      objects: [{ kind: 'table', name: 'ANALYTICS.FCT_ORDERS' }],
    },
    {
      system: 'sheets',
      calls: 2,
      lastAt: '2026-11-03T13:00:00.000Z',
      objects: [{ kind: 'range', spreadsheetId: 'SHEET_ID_1234', range: 'Summary!A2:F90' }],
    },
  ],
};

describe('buildSourcesFooter + renderSourcesFooter', () => {
  it('renders one labelled line with links built from host config', () => {
    const segments = buildSourcesFooter(payload, ctx)!;
    expect(renderSourcesFooter(segments, undefined)).toBe(
      `Data read (recorded) · Looker: sales/orders (3 queries) · Snowflake: ANALYTICS.FCT_ORDERS (1 query) · Sheets: Summary (2 reads) · ${LAST_CALL}`,
    );
    expect(renderSourcesFooter(segments, 'slack-mrkdwn')).toBe(
      `Data read (recorded) · Looker: <${ORIGIN}/explore/sales/orders|sales/orders> (3 queries) · Snowflake: ANALYTICS.FCT_ORDERS (1 query) · Sheets: <https://docs.google.com/spreadsheets/d/SHEET_ID_1234/edit|Summary> (2 reads) · ${LAST_CALL}`,
    );
    expect(renderSourcesFooter(segments, 'discord-markdown')).toBe(
      `Data read \\(recorded\\) · Looker: [sales/orders](<${ORIGIN}/explore/sales/orders>) \\(3 queries\\) · Snowflake: ANALYTICS.FCT\\_ORDERS \\(1 query\\) · Sheets: [Summary](<https://docs.google.com/spreadsheets/d/SHEET_ID_1234/edit>) \\(2 reads\\) · ${LAST_CALL.replace(/[(),]/g, (c) => (c === ',' ? c : `\\${c}`))}`,
    );
  });

  it('shows nothing of a Looker instance that is not the group own', () => {
    for (const lookerOrigin of [null, 'https://other.looker.example']) {
      const line = renderSourcesFooter(buildSourcesFooter(payload, { ...ctx, lookerOrigin })!, 'slack-mrkdwn');
      expect(line).not.toContain('Looker');
      expect(line).not.toContain('sales/orders');
      expect(line).toContain('Snowflake: ANALYTICS.FCT_ORDERS');
    }
    const unstamped = { version: 1, systems: [{ ...payload.systems[0], origin: undefined }] };
    expect(buildSourcesFooter(unstamped, ctx)).toBeNull();
  });

  it("sheds names one at a time, keeping each system's first, when the line is too long for small print", () => {
    const explores = Array.from({ length: 5 }, (_, i) => ({
      kind: 'explore',
      model: 'sales',
      explore: `e${i}${'y'.repeat(60)}`,
    }));
    const tables = Array.from({ length: 5 }, (_, i) => ({ kind: 'table', name: `WH.MART.T${i}${'Z'.repeat(60)}` }));
    const footer = buildSourcesFooter(
      {
        version: 1,
        systems: [
          { system: 'looker', origin: ORIGIN, calls: 5, lastAt: payload.systems[0].lastAt, objects: explores },
          { system: 'snowflake', calls: 9, lastAt: payload.systems[0].lastAt, objects: tables },
        ],
      },
      ctx,
    )!;
    for (const markup of ['slack-mrkdwn', 'discord-markdown', undefined] as const) {
      const line = renderSourcesFooter(footer, markup);
      expect(renderSourcesFooter(footer, undefined).length).toBeLessThanOrEqual(300);
      expect(line.length).toBeLessThanOrEqual(1000);
      expect(line).toContain(`e0${'y'.repeat(60)}`);
      expect(line).toContain(`T0${'Z'.repeat(60)}`);
      expect(line).toMatch(/\+\d more/);
      expect(line).toContain('5 queries');
      expect(line).toContain('9 queries');
    }
  });

  it('falls back to systems and counts only when not even one name per system fits', () => {
    const big = (i: number) => ({ kind: 'table', name: `${String(i).repeat(110)}.T` });
    const footer = buildSourcesFooter(
      {
        version: 1,
        systems: [
          {
            system: 'looker',
            origin: ORIGIN,
            calls: 1,
            objects: [{ kind: 'explore', model: 'm'.repeat(100), explore: 'e'.repeat(100) }],
          },
          { system: 'snowflake', calls: 2, objects: [big(1), big(2), big(3)] },
          {
            system: 'sheets',
            calls: 3,
            objects: [{ kind: 'range', spreadsheetId: 'SHEET_ID_1234', range: `'${'t'.repeat(110)}'!A1` }],
          },
        ],
      },
      ctx,
    )!;
    const line = renderSourcesFooter(footer, 'discord-markdown');
    expect(renderSourcesFooter(footer, undefined).length).toBeLessThanOrEqual(300);
    expect(line.length).toBeLessThanOrEqual(1000);
    for (const count of ['1 query', '2 queries', '3 reads']) expect(line).toContain(count);
  });

  it('names each spreadsheet once, by the tabs it read, with one link', () => {
    const range = (spreadsheetId: string, r: string) => ({ kind: 'range', spreadsheetId, range: r });
    const footer = buildSourcesFooter(
      {
        version: 1,
        systems: [
          {
            system: 'sheets',
            calls: 10,
            objects: [
              range('SHEET_ID_1111', "'Direct Plan'!A1:B2"),
              range('SHEET_ID_1111', 'Direct Plan!C1'),
              range('SHEET_ID_1111', "'Summary'"),
              range('SHEET_ID_1111', 'Summary!A1:B2'),
              range('SHEET_ID_1111', "'Owner''s Notes'!A1"),
              range('SHEET_ID_1111', 'A1:B2'),
              range('SHEET_ID_1111', 'Revenue_Data'),
              range('SHEET_ID_1111', "'Ops! FY'"),
              range('SHEET_ID_2222', 'A1:B2'),
              range('SHEET_ID_2222', 'Expense_Data'),
            ],
          },
        ],
      },
      ctx,
    )!;
    expect(footer.systems[0].objects).toEqual([
      { text: 'Direct Plan, Summary +2 tabs', url: 'https://docs.google.com/spreadsheets/d/SHEET_ID_1111/edit' },
      { text: 'sheet', url: 'https://docs.google.com/spreadsheets/d/SHEET_ID_2222/edit' },
    ]);
  });

  it('renders a reply that read many tables and tabs as one readable line, names kept', () => {
    const tabs = ['Plan', 'Summary', 'How it works', 'Notes', 'Changes', 'Daily Avg', 'Retail', 'Search', 'Links'];
    const ranges = Array.from({ length: 42 }, (_, i) => ({
      kind: 'range',
      spreadsheetId: 'SHEET_ID_1234',
      range: `'${tabs[i % tabs.length]}'!A${i + 1}:Q${i + 9}`,
    }));
    const footer = buildSourcesFooter(
      {
        version: 1,
        systems: [
          {
            system: 'looker',
            origin: ORIGIN,
            calls: 1,
            lastAt: '2026-11-04T00:29:57.664Z',
            objects: [{ kind: 'explore', model: 'marketing', explore: 'channel_performance' }],
          },
          {
            system: 'snowflake',
            calls: 27,
            lastAt: '2026-11-04T00:58:37.074Z',
            objects: [
              'WAREHOUSE.MARKETING.ACQUISITION_CHANNEL_PERFORMANCE',
              'WAREHOUSE.MARKETING.ACQUISITION_NC_MAPPED_CHANNEL',
              'WAREHOUSE.CORE.ORDERS',
              'warehouse.marketing.int_first_order_attribution',
            ].map((name) => ({ kind: 'table', name })),
          },
          { system: 'sheets', calls: 51, lastAt: '2026-11-04T00:59:50.059Z', objects: ranges },
        ],
      },
      ctx,
    )!;
    expect(renderSourcesFooter(footer, undefined)).toBe(
      'Data read (recorded) · Looker: marketing/channel_performance (1 query) · Snowflake: WAREHOUSE.MARKETING.ACQUISITION_CHANNEL_PERFORMANCE, WAREHOUSE.MARKETING.ACQUISITION_NC_MAPPED_CHANNEL, +2 more (27 queries) · Sheets: Plan, Summary +7 tabs (51 reads) · last call Nov 3, 2026, 7:59 PM EST',
    );
    expect(renderSourcesFooter(footer, 'discord-markdown').length).toBeLessThanOrEqual(1000);
  });

  it('caps the objects per system and says how many it left out', () => {
    const objects = Array.from({ length: 8 }, (_, i) => ({ kind: 'table', name: `S.T${i}` }));
    const line = renderSourcesFooter(
      buildSourcesFooter(
        { version: 1, systems: [{ system: 'snowflake', calls: 8, lastAt: payload.systems[0].lastAt, objects }] },
        ctx,
      )!,
      undefined,
    );
    expect(line).toContain('Snowflake: S.T0, S.T1, S.T2, S.T3, S.T4, +3 more (8 queries)');
  });

  it.each([
    ['no payload', undefined],
    ['wrong version', { version: 2, systems: payload.systems }],
    ['unknown system only', { version: 1, systems: [{ system: 'bigquery', calls: 1, objects: [] }] }],
    ['zero calls', { version: 1, systems: [{ system: 'looker', calls: 0, objects: [] }] }],
    ['fractional calls', { version: 1, systems: [{ system: 'looker', calls: 1.5, objects: [] }] }],
  ])('renders nothing for %s', (_name, value) => {
    expect(buildSourcesFooter(value, ctx)).toBeNull();
  });

  it('drops objects whose text could break the link syntax or point elsewhere', () => {
    const segments = buildSourcesFooter(
      {
        version: 1,
        systems: [
          {
            system: 'looker',
            calls: 1,
            origin: ORIGIN,
            objects: [
              { kind: 'explore', model: 'm', explore: 'e/../../evil' },
              { kind: 'explore', model: 'm', explore: 'ok' },
            ],
          },
          { system: 'snowflake', calls: 1, objects: [{ kind: 'table', name: 'x|<https://evil.example|click>' }] },
          { system: 'sheets', calls: 1, objects: [{ kind: 'range', spreadsheetId: '../../evil', range: 'A1' }] },
        ],
      },
      ctx,
    )!;
    const line = renderSourcesFooter(segments, 'slack-mrkdwn');
    expect(line).toBe(
      `Data read (recorded) · Looker: <${ORIGIN}/explore/m/ok|m/ok> (1 query) · Snowflake (1 query) · Sheets (1 read)`,
    );
  });

  it('names Postgres tables by their database, with no link, escaped per platform', () => {
    const segments = buildSourcesFooter(
      {
        version: 1,
        systems: [
          {
            system: 'postgres',
            calls: 2,
            objects: [
              { kind: 'table', database: 'app_dev', name: 'public.order_lines' },
              { kind: 'table', name: 'public.events' },
              { kind: 'database', name: 'reporting' },
            ],
          },
        ],
      },
      ctx,
    )!;
    expect(renderSourcesFooter(segments, 'slack-mrkdwn')).toBe(
      'Data read (recorded) · Postgres: app_dev.public.order_lines, public.events, reporting (2 queries)',
    );
    expect(renderSourcesFooter(segments, 'discord-markdown')).toBe(
      'Data read \\(recorded\\) · Postgres: app\\_dev.public.order\\_lines, public.events, reporting \\(2 queries\\)',
    );
  });

  it('refuses a Postgres database that is anything but a plain name, so no connection detail can be shown', () => {
    const secrets = [
      'zz_reader:Pw9xQ7tr@fixture.pghost.example',
      'postgres://zz_reader@fixture.pghost.example/app_dev',
    ];
    const segments = buildSourcesFooter(
      {
        version: 1,
        systems: [
          {
            system: 'postgres',
            calls: 1,
            objects: [
              { kind: 'table', database: secrets[0], name: 'public.orders' },
              { kind: 'database', name: secrets[1] },
              { kind: 'database', name: 'host=fixture.pghost.example password=Pw9xQ7tr' },
            ],
          },
        ],
      },
      ctx,
    )!;
    expect(renderSourcesFooter(segments, 'slack-mrkdwn')).toBe('Data read (recorded) · Postgres (1 query)');
  });
});

describe('Looker query links', () => {
  const lookerFooter = (objects: unknown[]) =>
    buildSourcesFooter(
      { version: 1, systems: [{ system: 'looker', origin: ORIGIN, calls: objects.length, objects }] },
      ctx,
    )!;
  const explore = (query?: Record<string, unknown>) => ({
    kind: 'explore',
    model: 'acme_sales',
    explore: 'orders',
    ...(query ? { query } : {}),
  });
  const EXPLORE_URL = `${ORIGIN}/explore/acme_sales/orders`;
  const QUERY = {
    fields: ['orders.region', 'orders.total_revenue'],
    filters: { 'orders.city': `'Santa Cruz, CA',"Main" 100%`, 'orders.created_date': '7 days' },
    sorts: ['orders.total_revenue desc'],
    limit: 50,
  };
  const QUERY_URL =
    `${EXPLORE_URL}?fields=orders.region,orders.total_revenue` +
    `&f%5Borders.city%5D=%27Santa%20Cruz%2C%20CA%27%2C%22Main%22%20100%25` +
    `&f%5Borders.created_date%5D=7%20days&sorts=orders.total_revenue%20desc&limit=50`;

  it('links one query to its expanded Explore URL, which reads back as the exact query', () => {
    const footer = lookerFooter([explore(QUERY)]);
    expect(renderSourcesFooter(footer, 'slack-mrkdwn')).toBe(
      `Data read (recorded) · Looker: <${QUERY_URL}|acme_sales/orders> (1 query)`,
    );
    expect(renderSourcesFooter(footer, 'discord-markdown')).toBe(
      `Data read \\(recorded\\) · Looker: [acme\\_sales/orders](<${QUERY_URL}>) \\(1 query\\)`,
    );
    const params = new URL(QUERY_URL).searchParams;
    expect(params.get('fields')).toBe(QUERY.fields.join(','));
    expect(params.get('f[orders.city]')).toBe(QUERY.filters['orders.city']);
    expect(params.get('f[orders.created_date]')).toBe('7 days');
    expect(params.get('sorts')).toBe('orders.total_revenue desc');
    expect(params.get('limit')).toBe('50');
  });

  it('drops one pair of outer quotes from a filter value, as the Looker MCP does before it queries', () => {
    const footer = lookerFooter([explore({ fields: ['orders.city'], filters: { 'orders.city': `"Santa Cruz, CA"` } })]);
    const url = /<([^|]+)\|/.exec(renderSourcesFooter(footer, 'slack-mrkdwn'))![1];
    expect(new URL(url).searchParams.get('f[orders.city]')).toBe('Santa Cruz, CA');
  });

  it('carries pivots, the query timezone and custom fields', () => {
    const dynamic = [{ table_calculation: 'share', label: 'Share', expression: '${orders.total_revenue} / 2' }];
    const footer = lookerFooter([
      explore({ ...QUERY, pivots: ['orders.region'], tz: 'America/Los_Angeles', dynamic_fields: dynamic }),
    ]);
    const url = /<([^|]+)\|/.exec(renderSourcesFooter(footer, 'slack-mrkdwn'))![1];
    const params = new URL(url).searchParams;
    expect(params.get('pivots')).toBe('orders.region');
    expect(params.get('query_timezone')).toBe('America/Los_Angeles');
    expect(JSON.parse(params.get('dynamic_fields')!)).toEqual(dynamic);
  });

  it('numbers two queries on one Explore, each linked to its own query', () => {
    const other = { ...QUERY, limit: 10 };
    const footer = lookerFooter([explore(QUERY), explore(other)]);
    const otherUrl = QUERY_URL.replace('limit=50', 'limit=10');
    expect(renderSourcesFooter(footer, 'slack-mrkdwn')).toBe(
      `Data read (recorded) · Looker: acme_sales/orders (<${QUERY_URL}|q1>, <${otherUrl}|q2>) (2 queries)`,
    );
    expect(renderSourcesFooter(footer, 'discord-markdown')).toBe(
      `Data read \\(recorded\\) · Looker: acme\\_sales/orders \\([q1](<${QUERY_URL}>), [q2](<${otherUrl}>)\\) \\(2 queries\\)`,
    );
    expect(renderSourcesFooter(footer, undefined)).toBe(
      'Data read (recorded) · Looker: acme_sales/orders (q1, q2) (2 queries)',
    );
  });

  it('links the same query run twice once', () => {
    const footer = lookerFooter([explore(QUERY), explore({ ...QUERY })]);
    expect(renderSourcesFooter(footer, 'slack-mrkdwn')).toBe(
      `Data read (recorded) · Looker: <${QUERY_URL}|acme_sales/orders> (2 queries)`,
    );
  });

  it('links a query too long for the line to its Explore, marked, never a cut URL', () => {
    const long = { ...QUERY, filters: { 'orders.city': 'x'.repeat(1200) } };
    const footer = lookerFooter([explore(long)]);
    for (const markup of ['slack-mrkdwn', 'discord-markdown'] as const) {
      const line = renderSourcesFooter(footer, markup);
      expect(line).toContain(EXPLORE_URL);
      expect(line).not.toContain('x'.repeat(10));
      expect(line).toContain('Explore only');
    }
  });

  it('swaps query links for Explore links, longest first, when together they overflow the line', () => {
    const sized = (n: number, length: number) => ({ ...QUERY, filters: { 'orders.city': String(n).repeat(length) } });
    const footer = lookerFooter([explore(sized(1, 150)), explore(sized(2, 200)), explore(sized(3, 400))]);
    const line = renderSourcesFooter(footer, 'slack-mrkdwn');
    expect(line.length).toBeLessThanOrEqual(1000);
    expect(line).toContain('1'.repeat(150));
    expect(line).toContain('2'.repeat(200));
    expect(line).not.toContain('3'.repeat(10));
    expect(line).toContain(`<${EXPLORE_URL}|q3 Explore only>`);
  });

  it('links an object from a runner without query definitions to its Explore, unmarked', () => {
    expect(renderSourcesFooter(lookerFooter([explore()]), 'slack-mrkdwn')).toBe(
      `Data read (recorded) · Looker: <${EXPLORE_URL}|acme_sales/orders> (1 query)`,
    );
  });

  it.each([
    ['a field that is not a LookML name', { ...QUERY, fields: ['orders.region&f[x]=1'] }],
    ['a filter on a field that is not a LookML name', { ...QUERY, filters: { 'a.b]=1&c[': 'x' } }],
    ['a filter value that is not text', { ...QUERY, filters: { 'orders.city': ['x'] } }],
    ['a custom filter, which no documented URL parameter carries', { ...QUERY, filter_expression: '${a.b} > 1' }],
    ['an argument the URL cannot carry', { ...QUERY, vis_config: { type: 'looker_bar' } }],
    ['no fields', { filters: QUERY.filters }],
    ['a malformed sort', { ...QUERY, sorts: ['orders.total_revenue; drop'] }],
    ['a non-numeric limit', { ...QUERY, limit: '50&x=1' }],
    ['a query whose time zone the runner could not know', { ...QUERY, tz_unknown: true }],
    ['an empty time zone, which no URL parameter states', { ...QUERY, tz: '' }],
    ['an unlimited read, more rows than an Explore shows', { ...QUERY, limit: -1 }],
    ['a read past the Explore row cap', { ...QUERY, limit: 5001 }],
    ['a filter value no URL can encode', { ...QUERY, filters: { 'orders.city': '\ud800' } }],
  ])('links the Explore, marked, for %s', (_name, query) => {
    const line = renderSourcesFooter(lookerFooter([explore(query)]), 'slack-mrkdwn');
    expect(line).toBe(`Data read (recorded) · Looker: <${EXPLORE_URL}|acme_sales/orders (Explore only)> (1 query)`);
  });

  it('never builds a link to another origin', () => {
    for (const fields of [['@evil.example'], ['//evil.example']]) {
      const line = renderSourcesFooter(lookerFooter([explore({ fields })]), 'slack-mrkdwn');
      for (const url of line.matchAll(/<([^|>]+)\|/g)) expect(new URL(url[1]).origin).toBe(ORIGIN);
    }
  });
});

describe('scopedLookerOrigin', () => {
  it('reads only the folder-scoped variable, never the bare one', () => {
    expect(scopedLookerOrigin('acme-corp', { LOOKER_BASE_URL_ACME_CORP: `${ORIGIN}/` })).toBe(ORIGIN);
    expect(scopedLookerOrigin('acme-corp', { LOOKER_BASE_URL: 'https://other.looker.example' })).toBeNull();
  });

  it('refuses anything but a bare https origin', () => {
    const withCredentials = Object.assign(new URL('https://a.example'), { username: 'u', password: 'p' }).href;
    for (const raw of ['http://a.example', withCredentials, 'https://a.example/path', 'not a url']) {
      expect(scopedLookerOrigin('acme', { LOOKER_BASE_URL_ACME: raw })).toBeNull();
    }
  });
});

describe('attachSourcesFooter', () => {
  const context = async () => ctx;

  it('returns content without sources byte-identical', async () => {
    const content = JSON.stringify({ text: 'hi', subtext: 'opus-5' });
    expect(await attachSourcesFooter(content, context)).toBe(content);
  });

  it('replaces the container sources with the host-built footer', async () => {
    const out = JSON.parse(await attachSourcesFooter(JSON.stringify({ text: 'hi', sources: payload }), context));
    expect(out.sources).toBeUndefined();
    expect(out.sourcesFooter.systems.map((sys: { name: string }) => sys.name)).toEqual([
      'Looker',
      'Snowflake',
      'Sheets',
    ]);
  });

  it('delivers the answer without a footer when the footer cannot be built', async () => {
    const content = JSON.stringify({ text: 'hi', sources: payload });
    const out = await attachSourcesFooter(content, async () => {
      throw new Error('container.json unreadable');
    });
    expect(JSON.parse(out)).toEqual({ text: 'hi' });
  });

  it('drops a sourcesFooter the payload arrived with', async () => {
    const forged = JSON.stringify({ text: 'hi', sourcesFooter: [{ text: 'Sources', url: 'https://evil.example' }] });
    expect(JSON.parse(await attachSourcesFooter(forged, context))).toEqual({ text: 'hi' });
  });
});

describe('bridge rendering', () => {
  function bridgeWith(markup: 'slack-mrkdwn' | 'discord-markdown', render: 'slack' | 'discord') {
    const posts: Array<Record<string, unknown>> = [];
    const adapter = {
      name: 'stub',
      channelIdFromThreadId: (t: string) => t,
      postMessage: async (threadId: string, body: Record<string, unknown>) => {
        posts.push(body);
        return { id: `m${posts.length}`, threadId, raw: {} };
      },
    } as unknown as Adapter;
    const bridge = createChatSdkBridge({
      adapter,
      supportsThreads: true,
      maxTextLength: 2000,
      subtextMarkup: markup,
      renderSubtext: render === 'slack' ? (body, subtext) => ({ ...body, subtext }) : renderDiscordSubtext,
    });
    return { bridge, posts };
  }

  const segments = buildSourcesFooter(payload, ctx)!;

  it('puts the sources line under the status subtext in one Slack context block', async () => {
    const { bridge, posts } = bridgeWith('slack-mrkdwn', 'slack');
    await bridge.deliver('t', null, {
      kind: 'chat',
      content: { text: 'All set.', subtext: 'opus-5 · high', sourcesFooter: segments },
    });
    const subtext = posts[0].subtext as string;
    expect(subtext.split('\n')).toEqual(['opus-5 · high', renderSourcesFooter(segments, 'slack-mrkdwn')]);
    const blocks = applySlackSubtext({ channel: 'C', markdown_text: 'All set.' }, subtext).blocks as unknown[];
    expect(blocks[1]).toEqual({ type: 'context', elements: [{ type: 'mrkdwn', text: subtext }] });
  });

  it('renders the sources even when the group turned the status subtext off', async () => {
    const { bridge, posts } = bridgeWith('slack-mrkdwn', 'slack');
    await bridge.deliver('t', null, { kind: 'chat', content: { text: 'All set.', sourcesFooter: segments } });
    expect(posts[0].subtext).toBe(renderSourcesFooter(segments, 'slack-mrkdwn'));
  });

  it('gives each Discord small-print line its own prefix, on the last chunk only', async () => {
    const { bridge, posts } = bridgeWith('discord-markdown', 'discord');
    const long = `${'a'.repeat(1500)}\n\n${'b'.repeat(1500)}`;
    await bridge.deliver('t', null, {
      kind: 'chat',
      content: { text: long, subtext: 'opus-5 · high', sourcesFooter: segments },
    });
    expect(posts.length).toBeGreaterThan(1);
    expect(String(posts[0].markdown)).not.toContain('-#');
    const last = String(posts.at(-1)!.markdown).split('\n');
    expect(last.slice(-2)).toEqual(['-# opus-5 · high', `-# ${renderSourcesFooter(segments, 'discord-markdown')}`]);
    for (const p of posts) expect(String(p.markdown).length).toBeLessThanOrEqual(2000);
  });

  it('keeps the sources line when an answer is edited in place', async () => {
    const edits: Array<Record<string, unknown>> = [];
    const adapter = {
      name: 'stub',
      channelIdFromThreadId: (t: string) => t,
      postMessage: async () => ({ id: 'm1', threadId: 't', raw: {} }),
      editMessage: async (threadId: string, id: string, body: Record<string, unknown>) => {
        edits.push(body);
        return { id, threadId, raw: {} };
      },
    } as unknown as Adapter;
    const bridge = createChatSdkBridge({
      adapter,
      supportsThreads: true,
      subtextMarkup: 'slack-mrkdwn',
      renderSubtext: (body, subtext) => ({ ...body, subtext }),
    });
    await bridge.deliver('t', null, {
      kind: 'chat',
      content: { operation: 'edit', messageId: 'm1', text: 'Updated.', sourcesFooter: segments },
    });
    expect(edits[0].subtext).toBe(renderSourcesFooter(segments, 'slack-mrkdwn'));
  });

  it('renders no sources line on a status bubble', async () => {
    const { bridge, posts } = bridgeWith('slack-mrkdwn', 'slack');
    await bridge.deliver('t', null, { kind: 'status', content: { text: 'working', sourcesFooter: segments } });
    expect(posts[0].subtext).toBeUndefined();
  });
});
