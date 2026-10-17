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
    if (sql.includes('from pilot.athletes')) return n('athletes');
    if (sql.includes('a.pin_hash is null')) return n('waiting');
    if (sql.includes('a.pin_hash is not null')) return n('withPin');
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
  expect(lines['admin-sign-in'].detail).toMatch(/guest in the gym’s Microsoft tenant/);
  for (const key of ['coaches', 'athletes', 'athlete-sign-in', 'waivers', 'class', 'tv']) {
    expect(lines[key].state).toBe('to_do');
  }
  // No minor on the roster means no minor without a guardian.
  expect(lines.guardians.state).toBe('done');
  expect(lines.coaches.href).toBe('/admin/people');
  expect(lines.class.href).toBe('/schedule');
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
  expect(lines['athlete-sign-in'].detail).toBe('12 athletes have set a PIN.');
  expect(lines.tv.detail).toBe('1 TV is paired.');
});

test('what is still open is counted', async () => {
  counts({ coaches: 1, athletes: 3, waiting: 2, withPin: 1, minors: 1, classes: 0, tvs: 0 });
  mockWaiverRoster.mockResolvedValue([
    { athleteId: 'a1', athleteName: 'A', activeFlag: true, waivers: SIGNED },
    { athleteId: 'a2', athleteName: 'B', activeFlag: true, waivers: { ...SIGNED, photo_media: 'missing' } },
    { athleteId: 'a3', athleteName: 'C', activeFlag: false, waivers: { ...SIGNED, general: 'missing' } },
  ]);
  const lines = byKey(await readGymSetupStatus('gym-1'));

  expect(lines['athlete-sign-in']).toMatchObject({
    state: 'to_do',
    detail: '1 athlete has set a PIN; 2 are still waiting to redeem an activation code.',
  });
  expect(lines.guardians).toMatchObject({ state: 'to_do', detail: '1 athlete under 18 has no guardian on file.' });
  // Only active athletes are counted.
  expect(lines.waivers).toMatchObject({ state: 'to_do', detail: '1 active athlete is missing at least one tracked waiver or consent.' });
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
