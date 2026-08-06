import { queryOne, withTransaction } from './db';
import { fileEscalation } from './escalationLadder';
import { findNearMissByTriggerContext, flagNearMiss } from './shadowNearMisses';
import {
  findRegistrationBlockingHold,
  flagContactDuringHold,
  getActiveTrainingHold,
  liftTrainingHold,
  placeTrainingHold,
} from './trainingHolds';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
}));

jest.mock('./escalationLadder', () => ({
  fileEscalation: jest.fn().mockResolvedValue({ escalation_id: 'esc-1' }),
}));

jest.mock('./shadowNearMisses', () => ({
  findNearMissByTriggerContext: jest.fn().mockResolvedValue(null),
  flagNearMiss: jest.fn().mockResolvedValue({ near_miss_id: 'nm-1' }),
}));

const mockQueryOne = queryOne as jest.Mock;
const mockWithTransaction = withTransaction as jest.Mock;
const mockFileEscalation = jest.mocked(fileEscalation);
const mockFindNearMiss = jest.mocked(findNearMissByTriggerContext);
const mockFlagNearMiss = jest.mocked(flagNearMiss);

/** A fake transaction client whose query results are queued per call. */
function transactionClient(results: Array<{ rows: unknown[] }>) {
  const client = { query: jest.fn() };
  for (const result of results) {
    client.query.mockResolvedValueOnce(result);
  }
  mockWithTransaction.mockImplementationOnce(async (fn: (c: unknown) => Promise<unknown>) => fn(client));
  return client;
}

const HOLD_ROW = {
  hold_id: 'hold-1',
  athlete_id: 'ATH-1',
  scope: 'all_training',
  reason_category: 'medical',
  status: 'active',
};

afterEach(() => {
  jest.clearAllMocks();
  mockFindNearMiss.mockResolvedValue(null);
});

describe('placeTrainingHold', () => {
  const input = {
    organizationId: 'org-1',
    athleteId: 'ATH-1',
    scope: 'all_training' as const,
    reasonCategory: 'medical' as const,
    reasonText: 'Concussion protocol pending clearance.',
    athleteExplanation: 'We are giving your head time to heal before you train again.',
    liftConditionText: 'A doctor says you are ready.',
    placedByAccountId: 'acct-coach-1',
    placedByRole: 'coach' as const,
  };

  test('places the hold and files its escalation in the same transaction', async () => {
    const client = transactionClient([
      { rows: [] }, // no existing active hold
      { rows: [HOLD_ROW] }, // insert returning
    ]);

    const placed = await placeTrainingHold(input);

    expect(placed).toEqual(HOLD_ROW);
    // The escalation is filed with the SAME client, so hold and alarm
    // commit or roll back together.
    expect(mockFileEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: 'training_hold',
        sourceId: expect.any(String),
        athleteId: 'ATH-1',
        severity: 'high',
        escalatedToRole: 'organization_admin',
        triggeredBy: 'human',
      }),
      client,
    );
  });

  test('an all_training stop files high; a scoped regression files moderate', async () => {
    transactionClient([{ rows: [] }, { rows: [{ ...HOLD_ROW, scope: 'contact_only' }] }]);

    await placeTrainingHold({ ...input, scope: 'contact_only' });

    expect(mockFileEscalation).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'moderate' }),
      expect.anything(),
    );
  });

  test('refuses a second hold while one is active, naming the live hold', async () => {
    transactionClient([{ rows: [{ hold_id: 'hold-live' }] }]);

    await expect(placeTrainingHold(input)).rejects.toThrow(
      'Hold already exists: hold-live is active for this athlete -- lift it first',
    );
    expect(mockFileEscalation).not.toHaveBeenCalled();
  });

  test('the escalation reason carries no staff reason_text and no athlete explanation', async () => {
    transactionClient([{ rows: [] }, { rows: [HOLD_ROW] }]);

    await placeTrainingHold(input);

    const [escalation] = mockFileEscalation.mock.calls[0];
    const serialized = JSON.stringify({ reason: escalation.reason, metadata: escalation.metadata }).toLowerCase();
    expect(serialized).not.toContain('concussion');
    expect(serialized).not.toContain('heal');
  });
});

describe('liftTrainingHold', () => {
  test('lifts an active hold with the guarded update', async () => {
    mockQueryOne.mockResolvedValueOnce({ ...HOLD_ROW, status: 'lifted' });

    const lifted = await liftTrainingHold('org-1', 'hold-1', 'acct-admin-1', 'Cleared by doctor.');

    expect(lifted).toMatchObject({ status: 'lifted' });
    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(String(sql)).toContain("status = 'active'");
    expect(params).toEqual(['org-1', 'hold-1', 'acct-admin-1', 'Cleared by doctor.']);
  });

  test('a missing hold returns null', async () => {
    mockQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(liftTrainingHold('org-1', 'hold-ghost', 'acct-1', '')).resolves.toBeNull();
  });

  test('an already-lifted hold is an Unsupported transition, not a silent re-lift', async () => {
    mockQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ status: 'lifted' });

    await expect(liftTrainingHold('org-1', 'hold-1', 'acct-2', '')).rejects.toThrow(
      "Unsupported transition: hold is 'lifted' and cannot be lifted",
    );
  });

  test('an empty lift note never wipes a stored one', async () => {
    mockQueryOne.mockResolvedValueOnce({ ...HOLD_ROW, status: 'lifted' });

    await liftTrainingHold('org-1', 'hold-1', 'acct-1', '');

    const [sql] = mockQueryOne.mock.calls[0];
    expect(String(sql)).toContain("coalesce(nullif($4, ''), lift_note)");
  });
});

describe('getActiveTrainingHold', () => {
  test('expiry is a read-time predicate, not a cron', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    await getActiveTrainingHold('org-1', 'ATH-1');

    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(String(sql)).toContain('expires_at is null or expires_at > now()');
    expect(String(sql)).toContain("status = 'active'");
    expect(params).toEqual(['org-1', 'ATH-1']);
  });
});

describe('findRegistrationBlockingHold', () => {
  test('only an all_training hold blocks registration -- classes are untyped', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    await findRegistrationBlockingHold('org-1', 'ATH-1');

    const [sql] = mockQueryOne.mock.calls[0];
    expect(String(sql)).toContain("scope = 'all_training'");
  });

  test('a missing table (pre-migration window) reads as no hold, never a 500', async () => {
    mockQueryOne.mockRejectedValueOnce(
      Object.assign(new Error('relation "pilot.training_holds" does not exist'), { code: '42P01' }),
    );

    await expect(findRegistrationBlockingHold('org-1', 'ATH-1')).resolves.toBeNull();
  });

  test('any other database error still propagates', async () => {
    mockQueryOne.mockRejectedValueOnce(Object.assign(new Error('connection refused'), { code: '08006' }));
    await expect(findRegistrationBlockingHold('org-1', 'ATH-1')).rejects.toThrow('connection refused');
  });

  test('inside a transaction it uses the provided client, not the pool', async () => {
    const client = { query: jest.fn().mockResolvedValueOnce({ rows: [{ hold_id: 'hold-1' }] }) };

    const hold = await findRegistrationBlockingHold('org-1', 'ATH-1', client as never);

    expect(hold).toEqual({ hold_id: 'hold-1' });
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });
});

describe('flagContactDuringHold (the REGRESS rung)', () => {
  const input = {
    organizationId: 'org-1',
    athleteId: 'ATH-1',
    kind: 'contact_level',
    value: 2,
    actorAccountId: 'acct-coach-1',
    actorRole: 'coach',
    contextId: 'ctx-1',
    observedAt: '2026-08-06T12:00:00Z',
  };

  test('contact during a contact-covering hold raises a high near miss, never a refusal', async () => {
    mockQueryOne.mockResolvedValueOnce({ hold_id: 'hold-1', scope: 'contact_only' });

    const outcome = await flagContactDuringHold(input);

    expect(outcome).toEqual({ flagged: true, holdId: 'hold-1', scope: 'contact_only' });
    expect(mockFlagNearMiss).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'high',
        detectedBy: 'system',
        metadata: expect.objectContaining({ trigger: 'contact_observation_during_training_hold', hold_id: 'hold-1' }),
      }),
    );
  });

  test('a non-contact observation never queries holds at all', async () => {
    const outcome = await flagContactDuringHold({ ...input, kind: 'sleep_hours', value: 8 });

    expect(outcome).toEqual({ flagged: false });
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('zero-value contact fields do not flag (a bag session is not contact)', async () => {
    const outcome = await flagContactDuringHold({ ...input, value: 0 });
    expect(outcome).toEqual({ flagged: false });
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('no active covering hold means no flag', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    const outcome = await flagContactDuringHold(input);
    expect(outcome).toEqual({ flagged: false });
    expect(mockFlagNearMiss).not.toHaveBeenCalled();
  });

  test('one near miss per session: the trigger+context dedup holds', async () => {
    mockQueryOne.mockResolvedValueOnce({ hold_id: 'hold-1', scope: 'all_training' });
    mockFindNearMiss.mockResolvedValueOnce({ near_miss_id: 'nm-existing' } as never);

    const outcome = await flagContactDuringHold(input);

    expect(outcome.flagged).toBe(true);
    expect(mockFlagNearMiss).not.toHaveBeenCalled();
  });

  test('a missing table degrades to no flag, never a 500 on the observation path', async () => {
    mockQueryOne.mockRejectedValueOnce(
      Object.assign(new Error('relation "pilot.training_holds" does not exist'), { code: '42P01' }),
    );

    await expect(flagContactDuringHold(input)).resolves.toEqual({ flagged: false });
  });

  test('conditioning_only holds do not cover contact and do not flag it', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    await flagContactDuringHold(input);

    const [sql] = mockQueryOne.mock.calls[0];
    expect(String(sql)).toContain("scope in ('all_training', 'contact_only')");
  });
});

describe('module boundary', () => {
  test('the module source never mentions gym_status -- a hold is not a membership state', () => {
    // Two migrations already refused to overload gym_status with new
    // meanings; this pins the same refusal for holds at the source level.
    const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
    const path = jest.requireActual<typeof import('node:path')>('node:path');
    const source = fs.readFileSync(path.join(__dirname, 'trainingHolds.ts'), 'utf8');
    expect(source).not.toContain('gym_status');
  });
});
