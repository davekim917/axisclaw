const MIN_MS = 1000;
const MAX_MS = 24 * 60 * 60 * 1000;

/**
 * A server's `timeout` as a provider may render it, or undefined. `container.json` reaches the runner unvalidated, and
 * Codex refuses its whole config over one bad value (NaN, Infinity, negative), losing every server with it.
 */
export function usableToolTimeoutMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_MS && value <= MAX_MS ? value : undefined;
}
