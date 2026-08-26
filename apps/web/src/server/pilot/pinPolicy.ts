import { ValidationError } from './errors';

export const DEFAULT_PIN_LENGTH = 6;

/**
 * Retired shared bootstrap PIN. Kept only so login can fail closed against
 * legacy rows and migrations can identify them; no creation/reset path may
 * issue it.
 */
export const DEFAULT_FIRST_LOGIN_PIN = '123456';

/**
 * Refuses a PIN that someone is choosing for themselves, as opposed to one the
 * platform issues as a bootstrap credential.
 *
 * Also enforced by validatePinPolicy so no future caller can reissue it.
 *
 * Without this, an athlete could change their PIN back to the starting PIN,
 * which clears must_change_pin and leaves the account reachable by anyone who
 * knows the sign-in ID -- on a PIN that is published in this file and printed in
 * the admin UI. It is also the first PIN anyone would guess.
 *
 * The message must reach the athlete, so this throws ValidationError rather
 * than Error: jsonError returns a PilotError's own status with its message
 * intact. This used to depend on the message LEADING with "PIN", which
 * jsonError prefix-matched to a 400 -- and the trivially-guessable check
 * eleven lines below the old note began with "That", so it 500'd and told the
 * athlete nothing. Carrying the status on the type removes the spelling from
 * the contract.
 */
export function assertChosenPinAllowed(pin: string): void {
  if (pin.trim() === DEFAULT_FIRST_LOGIN_PIN) {
    throw new ValidationError(
      'PIN cannot be the starting PIN everyone is given. Choose a different one.',
      'PIN_IS_DEFAULT_FIRST_LOGIN',
    );
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
 * The retired bootstrap value is rejected before this helper runs.
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
    throw new ValidationError('PIN is required', 'PIN_REQUIRED');
  }

  if (!/^\d+$/.test(normalized)) {
    throw new ValidationError('PIN must contain only digits', 'PIN_NOT_NUMERIC');
  }

  if (normalized.length !== DEFAULT_PIN_LENGTH) {
    throw new ValidationError(`PIN must be exactly ${DEFAULT_PIN_LENGTH} digits`, 'PIN_WRONG_LENGTH');
  }

  assertChosenPinAllowed(normalized);

  // Checked after format and retired-credential rules.
  if (isTriviallyGuessablePin(normalized)) {
    throw new ValidationError(
      'That PIN is too easy to guess. Avoid repeated digits, runs, and simple patterns.',
      'PIN_TRIVIALLY_GUESSABLE',
    );
  }
}
