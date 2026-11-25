import { emailAlertUserTypeFor, readEmailAlertSwitch } from './emailAlertSwitches';
import { queryOne } from './db';

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

it('an athlete whose date of birth reads as null is treated as a minor: no switch, and the switch table is never read', async () => {
  mockQueryOne.mockResolvedValueOnce({ dob: null });
  await expect(readEmailAlertSwitch(athlete, NOW)).resolves.toEqual({ offered: false });
  expect(mockQueryOne).toHaveBeenCalledTimes(1);
  expect(mockQueryOne.mock.calls[0][0]).toMatch(/from pilot\.athletes/);
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
