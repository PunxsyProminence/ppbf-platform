/**
 * The family projection of an athlete record and a coach review
 * (familyRecordView.ts): what an athlete or a guardian receives, and above
 * all what they do not -- the coach's account id (OD-2026-10-06-025 ruling 2).
 */

import { getCoachDisplayName } from './achievements';
import type { PilotAthlete, PilotCoachReview } from './contracts';
import {
  isFamilyRecordCaller,
  toFamilyAthlete,
  toFamilyAthletes,
  toFamilyCoachReviews,
} from './familyRecordView';

jest.mock('./achievements', () => ({ getCoachDisplayName: jest.fn() }));

const mockCoachName = jest.mocked(getCoachDisplayName);

const COACH_ID = 'coach-alvarez@punxsyprominence.org';
const OTHER_COACH_ID = 'coach-pike@punxsyprominence.org';

beforeEach(() => {
  mockCoachName.mockReset();
  mockCoachName.mockImplementation(async (_org, accountId) =>
    accountId === COACH_ID ? 'Coach Alvarez' : 'Coach Pike',
  );
});

// The storage row as `select *` returns it: the contract fields plus the
// columns the migrations added afterwards, which the projection must not
// carry either.
const athleteRow = (overrides: Partial<PilotAthlete> & Record<string, unknown> = {}): PilotAthlete => ({
  athlete_id: 'ATH-1',
  full_name: 'Marisol Vance',
  dob: '2010-03-04',
  weight_class: '132',
  gym_status: 'active',
  emergency_contact: 'Rosa Vance 814-555-0110',
  active_flag: true,
  coach_id: COACH_ID,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-02T00:00:00.000Z',
  ...({ organization_id: 'org-1', emergency_contact_note: 'Rosa Vance 814-555-0110', deleted_at: null } as Record<string, unknown>),
  ...overrides,
});

const reviewRow = (overrides: Partial<PilotCoachReview> & Record<string, unknown> = {}): PilotCoachReview => ({
  review_id: 'rev-1',
  session_id: 'sess-1',
  coach_id: COACH_ID,
  decision: 'progress',
  notes: 'Jab is landing. Keep the rear hand home.',
  approved_flag: true,
  created_at: '2026-08-03T00:00:00.000Z',
  updated_at: '2026-08-03T00:00:00.000Z',
  ...({ organization_id: 'org-1' } as Record<string, unknown>),
  ...overrides,
});

describe('who is a family caller', () => {
  test.each(['athlete', 'parent'] as const)('%s is', (role) => {
    expect(isFamilyRecordCaller(role)).toBe(true);
  });
  test.each(['coach', 'admin', 'organization_admin', 'platform_owner', 'board', 'volunteer', 'staff'] as const)(
    '%s is not',
    (role) => {
      expect(isFamilyRecordCaller(role)).toBe(false);
    },
  );
});

describe('the family athlete', () => {
  test('carries the record with coach_name in place of coach_id, and nothing the row grew later', async () => {
    const [item] = await toFamilyAthletes('org-1', [athleteRow()]);

    expect(item).toEqual({
      athlete_id: 'ATH-1',
      full_name: 'Marisol Vance',
      dob: '2010-03-04',
      weight_class: '132',
      gym_status: 'active',
      emergency_contact: 'Rosa Vance 814-555-0110',
      active_flag: true,
      coach_name: 'Coach Alvarez',
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-02T00:00:00.000Z',
    });
    // The whole serialised item, not one key: an id smuggled under another
    // name would pass a `not.toHaveProperty('coach_id')`.
    expect(JSON.stringify(item)).not.toContain(COACH_ID);
    expect(JSON.stringify(item)).not.toContain('org-1');
  });

  test('names the coach through the tenancy-scoped reader, once per distinct coach', async () => {
    const items = await toFamilyAthletes('org-7', [
      athleteRow({ athlete_id: 'ATH-1' }),
      athleteRow({ athlete_id: 'ATH-2', coach_id: OTHER_COACH_ID }),
      athleteRow({ athlete_id: 'ATH-3' }),
    ]);

    expect(items.map((item) => item.coach_name)).toEqual(['Coach Alvarez', 'Coach Pike', 'Coach Alvarez']);
    expect(mockCoachName).toHaveBeenCalledTimes(2);
    expect(mockCoachName).toHaveBeenCalledWith('org-7', COACH_ID);
    expect(mockCoachName).toHaveBeenCalledWith('org-7', OTHER_COACH_ID);
  });

  test('a coach the reader cannot name (deleted, lapsed, or a stranger) shows the floor phrase, never the id', async () => {
    mockCoachName.mockResolvedValue('Your coach');

    const item = await toFamilyAthlete('org-1', athleteRow());

    expect(item.coach_name).toBe('Your coach');
    expect(JSON.stringify(item)).not.toContain(COACH_ID);
  });

  test('an empty list makes no name lookup', async () => {
    await expect(toFamilyAthletes('org-1', [])).resolves.toEqual([]);
    expect(mockCoachName).not.toHaveBeenCalled();
  });
});

describe('the family coach review', () => {
  test('carries the review with coach_name in place of coach_id', async () => {
    const items = await toFamilyCoachReviews('org-1', [reviewRow()]);

    expect(items).toEqual([
      {
        review_id: 'rev-1',
        session_id: 'sess-1',
        coach_name: 'Coach Alvarez',
        decision: 'progress',
        notes: 'Jab is landing. Keep the rear hand home.',
        approved_flag: true,
        created_at: '2026-08-03T00:00:00.000Z',
        updated_at: '2026-08-03T00:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(items)).not.toContain(COACH_ID);
    expect(JSON.stringify(items)).not.toContain('org-1');
  });

  test('a deleted coach shows the floor phrase on every review they wrote', async () => {
    mockCoachName.mockResolvedValue('Your coach');

    const items = await toFamilyCoachReviews('org-1', [reviewRow(), reviewRow({ review_id: 'rev-2' })]);

    expect(items.map((item) => item.coach_name)).toEqual(['Your coach', 'Your coach']);
    expect(JSON.stringify(items)).not.toContain(COACH_ID);
    expect(mockCoachName).toHaveBeenCalledTimes(1);
  });
});
