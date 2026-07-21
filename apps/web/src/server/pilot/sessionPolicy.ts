// Single source of truth for session absolute lifetime. Every place that
// mints a session token, sets a session cookie, or checks expiry must derive
// its value from this constant so the database record and the cookie can
// never drift apart.
export const SESSION_ABSOLUTE_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_LIFETIME_SECONDS = SESSION_ABSOLUTE_LIFETIME_MS / 1000;

export function computeSessionExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + SESSION_ABSOLUTE_LIFETIME_MS);
}
