/**
 * Rate limiting utility for PIN-based authentication endpoints.
 * Prevents brute force attacks with per-account and per-IP exponential backoff.
 *
 * In production, this should be backed by Redis or similar distributed cache.
 * This in-memory implementation is suitable for development and single-instance deployments.
 */

import type { PoolClient } from 'pg';

import { withPoolClient } from './db';

interface RateLimitEntry {
  count: number;
  lastAttempt: number;
  blockedUntil: number;
}

// In-memory store: Map[key] = RateLimitEntry
// Keys: 'pin_account:{accountId}' or 'pin_ip:{ipAddress}'
const rateLimitStore = new Map<string, RateLimitEntry>();

// Configuration
const MAX_ATTEMPTS_THRESHOLD = 5; // Allow 5 attempts before throttling
const INITIAL_BACKOFF_MS = 1000; // 1 second
const MAX_BACKOFF_MS = 60000; // 1 minute
const BACKOFF_MULTIPLIER = 2; // Double the wait time on each failed attempt
const EXPIRY_MS = 15 * 60 * 1000; // Clear old entries after 15 minutes
const DURABLE_WINDOW_SECONDS = 15 * 60;


function durableRateLimitEnabled(): boolean {
  return process.env.PPBF_DURABLE_RATE_LIMIT === 'true';
}

/**
 * Runs durable rate-limit work on the SHARED POOL, and never throws.
 *
 * Two problems with what this used to do. It opened a brand-new pg Client
 * per call -- acceptable for activation, which is rare, but a fresh TCP+TLS
 * handshake on every athlete sign-in once login started using it. And
 * `client.connect()` sat OUTSIDE the try/catch, so a database blip threw out
 * of this helper instead of degrading.
 *
 * That second point is the important one. Rate limiting is a guard, not the
 * operation: if the durable store cannot be reached, the honest fallback is
 * the in-memory limiter, NOT locking every athlete out of the platform. A
 * null return means "durable store unavailable or disabled" and every caller
 * below treats it as "fall back to volatile", never as "deny".
 */
async function withDurableClient<T>(work: (client: PoolClient) => Promise<T>): Promise<T | null> {
  if (!durableRateLimitEnabled() || !process.env.AZURE_POSTGRES_CONNECTION_STRING?.trim()) {
    return null;
  }

  try {
    return await withPoolClient(work);
  } catch (error) {
    // Includes connection acquisition, which the previous implementation let
    // escape. Nothing a rate-limit lookup does is worth failing a login for --
    // but the flag was ON and a connection string was present, so this is an
    // unexpected degradation to the weaker limiter, not the ordinary
    // flag-off path. Worth a line an operator can find, not worth failing on.
    console.warn('Durable rate limit unavailable, falling back to in-memory limiter', error);
    return null;
  }
}

// pilot.auth_rate_limit_buckets used to be created HERE, by
// `create table if not exists` issued from inside a request handler -- on the
// login path, which by definition runs before anyone has authenticated. So the
// first anonymous sign-in attempt against a fresh database executed DDL to
// bring the table into being, and the application needed `create table` rights
// on the one path an attacker reaches without credentials.
//
// That is the pattern #111 removed ("An anonymous request could execute DDL
// against production Postgres"). It was removed from the surface that made it
// obvious and survived here.
//
// The table is now created by infra/azure/pilot_slice_postgres_rate_limit_migration.sql,
// applied through the same gated workflow as every other migration.
//
// Nothing replaces this function, and nothing needs to. withDurableClient()
// returns null on ANY failure -- including a missing relation -- and every
// caller treats null as "fall back to the in-memory limiter", never as "deny".
// An environment that has not run the migration rate-limits in process memory
// instead of locking every athlete out, which is the same degradation the
// durable store already has for a database blip.

// How many rightmost X-Forwarded-For entries were written by our own
// infrastructure rather than by the caller.
//
// THE DEFAULT OF 1 IS THE PLATFORM CONTRACT, NOT A GUESS. Azure Container Apps
// documents exactly what it does to this header: "If specified in initial
// request, it is appended to. Only the rightmost IP is provided by Azure
// Container Apps. Any other values must be validated by the user to prevent IP
// spoofing."
// https://learn.microsoft.com/azure/container-apps/ingress-overview#http-headers
//
// So the ingress appends exactly one entry, and the count does not vary with
// how long the header is. A caller can send an arbitrarily long fabricated
// chain; the platform still appends one address, and one trusted hop still
// lands on it. Both PPBF environments run on Container Apps ingress, so 1 is
// correct in both.
//
// RAISING THIS IS THE HAZARD, and it is not hypothetical -- getClientIp's own
// comment below records the incident: reading one position further left
// returned attacker-controlled chain data and let a caller mint a fresh
// rate-limit bucket per request by rotating a forged header. Every entry left
// of the rightmost is, by the contract above, caller-written. There is no
// topology in this deployment that justifies a higher number, which is why no
// workflow sets this variable and .env.example does not carry it.
//
// A value only makes sense if PPBF ever sits behind an additional proxy that
// appends before Container Apps does (Front Door, a WAF, a CDN). Confirm the
// real hop count against a live request first; do not infer it from a diagram.
function trustedProxyCount(): number {
  const raw = process.env.PPBF_TRUSTED_PROXY_COUNT;
  const parsed = Number.parseInt(raw ?? '1', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
}

function normalizeIp(rawIp: string): string {
  const trimmed = rawIp.trim();
  if (!trimmed) {
    return 'unknown';
  }

  // IPv4 with port (`1.2.3.4:5678`) arrives in some proxy stacks.
  if (trimmed.includes(':') && !trimmed.includes(']') && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(trimmed)) {
    return trimmed.slice(0, trimmed.lastIndexOf(':'));
  }

  // RFC 7239 style quoted host or bracketed IPv6 with optional port.
  return trimmed.replace(/^"|"$/g, '').replace(/^\[(.*)\](?::\d+)?$/, '$1');
}

/**
 * Get the client IP address from the request
 */
export function getClientIp(request: Request): string {
  // Check headers in order of preference
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const ips = forwardedFor
      .split(',')
      .map((ip) => normalizeIp(ip))
      .filter((ip) => ip && ip !== 'unknown');

    const hops = trustedProxyCount();
    // Zero trusted hops means nothing appended this header on our side, so
    // every entry is client-written and none of it may key a rate-limit bucket.
    if (ips.length > 0 && hops > 0) {
      // Each trusted hop APPENDS its peer's address, so with N trusted hops the
      // real client sits at ips.length - N. Taking one position further left
      // returned attacker-controlled chain data, letting a client rotate a
      // fabricated X-Forwarded-For to get a fresh per-IP bucket every request.
      const index = Math.max(0, ips.length - hops);
      return ips[index] || ips[ips.length - 1] || 'unknown';
    }
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    return normalizeIp(realIp);
  }

  // Fallback: try to extract from URL or use a default
  return 'unknown';
}

/**
 * Clean up expired entries in the rate limit store
 */
function cleanupExpiredEntries(): void {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now - entry.lastAttempt > EXPIRY_MS) {
      rateLimitStore.delete(key);
    }
  }
}

/**
 * Check if a key (account or IP) is currently rate limited.
 * Returns { isLimited: true, delayMs: number } if limited.
 * Returns { isLimited: false } if not limited.
 */
export function checkRateLimit(key: string): { isLimited: boolean; delayMs?: number } {
  cleanupExpiredEntries();

  const entry = rateLimitStore.get(key);
  if (!entry) {
    return { isLimited: false };
  }

  const now = Date.now();
  if (now < entry.blockedUntil) {
    // Still within the backoff period
    const remainingMs = entry.blockedUntil - now;
    return { isLimited: true, delayMs: remainingMs };
  }

  // Backoff period has expired; allow retry
  return { isLimited: false };
}

/**
 * Record a failed attempt and update the rate limit.
 * Returns the delay (in ms) before the next attempt is allowed.
 */
export function recordFailedAttempt(key: string): { delayMs: number } {
  const now = Date.now();
  const entry = rateLimitStore.get(key) || { count: 0, lastAttempt: now, blockedUntil: now };

  entry.count += 1;
  entry.lastAttempt = now;

  // Calculate exponential backoff
  // Delay = INITIAL_BACKOFF_MS * (BACKOFF_MULTIPLIER ^ (max(0, count - MAX_ATTEMPTS_THRESHOLD)))
  const attemptsOverThreshold = Math.max(0, entry.count - MAX_ATTEMPTS_THRESHOLD);
  const delayMs = Math.min(INITIAL_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, attemptsOverThreshold), MAX_BACKOFF_MS);

  entry.blockedUntil = now + delayMs;
  rateLimitStore.set(key, entry);

  return { delayMs };
}

/**
 * Clear rate limit for a key (e.g., on successful authentication)
 */
export function clearRateLimit(key: string): void {
  rateLimitStore.delete(key);
}

export async function checkDurableRateLimit(key: string): Promise<{ isLimited: boolean; delayMs?: number }> {
  const result = await withDurableClient(async (client) => {
    const row = await client.query<{ blocked_until: Date }>(
      `select blocked_until
       from pilot.auth_rate_limit_buckets
       where bucket_key = $1`,
      [key],
    );

    if (row.rows.length === 0) {
      return { isLimited: false };
    }

    const now = Date.now();
    const blockedUntil = new Date(row.rows[0].blocked_until).getTime();
    if (blockedUntil > now) {
      return { isLimited: true, delayMs: blockedUntil - now };
    }

    return { isLimited: false };
  });

  return result ?? { isLimited: false };
}

export async function recordDurableFailedAttempt(key: string): Promise<{ delayMs: number }> {
  const fallback = recordFailedAttempt(key);

  const durableResult = await withDurableClient(async (client) => {

    await client.query(
      `delete from pilot.auth_rate_limit_buckets
       where updated_at < now() - ($1::int * interval '1 second')`,
      [DURABLE_WINDOW_SECONDS],
    );

    await client.query('begin');
    try {
      const existing = await client.query<{ attempt_count: number }>(
        `select attempt_count
         from pilot.auth_rate_limit_buckets
         where bucket_key = $1
         for update`,
        [key],
      );

      const attempts = (existing.rows[0]?.attempt_count ?? 0) + 1;
      const attemptsOverThreshold = Math.max(0, attempts - MAX_ATTEMPTS_THRESHOLD);
      const delayMs = Math.min(INITIAL_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, attemptsOverThreshold), MAX_BACKOFF_MS);

      await client.query(
        `insert into pilot.auth_rate_limit_buckets (bucket_key, attempt_count, blocked_until, updated_at)
         values ($1, $2, now() + ($3::int * interval '1 millisecond'), now())
         on conflict (bucket_key)
         do update set
           attempt_count = excluded.attempt_count,
           blocked_until = excluded.blocked_until,
           updated_at = now()`,
        [key, attempts, delayMs],
      );

      await client.query('commit');
      return { delayMs };
    } catch {
      await client.query('rollback').catch(() => {});
      return null;
    }
  });

  return durableResult ?? fallback;
}

export async function clearDurableRateLimit(key: string): Promise<void> {
  clearRateLimit(key);

  await withDurableClient(async (client) => {
    await client.query(
      `delete from pilot.auth_rate_limit_buckets
       where bucket_key = $1`,
      [key],
    );
    return true;
  });
}

/**
 * Get rate limit status for monitoring/debugging
 */
export function getRateLimitStatus(key: string): {
  count: number;
  blockedUntil: number | null;
  isCurrentlyLimited: boolean;
} {
  const entry = rateLimitStore.get(key);
  if (!entry) {
    return { count: 0, blockedUntil: null, isCurrentlyLimited: false };
  }

  const now = Date.now();
  return {
    count: entry.count,
    blockedUntil: entry.blockedUntil > now ? entry.blockedUntil : null,
    isCurrentlyLimited: now < entry.blockedUntil,
  };
}
