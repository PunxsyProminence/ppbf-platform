import { ValidationError } from './errors';

/**
 * What a parent's password must be. Length, and not one of the handful
 * everybody picks -- no forced capitals, digits or symbols (Jason, 2026-10-01,
 * minimum length question: "agree with recomendations" -> 10 characters, no
 * composition rules).
 *
 * Imported by the page that asks for a password as well as the route that
 * stores one, so it stays free of server-only dependencies.
 */
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;

/**
 * Passwords of ten characters or more that are still the first guesses.
 *
 * Written here, not taken from a published breach corpus: the repository
 * carries none and this calls no outside service. It is a floor against the
 * obvious, and the length rule and the sign-in rate limit do the rest.
 * Compared lower-cased.
 */
const COMMON_PASSWORDS: readonly string[] = [
  '1234567890', '0123456789', '12345678910', '1234567891', '0987654321', '9876543210',
  '1q2w3e4r5t', '1qaz2wsx3edc', 'qwertyuiop', 'qwerty12345', 'qwerty123456', 'qwertyuiop123',
  'asdfghjkl1', 'zxcvbnm123', 'abcdefghij', 'abc1234567', 'abcd123456', 'a123456789',
  'password12', 'password123', 'password1234', 'passwordpassword', 'iloveyou123', 'iloveyou12',
  'letmein123', 'welcome123', 'welcome1234', 'football123', 'baseball123', 'sunshine123',
  'princess123', 'superman123', 'changeme123', 'trustno1trustno1',
];

/**
 * Words that are a password only with digits, spaces or symbols added, here: the
 * gym's own name in the forms a parent would type, and the two generic ones.
 * "Punxsy2026!!" is the first thing a stranger who knows the gym would try.
 */
const WEAK_BASE_WORDS: readonly string[] = [
  'password', 'qwerty', 'ppbf', 'punxsy', 'punxsutawney', 'prominence', 'boxing',
  'punxsyprominence', 'punxsyboxing', 'prominenceboxing', 'punxsyprominenceboxing',
];

/** Only the letters a-z, lower-cased: "Punxsy-Prominence 2026!" is "punxsyprominence". */
function lettersOnly(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, '');
}

export interface PasswordContext {
  /** The account's sign-in email. Neither it nor its name part may be the password. */
  loginEmail?: string | null;
}

/**
 * Shown on the page beside the field, and built from the same constants the
 * check reads -- passwordPolicy.test.ts asserts every example here is refused
 * (the PIN_RULE_SUMMARY arrangement, for the same reason).
 */
export const PASSWORD_RULES_REFUSED_EXAMPLES = ['password123', '1234567890', 'Punxsy2026!!'] as const;

export const PASSWORD_RULE_SUMMARY =
  `At least ${MIN_PASSWORD_LENGTH} characters. Any letters, numbers, spaces or symbols you like — a few words `
  + `together works well. Not a common one such as ${PASSWORD_RULES_REFUSED_EXAMPLES[0]} or `
  + `${PASSWORD_RULES_REFUSED_EXAMPLES[1]}, and not the gym's name or your email name with numbers added.`;

export function validatePasswordPolicy(password: string, context: PasswordContext = {}): void {
  // Before anything walks the string: a body of megabytes is not a password.
  if (password.length > MAX_PASSWORD_LENGTH * 4) {
    throw new ValidationError(
      `Password must be at most ${MAX_PASSWORD_LENGTH} characters`,
      'PASSWORD_TOO_LONG',
    );
  }

  // Counted in code points, not UTF-16 units, on the same NFKC form
  // hashPassword hashes.
  const normalized = password.normalize('NFKC');
  const length = [...normalized].length;

  if (length === 0) {
    throw new ValidationError('Password is required', 'PASSWORD_REQUIRED');
  }
  if (length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      'PASSWORD_TOO_SHORT',
    );
  }
  if (length > MAX_PASSWORD_LENGTH) {
    throw new ValidationError(
      `Password must be at most ${MAX_PASSWORD_LENGTH} characters`,
      'PASSWORD_TOO_LONG',
    );
  }

  const lowered = normalized.toLowerCase();
  const letters = lettersOnly(normalized);
  const loginEmail = (context.loginEmail ?? '').trim().toLowerCase();
  const emailName = lettersOnly(loginEmail.split('@')[0] ?? '');

  if (
    new Set(lowered).size === 1
    || COMMON_PASSWORDS.includes(lowered)
    || WEAK_BASE_WORDS.includes(letters)
    || (loginEmail !== '' && lowered === loginEmail)
    // An email name of one or two letters is not a base word: "jo" would
    // refuse every password whose only letters happen to be those two.
    || (emailName.length >= 3 && letters === emailName)
  ) {
    throw new ValidationError(
      'That password is too easy to guess. Choose something longer or less obvious.',
      'PASSWORD_TOO_GUESSABLE',
    );
  }
}
