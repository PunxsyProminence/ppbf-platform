export const DEFAULT_PIN_LENGTH = 6;

/**
 * The PIN every new athlete account starts on.
 *
 * This is a bootstrap credential, not a secret: it is public knowledge by
 * design, so an admin can say it out loud instead of shepherding a one-time
 * activation code. What stops it being a way in is accounts.must_change_pin --
 * while that flag is set requirePrincipal refuses every route except the PIN
 * change itself, so a session opened with this PIN can read nothing about the
 * athlete. It satisfies validatePinPolicy below, so no caller needs a special
 * case for it.
 *
 * It is still guessable for the window between the admin creating the account
 * and the athlete first signing in. Shortening that window is an operational
 * matter -- create the account when you are with the athlete, not in a batch
 * the week before.
 */
export const DEFAULT_FIRST_LOGIN_PIN = '123456';

export function validatePinPolicy(pin: string): void {
  const normalized = pin.trim();
  if (!normalized) {
    throw new Error('PIN is required');
  }

  if (!/^\d+$/.test(normalized)) {
    throw new Error('PIN must contain only digits');
  }

  if (normalized.length !== DEFAULT_PIN_LENGTH) {
    throw new Error(`PIN must be exactly ${DEFAULT_PIN_LENGTH} digits`);
  }
}