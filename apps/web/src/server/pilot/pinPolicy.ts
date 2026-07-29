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
 *
 * The invariant that makes all of the above true: this PIN is only ever written
 * alongside must_change_pin = true. Any path where a PIN is CHOSEN rather than
 * issued must refuse it -- see assertChosenPinAllowed.
 */
export const DEFAULT_FIRST_LOGIN_PIN = '123456';

/**
 * Refuses a PIN that someone is choosing for themselves, as opposed to one the
 * platform issues as a bootstrap credential.
 *
 * Deliberately NOT folded into validatePinPolicy: the admin PIN-reset flow
 * legitimately sets DEFAULT_FIRST_LOGIN_PIN, and validatePinPolicy is on that
 * path. The distinction is not the value, it is whether must_change_pin is being
 * set with it.
 *
 * Without this, an athlete could change their PIN back to the starting PIN,
 * which clears must_change_pin and leaves the account reachable by anyone who
 * knows the sign-in ID -- on a PIN that is published in this file and printed in
 * the admin UI. It is also the first PIN anyone would guess.
 */
export function assertChosenPinAllowed(pin: string): void {
  if (pin.trim() === DEFAULT_FIRST_LOGIN_PIN) {
    throw new Error('That is the starting PIN everyone is given. Choose a different one.');
  }
}

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