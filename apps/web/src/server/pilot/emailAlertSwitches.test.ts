import { emailAlertUserTypeFor, readEmailAlertSwitch, setEmailAlertSwitch } from './emailAlertSwitches';
import { queryOne, withTransaction } from './db';
import { ForbiddenError } from './errors';

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

it('a coach is decided by role alone: no date of birth is read', async () => {
  await expect(emailAlertUserTypeFor({ ...athlete, role: 'coach', athleteId: null }, NOW)).resolves.toBe('staff');
  expect(mockQueryOne).not.toHaveBeenCalled();
});

/*
 * Only the membership key's 23503 becomes the plain 403 (a membership row
 * deleted mid-save; emailAlertSwitches.pg.test.ts proves that case on a real
 * database). Any other database error on the save stays an error, so a wider
 * catch cannot quietly turn a real fault into "not offered".
 */
it.each([
  ['a 23503 from another key', { code: '23503', constraint: 'email_alert_switches_account_id_fkey' }],
  ['another code on the membership key', { code: '23514', constraint: 'pilot_email_alert_switch_membership_fk' }],
])('%s on the save is not turned into the 403', async (_label, fields) => {
  const dbError = Object.assign(new Error('database error'), fields);
  const client = {
    query: jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // the account lock
      .mockResolvedValueOnce({ rows: [] }) // no switch row yet
      .mockResolvedValueOnce({ rows: [{ role: 'coach' }] }) // the membership, read again under the lock
      .mockRejectedValueOnce(dbError), // the insert
  };
  (withTransaction as jest.Mock).mockImplementation((work: (c: typeof client) => unknown) => work(client));
  const coach = { organizationId: 'org-1', accountId: 'acct-c', role: 'coach' as const, athleteId: null };
  const attempt = setEmailAlertSwitch({ ...coach, switchedOn: true }, NOW);
  await expect(attempt).rejects.toBe(dbError);
  await expect(attempt).rejects.not.toBeInstanceOf(ForbiddenError);
  expect(client.query).toHaveBeenCalledTimes(4);
  expect(client.query.mock.calls[3][0]).toMatch(/insert into pilot\.email_alert_switches/);
});
