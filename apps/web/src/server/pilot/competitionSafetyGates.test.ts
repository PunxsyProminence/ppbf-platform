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

/** The state where every gate passes, so each test only alters its own gate. */
function allClear() {
  mockAssertAccess.mockResolvedValue(undefined);
  mockFindHold.mockResolvedValue(null);
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
    // A passing gate records nothing: this mirrors the scheduler's
    // training_hold branch, which records only the block.
    expect(mockRecordEvaluation).not.toHaveBeenCalled();
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
