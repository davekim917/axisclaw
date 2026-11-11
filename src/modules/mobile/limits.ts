export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

export interface Limit {
  max: number;
  windowMs: number;
}

/** Each one posts as the person, or in their name, which nothing here can take back. */
export const SEND_LIMITS: Limit[] = [
  { max: 10, windowMs: MINUTE_MS },
  { max: 300, windowMs: DAY_MS },
];

/** Counts this attempt against `key`'s limits, unless one is already reached; true when it is. */
export function overLimit(recent: Map<string, number[]>, key: string, limits: Limit[]): boolean {
  const now = Date.now();
  const longest = Math.max(...limits.map((limit) => limit.windowMs));
  const kept = (recent.get(key) ?? []).filter((at) => at > now - longest);
  const over = limits.some(({ max, windowMs }) => kept.filter((at) => at > now - windowMs).length >= max);
  recent.set(key, over ? kept : [...kept, now]);
  return over;
}
