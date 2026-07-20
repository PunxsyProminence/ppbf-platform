/**
 * Rate limiting utility for PIN-based authentication endpoints.
 * Prevents brute force attacks with per-account and per-IP exponential backoff.
 *
 * In production, this should be backed by Redis or similar distributed cache.
 * This in-memory implementation is suitable for development and single-instance deployments.
 */

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

/**
 * Get the client IP address from the request
 */
export function getClientIp(request: Request): string {
  // Check headers in order of preference
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    // x-forwarded-for can be a comma-separated list; take the last one (client IP)
    const ips = forwardedFor.split(',').map((ip) => ip.trim());
    return ips[ips.length - 1] || 'unknown';
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    return realIp;
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
