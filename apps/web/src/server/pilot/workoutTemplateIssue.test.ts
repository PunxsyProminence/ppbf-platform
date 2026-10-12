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

jest.mock('./drillVersioning', () => ({
  updateDrillToReferenceVersion: jest.fn(),
}));

jest.mock('./coachCards', () => ({
  issueCoachCard: jest.fn(),
}));

jest.mock('./audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./workoutIssues', () => ({
  // The real error class: the writer tells it apart by type.
  WorkoutIssueRequestKeyTakenError: jest.requireActual('./workoutIssues').WorkoutIssueRequestKeyTakenError,
  recordWorkoutIssue: jest.fn(),
  findWorkoutIssueByRequestKey: jest.fn(),
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
import { updateDrillToReferenceVersion } from './drillVersioning';
import { DrillNameTakenError, ReferenceDrillAlreadyPromotedError, promoteReferenceDrill } from './drills';
import { ConflictError } from './errors';
import { assertNewAssignmentMeetsCueRule } from './progression';
import { findWorkoutIssueByRequestKey, recordWorkoutIssue, WorkoutIssueRequestKeyTakenError } from './workoutIssues';
import { issueWorkoutTemplate } from './workoutTemplates';

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
const mockRecordIssue = recordWorkoutIssue as jest.Mock;
const mockUpdate = updateDrillToReferenceVersion as jest.Mock;
const mockFindByKey = findWorkoutIssueByRequestKey as jest.Mock;

const ORG = 'org-1';
const TEMPLATE_ID = 'wtp_1';
const ATHLETE = 'athlete-1';
const DRAFT = 'LITERATURE-GROUNDED DRAFT — generated from cited registry claims; REQUIRES FLOOR VALIDATION';

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
  /** Names the gym's ACTIVE drills already hold (the plan's one read of pilot.drills). */
  takenNames?: Array<string | { name: string; lineage_id: string }>;
  /** The gym's drill for another version of a step's drill: its lineage and whether any version runs. */
  gymDrill?: { lineage_id: string; lineage_active: boolean } | null;
}) {
  const templateRow = opts.template === undefined ? template() : opts.template;
  mockQueryOne.mockImplementation(async (text: string) =>
    /from pilot\.drills d/.test(text) ? (opts.gymDrill ?? null) : templateRow,
  );
  mockQuery.mockImplementation(async (text: string) =>
    /from pilot\.drills d/.test(text)
      ? (opts.takenNames ?? []).map((taken) => (typeof taken === 'string' ? { name: taken, lineage_id: `lineage-${taken}` } : taken))
      : (opts.items ?? []),
  );
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
  expect(mockRecordIssue).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
}

let cardCount = 0;

beforeEach(() => {
  jest.clearAllMocks();
  cardCount = 0;
  mockCueRule.mockResolvedValue(undefined);
  mockRecordIssue.mockResolvedValue('issue-1');
  // Reset, not only cleared: a case here queues one-time answers.
  mockFindByKey.mockReset();
  mockFindByKey.mockResolvedValue(null);
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
        issue_id: 'issue-1',
        template_version: 2,
        steps: [
          { step: 1, item_id: 'wti_1', assignment_id: 'assignment_1', drill_id: 'op-1' },
          { step: 2, item_id: 'wti_2', assignment_id: 'assignment_2', drill_id: 'op-2' },
        ],
        adopted_drill_ids: [],
      },
    });
    expect(event.details).not.toHaveProperty('not_carried');

    expect(result).toEqual({
      outcome: 'issued',
      issue_id: 'issue-1',
      template: { template_id: TEMPLATE_ID, name: 'Technical Tuesday', version: 2 },
      steps: [
        { step: 1, item_id: 'wti_1', assignment: assignment('op-1', 1) },
        { step: 2, item_id: 'wti_2', assignment: assignment('op-2', 2) },
      ],
      adopted: [],
      updated: [],
      untested: [],
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

  test('a running drill whose reference has since been SUPERSEDED is assigned too', async () => {
    given({
      items: [item(1)],
      library: {
        'ref-1': {
          row: reference('ref-1', { superseded_at: '2026-10-01T00:00:00.000Z' }),
          state: 'operational',
          operational: 'op-1',
        },
      },
    });

    await expect(issueWorkoutTemplate(PARAMS)).resolves.toMatchObject({ outcome: 'issued', adopted: [] });
    expect(mockCard.mock.calls.map(([params]) => params.drillId)).toEqual(['op-1']);
  });

  test('a running drill that breaks the cue rule refuses the issue and is named', async () => {
    given({ items: [item(1)], library: { 'ref-1': { state: 'operational', operational: 'op-1' } } });
    mockCueRule.mockRejectedValue(new ConflictError('Add a coaching cue to "Drill ref-1" first.', 'DRILL_CUE_REQUIRED'));

    const result = await issueWorkoutTemplate(PARAMS);

    expect(mockCueRule).toHaveBeenCalledWith(ORG, 'op-1');
    expect(result).toMatchObject({
      outcome: 'refused',
      drills: [{ steps: [1], drill_id: 'ref-1', name: 'Drill ref-1', reason: 'Add a coaching cue to "Drill ref-1" first.' }],
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

describe('an untested DRAFT does not stop the issue (Jason, 2026-10-11: "B", issue #1473)', () => {
  test('it is adopted and assigned with the rest, and the result and the audit name it', async () => {
    given({
      items: [item(1), item(2), item(3)],
      library: {
        'ref-1': { state: 'operational', operational: 'op-1' },
        'ref-2': { row: reference('ref-2', { name: 'Slip Rope Shuffle', field_provenance: DRAFT }), state: 'available' },
        'ref-3': { state: 'available' },
      },
    });

    const result = await issueWorkoutTemplate(PARAMS);

    expect(result).toMatchObject({
      outcome: 'issued',
      adopted: [{ reference_drill_id: 'ref-2' }, { reference_drill_id: 'ref-3' }],
      untested: [{ reference_drill_id: 'ref-2', name: 'Slip Rope Shuffle', steps: [2] }],
    });
    // Every step became an assignment.
    expect(mockCard).toHaveBeenCalledTimes(3);
    const issueAudit = mockAudit.mock.calls.find(([event]) => event.entity_type === 'workout_template_issue');
    expect(issueAudit?.[0].details.untested_reference_drill_ids).toEqual(['ref-2']);
  });

  test('every untested draft is named once, with the steps that use it, in step order', async () => {
    given({
      items: [item(1, { drill_id: 'ref-b' }), item(2, { drill_id: 'ref-a' }), item(3, { drill_id: 'ref-b' })],
      library: {
        'ref-a': { row: reference('ref-a', { name: 'Draft A', field_provenance: DRAFT }), state: 'available' },
        'ref-b': { row: reference('ref-b', { name: 'Draft B', field_provenance: DRAFT }), state: 'available' },
      },
    });

    const result = await issueWorkoutTemplate(PARAMS);

    expect(result).toMatchObject({
      outcome: 'issued',
      untested: [
        { reference_drill_id: 'ref-b', name: 'Draft B', steps: [1, 3] },
        { reference_drill_id: 'ref-a', name: 'Draft A', steps: [2] },
      ],
    });
  });

  test("another gym's floor test does not count: the mark is read for this gym only", async () => {
    given({
      items: [item(1)],
      library: { 'ref-1': { row: reference('ref-1', { field_provenance: DRAFT }), state: 'available' } },
      floorTested: [],
    });

    await expect(issueWorkoutTemplate(PARAMS)).resolves.toMatchObject({
      outcome: 'issued',
      untested: [{ reference_drill_id: 'ref-1' }],
    });
    expect(mockFloorTested).toHaveBeenCalledWith(ORG, ['ref-1']);
  });

  test('a draft this gym has floor-tested is not named', async () => {
    given({
      items: [item(1)],
      library: { 'ref-1': { row: reference('ref-1', { field_provenance: DRAFT }), state: 'available' } },
      floorTested: ['ref-1'],
    });

    await expect(issueWorkoutTemplate(PARAMS)).resolves.toMatchObject({ outcome: 'issued', untested: [] });
  });

  test('untested AND short of something else: refused for the something else alone', async () => {
    given({
      items: [item(1), item(2)],
      library: {
        'ref-1': { state: 'available' },
        'ref-2': {
          row: reference('ref-2', { name: 'Stopless Draft', field_provenance: DRAFT, stop_rules: [] }),
          state: 'available',
        },
      },
    });

    const result = await issueWorkoutTemplate(PARAMS);

    expect(result).toEqual({
      outcome: 'refused',
      message: 'Nothing was issued. Cannot be assigned as they stand: Stopless Draft.',
      drills: [{ steps: [2], drill_id: 'ref-2', name: 'Stopless Draft', reason: 'It has no stop rules.' }],
    });
    expect(JSON.stringify(result)).not.toMatch(/floor-tested/);
    expectNothingWritten();
  });

  test('a refusal no longer carries the untested_draft flag', async () => {
    given({ items: [item(1)], library: { 'ref-1': { state: 'retired', operational: 'op-old' } } });

    const result = await issueWorkoutTemplate(PARAMS);

    expect(result).toMatchObject({ outcome: 'refused' });
    expect(result.outcome === 'refused' && result.drills[0]).not.toHaveProperty('untested_draft');
  });
});

describe('a DRAFT the gym already adopted', () => {
  test('with no floor-tested mark it is assigned and named', async () => {
    given({
      items: [item(1), item(2)],
      library: {
        'ref-1': { state: 'operational', operational: 'op-1' },
        'ref-2': {
          row: reference('ref-2', { name: 'Old Adopted Draft', field_provenance: DRAFT }),
          state: 'operational',
          operational: 'op-2',
        },
      },
    });

    const result = await issueWorkoutTemplate(PARAMS);

    expect(result).toMatchObject({
      outcome: 'issued',
      adopted: [],
      untested: [{ reference_drill_id: 'ref-2', name: 'Old Adopted Draft', steps: [2] }],
    });
    expect(mockCard.mock.calls.map(([params]) => params.drillId)).toEqual(['op-1', 'op-2']);
  });

  test('once a coach of this gym has marked it floor-tested it is assigned and not named', async () => {
    given({
      items: [item(1)],
      library: {
        'ref-1': { row: reference('ref-1', { field_provenance: DRAFT }), state: 'operational', operational: 'op-1' },
      },
      floorTested: ['ref-1'],
    });

    await expect(issueWorkoutTemplate(PARAMS)).resolves.toMatchObject({ outcome: 'issued', adopted: [], untested: [] });
    expect(mockCard.mock.calls.map(([params]) => params.drillId)).toEqual(['op-1']);
  });

  test('an adopted drill that is NOT a draft is never named', async () => {
    given({ items: [item(1)], library: { 'ref-1': { state: 'operational', operational: 'op-1' } }, floorTested: [] });

    await expect(issueWorkoutTemplate(PARAMS)).resolves.toMatchObject({ outcome: 'issued', untested: [] });
  });

  test('untested AND breaking the cue rule: refused for the cue rule alone', async () => {
    given({
      items: [item(1)],
      library: {
        'ref-1': {
          row: reference('ref-1', { name: 'Old Adopted Draft', field_provenance: DRAFT }),
          state: 'operational',
          operational: 'op-1',
        },
      },
    });
    mockCueRule.mockRejectedValue(new ConflictError('"Old Adopted Draft" has no coaching cue.', 'DRILL_CUE_REQUIRED'));

    const result = await issueWorkoutTemplate(PARAMS);

    expect(result).toEqual({
      outcome: 'refused',
      message: 'Nothing was issued. Cannot be assigned as they stand: Old Adopted Draft.',
      drills: [{ steps: [1], drill_id: 'ref-1', name: 'Old Adopted Draft', reason: '"Old Adopted Draft" has no coaching cue.' }],
    });
    expectNothingWritten();
  });

  test('a step naming a version the gym has updated past: the mark that counts is the version it runs', async () => {
    const runsUntested = async (newerTested: boolean) => {
      jest.clearAllMocks();
      given({
        items: [item(1)],
        library: {
          'ref-1': {
            row: reference('ref-1', { name: 'Old Version', field_provenance: DRAFT, superseded_at: '2026-10-01T00:00:00.000Z' }),
            state: 'operational',
            operational: 'op-1',
          },
          'ref-1b': { row: reference('ref-1b', { name: 'New Version', field_provenance: DRAFT }), state: 'available' },
        },
        // The OLD version is marked; only the newer one's mark may count.
        floorTested: newerTested ? ['ref-1', 'ref-1b'] : ['ref-1'],
      });
      const fallback = mockQueryOne.getMockImplementation() as (text: string) => Promise<unknown>;
      mockQueryOne.mockImplementation(async (text: string) =>
        /from pilot\.drills o/.test(text) ? { reference_drill_id: 'ref-1b' } : fallback(text),
      );
      return issueWorkoutTemplate(PARAMS);
    };

    await expect(runsUntested(false)).resolves.toMatchObject({
      outcome: 'issued',
      untested: [{ reference_drill_id: 'ref-1b', name: 'New Version', steps: [1] }],
    });
    await expect(runsUntested(true)).resolves.toMatchObject({ outcome: 'issued', untested: [] });
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
    expect(result.drills[0]).toMatchObject({ steps: [1], drill_id: 'ref-1' });
    expect(result.drills[0].reason).toContain(reason);
    expect(result.message).toBe(`Nothing was issued. Cannot be assigned as they stand: ${result.drills[0].name}.`);
    expectNothingWritten();
  });

  test('a draft that is untested AND missing something else is refused for the something else alone', async () => {
    given({
      items: [item(1)],
      library: {
        'ref-1': { row: reference('ref-1', { name: 'Half Built', field_provenance: DRAFT, stop_rules: [] }), state: 'available' },
      },
    });

    const result = await issueWorkoutTemplate(PARAMS);

    expect(result).toEqual({
      outcome: 'refused',
      message: 'Nothing was issued. Cannot be assigned as they stand: Half Built.',
      drills: [{
        steps: [1],
        drill_id: 'ref-1',
        name: 'Half Built',
        reason: 'It has no stop rules.',
      }],
    });
    expectNothingWritten();
  });

  test('a retired adoption whose reference was since withdrawn is not sent to Restore, which would refuse it', async () => {
    given({
      items: [item(1)],
      library: { 'ref-1': { row: reference('ref-1', { active: false }), state: 'retired', operational: 'op-old' } },
    });

    const result = await issueWorkoutTemplate(PARAMS);

    expect(result).toMatchObject({
      outcome: 'refused',
      drills: [{
        drill_id: 'ref-1',
        reason:
          'This gym adopted this drill and then retired it, and its reference has since been withdrawn, so it cannot be assigned.',
      }],
    });
    expectNothingWritten();
  });

  test('the gym retired its drill for another version: still refused and named, never updated or adopted beside it', async () => {
    given({
      items: [item(1)],
      library: { 'ref-1': { state: 'newer_version_retired', operational: 'op-other' } },
      gymDrill: { lineage_id: 'lin-other', lineage_active: false },
    });
    mockOtherVersion.mockResolvedValue({ operational_drill_id: 'op-other', adopted_reference_drill_id: 'ref-0' });

    await expect(issueWorkoutTemplate(PARAMS)).resolves.toMatchObject({
      outcome: 'refused',
      drills: [{
        drill_id: 'ref-1',
        reason: 'This gym adopted an earlier version of this drill and then retired it. Restore it in the drill library first.',
      }],
    });
    // The question is asked about the gym drill the lineage read named, in this gym.
    const gymDrillRead = mockQueryOne.mock.calls.find(([text]) => /from pilot\.drills d/.test(text));
    expect(gymDrillRead?.[1]).toEqual([ORG, 'op-other']);
    expect(mockUpdate).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  test("an 'operational' lifecycle with no drill id is not assigned on trust: it goes through the adoption checks", async () => {
    // Not a state the lifecycle read produces; if it ever did, the step must
    // not be carded from an id nobody has. It is treated as unadopted, and the
    // reference index decides inside the transaction.
    given({ items: [item(1)], library: { 'ref-1': { state: 'operational', operational: null } } });

    await issueWorkoutTemplate(PARAMS);

    expect(mockCueRule).not.toHaveBeenCalled();
    expect(mockPromote).toHaveBeenCalledTimes(1);
  });

  test('a newer version of a drill the gym runs, not ready, is named and nothing is updated', async () => {
    given({
      items: [item(1)],
      library: { 'ref-1': { state: 'newer_version_available', operational: 'op-other', row: reference('ref-1', { stop_rules: [] }) } },
      gymDrill: { lineage_id: 'lin-other', lineage_active: true },
    });
    mockOtherVersion.mockResolvedValue({ operational_drill_id: 'op-other', adopted_reference_drill_id: 'ref-0' });

    await expect(issueWorkoutTemplate(PARAMS)).resolves.toMatchObject({
      outcome: 'refused',
      drills: [{ steps: [1], drill_id: 'ref-1' }],
    });
    expect(mockUpdate).not.toHaveBeenCalled();
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
        reason: 'This step is typed text, not a drill from the library, so it cannot be assigned.',
      }],
    });
    expectNothingWritten();
  });

  test('an untested draft beside other refusals is not one of them; the others are named in step order', async () => {
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
      message: 'Nothing was issued. Cannot be assigned as they stand: No Stops, Shadow round.',
    });
    if (result.outcome !== 'refused') return;
    expect(result.drills.map((drill) => drill.steps)).toEqual([[1], [3]]);
    expectNothingWritten();
  });
});

describe('drill names, decided before anything is written', () => {
  test('every drill whose name a gym drill already holds is named in one answer', async () => {
    given({
      items: [item(1), item(2), item(3)],
      library: {
        'ref-1': { row: reference('ref-1', { name: 'Jab Ladder' }), state: 'available' },
        'ref-2': { row: reference('ref-2', { name: 'Free Name' }), state: 'available' },
        'ref-3': { row: reference('ref-3', { name: 'Slip Line' }), state: 'available' },
      },
      takenNames: ['Jab Ladder', 'Slip Line'],
    });

    const result = await issueWorkoutTemplate(PARAMS);

    expect(result).toEqual({
      outcome: 'refused',
      message: 'Nothing was issued. Cannot be assigned as they stand: Jab Ladder, Slip Line.',
      drills: [
        {
          steps: [1],
          drill_id: 'ref-1',
          name: 'Jab Ladder',
          reason: 'This gym already has a drill named "Jab Ladder", so this one cannot be adopted under that name.',
        },
        {
          steps: [3],
          drill_id: 'ref-3',
          name: 'Slip Line',
          reason: 'This gym already has a drill named "Slip Line", so this one cannot be adopted under that name.',
        },
      ],
    });
    expectNothingWritten();
  });

  test('the name read is scoped to this gym, to active drills, and to the names about to be adopted', async () => {
    given({
      items: [item(1), item(2)],
      library: {
        'ref-1': { row: reference('ref-1', { name: 'To Adopt' }), state: 'available' },
        'ref-2': { state: 'operational', operational: 'op-2' },
      },
    });

    await issueWorkoutTemplate(PARAMS);

    const nameReads = mockQuery.mock.calls.filter(([text]) => /from pilot\.drills d/.test(text));
    expect(nameReads).toHaveLength(1);
    expect(nameReads[0][0]).toMatch(/d\.organization_id = \$1 and d\.active and d\.name = any\(\$2::text\[\]\)/);
    expect(nameReads[0][1]).toEqual([ORG, ['To Adopt']]);
  });

  test('nothing to adopt: pilot.drills is not read for names at all', async () => {
    given({ items: [item(1)], library: { 'ref-1': { state: 'operational', operational: 'op-1' } } });

    await issueWorkoutTemplate(PARAMS);

    expect(mockQuery.mock.calls.filter(([text]) => /from pilot\.drills d/.test(text))).toHaveLength(0);
  });

  test('two drills of one template sharing a name are both refused, with the true reason', async () => {
    given({
      items: [item(1), item(2)],
      library: {
        'ref-1': { row: reference('ref-1', { name: 'Stance Hold', discipline: 'boxing' }), state: 'available' },
        'ref-2': { row: reference('ref-2', { name: 'Stance Hold', discipline: 'wrestling' }), state: 'available' },
      },
    });

    const result = await issueWorkoutTemplate(PARAMS);

    expect(result).toMatchObject({
      outcome: 'refused',
      drills: [
        { steps: [1], drill_id: 'ref-1', reason: 'Another drill in this template has the same name, and a gym can hold only one drill under a name.' },
        { steps: [2], drill_id: 'ref-2', reason: 'Another drill in this template has the same name, and a gym can hold only one drill under a name.' },
      ],
    });
    expectNothingWritten();
  });

  test('drills are adopted in drill-id order whatever the step order, so two issues cannot deadlock on the indexes', async () => {
    given({
      items: [item(1, { drill_id: 'ref-b' }), item(2, { drill_id: 'ref-a' })],
      library: { 'ref-a': { state: 'available' }, 'ref-b': { state: 'available' } },
    });

    const result = await issueWorkoutTemplate(PARAMS);

    expect(mockPromote.mock.calls.map(([params]) => params.referenceDrillId)).toEqual(['ref-a', 'ref-b']);
    // The cards still follow the template's step order.
    expect(mockCard.mock.calls.map(([params]) => params.drillId)).toEqual(['op-ref-b', 'op-ref-a']);
    expect(result).toMatchObject({ outcome: 'issued', steps: [{ step: 1 }, { step: 2 }] });
  });
});

// The workout the shape cases and the request key cases issue: three steps the gym already runs.
const ITEMS = [
  item(1, { block: 'warmup', scale_level: 'A', contact_level: 'none', coach_note: 'Easy pace.' }),
  item(2, { block: 'technical', scale_level: null, contact_level: 'light_technical', coach_note: null }),
  item(3, { block: 'technical', scale_level: 'C', contact_level: 'controlled_sparring', coach_note: 'Two rounds, coach watching.', duration_minutes: null }),
];
const LIBRARY = {
  'ref-1': { state: 'operational', operational: 'op-1' },
  'ref-2': { state: 'operational', operational: 'op-2' },
  'ref-3': { state: 'operational', operational: 'op-3' },
};

describe('the issued workout keeps its shape (lane P7c)', () => {
  test('every step is recorded on the transaction with its block, order, levels and note exactly as the template item has them', async () => {
    given({ items: ITEMS, library: LIBRARY });

    await issueWorkoutTemplate(PARAMS);

    expect(mockRecordIssue).toHaveBeenCalledTimes(1);
    const [client, recorded] = mockRecordIssue.mock.calls[0];
    expect(client).toBe(transactionClient);
    expect(recorded).toEqual({
      organizationId: ORG,
      athleteId: ATHLETE,
      template: { template_id: TEMPLATE_ID, name: 'Technical Tuesday', version: 2 },
      issuedByAccountId: 'coach-1',
      requestKey: null,
      steps: [
        { ordinal: 1, block: 'warmup', scale_level: 'A', contact_level: 'none', coach_note: 'Easy pace.', template_item_id: 'wti_1', assignment_id: 'assignment_1' },
        // A level the coach left open stays open, and a missing note stays missing.
        { ordinal: 2, block: 'technical', scale_level: null, contact_level: 'light_technical', coach_note: null, template_item_id: 'wti_2', assignment_id: 'assignment_2' },
        // The contact level is the coach's entry: recorded as written.
        { ordinal: 3, block: 'technical', scale_level: 'C', contact_level: 'controlled_sparring', coach_note: 'Two rounds, coach watching.', template_item_id: 'wti_3', assignment_id: 'assignment_3' },
      ],
    });
  });

  test('the shape is written after every card and before the audit event, inside the one transaction', async () => {
    given({ items: ITEMS, library: LIBRARY });

    await issueWorkoutTemplate(PARAMS);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    const lastCard = Math.max(...mockCard.mock.invocationCallOrder);
    expect(mockRecordIssue.mock.invocationCallOrder[0]).toBeGreaterThan(lastCard);
    expect(mockRecordIssue.mock.invocationCallOrder[0]).toBeLessThan(mockAudit.mock.invocationCallOrder[0]);
  });

  test('a failure to record the shape fails the issue and no audit event is written', async () => {
    given({ items: ITEMS, library: LIBRARY });
    mockRecordIssue.mockRejectedValue(new Error('insert refused'));

    await expect(issueWorkoutTemplate(PARAMS)).rejects.toThrow('insert refused');
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

// ONE ISSUE PER REQUEST KEY (lane P7c, PR F). What the writer decides about a
// key; that the database keeps a key to one issue, and what two sends at the
// same moment do, is workoutIssues.pg.test.ts.
describe('a request key names one issue', () => {
  const FIRST = {
    issue_id: 'issue-first',
    athlete_id: ATHLETE,
    template_id: TEMPLATE_ID,
    template_name: 'Technical Tuesday As Issued',
    template_version: 2,
    step_count: 3,
  };
  const REPEAT = {
    outcome: 'already_issued',
    issue_id: 'issue-first',
    // The name the workout was issued under, from the issue, not from the template today.
    template: { template_id: TEMPLATE_ID, name: 'Technical Tuesday As Issued', version: 2 },
    step_count: 3,
  };

  test.each([
    ['no key', PARAMS],
    ['a null key', { ...PARAMS, requestKey: null }],
  ])('with %s nothing is looked up, and the issue is written with a null key', async (_label, params) => {
    given({ items: ITEMS, library: LIBRARY });

    const result = await issueWorkoutTemplate(params);

    expect(result.outcome).toBe('issued');
    expect(mockFindByKey).not.toHaveBeenCalled();
    expect(mockRecordIssue.mock.calls[0][1].requestKey).toBeNull();
  });

  test("a key that names nothing yet is looked up in the session's organization before the template is read, then written with the issue", async () => {
    given({ items: ITEMS, library: LIBRARY });

    const result = await issueWorkoutTemplate({ ...PARAMS, requestKey: 'key-1' });

    expect(result.outcome).toBe('issued');
    expect(mockFindByKey).toHaveBeenCalledTimes(1);
    expect(mockFindByKey).toHaveBeenCalledWith(ORG, 'key-1');
    expect(mockFindByKey.mock.invocationCallOrder[0]).toBeLessThan(mockQueryOne.mock.invocationCallOrder[0]);
    expect(mockRecordIssue.mock.calls[0][1].requestKey).toBe('key-1');
  });

  test('a key that already names this issue is answered with it: no template read, no transaction, no card, no audit event', async () => {
    mockFindByKey.mockResolvedValue(FIRST);

    const result = await issueWorkoutTemplate({ ...PARAMS, requestKey: 'key-1' });

    expect(result).toEqual(REPEAT);
    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  test.each([
    ['another athlete', { ...FIRST, athlete_id: 'athlete-other' }],
    ['another template', { ...FIRST, template_id: 'wtp_other' }],
  ])('a key that names an issue for %s is refused, never answered with that issue and never issued again', async (_label, other) => {
    mockFindByKey.mockResolvedValue(other);

    await expect(issueWorkoutTemplate({ ...PARAMS, requestKey: 'key-1' })).rejects.toMatchObject({
      status: 409,
      code: 'WORKOUT_ISSUE_REQUEST_KEY_REUSED',
      message: 'This request was already used to issue a different workout.',
    });
    expectNothingWritten();
  });

  test('the key is taken INSIDE the transaction (the same request, sent twice at once): the answer is the issue that took it, and no audit event is written', async () => {
    given({ items: ITEMS, library: LIBRARY });
    mockFindByKey.mockResolvedValueOnce(null).mockResolvedValueOnce(FIRST);
    mockRecordIssue.mockRejectedValue(new WorkoutIssueRequestKeyTakenError());

    const result = await issueWorkoutTemplate({ ...PARAMS, requestKey: 'key-1' });

    expect(result).toEqual(REPEAT);
    expect(mockFindByKey).toHaveBeenCalledTimes(2);
    expect(mockFindByKey).toHaveBeenLastCalledWith(ORG, 'key-1');
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a key taken inside the transaction by an issue for another athlete is refused, not answered with it', async () => {
    given({ items: ITEMS, library: LIBRARY });
    mockFindByKey.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...FIRST, athlete_id: 'athlete-other' });
    mockRecordIssue.mockRejectedValue(new WorkoutIssueRequestKeyTakenError());

    await expect(issueWorkoutTemplate({ ...PARAMS, requestKey: 'key-1' })).rejects.toMatchObject({
      status: 409,
      code: 'WORKOUT_ISSUE_REQUEST_KEY_REUSED',
    });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a key reported taken that then names nothing is not swallowed: the error leaves as it came', async () => {
    given({ items: ITEMS, library: LIBRARY });
    mockRecordIssue.mockRejectedValue(new WorkoutIssueRequestKeyTakenError());

    await expect(issueWorkoutTemplate({ ...PARAMS, requestKey: 'key-1' })).rejects.toBeInstanceOf(WorkoutIssueRequestKeyTakenError);
    expect(mockFindByKey).toHaveBeenCalledTimes(2);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  const ADOPTS = { items: [item(1)], library: { 'ref-1': { state: 'available' as const } } };
  const COLLISIONS: Array<[string, () => Error]> = [
    ['the name', () => new DrillNameTakenError('Jab Ladder')],
    ['the reference', () => new ReferenceDrillAlreadyPromotedError('ref-1')],
  ];

  test.each(COLLISIONS)(
    "the same request met at the drill library (%s index), because the template adopts a drill: answered as the repeat, never as 'nothing was issued'",
    async (_label, collision) => {
      given(ADOPTS);
      mockFindByKey.mockResolvedValueOnce(null).mockResolvedValueOnce(FIRST);
      mockPromote.mockRejectedValue(collision());

      const result = await issueWorkoutTemplate({ ...PARAMS, requestKey: 'key-1' });

      expect(result).toEqual(REPEAT);
      expect(mockFindByKey).toHaveBeenCalledTimes(2);
      expect(mockRecordIssue).not.toHaveBeenCalled();
      expect(mockAudit).not.toHaveBeenCalled();
    },
  );

  test.each(COLLISIONS)(
    "a drill library collision (%s index) that was somebody else's adoption is still the conflict to retry: the key names nothing",
    async (_label, collision) => {
      given(ADOPTS);
      mockPromote.mockRejectedValue(collision());

      await expect(issueWorkoutTemplate({ ...PARAMS, requestKey: 'key-1' })).rejects.toMatchObject({
        status: 409,
        code: 'WORKOUT_TEMPLATE_ISSUE_STATE_CHANGED',
      });
      expect(mockFindByKey).toHaveBeenCalledTimes(2);
    },
  );

  test.each(COLLISIONS)(
    "a drill library collision (%s index) whose key names ANOTHER athlete's issue is refused as a reused key, not answered with that issue and not called a library change",
    async (_label, collision) => {
      given(ADOPTS);
      mockFindByKey.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...FIRST, athlete_id: 'athlete-other' });
      mockPromote.mockRejectedValue(collision());

      await expect(issueWorkoutTemplate({ ...PARAMS, requestKey: 'key-1' })).rejects.toMatchObject({
        status: 409,
        code: 'WORKOUT_ISSUE_REQUEST_KEY_REUSED',
      });
      expect(mockAudit).not.toHaveBeenCalled();
    },
  );

  test.each(COLLISIONS)('with no key a drill library collision (%s index) looks nothing up', async (_label, collision) => {
    given(ADOPTS);
    mockPromote.mockRejectedValue(collision());

    await expect(issueWorkoutTemplate(PARAMS)).rejects.toMatchObject({ code: 'WORKOUT_TEMPLATE_ISSUE_STATE_CHANGED' });
    expect(mockFindByKey).not.toHaveBeenCalled();
  });

  test('any other failure of the write is not looked up as a repeat', async () => {
    given({ items: ITEMS, library: LIBRARY });
    mockRecordIssue.mockRejectedValue(new Error('insert refused'));

    await expect(issueWorkoutTemplate({ ...PARAMS, requestKey: 'key-1' })).rejects.toThrow('insert refused');
    expect(mockFindByKey).toHaveBeenCalledTimes(1);
  });
});

describe('a write that fails inside the transaction', () => {
  test('a name taken between the plan and the write is a conflict to retry, not a standing name clash', async () => {
    // The plan found the name free. Which unique index reports a competing
    // adoption depends on index order, so a name collision HERE means the
    // library changed underneath the issue; the retry plans against what is
    // there now and gives the true reason.
    given({ items: [item(1)], library: { 'ref-1': { row: reference('ref-1', { name: 'Jab Ladder' }), state: 'available' } } });
    mockPromote.mockRejectedValue(new DrillNameTakenError('Jab Ladder'));

    await expect(issueWorkoutTemplate(PARAMS)).rejects.toMatchObject({
      status: 409,
      code: 'WORKOUT_TEMPLATE_ISSUE_STATE_CHANGED',
    });
    expect(mockCard).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
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

describe('a step naming a newer version of a drill the gym runs updates it while issuing (Jason, question card 2026-10-11)', () => {
  const GYM_VERSION = { operational_drill_id: 'op-old', adopted_reference_drill_id: 'ref-0' };

  beforeEach(() => {
    mockUpdate.mockImplementation(async (input: { referenceDrillId: string; content: { name: string } }) => ({
      drill: { drill_id: `op-new-${input.referenceDrillId}`, name: input.content.name },
      previous: { drill_id: 'op-old' },
    }));
  });

  test("the gym's drill is updated in place on the transaction, then the new version is assigned", async () => {
    given({
      items: [item(1, { rep_count: 12 })],
      library: { 'ref-1': { state: 'newer_version_available', operational: 'op-old' } },
      gymDrill: { lineage_id: 'lin-old', lineage_active: true },
    });
    mockOtherVersion.mockResolvedValue(GYM_VERSION);

    const result = await issueWorkoutTemplate(PARAMS);

    expect(mockUpdate.mock.calls).toEqual([[
      {
        organizationId: ORG,
        drillId: 'op-old',
        referenceDrillId: 'ref-1',
        content: {
          name: 'Drill ref-1',
          category: 'technical',
          focus: 'Return the rear hand to guard.',
          difficulty: 'intermediate',
          cues: ['Chin behind the shoulder', 'Hand home first'],
        },
        actorAccountId: 'coach-1',
        actorRole: 'coach',
        auditDetails: { adopted_by: 'workout_template_issue', template_id: TEMPLATE_ID },
      },
      transactionClient,
    ]]);
    // Never a second drill beside the gym's.
    expect(mockPromote).not.toHaveBeenCalled();
    expect(mockCard.mock.calls[0][0]).toMatchObject({ drillId: 'op-new-ref-1', repCount: 12 });
    expect(mockCard.mock.calls[0][1]).toBe(transactionClient);
    expect(result).toMatchObject({
      outcome: 'issued',
      // An update is not an adoption: the gym already had the drill.
      adopted: [],
      updated: [{ drill_id: 'op-new-ref-1', reference_drill_id: 'ref-1', name: 'Drill ref-1', updated_from_drill_id: 'op-old' }],
    });
    // The issue's own audit row names the new version it assigned.
    expect(mockAudit.mock.calls.at(-1)?.[0].details).toMatchObject({ adopted_drill_ids: [], updated_drill_ids: ['op-new-ref-1'] });
  });

  test("the drill's own name is not a clash with itself; another drill's is, and nothing is updated", async () => {
    given({
      items: [item(1)],
      library: { 'ref-1': { state: 'newer_version_available', operational: 'op-old' } },
      gymDrill: { lineage_id: 'lin-old', lineage_active: true },
      takenNames: [{ name: 'Drill ref-1', lineage_id: 'lin-old' }],
    });
    mockOtherVersion.mockResolvedValue(GYM_VERSION);

    await expect(issueWorkoutTemplate(PARAMS)).resolves.toMatchObject({ outcome: 'issued' });
    expect(mockUpdate).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    given({
      items: [item(1)],
      library: { 'ref-1': { state: 'newer_version_available', operational: 'op-old' } },
      gymDrill: { lineage_id: 'lin-old', lineage_active: true },
      takenNames: [{ name: 'Drill ref-1', lineage_id: 'lin-someone-else' }],
    });
    mockOtherVersion.mockResolvedValue(GYM_VERSION);

    await expect(issueWorkoutTemplate(PARAMS)).resolves.toMatchObject({
      outcome: 'refused',
      drills: [{ drill_id: 'ref-1', reason: expect.stringContaining('This gym already has a drill named "Drill ref-1"') }],
    });
    expect(mockUpdate).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  test('a gym drill the lineage read named but that cannot be read is named as unreadable, not as retired', async () => {
    given({
      items: [item(1)],
      library: { 'ref-1': { state: 'newer_version_available', operational: 'op-old' } },
      gymDrill: null,
    });
    mockOtherVersion.mockResolvedValue(GYM_VERSION);

    await expect(issueWorkoutTemplate(PARAMS)).resolves.toMatchObject({
      outcome: 'refused',
      drills: [{ drill_id: 'ref-1', reason: 'This drill could not be read from the library.' }],
    });
    expectNothingWritten();
  });

  test('a template naming the older version too assigns the updated drill on both steps', async () => {
    given({
      items: [item(1, { drill_id: 'ref-0' }), item(2, { drill_id: 'ref-1' })],
      library: {
        'ref-0': { state: 'operational', operational: 'op-old', row: reference('ref-0', { superseded_at: '2026-10-01T00:00:00.000Z' }) },
        'ref-1': { state: 'newer_version_available', operational: 'op-old' },
      },
      gymDrill: { lineage_id: 'lin-old', lineage_active: true },
    });
    mockOtherVersion.mockImplementation(async (_org: string, id: string) => (id === 'ref-1' ? GYM_VERSION : null));

    await expect(issueWorkoutTemplate(PARAMS)).resolves.toMatchObject({ outcome: 'issued' });
    expect(mockCard.mock.calls.map(([params]) => params.drillId)).toEqual(['op-new-ref-1', 'op-new-ref-1']);
    expect(mockAudit.mock.calls.at(-1)?.[0].details).toMatchObject({
      adopted_drill_ids: [],
      updated_drill_ids: ['op-new-ref-1'],
    });
  });

  // Review finding (PR #1502): the floor test that counts is the drill the
  // step will assign. Both steps assign the newer version once the gym's drill
  // is updated to it, so only the newer version's mark matters, for both.
  test('a template naming both versions: the untested list judges both steps by the newer version they will assign', async () => {
    const both = async (tested: string[]) => {
      jest.clearAllMocks();
      given({
        items: [item(1, { drill_id: 'ref-0' }), item(2, { drill_id: 'ref-1' })],
        library: {
          'ref-0': {
            state: 'operational',
            operational: 'op-old',
            row: reference('ref-0', { name: 'Old Version', field_provenance: DRAFT, superseded_at: '2026-10-01T00:00:00.000Z' }),
          },
          'ref-1': {
            state: 'newer_version_available',
            operational: 'op-old',
            row: reference('ref-1', { name: 'New Version', field_provenance: DRAFT }),
          },
        },
        gymDrill: { lineage_id: 'lin-old', lineage_active: true },
        floorTested: tested,
      });
      mockOtherVersion.mockImplementation(async (_org: string, id: string) => (id === 'ref-1' ? GYM_VERSION : null));
      return issueWorkoutTemplate(PARAMS);
    };

    // The old version is unmarked, but no step assigns it: nothing is named.
    await expect(both(['ref-1'])).resolves.toMatchObject({ outcome: 'issued', untested: [] });
    // The new version is unmarked: named once, for BOTH steps.
    await expect(both(['ref-0'])).resolves.toMatchObject({
      outcome: 'issued',
      untested: [{ reference_drill_id: 'ref-1', name: 'New Version', steps: [1, 2] }],
    });
  });

  test("after an update, a step naming the older version takes the floor test of the version the gym runs", async () => {
    // The gym runs ref-2's drill; the step names ref-0, which it moved on from.
    const draftRef = (id: string) => reference(id, { field_provenance: DRAFT });
    given({
      items: [item(1, { drill_id: 'ref-0' })],
      library: {
        'ref-0': { state: 'operational', operational: 'op-new', row: reference('ref-0', { superseded_at: '2026-10-01T00:00:00.000Z' }) },
      },
    });
    const templateRow = template();
    mockQueryOne.mockImplementation(async (text: string) =>
      /from pilot[.]drills o/.test(text) ? { reference_drill_id: 'ref-2' } : templateRow);
    mockReference.mockImplementation(async (_org: string, id: string) =>
      (id === 'ref-2' ? draftRef(id) : reference(id, { superseded_at: '2026-10-01T00:00:00.000Z' })));

    // ref-2 is a draft no coach has floor-tested: issued, and ref-2 (the drill
    // the gym runs) is the one named, though ref-0 needs no floor test.
    mockFloorTested.mockResolvedValue({});
    await expect(issueWorkoutTemplate(PARAMS)).resolves.toMatchObject({
      outcome: 'issued',
      untested: [{ reference_drill_id: 'ref-2', steps: [1] }],
    });
    expect(mockFloorTested).toHaveBeenCalledWith(ORG, ['ref-2']);
    expect(mockCard.mock.calls.at(-1)?.[0].drillId).toBe('op-new');

    // Once ref-2 is floor-tested, nothing is named.
    mockFloorTested.mockImplementation(async (_org: string, ids: string[]) =>
      (ids.includes('ref-2') ? { 'ref-2': { drill_id: 'ref-2' } } : {}));
    await expect(issueWorkoutTemplate(PARAMS)).resolves.toMatchObject({ outcome: 'issued', untested: [] });
    expect(mockCard.mock.calls.at(-1)?.[0].drillId).toBe('op-new');
  });

  test('a concurrent update that got there first reads as the library having changed: nothing is issued', async () => {
    given({
      items: [item(1)],
      library: { 'ref-1': { state: 'newer_version_available', operational: 'op-old' } },
      gymDrill: { lineage_id: 'lin-old', lineage_active: true },
    });
    mockOtherVersion.mockResolvedValue(GYM_VERSION);
    mockUpdate.mockRejectedValue(new ReferenceDrillAlreadyPromotedError('ref-1'));

    await expect(issueWorkoutTemplate(PARAMS)).rejects.toMatchObject({
      status: 409,
      code: 'WORKOUT_TEMPLATE_ISSUE_STATE_CHANGED',
    });
    expect(mockCard).not.toHaveBeenCalled();
  });

  test('a drill retired between the plan and the write is refused by the write: nothing is issued', async () => {
    given({
      items: [item(1)],
      library: { 'ref-1': { state: 'newer_version_available', operational: 'op-old' } },
      gymDrill: { lineage_id: 'lin-old', lineage_active: true },
    });
    mockOtherVersion.mockResolvedValue(GYM_VERSION);
    const retired = new ConflictError(
      'This drill is retired, so it cannot be updated to the newer version. Restore the drill first.',
      'DRILL_RETIRED',
    );
    mockUpdate.mockRejectedValue(retired);

    await expect(issueWorkoutTemplate(PARAMS)).rejects.toBe(retired);
    expect(mockCard).not.toHaveBeenCalled();
    expect(mockRecordIssue).not.toHaveBeenCalled();
  });
});

describe('every read is scoped to the session gym', () => {
  test('the organization id reaches each collaborator', async () => {
    // A draft, so the floor-test read is asked too.
    given({ items: [item(1)], library: { 'ref-1': { row: reference('ref-1', { field_provenance: DRAFT }), state: 'available' } } });

    await issueWorkoutTemplate(PARAMS);

    expect(mockLifecycles).toHaveBeenCalledWith(ORG, ['ref-1']);
    expect(mockFloorTested).toHaveBeenCalledWith(ORG, ['ref-1']);
    expect(mockReference).toHaveBeenCalledWith(ORG, 'ref-1');
    expect(mockOtherVersion).toHaveBeenCalledWith(ORG, 'ref-1');
    expect(mockPromote.mock.calls[0][0].organizationId).toBe(ORG);
    expect(mockCard.mock.calls[0][0].organizationId).toBe(ORG);
  });
});
