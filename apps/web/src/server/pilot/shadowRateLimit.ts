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
