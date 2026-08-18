import { assertActorCanAccessAthlete } from './access';
import { assertAthleteMayBeEnteredInCompetition } from './competitionSafetyGates';
import { ConflictError, ForbiddenError } from './errors';
import { getSafetyGateDefinition, recordSafetyGateEvaluation } from './safetyGateMatrix';
import { findContactEventBlockingHold } from './trainingHolds';
import { getAthleteWaiverStatus } from './waiverCompliance';

jest.mock('./access', () => ({ assertActorCanAccessAthlete: jest.fn() }));
jest.mock('./safetyGateMatrix', () => ({
  getSafetyGateDefinition: jest.fn(),
  recordSafetyGateEvaluation: jest.fn(),
}));
jest.mock('./trainingHolds', () => ({ findContactEventBlockingHold: jest.fn() }));
jest.mock('./waiverCompliance', () => ({ getAthleteWaiverStatus: jest.fn() }));

const mockAssertAccess = assertActorCanAccessAthlete as jest.Mock;
const mockFindHold = findContactEventBlockingHold as jest.Mock;
const mockGetGate = getSafetyGateDefinition as jest.Mock;
const mockRecordEvaluation = recordSafetyGateEvaluation as jest.Mock;
const mockWaiverStatus = getAthleteWaiverStatus as jest.Mock;

const ADMIN = {
  accountId: 'acct-admin',
  role: 'organization_admin' as const,
  organizationId: 'org-1',
  athleteId: null,
};

function gates(overrides: Partial<Parameters<typeof assertAthleteMayBeEnteredInCompetition>[0]> = {}) {
  return assertAthleteMayBeEnteredInCompetition({
    actor: ADMIN,
    athleteId: 'ath-1',
    kind: 'external_competition',
    contextId: 'comp-1',
    at: '2026-08-17T12:00:00.000Z',
    ...overrides,
  });
}

/** The seeded training_hold gate row a migrated organization has. */
const GATE_ROW = { gate_key: 'training_hold', enforcement: 'block' };

/**
 * The state where every gate passes, so each test only alters its own gate.
 *
 * The gate row is part of that baseline. It used to be left unstubbed, which
 * made mockGetGate resolve undefined for every test that did not set it -- so
 * every recording assertion in this file was passing against a gym whose
 * safety-gate migration had never run. A "records nothing" expectation is
 * vacuous under that stub; the pre-migration case is tested deliberately
 * further down instead.
 */
function allClear() {
  mockAssertAccess.mockResolvedValue(undefined);
  mockFindHold.mockResolvedValue(null);
  mockGetGate.mockResolvedValue(GATE_ROW);
  mockWaiverStatus.mockResolvedValue('signed');
}

beforeEach(() => {
  allClear();
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('the still-works case', () => {
  test('an admin, no hold, a signed travel waiver -- the entry proceeds', async () => {
    await expect(gates()).resolves.toBeUndefined();

    expect(mockAssertAccess).toHaveBeenCalledWith(ADMIN, 'ath-1');
    expect(mockFindHold).toHaveBeenCalledWith('org-1', 'ath-1');
    expect(mockWaiverStatus).toHaveBeenCalledWith('org-1', 'ath-1', 'travel');
  });

  test('a conditioning-only hold does not reach this function, so entry proceeds', async () => {
    // The scope set lives in findContactEventBlockingHold (pinned in
    // trainingHolds.test.ts); here that reads as "no blocking hold".
    mockFindHold.mockResolvedValue(null);

    await expect(gates({ kind: 'wrestling_league_season', contextId: 'season-1' })).resolves.toBeUndefined();
  });
});

describe('gate 1 -- coach scoping', () => {
  test("a coach with no standing on this athlete is refused, and learns nothing else about the child", async () => {
    mockAssertAccess.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));

    await expect(gates()).rejects.toThrow('Forbidden: coach not assigned to athlete');

    // The order is the safeguarding property: no hold state and no family
    // consent state is even READ for an actor who may not act on this child.
    expect(mockFindHold).not.toHaveBeenCalled();
    expect(mockWaiverStatus).not.toHaveBeenCalled();
    // And nothing is written to the child's gate history either. An actor with
    // no standing on this child cannot leave a row on their record.
    expect(mockRecordEvaluation).not.toHaveBeenCalled();
  });
});

describe('gate 2 -- training holds', () => {
  const HOLD = {
    hold_id: 'hold-1',
    scope: 'contact_only',
    athlete_explanation: 'Your ribs need two more weeks before contact.',
    lift_condition_text: 'A coach clears you after a pain-free week of conditioning.',
  };

  test('a contact-only hold refuses the entry with the athlete-facing words', async () => {
    mockFindHold.mockResolvedValue(HOLD);
    mockGetGate.mockResolvedValue(null);

    const error = await gates().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ForbiddenError);
    const forbidden = error as ForbiddenError;
    expect(forbidden.status).toBe(403);
    expect(forbidden.code).toBe('TRAINING_HOLD_BLOCKS_COMPETITION');
    expect(forbidden.message).toContain('an external competition');
    expect(forbidden.message).toContain('Your ribs need two more weeks before contact.');
    expect(forbidden.message).toContain('What earns the lift: A coach clears you');
    // Refused before the consent lookup -- one refusal at a time, and the
    // held athlete is not entered either way.
    expect(mockWaiverStatus).not.toHaveBeenCalled();
  });

  test('an all-training hold refuses a league roster add too, worded for that event', async () => {
    mockFindHold.mockResolvedValue({ ...HOLD, scope: 'all_training' });
    mockGetGate.mockResolvedValue(null);

    await expect(gates({ kind: 'wrestling_league_season', contextId: 'season-1' }))
      .rejects.toThrow(/wrestling league season roster/);
  });

  test('the blocked attempt is recorded against the training_hold gate when the gate row exists', async () => {
    mockFindHold.mockResolvedValue(HOLD);
    mockGetGate.mockResolvedValue({ gate_key: 'training_hold', enforcement: 'block' });

    await expect(gates()).rejects.toBeInstanceOf(ForbiddenError);

    expect(mockRecordEvaluation).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      gateKey: 'training_hold',
      athleteId: 'ath-1',
      outcome: 'blocked',
      contextId: 'comp-1',
      evaluatedByAccountId: 'acct-admin',
      evaluatedAt: '2026-08-17T12:00:00.000Z',
      metadata: { hold_id: 'hold-1', hold_scope: 'contact_only', event_kind: 'external_competition' },
    }));
  });

  test('a pre-migration safety_gates table still produces the refusal, recording nothing', async () => {
    mockFindHold.mockResolvedValue(HOLD);
    mockGetGate.mockRejectedValue(Object.assign(new Error('relation does not exist'), { code: '42P01' }));

    await expect(gates()).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockRecordEvaluation).not.toHaveBeenCalled();
  });

  test('a database fault that is not a missing table is not swallowed', async () => {
    mockFindHold.mockResolvedValue(HOLD);
    mockGetGate.mockRejectedValue(Object.assign(new Error('connection terminated'), { code: '08006' }));

    await expect(gates()).rejects.toThrow('connection terminated');
  });
});

// The other half of the same audit trail. Recording only refusals left
// pilot.safety_gate_evaluations accumulating nothing but 'blocked' rows for
// this gate_key, and getGuardianGateSummary shows a guardian only the MOST
// RECENT outcome per gate -- so one hold placed and later lifted read as
// `training_hold: blocked` on that child's record permanently, no matter how
// many times the gate was checked and cleared afterwards.
describe('gate 2 -- the clearance is recorded too', () => {
  test('a cleared hold check is recorded as passed against the training_hold gate', async () => {
    await expect(gates()).resolves.toBeUndefined();

    expect(mockGetGate).toHaveBeenCalledWith('org-1', 'training_hold');
    expect(mockRecordEvaluation).toHaveBeenCalledTimes(1);
    expect(mockRecordEvaluation).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      gateKey: 'training_hold',
      athleteId: 'ath-1',
      outcome: 'passed',
      contextId: 'comp-1',
      evaluatedByAccountId: 'acct-admin',
      evaluatedByRole: 'organization_admin',
      evaluatedAt: '2026-08-17T12:00:00.000Z',
      metadata: { event_kind: 'external_competition' },
    }));
    // The reason distinguishes a clearance from a refusal in a history read
    // back as text, not only by its outcome column.
    expect(mockRecordEvaluation.mock.calls[0][0].reason).toMatch(/no active hold covering contact/i);
  });

  test('a league roster add records its own event kind', async () => {
    await expect(gates({ kind: 'wrestling_league_season', contextId: 'season-1' })).resolves.toBeUndefined();

    expect(mockRecordEvaluation).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'passed',
      contextId: 'season-1',
      metadata: { event_kind: 'wrestling_league_season' },
    }));
  });

  test('exactly one outcome is recorded per check -- never both', async () => {
    mockFindHold.mockResolvedValue({
      hold_id: 'hold-1',
      scope: 'all_training',
      athlete_explanation: 'Rest your ribs.',
      lift_condition_text: 'A pain-free week.',
    });

    await expect(gates()).rejects.toBeInstanceOf(ForbiddenError);

    expect(mockRecordEvaluation).toHaveBeenCalledTimes(1);
    expect(mockRecordEvaluation).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'blocked' }));
    expect(mockRecordEvaluation).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'passed' }));
  });

  test('the clearance is recorded even when the travel waiver then refuses the entry', async () => {
    mockWaiverStatus.mockResolvedValue('missing');

    await expect(gates()).rejects.toBeInstanceOf(ConflictError);

    // This gate passed, and that is what the row says. Withholding it until
    // every later gate also passed would blank the hold history of exactly the
    // children a different gate stopped.
    expect(mockRecordEvaluation).toHaveBeenCalledWith(expect.objectContaining({
      gateKey: 'training_hold',
      outcome: 'passed',
    }));
  });

  test('a pre-migration safety_gates table still lets the entry through, recording nothing', async () => {
    mockGetGate.mockRejectedValue(Object.assign(new Error('relation does not exist'), { code: '42P01' }));

    // Same best-effort posture as the refusal path: a gym whose safety-gate
    // migration has not run yet must still be able to enter a cleared child.
    // An audit-write side effect does not get to fail competition entry.
    await expect(gates()).resolves.toBeUndefined();
    expect(mockRecordEvaluation).not.toHaveBeenCalled();
  });

  test('an organization with no training_hold gate row records nothing and still proceeds', async () => {
    mockGetGate.mockResolvedValue(null);

    await expect(gates()).resolves.toBeUndefined();
    expect(mockRecordEvaluation).not.toHaveBeenCalled();
  });

  test('a database fault that is not a missing table is not swallowed on the pass path either', async () => {
    mockGetGate.mockRejectedValue(Object.assign(new Error('connection terminated'), { code: '08006' }));

    await expect(gates()).rejects.toThrow('connection terminated');
  });
});

describe('gate 3 -- travel waiver', () => {
  test('no travel waiver on file refuses the entry, and says where to fix it', async () => {
    mockWaiverStatus.mockResolvedValue('missing');

    const error = await gates().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictError);
    const conflict = error as ConflictError;
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe('TRAVEL_WAIVER_NOT_SIGNED');
    expect(conflict.message).toMatch(/no signed travel waiver is on file/i);
    expect(conflict.message).toContain('taking a minor off-site');
  });

  test('a declined waiver is refused as a decision, not as missing paperwork', async () => {
    mockWaiverStatus.mockResolvedValue('declined');

    const error = (await gates().catch((caught: unknown) => caught)) as ConflictError;

    expect(error.status).toBe(409);
    expect(error.message).toMatch(/guardian declined/i);
    expect(error.message).toMatch(/not missing paperwork/i);
  });

  test('a withdrawn waiver is refused', async () => {
    mockWaiverStatus.mockResolvedValue('withdrawn');

    await expect(gates()).rejects.toThrow(/withdrawn/i);
  });

  test('a waiver lookup failure is not degraded into permission to travel', async () => {
    mockWaiverStatus.mockRejectedValue(Object.assign(new Error('relation "pilot.waivers" does not exist'), { code: '42P01' }));

    // Fail closed: a consent question nobody could answer is not a yes.
    await expect(gates()).rejects.toThrow(/does not exist/);
  });
});
