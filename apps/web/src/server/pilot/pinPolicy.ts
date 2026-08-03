import { randomInt } from 'node:crypto';

export const DEFAULT_PIN_LENGTH = 6;

/**
 * @deprecated Nothing issues this any more. Kept only so the message below can
 * name it, and so an operator searching for "123456" finds this explanation.
 *
 * This used to be the PIN every new athlete account started on: one shared,
 * published value, relying on accounts.must_change_pin to make it harmless.
 * The flag did its job -- a session on the starting PIN could read nothing --
 * but it never closed the window between an admin creating the account and the
 * athlete first signing in. During that window, `ath-001` + `123456` was a
 * guess anyone could make, and provisioning forty accounts a week ahead of a
 * pilot widened it forty-fold.
 *
 * Starting PINs are now generated per athlete -- see generateStartingPin.
 */
export const LEGACY_SHARED_FIRST_LOGIN_PIN = '123456';

/**
 * A starting PIN for one athlete account.
 *
 * Uses randomInt (CSPRNG) rather than Math.random: this is a credential, and
 * Math.random is both predictable from prior outputs and seeded per process, so
 * a batch of accounts provisioned in one run would be correlated.
 *
 * Rejects the same trivially-guessable shapes a person choosing a PIN is
 * refused. Not because the generator is likely to produce one -- it is a few
 * hundred values out of a million -- but because "the platform issued me 111111"
 * is indistinguishable to an operator from a bug, and because those shapes are
 * exactly what an attacker guesses first.
 *
 * Still paired with must_change_pin = true. That invariant has not changed and
 * must not: this PIN is issued, never chosen, and the athlete replaces it on
 * first sign-in.
 */
export function generateStartingPin(): string {
  // Bounded rather than `while (true)`: the rejected set is a tiny fraction of
  // the space, so exhausting this many draws means the generator is broken, and
  // looping forever inside a request handler would turn that into a hang.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let pin = '';
    for (let digit = 0; digit < DEFAULT_PIN_LENGTH; digit += 1) {
      pin += String(randomInt(10));
    }

    if (!isTriviallyGuessablePin(pin)) {
      return pin;
    }
  }

  throw new Error('Could not generate a starting PIN');
}

/**
 * Refuses a PIN that someone is choosing for themselves, as opposed to one the
 * platform issues as a bootstrap credential.
 *
 * Now that starting PINs are generated per athlete there is no single value to
 * refuse, and the shape rules in validatePinPolicy already reject the old shared
 * `123456` as an ascending run. What remains worth refusing explicitly is an
 * athlete "changing" their PIN to the one they were just issued: that clears
 * must_change_pin while leaving the account on a credential their admin has
 * seen, written down, and possibly read aloud.
 *
 * Callers pass the CURRENT pin because only they have it -- changeOwnPin has
 * already taken it from the athlete to authenticate the change, so comparing
 * here costs nothing and needs no database read.
 *
 * The message has to lead with "PIN" like the ones in validatePinPolicy:
 * jsonError maps that prefix to a 400 carrying the text, and anything else to a
 * 500 "Internal server error", which would tell the athlete nothing about why
 * their chosen PIN was refused.
 */
export function assertChosenPinAllowed(pin: string, currentPin?: string): void {
  const normalized = pin.trim();

  if (currentPin !== undefined && normalized === currentPin.trim()) {
    throw new Error('PIN cannot be the one you were given to sign in with. Choose a different one.');
  }

  if (normalized === LEGACY_SHARED_FIRST_LOGIN_PIN) {
    throw new Error('PIN cannot be the old shared starting PIN. Choose a different one.');
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
 * The old shared `123456` used to be exempted here, because the admin reset flow
 * issued it and validatePinPolicy sits on that path. Generated starting PINs are
 * screened through these same rules before they are ever issued, so nothing
 * legitimate needs the exemption any more -- and without it `123456` is caught as
 * the ascending run it always was, on every path, including an admin trying to
 * set it by hand from the PIN console.
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
  // specific one. No value is exempt -- see the note on isTriviallyGuessablePin.
  if (isTriviallyGuessablePin(normalized)) {
    throw new Error('That PIN is too easy to guess. Avoid repeated digits, runs, and simple patterns.');
  }
}