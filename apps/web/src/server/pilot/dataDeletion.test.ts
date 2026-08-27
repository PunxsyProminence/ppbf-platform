import {
  deleteAthleteRecord,
  deleteGuardianAccount,
  getDeletionStatus,
} from './dataDeletion';

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
