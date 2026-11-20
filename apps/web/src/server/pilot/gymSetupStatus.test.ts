/**
 * Gym Setup (lane L31 P5): each line says what the records show, links to the
 * screen where the step is done, and says "could not read" rather than "done"
 * when its read fails. The admin sign-in is the one step done outside the app
 * (Overwatch Q3 A).
 */

const mockQueryOne = jest.fn();
const mockWaiverRoster = jest.fn();
jest.mock('./db', () => ({ queryOne: (...args: unknown[]) => mockQueryOne(...args) }));
jest.mock('./waiverCompliance', () => ({
  ...jest.requireActual('./waiverCompliance'),
  readOrganizationWaiverRoster: (...args: unknown[]) => mockWaiverRoster(...args),
}));

import { readGymSetupStatus } from './gymSetupStatus';

const SIGNED = { general: 'signed', medical_release: 'signed', photo_media: 'signed', travel: 'signed' };

/** Answers each count by the table its SQL reads. */
function counts(values: Partial<Record<'coaches' | 'athletes' | 'waiting' | 'withPin' | 'minors' | 'classes' | 'tvs', number>>) {
  mockQueryOne.mockImplementation(async (sql: string) => {
    const n = (key: keyof typeof values) => ({ n: values[key] ?? 0 });
    if (sql.includes("m.role = 'coach'")) return n('coaches');
    if (sql.includes('pilot.guardian_links')) return n('minors');
    if (sql.includes('left join pilot.accounts acct')) {
      return { total: values.athletes ?? 0, with_pin: values.withPin ?? 0, waiting: values.waiting ?? 0 };
    }
    if (sql.includes('from pilot.athletes')) return n('athletes');
    if (sql.includes('pilot.scheduler_classes')) return n('classes');
    if (sql.includes('pilot.gym_tvs')) return n('tvs');
    throw new Error(`unexpected SQL: ${sql}`);
  });
}

function byKey(lines: Awaited<ReturnType<typeof readGymSetupStatus>>) {
  return Object.fromEntries(lines.map((line) => [line.key, line]));
}

beforeEach(() => {
  mockQueryOne.mockReset();
  mockWaiverRoster.mockReset();
});

test('a brand-new gym: every step is to do, and the admin sign-in is the one step outside the app', async () => {
  counts({});
  mockWaiverRoster.mockResolvedValue([]);
  const lines = byKey(await readGymSetupStatus('gym-1'));

  expect(Object.keys(lines)).toEqual(['admin-sign-in', 'coaches', 'athletes', 'athlete-sign-in', 'guardians', 'waivers', 'class', 'tv']);
  expect(lines['admin-sign-in'].state).toBe('manual');
  for (const key of ['coaches', 'athletes', 'athlete-sign-in', 'waivers', 'class']) {
    expect(lines[key].state).toBe('to_do');
  }
  // A TV is optional. It links nowhere: the office pairs one inside this
  // line on /admin/setup itself (OFF-02).
  expect(lines.tv).toMatchObject({ state: 'optional', href: null });
  // OFF-02: the office pairs one on this page; a coach still can from the workspace.
  expect(lines.tv.detail).toBe('No TV paired. Pair one here, or a coach pairs one from the coach workspace.');
  // The guest invite is the platform owner's, in the platform's tenant; no gym screen does it.
  expect(lines['admin-sign-in']).toMatchObject({ href: null });
  expect(lines['admin-sign-in'].detail).toMatch(/platform’s Microsoft tenant/);
  expect(lines['admin-sign-in'].detail).toMatch(/Users, New user, Invite external user/);
  // No minor on the roster means no minor without a guardian.
  expect(lines.guardians.state).toBe('done');
  expect(lines.class.href).toBe('/schedule');
  expect(mockQueryOne.mock.calls.every(([, params]) => JSON.stringify(params) === '["gym-1"]')).toBe(true);
});

// Lane AS-10 (OFF-08, OFF-09; Overwatch Q5 A, Q6 A): each step opens the Gym
// Office tab that does it, Gym Office is the one place a code is issued, and
// the guardian step also names the paper-only page for a family with no email.
test('each step links to the Gym Office tab that does it, and the guardian step to both guardian screens', async () => {
  counts({});
  mockWaiverRoster.mockResolvedValue([]);
  const lines = byKey(await readGymSetupStatus('gym-1'));

  expect(lines.coaches).toMatchObject({ href: '/admin/people?tab=invite-staff', linkLabel: 'Add a coach' });
  expect(lines.athletes).toMatchObject({ href: '/admin/people?tab=add-athlete', linkLabel: 'Add an athlete' });
  expect(lines['athlete-sign-in']).toMatchObject({ href: '/admin/people?tab=add-athlete', linkLabel: 'Add Athlete' });
  expect(lines.guardians).toMatchObject({
    href: '/admin/people?tab=invite-staff',
    linkLabel: 'Add a guardian',
    alsoHref: '/admin/athlete-consent',
    alsoLinkLabel: 'Media Consent Audit',
  });
  // No step links to the typed-account-ID page any more.
  expect(Object.values(lines).some((line) => line.href === '/admin/activation-codes')).toBe(false);
  // Only the guardian step has a second screen.
  expect(Object.values(lines).filter((line) => line.alsoHref).map((line) => line.key)).toEqual(['guardians']);
  expect(mockQueryOne.mock.calls.every(([, params]) => JSON.stringify(params) === '["gym-1"]')).toBe(true);
});

test('a gym ready for its first class: every step is done, with what the records say', async () => {
  counts({ coaches: 2, athletes: 12, waiting: 0, withPin: 12, minors: 0, classes: 3, tvs: 1 });
  mockWaiverRoster.mockResolvedValue([{ athleteId: 'a1', athleteName: 'A', activeFlag: true, waivers: SIGNED }]);
  const lines = byKey(await readGymSetupStatus('gym-1'));

  for (const key of ['coaches', 'athletes', 'athlete-sign-in', 'guardians', 'waivers', 'class', 'tv']) {
    expect(lines[key].state).toBe('done');
  }
  expect(lines.coaches.detail).toBe('2 active coaches.');
  expect(lines['athlete-sign-in'].detail).toBe('Every active athlete has set a PIN (12).');
  expect(lines.tv.detail).toBe('1 TV is paired.');
});

test('what is still open is counted', async () => {
  counts({ coaches: 1, athletes: 4, waiting: 2, withPin: 1, minors: 1, classes: 0, tvs: 0 });
  mockWaiverRoster.mockResolvedValue([
    { athleteId: 'a1', athleteName: 'A', activeFlag: true, waivers: SIGNED },
    { athleteId: 'a2', athleteName: 'B', activeFlag: true, waivers: { ...SIGNED, photo_media: 'missing' } },
    { athleteId: 'a3', athleteName: 'C', activeFlag: false, waivers: { ...SIGNED, general: 'missing' } },
  ]);
  const lines = byKey(await readGymSetupStatus('gym-1'));

  // From the roster: the athlete never issued a code is counted too.
  expect(lines['athlete-sign-in']).toMatchObject({
    state: 'to_do',
    detail: '1 athlete has set a PIN; 2 are waiting to redeem an activation code; 1 has not been issued a code yet.',
  });
  expect(lines.guardians).toMatchObject({ state: 'to_do', detail: '1 athlete under 18 has no guardian on file.' });
  // Only active athletes are counted.
  expect(lines.waivers).toMatchObject({
    state: 'to_do',
    detail: '1 active athlete has at least one tracked waiver or consent not signed (missing, declined or withdrawn).',
  });
});

test('a read that fails says so and never claims done; the other lines still answer', async () => {
  counts({ coaches: 1 });
  mockQueryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('pilot.gym_tvs')) throw new Error('relation does not exist');
    return { n: 1 };
  });
  mockWaiverRoster.mockRejectedValue(new Error('db down'));
  const lines = byKey(await readGymSetupStatus('gym-1'));

  expect(lines.tv).toMatchObject({ state: 'unavailable', detail: 'This could not be read just now.' });
  expect(lines.waivers.state).toBe('unavailable');
  expect(lines.coaches.state).toBe('done');
});
