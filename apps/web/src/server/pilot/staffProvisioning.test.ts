function fakeClient() {
  return { query: jest.fn().mockResolvedValue({ rows: [] }) };
}

let currentClient: ReturnType<typeof fakeClient>;

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(currentClient)),
}));

import {
  INVITABLE_STAFF_ROLES,
  ORG_ADMIN_INVITABLE_ROLES,
  createOrUpdateMicrosoftStaffAccount,
  isInvitableStaffRole,
  listOrganizationMembers,
} from './staffProvisioning';
import { query, queryOne } from './db';

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

// queryOne is called in a fixed order by the module: organization existence,
// then the email lookup, then (only for new accounts) the account_id
// collision check.
function stubLookups(options: {
  organizationExists?: boolean;
  existingByEmail?: Record<string, unknown> | null;
  accountIdCollision?: Record<string, unknown> | null;
}) {
  mockQueryOne.mockResolvedValueOnce(
    options.organizationExists === false ? null : { organization_id: 'org-1' },
  );
  mockQueryOne.mockResolvedValueOnce(options.existingByEmail ?? null);
  mockQueryOne.mockResolvedValueOnce(options.accountIdCollision ?? null);
}

function accountUpsertCalls() {
  return currentClient.query.mock.calls.filter(
    ([sql]) => sql.includes('pilot.accounts') && sql.includes('insert'),
  );
}

function membershipCalls() {
  return currentClient.query.mock.calls.filter(
    ([sql]) => sql.includes('pilot.organization_memberships') && sql.includes('insert'),
  );
}

function revokeCalls() {
  return currentClient.query.mock.calls.filter(
    ([sql]) => sql.includes('pilot.session_tokens') && sql.includes('revoked_at'),
  );
}

beforeEach(() => {
  currentClient = fakeClient();
  // mockReset (not clearAllMocks) is required: the guard tests throw before
  // consuming every queued mockResolvedValueOnce, and clearAllMocks leaves
  // those leftovers queued for the next test.
  mockQuery.mockReset();
  mockQueryOne.mockReset();
});

describe('invitable role boundaries', () => {
  test('platform_owner and athlete are never invitable through this module', () => {
    expect(isInvitableStaffRole('platform_owner')).toBe(false);
    expect(isInvitableStaffRole('athlete')).toBe(false);
    expect(isInvitableStaffRole('admin')).toBe(false);
  });

  test('coach and organization_admin are invitable', () => {
    expect(isInvitableStaffRole('coach')).toBe(true);
    expect(isInvitableStaffRole('organization_admin')).toBe(true);
  });

  test('an organization admin cannot invite another organization admin', () => {
    expect(ORG_ADMIN_INVITABLE_ROLES).not.toContain('organization_admin');
    expect(ORG_ADMIN_INVITABLE_ROLES).toContain('coach');
  });

  test('a role outside the allowed set is rejected at the module boundary', async () => {
    await expect(
      createOrUpdateMicrosoftStaffAccount({
        loginEmail: 'x@example.com',
        organizationId: 'org-1',
        // Casting past the type is exactly the case the runtime guard exists for.
        role: 'platform_owner' as never,
      }),
    ).rejects.toThrow('Unsupported role');
  });
});

describe('email handling', () => {
  test('normalizes case and whitespace before persisting', async () => {
    stubLookups({});
    const result = await createOrUpdateMicrosoftStaffAccount({
      loginEmail: '  Coach@Example.COM ',
      organizationId: 'org-1',
      role: 'coach',
    });

    expect(result.loginEmail).toBe('coach@example.com');
    expect(accountUpsertCalls()[0][1]).toContain('coach@example.com');
  });

  test('rejects a value that is not an email address', async () => {
    await expect(
      createOrUpdateMicrosoftStaffAccount({
        loginEmail: 'not-an-email',
        organizationId: 'org-1',
        role: 'coach',
      }),
    ).rejects.toThrow('Missing login_email');
  });

  test('rejects an organization that does not exist', async () => {
    stubLookups({ organizationExists: false });
    await expect(
      createOrUpdateMicrosoftStaffAccount({
        loginEmail: 'coach@example.com',
        organizationId: 'ghost-org',
        role: 'coach',
      }),
    ).rejects.toThrow('Missing organization_id');
  });
});

describe('takeover and escalation guards', () => {
  test('refuses to touch a platform owner account', async () => {
    stubLookups({
      existingByEmail: {
        account_id: 'owner-1',
        organization_id: 'org-1',
        role: 'platform_owner',
        auth_provider: 'microsoft',
        is_platform_owner: true,
      },
    });

    await expect(
      createOrUpdateMicrosoftStaffAccount({
        loginEmail: 'owner@example.com',
        organizationId: 'org-1',
        role: 'coach',
      }),
    ).rejects.toThrow('Forbidden: cannot modify a platform owner account');
  });

  test('refuses to move an account into a different organization', async () => {
    stubLookups({
      existingByEmail: {
        account_id: 'coach-1',
        organization_id: 'org-other',
        role: 'coach',
        auth_provider: 'microsoft',
        is_platform_owner: false,
      },
    });

    await expect(
      createOrUpdateMicrosoftStaffAccount({
        loginEmail: 'coach@example.com',
        organizationId: 'org-1',
        role: 'coach',
      }),
    ).rejects.toThrow('Forbidden: account already exists in another organization');
  });

  test('refuses to convert a PIN-based athlete into a staff account', async () => {
    stubLookups({
      existingByEmail: {
        account_id: 'ath-1',
        organization_id: 'org-1',
        role: 'athlete',
        auth_provider: 'ppbf_local',
        is_platform_owner: false,
      },
    });

    await expect(
      createOrUpdateMicrosoftStaffAccount({
        loginEmail: 'athlete@example.com',
        organizationId: 'org-1',
        role: 'coach',
      }),
    ).rejects.toThrow('Forbidden: this email is already used by a PIN-based athlete account');
  });

  test.each(['organization_admin', 'admin', 'board'])(
    'refuses to re-role an existing %s through an organization admin invite',
    async (existingRole) => {
      stubLookups({
        existingByEmail: {
          account_id: 'peer-1',
          organization_id: 'org-1',
          role: existingRole,
          auth_provider: 'microsoft',
          is_platform_owner: false,
        },
      });

      await expect(
        createOrUpdateMicrosoftStaffAccount({
          loginEmail: 'peer@example.com',
          organizationId: 'org-1',
          role: 'volunteer',
        }),
      ).rejects.toThrow('Forbidden: this account holds a role you cannot assign');
      expect(currentClient.query).not.toHaveBeenCalled();
    },
  );

  test('re-inviting an existing board member at the same role is not a role change', async () => {
    stubLookups({
      existingByEmail: {
        account_id: 'board-1',
        organization_id: 'org-1',
        role: 'board',
        auth_provider: 'microsoft',
        is_platform_owner: false,
      },
    });

    const result = await createOrUpdateMicrosoftStaffAccount({
      loginEmail: 'board@example.com',
      organizationId: 'org-1',
      role: 'board',
      callerInvitableRoles: INVITABLE_STAFF_ROLES,
    });

    expect(result.role).toBe('board');
    expect(accountUpsertCalls()).toHaveLength(1);
  });

  test('a caller holding the wider set may still re-role a board member', async () => {
    stubLookups({
      existingByEmail: {
        account_id: 'board-1',
        organization_id: 'org-1',
        role: 'board',
        auth_provider: 'microsoft',
        is_platform_owner: false,
      },
    });

    const result = await createOrUpdateMicrosoftStaffAccount({
      loginEmail: 'board@example.com',
      organizationId: 'org-1',
      role: 'coach',
      callerInvitableRoles: INVITABLE_STAFF_ROLES,
    });

    expect(result.role).toBe('coach');
    expect(revokeCalls()).toHaveLength(1);
  });

  test('refuses an account_id hint that belongs to a different identity', async () => {
    stubLookups({ accountIdCollision: { account_id: 'taken' } });

    await expect(
      createOrUpdateMicrosoftStaffAccount({
        loginEmail: 'coach@example.com',
        organizationId: 'org-1',
        role: 'coach',
        accountIdHint: 'taken',
      }),
    ).rejects.toThrow('Forbidden: account_id is already in use');
  });
});

describe('account and membership writes', () => {
  test('creates the account and an active membership together', async () => {
    stubLookups({});
    const result = await createOrUpdateMicrosoftStaffAccount({
      loginEmail: 'coach@example.com',
      organizationId: 'org-1',
      role: 'coach',
    });

    expect(result.created).toBe(true);
    expect(accountUpsertCalls()).toHaveLength(1);
    expect(membershipCalls()).toHaveLength(1);
    expect(membershipCalls()[0][1]).toEqual(['coach@example.com', 'org-1', 'coach']);
  });

  test('does not revoke sessions when the account is brand new', async () => {
    stubLookups({});
    await createOrUpdateMicrosoftStaffAccount({
      loginEmail: 'coach@example.com',
      organizationId: 'org-1',
      role: 'coach',
    });

    expect(revokeCalls()).toHaveLength(0);
  });

  test('revokes existing sessions when an existing account is re-roled', async () => {
    stubLookups({
      existingByEmail: {
        account_id: 'coach-1',
        organization_id: 'org-1',
        role: 'coach',
        auth_provider: 'microsoft',
        is_platform_owner: false,
      },
    });

    const result = await createOrUpdateMicrosoftStaffAccount({
      loginEmail: 'coach@example.com',
      organizationId: 'org-1',
      role: 'organization_admin',
    });

    expect(result.created).toBe(false);
    expect(revokeCalls()).toHaveLength(1);
    expect(revokeCalls()[0][1]).toEqual(['coach-1']);
  });

  test('never writes is_platform_owner true or a pin hash', async () => {
    stubLookups({});
    await createOrUpdateMicrosoftStaffAccount({
      loginEmail: 'coach@example.com',
      organizationId: 'org-1',
      role: 'coach',
    });

    const [sql] = accountUpsertCalls()[0];
    expect(sql).toContain('is_platform_owner = false');
    expect(sql).toContain('pin_hash = null');
  });
});

describe('listOrganizationMembers', () => {
  test('reports PIN presence as a boolean and never selects the hash', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await listOrganizationMembers('org-1');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('(a.pin_hash is not null) as has_pin');
    expect(sql).not.toMatch(/select[\s\S]*a\.pin_hash\s*,/);
    expect(params).toEqual(['org-1']);
  });
});
