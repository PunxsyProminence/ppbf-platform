import { computeSessionExpiry, MAX_SESSION_RETENTION_DAYS, parseRetentionDays, SESSION_ABSOLUTE_LIFETIME_MS } from './sessionPolicy';

describe('computeSessionExpiry', () => {
  test('adds exactly the 24-hour absolute lifetime', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const expiry = computeSessionExpiry(from);
    expect(expiry.getTime() - from.getTime()).toBe(SESSION_ABSOLUTE_LIFETIME_MS);
    expect(SESSION_ABSOLUTE_LIFETIME_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('parseRetentionDays', () => {
  test('accepts a valid positive integer number', () => {
    expect(parseRetentionDays(7)).toBe(7);
  });

  test('accepts a valid positive integer string', () => {
    expect(parseRetentionDays('30')).toBe(30);
  });

  test('accepts the maximum allowed value', () => {
    expect(parseRetentionDays(MAX_SESSION_RETENTION_DAYS)).toBe(MAX_SESSION_RETENTION_DAYS);
  });

  test('rejects a value with trailing non-numeric characters (e.g. "7abc")', () => {
    expect(() => parseRetentionDays('7abc')).toThrow('Invalid retention days');
  });

  test('rejects a value with leading non-numeric characters', () => {
    expect(() => parseRetentionDays('abc7')).toThrow('Invalid retention days');
  });

  test('rejects a decimal string', () => {
    expect(() => parseRetentionDays('7.5')).toThrow('Invalid retention days');
  });

  test('rejects a decimal number', () => {
    expect(() => parseRetentionDays(7.5)).toThrow('Invalid retention days');
  });

  test('rejects zero', () => {
    expect(() => parseRetentionDays(0)).toThrow('Invalid retention days');
    expect(() => parseRetentionDays('0')).toThrow('Invalid retention days');
  });

  test('rejects a negative number', () => {
    expect(() => parseRetentionDays(-5)).toThrow('Invalid retention days');
  });

  test('rejects a negative string (the leading "-" is not a digit)', () => {
    expect(() => parseRetentionDays('-5')).toThrow('Invalid retention days');
  });

  test('rejects NaN', () => {
    expect(() => parseRetentionDays(Number.NaN)).toThrow('Invalid retention days');
  });

  test('rejects a value beyond the safe maximum', () => {
    expect(() => parseRetentionDays(MAX_SESSION_RETENTION_DAYS + 1)).toThrow('Invalid retention days');
  });

  test('rejects an unsafe/astronomically large numeric string', () => {
    expect(() => parseRetentionDays('999999999999999999999')).toThrow('Invalid retention days');
  });

  test('rejects an empty string', () => {
    expect(() => parseRetentionDays('')).toThrow('Invalid retention days');
  });

  test('rejects non-string, non-number input', () => {
    expect(() => parseRetentionDays(undefined)).toThrow('Invalid retention days');
    expect(() => parseRetentionDays(null)).toThrow('Invalid retention days');
  });
});
