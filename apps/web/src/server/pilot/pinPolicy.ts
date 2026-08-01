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

/**
 * Trivially guessable shapes, rejected regardless of who is setting the PIN.
 *
 * Six digits is a million combinations only if they are chosen uniformly, and
 * nobody chooses uniformly. The brute-force budget that matters is not 10^6,
 * it is the few dozen patterns a person actually picks -- which is why this
 * matters more than the digit count.
 *
 * DEFAULT_FIRST_LOGIN_PIN is deliberately NOT rejected here. The admin
 * PIN-reset flow legitimately issues it, and validatePinPolicy sits on that
 * path; refusing it would break the reset. What stops it being a way in is
 * must_change_pin, plus assertChosenPinAllowed refusing it on the path where
 * somebody CHOOSES their own -- the same split this file already draws.
 */
function isTriviallyGuessablePin(pin: string): boolean {
  // All one digit: 000000, 111111, ...
  if (/^(\d)\1+$/.test(pin)) return true;

  // Ascending or descending runs, with wraparound: 123456, 654321, 890123.
  const ascending = '01234567890123456789';
  const descending = '98765432109876543210';
  if (ascending.includes(pin) || descending.includes(pin)) return true;

  // Short repeating cycles: 121212 (2), 123123 (3), 112233 is not a cycle but
  // is caught by the pair rule below.
  for (const size of [1, 2, 3]) {
    const unit = pin.slice(0, size);
    if (unit.repeat(DEFAULT_PIN_LENGTH / size) === pin) return true;
  }

  // Doubled digits: 112233, 445566.
  if (/^(\d)\1(\d)\2(\d)\3$/.test(pin)) return true;

  // Palindromes of the 123321 / 456654 shape.
  if (pin === [...pin].reverse().join('')) return true;

  return false;
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

  // Checked after the shape rules so the message a caller sees is the most
  // specific one, and skipped for the issued bootstrap PIN as described above.
  if (normalized !== DEFAULT_FIRST_LOGIN_PIN && isTriviallyGuessablePin(normalized)) {
    throw new Error('That PIN is too easy to guess. Avoid repeated digits, runs, and simple patterns.');
  }
}