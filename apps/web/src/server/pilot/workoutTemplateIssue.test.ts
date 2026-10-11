// issueWorkoutTemplate (workoutTemplates.ts), with every collaborator faked.
//
// This suite is about the DECISIONS: which steps are assigned, which drills
// are adopted, which refuse the whole issue and under what name, and that a
// refusal reaches no writer. That the writes really are one transaction -- and
// that a failure part-way leaves nothing -- is proven against real PostgreSQL
// in workoutTemplateIssue.pg.test.ts, not here.
//
// adoptionReadiness and requiresFloorValidation are deliberately NOT mocked:
// they are pure, and the point of the cases below is that the real check
// decides what a template issue may adopt.

const transactionClient = { query: jest.fn() };

jest.mock('./db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => null),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(transactionClient)),
}));

jest.mock('./drillLibraryV3', () => ({
  getDrillWithDetail: jest.fn(),
  getOtherVersionAdoption: jest.fn(),
  listReferenceLifecycles: jest.fn(),
}));

jest.mock('./drillFloorValidations', () => ({
  listFloorValidations: jest.fn(),
}));

jest.mock('./drills', () => {
  const actual = jest.requireActual('./drills');
  return { ...actual, promoteReferenceDrill: jest.fn() };
});

jest.mock('./coachCards', () => ({
  issueCoachCard: jest.fn(),
}));

jest.mock('./audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./progression', () => {
  const actual = jest.requireActual('./progression');
  return { ...actual, assertNewAssignmentMeetsCueRule: jest.fn() };
});

import { writePilotAuditEvent } from './audit';
import { issueCoachCard } from './coachCards';
import { query, queryOne, withTransaction } from './db';
import { listFloorValidations } from './drillFloorValidations';
import { getDrillWithDetail, getOtherVersionAdoption, listReferenceLifecycles } from './drillLibraryV3';
import { DrillNameTakenError, ReferenceDrillAlreadyPromotedError, promoteReferenceDrill } from './drills';
import { ConflictError } from './errors';
import { assertNewAssignmentMeetsCueRule } from './progression';
import { TEMPLATE_STEP_FIELDS_NOT_CARRIED, issueWorkoutTemplate } from './workoutTemplates';

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockTransaction = withTransaction as jest.Mock;
const mockReference = getDrillWithDetail as jest.Mock;
const mockOtherVersion = getOtherVersionAdoption as jest.Mock;
const mockLifecycles = listReferenceLifecycles as jest.Mock;
const mockFloorTested = listFloorValidations as jest.Mock;
const mockPromote = promoteReferenceDrill as jest.Mock;
const mockCard = issueCoachCard as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;
const mockCueRule = assertNewAssignmentMeetsCueRule as jest.Mock;

const ORG = 'org-1';
const TEMPLATE_ID = 'wtp_1';
const ATHLETE = 'athlete-1';
const DRAFT = 'LITERATURE-GROUNDED DRAFT — generated from cited registry claims; REQUIRES FLOOR VALIDATION';
const NOT_FLOOR_TESTED =
  'It is a draft that requires floor validation, and no coach of this gym has marked it floor-tested.';

const PARAMS = {
  organizationId: ORG,
  templateId: TEMPLATE_ID,
  athleteId: ATHLETE,
  actorAccountId: 'coach-1',
  actorRole: 'coach' as const,
};

function template(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: ORG,
    template_id: TEMPLATE_ID,
    name: 'Technical Tuesday',
    version: 2,
    active: true,
    superseded_at: null,
    ...overrides,
  };
}

function item(ordinal: number, overrides: Record<string, unknown> = {}) {
  return {
    organization_id: ORG,
    item_id: `wti_${ordinal}`,
    template_id: TEMPLATE_ID,
    ordinal,
    block: 'technical',
    drill_id: `ref-${ordinal}`,
    free_text_drill: null,
    scale_level: 'B',
    duration_minutes: 6,
    rep_count: null,
    contact_level: 'none',
    coach_note: 'Keep it light.',
    ...overrides,
  };
}

// A READY reference drill: everything adoptionReadiness checks is present.
function reference(drillId: string, overrides: Record<string, unknown> = {}) {
  return {
    organization_id: ORG,
    drill_id: drillId,
    superseded_at: null,
    name: `Drill ${drillId}`,
    discipline: 'boxing',
    category: 'technical',
    difficulty: 'intermediate',
    purpose: '  Return the rear hand to guard.  ',
    standard_setup: 'Partners at technical distance.',
    execution: 'Throw the cross and bring the rear hand home.',
    what_good_looks_like: 'The rear hand is back before the next punch leaves.',
    field_provenance: 'PPBF source manual v3',
    active: true,
    cues: [{ cue_text: ' Chin behind the shoulder ' }, { cue_text: '   ' }, { cue_text: 'Hand home first' }],
    scale_levels: [
      { scale_level: 'A', is_starting_point: false },
      { scale_level: 'B', is_starting_point: true },
      { scale_level: 'C', is_starting_point: false },
    ],
    stop_rules: [{ ordinal: 1, condition_text: 'Stop on any head contact' }],
    ...overrides,
  };
}

function assignment(drillId: string, n: number) {
  return { assignment_id: `assignment_${n}`, drill_id: drillId, athlete_id: ATHLETE, gap_id: null };
}

/** What the gym's library holds for one reference drill: its row and its lifecycle. */
interface LibraryEntry {
  row?: Record<string, unknown> | null;
  state: string;
  operational?: string | null;
}

/**
 * Sets the template the read returns, and the library the plan reads.
 * `library` maps a reference drill id to its row and lifecycle.
 */
function given(opts: {
  template?: Record<string, unknown> | null;
  items?: Record<string, unknown>[];
  library?: Record<string, LibraryEntry>;
  floorTested?: string[];
}) {
  mockQueryOne.mockResolvedValue(opts.template === undefined ? template() : opts.template);
  mockQuery.mockResolvedValue(opts.items ?? []);
  const library = opts.library ?? {};
  mockLifecycles.mockResolvedValue(
    Object.fromEntries(
      Object.entries(library).map(([id, entry]) => [
        id,
        { state: entry.state, operational_drill_id: entry.operational ?? null },
      ]),
    ),
  );
  mockReference.mockImplementation(async (_org: string, id: string) =>
    library[id]?.row === undefined ? reference(id) : library[id].row,
  );
  mockFloorTested.mockResolvedValue(Object.fromEntries((opts.floorTested ?? []).map((id) => [id, { drill_id: id }])));
  mockOtherVersion.mockResolvedValue(null);
}

function expectNothingWritten() {
  expect(mockTransaction).not.toHaveBeenCalled();
  expect(mockPromote).not.toHaveBeenCalled();
  expect(mockCard).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
}

let cardCount = 0;

beforeEach(() => {
  jest.clearAllMocks();
  cardCount = 0;
  mockCueRule.mockResolvedValue(undefined);
  mockCard.mockImplementation(async (params: { drillId: string }) => {
    cardCount += 1;
    return assignment(params.drillId, cardCount);
  });
  mockPromote.mockImplementation(async (params: { referenceDrillId: string; name: string; category: string; difficulty: string }) => ({
    drill_id: `op-${params.referenceDrillId}`,
    reference_drill_id: params.referenceDrillId,
    name: params.name,
    category: params.category,
    difficulty: params.difficulty,
  }));
});

describe('the template itself', () => {
  test('an id that names no template in this gym is not_found, and nothing else is read', async () => {
    given({ template: null });

    await expect(issueWorkoutTemplate(PARAMS)).resolves.toEqual({ outcome: 'not_found' });

    // The read is scoped to the session's gym: another gym's id selects nothing.
    expect(mockQueryOne.mock.calls[0][1]).toEqual([ORG, TEMPLATE_ID]);
    expect(mockLifecycles).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  const NOT_CURRENT: Array<[string, Record<string, unknown>]> = [
    ['withdrawn', { active: false }],
    ['replaced by a newer version', { superseded_at: '2026-10-01T00:00:00.000Z' }],
  ];

  test.each(NOT_CURRENT)('a %s template is refused and nothing is written', async (_label, overrides) => {
    given({ template: template(overrides), items: [item(1)], library: { 'ref-1': { state: 'operational', operational: 'op-1' } } });

    await expect(issueWorkoutTemplate(PARAMS)).rejects.toMatchObject({
      status: 409,
      code: 'WORKOUT_TEMPLATE_NOT_CURRENT',
    });
    expectNothingWritten();
  });

  test('a template with no steps is refused', async () => {
    given({ items: [] });

    await expect(issueWorkoutTemplate(PARAMS)).rejects.toMatchObject({ status: 409, code: 'WORKOUT_TEMPLATE_EMPTY' });
    expectNothingWritten();
  });
});

describe('a template whose drills the gym already runs', () => {
  test('every step becomes one gap-free assignment of the gym drill, in one transaction, with one audit event', async () => {
    given({
      items: [item(1, { duration_minutes: 8, rep_count: null }), item(2, { duration_minutes: null, rep_count: 20 })],
      library: {
        'ref-1': { state: 'operational', operational: 'op-1' },
        'ref-2': { state: 'operational', operational: 'op-2' },
      },
    });

    const result = await issueWorkoutTemplate(PARAMS);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockPromote).not.toHaveBeenCalled();
    expect(mockCard.mock.calls).toEqual([
      [
        { organizationId: ORG, athleteId: ATHLETE, assignedByAccountId: 'coach-1', drillId: 'op-1', repCount: undefined, durationMinutes: 8 },
        transactionClient,
      ],
      [
        { organizationId: ORG, athleteId: ATHLETE, assignedByAccountId: 'coach-1', drillId: 'op-2', repCount: 20, durationMinutes: undefined },
        transactionClient,
      ],
    ]);

    // One audit event, on the transaction, and it is the template link.
    expect(mockAudit).toHaveBeenCalledTimes(1);
    const [event, client] = mockAudit.mock.calls[0];
    expect(client).toBe(transactionClient);
    expect(event).toMatchObject({
      event_type: 'create',
      actor_account_id: 'coach-1',
      actor_role: 'coach',
      organization_id: ORG,
      entity_type: 'workout_template_issue',
      entity_id: TEMPLATE_ID,
      details: {
        athlete_id: ATHLETE,
        template_version: 2,
        steps: [
          { step: 1, item_id: 'wti_1', assignment_id: 'assignment_1', drill_id: 'op-1' },
          { step: 2, item_id: 'wti_2', assignment_id: 'assignment_2', drill_id: 'op-2' },
        ],
        adopted_drill_ids: [],
        not_carried: [...TEMPLATE_STEP_FIELDS_NOT_CARRIED],
      },
    });

    expect(result).toEqual({
      outcome: 'issued',
      template: { template_id: TEMPLATE_ID, name: 'Technical Tuesday', version: 2 },
      steps: [
        { step: 1, item_id: 'wti_1', assignment: assignment('op-1', 1) },
        { step: 2, item_id: 'wti_2', assignment: assignment('op-2', 2) },
      ],
      adopted: [],
    });
  });

  test('a running drill is assigned even when its reference has since been withdrawn', async () => {
    given({
      items: [item(1)],
      library: { 'ref-1': { row: reference('ref-1', { active: false }), state: 'operational', operational: 'op-1' } },
    });

    await expect(issueWorkoutTemplate(PARAMS)).resolves.toMatchObject({ outcome: 'issued', adopted: [] });
    expect(mockCard).toHaveBeenCalledTimes(1);
  });

  test('a running drill that breaks the cue rule refuses the issue and is named', async () => {
    given({ items: [item(1)], library: { 'ref-1': { state: 'operational', operational: 'op-1' } } });
    mockCueRule.mockRejectedValue(new ConflictError('Add a coaching cue to "Drill ref-1" first.', 'DRILL_CUE_REQUIRED'));

    const result = await issueWorkoutTemplate(PARAMS);

    expect(mockCueRule).toHaveBeenCalledWith(ORG, 'op-1');
    expect(result).toMatchObject({
      outcome: 'refused',
      drills: [{ steps: [1], drill_id: 'ref-1', name: 'Drill ref-1', untested_draft: false, reason: 'Add a coaching cue to "Drill ref-1" first.' }],
    });
    expectNothingWritten();
  });

  test('a cue-rule read that fails for another reason is not turned into a refusal', async () => {
    given({ items: [item(1)], library: { 'ref-1': { state: 'operational', operational: 'op-1' } } });
    mockCueRule.mockRejectedValue(new Error('connection lost'));

    await expect(issueWorkoutTemplate(PARAMS)).rejects.toThrow('connection lost');
    expectNothingWritten();
  });
});

describe('a step naming a reference drill the gym has not adopted (OD-2026-10-07-012 ruling 2)', () => {
  test('a ready one is adopted in the same transaction, audited as a promotion, then assigned', async () => {
    given({
      items: [item(1), item(2)],
      library: {
        'ref-1': { state: 'operational', operational: 'op-1' },
        'ref-2': { state: 'available' },
      },
    });

    const result = await issueWorkoutTemplate(PARAMS);

    // The promote route's mapping: focus <- purpose (trimmed), blank cues dropped.
    expect(mockPromote).toHaveBeenCalledTimes(1);
    expect(mockPromote.mock.calls[0]).toEqual([
      {
        organizationId: ORG,
        referenceDrillId: 'ref-2',
        name: 'Drill ref-2',
        category: 'technical',
        focus: 'Return the rear hand to guard.',
        difficulty: 'intermediate',
        cues: ['Chin behind the shoulder', 'Hand home first'],
      },
      transactionClient,
    ]);

    // Two audit rows, both on the transaction: the adoption, then the issue.
    expect(mockAudit.mock.calls.map(([event, client]) => [event.entity_type, event.entity_id, client === transactionClient])).toEqual([
      ['drill', 'op-ref-2', true],
      ['workout_template_issue', TEMPLATE_ID, true],
    ]);
    expect(mockAudit.mock.calls[0][0].details).toEqual({
      name: 'Drill ref-2',
      category: 'technical',
      difficulty: 'intermediate',
      reference_drill_id: 'ref-2',
      adopted_by: 'workout_template_issue',
      template_id: TEMPLATE_ID,
    });
    expect(mockAudit.mock.calls[1][0].details.adopted_drill_ids).toEqual(['op-ref-2']);

    // The adopted drill is what step 2 is carded from.
    expect(mockCard.mock.calls.map(([params]) => params.drillId)).toEqual(['op-1', 'op-ref-2']);
    // Adoption happens before any card is written.
    expect(mockPromote.mock.invocationCallOrder[0]).toBeLessThan(mockCard.mock.invocationCallOrder[0]);

    expect(result).toMatchObject({
      outcome: 'issued',
      adopted: [{ drill_id: 'op-ref-2', reference_drill_id: 'ref-2', name: 'Drill ref-2' }],
    });
  });

  test('a drill named by two steps is adopted once and assigned twice', async () => {
    given({
      items: [item(1, { drill_id: 'ref-9' }), item(2, { drill_id: 'ref-9' })],
      library: { 'ref-9': { state: 'available' } },
    });

    const result = await issueWorkoutTemplate(PARAMS);

    expect(mockPromote).toHaveBeenCalledTimes(1);
    expect(mockCard.mock.calls.map(([params]) => params.drillId)).toEqual(['op-ref-9', 'op-ref-9']);
    expect(result).toMatchObject({ outcome: 'issued', adopted: [{ drill_id: 'op-ref-9' }] });
  });

  test('an adopted drill takes at most the first twelve cues', async () => {
    const cues = Array.from({ length: 15 }, (_, n) => ({ cue_text: `cue ${n + 1}` }));
    given({ items: [item(1)], library: { 'ref-1': { row: reference('ref-1', { cues }), state: 'available' } } });

    await issueWorkoutTemplate(PARAMS);

    expect(mockPromote.mock.calls[0][0].cues).toEqual(cues.slice(0, 12).map((cue) => cue.cue_text));
  });

  test('a conditioning drill with no cue is adopted: the cue rule exempts it', async () => {
    given({
      items: [item(1)],
      library: { 'ref-1': { row: reference('ref-1', { discipline: 'conditioning', cues: [] }), state: 'available' } },
    });

    await expect(issueWorkoutTemplate(PARAMS)).resolves.toMatchObject({ outcome: 'issued' });
    expect(mockPromote.mock.calls[0][0].cues).toEqual([]);
  });

  test('a DRAFT a coach of this gym has floor-tested is adopted', async () => {
    given({
      items: [item(1)],
      library: { 'ref-1': { row: reference('ref-1', { field_provenance: DRAFT }), state: 'available' } },
      floorTested: ['ref-1'],
    });

    await expect(issueWorkoutTemplate(PARAMS)).resolves.toMatchObject({
      outcome: 'issued',
      adopted: [{ reference_drill_id: 'ref-1' }],
    });
    // Asked of THIS gym, for exactly the drills the template names.
    expect(mockFloorTested).toHaveBeenCalledWith(ORG, ['ref-1']);
  });
});

describe('an untested DRAFT drill (OD-2026-10-08-002 item 2)', () => {
  test('refuses the whole issue, names the drill, and writes nothing', async () => {
    given({
      items: [item(1), item(2), item(3)],
      library: {
        'ref-1': { state: 'operational', operational: 'op-1' },
        'ref-2': { row: reference('ref-2', { name: 'Slip Rope Shuffle', field_provenance: DRAFT }), state: 'available' },
        'ref-3': { state: 'available' },
      },
    });

    const result = await issueWorkoutTemplate(PARAMS);

    expect(result).toEqual({
      outcome: 'refused',
      message: 'Nothing was issued. Not floor-tested by a coach of this gym yet: Slip Rope Shuffle.',
      drills: [{ steps: [2], drill_id: 'ref-2', name: 'Slip Rope Shuffle', untested_draft: true, reason: NOT_FLOOR_TESTED }],
    });
    expectNothingWritten();
  });

  test('every untested draft is named, with the steps that use it', async () => {
    given({
      items: [item(1, { drill_id: 'ref-a' }), item(2, { drill_id: 'ref-b' }), item(3, { drill_id: 'ref-a' })],
      library: {
        'ref-a': { row: reference('ref-a', { name: 'Draft A', field_provenance: DRAFT }), state: 'available' },
        'ref-b': { row: reference('ref-b', { name: 'Draft B', field_provenance: DRAFT }), state: 'available' },
      },
    });

    const result = await issueWorkoutTemplate(PARAMS);

    expect(result).toMatchObject({
      outcome: 'refused',
      message: 'Nothing was issued. Not floor-tested by a coach of this gym yet: Draft A, Draft B.',
      drills: [
        { steps: [1, 3], drill_id: 'ref-a', untested_draft: true },
        { steps: [2], drill_id: 'ref-b', untested_draft: true },
      ],
    });
    expectNothingWritten();
  });

  test("another gym's floor test does not count: the mark is read for this gym only", async () => {
    given({
      items: [item(1)],
      library: { 'ref-1': { row: reference('ref-1', { field_provenance: DRAFT }), state: 'available' } },
      floorTested: [],
    });

    await expect(issueWorkoutTemplate(PARAMS)).resolves.toMatchObject({ outcome: 'refused' });
    expect(mockFloorTested.mock.calls[0][0]).toBe(ORG);
  });
});

describe('every other step that cannot be assigned refuses the whole issue and is named', () => {
  const NOT_ASSIGNABLE: Array<[string, LibraryEntry, string]> = [
    ['a withdrawn reference', { row: reference('ref-1', { active: false }), state: 'unavailable' }, 'The reference drill has been withdrawn.'],
    [
      'a reference superseded by a newer version',
      { row: reference('ref-1', { superseded_at: '2026-10-01T00:00:00.000Z' }), state: 'superseded' },
      'A newer version of this reference drill exists.',
    ],
    [
      'a technique drill with no coaching cue',
      { row: reference('ref-1', { cues: [] }), state: 'available' },
      'It has no coaching cue.',
    ],
    ['a drill with no stop rules', { row: reference('ref-1', { stop_rules: [] }), state: 'available' }, 'It has no stop rules.'],
    [
      'a drill this gym adopted and then retired',
      { state: 'retired', operational: 'op-old' },
      'This gym adopted this drill and then retired it. Restore it in the drill library first.',
    ],
    [
      'a difficulty outside the operational vocabulary',
      { row: reference('ref-1', { difficulty: 'legendary' }), state: 'available' },
      'Its difficulty is not one this gym can assign.',
    ],
    ['a drill that cannot be read from the library', { row: null, state: 'available' }, 'This drill could not be read from the library.'],
  ];

  test.each(NOT_ASSIGNABLE)('%s', async (_label, entry, reason) => {
    given({
      items: [item(1), item(2)],
      library: { 'ref-1': entry, 'ref-2': { state: 'operational', operational: 'op-2' } },
    });

    const result = await issueWorkoutTemplate(PARAMS);

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.drills).toHaveLength(1);
    expect(result.drills[0]).toMatchObject({ steps: [1], drill_id: 'ref-1', untested_draft: false });
    expect(result.drills[0].reason).toContain(reason);
    expect(result.message).toBe(`Nothing was issued. Cannot be assigned as they stand: ${result.drills[0].name}.`);
    expectNothingWritten();
  });

  test('the gym holds another version of the drill: the template is not pointed at it', async () => {
    given({ items: [item(1)], library: { 'ref-1': { state: 'newer_version_available', operational: 'op-other' } } });
    mockOtherVersion.mockResolvedValue({ operational_drill_id: 'op-other', adopted_reference_drill_id: 'ref-0' });

    const result = await issueWorkoutTemplate(PARAMS);

    expect(mockOtherVersion).toHaveBeenCalledWith(ORG, 'ref-1');
    expect(result).toMatchObject({
      outcome: 'refused',
      drills: [{
        steps: [1],
        drill_id: 'ref-1',
        reason: 'This gym already has another version of this drill, and this template names a different one.',
      }],
    });
    expectNothingWritten();
  });

  test('a typed step (no drill) is refused: a new assignment needs a drill (OD-2026-09-18-001)', async () => {
    given({
      items: [item(1), item(2, { drill_id: null, free_text_drill: 'Jump rope, easy' })],
      library: { 'ref-1': { state: 'operational', operational: 'op-1' } },
    });

    const result = await issueWorkoutTemplate(PARAMS);

    expect(result).toEqual({
      outcome: 'refused',
      message: 'Nothing was issued. Cannot be assigned as they stand: Jump rope, easy.',
      drills: [{
        steps: [2],
        drill_id: null,
        name: 'Jump rope, easy',
        untested_draft: false,
        reason: 'This step is typed text, not a drill from the library, so it cannot be assigned.',
      }],
    });
    expectNothingWritten();
  });

  test('untested drafts and other refusals are reported together, in step order', async () => {
    given({
      items: [item(1), item(2), item(3, { drill_id: null, free_text_drill: 'Shadow round' })],
      library: {
        'ref-1': { row: reference('ref-1', { name: 'No Stops', stop_rules: [] }), state: 'available' },
        'ref-2': { row: reference('ref-2', { name: 'Draft Two', field_provenance: DRAFT }), state: 'available' },
      },
    });

    const result = await issueWorkoutTemplate(PARAMS);

    expect(result).toMatchObject({
      outcome: 'refused',
      message:
        'Nothing was issued. Not floor-tested by a coach of this gym yet: Draft Two. Cannot be assigned as they stand: No Stops, Shadow round.',
    });
    if (result.outcome !== 'refused') return;
    expect(result.drills.map((drill) => drill.steps)).toEqual([[1], [2], [3]]);
    expectNothingWritten();
  });
});

describe('a write that fails inside the transaction', () => {
  test('a name already taken by a drill the gym wrote refuses the issue and names the drill', async () => {
    given({ items: [item(1)], library: { 'ref-1': { row: reference('ref-1', { name: 'Jab Ladder' }), state: 'available' } } });
    mockPromote.mockRejectedValue(new DrillNameTakenError('Jab Ladder'));

    const result = await issueWorkoutTemplate(PARAMS);

    expect(result).toEqual({
      outcome: 'refused',
      message: 'Nothing was issued. Cannot be assigned as they stand: Jab Ladder.',
      drills: [{
        steps: [1],
        drill_id: 'ref-1',
        name: 'Jab Ladder',
        untested_draft: false,
        reason: 'This gym already has a drill named "Jab Ladder", so this one cannot be adopted under that name.',
      }],
    });
    expect(mockCard).not.toHaveBeenCalled();
  });

  test('a drill adopted by someone else in the meantime is a conflict to retry, not a silent success', async () => {
    given({ items: [item(1)], library: { 'ref-1': { state: 'available' } } });
    mockPromote.mockRejectedValue(new ReferenceDrillAlreadyPromotedError('ref-1'));

    await expect(issueWorkoutTemplate(PARAMS)).rejects.toMatchObject({
      status: 409,
      code: 'WORKOUT_TEMPLATE_ISSUE_STATE_CHANGED',
    });
    expect(mockCard).not.toHaveBeenCalled();
  });

  test('a card that cannot be written fails the whole issue: the error leaves the transaction', async () => {
    given({
      items: [item(1), item(2)],
      library: {
        'ref-1': { state: 'operational', operational: 'op-1' },
        'ref-2': { state: 'operational', operational: 'op-2' },
      },
    });
    const notAssignable = new Error('That drill is not an active drill in this gym, so it cannot be assigned.');
    mockCard.mockResolvedValueOnce(assignment('op-1', 1)).mockRejectedValueOnce(notAssignable);

    await expect(issueWorkoutTemplate(PARAMS)).rejects.toBe(notAssignable);
    // The issue's own audit event is never reached.
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('every read is scoped to the session gym', () => {
  test('the organization id reaches each collaborator', async () => {
    given({ items: [item(1)], library: { 'ref-1': { state: 'available' } } });

    await issueWorkoutTemplate(PARAMS);

    expect(mockLifecycles).toHaveBeenCalledWith(ORG, ['ref-1']);
    expect(mockFloorTested).toHaveBeenCalledWith(ORG, ['ref-1']);
    expect(mockReference).toHaveBeenCalledWith(ORG, 'ref-1');
    expect(mockOtherVersion).toHaveBeenCalledWith(ORG, 'ref-1');
    expect(mockPromote.mock.calls[0][0].organizationId).toBe(ORG);
    expect(mockCard.mock.calls[0][0].organizationId).toBe(ORG);
  });
});
