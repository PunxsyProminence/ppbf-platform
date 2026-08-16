// Community service totals (module 128). What these pin: verified and
// unverified minutes NEVER merge into one number (an external reader --
// a school, a court, a scholarship -- needs the verified figure alone);
// hours floor rather than round, so the record never hands out minutes it
// cannot back; and only community_service rows are read.

import { getCommunityServiceTotals, wholeHours } from './communityService';
import { listActivityLog } from './activityLog';

jest.mock('./activityLog', () => ({ listActivityLog: jest.fn() }));

const mockList = listActivityLog as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

const row = (overrides: Record<string, unknown>) => ({
  organization_id: 'org-1',
  activity_id: 'a-1',
  person_account_id: 'acct-1',
  athlete_id: null,
  activity_domain: 'community_service',
  activity_type: 'food_bank',
  occurred_on: '2026-08-10',
  started_at: null,
  duration_minutes: 60,
  what_was_worked_on: 'sorting donations',
  class_id: null,
  attendance_status: 'present',
  capture_method: 'supervisor_entry',
  recorded_by_role: 'admin',
  recorded_by_account_id: 'acct-admin',
  verified_by_account_id: null,
  verified_at: null,
  rpe: null,
  notes: '',
  created_at: '2026-08-10T00:00:00.000Z',
  updated_at: '2026-08-10T00:00:00.000Z',
  ...overrides,
});

test('verified and unverified minutes are counted separately and never summed into one figure', async () => {
  mockList.mockResolvedValue([
    row({ activity_id: 'a-1', duration_minutes: 120, verified_by_account_id: 'acct-admin', verified_at: '2026-08-11T00:00:00.000Z' }),
    row({ activity_id: 'a-2', duration_minutes: 90 }),
    row({ activity_id: 'a-3', duration_minutes: 30, verified_by_account_id: 'acct-admin', verified_at: '2026-08-12T00:00:00.000Z' }),
  ]);

  const [totals] = await getCommunityServiceTotals('org-1');
  expect(totals.verified_minutes).toBe(150);
  expect(totals.unverified_minutes).toBe(90);
  expect(totals.entry_count).toBe(3);
  // There is deliberately no combined total field to hand out by mistake.
  expect(totals).not.toHaveProperty('total_minutes');
  expect(totals.entries.find((entry) => entry.activity_id === 'a-2')?.verified).toBe(false);
});

test('only the community_service domain is read', async () => {
  mockList.mockResolvedValue([]);
  await getCommunityServiceTotals('org-1', { since: '2026-01-01' });
  expect(mockList).toHaveBeenCalledWith('org-1', expect.objectContaining({
    activityDomain: 'community_service',
    since: '2026-01-01',
  }));
});

test('people are grouped, most service first', async () => {
  mockList.mockResolvedValue([
    row({ activity_id: 'a-1', person_account_id: 'acct-small', duration_minutes: 30 }),
    row({ activity_id: 'a-2', person_account_id: 'acct-big', duration_minutes: 300 }),
  ]);

  const totals = await getCommunityServiceTotals('org-1');
  expect(totals.map((entry) => entry.person_account_id)).toEqual(['acct-big', 'acct-small']);
});

test('hours floor, never round up -- the record does not hand out minutes it cannot back', () => {
  expect(wholeHours(59)).toBe(0);
  expect(wholeHours(60)).toBe(1);
  expect(wholeHours(119)).toBe(1);
  expect(wholeHours(0)).toBe(0);
});
