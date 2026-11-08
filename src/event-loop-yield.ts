/**
 * Hands the loop to timers and socket I/O. An `await` on an already-settled promise does not: a chain of those is one
 * contiguous block, however many sessions it crosses.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
