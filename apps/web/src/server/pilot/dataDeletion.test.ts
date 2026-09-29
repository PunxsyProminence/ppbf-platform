import {
  deleteAthleteRecord,
  deleteGuardianAccount,
  getDeletionStatus,
} from './dataDeletion';
import { ConflictError } from './errors';

// withTransaction is mocked so the guardian-deletion cases below can capture
// the statements the function issues. The pre-existing cases in this file do
// not reach the database at all, so this does not change them.
jest.mock('./db', () => ({
  withTransaction: jest.fn(),
  query: jest.fn(),
  queryOne: jest.fn(),
}));

// These are the unit tests. Full integration tests require a live database
// and should be in dataDeletion.pg.test.ts. This file tests the business logic
// with mocked database calls.

describe('dataDeletion', () => {
  const mockActor = {
    accountId: 'admin-1',
    role: 'organization_admin' as const,
    organizationId: 'org-1',
  };

  const mockGuardianActor = {
    accountId: 'admin-1',
    role: 'organization_admin' as const,
    organizationId: 'org-1',
  };

  describe('authorization', () => {
    test('verifies admin role requirement', () => {
      // Test that admin roles are allowed
      const adminRoles = ['organization_admin', 'admin'] as const;
      expect(adminRoles).toContain(mockActor.role);
    });

    test('organization_admin can delete', () => {
      expect(mockActor.role).toBe('organization_admin');
    });

    test('admin role can delete', () => {
      const adminActor = { ...mockActor, role: 'admin' as const };
      const allowedRoles = ['organization_admin', 'admin'] as const;
      expect(allowedRoles).toContain(adminActor.role);
    });
  });

  describe('data structure', () => {
    test('DeletionResult includes required fields', () => {
      // Verify the expected shape of a deletion result
      const result = {
        deletedEntityType: 'athlete' as const,
        deletedEntityId: 'ath-1',
        deletedRecordsCounts: {
          athletes: 1,
          coachObservations: 5,
        },
        deletedAt: new Date().toISOString(),
        auditEventId: 123,
      };

      expect(result).toHaveProperty('deletedEntityType');
      expect(result).toHaveProperty('deletedEntityId');
      expect(result).toHaveProperty('deletedRecordsCounts');
      expect(result).toHaveProperty('deletedAt');
      expect(result).toHaveProperty('auditEventId');
    });
  });

  describe('retention windows', () => {
    test('athletes retain for 2 years', () => {
      const retentionDays = 365 * 2;
      expect(retentionDays).toBe(730);
    });

    test('parent accounts retain for 1 year', () => {
      const retentionDays = 365;
      expect(retentionDays).toBe(365);
    });
  });
});

/**
 * Deleting a guardian must actually end their access.
 *
 * It used to write deleted_at and nothing else. Nothing in the read path
 * filters on deleted_at -- not resolvePrincipal's query, not any guardian
 * access check -- so the flag the platform really gates on, active_flag,
 * stayed true and a "deleted" guardian kept reading their linked minor's
 * records until the session expired. And because `parent` is a magic-link
 * role whose issue and redeem paths both gate on active_flag and never look
 * at deleted_at, they could request a fresh link to their own inbox and sign
 * in again indefinitely.
 *
 * These are SQL-shape assertions against the statements the function issues,
 * not database tests -- the real-Postgres proof belongs in a
 * dataDeletion.pg.test.ts, which does not yet exist. Stated plainly so this
 * is not mistaken for runtime evidence.
 */
describe('guardian deletion closes the door it opens', () => {
  function capturingClient() {
    const statements: string[] = [];
    return {
      statements,
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('select account_id, role')) {
          return { rows: [{ account_id: 'parent-1', role: 'parent' }] };
        }
        if (sql.includes('update pilot.accounts')) {
          return { rows: [{ deleted_at: '2026-08-26 20:00:00+00' }] };
        }
        if (sql.includes('count(*)')) return { rows: [{ count: '0' }] };
        if (sql.includes('audit_events')) return { rows: [{ audit_id: 1 }] };
        return { rows: [] };
      }),
    };
  }

  async function runDeletion() {
    const client = capturingClient();
    const { withTransaction } = jest.requireMock('./db') as {
      withTransaction: jest.Mock;
    };
    withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(client));
    await deleteGuardianAccount(
      { accountId: 'admin-1', role: 'organization_admin', organizationId: 'org-1' },
      'parent-1',
    );
    return client.statements;
  }

  /* Scoped to ONE statement on purpose. The first version of these tests
     joined every statement into a single string and matched with [\s\S]*,
     which let the accounts assertion pass on the active_flag = false that
     belongs to the MEMBERSHIPS update. It stayed green with the accounts fix
     removed. Caught by mutating; recorded so it is not reintroduced. */
  function statementFor(statements: string[], table: string): string {
    const found = statements.filter((sql) => sql.includes(`update ${table}`));
    expect(found).toHaveLength(1);
    return found[0];
  }

  test('clears active_flag, so a fresh magic link cannot let them back in', async () => {
    const statements = await runDeletion();
    // magicLink.ts gates both issue and redeem on active_flag and never reads
    // deleted_at, so this line is the whole of what stops re-entry.
    expect(statementFor(statements, 'pilot.accounts')).toContain('active_flag = false');
  });

  test('revokes live sessions, so an existing cookie stops resolving', async () => {
    const statements = await runDeletion();
    expect(statementFor(statements, 'pilot.session_tokens')).toContain('revoked_at = now()');
  });

  test('deactivates the membership resolvePrincipal inner-joins on', async () => {
    const statements = await runDeletion();
    expect(statementFor(statements, 'pilot.organization_memberships')).toContain('active_flag = false');
  });

  test('all three happen in the deletion transaction, not after it', async () => {
    // If any of these moved outside withTransaction there would be a window in
    // which the account is deleted and a live session still resolves.
    const statements = await runDeletion();
    for (const table of ['pilot.accounts', 'pilot.organization_memberships', 'pilot.session_tokens']) {
      expect(statementFor(statements, table)).toBeTruthy();
    }
  });
});

/**
 * A capturing client for the blocks below. SQL-shape assertions, not a
 * database test.
 *
 * deleted_at is answered ONLY when the statement's select list names it. The
 * first version answered it for any existence check, so removing
 * `deleted_at::text as deleted_at` from either SELECT left every case here
 * green while the real server stopped refusing people already deleted -- and
 * until this change no pg suite exercised the guardian path.
 */
function capturingClient(
  existingDeletedAt: string | null,
  options: { withdrawnChildAccounts?: string[] } = {},
) {
  const statements: string[] = [];
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const selectList = (sql: string) => /^\s*select([\s\S]*?)\bfrom\b/i.exec(sql)?.[1] ?? '';
  const withDeletedAt = (sql: string, row: Record<string, unknown>) =>
    selectList(sql).includes('deleted_at') ? { ...row, deleted_at: existingDeletedAt } : row;
  return {
    statements,
    calls,
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      statements.push(sql);
      calls.push({ sql, params });
      if (sql.includes('select account_id, role')) {
        return { rows: [withDeletedAt(sql, { account_id: 'parent-1', role: 'parent' })] };
      }
      if (sql.includes('select athlete_id')) {
        return { rows: [withDeletedAt(sql, { athlete_id: 'ath-1' })] };
      }
      if (sql.includes("role = 'athlete' and deleted_at = $2")) {
        return { rows: (options.withdrawnChildAccounts ?? []).map((account_id) => ({ account_id })) };
      }
      if (sql.includes('update pilot.accounts') || sql.includes('update pilot.athletes')) {
        return { rows: [{ deleted_at: '2026-09-29 16:00:00+00', account_id: 'acct-ath-1' }] };
      }
      if (sql.includes('count(*)')) return { rows: [{ count: '0' }] };
      if (sql.includes('audit_events')) return { rows: [{ audit_id: 7 }] };
      return { rows: [], rowCount: 0 };
    }),
  };
}

function useClient(client: ReturnType<typeof capturingClient>) {
  const { withTransaction } = jest.requireMock('./db') as { withTransaction: jest.Mock };
  withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(client));
}

const actor = { accountId: 'admin-1', role: 'organization_admin' as const, organizationId: 'org-1' };

function writes(statements: string[]): string[] {
  return statements.filter((sql) => /^\s*(update|insert|delete)\b/i.test(sql));
}

/**
 * Owner decision, 2026-09-29 ("1A"): a person already deleted is refused, and
 * nothing is changed. Before this, a repeat deletion wrote deleted_at = now()
 * again, which restarts the retention clock the purge measures from.
 *
 * The real-Postgres proof of the refusal, for both paths, is in
 * athleteDeletionRevokesAccess.pg.test.ts.
 */
describe('a person already deleted is refused and nothing is written', () => {
  // Midday UTC, so the gym-timezone date is the same calendar day.
  const FIRST_DELETION = '2026-09-01 16:00:00+00';

  test('an athlete already deleted gets a 409 naming the first deletion date, and nothing is written', async () => {
    const client = capturingClient(FIRST_DELETION);
    useClient(client);

    const refusal = deleteAthleteRecord(actor, 'ath-1', 'again');
    await expect(refusal).rejects.toBeInstanceOf(ConflictError);
    await expect(refusal).rejects.toMatchObject({
      status: 409,
      code: 'ALREADY_DELETED',
      message: 'This athlete was already deleted on September 1, 2026. Nothing was changed.',
    });

    // No second deleted_at, no account or session update, no audit row.
    expect(writes(client.statements)).toEqual([]);
  });

  test('a guardian already deleted gets a 409 naming the first deletion date, and nothing is written', async () => {
    const client = capturingClient(FIRST_DELETION);
    useClient(client);

    const refusal = deleteGuardianAccount(actor, 'parent-1', 'again');
    await expect(refusal).rejects.toBeInstanceOf(ConflictError);
    await expect(refusal).rejects.toMatchObject({
      status: 409,
      code: 'ALREADY_DELETED',
      message: 'This guardian was already deleted on September 1, 2026. Nothing was changed.',
    });

    expect(writes(client.statements)).toEqual([]);
  });

  test('a person not yet deleted is still deleted (the check does not refuse everyone)', async () => {
    const athleteClient = capturingClient(null);
    useClient(athleteClient);
    const athlete = await deleteAthleteRecord(actor, 'ath-1', 'withdrew');
    expect(athlete.deletedEntityId).toBe('ath-1');
    expect(writes(athleteClient.statements).some((sql) => sql.includes('update pilot.athletes'))).toBe(true);

    const guardianClient = capturingClient(null);
    useClient(guardianClient);
    const guardian = await deleteGuardianAccount(actor, 'parent-1', 'asked');
    expect(guardian.deletedEntityId).toBe('parent-1');
    expect(writes(guardianClient.statements).some((sql) => sql.includes('update pilot.accounts'))).toBe(true);
  });

  test('both existence checks lock the row, so a racing second deletion waits and is then refused', async () => {
    const athleteClient = capturingClient(null);
    useClient(athleteClient);
    await deleteAthleteRecord(actor, 'ath-1');
    const athleteSelect = athleteClient.statements.find((sql) => sql.includes('select athlete_id'));
    expect(athleteSelect).toMatch(/for update\s*$/);

    const guardianClient = capturingClient(null);
    useClient(guardianClient);
    await deleteGuardianAccount(actor, 'parent-1');
    const guardianSelect = guardianClient.statements.find((sql) => sql.includes('select account_id, role'));
    expect(guardianSelect).toMatch(/for update\s*$/);
  });
});

/**
 * Organization isolation, a hard requirement for minors' records. Both
 * existence checks must bind the ACTOR's organization -- the one the route
 * takes from the session -- as their organization predicate. Dropping
 * `and organization_id = $2` from either check would otherwise pass every
 * other case in this file. The real-Postgres cross-organization cases are in
 * athleteDeletionRevokesAccess.pg.test.ts.
 */
describe('both deletions are bound to the actor organization', () => {
  test('the athlete existence check and every athlete-side write carry the actor organization', async () => {
    const client = capturingClient(null);
    useClient(client);
    await deleteAthleteRecord(actor, 'ath-1');

    const check = client.calls.find((call) => call.sql.includes('select athlete_id'));
    expect(check?.sql).toMatch(/where athlete_id = \$1 and organization_id = \$2/);
    expect(check?.params).toEqual(['ath-1', 'org-1']);

    const athleteUpdate = client.calls.find((call) => call.sql.includes('update pilot.athletes'));
    expect(athleteUpdate?.sql).toMatch(/where athlete_id = \$1 and organization_id = \$2/);
    expect(athleteUpdate?.params).toEqual(['ath-1', 'org-1']);

    const accountUpdate = client.calls.find((call) => call.sql.includes('update pilot.accounts'));
    expect(accountUpdate?.sql).toMatch(/where organization_id = \$1 and athlete_id = \$2 and role = 'athlete'/);
    expect(accountUpdate?.params).toEqual(['org-1', 'ath-1']);
  });

  test('the guardian existence check carries the actor organization, before any write', async () => {
    const client = capturingClient(null);
    useClient(client);
    await deleteGuardianAccount(actor, 'parent-1');

    const checkIndex = client.calls.findIndex((call) => call.sql.includes('select account_id, role'));
    const check = client.calls[checkIndex];
    expect(check.sql).toMatch(/where account_id = \$1 and organization_id = \$2 and role = 'parent'/);
    expect(check.params).toEqual(['parent-1', 'org-1']);

    const firstWrite = client.calls.findIndex((call) => /^\s*(update|insert|delete)\b/i.test(call.sql));
    expect(checkIndex).toBeGreaterThanOrEqual(0);
    expect(checkIndex).toBeLessThan(firstWrite);

    const membership = client.calls.find((call) => call.sql.includes('update pilot.organization_memberships'));
    expect(membership?.params).toEqual(['parent-1', 'org-1']);
  });
});

/**
 * A closed login stays closed. redeemActivationCode (activation.ts) sets
 * active_flag = true on the account and never reads deleted_at, so a code
 * handed out before the deletion would let the athlete back in with no admin
 * involved. The deletion cancels those codes in its own transaction. The
 * real-Postgres proof -- a code issued before the deletion is refused after
 * it -- is in athleteDeletionRevokesAccess.pg.test.ts.
 */
describe('deletion cancels outstanding activation codes', () => {
  function supersedeCalls(client: ReturnType<typeof capturingClient>) {
    return client.calls.filter((call) => call.sql.includes('update pilot.account_activation_tokens'));
  }

  test('deleting an athlete cancels the codes of the login it closes', async () => {
    const client = capturingClient(null);
    useClient(client);
    await deleteAthleteRecord(actor, 'ath-1');

    const supersede = supersedeCalls(client);
    expect(supersede).toHaveLength(1);
    expect(supersede[0].sql).toContain('set superseded_at = now()');
    expect(supersede[0].sql).toContain('consumed_at is null and superseded_at is null');
    // The account the deletion just closed, and only that one.
    expect(supersede[0].params).toEqual([['acct-ath-1']]);
  });

  test('deleting a guardian cancels the codes of the children the trigger withdrew', async () => {
    const client = capturingClient(null, { withdrawnChildAccounts: ['acct-child-1', 'acct-child-2'] });
    useClient(client);
    await deleteGuardianAccount(actor, 'parent-1');

    // The children are found by this deletion's own timestamp, in this organization.
    const lookup = client.calls.find((call) => call.sql.includes("role = 'athlete' and deleted_at = $2"));
    expect(lookup?.sql).toContain('where organization_id = $1');
    expect(lookup?.params).toEqual(['org-1', '2026-09-29 16:00:00+00']);

    const supersede = supersedeCalls(client);
    expect(supersede).toHaveLength(1);
    expect(supersede[0].params).toEqual([['acct-child-1', 'acct-child-2']]);
  });

  test('a guardian whose deletion withdrew no child cancels nothing', async () => {
    const client = capturingClient(null);
    useClient(client);
    await deleteGuardianAccount(actor, 'parent-1');

    expect(supersedeCalls(client)).toHaveLength(0);
  });
});
