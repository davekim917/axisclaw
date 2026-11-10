/**
 * The "Data read (recorded)" line under a data reply. The container sends what it recorded (`content.sources`); this
 * module validates it, builds every link from host config alone and hands the bridge a platform-neutral footer
 * (`content.sourcesFooter`). The label says "recorded" because the recorders do not see every path to a source (see
 * docs/sources-footer.md), so the line must never read as a complete list.
 */
import { readContainerConfig, resolveGroupTimezone } from './container-config.js';
import { getAgentGroup } from './db/agent-groups.js';
import { log } from './log.js';
import { formatLocalTime } from './timezone.js';

/** One Looker query run on an Explore: its exact URL, or none when only the Explore itself can be linked. */
interface QueryLink {
  url?: string;
}

interface FooterSegment {
  text: string;
  url?: string;
  /** Looker Explores only: each distinct query the turn ran on it, in the order first run. */
  queries?: QueryLink[];
}

interface FooterSystem {
  name: string;
  calls: number;
  unit: string;
  objects: FooterSegment[];
}

/** What the delivery door hands the bridge: validated, linked from host config, rendered per platform. */
export interface SourcesFooter {
  systems: FooterSystem[];
  lastCall: string | null;
}

export type SubtextMarkup = 'slack-mrkdwn' | 'discord-markdown';

export interface SourcesFooterContext {
  /** The group's own scoped Looker origin, or null: no Looker link is built without it. */
  lookerOrigin: string | null;
  timezone: string;
}

const LABEL = 'Data read (recorded)';
const MAX_OBJECTS_PER_SYSTEM = 5;
const MAX_TABS_SHOWN = 2;
/** Visible length (link text, not URLs or escapes) the line is shortened to, name by name: about one line of small print. */
const MAX_VISIBLE_LENGTH = 300;
/** Ceiling on the line as sent, links and escapes included; well inside every platform's cap. */
const MAX_MARKUP_LENGTH = 1000;
const MAX_CALLS = 100_000;

const SYSTEMS = {
  looker: { name: 'Looker', unit: ['query', 'queries'] },
  snowflake: { name: 'Snowflake', unit: ['query', 'queries'] },
  postgres: { name: 'Postgres', unit: ['query', 'queries'] },
  sheets: { name: 'Sheets', unit: ['read', 'reads'] },
} as const;
type SystemName = keyof typeof SYSTEMS;

const LOOKML_NAME_RE = /^[A-Za-z0-9_]{1,100}$/;
// A field as the query tool names it: `view.field`, or a bare name for a custom field or table calculation.
const LOOKML_FIELD = '[A-Za-z0-9_]{1,100}(?:\\.[A-Za-z0-9_]{1,100})?';
const LOOKML_FIELD_RE = new RegExp(`^${LOOKML_FIELD}$`);
const LOOKER_SORT_RE = new RegExp(`^${LOOKML_FIELD}(?: (?:asc|desc))?(?: [0-9]{1,3})?$`, 'i');
const LOOKER_LIMIT_RE = /^-?[0-9]{1,9}$/;
const LOOKER_EXPLORE_MAX_ROWS = 5000;
const LOOKER_TIMEZONE_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;
/** Marks a link that opens the Explore because the exact query could not be put in one. */
const EXPLORE_ONLY = 'Explore only';
const LOOKER_ID_RE = /^[A-Za-z0-9_:-]{1,100}$/;
const SHEET_ID_RE = /^[A-Za-z0-9_-]{10,100}$/;
// The runner names a database only in this shape; anything else (a host, a user, a connection string) is refused here too.
const PG_DATABASE_RE = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;
// Printable, single-line, and free of the characters either platform's link syntax would break on.
const SAFE_TEXT_RE = /^[^<>|[\]`]{1,120}$/;

function isSafeText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    SAFE_TEXT_RE.test(value) &&
    ![...value].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
  );
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Percent-encodes everything but unreserved characters, parentheses and quotes included, so no markup can end a link. */
function encodeQueryPart(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function fieldList(value: unknown, re: RegExp = LOOKML_FIELD_RE): string[] | null {
  return Array.isArray(value) && value.every((f) => typeof f === 'string' && re.test(f)) ? (value as string[]) : null;
}

/**
 * A filter value as the Looker MCP sends it on: it strips one pair of matching outer quotes, so `'a, b'` reaches
 * Looker as `a, b` (two values), and the link has to say the same.
 */
function lookerFilterValueSent(value: string): string {
  const first = value[0];
  return value.length >= 2 && (first === "'" || first === '"') && value[value.length - 1] === first
    ? value.slice(1, -1)
    : value;
}

/**
 * Looker's expanded Explore URL for the query a `query` call ran, or null when any part of it cannot be carried in
 * that URL exactly: a link that dropped a filter would show different data from what was read. The Looker MCP's
 * `filter_expression` (a custom filter) is one such part: no Looker document names its Explore URL parameter.
 */
function lookerQueryUrl(origin: string, model: string, explore: string, rawQuery: unknown): string | null {
  try {
    return buildLookerQueryUrl(origin, model, explore, rawQuery);
  } catch {
    // A lone surrogate in a filter value makes encodeURIComponent throw.
    return null;
  }
}

function buildLookerQueryUrl(origin: string, model: string, explore: string, rawQuery: unknown): string | null {
  const q = rec(rawQuery);
  if (!q) return null;
  const params: string[] = [];
  for (const key of Object.keys(q)) {
    if (!['fields', 'filters', 'pivots', 'sorts', 'limit', 'tz', 'dynamic_fields'].includes(key)) return null;
  }
  const fields = fieldList(q.fields);
  if (!fields || fields.length === 0) return null;
  params.push(`fields=${fields.join(',')}`);
  if (q.filters !== undefined) {
    const filters = rec(q.filters);
    if (!filters) return null;
    for (const [field, value] of Object.entries(filters)) {
      if (!LOOKML_FIELD_RE.test(field) || typeof value !== 'string') return null;
      params.push(`f%5B${field}%5D=${encodeQueryPart(lookerFilterValueSent(value))}`);
    }
  }
  if (q.pivots !== undefined) {
    const pivots = fieldList(q.pivots);
    if (!pivots) return null;
    if (pivots.length > 0) params.push(`pivots=${pivots.join(',')}`);
  }
  if (q.sorts !== undefined) {
    const sorts = fieldList(q.sorts, LOOKER_SORT_RE);
    if (!sorts) return null;
    if (sorts.length > 0) params.push(`sorts=${sorts.map(encodeQueryPart).join(',')}`);
  }
  if (q.limit !== undefined) {
    if ((typeof q.limit !== 'number' && typeof q.limit !== 'string') || !LOOKER_LIMIT_RE.test(String(q.limit)))
      return null;
    // The API returns every row asked for; an Explore shows at most 5,000, so a bigger read is not reproducible there.
    const limit = Number(q.limit);
    if (limit < 0 || limit > LOOKER_EXPLORE_MAX_ROWS) return null;
    params.push(`limit=${String(q.limit)}`);
  }
  if (q.tz !== undefined) {
    if (typeof q.tz !== 'string' || !LOOKER_TIMEZONE_RE.test(q.tz)) return null;
    params.push(`query_timezone=${encodeQueryPart(q.tz)}`);
  }
  if (q.dynamic_fields !== undefined) {
    if (!Array.isArray(q.dynamic_fields) || !q.dynamic_fields.every((d) => rec(d) !== null)) return null;
    if (q.dynamic_fields.length > 0) params.push(`dynamic_fields=${encodeQueryPart(JSON.stringify(q.dynamic_fields))}`);
  }
  const url = `${origin}/explore/${model}/${explore}?${params.join('&')}`;
  return new URL(url).origin === origin ? url : null;
}

/**
 * One segment per Explore, every distinct query run on it listed under it. A query too long to ever fit the line, or
 * one whose definition fails validation, keeps its place as a link to the Explore. An object from a runner that
 * predates query definitions links to the Explore unmarked, as it always did.
 */
function lookerExploreSegments(raws: unknown[], origin: string): Map<string, FooterSegment> {
  const byExplore = new Map<string, FooterSegment>();
  for (const raw of raws) {
    const o = rec(raw);
    if (!o || o.kind !== 'explore' || !LOOKML_NAME_RE.test(String(o.model)) || !LOOKML_NAME_RE.test(String(o.explore)))
      continue;
    const text = `${String(o.model)}/${String(o.explore)}`;
    let segment = byExplore.get(text);
    if (!segment) {
      segment = { text, url: `${origin}/explore/${String(o.model)}/${String(o.explore)}` };
      byExplore.set(text, segment);
    }
    if (!('query' in o)) continue;
    const url = lookerQueryUrl(origin, String(o.model), String(o.explore), o.query);
    const queries = (segment.queries ??= []);
    if (url && url.length <= MAX_MARKUP_LENGTH) {
      if (!queries.some((q) => q.url === url)) queries.push({ url });
    } else {
      queries.push({});
    }
  }
  return byExplore;
}

function objectSegment(system: SystemName, raw: unknown, ctx: SourcesFooterContext): FooterSegment | null {
  const o = rec(raw);
  if (!o) return null;
  if (system === 'looker') {
    const origin = ctx.lookerOrigin!;
    if ((o.kind === 'look' || o.kind === 'dashboard') && LOOKER_ID_RE.test(String(o.id))) {
      const text = `${o.kind} ${String(o.id)}`;
      const path = o.kind === 'look' ? 'looks' : 'dashboards';
      return { text, url: `${origin}/${path}/${encodeURIComponent(String(o.id))}` };
    }
    return null;
  }
  if (system === 'snowflake') {
    return o.kind === 'table' && isSafeText(o.name) ? { text: o.name } : null;
  }
  if (system === 'postgres') {
    // No link: a Postgres table has no URL to build.
    if (o.kind === 'database')
      return typeof o.name === 'string' && PG_DATABASE_RE.test(o.name) ? { text: o.name } : null;
    if (o.kind !== 'table' || !isSafeText(o.name)) return null;
    if (o.database === undefined) return { text: o.name };
    if (typeof o.database !== 'string' || !PG_DATABASE_RE.test(o.database)) return null;
    const text = `${o.database}.${o.name}`;
    return isSafeText(text) ? { text } : null;
  }
  return null;
}

/**
 * The tab a range names, only from explicit tab syntax (`Tab!A1`, `'My Tab'`). A bare `Revenue_Data` may be a named
 * range rather than a tab, so it names nothing.
 */
function tabOf(range: string): string | null {
  if (range.startsWith("'")) {
    let k = 1;
    while (k < range.length) {
      if (range[k] === "'" && range[k + 1] === "'") k += 2;
      else if (range[k] === "'") break;
      else k += 1;
    }
    const rest = range.slice(k + 1);
    if (k >= range.length || (rest !== '' && !rest.startsWith('!'))) return null;
    const tab = range.slice(1, k).replace(/''/g, "'");
    return isSafeText(tab) ? tab : null;
  }
  const bang = range.indexOf('!');
  if (bang === -1) return null;
  const tab = range.slice(0, bang);
  return isSafeText(tab) ? tab : null;
}

/** One object per spreadsheet, linked once, named by the tabs read: ranges of one file are not separate sources. */
function sheetObjects(raws: unknown[]): FooterSegment[] {
  const bySheet = new Map<string, string[]>();
  for (const raw of raws) {
    const o = rec(raw);
    if (!o || o.kind !== 'range' || typeof o.spreadsheetId !== 'string' || !SHEET_ID_RE.test(o.spreadsheetId)) continue;
    if (typeof o.range !== 'string') continue;
    const tabs = bySheet.get(o.spreadsheetId) ?? [];
    bySheet.set(o.spreadsheetId, tabs);
    const tab = tabOf(o.range);
    if (tab && !tabs.includes(tab)) tabs.push(tab);
  }
  return [...bySheet].map(([id, tabs]) => {
    const shown = tabs.slice(0, MAX_TABS_SHOWN).join(', ');
    const rest = tabs.length - MAX_TABS_SHOWN;
    const text = tabs.length === 0 ? 'sheet' : rest > 0 ? `${shown} +${rest} ${rest === 1 ? 'tab' : 'tabs'}` : shown;
    return { text, url: `https://docs.google.com/spreadsheets/d/${id}/edit` };
  });
}

/** Null when the payload carries no valid system: such a reply renders no line at all. */
export function buildSourcesFooter(sources: unknown, ctx: SourcesFooterContext): SourcesFooter | null {
  const payload = rec(sources);
  if (!payload || payload.version !== 1 || !Array.isArray(payload.systems)) return null;

  const systems: FooterSystem[] = [];
  const seen = new Set<string>();
  let latest: string | null = null;
  for (const rawSystem of payload.systems) {
    const s = rec(rawSystem);
    if (!s || typeof s.system !== 'string' || !(s.system in SYSTEMS) || seen.has(s.system)) continue;
    const system = s.system as SystemName;
    // A Looker call counts only against the group's own instance: another instance's names are never shown.
    if (system === 'looker' && (!ctx.lookerOrigin || s.origin !== ctx.lookerOrigin)) continue;
    const calls = s.calls;
    if (typeof calls !== 'number' || !Number.isInteger(calls) || calls < 1 || calls > MAX_CALLS) continue;
    seen.add(system);
    if (typeof s.lastAt === 'string' && !Number.isNaN(Date.parse(s.lastAt)) && (!latest || s.lastAt > latest))
      latest = s.lastAt;

    const raws = Array.isArray(s.objects) ? s.objects : [];
    let objects: FooterSegment[];
    if (system === 'sheets') {
      objects = sheetObjects(raws);
    } else if (system === 'looker') {
      // Each Explore keeps the place of its first query among the looks and dashboards.
      const explores = lookerExploreSegments(raws, ctx.lookerOrigin!);
      const placed = new Set<string>();
      objects = [];
      for (const raw of raws) {
        const o = rec(raw);
        if (o?.kind === 'explore') {
          const segment = explores.get(`${String(o.model)}/${String(o.explore)}`);
          if (segment && !placed.has(segment.text)) {
            placed.add(segment.text);
            objects.push(segment);
          }
        } else {
          const segment = objectSegment(system, raw, ctx);
          if (segment) objects.push(segment);
        }
      }
    } else {
      objects = raws.map((o) => objectSegment(system, o, ctx)).filter((o): o is FooterSegment => o !== null);
    }
    const { name, unit } = SYSTEMS[system];
    systems.push({ name, calls, unit: calls === 1 ? unit[0] : unit[1], objects });
  }
  if (systems.length === 0) return null;
  return { systems, lastCall: latest ? formatLocalTime(latest, ctx.timezone) : null };
}

function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeDiscord(text: string): string {
  return text.replace(/[\\*_~`|[\]()<>]/g, (c) => `\\${c}`);
}

function renderLink(text: string, url: string | undefined, markup: SubtextMarkup | undefined): string {
  if (markup === 'slack-mrkdwn') return url ? `<${url}|${escapeSlack(text)}>` : escapeSlack(text);
  if (markup === 'discord-markdown') return url ? `[${escapeDiscord(text)}](<${url}>)` : escapeDiscord(text);
  return text;
}

function renderText(text: string, markup: SubtextMarkup | undefined): string {
  return renderLink(text, undefined, markup);
}

/** Query links the line no longer has room for, by object; each then links to its Explore, marked. */
type Degraded = Map<FooterSegment, Set<number>>;

/**
 * One query names the Explore and links to the query. Several are numbered under the Explore's name, each linked.
 * A query without an exact URL links to the Explore and says so.
 */
function renderObject(segment: FooterSegment, markup: SubtextMarkup | undefined, degraded: Degraded): string {
  const { text, url, queries } = segment;
  if (!queries || queries.length === 0) return renderLink(text, url, markup);
  const exact = (i: number): string | undefined => (degraded.get(segment)?.has(i) ? undefined : queries[i].url);
  if (queries.length === 1) {
    const q = exact(0);
    return q ? renderLink(text, q, markup) : renderLink(`${text} (${EXPLORE_ONLY})`, url, markup);
  }
  const links = queries.map((_, i) => {
    const q = exact(i);
    return q ? renderLink(`q${i + 1}`, q, markup) : renderLink(`q${i + 1} ${EXPLORE_ONLY}`, url, markup);
  });
  return `${renderText(`${text} (`, markup)}${links.join(renderText(', ', markup))}${renderText(')', markup)}`;
}

function compose(
  footer: SourcesFooter,
  shown: readonly number[],
  markup: SubtextMarkup | undefined,
  degraded: Degraded = new Map(),
): string {
  const parts = [renderText(LABEL, markup)];
  footer.systems.forEach((system, i) => {
    const k = shown[i];
    const listed = system.objects.slice(0, k).map((o) => renderObject(o, markup, degraded));
    const more = k > 0 && system.objects.length > k ? `, +${system.objects.length - k} more` : '';
    const names = listed.length > 0 ? `: ${listed.join(', ')}${renderText(more, markup)}` : '';
    parts.push(`${renderText(system.name, markup)}${names}${renderText(` (${system.calls} ${system.unit})`, markup)}`);
  });
  if (footer.lastCall) parts.push(renderText(`last call ${footer.lastCall}`, markup));
  return parts.join(' · ');
}

/** The longest query URL still linked among the names shown, so swapping it for the Explore's saves the most. */
function longestExactQuery(
  footer: SourcesFooter,
  shown: readonly number[],
  degraded: Degraded,
): { segment: FooterSegment; index: number } | null {
  let best: { segment: FooterSegment; index: number; length: number } | null = null;
  footer.systems.forEach((system, i) => {
    for (const segment of system.objects.slice(0, shown[i])) {
      segment.queries?.forEach((q, index) => {
        if (q.url && !degraded.get(segment)?.has(index) && (!best || q.url.length > best.length))
          best = { segment, index, length: q.url.length };
      });
    }
  });
  return best;
}

/**
 * One line in the platform's own markup; a platform with no declared markup gets plain text and no links. A line whose
 * links overflow it first swaps the longest query links for their Explore's link, marked, one at a time. A line still
 * too long sheds object names one at a time, longest list first, keeping each system's first name until nothing else
 * is left to drop; systems and counts always stay.
 */
export function renderSourcesFooter(footer: SourcesFooter, markup: SubtextMarkup | undefined): string {
  const shown = footer.systems.map((s) => Math.min(s.objects.length, MAX_OBJECTS_PER_SYSTEM));
  const degraded: Degraded = new Map();
  for (;;) {
    const visibleTooLong = compose(footer, shown, undefined, degraded).length > MAX_VISIBLE_LENGTH;
    if (!visibleTooLong && compose(footer, shown, markup, degraded).length <= MAX_MARKUP_LENGTH) break;
    if (!visibleTooLong && markup) {
      const swap = longestExactQuery(footer, shown, degraded);
      if (swap) {
        const set = degraded.get(swap.segment) ?? new Set<number>();
        set.add(swap.index);
        degraded.set(swap.segment, set);
        continue;
      }
    }
    let pick = -1;
    shown.forEach((k, i) => {
      if (k > 1 && (pick === -1 || k > shown[pick])) pick = i;
    });
    if (pick === -1) pick = shown.lastIndexOf(1);
    if (pick === -1) break;
    shown[pick] -= 1;
  }
  return compose(footer, shown, markup, degraded);
}

function isFooter(value: unknown): value is SourcesFooter {
  const f = rec(value);
  if (!f || !Array.isArray(f.systems) || (f.lastCall !== null && typeof f.lastCall !== 'string')) return false;
  return f.systems.every((raw) => {
    const s = rec(raw);
    return (
      !!s &&
      typeof s.name === 'string' &&
      typeof s.calls === 'number' &&
      typeof s.unit === 'string' &&
      Array.isArray(s.objects) &&
      s.objects.every((raw) => {
        const o = rec(raw) as Partial<FooterSegment> | null;
        return (
          !!o &&
          typeof o.text === 'string' &&
          (o.url === undefined || typeof o.url === 'string') &&
          (o.queries === undefined ||
            (Array.isArray(o.queries) &&
              o.queries.every((q) => rec(q) !== null && (q.url === undefined || typeof q.url === 'string'))))
        );
      })
    );
  });
}

/** The footer the delivery door attached, or null. */
export function readSourcesFooter(content: Record<string, unknown>): SourcesFooter | null {
  return isFooter(content.sourcesFooter) && content.sourcesFooter.systems.length > 0 ? content.sourcesFooter : null;
}

/** The group's own Looker origin from its scoped `LOOKER_BASE_URL_<FOLDER>` only: the bare fallback may be another tenant's. */
export function scopedLookerOrigin(credentialFolder: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[`LOOKER_BASE_URL_${credentialFolder.toUpperCase().replace(/-/g, '_')}`];
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== '/' && url.pathname !== '') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export async function sourcesFooterContext(agentGroupId: string): Promise<SourcesFooterContext> {
  const group = await getAgentGroup(agentGroupId);
  const folder = group ? (readContainerConfig(group.folder).credentialFolder ?? group.folder) : null;
  return {
    lookerOrigin: folder ? scopedLookerOrigin(folder) : null,
    timezone: await resolveGroupTimezone(agentGroupId),
  };
}

/**
 * Replaces the container's `sources` with host-built `sourcesFooter` segments. Any `sourcesFooter` already on the
 * payload is dropped first, so only this function ever sets one. Content with neither key is returned unchanged.
 */
export async function attachSourcesFooter(
  content: string,
  context: () => Promise<SourcesFooterContext>,
): Promise<string> {
  if (!content.includes('"sources')) return content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  const payload = rec(parsed);
  if (!payload || (!('sources' in payload) && !('sourcesFooter' in payload))) return content;
  const sources = payload.sources;
  delete payload.sources;
  delete payload.sourcesFooter;
  if (sources !== undefined) {
    try {
      const footer = buildSourcesFooter(sources, await context());
      if (footer) payload.sourcesFooter = footer;
    } catch (err) {
      // The answer always goes out; only its footer is lost.
      log.warn('Sources footer dropped', { err: err instanceof Error ? err.message : String(err) });
    }
  }
  return JSON.stringify(payload);
}
