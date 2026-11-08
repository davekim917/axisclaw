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

interface FooterSegment {
  text: string;
  url?: string;
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

function objectSegment(system: SystemName, raw: unknown, ctx: SourcesFooterContext): FooterSegment | null {
  const o = rec(raw);
  if (!o) return null;
  if (system === 'looker') {
    const origin = ctx.lookerOrigin!;
    if (o.kind === 'explore' && LOOKML_NAME_RE.test(String(o.model)) && LOOKML_NAME_RE.test(String(o.explore))) {
      const text = `${String(o.model)}/${String(o.explore)}`;
      return { text, url: `${origin}/explore/${String(o.model)}/${String(o.explore)}` };
    }
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
    const objects =
      system === 'sheets'
        ? sheetObjects(raws)
        : raws.map((o) => objectSegment(system, o, ctx)).filter((o): o is FooterSegment => o !== null);
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

function renderObject({ text, url }: FooterSegment, markup: SubtextMarkup | undefined): string {
  if (markup === 'slack-mrkdwn') return url ? `<${url}|${escapeSlack(text)}>` : escapeSlack(text);
  if (markup === 'discord-markdown') return url ? `[${escapeDiscord(text)}](<${url}>)` : escapeDiscord(text);
  return text;
}

function renderText(text: string, markup: SubtextMarkup | undefined): string {
  return renderObject({ text }, markup);
}

function compose(footer: SourcesFooter, shown: readonly number[], markup: SubtextMarkup | undefined): string {
  const parts = [renderText(LABEL, markup)];
  footer.systems.forEach((system, i) => {
    const k = shown[i];
    const listed = system.objects.slice(0, k).map((o) => renderObject(o, markup));
    const more = k > 0 && system.objects.length > k ? `, +${system.objects.length - k} more` : '';
    const names = listed.length > 0 ? `: ${listed.join(', ')}${renderText(more, markup)}` : '';
    parts.push(`${renderText(system.name, markup)}${names}${renderText(` (${system.calls} ${system.unit})`, markup)}`);
  });
  if (footer.lastCall) parts.push(renderText(`last call ${footer.lastCall}`, markup));
  return parts.join(' · ');
}

/**
 * One line in the platform's own markup; a platform with no declared markup gets plain text and no links. Too long a
 * line sheds object names one at a time, longest list first, keeping each system's first name until nothing else is
 * left to drop; systems and counts always stay.
 */
export function renderSourcesFooter(footer: SourcesFooter, markup: SubtextMarkup | undefined): string {
  const shown = footer.systems.map((s) => Math.min(s.objects.length, MAX_OBJECTS_PER_SYSTEM));
  const tooLong = (): boolean =>
    compose(footer, shown, undefined).length > MAX_VISIBLE_LENGTH ||
    compose(footer, shown, markup).length > MAX_MARKUP_LENGTH;
  while (tooLong()) {
    let pick = -1;
    shown.forEach((k, i) => {
      if (k > 1 && (pick === -1 || k > shown[pick])) pick = i;
    });
    if (pick === -1) pick = shown.lastIndexOf(1);
    if (pick === -1) break;
    shown[pick] -= 1;
  }
  return compose(footer, shown, markup);
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
      s.objects.every(
        (o) =>
          rec(o) !== null &&
          typeof (o as FooterSegment).text === 'string' &&
          ((o as FooterSegment).url === undefined || typeof (o as FooterSegment).url === 'string'),
      )
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
