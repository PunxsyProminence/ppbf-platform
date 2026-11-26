import crypto from 'node:crypto';

import {
  confirmEmailAlertAddress,
  emailAlertCodeHash,
  emailAlertCodeLimitError,
  emailAlertUserTypeFor,
  newEmailAlertCode,
  normalizeEmailAlertAddress,
  readEmailAlertSwitch,
  requestEmailAlertAddressCode,
  setEmailAlertSwitch,
} from './emailAlertSwitches';
import { queryOne, withTransaction } from './db';
import { ForbiddenError } from './errors';
import { getRateLimitStatus } from './rateLimit';
import { hashToken } from './security';

/*
 * The age rule in code (lane W4-1, EM-1). pilot.athletes.dob is NOT NULL in the
 * schema, so emailAlertSwitches.pg.test.ts cannot store an athlete with no date
 * of birth; a null still reaches this module if the column or a read ever
 * changes. OD-2026-10-04-010: no date of birth counts as a minor, so no switch.
 */

jest.mock('./db', () => ({
  queryOne: jest.fn(),
  query: jest.fn(),
  withTransaction: jest.fn(),
}));

const mockQueryOne = queryOne as jest.Mock;
const NOW = new Date('2026-11-25T17:00:00Z');
const athlete = { organizationId: 'org-1', accountId: 'acct-a', role: 'athlete' as const, athleteId: 'ath-1' };

beforeEach(() => {
  jest.clearAllMocks();
});

it('an athlete whose date of birth reads as null is treated as a minor: no switch, and with nothing left over no transaction is opened', async () => {
  mockQueryOne.mockResolvedValueOnce({ dob: null }).mockResolvedValueOnce(null);
  await expect(readEmailAlertSwitch(athlete, NOW)).resolves.toEqual({ offered: false });
  expect(mockQueryOne).toHaveBeenCalledTimes(2);
  expect(mockQueryOne.mock.calls[0][0]).toMatch(/join pilot\.athletes/);
  // The account's own link is part of the read: the caller's athlete id alone is not trusted.
  expect(mockQueryOne.mock.calls[0][1]).toEqual(['org-1', 'acct-a', 'ath-1']);
  // The second read looks for a leftover switch; finding none, nothing is locked or written.
  expect(mockQueryOne.mock.calls[1][0]).toMatch(/from pilot\.email_alert_switches/);
  expect(withTransaction).not.toHaveBeenCalled();
});

it('an athlete with a date of birth 18 or more years back is a candidate adult athlete', async () => {
  mockQueryOne.mockResolvedValueOnce({ dob: '2000-03-14' });
  await expect(emailAlertUserTypeFor(athlete, NOW)).resolves.toBe('adult_athlete');
});

it('an athlete id of only spaces is no athlete: nothing is read', async () => {
  await expect(emailAlertUserTypeFor({ ...athlete, athleteId: '   ' }, NOW)).resolves.toBeNull();
  expect(mockQueryOne).not.toHaveBeenCalled();
});

it('a coach with no athlete record linked is staff: one read of the account\'s own link (A5), no date of birth', async () => {
  mockQueryOne.mockResolvedValueOnce({ athlete_id: null });
  await expect(emailAlertUserTypeFor({ ...athlete, role: 'coach', athleteId: null }, NOW)).resolves.toBe('staff');
  expect(mockQueryOne).toHaveBeenCalledTimes(1);
  expect(mockQueryOne.mock.calls[0][0]).toMatch(/select athlete_id from pilot\.accounts/);
  expect(mockQueryOne.mock.calls[0][1]).toEqual(['acct-a']);
});

it('A5: a parent account linked to an athlete record with no date of birth is offered nothing, whatever its role', async () => {
  mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-9' }).mockResolvedValueOnce({ dob: null });
  await expect(emailAlertUserTypeFor({ ...athlete, role: 'parent', athleteId: null }, NOW)).resolves.toBeNull();
  // The record read is the one the account itself is linked to, in this gym.
  expect(mockQueryOne.mock.calls[1][1]).toEqual(['org-1', 'acct-a', 'ath-9']);
});

it('a role with no switch is decided by role alone: nothing is read', async () => {
  await expect(emailAlertUserTypeFor({ ...athlete, role: 'volunteer', athleteId: null }, NOW)).resolves.toBeNull();
  expect(mockQueryOne).not.toHaveBeenCalled();
});

/*
 * Only the membership key's 23503 becomes the plain 403. Since the one pass on
 * #2169 the membership is read again under the save's locks, so a membership
 * row deleted before the save is refused by that read (the pg suite's "a
 * membership removed between sign-in and the save"), and the insert's key is
 * reached only by a delete that lands between that read and the insert. The pg
 * suite times that last case too ("a membership deleted while the save waits on
 * the membership key", a delete held open on a second connection). Here the
 * mapping is pinned exactly: the membership key's 23503 is the 403, and any
 * other database error on the save stays an error, so a wider catch cannot
 * quietly turn a real fault into "not offered".
 */
it('the membership key refusing the insert is the plain 403, not a raw error', async () => {
  const membershipGone = Object.assign(new Error('database error'), {
    code: '23503',
    constraint: 'pilot_email_alert_switch_membership_fk',
  });
  const client = {
    query: jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // the account lock
      .mockResolvedValueOnce({ rows: [] }) // no switch row yet
      .mockResolvedValueOnce({ rows: [{ status: 'active' }] }) // the gym, read under its share lock
      .mockResolvedValueOnce({ rows: [{ role: 'coach' }] }) // the membership, read again under the lock
      .mockRejectedValueOnce(membershipGone), // the insert
  };
  (withTransaction as jest.Mock).mockImplementation((work: (c: typeof client) => unknown) => work(client));
  const coach = { organizationId: 'org-1', accountId: 'acct-c', role: 'coach' as const, athleteId: null };
  const attempt = setEmailAlertSwitch({ ...coach, switchedOn: true }, NOW);
  await expect(attempt).rejects.toBeInstanceOf(ForbiddenError);
  await expect(attempt).rejects.toThrow('Forbidden: email alerts are not offered to this account');
  await expect(attempt).rejects.not.toBe(membershipGone);
  expect(client.query).toHaveBeenCalledTimes(5);
  expect(client.query.mock.calls[4][0]).toMatch(/insert into pilot\.email_alert_switches/);
});

it.each([
  ['a 23503 from another key', { code: '23503', constraint: 'email_alert_switches_account_id_fkey' }],
  ['another code on the membership key', { code: '23514', constraint: 'pilot_email_alert_switch_membership_fk' }],
])('%s on the save is not turned into the 403', async (_label, fields) => {
  const dbError = Object.assign(new Error('database error'), fields);
  const client = {
    query: jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // the account lock
      .mockResolvedValueOnce({ rows: [] }) // no switch row yet
      .mockResolvedValueOnce({ rows: [{ status: 'active' }] }) // the gym, read under its share lock
      .mockResolvedValueOnce({ rows: [{ role: 'coach' }] }) // the membership, read again under the lock
      .mockRejectedValueOnce(dbError), // the insert
  };
  (withTransaction as jest.Mock).mockImplementation((work: (c: typeof client) => unknown) => work(client));
  const coach = { organizationId: 'org-1', accountId: 'acct-c', role: 'coach' as const, athleteId: null };
  const attempt = setEmailAlertSwitch({ ...coach, switchedOn: true }, NOW);
  await expect(attempt).rejects.toBe(dbError);
  await expect(attempt).rejects.not.toBeInstanceOf(ForbiddenError);
  expect(client.query).toHaveBeenCalledTimes(5);
  expect(client.query.mock.calls[4][0]).toMatch(/insert into pilot\.email_alert_switches/);
});

/*
 * The adult athlete's address and its code (lane W4-1, EM-2b-2; the defaults
 * Overwatch GO'd on EM-2b, #2159 comment 7189871985). The database half --
 * sends, tries, limits, races -- is emailAlertAddress.pg.test.ts.
 */
describe('the address code, without a database', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('default 1: six digits from crypto.randomInt over 0..999999, zero-padded', () => {
    const draw = jest.spyOn(crypto, 'randomInt') as unknown as jest.Mock;
    for (const [drawn, code] of [[0, '000000'], [42, '000042'], [999_999, '999999']] as const) {
      draw.mockReturnValueOnce(drawn);
      expect(newEmailAlertCode()).toBe(code);
    }
    expect(draw.mock.calls).toEqual([[0, 1_000_000], [0, 1_000_000], [0, 1_000_000]]);
    draw.mockRestore();
    for (let i = 0; i < 200; i += 1) expect(newEmailAlertCode()).toMatch(/^\d{6}$/);
  });

  it('an address is trimmed and lowercased; empty, no @, no dot after it, over 254 characters or not a string is refused', () => {
    expect(normalizeEmailAlertAddress('  Adult.Person@Example.TEST \n')).toBe('adult.person@example.test');
    const longest = `${'a'.repeat(241)}@example.test`;
    expect(longest).toHaveLength(254);
    expect(normalizeEmailAlertAddress(longest)).toBe(longest);
    for (const bad of ['', '   ', 'no-at-sign.example.test', 'two@@example.test', 'a b@example.test', 'nobody@nodot', `a${longest}`, null, 7, ['x@example.test']]) {
      expect(normalizeEmailAlertAddress(bad)).toBeNull();
    }
  });

  it('default 2: the stored hash binds the code to one gym, account and address, under its own prefix', () => {
    const hash = emailAlertCodeHash('org-1', 'acct-a', 'one@example.test', '123456');
    expect(hash).toBe(hashToken('email-alert-code:org-1:acct-a:one@example.test:123456'));
    expect(emailAlertCodeHash('org-1', 'acct-a', 'one@example.test', '123456')).toBe(hash);
    for (const other of [
      emailAlertCodeHash('org-2', 'acct-a', 'one@example.test', '123456'),
      emailAlertCodeHash('org-1', 'acct-b', 'one@example.test', '123456'),
      emailAlertCodeHash('org-1', 'acct-a', 'two@example.test', '123456'),
      emailAlertCodeHash('org-1', 'acct-a', 'one@example.test', '123457'),
      hashToken('123456'),
    ]) {
      expect(other).not.toBe(hash);
    }
  });

  it('default 4: the one limit answer names no limit and no address', () => {
    expect(emailAlertCodeLimitError()).toMatchObject({ status: 429, code: 'EMAIL_ALERT_CODE_LIMIT' });
    expect(emailAlertCodeLimitError().message).toBe(emailAlertCodeLimitError().message);
  });

  // pilot.athletes.dob is NOT NULL, so the pg suite cannot store this case (OD-2026-10-04-010).
  it('an athlete whose date of birth reads as null: POST and PUT are 403 with nothing reserved, opened, written or sent', async () => {
    const sendCode = jest.fn();
    const address = 'nodob@example.test';
    mockQueryOne.mockResolvedValueOnce({ dob: null }).mockResolvedValueOnce(null);
    await expect(requestEmailAlertAddressCode({ ...athlete, address }, sendCode, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    mockQueryOne.mockResolvedValueOnce({ dob: null }).mockResolvedValueOnce(null);
    await expect(confirmEmailAlertAddress({ ...athlete, code: '123456' }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    expect(sendCode).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
    expect(getRateLimitStatus(`email_alert_code_address:${hashToken(address)}`).count).toBe(0);
  });

  // L1: the adult check comes first, so a minor's answer never depends on what they typed.
  it('a malformed address or code from an adult is the worded 400 after the adult check, with nothing opened, reserved or sent', async () => {
    const sendCode = jest.fn();
    mockQueryOne.mockResolvedValue({ dob: '2000-03-14' });
    await expect(requestEmailAlertAddressCode({ ...athlete, address: 'not an address' }, sendCode, NOW))
      .rejects.toMatchObject({ status: 400, message: 'Enter a valid email address' });
    for (const code of ['12345', '1234567', 'abcdef', 123456, null]) {
      await expect(confirmEmailAlertAddress({ ...athlete, code }, NOW))
        .rejects.toMatchObject({ status: 400, message: 'Enter the six-digit code from the email' });
    }
    expect(mockQueryOne.mock.calls.every((call) => /join pilot\.athletes/.test(call[0]))).toBe(true);
    expect(withTransaction).not.toHaveBeenCalled();
    expect(sendCode).not.toHaveBeenCalled();
  });

  it('a malformed address or code from an athlete with no date of birth is the plain 403, as a well-formed one is', async () => {
    const sendCode = jest.fn();
    mockQueryOne.mockImplementation(async (sql: string) => (/join pilot\.athletes/.test(sql) ? { dob: null } : null));
    for (const attempt of [
      () => requestEmailAlertAddressCode({ ...athlete, address: 'not an address' }, sendCode, NOW),
      () => requestEmailAlertAddressCode({ ...athlete, address: 'well.formed@example.test' }, sendCode, NOW),
      () => confirmEmailAlertAddress({ ...athlete, code: '12' }, NOW),
      () => confirmEmailAlertAddress({ ...athlete, code: '123456' }, NOW),
    ]) {
      await expect(attempt()).rejects.toThrow(new ForbiddenError('Forbidden: email alerts are not offered to this account'));
    }
    expect(withTransaction).not.toHaveBeenCalled();
    expect(sendCode).not.toHaveBeenCalled();
  });
});
