interface FakeResult {
  rows: unknown[];
  rowCount: number;
}

// The guardian writes read rows back inside the transaction (does this athlete
// exist, does this account already hold a guardian record), so the fake client
// answers per statement rather than returning one fixed empty result.
function fakeClient(responder?: (sql: string, params?: unknown[]) => FakeResult | undefined) {
  return {
    query: jest.fn(async (sql: string, params?: unknown[]) => responder?.(sql, params) ?? { rows: [], rowCount: 0 }),
  };
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
  listOrganizationGuardianLinks,
  listOrganizationMembers,
  removeGuardianLink,
  requireGuardianLinkForParentInvite,
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

function parentUpsertCalls() {
  return currentClient.query.mock.calls.filter(
    ([sql]) => sql.includes('insert into pilot.parents'),
  );
}

function guardianLinkInsertCalls() {
  return currentClient.query.mock.calls.filter(
    ([sql]) => sql.includes('insert into pilot.guardian_links'),
  );
}

const GUARDIAN = { athleteId: 'ath-1', fullName: 'Dana Johnson', relationshipToAthlete: 'mother' };

// Programs the in-transaction reads the guardian branch performs. Defaults are
// the healthy case: the athlete exists, and the account holds no guardian
// record yet.
function guardianClient(options: {
  athleteRows?: Array<{ athlete_id: string }>;
  parentRows?: Array<{ parent_id: string; account_id: string | null }>;
} = {}) {
  return fakeClient((sql) => {
    if (sql.includes('from pilot.athletes')) {
      const rows = options.athleteRows ?? [{ athlete_id: 'ath-1' }];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('from pilot.parents')) {
      const rows = options.parentRows ?? [];
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
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

describe('requireGuardianLinkForParentInvite', () => {
  test('refuses a parent invite that names no athlete', () => {
    expect(() => requireGuardianLinkForParentInvite('parent', undefined)).toThrow(
      /Missing guardian link/,
    );
  });

  test('allows a parent invite that names one', () => {
    expect(() => requireGuardianLinkForParentInvite('parent', GUARDIAN)).not.toThrow();
  });

  test('refuses a guardian link attached to a role that cannot use one', () => {
    expect(() => requireGuardianLinkForParentInvite('coach', GUARDIAN)).toThrow(
      'Forbidden: a guardian link belongs only to the parent role',
    );
  });

  test('leaves every other role alone', () => {
    for (const role of ['coach', 'staff', 'volunteer', 'board', 'organization_admin'] as const) {
      expect(() => requireGuardianLinkForParentInvite(role, undefined)).not.toThrow();
    }
  });
});

describe('guardian link provisioning', () => {
  test('writes the account, the guardian record and the link on one transaction client', async () => {
    currentClient = guardianClient();
    stubLookups({});

    const result = await createOrUpdateMicrosoftStaffAccount({
      loginEmail: 'dana@example.com',
      organizationId: 'org-1',
      role: 'parent',
      guardian: GUARDIAN,
    });

    // Same client object means the same BEGIN/COMMIT: an account can never be
    // committed without the link that makes it resolve a child.
    expect(accountUpsertCalls()).toHaveLength(1);
    expect(parentUpsertCalls()).toHaveLength(1);
    expect(guardianLinkInsertCalls()).toHaveLength(1);

    expect(parentUpsertCalls()[0][1]).toEqual([
      'org-1',
      'par-dana@example.com',
      'dana@example.com',
      'Dana Johnson',
      'dana@example.com',
    ]);
    expect(guardianLinkInsertCalls()[0][1]).toEqual(['org-1', 'par-dana@example.com', 'ath-1', 'mother']);
    expect(result.guardianLink).toEqual({ parentId: 'par-dana@example.com', athleteId: 'ath-1' });
  });

  test('refuses an athlete that is not in the organization, and writes no link', async () => {
    currentClient = guardianClient({ athleteRows: [] });
    stubLookups({});

    await expect(
      createOrUpdateMicrosoftStaffAccount({
        loginEmail: 'dana@example.com',
        organizationId: 'org-1',
        role: 'parent',
        guardian: { ...GUARDIAN, athleteId: 'ath-typo' },
      }),
    ).rejects.toThrow('Missing athlete_id: no athlete record "ath-typo" in this organization');

    expect(guardianLinkInsertCalls()).toHaveLength(0);
    expect(parentUpsertCalls()).toHaveLength(0);
  });

  test('reuses the guardian record this account already holds, so a second child adds a link', async () => {
    currentClient = guardianClient({ parentRows: [{ parent_id: 'par-7', account_id: 'dana@example.com' }] });
    stubLookups({
      existingByEmail: {
        account_id: 'dana@example.com',
        organization_id: 'org-1',
        role: 'parent',
        auth_provider: 'microsoft',
        is_platform_owner: false,
      },
    });

    const result = await createOrUpdateMicrosoftStaffAccount({
      loginEmail: 'dana@example.com',
      organizationId: 'org-1',
      role: 'parent',
      guardian: { ...GUARDIAN, athleteId: 'ath-2' },
    });

    expect(result.guardianLink).toEqual({ parentId: 'par-7', athleteId: 'ath-2' });
    expect(guardianLinkInsertCalls()[0][1]).toEqual(['org-1', 'par-7', 'ath-2', 'mother']);
  });

  test('refuses to adopt a guardian record that belongs to someone else', async () => {
    currentClient = guardianClient({ parentRows: [{ parent_id: 'par-dana@example.com', account_id: 'other@example.com' }] });
    stubLookups({});

    await expect(
      createOrUpdateMicrosoftStaffAccount({
        loginEmail: 'dana@example.com',
        organizationId: 'org-1',
        role: 'parent',
        guardian: GUARDIAN,
      }),
    ).rejects.toThrow('Forbidden: guardian record id is already in use by another guardian');

    expect(guardianLinkInsertCalls()).toHaveLength(0);
  });

  test('rejects a guardian link on a role that has no read path for it', async () => {
    await expect(
      createOrUpdateMicrosoftStaffAccount({
        loginEmail: 'coach@example.com',
        organizationId: 'org-1',
        role: 'coach',
        guardian: GUARDIAN,
      }),
    ).rejects.toThrow('Forbidden: a guardian link belongs only to the parent role');
  });

  test.each([
    ['athleteId', { ...GUARDIAN, athleteId: '  ' }, /Missing athlete_id/],
    ['fullName', { ...GUARDIAN, fullName: '  ' }, /Missing guardian full_name/],
    ['relationshipToAthlete', { ...GUARDIAN, relationshipToAthlete: '' }, /Missing relationship_to_athlete/],
  ])('refuses a parent invite with a blank %s', async (_field, guardian, expected) => {
    currentClient = guardianClient();
    stubLookups({});

    await expect(
      createOrUpdateMicrosoftStaffAccount({
        loginEmail: 'dana@example.com',
        organizationId: 'org-1',
        role: 'parent',
        guardian,
      }),
    ).rejects.toThrow(expected);

    expect(currentClient.query).not.toHaveBeenCalled();
  });

  test('a non-parent invite writes no guardian rows at all', async () => {
    currentClient = guardianClient();
    stubLookups({});

    const result = await createOrUpdateMicrosoftStaffAccount({
      loginEmail: 'coach@example.com',
      organizationId: 'org-1',
      role: 'coach',
    });

    expect(result.guardianLink).toBeNull();
    expect(parentUpsertCalls()).toHaveLength(0);
    expect(guardianLinkInsertCalls()).toHaveLength(0);
  });
});

function unlinkClient(options: {
  parentRows?: Array<{ parent_id: string }>;
  linkRows?: Array<{ parent_id: string; athlete_id: string }>;
}) {
  return fakeClient((sql) => {
    if (sql.startsWith('delete from')) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('from pilot.parents')) {
      const rows = options.parentRows ?? [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('from pilot.guardian_links')) {
      const rows = options.linkRows ?? [];
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
}

function deleteCalls() {
  return currentClient.query.mock.calls.filter(([sql]) => sql.startsWith('delete from pilot.guardian_links'));
}

describe('removeGuardianLink', () => {
  test('removes one link when the guardian still has another', async () => {
    currentClient = unlinkClient({
      parentRows: [{ parent_id: 'par-1' }],
      linkRows: [
        { parent_id: 'par-1', athlete_id: 'ath-1' },
        { parent_id: 'par-1', athlete_id: 'ath-2' },
      ],
    });

    const result = await removeGuardianLink({
      organizationId: 'org-1',
      accountId: 'dana@example.com',
      athleteId: 'ath-2',
    });

    expect(result).toEqual({ parentId: 'par-1', athleteId: 'ath-2' });
    expect(deleteCalls()).toHaveLength(1);
    expect(deleteCalls()[0][1]).toEqual(['org-1', 'par-1', 'ath-2']);
  });

  // The negative control for the whole feature: removing the last link is the
  // one action that could recreate a guardian who signs in and sees nothing.
  test('refuses to remove the only link a guardian holds', async () => {
    currentClient = unlinkClient({
      parentRows: [{ parent_id: 'par-1' }],
      linkRows: [{ parent_id: 'par-1', athlete_id: 'ath-1' }],
    });

    await expect(
      removeGuardianLink({ organizationId: 'org-1', accountId: 'dana@example.com', athleteId: 'ath-1' }),
    ).rejects.toThrow('Forbidden: this is the only athlete this guardian is linked to');

    expect(deleteCalls()).toHaveLength(0);
  });

  test('reports an account that holds no guardian record', async () => {
    currentClient = unlinkClient({ parentRows: [] });

    await expect(
      removeGuardianLink({ organizationId: 'org-1', accountId: 'nobody@example.com', athleteId: 'ath-1' }),
    ).rejects.toThrow('Not found: this account holds no guardian record');

    expect(deleteCalls()).toHaveLength(0);
  });

  test('reports an athlete this guardian is not linked to', async () => {
    currentClient = unlinkClient({
      parentRows: [{ parent_id: 'par-1' }],
      linkRows: [
        { parent_id: 'par-1', athlete_id: 'ath-1' },
        { parent_id: 'par-1', athlete_id: 'ath-2' },
      ],
    });

    await expect(
      removeGuardianLink({ organizationId: 'org-1', accountId: 'dana@example.com', athleteId: 'ath-9' }),
    ).rejects.toThrow('Not found: that athlete is not linked to this guardian');

    expect(deleteCalls()).toHaveLength(0);
  });

  test('requires every identifier before touching the database', async () => {
    currentClient = unlinkClient({});

    await expect(
      removeGuardianLink({ organizationId: 'org-1', accountId: '  ', athleteId: 'ath-1' }),
    ).rejects.toThrow('Missing organization_id, account_id, or athlete_id');

    expect(currentClient.query).not.toHaveBeenCalled();
  });
});

describe('listOrganizationGuardianLinks', () => {
  test('scopes to the organization and skips guardians who have no login', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await listOrganizationGuardianLinks('org-1');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('p.account_id is not null');
    expect(sql).toContain('gl.organization_id = $1');
    expect(params).toEqual(['org-1']);
  });
});
