// Sign-in ID enumeration by timing. loginWithAccountIdAndPin used to return
// on an unknown, inactive, suspended or PIN-less account BEFORE any hashing,
// while a live account with a wrong PIN paid a full scrypt verification. The
// login route is unauthenticated, so the difference in response time told an
// outside caller which sign-in IDs are real before they started guessing PINs.
//
// These pin the repair: every rejection path runs exactly one verifyPin, an
// account with no stored hash is checked against one cached throwaway hash,
// and the reason-code logging and the retired-PIN refusal are unchanged.
//
// Its own file, not a case in auth.sessionCreation.test.ts, because the
// throwaway hash is cached per module instance: a fresh module here means the
// "built once" assertion counts from zero.

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  isLoopbackPostgresConnectionString: jest.requireActual('./db').isLoopbackPostgresConnectionString,
}));

jest.mock('./security', () => ({
  createOpaqueToken: jest.fn(() => 'opaque-token'),
  hashToken: jest.fn(() => 'hashed-token'),
  hashPin: jest.fn(async () => 'scrypt$throwaway-salt$00'),
  verifyPin: jest.fn(async () => false),
}));

import { loginWithAccountIdAndPin } from './auth';
import { query, queryOne } from './db';
import { hashPin, verifyPin } from './security';

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockHashPin = hashPin as jest.Mock;
const mockVerifyPin = verifyPin as jest.Mock;

const THROWAWAY_HASH = 'scrypt$throwaway-salt$00';

let warn: jest.SpyInstance;

beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
  mockQuery.mockReset();
  mockQueryOne.mockReset();
  mockVerifyPin.mockReset();
  mockVerifyPin.mockResolvedValue(false);
});

function athleteRow(overrides: Record<string, unknown> = {}) {
  return {
    account_id: 'ath-1',
    role: 'athlete',
    organization_id: 'org-1',
    is_platform_owner: false,
    athlete_id: 'a-1',
    auth_provider: 'ppbf_local',
    pin_hash: 'scrypt$real-salt$11',
    must_change_pin: false,
    active_flag: true,
    account_deleted: false,
    has_master_shadow_access: false,
    organization_status: 'active',
    holds_board_seat: false,
    ...overrides,
  };
}

function loggedReasons(): unknown[] {
  return warn.mock.calls
    .filter(([message]) => message === 'pilot-auth login rejected')
    .map(([, detail]) => (detail as { reason: unknown }).reason);
}

describe('every login rejection pays the same PIN check', () => {
  test('an unknown sign-in ID still runs one PIN verification, against the throwaway hash', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const result = await loginWithAccountIdAndPin('no-such-athlete', '482913');

    expect(result).toBeNull();
    expect(mockVerifyPin).toHaveBeenCalledTimes(1);
    expect(mockVerifyPin).toHaveBeenCalledWith('482913', THROWAWAY_HASH);
    expect(loggedReasons()).toEqual(['unknown_or_inactive_account']);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('the throwaway hash is built once and reused, not re-hashed per request', async () => {
    mockQueryOne.mockResolvedValue(null);

    await loginWithAccountIdAndPin('no-such-1', '482913');
    await loginWithAccountIdAndPin('no-such-2', '482913');
    await loginWithAccountIdAndPin('no-such-3', '482913');

    // Each lookup would otherwise cost two scrypt runs (hash + verify) against
    // a real account's one -- a gap of its own.
    expect(mockHashPin).toHaveBeenCalledTimes(1);
    expect(mockVerifyPin).toHaveBeenCalledTimes(3);
  });

  test('an inactive account is checked against its own hash, then refused with its reason code', async () => {
    mockQueryOne.mockResolvedValueOnce(athleteRow({ active_flag: false }));

    const result = await loginWithAccountIdAndPin('ath-1', '482913');

    expect(result).toBeNull();
    expect(mockVerifyPin).toHaveBeenCalledTimes(1);
    expect(mockVerifyPin).toHaveBeenCalledWith('482913', 'scrypt$real-salt$11');
    expect(loggedReasons()).toEqual(['unknown_or_inactive_account']);
  });

  // Sign-in refuses any account marked deleted (OD-2026-09-29-003 Q9). The
  // case that matters is an account an admin path set active again: the
  // right PIN, active, and still refused -- after the same one verification.
  test('an account marked deleted is refused after the same one PIN check, even active with the right PIN', async () => {
    mockQueryOne.mockResolvedValueOnce(athleteRow({ account_deleted: true }));
    mockVerifyPin.mockResolvedValueOnce(true);

    const result = await loginWithAccountIdAndPin('ath-1', '482913');

    expect(result).toBeNull();
    expect(mockVerifyPin).toHaveBeenCalledTimes(1);
    expect(mockVerifyPin).toHaveBeenCalledWith('482913', 'scrypt$real-salt$11');
    expect(loggedReasons()).toEqual(['deleted_account']);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('an account marked deleted with a wrong PIN logs the deletion, after one PIN check', async () => {
    mockQueryOne.mockResolvedValueOnce(athleteRow({ account_deleted: true, active_flag: false }));

    const result = await loginWithAccountIdAndPin('ath-1', '000111');

    expect(result).toBeNull();
    expect(mockVerifyPin).toHaveBeenCalledTimes(1);
    expect(loggedReasons()).toEqual(['deleted_account']);
  });

  // Fail closed: a row that does not say it is not deleted is treated as
  // deleted, so a query that forgot to select the flag admits nobody.
  test('a row with no deletion flag at all is refused as deleted', async () => {
    const row: Record<string, unknown> = athleteRow();
    delete row.account_deleted;
    mockQueryOne.mockResolvedValueOnce(row);
    mockVerifyPin.mockResolvedValueOnce(true);

    const result = await loginWithAccountIdAndPin('ath-1', '482913');

    expect(result).toBeNull();
    expect(loggedReasons()).toEqual(['deleted_account']);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('an account in a suspended organization still pays the PIN check before being refused', async () => {
    mockQueryOne.mockResolvedValueOnce(athleteRow({ organization_status: 'suspended' }));

    const result = await loginWithAccountIdAndPin('ath-1', '482913');

    expect(result).toBeNull();
    expect(mockVerifyPin).toHaveBeenCalledTimes(1);
    expect(loggedReasons()).toEqual(['organization_not_active']);
  });

  test('an account with no PIN set is checked against the throwaway hash, then refused', async () => {
    mockQueryOne.mockResolvedValueOnce(athleteRow({ pin_hash: null }));

    const result = await loginWithAccountIdAndPin('ath-1', '482913');

    expect(result).toBeNull();
    expect(mockVerifyPin).toHaveBeenCalledTimes(1);
    expect(mockVerifyPin).toHaveBeenCalledWith('482913', THROWAWAY_HASH);
    expect(loggedReasons()).toEqual(['no_pin_set']);
  });

  test('the retired shared PIN is still refused even when it matches the stored hash', async () => {
    mockQueryOne.mockResolvedValueOnce(athleteRow({ must_change_pin: true }));
    mockVerifyPin.mockResolvedValueOnce(true);

    const result = await loginWithAccountIdAndPin('ath-1', '123456');

    expect(result).toBeNull();
    expect(mockVerifyPin).toHaveBeenCalledTimes(1);
    expect(loggedReasons()).toEqual(['retired_shared_bootstrap_pin']);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a live account with a wrong PIN runs the check once, not twice', async () => {
    mockQueryOne.mockResolvedValueOnce(athleteRow());

    const result = await loginWithAccountIdAndPin('ath-1', '000111');

    expect(result).toBeNull();
    expect(mockVerifyPin).toHaveBeenCalledTimes(1);
    expect(mockVerifyPin).toHaveBeenCalledWith('000111', 'scrypt$real-salt$11');
    expect(loggedReasons()).toEqual(['wrong_pin']);
  });

  test('the right PIN on a live athlete account still signs in', async () => {
    mockQueryOne.mockResolvedValueOnce(athleteRow());
    mockVerifyPin.mockResolvedValueOnce(true);
    mockQuery.mockResolvedValueOnce([]);

    const result = await loginWithAccountIdAndPin('ath-1', '482913');

    expect(result).not.toBeNull();
    expect(result?.principal.accountId).toBe('ath-1');
    expect(mockVerifyPin).toHaveBeenCalledTimes(1);
    expect(loggedReasons()).toEqual([]);
    expect(mockQuery.mock.calls[0][0]).toContain('insert into pilot.session_tokens');
  });
});
