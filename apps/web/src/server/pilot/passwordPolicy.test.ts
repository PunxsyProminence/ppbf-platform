import { ValidationError } from './errors';
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PASSWORD_RULES_REFUSED_EXAMPLES,
  PASSWORD_RULE_SUMMARY,
  validatePasswordPolicy,
} from './passwordPolicy';

function refusalCode(password: string, loginEmail?: string): string | null {
  try {
    validatePasswordPolicy(password, { loginEmail });
    return null;
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return error.code ?? 'NO_CODE';
  }
}

describe('password policy', () => {
  test('the minimum is ten characters (Jason 2026-10-01), and ten is enough', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(10);
    expect(refusalCode('tr4il mix!')).toBeNull();
    expect(refusalCode('tr4il mix')).toBe('PASSWORD_TOO_SHORT');
  });

  test('no composition rules: all lower-case letters, or words with spaces, are accepted', () => {
    expect(refusalCode('greenhousekettle')).toBeNull();
    expect(refusalCode('three small boats')).toBeNull();
  });

  test('length is counted in characters, not UTF-16 units', () => {
    // Five emoji are ten UTF-16 units and five characters.
    expect(refusalCode('\u{1F94A}'.repeat(5))).toBe('PASSWORD_TOO_SHORT');
  });

  test('the maximum is refused past, and accepted at', () => {
    const filler = 'kettle-drum-harbor-'.repeat(10);
    expect(refusalCode(filler.slice(0, MAX_PASSWORD_LENGTH))).toBeNull();
    expect(refusalCode(filler.slice(0, MAX_PASSWORD_LENGTH + 1))).toBe('PASSWORD_TOO_LONG');
  });

  test('empty is its own refusal', () => {
    expect(refusalCode('')).toBe('PASSWORD_REQUIRED');
  });

  test.each([
    ['a common password', 'password123'],
    ['a common password in capitals', 'PASSWORD123'],
    ['a keyboard run', 'qwertyuiop'],
    ['a digit run', '1234567890'],
    ['one character repeated', 'aaaaaaaaaaaa'],
    ['the gym name with a year', 'Punxsy2026!!'],
    ['the gym name with digits in front', '2026prominence'],
    ['the word password dressed up', '!!Password2026'],
    ['the gym name spelled out with a year', 'Punxsy Prominence 2026'],
    ['two gym words joined by a symbol', 'punxsy-boxing1'],
  ])('%s is too guessable: %s', (_label, password) => {
    expect(refusalCode(password)).toBe('PASSWORD_TOO_GUESSABLE');
  });

  test('the email name with numbers added is refused, for that account only', () => {
    expect(refusalCode('mariagarcia2026', 'mariagarcia@example.com')).toBe('PASSWORD_TOO_GUESSABLE');
    expect(refusalCode('mariagarcia2026', 'Maria.Garcia@example.com')).toBe('PASSWORD_TOO_GUESSABLE');
    expect(refusalCode('mariagarcia2026', 'someone.else@example.com')).toBeNull();
  });

  test('the sign-in email itself is refused as a password', () => {
    expect(refusalCode('Maria.Garcia@Example.com', 'maria.garcia@example.com')).toBe('PASSWORD_TOO_GUESSABLE');
  });

  test('an email name of three letters counts; one of two does not', () => {
    expect(refusalCode('1234-ann-5678', 'ann@example.com')).toBe('PASSWORD_TOO_GUESSABLE');
    expect(refusalCode('1234-jo-56789', 'jo@example.com')).toBeNull();
  });

  test('a body-sized string is refused before it is walked', () => {
    expect(refusalCode('x'.repeat(MAX_PASSWORD_LENGTH * 4 + 1))).toBe('PASSWORD_TOO_LONG');
  });

  test('a gym word inside a longer password is fine; only the bare word plus padding is refused', () => {
    expect(refusalCode('boxing on tuesdays')).toBeNull();
  });

  // The sentence on the page and the check behind it, held together.
  test('every example the rule sentence promises is refused, and the sentence names the two it quotes', () => {
    for (const example of PASSWORD_RULES_REFUSED_EXAMPLES) {
      expect(refusalCode(example)).toBe('PASSWORD_TOO_GUESSABLE');
    }
    expect(PASSWORD_RULE_SUMMARY).toContain(`At least ${MIN_PASSWORD_LENGTH} characters`);
    expect(PASSWORD_RULE_SUMMARY).toContain(PASSWORD_RULES_REFUSED_EXAMPLES[0]);
    expect(PASSWORD_RULE_SUMMARY).toContain(PASSWORD_RULES_REFUSED_EXAMPLES[1]);
  });

  test('a refusal reaches the caller as a 400 with its message, not a 500', () => {
    let thrown: unknown;
    try {
      validatePasswordPolicy('short');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as ValidationError).status).toBe(400);
  });
});
