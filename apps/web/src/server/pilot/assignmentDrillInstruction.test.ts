// Assigned work -> the drill instruction it was issued against (OD-2026-09-19-001,
// W-D4B). resolveAssignmentDrillInstruction is a pure decision over four reads,
// so the reads are mocked and the decision is what is under test:
//
// 1. It follows ONE chain and nothing else: assignment.drill_id -> that exact
//    operational row -> THAT row's reference_drill_id -> that reference row.
//    No lineage is followed to a newer head on either side, because that would
//    be the silent version substitution OD-2026-09-16-001 clause 5 rules out.
// 2. The athlete never receives the reference pointer. The athlete detail's
//    drill_id IS the reference id, so it is dropped as a key, not blanked.
// 3. Each audience's CONTENT comes from its own read, and only its own: the
//    athlete read carries the promoted-and-live predicate, the coach read
//    deliberately does not. The coach path also runs the athlete read -- the
//    same function, once, on the same pinned reference id -- but only to answer
//    athlete_can_open, a boolean. Nothing of the athlete projection reaches
//    staff, and the answer is never re-derived from the lifecycle or the row's
//    own flag, so it cannot disagree with what the athlete would actually get.
// 4. Staff are told where the operational version stands now -- current,
//    changed (refined or reinstated: another version of the lineage is active)
//    or retired -- from getOperationalDrillLifecycle, keyed on the operational
//    version the work was issued against. That is a status line, not a content
//    source, and an athlete read never makes it.
// 5. An athlete is never told WHY there is nothing to open. Legacy work, a
//    gym-written drill, a missing operational row and a withheld reference are
//    facts about how the library was assembled and governed, so every one of
//    them reaches the athlete as exactly { state: 'unavailable' }. Staff keep
//    no_drill / gym_written / unavailable apart, because it changes what they do.
// 6. It writes nothing. Opening a drill is reading; the module is scanned for
//    the write vocabulary so a write added later fails here by name.
//
// The real-Postgres halves of the reads are in drillLibraryV3.pg.test.ts and
// assignmentDrillInstruction.pg.test.ts.

import fs from 'node:fs';
import path from 'node:path';

// Every direct database entry point rejects. The four reads below are mocked,
// so a call reaching the database means the module grew a read (a lineage
// lookup, say) that the chain does not have -- the assertions on these mocks
// catch it by name, and the rejection stops it answering in the meantime.
jest.mock('./db', () => {
  const noDatabase = () => Promise.reject(new Error('unit test: no database'));
  return {
    query: jest.fn(noDatabase),
    queryOne: jest.fn(noDatabase),
    withTransaction: jest.fn(noDatabase),
    withPoolClient: jest.fn(noDatabase),
  };
});

// Only the reads are replaced. Everything else in these modules stays real, so
// if the implementation reached for another export (getDrillLibraryLineage,
// listDrills, getDrillLineage) it would run for real and hit the rejecting db
// mock above.
jest.mock('./drills', () => ({
  ...jest.requireActual('./drills'),
  getDrill: jest.fn(),
}));
jest.mock('./drillLibraryV3', () => ({
  ...jest.requireActual('./drillLibraryV3'),
  getAthleteDrillDetail: jest.fn(),
  getDrillWithDetail: jest.fn(),
}));
// The one lineage read the module is allowed, and it is status only.
// getDrillLineage -- a read that could pick content off a lineage -- stays real.
jest.mock('./drillVersioning', () => ({
  ...jest.requireActual('./drillVersioning'),
  getOperationalDrillLifecycle: jest.fn(),
}));

import { resolveAssignmentDrillInstruction, withoutReferencePointer } from './assignmentDrillInstruction';
import { query, queryOne, withPoolClient, withTransaction } from './db';
import {
  getAthleteDrillDetail,
  getDrillWithDetail,
  type AthleteDrillDetail,
  type DrillWithDetail,
} from './drillLibraryV3';
import { getDrill, type PilotDrill } from './drills';
import { getOperationalDrillLifecycle, type OperationalDrillLifecycle } from './drillVersioning';

const mockGetDrill = jest.mocked(getDrill);
const mockGetAthleteDrillDetail = jest.mocked(getAthleteDrillDetail);
const mockGetDrillWithDetail = jest.mocked(getDrillWithDetail);
const mockGetOperationalDrillLifecycle = jest.mocked(getOperationalDrillLifecycle);
const mockQuery = jest.mocked(query);
const mockQueryOne = jest.mocked(queryOne);
const mockWithTransaction = jest.mocked(withTransaction);
const mockWithPoolClient = jest.mocked(withPoolClient);

const ORG = 'punxsy_prominence';

// Three distinct ids, so a call made with the wrong one cannot pass by accident.
// The assignment names operational v1; v1 adopted reference v1; the reference
// lineage has since moved on to v3. Nothing may ever read v3 for this work.
const ASSIGNED_OPERATIONAL_ID = 'op-jab-catch-v1';
const PINNED_REFERENCE_ID = 'lib-jab-catch-v1';
const REFERENCE_LINEAGE_HEAD_ID = 'lib-jab-catch-v3';
// The reference lineage's own id, carried on the coach detail. Also never a read key.
const REFERENCE_LINEAGE_ID = 'lib-jab-catch';

/** Every id the athlete read may NOT be keyed on: only PINNED_REFERENCE_ID is allowed. */
const NEVER_READ_KEYS = [ASSIGNED_OPERATIONAL_ID, REFERENCE_LINEAGE_HEAD_ID, REFERENCE_LINEAGE_ID] as const;

/** The exact top-level keys of a coach 'available' answer. */
const COACH_AVAILABLE_KEYS = ['athlete_can_open', 'audience', 'drill', 'operational_lifecycle', 'state'];

function operationalRow(overrides: Partial<PilotDrill> = {}): PilotDrill {
  return {
    organization_id: ORG,
    drill_id: ASSIGNED_OPERATIONAL_ID,
    name: 'Catch and Return',
    category: 'Defense',
    focus: 'Catch the jab on the rear glove and fire back.',
    cues: ['Glove meets the punch'],
    difficulty: 'beginner',
    active: true,
    created_at: '2026-09-16T12:00:00.000Z',
    updated_at: '2026-09-16T12:00:00.000Z',
    reference_drill_id: PINNED_REFERENCE_ID,
    ...overrides,
  };
}

function athleteDetail(overrides: Partial<AthleteDrillDetail> = {}): AthleteDrillDetail {
  return {
    drill_id: PINNED_REFERENCE_ID,
    name: 'Catch and Return (v1 wording)',
    purpose: 'Stop the jab without leaving the pocket.',
    setup: 'focus mitt',
    execution: 'Partner jabs; catch on the rear glove; return a jab.',
    contact_level: 'light',
    requires_coach_authorization: false,
    cues: ['Glove meets the punch', 'Eyes on the chest'],
    what_good_looks_like: 'Glove meets the punch',
    what_bad_looks_like: 'Reaching',
    common_errors: 'Catching late',
    corrections: 'Coach calls "catch"',
    equipment_needed: 'focus mitt',
    scale_levels: [
      {
        scale_level: 'B',
        is_starting_point: true,
        demand_description: 'Single jab, fixed rhythm',
        constraint_applied: 'Partner calls the jab',
        contact_level: 'light',
        coach_watch_point: 'Rear glove stays home',
      },
    ],
    stop_rules: [
      { ordinal: 1, condition_text: 'Stop if the head is hit', scope: 'universal', rule_kind: 'safety' },
    ],
    ...overrides,
  };
}

function coachDetail(overrides: Partial<DrillWithDetail> = {}): DrillWithDetail {
  return {
    organization_id: ORG,
    drill_id: PINNED_REFERENCE_ID,
    lineage_id: REFERENCE_LINEAGE_ID,
    version: 1,
    supersedes_drill_id: null,
    superseded_at: '2026-09-18T12:00:00.000Z',
    name: 'Catch and Return (v1 wording)',
    discipline: 'boxing',
    category: 'Defense',
    difficulty: 'beginner',
    skill_id: 'DEF-PARRY',
    target_behavior: 'Rear glove catches the jab',
    purpose: 'Stop the jab without leaving the pocket.',
    standard_setup: 'focus mitt',
    execution: 'Partner jabs; catch on the rear glove; return a jab.',
    what_good_looks_like: 'Glove meets the punch [A2-070]',
    what_bad_looks_like: 'Reaching [B3-047]',
    common_errors: 'Catching late',
    corrections: 'Coach calls "catch" [A5-149]',
    transfer: 'Carries into sparring defense',
    contact_level: 'light',
    equipment_needed: 'focus mitt',
    requires_coach_authorization: false,
    content_class: 'draft',
    source_ref: null,
    grounding_claim_ids: ['A2-070'],
    field_provenance: 'authored',
    active: true,
    created_by_account_id: null,
    created_by_role: null,
    created_at: '2026-09-10T12:00:00.000Z',
    updated_at: '2026-09-10T12:00:00.000Z',
    scale_levels: [],
    stop_rules: [],
    cues: [],
    secondary_skills: [],
    ...overrides,
  };
}

/** No read of any kind happened -- neither the mocked ones nor the database. */
function expectNoDatabaseAccess() {
  expect(mockQuery).not.toHaveBeenCalled();
  expect(mockQueryOne).not.toHaveBeenCalled();
  expect(mockWithTransaction).not.toHaveBeenCalled();
  expect(mockWithPoolClient).not.toHaveBeenCalled();
}

/**
 * What an athlete is told for every reason there is nothing to open. A fresh
 * literal each time, so toStrictEqual also rules out any second key (a reason,
 * a pointer, an operational_lifecycle) riding along beside the state.
 */
function athleteNothingToOpen() {
  return { state: 'unavailable' };
}

afterEach(() => {
  jest.clearAllMocks();
  mockGetDrill.mockReset();
  mockGetAthleteDrillDetail.mockReset();
  mockGetDrillWithDetail.mockReset();
  mockGetOperationalDrillLifecycle.mockReset();
});

describe('resolveAssignmentDrillInstruction: nothing to open', () => {
  // Staff are told which case it is; an athlete gets the same 'unavailable' for
  // all of them. The reads are the same either way: the collapse happens after
  // the decision, so it cannot make either audience read more.
  test.each(['athlete', 'coach'] as const)(
    'a legacy assignment with no drill_id is no_drill for staff, unavailable for an athlete, and nothing is read (%s)',
    async (audience) => {
      const result = await resolveAssignmentDrillInstruction(ORG, { drill_id: null }, audience);

      expect(result).toStrictEqual(audience === 'athlete' ? athleteNothingToOpen() : { state: 'no_drill' });
      expect(mockGetDrill).not.toHaveBeenCalled();
      expect(mockGetAthleteDrillDetail).not.toHaveBeenCalled();
      expect(mockGetDrillWithDetail).not.toHaveBeenCalled();
      expect(mockGetOperationalDrillLifecycle).not.toHaveBeenCalled();
      expectNoDatabaseAccess();
    },
  );

  test.each(['athlete', 'coach'] as const)(
    'an operational row that reads as absent is no_drill for staff, unavailable for an athlete, and no library read follows (%s)',
    async (audience) => {
      mockGetDrill.mockResolvedValue(null);

      const result = await resolveAssignmentDrillInstruction(
        ORG,
        { drill_id: ASSIGNED_OPERATIONAL_ID },
        audience,
      );

      expect(result).toStrictEqual(audience === 'athlete' ? athleteNothingToOpen() : { state: 'no_drill' });
      expect(mockGetDrill).toHaveBeenCalledTimes(1);
      expect(mockGetDrill).toHaveBeenCalledWith(ORG, ASSIGNED_OPERATIONAL_ID);
      expect(mockGetAthleteDrillDetail).not.toHaveBeenCalled();
      expect(mockGetDrillWithDetail).not.toHaveBeenCalled();
      expect(mockGetOperationalDrillLifecycle).not.toHaveBeenCalled();
      expectNoDatabaseAccess();
    },
  );

  test.each(['athlete', 'coach'] as const)(
    'a gym-written drill (no reference_drill_id) is gym_written for staff, unavailable for an athlete, and no library read follows (%s)',
    async (audience) => {
      mockGetDrill.mockResolvedValue(operationalRow({ reference_drill_id: null }));

      const result = await resolveAssignmentDrillInstruction(
        ORG,
        { drill_id: ASSIGNED_OPERATIONAL_ID },
        audience,
      );

      expect(result).toStrictEqual(audience === 'athlete' ? athleteNothingToOpen() : { state: 'gym_written' });
      expect(mockGetDrill).toHaveBeenCalledWith(ORG, ASSIGNED_OPERATIONAL_ID);
      expect(mockGetAthleteDrillDetail).not.toHaveBeenCalled();
      expect(mockGetDrillWithDetail).not.toHaveBeenCalled();
      expect(mockGetOperationalDrillLifecycle).not.toHaveBeenCalled();
      expectNoDatabaseAccess();
    },
  );

  test('staff are told which case it is: no_drill, gym_written and unavailable stay three distinct answers', async () => {
    const legacy = await resolveAssignmentDrillInstruction(ORG, { drill_id: null }, 'coach');

    mockGetDrill.mockResolvedValue(operationalRow({ reference_drill_id: null }));
    const gymWritten = await resolveAssignmentDrillInstruction(ORG, { drill_id: ASSIGNED_OPERATIONAL_ID }, 'coach');

    mockGetDrill.mockResolvedValue(operationalRow());
    mockGetDrillWithDetail.mockResolvedValue(null);
    mockGetOperationalDrillLifecycle.mockResolvedValue('current');
    mockGetAthleteDrillDetail.mockResolvedValue(null);
    const withdrawn = await resolveAssignmentDrillInstruction(ORG, { drill_id: ASSIGNED_OPERATIONAL_ID }, 'coach');

    expect([legacy, gymWritten, withdrawn]).toStrictEqual([
      { state: 'no_drill' },
      { state: 'gym_written' },
      { state: 'unavailable' },
    ]);
  });
});

describe('resolveAssignmentDrillInstruction: athlete', () => {
  test('available, with the reference pointer dropped as a KEY, not blanked', async () => {
    const detail = athleteDetail();
    mockGetDrill.mockResolvedValue(operationalRow());
    mockGetAthleteDrillDetail.mockResolvedValue(detail);
    // Answers if asked, so an athlete path that made the status read and
    // carried it would grow a key below rather than pass quietly.
    mockGetOperationalDrillLifecycle.mockResolvedValue('current');

    const result = await resolveAssignmentDrillInstruction(
      ORG,
      { drill_id: ASSIGNED_OPERATIONAL_ID },
      'athlete',
    );

    expect(result.state).toBe('available');
    if (result.state !== 'available' || result.audience !== 'athlete') {
      throw new Error(`expected an athlete instruction, got ${JSON.stringify(result)}`);
    }
    // Exactly these top-level keys: no operational_lifecycle, no pointer beside the drill.
    expect(Object.keys(result).sort()).toEqual(['audience', 'drill', 'state']);
    // The lifecycle is a staff status line; the athlete read never makes it.
    expect(mockGetOperationalDrillLifecycle).not.toHaveBeenCalled();

    // toEqual ignores an own key whose value is undefined, so the key LIST is
    // what proves the pointer is gone rather than set to undefined.
    const expectedKeys = Object.keys(detail).filter((key) => key !== 'drill_id').sort();
    expect(Object.keys(result.drill).sort()).toEqual(expectedKeys);
    expect(expectedKeys).toEqual([
      'common_errors',
      'contact_level',
      'corrections',
      'cues',
      'equipment_needed',
      'execution',
      'name',
      'purpose',
      'requires_coach_authorization',
      'scale_levels',
      'setup',
      'stop_rules',
      'what_bad_looks_like',
      'what_good_looks_like',
    ]);
    expect(result.drill).not.toHaveProperty('drill_id');

    // Every other field is carried as the athlete read shaped it.
    const { drill_id: _pointer, ...instruction } = detail;
    void _pointer;
    expect(result.drill).toStrictEqual(instruction);

    // Nowhere in the serialized response -- which is what the route sends -- is
    // the reference id, or the operational id the assignment already carries.
    const wire = JSON.stringify(result);
    expect(wire).not.toContain(PINNED_REFERENCE_ID);
    expect(wire).not.toContain(ASSIGNED_OPERATIONAL_ID);
  });

  test("reads the assignment's OWN operational row's pointer: never assignment.drill_id, never a lineage head", async () => {
    mockGetDrill.mockResolvedValue(operationalRow());
    // Answers for any id, so a wrong id would still produce a drill -- the
    // wrong one. v1 wording is the only acceptable answer.
    mockGetAthleteDrillDetail.mockImplementation(async (_org, drillId) => {
      if (drillId === PINNED_REFERENCE_ID) return athleteDetail();
      return athleteDetail({ drill_id: drillId, name: `Some other drill (${drillId})` });
    });

    const result = await resolveAssignmentDrillInstruction(
      ORG,
      { drill_id: ASSIGNED_OPERATIONAL_ID },
      'athlete',
    );

    expect(mockGetDrill.mock.calls).toEqual([[ORG, ASSIGNED_OPERATIONAL_ID]]);
    expect(mockGetAthleteDrillDetail.mock.calls).toEqual([[ORG, PINNED_REFERENCE_ID]]);
    expect(mockGetAthleteDrillDetail).not.toHaveBeenCalledWith(ORG, ASSIGNED_OPERATIONAL_ID);
    expect(mockGetAthleteDrillDetail).not.toHaveBeenCalledWith(ORG, REFERENCE_LINEAGE_HEAD_ID);
    expect(result).toMatchObject({
      state: 'available',
      audience: 'athlete',
      drill: { name: 'Catch and Return (v1 wording)' },
    });
    // No lineage read of either kind ran underneath (see the db mock), and the
    // status read that staff get did not run for an athlete either.
    expect(mockGetOperationalDrillLifecycle).not.toHaveBeenCalled();
    expectNoDatabaseAccess();
  });

  test('a retired operational version still resolves through its own pointer; the athlete read alone decides', async () => {
    // v1 was retired and refined into an active v2 that copied the same
    // reference_drill_id forward. The assignment still names v1, so v1 is read,
    // and whether the athlete may see the reference is getAthleteDrillDetail's
    // promoted-and-live predicate -- not a second rule grown here, and not the
    // lineage status staff are shown.
    mockGetDrill.mockResolvedValue(operationalRow({ active: false }));
    mockGetAthleteDrillDetail.mockResolvedValue(athleteDetail());
    mockGetOperationalDrillLifecycle.mockResolvedValue('changed');

    const result = await resolveAssignmentDrillInstruction(
      ORG,
      { drill_id: ASSIGNED_OPERATIONAL_ID },
      'athlete',
    );

    expect(result).toMatchObject({ state: 'available', audience: 'athlete' });
    expect(result).not.toHaveProperty('operational_lifecycle');
    expect(mockGetAthleteDrillDetail.mock.calls).toEqual([[ORG, PINNED_REFERENCE_ID]]);
    expect(mockGetOperationalDrillLifecycle).not.toHaveBeenCalled();
  });

  test('the athlete read answering null is unavailable, with no fallback to the coach read', async () => {
    mockGetDrill.mockResolvedValue(operationalRow());
    mockGetAthleteDrillDetail.mockResolvedValue(null);
    // If the implementation fell back to the unfiltered coach read, this would
    // hand a withheld drill to an athlete.
    mockGetDrillWithDetail.mockResolvedValue(coachDetail());
    mockGetOperationalDrillLifecycle.mockResolvedValue('retired');

    const result = await resolveAssignmentDrillInstruction(
      ORG,
      { drill_id: ASSIGNED_OPERATIONAL_ID },
      'athlete',
    );

    expect(result).toStrictEqual(athleteNothingToOpen());
    expect(mockGetAthleteDrillDetail.mock.calls).toEqual([[ORG, PINNED_REFERENCE_ID]]);
    expect(mockGetDrillWithDetail).not.toHaveBeenCalled();
    expect(mockGetOperationalDrillLifecycle).not.toHaveBeenCalled();
  });

  test('every reason there is nothing to open reaches the athlete as the same answer, naming none of them', async () => {
    // Legacy work, a missing operational row, a gym-written drill and a
    // withheld reference, one after another. Staff are told these apart (see
    // above); an athlete must not be able to, from the response alone.
    const wires: string[] = [];
    const answerAs = async (assignment: { drill_id: string | null }) => {
      wires.push(JSON.stringify(await resolveAssignmentDrillInstruction(ORG, assignment, 'athlete')));
    };

    await answerAs({ drill_id: null });
    mockGetDrill.mockResolvedValueOnce(null);
    await answerAs({ drill_id: ASSIGNED_OPERATIONAL_ID });
    mockGetDrill.mockResolvedValueOnce(operationalRow({ reference_drill_id: null }));
    await answerAs({ drill_id: ASSIGNED_OPERATIONAL_ID });
    mockGetDrill.mockResolvedValueOnce(operationalRow());
    mockGetAthleteDrillDetail.mockResolvedValueOnce(null);
    await answerAs({ drill_id: ASSIGNED_OPERATIONAL_ID });

    expect(wires).toEqual([
      '{"state":"unavailable"}',
      '{"state":"unavailable"}',
      '{"state":"unavailable"}',
      '{"state":"unavailable"}',
    ]);
    // The four setups really did take four different paths.
    expect(mockGetDrill).toHaveBeenCalledTimes(3);
    expect(mockGetAthleteDrillDetail).toHaveBeenCalledTimes(1);
    expect(mockGetOperationalDrillLifecycle).not.toHaveBeenCalled();
    expect(mockGetDrillWithDetail).not.toHaveBeenCalled();
  });
});

describe('resolveAssignmentDrillInstruction: coach', () => {
  // The row's own flag rides along beside each state as it would really read:
  // 'changed' and 'retired' are both an inactive row, told apart only by
  // whether another version of the lineage is active.
  const LIFECYCLES: ReadonlyArray<[OperationalDrillLifecycle, boolean]> = [
    ['current', true],
    ['changed', false],
    ['retired', false],
  ];

  test.each(LIFECYCLES)(
    'available in full, and operational_lifecycle is %s as the lifecycle read reports it (row active=%s)',
    async (lifecycle, active) => {
      const detail = coachDetail();
      mockGetDrill.mockResolvedValue(operationalRow({ active }));
      mockGetDrillWithDetail.mockResolvedValue(detail);
      mockGetOperationalDrillLifecycle.mockResolvedValue(lifecycle);
      mockGetAthleteDrillDetail.mockResolvedValue(athleteDetail());

      const result = await resolveAssignmentDrillInstruction(
        ORG,
        { drill_id: ASSIGNED_OPERATIONAL_ID },
        'coach',
      );

      expect(result).toStrictEqual({
        state: 'available',
        audience: 'coach',
        drill: detail,
        operational_lifecycle: lifecycle,
        athlete_can_open: true,
      });
      expect(mockGetDrill.mock.calls).toEqual([[ORG, ASSIGNED_OPERATIONAL_ID]]);
      // Status only: whatever the lineage says, the content stays the pinned
      // reference version -- 'changed' does not move the read to a newer one.
      expect(mockGetDrillWithDetail.mock.calls).toEqual([[ORG, PINNED_REFERENCE_ID]]);
      // Keyed on the operational version the work was issued against (the row
      // getDrill just read), in this gym -- never on a reference id.
      expect(mockGetOperationalDrillLifecycle.mock.calls).toEqual([[ORG, ASSIGNED_OPERATIONAL_ID]]);
      // The athlete read runs once, on the same pinned reference, and only to
      // answer athlete_can_open; the staff drill above is the coach read's.
      expect(mockGetAthleteDrillDetail.mock.calls).toEqual([[ORG, PINNED_REFERENCE_ID]]);
      expectNoDatabaseAccess();
    },
  );

  test.each([
    [true, 'retired'],
    [false, 'current'],
  ] as const)(
    "when the row's flag (active=%s) and the lifecycle read (%s) disagree, the lifecycle read decides",
    async (active, lifecycle) => {
      // getDrill runs first; the lifecycle read runs after it. A gym that
      // retires or reinstates the drill in between leaves the later read as
      // the truer one, so the flag is only a fallback, never an override.
      mockGetDrill.mockResolvedValue(operationalRow({ active }));
      mockGetDrillWithDetail.mockResolvedValue(coachDetail());
      mockGetOperationalDrillLifecycle.mockResolvedValue(lifecycle);
      mockGetAthleteDrillDetail.mockResolvedValue(athleteDetail());

      const result = await resolveAssignmentDrillInstruction(
        ORG,
        { drill_id: ASSIGNED_OPERATIONAL_ID },
        'coach',
      );

      expect(result).toMatchObject({ state: 'available', audience: 'coach', operational_lifecycle: lifecycle });
    },
  );

  test.each([
    [true, 'current'],
    [false, 'retired'],
  ] as const)(
    "the lifecycle read answering null falls back to the row's own flag: active=%s is %s, never changed",
    async (active, expected) => {
      // Null means the row vanished between two reads. Its own flag is then the
      // most that can honestly be said; 'changed' needs the lineage, which the
      // fallback does not have.
      const detail = coachDetail();
      mockGetDrill.mockResolvedValue(operationalRow({ active }));
      mockGetDrillWithDetail.mockResolvedValue(detail);
      mockGetOperationalDrillLifecycle.mockResolvedValue(null);
      mockGetAthleteDrillDetail.mockResolvedValue(athleteDetail());

      const result = await resolveAssignmentDrillInstruction(
        ORG,
        { drill_id: ASSIGNED_OPERATIONAL_ID },
        'coach',
      );

      expect(result).toStrictEqual({
        state: 'available',
        audience: 'coach',
        drill: detail,
        operational_lifecycle: expected,
        athlete_can_open: true,
      });
      expect(mockGetOperationalDrillLifecycle.mock.calls).toEqual([[ORG, ASSIGNED_OPERATIONAL_ID]]);
      expectNoDatabaseAccess();
    },
  );

  test('reads the pinned reference version, never assignment.drill_id, the lineage id or the lineage head', async () => {
    mockGetDrill.mockResolvedValue(operationalRow());
    mockGetDrillWithDetail.mockImplementation(async (_org, drillId) =>
      coachDetail({ drill_id: drillId, name: drillId === PINNED_REFERENCE_ID ? 'v1' : 'wrong version' }),
    );
    mockGetOperationalDrillLifecycle.mockResolvedValue('current');
    mockGetAthleteDrillDetail.mockResolvedValue(athleteDetail());

    const result = await resolveAssignmentDrillInstruction(
      ORG,
      { drill_id: ASSIGNED_OPERATIONAL_ID },
      'coach',
    );

    for (const wrongKey of NEVER_READ_KEYS) {
      expect(mockGetDrillWithDetail).not.toHaveBeenCalledWith(ORG, wrongKey);
      expect(mockGetAthleteDrillDetail).not.toHaveBeenCalledWith(ORG, wrongKey);
    }
    // And the status read, for its part, is never pointed at a reference id.
    expect(mockGetOperationalDrillLifecycle).not.toHaveBeenCalledWith(ORG, PINNED_REFERENCE_ID);
    expect(mockGetOperationalDrillLifecycle).not.toHaveBeenCalledWith(ORG, REFERENCE_LINEAGE_HEAD_ID);
    expect(result).toMatchObject({ state: 'available', audience: 'coach', drill: { name: 'v1' } });
  });

  test('the coach read answering null is unavailable, even when the athlete read answers', async () => {
    mockGetDrill.mockResolvedValue(operationalRow());
    mockGetDrillWithDetail.mockResolvedValue(null);
    // A lifecycle answer does not turn a missing reference into something to open.
    mockGetOperationalDrillLifecycle.mockResolvedValue('current');
    // Nor does the athlete read: it only ever answers athlete_can_open, so it is
    // never a fallback source of staff content, and there is no athlete_can_open
    // without an instruction for it to describe.
    mockGetAthleteDrillDetail.mockResolvedValue(athleteDetail());

    const result = await resolveAssignmentDrillInstruction(
      ORG,
      { drill_id: ASSIGNED_OPERATIONAL_ID },
      'coach',
    );

    expect(result).toStrictEqual({ state: 'unavailable' });
    expect(mockGetDrillWithDetail.mock.calls).toEqual([[ORG, PINNED_REFERENCE_ID]]);
    // It may run beside the coach read or not at all; either way at most once,
    // and never pointed anywhere but the pinned reference.
    expect(mockGetAthleteDrillDetail.mock.calls.length).toBeLessThanOrEqual(1);
    for (const call of mockGetAthleteDrillDetail.mock.calls) {
      expect(call).toEqual([ORG, PINNED_REFERENCE_ID]);
    }
  });
});

describe('resolveAssignmentDrillInstruction: coach athlete_can_open', () => {
  // A name only the athlete projection carries, so any of it reaching the staff
  // answer -- the detail passed through as the flag, or merged into the drill --
  // is visible on the wire.
  const ATHLETE_PROJECTION_NAME = 'athlete projection, never shown to staff';

  test.each([
    ['answers a detail', true],
    ['answers null', false],
  ] as const)(
    "is the athlete's own read reduced to a boolean: when that read %s, athlete_can_open is %s",
    async (_answer, athleteCanOpen) => {
      const detail = coachDetail();
      mockGetDrill.mockResolvedValue(operationalRow());
      mockGetDrillWithDetail.mockResolvedValue(detail);
      mockGetOperationalDrillLifecycle.mockResolvedValue('current');
      mockGetAthleteDrillDetail.mockResolvedValue(
        athleteCanOpen ? athleteDetail({ name: ATHLETE_PROJECTION_NAME }) : null,
      );

      const result = await resolveAssignmentDrillInstruction(
        ORG,
        { drill_id: ASSIGNED_OPERATIONAL_ID },
        'coach',
      );

      // A strict boolean beside the staff drill -- not the detail, not null.
      expect(result).toStrictEqual({
        state: 'available',
        audience: 'coach',
        drill: detail,
        operational_lifecycle: 'current',
        athlete_can_open: athleteCanOpen,
      });
      expect(Object.keys(result).sort()).toEqual(COACH_AVAILABLE_KEYS);
      if (result.state !== 'available' || result.audience !== 'coach') {
        throw new Error(`expected a coach instruction, got ${JSON.stringify(result)}`);
      }
      expect(result.drill).toBe(detail);
      expect(JSON.stringify(result)).not.toContain(ATHLETE_PROJECTION_NAME);

      // Exactly once, on (org, the operational row's own reference_drill_id).
      expect(mockGetAthleteDrillDetail).toHaveBeenCalledTimes(1);
      expect(mockGetAthleteDrillDetail).toHaveBeenCalledWith(ORG, PINNED_REFERENCE_ID);
      expectNoDatabaseAccess();
    },
  );

  test.each([
    // v1 refined into an active v2 that carried the pointer forward: live for the athlete.
    ['changed', false, true],
    // Retired here, but the athlete read still finds the reference live (for
    // example through another promotion): the athlete read is what counts.
    ['retired', false, true],
    // Current here, but the reference itself was withdrawn: nothing for the athlete.
    ['current', true, false],
  ] as const)(
    'follows the athlete read, never the lifecycle or the row flag: lifecycle %s, row active=%s, athlete_can_open %s',
    async (lifecycle, active, athleteCanOpen) => {
      mockGetDrill.mockResolvedValue(operationalRow({ active }));
      mockGetDrillWithDetail.mockResolvedValue(coachDetail());
      mockGetOperationalDrillLifecycle.mockResolvedValue(lifecycle);
      mockGetAthleteDrillDetail.mockResolvedValue(athleteCanOpen ? athleteDetail() : null);

      const result = await resolveAssignmentDrillInstruction(
        ORG,
        { drill_id: ASSIGNED_OPERATIONAL_ID },
        'coach',
      );

      expect(result).toMatchObject({
        state: 'available',
        audience: 'coach',
        operational_lifecycle: lifecycle,
        athlete_can_open: athleteCanOpen,
      });
    },
  );

  test('is keyed on the pinned reference id -- never assignment.drill_id, the reference lineage id or its head', async () => {
    mockGetDrill.mockResolvedValue(operationalRow());
    mockGetDrillWithDetail.mockResolvedValue(coachDetail());
    mockGetOperationalDrillLifecycle.mockResolvedValue('current');
    // Answers a detail for EVERY id except the pinned one, so an athlete read
    // keyed on the wrong id would report true -- the wrong answer -- and fail below.
    mockGetAthleteDrillDetail.mockImplementation(async (_org, drillId) =>
      drillId === PINNED_REFERENCE_ID ? null : athleteDetail({ drill_id: drillId }),
    );

    const result = await resolveAssignmentDrillInstruction(
      ORG,
      { drill_id: ASSIGNED_OPERATIONAL_ID },
      'coach',
    );

    expect(result).toMatchObject({ state: 'available', audience: 'coach', athlete_can_open: false });
    expect(mockGetAthleteDrillDetail.mock.calls).toEqual([[ORG, PINNED_REFERENCE_ID]]);
    for (const wrongKey of NEVER_READ_KEYS) {
      expect(mockGetAthleteDrillDetail).not.toHaveBeenCalledWith(ORG, wrongKey);
    }
  });

  test.each(['athlete', 'coach'] as const)(
    'the athlete read runs exactly once per resolution, on (org, pinned reference id), for the %s audience',
    async (audience) => {
      mockGetDrill.mockResolvedValue(operationalRow());
      mockGetDrillWithDetail.mockResolvedValue(coachDetail());
      mockGetOperationalDrillLifecycle.mockResolvedValue('current');
      mockGetAthleteDrillDetail.mockResolvedValue(athleteDetail());

      const result = await resolveAssignmentDrillInstruction(ORG, { drill_id: ASSIGNED_OPERATIONAL_ID }, audience);

      expect(result).toMatchObject({ state: 'available', audience });
      expect(mockGetAthleteDrillDetail).toHaveBeenCalledTimes(1);
      expect(mockGetAthleteDrillDetail).toHaveBeenNthCalledWith(1, ORG, PINNED_REFERENCE_ID);
      // The coach read (content for staff) runs only for staff.
      expect(mockGetDrillWithDetail).toHaveBeenCalledTimes(audience === 'coach' ? 1 : 0);
    },
  );

  test('never reaches an athlete: the athlete answer carries no athlete_can_open', async () => {
    mockGetDrill.mockResolvedValue(operationalRow());
    mockGetAthleteDrillDetail.mockResolvedValue(athleteDetail());

    const result = await resolveAssignmentDrillInstruction(
      ORG,
      { drill_id: ASSIGNED_OPERATIONAL_ID },
      'athlete',
    );

    expect(result).toMatchObject({ state: 'available', audience: 'athlete' });
    expect(result).not.toHaveProperty('athlete_can_open');
  });
});

describe('withoutReferencePointer', () => {
  test('returns a new object without drill_id and leaves its input untouched', () => {
    const input = athleteDetail();
    const before = structuredClone(input);
    // Frozen, so an in-place delete would throw here rather than pass quietly.
    Object.freeze(input);

    const output = withoutReferencePointer(input);

    expect(output).not.toBe(input);
    expect(output).not.toHaveProperty('drill_id');
    expect(input).toStrictEqual(before);
    expect(input.drill_id).toBe(PINNED_REFERENCE_ID);
  });
});

describe('assignmentDrillInstruction.ts is read-only', () => {
  const source = fs.readFileSync(path.join(__dirname, 'assignmentDrillInstruction.ts'), 'utf8');

  /** The module's prose names the writers it does not call, so comments are stripped first. */
  function codeOnly(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  }

  const code = codeOnly(source);

  test('the scan is looking at the real module, not an emptied string', () => {
    expect(code).toContain('export async function resolveAssignmentDrillInstruction');
    expect(code).toContain('getAthleteDrillDetail(');
    expect(code).toContain('getDrillWithDetail(');
    expect(code).toContain('getOperationalDrillLifecycle(');
  });

  test('no write vocabulary and no transaction appear in its code', () => {
    expect(code).not.toMatch(/\b(insert|update|delete|upsert)\b/i);
    expect(code).not.toMatch(/withTransaction|withPoolClient/);
    // The only assignment writers stay behind POST /api/pilot/progression/completions.
    expect(code).not.toMatch(/recordCompletion|touchAssignmentProgress/);
  });

  test('it imports only the three read modules, and never the database directly', () => {
    const specifiers = [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]).sort();
    expect(specifiers).toEqual(['./drillLibraryV3', './drillVersioning', './drills']);
    expect(specifiers).not.toContain('./db');
  });
});
