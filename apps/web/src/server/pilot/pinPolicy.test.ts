import {
  DEFAULT_FIRST_LOGIN_PIN,
  DEFAULT_PIN_LENGTH,
  assertChosenPinAllowed,
  validatePinPolicy,
} from './pinPolicy';

describe('PIN policy', () => {
  describe('shape', () => {
    test.each([
      ['empty', '', 'PIN is required'],
      ['letters', 'abc123', 'only digits'],
      ['too short', '12345', `exactly ${DEFAULT_PIN_LENGTH} digits`],
      ['too long', '1234567', `exactly ${DEFAULT_PIN_LENGTH} digits`],
    ])('rejects %s', (_label, pin, expected) => {
      expect(() => validatePinPolicy(pin)).toThrow(expected);
    });

    test('accepts an ordinary six-digit PIN', () => {
      expect(() => validatePinPolicy('284917')).not.toThrow();
    });
  });

  // Six digits is a million combinations only if chosen uniformly, and nobody
  // chooses uniformly. The brute-force budget that matters is not 10^6, it is
  // the few dozen patterns people actually pick -- which makes this matter
  // more than the digit count, especially while the login limiter's backoff
  // tops out at 60s.
  describe('trivially guessable PINs', () => {
    test.each([
      ['all one digit', '000000'],
      ['all one digit, nonzero', '111111'],
      ['ascending run', '234567'],
      ['descending run', '654321'],
      ['ascending with wraparound', '890123'],
      ['two-digit cycle', '121212'],
      ['three-digit cycle', '123123'],
      ['doubled digits', '112233'],
      ['doubled digits, higher', '445566'],
      ['palindrome', '123321'],
      ['palindrome, other', '456654'],
    ])('rejects %s', (_label, pin) => {
      expect(() => validatePinPolicy(pin)).toThrow('too easy to guess');
    });

    test.each([
      ['a scattered PIN', '284917'],
      ['one with a repeated digit but no pattern', '283917'],
      ['one that starts like a run but breaks', '123597'],
    ])('still accepts %s', (_label, pin) => {
      expect(() => validatePinPolicy(pin)).not.toThrow();
    });
  });

  describe('the retired bootstrap PIN', () => {
    test('validatePinPolicy rejects it everywhere', () => {
      expect(() => validatePinPolicy(DEFAULT_FIRST_LOGIN_PIN)).toThrow('starting PIN');
    });

    test('assertChosenPinAllowed still refuses it when somebody picks it', () => {
      expect(() => assertChosenPinAllowed(DEFAULT_FIRST_LOGIN_PIN))
        .toThrow('starting PIN everyone is given');
    });

    test('an athlete choosing their own PIN faces both checks', () => {
      // The change-PIN path runs both. Neither alone is sufficient:
      // assertChosenPinAllowed blocks only the default, validatePinPolicy
      // blocks the rest of the guessable space.
      expect(() => assertChosenPinAllowed('111111')).not.toThrow();
      expect(() => validatePinPolicy('111111')).toThrow('too easy to guess');
    });
  });
});
