// Assigned work -> the drill instruction it was issued against (OD-2026-09-19-001,
// W-D4B, as narrowed by OD-2026-09-19-002). resolveAssignmentDrillInstruction
// is a pure decision over five reads, so the reads are mocked and the decision
// is what is under test:
//
// 1. It follows ONE chain and nothing else: assignment.drill_id -> that exact
//    operational row -> THAT row's reference_drill_id -> that reference row.
//    No lineage is followed to a newer head on either side, because that would
//    be the silent version substitution OD-2026-09-16-001 clause 5 rules out.
// 2. The athlete never receives the reference pointer. The athlete detail's
//    drill_id IS the reference id, so it is dropped as a key, not blanked.
// 3. The athlete's CONTENT comes from exactly one athlete read, chosen by the
//    status of the work (OD-2026-09-19-002). Open work -- assigned or
//    in_progress -- reads getAthleteDrillDetailForOpenWork, which keeps the
//    exact instruction after the gym retires the drill; completed, cancelled
//    and incomplete work read getAthleteDrillDetail, the Learn read with its
//    promoted-and-live predicate. Neither falls back to the other, and neither
//    falls back to the coach read.
// 4. Staff content comes from the coach read, and only that read. The coach
//    path ALSO runs both athlete reads -- each once, on the same pinned
//    reference id -- but only to answer athlete_access: 'all_work' when the
//    Learn read answers, 'open_work_only' when only the open-work read does,
//    'none' when neither does. Nothing of the athlete projection reaches staff,
//    the answer is never re-derived from the lifecycle or the row's own flag,
//    and it does not depend on the status of the card it is opened from, so it
//    cannot disagree with what an athlete would actually get.
// 5. Staff are told where the operational version stands now -- current,
//    changed (refined or reinstated: another version of the lineage is active)
//    or retired -- from getOperationalDrillLifecycle, keyed on the operational
//    version the work was issued against. That is a status line, not a content
//    source, and an athlete read never makes it.
// 6. An athlete is never told WHY there is nothing to open. Legacy work, a
//    gym-written drill, a missing operational row and a withheld reference are
//    facts about how the library was assembled and governed, so every one of
//    them reaches the athlete as exactly { state: 'unavailable' }. Staff keep
//    no_drill / gym_written / unavailable apart, because it changes what they do.
// 7. It writes nothing. Opening a drill is reading; the module is scanned for
//    the write vocabulary so a write added later fails here by name.
// 8. getAthleteDrillDetailForOpenWork is not a browse read. Handed an arbitrary
//    id it would reveal any active reference in the gym, so the source tree is
//    scanned: outside tests, only its definition and this resolver name it.
//
// The real-Postgres halves of the reads are in drillLibraryV3.pg.test.ts and
// assignmentDrillInstruction.pg.test.ts.

import fs from 'node:fs';
import path from 'node:path';

// Every direct database entry point rejects. The five reads below are mocked,
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
  getAthleteDrillDetailForOpenWork: jest.fn(),
  getDrillWithDetail: jest.fn(),
}));
// The one lineage read the module is allowed, and it is status only.
// getDrillLineage -- a read that could pick content off a lineage -- stays real.
jest.mock('./drillVersioning', () => ({
  ...jest.requireActual('./drillVersioning'),
  getOperationalDrillLifecycle: jest.fn(),
}));

import * as resolverModule from './assignmentDrillInstruction';
import {
  isOpenWork,
  resolveAssignmentDrillInstruction,
  withoutReferencePointer,
  type AthleteInstructionAccess,
} from './assignmentDrillInstruction';
import { query, queryOne, withPoolClient, withTransaction } from './db';
import {
  getAthleteDrillDetail,
  getAthleteDrillDetailForOpenWork,
  getDrillWithDetail,
  type AthleteDrillDetail,
  type DrillWithDetail,
} from './drillLibraryV3';
import { getDrill, type PilotDrill } from './drills';
import { getOperationalDrillLifecycle, type OperationalDrillLifecycle } from './drillVersioning';
import type { DrillAssignment } from './progression';

const mockGetDrill = jest.mocked(getDrill);
const mockGetAthleteDrillDetail = jest.mocked(getAthleteDrillDetail);
const mockGetAthleteDrillDetailForOpenWork = jest.mocked(getAthleteDrillDetailForOpenWork);
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

/** Every id an athlete read may NOT be keyed on: only PINNED_REFERENCE_ID is allowed. */
const NEVER_READ_KEYS = [ASSIGNED_OPERATIONAL_ID, REFERENCE_LINEAGE_HEAD_ID, REFERENCE_LINEAGE_ID] as const;

/** The exact top-level keys of a coach 'available' answer. athlete_can_open is gone. */
const COACH_AVAILABLE_KEYS = ['athlete_access', 'audience', 'drill', 'operational_lifecycle', 'state'];

type AssignmentStatus = DrillAssignment['status'];

/**
 * Every assignment status, placed on one side of OD-2026-09-19-002's line by
 * the ruling's own words ("assigned / in progress"). A Record over the status
 * union, so a status added to DrillAssignment later fails to compile here
 * until someone decides which side it belongs on.
 */
const IS_OPEN_BY_STATUS: Record<AssignmentStatus, boolean> = {
  assigned: true,
  in_progress: true,
  completed: false,
  cancelled: false,
  incomplete: false,
};
const OPEN_STATUSES = ['assigned', 'in_progress'] as const satisfies readonly AssignmentStatus[];
const CLOSED_STATUSES = ['completed', 'cancelled', 'incomplete'] as const satisfies readonly AssignmentStatus[];
const ALL_STATUSES: readonly AssignmentStatus[] = [...OPEN_STATUSES, ...CLOSED_STATUSES];

/** Every (audience, status) pair, for the cases where neither may change the answer. */
const AUDIENCE_BY_STATUS = (['athlete', 'coach'] as const).flatMap((audience) =>
  ALL_STATUSES.map((status) => [audience, status] as const),
);

// Names only one read carries, so the drill in an answer says which read it came from.
const LEARN_READ_NAME = 'Catch and Return (from the Learn read)';
const OPEN_WORK_READ_NAME = 'Catch and Return (from the open-work read)';

/** The work, as the route hands it over: the anchor and the status, nothing else is read. */
function work(status: AssignmentStatus, drillId: string | null = ASSIGNED_OPERATIONAL_ID) {
  return { drill_id: drillId, status };
}

/**
 * The athlete read this status must use, and the one it must never touch.
 * Taken from this file's own table, not from isOpenWork, so a wrong
 * isOpenWork cannot agree with itself here.
 */
function athleteReadsFor(status: AssignmentStatus) {
  return IS_OPEN_BY_STATUS[status]
    ? { chosen: mockGetAthleteDrillDetailForOpenWork, other: mockGetAthleteDrillDetail }
    : { chosen: mockGetAthleteDrillDetail, other: mockGetAthleteDrillDetailForOpenWork };
}

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

/** Neither athlete read ran. */
function expectNoAthleteRead() {
  expect(mockGetAthleteDrillDetail).not.toHaveBeenCalled();
  expect(mockGetAthleteDrillDetailForOpenWork).not.toHaveBeenCalled();
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
  mockGetAthleteDrillDetailForOpenWork.mockReset();
  mockGetDrillWithDetail.mockReset();
  mockGetOperationalDrillLifecycle.mockReset();
});

describe('isOpenWork: the line OD-2026-09-19-002 draws ("assigned / in progress")', () => {
  test.each(Object.entries(IS_OPEN_BY_STATUS))('isOpenWork(%j) is %s', (status, open) => {
    expect(isOpenWork(status)).toBe(open);
  });

  test('the open and closed lists used below split the status union exactly', () => {
    expect([...ALL_STATUSES].sort()).toEqual(Object.keys(IS_OPEN_BY_STATUS).sort());
    for (const status of OPEN_STATUSES) expect(IS_OPEN_BY_STATUS[status]).toBe(true);
    for (const status of CLOSED_STATUSES) expect(IS_OPEN_BY_STATUS[status]).toBe(false);
  });

  // A status this ruling never named gets the stricter Learn read, not the
  // exception: the exception is a narrowing, so it is the one that must be earned.
  test.each(['', 'ASSIGNED', 'Assigned', 'In_Progress', 'in-progress', 'in progress', ' assigned', 'assigned ', 'open', 'pending', 'active'])(
    'a status it does not name (%j) is not open work',
    (status) => {
      expect(isOpenWork(status)).toBe(false);
    },
  );
});

describe('resolveAssignmentDrillInstruction: nothing to open', () => {
  // Staff are told which case it is; an athlete gets the same 'unavailable' for
  // all of them, whatever the status of the work. The reads are the same either
  // way: the collapse happens after the decision, so it cannot make either
  // audience read more.
  test.each(AUDIENCE_BY_STATUS)(
    'a legacy assignment with no drill_id is no_drill for staff, unavailable for an athlete, and nothing is read (%s, %s work)',
    async (audience, status) => {
      const result = await resolveAssignmentDrillInstruction(ORG, work(status, null), audience);

      expect(result).toStrictEqual(audience === 'athlete' ? athleteNothingToOpen() : { state: 'no_drill' });
      expect(mockGetDrill).not.toHaveBeenCalled();
      expectNoAthleteRead();
      expect(mockGetDrillWithDetail).not.toHaveBeenCalled();
      expect(mockGetOperationalDrillLifecycle).not.toHaveBeenCalled();
      expectNoDatabaseAccess();
    },
  );

  test.each(AUDIENCE_BY_STATUS)(
    'an operational row that reads as absent is no_drill for staff, unavailable for an athlete, and no library read follows (%s, %s work)',
    async (audience, status) => {
      mockGetDrill.mockResolvedValue(null);

      const result = await resolveAssignmentDrillInstruction(ORG, work(status), audience);

      expect(result).toStrictEqual(audience === 'athlete' ? athleteNothingToOpen() : { state: 'no_drill' });
      expect(mockGetDrill).toHaveBeenCalledTimes(1);
      expect(mockGetDrill).toHaveBeenCalledWith(ORG, ASSIGNED_OPERATIONAL_ID);
      expectNoAthleteRead();
      expect(mockGetDrillWithDetail).not.toHaveBeenCalled();
      expect(mockGetOperationalDrillLifecycle).not.toHaveBeenCalled();
      expectNoDatabaseAccess();
    },
  );

  test.each(AUDIENCE_BY_STATUS)(
    'a gym-written drill (no reference_drill_id) is gym_written for staff, unavailable for an athlete, and no library read follows (%s, %s work)',
    async (audience, status) => {
      mockGetDrill.mockResolvedValue(operationalRow({ reference_drill_id: null }));

      const result = await resolveAssignmentDrillInstruction(ORG, work(status), audience);

      expect(result).toStrictEqual(audience === 'athlete' ? athleteNothingToOpen() : { state: 'gym_written' });
      expect(mockGetDrill).toHaveBeenCalledWith(ORG, ASSIGNED_OPERATIONAL_ID);
      expectNoAthleteRead();
      expect(mockGetDrillWithDetail).not.toHaveBeenCalled();
      expect(mockGetOperationalDrillLifecycle).not.toHaveBeenCalled();
      expectNoDatabaseAccess();
    },
  );

  test('staff are told which case it is: no_drill, gym_written and unavailable stay three distinct answers', async () => {
    const legacy = await resolveAssignmentDrillInstruction(ORG, work('assigned', null), 'coach');

    mockGetDrill.mockResolvedValue(operationalRow({ reference_drill_id: null }));
    const gymWritten = await resolveAssignmentDrillInstruction(ORG, work('assigned'), 'coach');

    mockGetDrill.mockResolvedValue(operationalRow());
    mockGetDrillWithDetail.mockResolvedValue(null);
    mockGetOperationalDrillLifecycle.mockResolvedValue('current');
    mockGetAthleteDrillDetail.mockResolvedValue(null);
    mockGetAthleteDrillDetailForOpenWork.mockResolvedValue(null);
    const withdrawn = await resolveAssignmentDrillInstruction(ORG, work('assigned'), 'coach');

    expect([legacy, gymWritten, withdrawn]).toStrictEqual([
      { state: 'no_drill' },
      { state: 'gym_written' },
      { state: 'unavailable' },
    ]);
  });
});

describe('resolveAssignmentDrillInstruction: athlete', () => {
  test.each(ALL_STATUSES)('available, with the reference pointer dropped as a KEY, not blanked (%s work)', async (status) => {
    const detail = athleteDetail();
    const { chosen } = athleteReadsFor(status);
    mockGetDrill.mockResolvedValue(operationalRow());
    chosen.mockResolvedValue(detail);
    // Answers if asked, so an athlete path that made the status read and
    // carried it would grow a key below rather than pass quietly.
    mockGetOperationalDrillLifecycle.mockResolvedValue('current');

    const result = await resolveAssignmentDrillInstruction(ORG, work(status), 'athlete');

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

    // Every other field is carried as the athlete read shaped it -- the
    // safety stop rule included, which is why open work keeps it at all.
    const { drill_id: _pointer, ...instruction } = detail;
    void _pointer;
    expect(result.drill).toStrictEqual(instruction);

    // Nowhere in the serialized response -- which is what the route sends -- is
    // the reference id, or the operational id the assignment already carries.
    const wire = JSON.stringify(result);
    expect(wire).not.toContain(PINNED_REFERENCE_ID);
    expect(wire).not.toContain(ASSIGNED_OPERATIONAL_ID);
  });

  test.each(ALL_STATUSES)(
    "reads the assignment's OWN operational row's pointer: never assignment.drill_id, never a lineage head (%s work)",
    async (status) => {
      const { chosen, other } = athleteReadsFor(status);
      mockGetDrill.mockResolvedValue(operationalRow());
      // Both athlete reads answer for any id, so a wrong id would still produce
      // a drill -- the wrong one. v1 wording is the only acceptable answer.
      const answerAnyId = async (_org: string, drillId: string) =>
        drillId === PINNED_REFERENCE_ID
          ? athleteDetail()
          : athleteDetail({ drill_id: drillId, name: `Some other drill (${drillId})` });
      mockGetAthleteDrillDetail.mockImplementation(answerAnyId);
      mockGetAthleteDrillDetailForOpenWork.mockImplementation(answerAnyId);

      const result = await resolveAssignmentDrillInstruction(ORG, work(status), 'athlete');

      expect(mockGetDrill.mock.calls).toEqual([[ORG, ASSIGNED_OPERATIONAL_ID]]);
      expect(chosen.mock.calls).toEqual([[ORG, PINNED_REFERENCE_ID]]);
      expect(other).not.toHaveBeenCalled();
      for (const wrongKey of NEVER_READ_KEYS) {
        expect(mockGetAthleteDrillDetail).not.toHaveBeenCalledWith(ORG, wrongKey);
        expect(mockGetAthleteDrillDetailForOpenWork).not.toHaveBeenCalledWith(ORG, wrongKey);
      }
      expect(result).toMatchObject({
        state: 'available',
        audience: 'athlete',
        drill: { name: 'Catch and Return (v1 wording)' },
      });
      // No lineage read of either kind ran underneath (see the db mock), and the
      // status read that staff get did not run for an athlete either.
      expect(mockGetOperationalDrillLifecycle).not.toHaveBeenCalled();
      expectNoDatabaseAccess();
    },
  );

  test.each(ALL_STATUSES)(
    'a retired operational version still resolves through its own pointer; the chosen athlete read alone decides (%s work)',
    async (status) => {
      // v1 was retired and refined into an active v2 that copied the same
      // reference_drill_id forward. The assignment still names v1, so v1 is
      // read, and whether the athlete may see the reference is the chosen
      // athlete read's predicate -- not a second rule grown here, and not the
      // lineage status staff are shown.
      const { chosen } = athleteReadsFor(status);
      mockGetDrill.mockResolvedValue(operationalRow({ active: false }));
      chosen.mockResolvedValue(athleteDetail());
      mockGetOperationalDrillLifecycle.mockResolvedValue('changed');

      const result = await resolveAssignmentDrillInstruction(ORG, work(status), 'athlete');

      expect(result).toMatchObject({ state: 'available', audience: 'athlete' });
      expect(result).not.toHaveProperty('operational_lifecycle');
      expect(chosen.mock.calls).toEqual([[ORG, PINNED_REFERENCE_ID]]);
      expect(mockGetOperationalDrillLifecycle).not.toHaveBeenCalled();
    },
  );

  test.each(ALL_STATUSES)(
    'the chosen athlete read answering null is unavailable: no fallback to the other athlete read or to the coach read (%s work)',
    async (status) => {
      const { chosen, other } = athleteReadsFor(status);
      mockGetDrill.mockResolvedValue(operationalRow());
      chosen.mockResolvedValue(null);
      // If the implementation fell back to either of these, it would hand a
      // withheld drill to an athlete: the other athlete read has the other
      // predicate, and the coach read has none at all.
      other.mockResolvedValue(athleteDetail());
      mockGetDrillWithDetail.mockResolvedValue(coachDetail());
      mockGetOperationalDrillLifecycle.mockResolvedValue('retired');

      const result = await resolveAssignmentDrillInstruction(ORG, work(status), 'athlete');

      expect(result).toStrictEqual(athleteNothingToOpen());
      expect(chosen.mock.calls).toEqual([[ORG, PINNED_REFERENCE_ID]]);
      expect(other).not.toHaveBeenCalled();
      expect(mockGetDrillWithDetail).not.toHaveBeenCalled();
      expect(mockGetOperationalDrillLifecycle).not.toHaveBeenCalled();
    },
  );

  test.each(ALL_STATUSES)(
    'every reason there is nothing to open reaches the athlete as the same answer, naming none of them (%s work)',
    async (status) => {
      // Legacy work, a missing operational row, a gym-written drill and a
      // withheld reference, one after another. Staff are told these apart (see
      // above); an athlete must not be able to, from the response alone.
      const { chosen, other } = athleteReadsFor(status);
      const wires: string[] = [];
      const answerAs = async (drillId: string | null) => {
        wires.push(JSON.stringify(await resolveAssignmentDrillInstruction(ORG, work(status, drillId), 'athlete')));
      };

      await answerAs(null);
      mockGetDrill.mockResolvedValueOnce(null);
      await answerAs(ASSIGNED_OPERATIONAL_ID);
      mockGetDrill.mockResolvedValueOnce(operationalRow({ reference_drill_id: null }));
      await answerAs(ASSIGNED_OPERATIONAL_ID);
      mockGetDrill.mockResolvedValueOnce(operationalRow());
      chosen.mockResolvedValueOnce(null);
      await answerAs(ASSIGNED_OPERATIONAL_ID);

      expect(wires).toEqual([
        '{"state":"unavailable"}',
        '{"state":"unavailable"}',
        '{"state":"unavailable"}',
        '{"state":"unavailable"}',
      ]);
      // The four setups really did take four different paths.
      expect(mockGetDrill).toHaveBeenCalledTimes(3);
      expect(chosen).toHaveBeenCalledTimes(1);
      expect(other).not.toHaveBeenCalled();
      expect(mockGetOperationalDrillLifecycle).not.toHaveBeenCalled();
      expect(mockGetDrillWithDetail).not.toHaveBeenCalled();
    },
  );
});

describe('resolveAssignmentDrillInstruction: athlete, which read the status chooses (OD-2026-09-19-002)', () => {
  // Both athlete reads answer, each with a name only it carries, so the drill
  // in the answer says which read supplied it.
  function bothAthleteReadsAnswer() {
    mockGetAthleteDrillDetail.mockResolvedValue(athleteDetail({ name: LEARN_READ_NAME }));
    mockGetAthleteDrillDetailForOpenWork.mockResolvedValue(athleteDetail({ name: OPEN_WORK_READ_NAME }));
  }

  test.each(OPEN_STATUSES)(
    '%s work is open: its instruction comes from getAthleteDrillDetailForOpenWork, and the Learn read never runs',
    async (status) => {
      mockGetDrill.mockResolvedValue(operationalRow());
      bothAthleteReadsAnswer();

      const result = await resolveAssignmentDrillInstruction(ORG, work(status), 'athlete');

      expect(result).toMatchObject({ state: 'available', audience: 'athlete', drill: { name: OPEN_WORK_READ_NAME } });
      expect(mockGetAthleteDrillDetailForOpenWork.mock.calls).toEqual([[ORG, PINNED_REFERENCE_ID]]);
      expect(mockGetAthleteDrillDetail).not.toHaveBeenCalled();
      expect(mockGetDrillWithDetail).not.toHaveBeenCalled();
      expect(mockGetOperationalDrillLifecycle).not.toHaveBeenCalled();
      expectNoDatabaseAccess();
    },
  );

  test.each(CLOSED_STATUSES)(
    '%s work is not open: its instruction comes from getAthleteDrillDetail (the Learn read), and the open-work read never runs',
    async (status) => {
      mockGetDrill.mockResolvedValue(operationalRow());
      bothAthleteReadsAnswer();

      const result = await resolveAssignmentDrillInstruction(ORG, work(status), 'athlete');

      expect(result).toMatchObject({ state: 'available', audience: 'athlete', drill: { name: LEARN_READ_NAME } });
      expect(mockGetAthleteDrillDetail.mock.calls).toEqual([[ORG, PINNED_REFERENCE_ID]]);
      expect(mockGetAthleteDrillDetailForOpenWork).not.toHaveBeenCalled();
      expect(mockGetDrillWithDetail).not.toHaveBeenCalled();
      expect(mockGetOperationalDrillLifecycle).not.toHaveBeenCalled();
      expectNoDatabaseAccess();
    },
  );

  // The ruling itself, as the two reads would really answer after the gym
  // retires the drill: the Learn read withholds it (no active adoption left),
  // the open-work read still finds the active reference.
  test.each(ALL_STATUSES)('a drill the gym retired opens from %s work only while the work is open', async (status) => {
    mockGetDrill.mockResolvedValue(operationalRow({ active: false }));
    mockGetAthleteDrillDetail.mockResolvedValue(null);
    mockGetAthleteDrillDetailForOpenWork.mockResolvedValue(athleteDetail());
    mockGetOperationalDrillLifecycle.mockResolvedValue('retired');

    const result = await resolveAssignmentDrillInstruction(ORG, work(status), 'athlete');

    if (IS_OPEN_BY_STATUS[status]) {
      expect(result).toMatchObject({
        state: 'available',
        audience: 'athlete',
        drill: { name: 'Catch and Return (v1 wording)', stop_rules: athleteDetail().stop_rules },
      });
    } else {
      expect(result).toStrictEqual(athleteNothingToOpen());
    }
  });

  // A retracted reference fails both reads (both keep `d.active`), so no status opens it.
  test.each(ALL_STATUSES)('a withdrawn reference opens from no work, %s included', async (status) => {
    mockGetDrill.mockResolvedValue(operationalRow());
    mockGetAthleteDrillDetail.mockResolvedValue(null);
    mockGetAthleteDrillDetailForOpenWork.mockResolvedValue(null);
    mockGetDrillWithDetail.mockResolvedValue(coachDetail({ active: false }));

    const result = await resolveAssignmentDrillInstruction(ORG, work(status), 'athlete');

    expect(result).toStrictEqual(athleteNothingToOpen());
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

  function bothAthleteReadsAnswer() {
    mockGetAthleteDrillDetail.mockResolvedValue(athleteDetail());
    mockGetAthleteDrillDetailForOpenWork.mockResolvedValue(athleteDetail());
  }

  test.each(LIFECYCLES)(
    'available in full, and operational_lifecycle is %s as the lifecycle read reports it (row active=%s)',
    async (lifecycle, active) => {
      const detail = coachDetail();
      mockGetDrill.mockResolvedValue(operationalRow({ active }));
      mockGetDrillWithDetail.mockResolvedValue(detail);
      mockGetOperationalDrillLifecycle.mockResolvedValue(lifecycle);
      bothAthleteReadsAnswer();

      const result = await resolveAssignmentDrillInstruction(ORG, work('assigned'), 'coach');

      expect(result).toStrictEqual({
        state: 'available',
        audience: 'coach',
        drill: detail,
        operational_lifecycle: lifecycle,
        athlete_access: 'all_work',
      });
      expect(mockGetDrill.mock.calls).toEqual([[ORG, ASSIGNED_OPERATIONAL_ID]]);
      // Status only: whatever the lineage says, the content stays the pinned
      // reference version -- 'changed' does not move the read to a newer one.
      expect(mockGetDrillWithDetail.mock.calls).toEqual([[ORG, PINNED_REFERENCE_ID]]);
      // Keyed on the operational version the work was issued against (the row
      // getDrill just read), in this gym -- never on a reference id.
      expect(mockGetOperationalDrillLifecycle.mock.calls).toEqual([[ORG, ASSIGNED_OPERATIONAL_ID]]);
      // Both athlete reads run once each, on the same pinned reference, and only
      // to answer athlete_access; the staff drill above is the coach read's.
      expect(mockGetAthleteDrillDetail.mock.calls).toEqual([[ORG, PINNED_REFERENCE_ID]]);
      expect(mockGetAthleteDrillDetailForOpenWork.mock.calls).toEqual([[ORG, PINNED_REFERENCE_ID]]);
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
      bothAthleteReadsAnswer();

      const result = await resolveAssignmentDrillInstruction(ORG, work('assigned'), 'coach');

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
      bothAthleteReadsAnswer();

      const result = await resolveAssignmentDrillInstruction(ORG, work('assigned'), 'coach');

      expect(result).toStrictEqual({
        state: 'available',
        audience: 'coach',
        drill: detail,
        operational_lifecycle: expected,
        athlete_access: 'all_work',
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
    bothAthleteReadsAnswer();

    const result = await resolveAssignmentDrillInstruction(ORG, work('assigned'), 'coach');

    for (const wrongKey of NEVER_READ_KEYS) {
      expect(mockGetDrillWithDetail).not.toHaveBeenCalledWith(ORG, wrongKey);
      expect(mockGetAthleteDrillDetail).not.toHaveBeenCalledWith(ORG, wrongKey);
      expect(mockGetAthleteDrillDetailForOpenWork).not.toHaveBeenCalledWith(ORG, wrongKey);
    }
    // And the status read, for its part, is never pointed at a reference id.
    expect(mockGetOperationalDrillLifecycle).not.toHaveBeenCalledWith(ORG, PINNED_REFERENCE_ID);
    expect(mockGetOperationalDrillLifecycle).not.toHaveBeenCalledWith(ORG, REFERENCE_LINEAGE_HEAD_ID);
    expect(result).toMatchObject({ state: 'available', audience: 'coach', drill: { name: 'v1' } });
  });

  test('the coach read answering null is unavailable, even when both athlete reads answer', async () => {
    mockGetDrill.mockResolvedValue(operationalRow());
    mockGetDrillWithDetail.mockResolvedValue(null);
    // A lifecycle answer does not turn a missing reference into something to open.
    mockGetOperationalDrillLifecycle.mockResolvedValue('current');
    // Nor do the athlete reads: they only ever answer athlete_access, so they
    // are never a fallback source of staff content, and there is no
    // athlete_access without an instruction for it to describe.
    bothAthleteReadsAnswer();

    const result = await resolveAssignmentDrillInstruction(ORG, work('assigned'), 'coach');

    expect(result).toStrictEqual({ state: 'unavailable' });
    expect(mockGetDrillWithDetail.mock.calls).toEqual([[ORG, PINNED_REFERENCE_ID]]);
    // They may run beside the coach read or not at all; either way at most
    // once each, and never pointed anywhere but the pinned reference.
    for (const athleteRead of [mockGetAthleteDrillDetail, mockGetAthleteDrillDetailForOpenWork]) {
      expect(athleteRead.mock.calls.length).toBeLessThanOrEqual(1);
      for (const call of athleteRead.mock.calls) {
        expect(call).toEqual([ORG, PINNED_REFERENCE_ID]);
      }
    }
  });
});

describe('resolveAssignmentDrillInstruction: coach athlete_access', () => {
  // A name only the athlete projections carry, so any of either reaching the
  // staff answer -- a detail passed through as the answer, or merged into the
  // drill -- is visible on the wire.
  const ATHLETE_PROJECTION_NAME = 'athlete projection, never shown to staff';

  function coachReadsWith(learnAnswers: boolean, openWorkAnswers: boolean, detail = coachDetail()) {
    mockGetDrill.mockResolvedValue(operationalRow());
    mockGetDrillWithDetail.mockResolvedValue(detail);
    mockGetOperationalDrillLifecycle.mockResolvedValue('current');
    mockGetAthleteDrillDetail.mockResolvedValue(learnAnswers ? athleteDetail({ name: ATHLETE_PROJECTION_NAME }) : null);
    mockGetAthleteDrillDetailForOpenWork.mockResolvedValue(
      openWorkAnswers ? athleteDetail({ name: ATHLETE_PROJECTION_NAME }) : null,
    );
  }

  // The fourth combination -- the Learn read answering while the open-work
  // read does not -- cannot happen: the open-work read is the Learn read with
  // one term removed (drillLibraryV3.ts), so anything the Learn read returns it
  // returns too. Its answer is deliberately left unpinned here.
  test.each([
    [true, true, 'all_work'],
    [false, true, 'open_work_only'],
    [false, false, 'none'],
  ] as const)(
    'is the two athlete reads reduced to one word: Learn read answers=%s, open-work read answers=%s -> %s',
    async (learnAnswers, openWorkAnswers, access: AthleteInstructionAccess) => {
      const detail = coachDetail();
      coachReadsWith(learnAnswers, openWorkAnswers, detail);

      const result = await resolveAssignmentDrillInstruction(ORG, work('assigned'), 'coach');

      // A plain string beside the staff drill -- not either detail, not a boolean.
      expect(result).toStrictEqual({
        state: 'available',
        audience: 'coach',
        drill: detail,
        operational_lifecycle: 'current',
        athlete_access: access,
      });
      expect(Object.keys(result).sort()).toEqual(COACH_AVAILABLE_KEYS);
      expect(result).not.toHaveProperty('athlete_can_open');
      if (result.state !== 'available' || result.audience !== 'coach') {
        throw new Error(`expected a coach instruction, got ${JSON.stringify(result)}`);
      }
      expect(result.drill).toBe(detail);
      expect(JSON.stringify(result)).not.toContain(ATHLETE_PROJECTION_NAME);

      // Exactly once each, on (org, the operational row's own reference_drill_id).
      expect(mockGetAthleteDrillDetail.mock.calls).toEqual([[ORG, PINNED_REFERENCE_ID]]);
      expect(mockGetAthleteDrillDetailForOpenWork.mock.calls).toEqual([[ORG, PINNED_REFERENCE_ID]]);
      expectNoDatabaseAccess();
    },
  );

  test.each([
    // Run here: both reads find it.
    ['current', true, true, true, 'all_work'],
    // v1 refined into an active v2 that carried the pointer forward: still live for the athlete.
    ['changed', false, true, true, 'all_work'],
    // OD-2026-09-19-002: the gym retired it, so only open work keeps it.
    ['retired', false, false, true, 'open_work_only'],
    // Retired here, but another operational drill still adopts the same
    // reference, so the Learn read still finds it: the reads are what count.
    ['retired', false, true, true, 'all_work'],
    // Current here, but the reference itself was withdrawn: nothing for the athlete.
    ['current', true, false, false, 'none'],
    // Changed or retired AND withdrawn: still nothing.
    ['changed', false, false, false, 'none'],
    ['retired', false, false, false, 'none'],
  ] as const)(
    'follows the athlete reads, never the lifecycle or the row flag: lifecycle %s, row active=%s, Learn=%s, open-work=%s -> %s',
    async (lifecycle, active, learnAnswers, openWorkAnswers, access) => {
      mockGetDrill.mockResolvedValue(operationalRow({ active }));
      mockGetDrillWithDetail.mockResolvedValue(coachDetail());
      mockGetOperationalDrillLifecycle.mockResolvedValue(lifecycle);
      mockGetAthleteDrillDetail.mockResolvedValue(learnAnswers ? athleteDetail() : null);
      mockGetAthleteDrillDetailForOpenWork.mockResolvedValue(openWorkAnswers ? athleteDetail() : null);

      const result = await resolveAssignmentDrillInstruction(ORG, work('assigned'), 'coach');

      expect(result).toMatchObject({
        state: 'available',
        audience: 'coach',
        operational_lifecycle: lifecycle,
        athlete_access: access,
      });
    },
  );

  test('is a property of the drill, not of the card: the same answer from work in every status', async () => {
    // One group issuance leaves cards in different statuses. A coach opening
    // any of them must be told the same thing, so the answer runs BOTH reads
    // every time rather than the one this card's status would choose.
    const answers: Awaited<ReturnType<typeof resolveAssignmentDrillInstruction>>[] = [];
    for (const status of ALL_STATUSES) {
      jest.clearAllMocks();
      coachReadsWith(false, true);

      answers.push(await resolveAssignmentDrillInstruction(ORG, work(status), 'coach'));

      expect(mockGetAthleteDrillDetail.mock.calls).toEqual([[ORG, PINNED_REFERENCE_ID]]);
      expect(mockGetAthleteDrillDetailForOpenWork.mock.calls).toEqual([[ORG, PINNED_REFERENCE_ID]]);
    }

    expect(answers).toHaveLength(ALL_STATUSES.length);
    for (const answer of answers) {
      expect(answer).toStrictEqual(answers[0]);
    }
    expect(answers[0]).toMatchObject({ state: 'available', audience: 'coach', athlete_access: 'open_work_only' });
  });

  test('both reads are keyed on the pinned reference id -- never assignment.drill_id, the reference lineage id or its head', async () => {
    mockGetDrill.mockResolvedValue(operationalRow());
    mockGetDrillWithDetail.mockResolvedValue(coachDetail());
    mockGetOperationalDrillLifecycle.mockResolvedValue('current');
    // Each read answers a detail for EVERY id except the pinned one. The Learn
    // read keyed wrongly would report 'all_work', the open-work read keyed
    // wrongly 'open_work_only' -- each the wrong answer, and each fails below.
    const answerEveryIdButThePinnedOne = async (_org: string, drillId: string) =>
      drillId === PINNED_REFERENCE_ID ? null : athleteDetail({ drill_id: drillId });
    mockGetAthleteDrillDetail.mockImplementation(answerEveryIdButThePinnedOne);
    mockGetAthleteDrillDetailForOpenWork.mockImplementation(answerEveryIdButThePinnedOne);

    const result = await resolveAssignmentDrillInstruction(ORG, work('assigned'), 'coach');

    expect(result).toMatchObject({ state: 'available', audience: 'coach', athlete_access: 'none' });
    expect(mockGetAthleteDrillDetail.mock.calls).toEqual([[ORG, PINNED_REFERENCE_ID]]);
    expect(mockGetAthleteDrillDetailForOpenWork.mock.calls).toEqual([[ORG, PINNED_REFERENCE_ID]]);
    for (const wrongKey of NEVER_READ_KEYS) {
      expect(mockGetAthleteDrillDetail).not.toHaveBeenCalledWith(ORG, wrongKey);
      expect(mockGetAthleteDrillDetailForOpenWork).not.toHaveBeenCalledWith(ORG, wrongKey);
    }
  });

  test.each(AUDIENCE_BY_STATUS)(
    'read counts per resolution (%s, %s work): a coach runs both athlete reads once each; an athlete runs only the one its status chooses',
    async (audience, status) => {
      mockGetDrill.mockResolvedValue(operationalRow());
      mockGetDrillWithDetail.mockResolvedValue(coachDetail());
      mockGetOperationalDrillLifecycle.mockResolvedValue('current');
      mockGetAthleteDrillDetail.mockResolvedValue(athleteDetail());
      mockGetAthleteDrillDetailForOpenWork.mockResolvedValue(athleteDetail());

      const result = await resolveAssignmentDrillInstruction(ORG, work(status), audience);

      expect(result).toMatchObject({ state: 'available', audience });
      if (audience === 'coach') {
        expect(mockGetAthleteDrillDetail.mock.calls).toEqual([[ORG, PINNED_REFERENCE_ID]]);
        expect(mockGetAthleteDrillDetailForOpenWork.mock.calls).toEqual([[ORG, PINNED_REFERENCE_ID]]);
      } else {
        const { chosen, other } = athleteReadsFor(status);
        expect(chosen.mock.calls).toEqual([[ORG, PINNED_REFERENCE_ID]]);
        expect(other).not.toHaveBeenCalled();
      }
      // The coach read (content for staff) runs only for staff.
      expect(mockGetDrillWithDetail).toHaveBeenCalledTimes(audience === 'coach' ? 1 : 0);
    },
  );

  test.each(ALL_STATUSES)('never reaches an athlete: the athlete answer from %s work carries no athlete_access', async (status) => {
    mockGetDrill.mockResolvedValue(operationalRow());
    mockGetAthleteDrillDetail.mockResolvedValue(athleteDetail());
    mockGetAthleteDrillDetailForOpenWork.mockResolvedValue(athleteDetail());

    const result = await resolveAssignmentDrillInstruction(ORG, work(status), 'athlete');

    expect(result).toMatchObject({ state: 'available', audience: 'athlete' });
    expect(result).not.toHaveProperty('athlete_access');
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

/** The module's prose names what it does not call, so comments are stripped before a code scan. */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('assignmentDrillInstruction.ts is read-only', () => {
  const source = fs.readFileSync(path.join(__dirname, 'assignmentDrillInstruction.ts'), 'utf8');
  const code = codeOnly(source);

  test('the scan is looking at the real module, not an emptied string', () => {
    expect(code).toContain('export async function resolveAssignmentDrillInstruction');
    expect(code).toContain('getAthleteDrillDetail(');
    expect(code).toContain('getAthleteDrillDetailForOpenWork(');
    expect(code).toContain('isOpenWork(');
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

describe('getAthleteDrillDetailForOpenWork is reachable only through the assignment resolver', () => {
  // OD-2026-09-19-002 clause 4: "a read keyed by the athlete's own open work,
  // not a browse surface". The read itself cannot enforce that -- handed any id
  // it answers for any active reference in the gym, which is exactly what the
  // Learn rule exists to stop -- so the source tree is scanned instead. Outside
  // tests, the name may appear in exactly two files: its definition, and the
  // resolver that only ever hands it the pinned reference of the athlete's own
  // open work. A browse route, a page, a component or a helper naming it fails
  // here by file name.
  //
  // lib/ is scanned too: it sits under the same "@/" alias as the rest, so it
  // is just as able to reach the read.
  const WEB_ROOT = path.resolve(__dirname, '..', '..', '..');
  const SCANNED_DIRS = ['app', 'components', 'src', 'lib'];
  const SKIPPED_DIRS = new Set(['node_modules', '.next', '.next-offline']);
  const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
  const TEST_FILE = /\.test\.(ts|tsx|js|jsx|mjs|cjs)$/;
  const OPEN_WORK_READ = /\bgetAthleteDrillDetailForOpenWork\b/g;

  const DEFINITION_FILE = 'src/server/pilot/drillLibraryV3.ts';
  const RESOLVER_FILE = 'src/server/pilot/assignmentDrillInstruction.ts';

  function walk(dir: string): string[] {
    // readdirSync throws on a missing directory, so a renamed scan root fails
    // loudly here rather than scanning nothing.
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : walk(full);
      return entry.isFile() && SOURCE_FILE.test(entry.name) ? [full] : [];
    });
  }

  const toRelative = (file: string) => path.relative(WEB_ROOT, file).split(path.sep).join('/');
  const allSourceFiles = SCANNED_DIRS.flatMap((dir) => walk(path.join(WEB_ROOT, dir))).map(toRelative);
  const scannedFiles = allSourceFiles.filter((file) => !TEST_FILE.test(file));
  const read = (file: string) => fs.readFileSync(path.join(WEB_ROOT, file), 'utf8');
  const namesTheRead = (file: string) => (read(file).match(OPEN_WORK_READ) ?? []).length > 0;

  test('the scan sees the real tree: browse routes, components and both server modules, with test files left out', () => {
    expect(WEB_ROOT.split(path.sep).slice(-2)).toEqual(['apps', 'web']);
    expect(scannedFiles.length).toBeGreaterThan(200);
    for (const file of [
      DEFINITION_FILE,
      RESOLVER_FILE,
      // The Learn browse route, and the assignment route that feeds the resolver.
      'app/api/pilot/drill-library/route.ts',
      'app/api/pilot/progression/drill-instruction/route.ts',
      'components/drills/CoachInstructionPanel.tsx',
      'components/drills/drillInstructionRead.ts',
    ]) {
      expect(scannedFiles).toContain(file);
    }
    // A positive control: the scan reads real content in app/ -- the Learn
    // browse route does call the Learn read, and the scan can see it.
    expect(codeOnly(read('app/api/pilot/drill-library/route.ts'))).toMatch(/\bgetAthleteDrillDetail\(/);
    // This file names the open-work read many times and is still not flagged,
    // because tests are left out -- and only tests are.
    const thisFile = toRelative(__filename);
    expect(allSourceFiles).toContain(thisFile);
    expect(namesTheRead(thisFile)).toBe(true);
    expect(scannedFiles).not.toContain(thisFile);
    const scanned = new Set(scannedFiles);
    expect(allSourceFiles.filter((file) => !scanned.has(file)).every((file) => TEST_FILE.test(file))).toBe(true);
  });

  test('outside tests, only its definition and the assignment resolver name it', () => {
    expect(scannedFiles.filter(namesTheRead).sort()).toEqual([RESOLVER_FILE, DEFINITION_FILE].sort());
  });

  test('drillLibraryV3.ts only defines it: nothing there calls it or re-exports it under another name', () => {
    const occurrences = codeOnly(read(DEFINITION_FILE)).match(OPEN_WORK_READ) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(codeOnly(read(DEFINITION_FILE))).toMatch(/export async function getAthleteDrillDetailForOpenWork\(/);
  });

  test('the resolver hands no route another way to it: its runtime exports are exactly these three', () => {
    // A wrapper or an alias exported from here would let a browse path reach
    // the open-work read without ever naming it, so the scan above would pass.
    expect(Object.keys(resolverModule).sort()).toEqual([
      'isOpenWork',
      'resolveAssignmentDrillInstruction',
      'withoutReferencePointer',
    ]);
  });
});
