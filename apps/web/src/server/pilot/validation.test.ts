import { GOAL_CATEGORIES, SESSION_RPE_METHODS } from './contracts';
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
    rpe_method: 'athlete_post_session_self_report',
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
    expect(validateSessionPayload(sessionPayload())).toMatchObject({
      rpe: 7,
      rpe_method: 'athlete_post_session_self_report',
    });
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

// pilot.sessions.rpe became nullable and gained rpe_method on 2026-08-24
// (pilot_slice_postgres_session_rpe_semantics_migration.sql). The column was
// NOT NULL, so check-in had to put SOME number in it, and the number it reached
// for was the pre-session "Readiness to Train" slider -- a reading of how ready
// an athlete felt BEFORE training, stored in the column that means how hard the
// session WAS. Everything below is about not letting that back in: an absent
// reading has to stay absent, a real 0 has to stay 0, and a row carrying a
// number has to say where the number came from.
describe('session RPE is nullable, and null means nobody rated the session', () => {
  test('a null rpe is preserved as null rather than defaulted to a number', () => {
    expect(validateSessionPayload(sessionPayload({
      rpe: null,
      rpe_method: 'UNKNOWN',
    })).rpe).toBeNull();
  });

  // The distinction the nullable column exists to preserve, and the reason
  // every reader must test for null before coercing: Number(null) is 0, and 0
  // is a real rung on this scale. An athlete who finished a session and rated
  // it 0 must not be indistinguishable from an athlete who was never asked.
  test('a reported 0 is not the same value as no report', () => {
    expect(validateSessionPayload(sessionPayload({
      rpe: 0,
      rpe_method: 'athlete_post_session_self_report',
    })).rpe).toBe(0);
    expect(validateSessionPayload(sessionPayload({
      rpe: null,
      rpe_method: 'UNKNOWN',
    })).rpe).toBeNull();
  });

  // An absent key is not the same thing as an explicit null. rpe is a required
  // field, so a caller that simply forgets it is told so rather than having the
  // omission read as "not rated".
  test('omitting rpe entirely is a 400, not a silent null', () => {
    const withoutRpe: Record<string, unknown> = sessionPayload();
    delete withoutRpe.rpe;
    expect(statusOf(() => validateSessionPayload(withoutRpe))).toBe(400);
  });
});

// The 0-10 bound lives in the API and deliberately NOT in a CHECK constraint,
// because rows written before this contract were never held to it. That makes
// these the only place the scale is enforced at all.
describe('the session validator holds new input to the scale its unit names', () => {
  test('both ends of the scale are accepted', () => {
    expect(validateSessionPayload(sessionPayload({
      rpe: 0,
      rpe_method: 'athlete_post_session_self_report',
    })).rpe).toBe(0);
    expect(validateSessionPayload(sessionPayload({
      rpe: 10,
      rpe_method: 'athlete_post_session_self_report',
    })).rpe).toBe(10);
  });

  test.each([-1, 11, 10.5, -0.5])('%p is outside the scale and is refused', (rpe) => {
    expect(statusOf(() => validateSessionPayload(sessionPayload({ rpe })))).toBe(400);
  });

  test('NaN is refused rather than stored as a number', () => {
    expect(statusOf(() => validateSessionPayload(sessionPayload({ rpe: Number.NaN })))).toBe(400);
  });

  /* Infinity is the gap the NaN check does not close. `typeof Infinity` is
     'number' and `Number.isNaN(Infinity)` is false, so it clears every type
     guard; only the scale bound stops it. It is refused here by `value > 10`
     rather than by anything naming it, which is why it is pinned explicitly:
     a future edit that relaxed the bound while keeping the NaN check would
     let Infinity through and nothing else would notice. Postgres `numeric`
     accepts 'Infinity' on PG14+, so this is a real storable value, not a
     theoretical one. */
  test.each([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    '%p clears the type guard but is refused by the scale',
    (rpe) => {
      expect(typeof rpe === 'number' && !Number.isNaN(rpe)).toBe(true);
      expect(statusOf(() => validateSessionPayload(sessionPayload({ rpe })))).toBe(400);
    },
  );

  test('a numeric string is refused rather than coerced', () => {
    expect(statusOf(() => validateSessionPayload(sessionPayload({ rpe: '7' })))).toBe(400);
  });

  test('the rejection names rpe so the caller knows what to fix', async () => {
    let refusal: unknown;
    try {
      validateSessionPayload(sessionPayload({ rpe: 11 }));
    } catch (error) {
      refusal = error;
    }
    const body = await jsonError(refusal).json();
    expect(body.error).toContain('rpe');
  });
});

describe('a session RPE has to say where it came from', () => {
  test.each(SESSION_RPE_METHODS)('%s is accepted', (method) => {
    // UNKNOWN is paired with a null reading and the self-report with a real
    // one, so each case is a row the application could actually write.
    const rpe = method === 'UNKNOWN' ? null : 6;
    expect(validateSessionPayload(sessionPayload({ rpe, rpe_method: method })).rpe_method)
      .toBe(method);
  });

  test('a method outside the vocabulary is a 400, not a constraint violation', () => {
    expect(statusOf(() => validateSessionPayload(sessionPayload({
      rpe_method: 'coach_estimate',
    })))).toBe(400);
  });

  // Required, not defaulted. The migration drops the column default for the
  // same reason: a writer that knows the provenance must state it rather than
  // inherit 'UNKNOWN' by saying nothing.
  test('omitting rpe_method is a 400 rather than an inherited UNKNOWN', () => {
    const withoutMethod: Record<string, unknown> = sessionPayload();
    delete withoutMethod.rpe_method;
    expect(statusOf(() => validateSessionPayload(withoutMethod))).toBe(400);
  });

  test('the rejection names rpe_method so the caller knows what to fix', async () => {
    let refusal: unknown;
    try {
      validateSessionPayload(sessionPayload({ rpe_method: 'coach_estimate' }));
    } catch (error) {
      refusal = error;
    }
    const body = await jsonError(refusal).json();
    expect(body.error).toContain('rpe_method');
  });
});

// The agreement rule, mirroring the CHECK the migration adds. It is deliberately
// one-directional, and both directions are pinned here so neither drifts.
describe('rpe and rpe_method have to agree', () => {
  test('a row with no reading may not claim a method for one', () => {
    expect(statusOf(() => validateSessionPayload(sessionPayload({
      rpe: null,
      rpe_method: 'athlete_post_session_self_report',
    })))).toBe(400);
  });

  test('the refusal explains which pairing is wrong', async () => {
    let refusal: unknown;
    try {
      validateSessionPayload(sessionPayload({ rpe: null, rpe_method: 'athlete_post_session_self_report' }));
    } catch (error) {
      refusal = error;
    }
    const body = await jsonError(refusal).json();
    expect(body.error).toContain('rpe_method');
    expect(body.error).toContain('UNKNOWN');
  });

  test('no reading with no claimed method is the honest open check-in, and is accepted', () => {
    expect(validateSessionPayload(sessionPayload({ rpe: null, rpe_method: 'UNKNOWN' })))
      .toMatchObject({ rpe: null, rpe_method: 'UNKNOWN' });
  });

  // The converse is NOT constrained, on purpose. Every row written before this
  // contract holds a number whose provenance is genuinely unknown -- in fact a
  // readiness reading -- and refusing that pairing would make those rows
  // unwritable and force a lie about where they came from.
  test('a reading whose provenance is unknown is accepted, because that is what the old rows are', () => {
    expect(validateSessionPayload(sessionPayload({ rpe: 7, rpe_method: 'UNKNOWN' })))
      .toMatchObject({ rpe: 7, rpe_method: 'UNKNOWN' });
  });
});
