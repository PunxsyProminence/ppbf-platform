import { GOAL_CATEGORIES } from './contracts';
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

// pilot.goals gained `category` and `progress_percent` on 2026-08-03. Both are
// optional on the wire and nullable in the column, and the tests below are
// about the three ways that could quietly go wrong: a payload that predates the
// columns getting rejected, a null being turned into a value, and the API
// admitting a category the database will then refuse.
function goalPayload(overrides: Record<string, unknown> = {}) {
  return {
    goal_id: 'goal-1',
    athlete_id: 'ath-1',
    title: 'Land 100 clean jabs',
    target_date: '2026-09-01',
    metric: '100 reps logged',
    status: 'active',
    created_at: '2026-07-29T12:00:00.000Z',
    updated_at: '2026-07-29T12:00:00.000Z',
    ...overrides,
  };
}

describe('goal category and progress are optional and nullable', () => {
  test('a payload written before the columns existed still validates', () => {
    expect(validateGoalPayload(goalPayload())).toMatchObject({
      goal_id: 'goal-1',
      category: null,
      progress_percent: null,
    });
  });

  test('an explicit null is kept as null rather than defaulted', () => {
    expect(validateGoalPayload(goalPayload({ category: null, progress_percent: null }))).toMatchObject({
      category: null,
      progress_percent: null,
    });
  });

  // The distinction the nullable column exists to preserve. If 0 were folded
  // into null anywhere on this path, an athlete reporting "I have not started"
  // would be indistinguishable from an athlete who was never asked.
  test('a reported 0 is not the same value as no report', () => {
    expect(validateGoalPayload(goalPayload({ progress_percent: 0 })).progress_percent).toBe(0);
    expect(validateGoalPayload(goalPayload()).progress_percent).toBeNull();
  });

  test('a category from the vocabulary is accepted', () => {
    expect(validateGoalPayload(goalPayload({ category: 'Academics' })).category).toBe('Academics');
  });

  test('every category the athlete form offers is accepted', () => {
    for (const category of GOAL_CATEGORIES) {
      expect(validateGoalPayload(goalPayload({ category })).category).toBe(category);
    }
  });

  test('progress of 100 is accepted and 101 is not', () => {
    expect(validateGoalPayload(goalPayload({ progress_percent: 100 })).progress_percent).toBe(100);
    expect(statusOf(() => validateGoalPayload(goalPayload({ progress_percent: 101 })))).toBe(400);
  });
});

describe('the goal validator refuses what the column would refuse', () => {
  test('a category outside the vocabulary is a 400, not a constraint violation', () => {
    expect(statusOf(() => validateGoalPayload(goalPayload({ category: 'Underwater Basket Weaving' })))).toBe(400);
  });

  // Held to the same standard as any other value outside the list. These two
  // are withheld pending the Privacy-Tier System rather than dropped forever,
  // so the test records the intent: while they are out of GOAL_CATEGORIES, the
  // API must refuse them rather than write a row the CHECK will reject.
  test.each(['Weight Loss', 'Weight Gain'])('%s is refused while it is out of the vocabulary', (category) => {
    expect(GOAL_CATEGORIES as readonly string[]).not.toContain(category);
    expect(statusOf(() => validateGoalPayload(goalPayload({ category })))).toBe(400);
  });

  test('a negative percentage is refused', () => {
    expect(statusOf(() => validateGoalPayload(goalPayload({ progress_percent: -1 })))).toBe(400);
  });

  test('a fractional percentage is refused, because the column is an integer', () => {
    expect(statusOf(() => validateGoalPayload(goalPayload({ progress_percent: 42.5 })))).toBe(400);
  });

  test('a percentage sent as a string is refused', () => {
    expect(statusOf(() => validateGoalPayload(goalPayload({ progress_percent: '50' })))).toBe(400);
  });

  test('the refusal names the field the caller has to fix', async () => {
    let refusal: unknown;
    try {
      validateGoalPayload(goalPayload({ category: 'Nope' }));
    } catch (error) {
      refusal = error;
    }

    const body = await jsonError(refusal).json();
    expect(body.error).toContain('category');
  });
});
