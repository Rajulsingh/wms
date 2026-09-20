/**
 * Runs `fn` over `items` with at most `concurrency` in flight at once,
 * instead of either fully sequential (slow — each item pays the full
 * network/DB round-trip latency of the one before it) or unbounded
 * Promise.all (risks tripping Amazon's per-second SP-API rate limits, or
 * hammering D1 with more concurrent writes than useful). A worker pool
 * pattern: `concurrency` workers each pull the next item off a shared index
 * as soon as they finish theirs, so results always come back in the same
 * order as `items` regardless of which one finishes first.
 */
export async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
