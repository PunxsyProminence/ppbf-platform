import { query, queryOne, withTransaction } from './db';
import { fileEscalation } from './escalationLadder';
import { findNearMissByTriggerContext, flagNearMiss } from './shadowNearMisses';
import {
  findContactEventBlockingHold,
  findRegistrationBlockingHold,
  flagContactDuringHold,
  getActiveTrainingHold,
  getTrainingHoldById,
  liftTrainingHold,
  listTrainingHolds,
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

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockWithTransaction = withTransaction as jest.Mock;
const mockFileEscalation = jest.mocked(fileEscalation);
const mockFindNearMiss = jest.mocked(findNearMissByTriggerContext);
const mockFlagNearMiss = jest.mocked(flagNearMiss);

const SAVEPOINT_LITERAL = /^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/;

/**
 * A fake transaction client. SAVEPOINT/RELEASE/ROLLBACK-TO literals
 * (findRegistrationBlockingHold's poisoning guard) resolve immediately and
 * never consume the queue, so callers only need to queue the DATA query
 * results (the sweep's UPDATE, the duplicate-check SELECT, the INSERT, ...)
 * in the order the function under test actually issues them.
 */
function transactionClient(dataResults: Array<{ rows: unknown[] }>) {
  const queue = [...dataResults];
  const client = {
    query: jest.fn<Promise<{ rows: unknown[] }>, unknown[]>((...callArgs) => {
      const sql = callArgs[0];
      if (SAVEPOINT_LITERAL.test(String(sql).trim())) {
        return Promise.resolve({ rows: [] });
      }
      const next = queue.shift();
      if (!next) throw new Error('test bug: transactionClient ran out of queued data results');
      return Promise.resolve(next);
    }),
  };
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
      { rows: [] }, // sweepExpiredHolds
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
    transactionClient([{ rows: [] }, { rows: [] }, { rows: [{ ...HOLD_ROW, scope: 'contact_only' }] }]);

    await placeTrainingHold({ ...input, scope: 'contact_only' });

    expect(mockFileEscalation).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'moderate' }),
      expect.anything(),
    );
  });

  test('refuses a second hold while one is active, naming the live hold', async () => {
    transactionClient([{ rows: [] }, { rows: [{ hold_id: 'hold-live' }] }]);

    await expect(placeTrainingHold(input)).rejects.toThrow(
      'Hold already exists: hold-live is active for this athlete -- lift it first',
    );
    expect(mockFileEscalation).not.toHaveBeenCalled();
  });

  test('the escalation reason carries no staff reason_text and no athlete explanation', async () => {
    transactionClient([{ rows: [] }, { rows: [] }, { rows: [HOLD_ROW] }]);

    await placeTrainingHold(input);

    const [escalation] = mockFileEscalation.mock.calls[0];
    const serialized = JSON.stringify({ reason: escalation.reason, metadata: escalation.metadata }).toLowerCase();
    expect(serialized).not.toContain('concussion');
    expect(serialized).not.toContain('heal');
  });

  // The sweep is what makes the module's "expired holds simply stop
  // mattering" claim true: without it, the partial unique index (keyed on
  // status='active' alone) would keep colliding with the lapsed row.
  test('sweeps a lapsed hold to expired first, so a new placement is not blocked by it', async () => {
    const client = transactionClient([{ rows: [] }, { rows: [] }, { rows: [HOLD_ROW] }]);

    await placeTrainingHold(input);

    const [sweepSql, sweepParams] = client.query.mock.calls[0];
    expect(String(sweepSql)).toContain("set status = 'expired'");
    expect(String(sweepSql)).toContain('expires_at <= now()');
    expect(sweepParams).toEqual(['org-1', 'ATH-1']);
  });

  // Sweep-then-check closes the ordinary race, but two simultaneous
  // placements can both pass the check before either commits; the loser
  // hits the partial unique index directly and must still get the same
  // caller-facing conflict, not a raw 500.
  test('a concurrent-placement unique-index violation surfaces as the same "Hold already exists" conflict', async () => {
    const client = { query: jest.fn() };
    client.query.mockImplementation((sql: unknown) => {
      if (SAVEPOINT_LITERAL.test(String(sql).trim())) return Promise.resolve({ rows: [] });
      const text = String(sql);
      if (text.includes('set status = ')) return Promise.resolve({ rows: [] }); // sweep
      if (text.includes('select hold_id from')) return Promise.resolve({ rows: [] }); // duplicate check: none found
      return Promise.reject(Object.assign(new Error('duplicate key value violates unique constraint "idx_training_holds_one_active"'), { code: '23505' }));
    });
    mockWithTransaction.mockImplementationOnce(async (fn: (c: unknown) => Promise<unknown>) => fn(client));

    await expect(placeTrainingHold(input)).rejects.toThrow(
      'Hold already exists: an active hold was placed concurrently for this athlete -- lift it first',
    );
    expect(mockFileEscalation).not.toHaveBeenCalled();
  });
});

describe('liftTrainingHold', () => {
  test('lifts an active hold with the guarded update', async () => {
    mockQueryOne.mockResolvedValueOnce({ ...HOLD_ROW, status: 'lifted' });

    const lifted = await liftTrainingHold('org-1', 'hold-1', 'acct-admin-1', 'Cleared by doctor.');

    expect(lifted).toMatchObject({ status: 'lifted' });
    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(String(sql)).toContain("status = 'active'");
    // The guard that makes "an expired hold cannot be dressed up as a
    // deliberate lift" true: without this predicate, a lapsed-but-still-
    // 'active'-in-storage row would be liftable, freshly attributing an
    // action nobody took.
    expect(String(sql)).toContain('expires_at is null or expires_at > now()');
    expect(params).toEqual(['org-1', 'hold-1', 'acct-admin-1', 'Cleared by doctor.']);
  });

  test('a missing hold returns null', async () => {
    mockQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(liftTrainingHold('org-1', 'hold-ghost', 'acct-1', '')).resolves.toBeNull();
  });

  test('an already-lifted hold is an Unsupported transition, not a silent re-lift', async () => {
    mockQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ status: 'lifted', expires_at: null });

    await expect(liftTrainingHold('org-1', 'hold-1', 'acct-2', '')).rejects.toThrow(
      "Unsupported transition: hold is 'lifted' and cannot be lifted",
    );
  });

  // The guarded UPDATE excludes it (tested above), so the fallback re-read
  // is reached; the row's own status column still says 'active' (nothing
  // ever writes 'expired' for a single hold-id lookup) -- the fallback
  // must derive the true status from expires_at rather than trust it,
  // or this reports the false "hold is 'active' and cannot be lifted".
  test('a lapsed hold reports Unsupported transition as expired, not a false active', async () => {
    mockQueryOne
      .mockResolvedValueOnce(null) // guarded UPDATE excludes it
      .mockResolvedValueOnce({ status: 'active', expires_at: '2020-01-01T00:00:00.000Z' });

    await expect(liftTrainingHold('org-1', 'hold-1', 'acct-2', '')).rejects.toThrow(
      "Unsupported transition: hold is 'expired' and cannot be lifted",
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
  test('sweeps lapsed holds first, then reads with the expiry predicate as a second line of defense', async () => {
    mockQuery.mockResolvedValueOnce([]); // sweep
    mockQueryOne.mockResolvedValueOnce(null);

    await getActiveTrainingHold('org-1', 'ATH-1');

    const [sweepSql, sweepParams] = mockQuery.mock.calls[0];
    expect(String(sweepSql)).toContain("set status = 'expired'");
    expect(sweepParams).toEqual(['org-1', 'ATH-1']);

    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(String(sql)).toContain('expires_at is null or expires_at > now()');
    expect(String(sql)).toContain("status = 'active'");
    expect(params).toEqual(['org-1', 'ATH-1']);
  });

  // Fired on every athlete workspace load via the banner -- a 500 here in
  // the pre-migration window would spam error monitoring and, for any
  // OTHER consumer of this function, break outright.
  test('a missing table reads as no hold, never a 500', async () => {
    mockQuery.mockRejectedValueOnce(
      Object.assign(new Error('relation "pilot.training_holds" does not exist'), { code: '42P01' }),
    );

    await expect(getActiveTrainingHold('org-1', 'ATH-1')).resolves.toBeNull();
    expect(mockQueryOne).not.toHaveBeenCalled();
  });
});

describe('getTrainingHoldById', () => {
  test('a missing table reads as no hold, never a 500', async () => {
    mockQueryOne.mockRejectedValueOnce(
      Object.assign(new Error('relation "pilot.training_holds" does not exist'), { code: '42P01' }),
    );

    await expect(getTrainingHoldById('org-1', 'hold-1')).resolves.toBeNull();
  });
});

describe('listTrainingHolds', () => {
  test('sweeps lapsed holds (org-wide, or athlete-scoped when filtered) before listing', async () => {
    mockQuery.mockResolvedValueOnce([]); // sweep
    mockQuery.mockResolvedValueOnce([]); // list

    await listTrainingHolds('org-1', { athleteId: 'ATH-1' });

    const [sweepSql, sweepParams] = mockQuery.mock.calls[0];
    expect(String(sweepSql)).toContain("set status = 'expired'");
    expect(sweepParams).toEqual(['org-1', 'ATH-1']);
  });

  // The staff surface a coach/admin reads to answer "is this child
  // protected right now" -- a 500 here reads as an outage, not as "not
  // migrated yet".
  test('a missing table reads as an empty list, never a 500', async () => {
    mockQuery.mockRejectedValueOnce(
      Object.assign(new Error('relation "pilot.training_holds" does not exist'), { code: '42P01' }),
    );

    await expect(listTrainingHolds('org-1')).resolves.toEqual([]);
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
    const client = {
      query: jest.fn((sql: unknown) => {
        if (SAVEPOINT_LITERAL.test(String(sql).trim())) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [{ hold_id: 'hold-1' }] });
      }),
    };

    const hold = await findRegistrationBlockingHold('org-1', 'ATH-1', client as never);

    expect(hold).toEqual({ hold_id: 'hold-1' });
    expect(mockQueryOne).not.toHaveBeenCalled();
    // SAVEPOINT, the probe SELECT, RELEASE SAVEPOINT.
    expect(client.query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/)[0])).toEqual([
      'SAVEPOINT',
      'select',
      'RELEASE',
    ]);
  });

  // THE critical fix: a 42P01 mid-transaction leaves the enclosing BEGIN
  // block ABORTED (Postgres 25P02) unless something rolls back to a
  // savepoint first. Pinning the exact call sequence here is the unit-level
  // proof the mechanism is in place; trainingHolds.pg.test.ts proves the
  // real-Postgres consequence (the caller's next query survives).
  test('a 42P01 mid-transaction rolls back to the savepoint instead of leaving the transaction aborted', async () => {
    const client = {
      query: jest.fn((sql: unknown) => {
        const text = String(sql).trim();
        if (text.startsWith('SAVEPOINT')) return Promise.resolve({ rows: [] });
        if (text.startsWith('ROLLBACK TO SAVEPOINT')) return Promise.resolve({ rows: [] });
        return Promise.reject(
          Object.assign(new Error('relation "pilot.training_holds" does not exist'), { code: '42P01' }),
        );
      }),
    };

    const hold = await findRegistrationBlockingHold('org-1', 'ATH-1', client as never);

    expect(hold).toBeNull();
    expect(client.query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/).slice(0, 2).join(' '))).toEqual([
      'SAVEPOINT training_hold_probe',
      'select hold_id,',
      'ROLLBACK TO',
    ]);
    // RELEASE SAVEPOINT must NOT have run -- the probe failed, it was not released clean.
    expect(client.query.mock.calls.some(([sql]) => String(sql).trim().startsWith('RELEASE'))).toBe(false);
  });

  test('a non-42P01 error mid-transaction still propagates without a rollback-to-savepoint', async () => {
    const client = {
      query: jest.fn((sql: unknown) => {
        const text = String(sql).trim();
        if (text.startsWith('SAVEPOINT')) return Promise.resolve({ rows: [] });
        return Promise.reject(Object.assign(new Error('connection refused'), { code: '08006' }));
      }),
    };

    await expect(findRegistrationBlockingHold('org-1', 'ATH-1', client as never)).rejects.toThrow('connection refused');
    expect(client.query.mock.calls.some(([sql]) => String(sql).trim().startsWith('ROLLBACK'))).toBe(false);
  });
});

describe('findContactEventBlockingHold', () => {
  test('a contact event is blocked by contact_only as well as all_training', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    await findContactEventBlockingHold('org-1', 'ATH-1');

    const [sql, params] = mockQueryOne.mock.calls[0];
    // The whole point of this probe existing next to
    // findRegistrationBlockingHold: a match IS contact, so the REGRESS rung
    // stops it too. If this assertion is ever relaxed, an athlete told "no
    // contact for now" can be entered into a competition on Saturday.
    expect(String(sql)).toContain("scope in ('all_training', 'contact_only')");
    expect(String(sql)).toContain("status = 'active'");
    // Conditioning-only is training that continues; it is not a contact bar.
    expect(String(sql)).not.toContain('conditioning_only');
    // Expiry in the predicate, so a lapsed hold stops blocking with no sweep.
    expect(String(sql)).toContain('expires_at is null or expires_at > now()');
    expect(params).toEqual(['org-1', 'ATH-1']);
  });

  test("returns the hold with the athlete's own words, so the caller can quote them", async () => {
    mockQueryOne.mockResolvedValueOnce({
      hold_id: 'hold-1',
      scope: 'contact_only',
      athlete_explanation: 'Your ribs need two more weeks before contact.',
      lift_condition_text: 'A coach clears you after a pain-free week.',
    });

    await expect(findContactEventBlockingHold('org-1', 'ATH-1')).resolves.toEqual({
      hold_id: 'hold-1',
      scope: 'contact_only',
      athlete_explanation: 'Your ribs need two more weeks before contact.',
      lift_condition_text: 'A coach clears you after a pain-free week.',
    });
  });

  test('a missing table (pre-migration window) reads as no hold, matching the registration probe', async () => {
    mockQueryOne.mockRejectedValueOnce(
      Object.assign(new Error('relation "pilot.training_holds" does not exist'), { code: '42P01' }),
    );

    await expect(findContactEventBlockingHold('org-1', 'ATH-1')).resolves.toBeNull();
  });

  test('any other database error still propagates', async () => {
    mockQueryOne.mockRejectedValueOnce(Object.assign(new Error('connection refused'), { code: '08006' }));

    await expect(findContactEventBlockingHold('org-1', 'ATH-1')).rejects.toThrow('connection refused');
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
