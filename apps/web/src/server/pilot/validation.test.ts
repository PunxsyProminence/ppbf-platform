import { jsonError } from './http';
import {
  validateAthletePayload,
  validateCoachReviewPayload,
  validateGoalPayload,
  validateSessionPayload,
} from './validation';

function athletePayload(overrides: Record<string, unknown> = {}) {
  return {
    athlete_id: 'ath-1',
    full_name: 'Dawn Kellerman',
    dob: '2008-04-17',
    weight_class: '145',
    gym_status: 'active',
    emergency_contact: 'Ruth Kellerman 814-555-0143',
    active_flag: true,
    coach_id: 'coach-1',
    created_at: '2026-07-29T12:00:00.000Z',
    updated_at: '2026-07-29T12:00:00.000Z',
    ...overrides,
  };
}

function sessionPayload(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 'ses-1',
    athlete_id: 'ath-1',
    date: '2026-07-29',
    rpe: 7,
    notes: 'Six rounds on the bag',
    completed_flag: true,
    created_at: '2026-07-29T12:00:00.000Z',
    updated_at: '2026-07-29T12:00:00.000Z',
    ...overrides,
  };
}

function statusOf(run: () => unknown): number {
  try {
    run();
  } catch (error) {
    return jsonError(error).status;
  }
  throw new Error('expected the payload to be rejected');
}

describe('validators accept a complete payload', () => {
  test('athlete', () => {
    expect(validateAthletePayload(athletePayload())).toMatchObject({ athlete_id: 'ath-1' });
  });

  test('session', () => {
    expect(validateSessionPayload(sessionPayload())).toMatchObject({ rpe: 7 });
  });
});

// A field-level rejection is only useful if the caller is told which field is
// wrong. jsonError maps by message prefix and replaces anything it does not
// recognize with a 500 "Internal server error", so every message thrown here
// has to stay on a prefix it maps to 400.
describe('a rejected field is reported to the caller as a 400', () => {
  test('a non-string field', () => {
    expect(statusOf(() => validateAthletePayload(athletePayload({ full_name: 42 })))).toBe(400);
  });

  test('an empty string field', () => {
    expect(statusOf(() => validateGoalPayload({
      goal_id: 'goal-1',
      athlete_id: 'ath-1',
      title: '   ',
      target_date: '2026-09-01',
      metric: 'rounds',
      status: 'active',
      created_at: '2026-07-29T12:00:00.000Z',
      updated_at: '2026-07-29T12:00:00.000Z',
    }))).toBe(400);
  });

  test('a non-boolean field', () => {
    expect(statusOf(() => validateCoachReviewPayload({
      review_id: 'rev-1',
      session_id: 'ses-1',
      coach_id: 'coach-1',
      decision: 'approved',
      notes: 'Good work',
      approved_flag: 'yes',
      created_at: '2026-07-29T12:00:00.000Z',
      updated_at: '2026-07-29T12:00:00.000Z',
    }))).toBe(400);
  });

  test('a non-numeric field', () => {
    expect(statusOf(() => validateSessionPayload(sessionPayload({ rpe: 'seven' })))).toBe(400);
  });

  test('a missing field', () => {
    const withoutCoach: Record<string, unknown> = athletePayload();
    delete withoutCoach.coach_id;
    expect(statusOf(() => validateAthletePayload(withoutCoach))).toBe(400);
  });

  test('an unsupported field', () => {
    expect(statusOf(() => validateAthletePayload(athletePayload({ nickname: 'Dawnie' })))).toBe(400);
  });

  test('a body that is not a JSON object', () => {
    expect(statusOf(() => validateAthletePayload([]))).toBe(400);
  });
});

describe('the rejection names the field the caller has to fix', () => {
  test('the offending field appears in the response body', async () => {
    let refusal: unknown;
    try {
      validateAthletePayload(athletePayload({ full_name: 42 }));
    } catch (error) {
      refusal = error;
    }

    const body = await jsonError(refusal).json();
    expect(body.error).toContain('full_name');
  });
});
