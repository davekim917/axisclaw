import { parseUtcTimestampMs } from './thread-context.js';

/** Titles are generated per session, so the freshest among a thread's wins; a row with no stamp goes by `activityMs`. */
function freshestGeneratedTitle<R extends { title: string | null; title_generated_at: string | null }>(
  rows: Iterable<R>,
  activityMs: (row: R) => number,
): string | null {
  let title: string | null = null;
  let titleAt = -Infinity;
  for (const row of rows) {
    if (!row.title) continue;
    const at = parseUtcTimestampMs(row.title_generated_at) ?? activityMs(row);
    if (at > titleAt) {
      titleAt = at;
      title = row.title;
    }
  }
  return title;
}

export function shownThreadTitle<R extends { title: string | null; title_generated_at: string | null }>(
  rowTitle: string | null | undefined,
  sessions: Iterable<R>,
  activityMs: (row: R) => number,
): string | null {
  return rowTitle?.trim() || freshestGeneratedTitle(sessions, activityMs);
}
