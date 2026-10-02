import { queryOne } from './db';

export class ShadowRateLimitExceeded extends Error {
  readonly retryAfterSeconds: number;
  /**
   * Which bucket refused the request.
   *
   * Carried because not every SHADOW limit means the same thing to the person
   * who hit it. `chat` and `chat_daily` throttle all of SHADOW, so telling
   * someone "too many SHADOW requests" is accurate. `heavy_bag` throttles one
   * tier while Quick Round stays fully available -- and a caller that cannot
   * tell the two apart has to describe a partial cap as a total outage, which
   * sends a coach away for an hour they did not need to wait.
   *
   * Optional so existing test fixtures that construct this by hand keep
   * working; the single throw site always populates it.
   */
  readonly endpointKey?: string;
  /**
   * The bucket row the refused attempt incremented.
   *
   * The statement increments first and compares afterwards, so a refused
   * attempt has still added one to the count. For most buckets that is
   * harmless. For one whose slots can be given back it is not: the count then
   * sits ABOVE the limit, and a later refund brings it back to the limit, not
   * under it -- so the slot that was refunded cannot be used. A caller that
   * refunds uses this to put the refused attempt's own increment back
   * (see consumeShadowReviewSlot).
   */
  readonly receipt?: ShadowRateLimitReceipt;

  constructor(retryAfterSeconds: number, endpointKey?: string, receipt?: ShadowRateLimitReceipt) {
    super('SHADOW_RATE_LIMIT_EXCEEDED');
    this.name = 'ShadowRateLimitExceeded';
    this.retryAfterSeconds = retryAfterSeconds;
    this.endpointKey = endpointKey;
    this.receipt = receipt;
  }
}

interface RateLimitRow {
  request_count: number;
  retry_after_seconds: number;
  window_started_epoch: string | number;
}

/**
 * Which bucket row one call incremented.
 *
 * Returned by consumeShadowRateLimit so that a caller who has to give the
 * slot back can name the row it took it from. The window is the one the
 * database chose when it incremented -- read back from the row, never worked
 * out again from the clock -- so a refund issued after the hour has turned
 * still lands on the hour that was charged, or on nothing.
 */
export interface ShadowRateLimitReceipt {
  organizationId: string;
  accountId: string;
  endpointKey: string;
  windowSeconds: number;
  /** Start of the charged window, in whole seconds since the epoch. */
  windowStartedAtEpochSeconds: number;
}

export interface ShadowRateLimitPolicy {
  endpointKey: string;
  limit: number;
  windowSeconds: number;
}

/**
 * Every SHADOW rate limit, in one place and tunable from the environment.
 *
 * These were literals at each call site, so a cap that turned away a real user
 * could only be raised by editing code and shipping a release. Early pilot usage
 * is the heaviest usage -- people explore a new tool hard in their first week --
 * and someone who hits a wall then reads the product as broken and does not come
 * back. The defaults below are therefore sized for enthusiastic ordinary use
 * rather than for worst-case abuse, and each one can be raised or lowered
 * through PPBF_SHADOW_RATE_LIMIT_<KEY> without a deploy.
 *
 * Only the limit is overridable. The window is semantic -- 'chat_daily' means a
 * day -- so an override that changed it would make the key a lie.
 *
 * enforceShadowRateLimit still validates the resolved numbers, so a mistyped
 * override cannot switch limiting off.
 */
const RATE_LIMIT_DEFAULTS = {
  // Per-minute caps protect the connection pool and the provider from a runaway
  // client, not from a person: nobody types 30 questions in a minute, but a
  // double-submit or a retry loop can.
  chat: { limit: 30, windowSeconds: 60 },
  // The cap most likely to be felt. At 100 a coach demonstrating SHADOW through
  // a squad could be shut off mid-session, with no way to tell that a limit --
  // rather than a fault -- had stopped it.
  chat_daily: { limit: 400, windowSeconds: 86_400 },
  feedback: { limit: 60, windowSeconds: 60 },
  // Heavy Bag is the expensive inference path, and until this existed it was
  // charged to the same generic `chat` bucket a Quick Round uses -- so the
  // per-organization cap the ML spec (§3.1) describes did not exist in any
  // form. Owner decision 2026-08-01: ten rounds per user per hour, with the
  // administrative tier exempt. The bucket is keyed (organization, account)
  // like every other, which is what makes it per-user; there is deliberately
  // no organization-wide ceiling, because one member exhausting a shared pool
  // would silently deny everyone else in the gym.
  heavy_bag: { limit: 10, windowSeconds: 3_600 },
  // Uploads cost storage rather than inference. Raised, but by less, since a
  // batch of session video is the one action here with an unbounded byte cost.
  shadow_upload: { limit: 40, windowSeconds: 3_600 },
  video_upload: { limit: 20, windowSeconds: 3_600 },
  // The human-review queue writes (OD-2026-09-30-005: "3 per hour"). Each
  // counts review ROWS, per account. Reaching one suppresses the row and
  // nothing else: the person still gets their response. A slot whose row was
  // never written is given back (refundShadowRateLimit), and a refused
  // attempt's own increment is put back (consumeShadowReviewSlot), so the
  // hour is spent on rows, not on attempts (OD-2026-09-30-006: "Refund on
  // failure").
  //
  // TWO allowances, not one (OD-2026-10-01-006, the owner's "A"): critical
  // REQUEST reviews have their own three an hour, so routine review rows
  // cannot use up the hour an emergency report needs. Which event draws on
  // which is decided in resolveShadowReviewBucket, and nowhere else.
  //
  // NOT TUNABLE BY ENVIRONMENT, unlike every bucket above (see
  // OWNER_FIXED_RATE_LIMITS): three an hour is the owner's number
  // (OD-2026-10-01-006 section 2), and changing it is his decision, recorded
  // and made here in code, not an operator's setting.
  safety_review: { limit: 3, windowSeconds: 3_600 },
  safety_review_critical: { limit: 3, windowSeconds: 3_600 },
} as const;

export type ShadowRateLimitKey = keyof typeof RATE_LIMIT_DEFAULTS;

// Buckets whose limit is an owner decision. resolveShadowRateLimit ignores
// PPBF_SHADOW_RATE_LIMIT_<KEY> for these and returns the number above.
const OWNER_FIXED_RATE_LIMITS: ReadonlySet<ShadowRateLimitKey> = new Set<ShadowRateLimitKey>([
  'safety_review',
  'safety_review_critical',
]);

export function resolveShadowRateLimit(
  key: ShadowRateLimitKey,
  env: Record<string, string | undefined> = process.env,
): ShadowRateLimitPolicy {
  const fallback = RATE_LIMIT_DEFAULTS[key];
  if (OWNER_FIXED_RATE_LIMITS.has(key)) {
    return { endpointKey: key, limit: fallback.limit, windowSeconds: fallback.windowSeconds };
  }
  const raw = env[`PPBF_SHADOW_RATE_LIMIT_${key.toUpperCase()}`];
  const parsed = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
  const limit = Number.isFinite(parsed) && parsed >= 1
    ? Math.min(10_000, Math.trunc(parsed))
    : fallback.limit;

  return { endpointKey: key, limit, windowSeconds: fallback.windowSeconds };
}

/**
 * A limit message that says when the caller can actually continue.
 *
 * One shared "please wait briefly" was accurate for the per-minute cap and wrong
 * for the daily one, where "briefly" could mean twenty hours. Someone told to
 * wait briefly, who waits and is refused again, concludes the product is broken
 * -- so the wording has to distinguish a pause from a cap.
 */
export function shadowRateLimitMessage(retryAfterSeconds: number, subject = 'SHADOW'): string {
  if (retryAfterSeconds <= 90) {
    const seconds = Math.max(5, retryAfterSeconds);
    return `Too many ${subject} requests from this account. Try again in about ${seconds} seconds.`;
  }
  if (retryAfterSeconds <= 3_600) {
    const minutes = Math.ceil(retryAfterSeconds / 60);
    return `Too many ${subject} requests from this account. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
  }
  const hours = Math.ceil(retryAfterSeconds / 3_600);
  return `This account has reached its ${subject} usage limit for now. It resets in about ${hours} hour${hours === 1 ? '' : 's'}.`;
}

export async function enforceShadowRateLimit(input: {
  organizationId: string;
  accountId: string;
  endpointKey: string;
  limit: number;
  windowSeconds: number;
}): Promise<void> {
  // The receipt is not needed here, and its absence is not an error here:
  // this call admits and refuses exactly as it did before receipts existed.
  await chargeShadowRateLimit(input);
}

/**
 * enforceShadowRateLimit, returning what it charged.
 *
 * The same statement and the same checks. It throws ShadowRateLimitExceeded
 * when the incremented count is over the limit, and SHADOW_RATE_LIMIT_UNAVAILABLE
 * when the database returns no row. On success it returns a receipt naming the
 * exact bucket row it incremented.
 *
 * ONE ERROR enforceShadowRateLimit DOES NOT HAVE: if the database returns a
 * row whose window cannot be read back as a whole number of seconds, there is
 * no receipt to return, and this throws SHADOW_RATE_LIMIT_UNAVAILABLE. The
 * row has been incremented by then and cannot be given back. (Not expected
 * from Postgres; the window is an epoch cast to bigint.)
 *
 * A call that throws ShadowRateLimitExceeded HAS incremented the row, as it
 * always has. The error carries the receipt for that increment, for the one
 * kind of caller that needs to put it back (consumeShadowReviewSlot).
 */
export async function consumeShadowRateLimit(input: {
  organizationId: string;
  accountId: string;
  endpointKey: string;
  limit: number;
  windowSeconds: number;
}): Promise<ShadowRateLimitReceipt> {
  const receipt = await chargeShadowRateLimit(input);
  if (!receipt) {
    throw new Error('SHADOW_RATE_LIMIT_UNAVAILABLE');
  }
  return receipt;
}

async function chargeShadowRateLimit(input: {
  organizationId: string;
  accountId: string;
  endpointKey: string;
  limit: number;
  windowSeconds: number;
}): Promise<ShadowRateLimitReceipt | undefined> {
  if (!input.organizationId.trim() || !input.accountId.trim()) {
    throw new Error('Forbidden: SHADOW rate limiting requires an authenticated tenant owner');
  }
  if (!/^[a-z0-9:_-]{1,80}$/.test(input.endpointKey)) {
    throw new Error('Invalid SHADOW rate-limit endpoint');
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10_000) {
    throw new Error('Invalid SHADOW rate limit');
  }
  if (!Number.isSafeInteger(input.windowSeconds) || input.windowSeconds < 1 || input.windowSeconds > 86_400) {
    throw new Error('Invalid SHADOW rate-limit window');
  }

  const row = await queryOne<RateLimitRow>(
    `with purged as (
       delete from pilot.shadow_rate_limit_buckets
       where ctid in (
         select ctid
         from pilot.shadow_rate_limit_buckets
         where window_started_at < clock_timestamp() - interval '2 days'
         order by window_started_at asc
         limit 250
       )
     ),
     bucket as (
       select to_timestamp(
         floor(extract(epoch from clock_timestamp()) / $4) * $4
       ) as started_at
     ),
     updated as (
       insert into pilot.shadow_rate_limit_buckets
         (organization_id, account_id, endpoint_key, window_started_at, window_seconds, request_count)
       select $1, $2, $3, started_at, $4, 1
       from bucket
       on conflict (organization_id, account_id, endpoint_key, window_started_at)
       do update set
         request_count = pilot.shadow_rate_limit_buckets.request_count + 1,
         updated_at = now()
       returning request_count, window_started_at
     )
     select
       request_count,
       greatest(
         1,
         ceil(extract(epoch from (window_started_at + ($4 * interval '1 second') - clock_timestamp())))
       )::integer as retry_after_seconds,
       extract(epoch from window_started_at)::bigint as window_started_epoch
     from updated`,
    [
      input.organizationId,
      input.accountId,
      input.endpointKey,
      input.windowSeconds,
    ],
  );

  if (!row) {
    throw new Error('SHADOW_RATE_LIMIT_UNAVAILABLE');
  }
  const windowStartedAtEpochSeconds = Number(row.window_started_epoch);
  const receipt: ShadowRateLimitReceipt | undefined = Number.isSafeInteger(windowStartedAtEpochSeconds)
    ? {
        organizationId: input.organizationId,
        accountId: input.accountId,
        endpointKey: input.endpointKey,
        windowSeconds: input.windowSeconds,
        windowStartedAtEpochSeconds,
      }
    : undefined;
  if (row.request_count > input.limit) {
    throw new ShadowRateLimitExceeded(row.retry_after_seconds, input.endpointKey, receipt);
  }
  return receipt;
}

/**
 * WHICH BUCKET A HUMAN-REVIEW WRITE DRAWS ON. One place, on purpose.
 *
 * The chat route and the job worker both ask here, so that how the review
 * writes are bounded is decided once and changed in one line.
 *
 * THE OWNER'S RULING (OD-2026-10-01-006, "A"; each allowance is
 * OD-2026-09-30-005's "3 per hour", per account):
 *
 *   safety_review_critical   CRITICAL REQUEST reviews only: the request-risk
 *                            row of a request written at severity 'critical'.
 *   safety_review            EVERY OTHER SHADOW human-review row: the
 *                            request-risk row of any other high-risk request;
 *                            every generated-answer (response-safety) row,
 *                            from the route or from the worker, whatever the
 *                            severity of the request that produced the
 *                            answer; and the operational rows, such as the
 *                            empty-Library notice's.
 *
 * So three routine rows in an hour cannot stop an emergency report's row
 * being written, and the fourth critical request in an hour is still
 * suppressed: bounded, not unlimited.
 *
 * The limit is on persisting the row, never on what the person is told.
 *
 * `null` means "not bounded by a review bucket". Nothing returns it today;
 * consumeShadowReviewSlot handles it so that a later ruling is a change to
 * this function alone.
 */
export type ShadowReviewEvent = {
  kind: 'request_risk' | 'response_safety' | 'operational';
  /** The row is being written at severity 'critical'. */
  critical: boolean;
};

export function resolveShadowReviewBucket(event: ShadowReviewEvent): ShadowRateLimitKey | null {
  return event.kind === 'request_risk' && event.critical ? 'safety_review_critical' : 'safety_review';
}

/**
 * Take one slot for a human-review row.
 *
 * consumeShadowRateLimit for the bucket resolveShadowReviewBucket names, with
 * one difference: A REFUSED ATTEMPT IS PUT BACK. The count for a review
 * bucket therefore does not rest above its limit, and a slot refunded later
 * is a slot the next row can use. (Two exceptions, both failures: the
 * put-back itself fails, or the refusal carries no receipt. And between a
 * refused attempt's increment and its put-back the count is briefly one over,
 * so an attempt that lands in that gap can be refused with a slot free.)
 * Without this, a refusal that lands between an
 * admitted row's charge and its refund leaves the count one too high, and
 * the account is locked for the rest of the hour with a slot it was owed.
 *
 * Returns the receipt for an admitted row; `null` when the event is not
 * bounded. Throws ShadowRateLimitExceeded when the hour is spent, and any
 * other error when the limiter itself failed -- which the caller must NOT
 * treat as spent.
 */
export async function consumeShadowReviewSlot(input: {
  organizationId: string;
  accountId: string;
  event: ShadowReviewEvent;
}): Promise<ShadowRateLimitReceipt | null> {
  const bucket = resolveShadowReviewBucket(input.event);
  if (bucket === null) return null;
  try {
    return await consumeShadowRateLimit({
      organizationId: input.organizationId,
      accountId: input.accountId,
      ...resolveShadowRateLimit(bucket),
    });
  } catch (error) {
    if (error instanceof ShadowRateLimitExceeded && error.receipt) {
      await refundShadowRateLimit(error.receipt);
    }
    throw error;
  }
}

/**
 * Give back the one slot a receipt names.
 *
 * WHY IT EXISTS. For every other bucket the attempt is the cost, and counting
 * it is right. For the review buckets it is not: the limiter increments, then
 * the human-review insert runs, and that insert can fail. Three failed
 * inserts would spend an account's whole hour while persisting nothing, and
 * the next real report that hour would be suppressed as "exhausted".
 *
 * WHAT IT TOUCHES: exactly the row the receipt names -- this organization,
 * this account, this endpoint, THIS window -- and only if its count is above
 * zero. WHICH row is decided by the receipt alone, never by the clock (the
 * clock is used only to stamp updated_at). A refund that arrives after the hour
 * has turned decrements the hour that was charged; if that row has been
 * purged it decrements nothing. It never creates a row, never goes below
 * zero, and never touches the current window unless that is the one charged.
 *
 * Returns whether a row was decremented. NEVER THROWS: it is called while a
 * failure is already being handled, and a second failure there has nowhere
 * useful to go.
 *
 * NOT IDEMPOTENT. Two calls with one receipt give back two slots. Each caller
 * therefore holds one receipt and refunds it on at most one path:
 * consumeShadowReviewSlot for a refused attempt, and the route's and the
 * worker's review writers for an admitted row whose every insert failed.
 */
export async function refundShadowRateLimit(receipt: ShadowRateLimitReceipt): Promise<boolean> {
  try {
    if (!receipt.organizationId.trim() || !receipt.accountId.trim()) return false;
    if (!/^[a-z0-9:_-]{1,80}$/.test(receipt.endpointKey)) return false;
    if (!Number.isSafeInteger(receipt.windowSeconds) || receipt.windowSeconds < 1 || receipt.windowSeconds > 86_400) return false;
    if (!Number.isSafeInteger(receipt.windowStartedAtEpochSeconds) || receipt.windowStartedAtEpochSeconds < 0) return false;

    const row = await queryOne<{ request_count: number }>(
      `update pilot.shadow_rate_limit_buckets
          set request_count = request_count - 1,
              updated_at = now()
        where organization_id = $1
          and account_id = $2
          and endpoint_key = $3
          and window_started_at = to_timestamp($4::bigint)
          and window_seconds = $5
          and request_count > 0
        returning request_count`,
      [
        receipt.organizationId,
        receipt.accountId,
        receipt.endpointKey,
        receipt.windowStartedAtEpochSeconds,
        receipt.windowSeconds,
      ],
    );
    return Boolean(row);
  } catch {
    console.error('SHADOW rate-limit refund failed');
    return false;
  }
}
