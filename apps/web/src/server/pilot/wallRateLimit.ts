/**
 * A fixed-window request budget for the public wall-display read.
 *
 * rateLimit.ts is deliberately not reused here. That module is built for
 * authentication: every call is recorded as a failed attempt and the backoff
 * doubles, which is exactly right for someone guessing a child's PIN and
 * exactly wrong for a television that is SUPPOSED to ask every thirty seconds
 * forever. Wired to this endpoint it would 429 the gym's own screen within a
 * few minutes of switching it on.
 *
 * So: a plain per-address budget with a window, no memory of "failure", and no
 * escalation. A TV polling every 30s spends 2 of 30. A scraper hammering the
 * endpoint runs out.
 *
 * In-memory and per-instance, the same limitation rateLimit.ts documents for
 * its volatile half. That is acceptable here because the payload is already
 * built to be safe when public -- this budget protects the database from load,
 * not the children from disclosure. The consent gate does that.
 */

export const WALL_WINDOW_MS = 60_000;
export const WALL_MAX_PER_WINDOW = 30;

interface Bucket {
  windowStart: number;
  count: number;
}

const buckets = new Map<string, Bucket>();

export interface WallBudgetVerdict {
  readonly allowed: boolean;
  /** Seconds until the window resets. Only meaningful when refused. */
  readonly retryAfterSeconds: number;
}

export function consumeWallBudget(key: string, nowMs: number = Date.now()): WallBudgetVerdict {
  // Sweep on the way through rather than on a timer, so an idle process holds
  // nothing and there is no interval to leak in a serverless instance.
  for (const [existing, bucket] of buckets) {
    if (nowMs - bucket.windowStart >= WALL_WINDOW_MS) buckets.delete(existing);
  }

  const bucket = buckets.get(key);
  if (!bucket) {
    buckets.set(key, { windowStart: nowMs, count: 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  bucket.count += 1;
  if (bucket.count > WALL_MAX_PER_WINDOW) {
    const remaining = WALL_WINDOW_MS - (nowMs - bucket.windowStart);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(remaining / 1000)) };
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

/** Test seam. Never called in a request path. */
export function resetWallBudget(): void {
  buckets.clear();
}
