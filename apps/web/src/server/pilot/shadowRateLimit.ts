import { queryOne } from './db';

export class ShadowRateLimitExceeded extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('SHADOW_RATE_LIMIT_EXCEEDED');
    this.name = 'ShadowRateLimitExceeded';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface RateLimitRow {
  request_count: number;
  retry_after_seconds: number;
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
} as const;

export type ShadowRateLimitKey = keyof typeof RATE_LIMIT_DEFAULTS;

export function resolveShadowRateLimit(
  key: ShadowRateLimitKey,
  env: Record<string, string | undefined> = process.env,
): ShadowRateLimitPolicy {
  const fallback = RATE_LIMIT_DEFAULTS[key];
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
       )::integer as retry_after_seconds
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
  if (row.request_count > input.limit) {
    throw new ShadowRateLimitExceeded(row.retry_after_seconds);
  }
}
