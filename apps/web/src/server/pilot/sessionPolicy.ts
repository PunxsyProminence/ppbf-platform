// Single source of truth for session absolute lifetime. Every place that
// mints a session token, sets a session cookie, or checks expiry must derive
// its value from this constant so the database record and the cookie can
// never drift apart.
export const SESSION_ABSOLUTE_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_LIFETIME_SECONDS = SESSION_ABSOLUTE_LIFETIME_MS / 1000;

export function computeSessionExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + SESSION_ABSOLUTE_LIFETIME_MS);
}

// Generous but finite safety cap for session-cleanup retention, so an
// operator (or a malformed argument) can't request an effectively-infinite
// retention window that defeats cleanup entirely.
export const MAX_SESSION_RETENTION_DAYS = 3650;

// Validates a retention-days value at the service boundary -- shared by
// cleanupExpiredSessions itself and by its CLI wrapper, so both reject the
// exact same malformed input (e.g. "7abc", decimals, zero, negative, NaN,
// values beyond MAX_SESSION_RETENTION_DAYS) instead of silently coercing it.
export function parseRetentionDays(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_SESSION_RETENTION_DAYS) {
      throw new Error(`Invalid retention days: ${value}`);
    }
    return value;
  }

  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_SESSION_RETENTION_DAYS) {
      return parsed;
    }
  }

  throw new Error(`Invalid retention days: ${String(value)}`);
}
