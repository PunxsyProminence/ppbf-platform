interface FakeResult {
  rows: unknown[];
  rowCount: number;
}

// The guardian writes read rows back inside the transaction (does this athlete
// exist, does this account already hold a guardian record), so the fake client
// answers per statement rather than returning one fixed empty result.
//
// The account upsert returns the row it wrote, and the module reads no row
// back as "this login is deleted, re-roled or deactivated". So the default
// answer to that one statement is a written row; a test of the refusal says so
// with its own responder.
function fakeClient(responder?: (sql: string, params?: unknown[]) => FakeResult | undefined) {
  return {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      const answered = responder?.(sql, params);
      if (answered) return answered;
      if (sql.includes('insert into pilot.accounts')) return { rows: [{ account_id: 'written' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
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
  assertGuardianLoginProvisionable,
  createOrUpdateMicrosoftStaffAccount,
  isInvitableStaffRole,
  listOrganizationGuardianLinks,
  listOrganizationMembers,
  removeGuardianLink,
  requireGuardianLinkForParentInvite,
} from './staffProvisioning';
import { query, queryOne, withTransaction } from './db';
import { ConflictError } from './errors';

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
  // An existing login is active and not deleted unless the test says otherwise.
  mockQueryOne.mockResolvedValueOnce(
    options.existingByEmail ? { active_flag: true, account_deleted: false, ...options.existingByEmail } : null,
  );
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
  parentRows?: Array<{ parent_id: string; account_id: string | null; email_matches?: boolean }>;
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
    return undefined;
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

// OD-2026-10-03-002 section 5: intake promotion passes its own transaction's
// client, and every statement -- the reads included -- runs on it. None goes
// through the pool, and no transaction of its own is opened.
describe('on the caller\'s transaction', () => {
  test('every read and write runs on the client it is given', async () => {
    (withTransaction as jest.Mock).mockClear();
    const callerClient = fakeClient((sql) => {
      if (sql.includes('from pilot.organizations')) return { rows: [{ organization_id: 'org-1' }], rowCount: 1 };
      return undefined;
    });

    const result = await createOrUpdateMicrosoftStaffAccount({
      loginEmail: 'guardian@example.com',
      organizationId: 'org-1',
      role: 'parent',
      accountIdHint: 'guardian-1',
      refuseRoleChange: true,
      refuseDeactivatedLogin: true,
    }, callerClient as never);

    expect(result).toMatchObject({ accountId: 'guardian-1', created: true });
    const statements = callerClient.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes('from pilot.organizations'))).toBe(true);
    expect(statements.some((sql) => sql.includes('lower(login_email) = $1'))).toBe(true);
    expect(statements.some((sql) => sql.includes('insert into pilot.accounts'))).toBe(true);
    expect(statements.some((sql) => sql.includes('insert into pilot.organization_memberships'))).toBe(true);
    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
    expect(currentClient.query).not.toHaveBeenCalled();
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

  // The laptop roster seeder (scripts/seed-data.ts, #281; retired 2026-10-03, OD-2026-10-03-002 section 10) wrote a guardian's
  // pilot.parents row with a content-hashed parent_id and account_id NULL,
  // already carrying one guardian_link per sibling. Before this, the invite
  // matched only on account_id or par-<accountId>, saw nothing, and inserted a
  // second row -- so the account attached to the new row and every imported
  // sibling link stayed on the orphaned one.
  test('claims the unclaimed guardian record the roster import left, instead of inserting a second one', async () => {
    currentClient = guardianClient({
      parentRows: [{ parent_id: 'par_org-1_9f2c4a', account_id: null, email_matches: true }],
    });
    stubLookups({});

    const result = await createOrUpdateMicrosoftStaffAccount({
      loginEmail: 'dana@example.com',
      organizationId: 'org-1',
      role: 'parent',
      guardian: GUARDIAN,
    });

    // The imported parent_id, not par-dana@example.com. That is the whole
    // point: guardian_links key on parent_id, so reusing the imported id is
    // what keeps the siblings the import already linked.
    expect(result.guardianLink).toEqual({ parentId: 'par_org-1_9f2c4a', athleteId: 'ath-1' });
    expect(parentUpsertCalls()).toHaveLength(1);
    expect(parentUpsertCalls()[0][1]).toEqual([
      'org-1',
      'par_org-1_9f2c4a',
      'dana@example.com',
      'Dana Johnson',
      'dana@example.com',
    ]);
    expect(guardianLinkInsertCalls()[0][1]).toEqual(['org-1', 'par_org-1_9f2c4a', 'ath-1', 'mother']);
  });

  test('asks Postgres for unclaimed records by normalized email, not only by account or derived id', async () => {
    currentClient = guardianClient();
    stubLookups({});

    await createOrUpdateMicrosoftStaffAccount({
      loginEmail: '  Dana@Example.COM ',
      organizationId: 'org-1',
      role: 'parent',
      guardian: GUARDIAN,
    });

    const lookup = currentClient.query.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('from pilot.parents'),
    );

    // Without the account_id-is-null branch the imported row is invisible and
    // the defect returns, so the predicate itself is asserted, not just the
    // decision made from its rows.
    expect(lookup?.[0]).toContain('account_id is null');
    expect(lookup?.[1]).toEqual(['org-1', 'dana@example.com', 'par-dana@example.com', 'dana@example.com']);
  });

  test('does not claim an unclaimed record whose email is a different address', async () => {
    currentClient = guardianClient({
      parentRows: [{ parent_id: 'par-dana@example.com', account_id: null, email_matches: false }],
    });
    stubLookups({});

    await expect(
      createOrUpdateMicrosoftStaffAccount({
        loginEmail: 'dana@example.com',
        organizationId: 'org-1',
        role: 'parent',
        guardian: GUARDIAN,
      }),
    ).rejects.toThrow('Forbidden: guardian record id is already in use by another guardian');

    expect(parentUpsertCalls()).toHaveLength(0);
    expect(guardianLinkInsertCalls()).toHaveLength(0);
  });

  test('refuses to guess when two unclaimed records share the address', async () => {
    currentClient = guardianClient({
      parentRows: [
        { parent_id: 'par_org-1_aaa', account_id: null, email_matches: true },
        { parent_id: 'par_org-1_bbb', account_id: null, email_matches: true },
      ],
    });
    stubLookups({});

    await expect(
      createOrUpdateMicrosoftStaffAccount({
        loginEmail: 'dana@example.com',
        organizationId: 'org-1',
        role: 'parent',
        guardian: GUARDIAN,
      }),
    ).rejects.toThrow('Conflict: more than one unclaimed guardian record carries this email address');

    // Claiming either one would strand the other's children -- the exact
    // failure this block exists to prevent -- so it writes nothing.
    expect(parentUpsertCalls()).toHaveLength(0);
    expect(guardianLinkInsertCalls()).toHaveLength(0);
  });

  test('prefers the record this account already owns over an unclaimed match', async () => {
    currentClient = guardianClient({
      parentRows: [
        { parent_id: 'par_org-1_imported', account_id: null, email_matches: true },
        { parent_id: 'par-7', account_id: 'dana@example.com', email_matches: true },
      ],
    });
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

    // Already-claimed wins. Re-pointing an established guardian at a stale
    // imported row would move them off the links they have been using.
    expect(result.guardianLink).toEqual({ parentId: 'par-7', athleteId: 'ath-2' });
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
  // The guardian's CURRENT photo_media status for the athlete being
  // unlinked. Undefined is the default and the honest one: no consent row on
  // file is the state of nearly every roster-imported athlete, so every test
  // that does not name a status runs under it.
  consentStatus?: string;
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
    if (sql.includes('from pilot.waivers')) {
      const rows = options.consentStatus ? [{ status: options.consentStatus }] : [];
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
}

function consentCalls() {
  return currentClient.query.mock.calls.filter(([sql]) => String(sql).includes('from pilot.waivers'));
}

function lockCalls() {
  return currentClient.query.mock.calls.filter(([sql]) => String(sql).includes('for update'));
}

/** Index of the first call whose SQL matches, or -1. */
function callIndex(match: (sql: string) => boolean): number {
  return currentClient.query.mock.calls.findIndex(([sql]) => match(String(sql)));
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

  /*
   * The unlink is the one action that can turn a guardian's standing NO into
   * a YES with nobody signing anything, because checkGuardianMediaConsent
   * resolves an athlete's guardians from pilot.guardian_links LIVE. Drop the
   * row and the guardian who withdrew simply stops being asked.
   */
  test('refuses to unlink a guardian whose media consent for this athlete is withdrawn', async () => {
    currentClient = unlinkClient({
      parentRows: [{ parent_id: 'par-1' }],
      linkRows: [
        { parent_id: 'par-1', athlete_id: 'ath-1' },
        { parent_id: 'par-1', athlete_id: 'ath-2' },
      ],
      consentStatus: 'withdrawn',
    });

    await expect(
      removeGuardianLink({ organizationId: 'org-1', accountId: 'dana@example.com', athleteId: 'ath-2' }),
    ).rejects.toThrow('Forbidden: this guardian has withdrawn media consent for this athlete');

    expect(deleteCalls()).toHaveLength(0);
  });

  test('the consent read is scoped to this guardian, this athlete, and photo_media', async () => {
    // A read scoped only by athlete would refuse on some OTHER guardian's
    // withdrawal, and one scoped only by guardian would refuse on a
    // withdrawal for a different child. Both would be a refusal that looks
    // right and fires on the wrong fact, so the parameters are asserted
    // rather than trusted.
    currentClient = unlinkClient({
      parentRows: [{ parent_id: 'par-1' }],
      linkRows: [
        { parent_id: 'par-1', athlete_id: 'ath-1' },
        { parent_id: 'par-1', athlete_id: 'ath-2' },
      ],
    });

    await removeGuardianLink({ organizationId: 'org-1', accountId: 'dana@example.com', athleteId: 'ath-2' });

    expect(consentCalls()).toHaveLength(1);
    expect(consentCalls()[0][1]).toEqual(['org-1', 'ath-2', 'par-1', 'photo_media']);
    // The parameters alone do not pin this: a predicate that binds $3
    // somewhere harmless (`and $3 is not null`) passes an argument check
    // while reading every guardian's row for the athlete. Caught in mutation
    // testing, so the predicate itself is asserted. The behavioural half of
    // the same claim is in guardianInviteLink.pg.test.ts, where a co-guardian
    // unlinks normally past somebody else's withdrawal.
    const consentSql = String(consentCalls()[0][0]);
    expect(consentSql).toContain('parent_id = $3');
    expect(consentSql).toContain('athlete_id = $2');
    expect(consentSql).toContain('waiver_type = $4');
  });

  test('a signed consent does not block the unlink', async () => {
    currentClient = unlinkClient({
      parentRows: [{ parent_id: 'par-1' }],
      linkRows: [
        { parent_id: 'par-1', athlete_id: 'ath-1' },
        { parent_id: 'par-1', athlete_id: 'ath-2' },
      ],
      consentStatus: 'signed',
    });

    const result = await removeGuardianLink({
      organizationId: 'org-1',
      accountId: 'dana@example.com',
      athleteId: 'ath-2',
    });

    expect(result).toEqual({ parentId: 'par-1', athleteId: 'ath-2' });
    expect(deleteCalls()).toHaveLength(1);
  });

  test('no consent row on file does not block the unlink', async () => {
    // The blast-radius control. Absence is the default state of a
    // roster-imported athlete -- the only writer of a row this check can see
    // is the guardian's own console -- so refusing on absence would take the
    // unlink away from nearly every family at once. Only an affirmative
    // withdrawal refuses.
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
  });

  test('a withdrawal that is also the only link reports the WITHDRAWAL', async () => {
    // Ordering, asserted. Both refusals are 403 with a message, so if the
    // structural rule ran first this case would never mention the withdrawal
    // and an admin would route around it -- link another athlete, come back,
    // and only then find out. A safeguarding fact must not be masked by a
    // housekeeping one.
    currentClient = unlinkClient({
      parentRows: [{ parent_id: 'par-1' }],
      linkRows: [{ parent_id: 'par-1', athlete_id: 'ath-1' }],
      consentStatus: 'withdrawn',
    });

    await expect(
      removeGuardianLink({ organizationId: 'org-1', accountId: 'dana@example.com', athleteId: 'ath-1' }),
    ).rejects.toThrow('Forbidden: this guardian has withdrawn media consent for this athlete');

    expect(deleteCalls()).toHaveLength(0);
  });

  /*
   * Round-review finding (Codex, PR #823): the consent read was an ordinary
   * SELECT with nothing serializing it against a concurrent withdrawal. The
   * lock below is what makes the read see a withdrawal that committed a
   * moment earlier, and what orders this transaction against the withdrawal
   * path's own sweep.
   */
  test('the row being deleted is locked FOR UPDATE, and the lock is taken BEFORE the consent read', async () => {
    currentClient = unlinkClient({
      parentRows: [{ parent_id: 'par-1' }],
      linkRows: [
        { parent_id: 'par-1', athlete_id: 'ath-1' },
        { parent_id: 'par-1', athlete_id: 'ath-2' },
      ],
    });

    await removeGuardianLink({ organizationId: 'org-1', accountId: 'dana@example.com', athleteId: 'ath-2' });

    expect(lockCalls()).toHaveLength(1);
    // Exactly the row about to be deleted -- not every link this guardian
    // holds. A transaction that takes one row lock and waits on nothing else
    // cannot be half of a deadlock cycle with the withdrawal sweep, which
    // locks every guardian of one athlete.
    expect(lockCalls()[0][1]).toEqual(['org-1', 'par-1', 'ath-2']);
    expect(String(lockCalls()[0][0])).toContain('from pilot.guardian_links');

    // Ordering is the whole point: a lock taken after the read serializes
    // nothing. Under READ COMMITTED the read below the lock takes a fresh
    // snapshot and sees every withdrawal committed up to that moment.
    const lockAt = callIndex((sql) => sql.includes('for update'));
    const readAt = callIndex((sql) => sql.includes('from pilot.waivers'));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(readAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeLessThan(readAt);
  });

  test('nothing is locked when the athlete is not linked to this guardian', async () => {
    // target.parent_id does not exist until the link is found, so the lock
    // cannot precede that check -- and locking a row on a request that is
    // about to be refused would hold it for no reason.
    currentClient = unlinkClient({
      parentRows: [{ parent_id: 'par-1' }],
      linkRows: [{ parent_id: 'par-1', athlete_id: 'ath-1' }, { parent_id: 'par-1', athlete_id: 'ath-2' }],
    });

    await expect(
      removeGuardianLink({ organizationId: 'org-1', accountId: 'dana@example.com', athleteId: 'ath-9' }),
    ).rejects.toThrow('Not found: that athlete is not linked to this guardian');

    expect(lockCalls()).toHaveLength(0);
  });

  test('an athlete this guardian is not linked to is still reported before any consent is read', async () => {
    // The consent read takes target.parent_id, which does not exist until the
    // link is found. Reading first would either throw on undefined or query
    // on a guessed parent id.
    currentClient = unlinkClient({
      parentRows: [{ parent_id: 'par-1' }],
      linkRows: [
        { parent_id: 'par-1', athlete_id: 'ath-1' },
        { parent_id: 'par-1', athlete_id: 'ath-2' },
      ],
      consentStatus: 'withdrawn',
    });

    await expect(
      removeGuardianLink({ organizationId: 'org-1', accountId: 'dana@example.com', athleteId: 'ath-9' }),
    ).rejects.toThrow('Not found: that athlete is not linked to this guardian');

    expect(consentCalls()).toHaveLength(0);
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

// An existing login, as the email lookup returns it. Defaults: a Microsoft
// parent account in org-1.
function existingLogin(overrides: Record<string, unknown> = {}) {
  return {
    account_id: 'acct-existing',
    organization_id: 'org-1',
    role: 'parent',
    auth_provider: 'microsoft',
    is_platform_owner: false,
    active_flag: true,
    account_deleted: false,
    ...overrides,
  };
}

const NON_PARENT_ROLES = ['coach', 'staff', 'volunteer', 'board', 'organization_admin', 'admin', 'athlete'];

// R5 (Jason 2026-09-29, "A"): intake names an existing coach or staff login
// as a guardian -> intake refuses; it does not turn that login into a parent.
describe('intake guardian login: an existing non-parent account is refused, not re-roled', () => {
  test.each(NON_PARENT_ROLES)(
    'provisioning with refuseRoleChange refuses an existing %s account with 409 and writes nothing',
    async (existingRole) => {
      stubLookups({ existingByEmail: existingLogin({ account_id: 'acct-staff', role: existingRole }) });

      const refusal = createOrUpdateMicrosoftStaffAccount({
        loginEmail: 'shared@example.com',
        organizationId: 'org-1',
        role: 'parent',
        accountIdHint: 'acct-staff',
        refuseRoleChange: true,
      });

      await expect(refusal).rejects.toBeInstanceOf(ConflictError);
      await expect(refusal).rejects.toMatchObject({ status: 409, code: 'EXISTING_ACCOUNT_ROLE_CONFLICT' });
      await expect(refusal).rejects.toThrow(
        `Conflict: shared@example.com already belongs to an existing ${existingRole} account in this organization.`,
      );
      expect(currentClient.query).not.toHaveBeenCalled();
    },
  );

  test('an existing parent account is still provisioned with refuseRoleChange', async () => {
    stubLookups({ existingByEmail: existingLogin() });

    const result = await createOrUpdateMicrosoftStaffAccount({
      loginEmail: 'dana@example.com',
      organizationId: 'org-1',
      role: 'parent',
      accountIdHint: 'acct-existing',
      refuseRoleChange: true,
    });

    expect(result.accountId).toBe('acct-existing');
    expect(accountUpsertCalls()).toHaveLength(1);
  });

  test('an account in another organization keeps the generic refusal and is not described', async () => {
    stubLookups({ existingByEmail: existingLogin({ organization_id: 'org-other', role: 'coach' }) });

    const refusal = createOrUpdateMicrosoftStaffAccount({
      loginEmail: 'shared@example.com',
      organizationId: 'org-1',
      role: 'parent',
      refuseRoleChange: true,
    });

    await expect(refusal).rejects.toThrow(/^Forbidden: account already exists in another organization$/);
  });

  // Scope: the invite surfaces re-role on purpose, and must keep doing so.
  test('without refuseRoleChange an invite still re-roles an existing coach, as before', async () => {
    stubLookups({ existingByEmail: existingLogin({ account_id: 'acct-coach', role: 'coach' }) });

    const result = await createOrUpdateMicrosoftStaffAccount({
      loginEmail: 'coach@example.com',
      organizationId: 'org-1',
      role: 'staff',
    });

    expect(result.role).toBe('staff');
    expect(accountUpsertCalls()).toHaveLength(1);
  });
});

// Intake promotion writes the athlete record before it provisions the
// guardian's login, then links the guardian record to that login. This check
// refuses, before the first write, everything provisioning would refuse for
// that login, and an account_id provisioning would not use.
describe('assertGuardianLoginProvisionable', () => {
  const check = (overrides: { loginEmail?: string; accountIdHint?: string } = {}) =>
    assertGuardianLoginProvisionable({
      loginEmail: 'dana@example.com',
      organizationId: 'org-1',
      accountIdHint: 'acct-existing',
      ...overrides,
    });

  test('provisioning keeps the login an email already has and ignores the hint', async () => {
    // The premise the hint check exists for. If this ever changes, so does the check.
    stubLookups({ existingByEmail: existingLogin() });

    const result = await createOrUpdateMicrosoftStaffAccount({
      loginEmail: 'dana@example.com',
      organizationId: 'org-1',
      role: 'parent',
      accountIdHint: 'acct-other-family',
    });

    expect(result.accountId).toBe('acct-existing');
  });

  test.each(NON_PARENT_ROLES)(
    'refuses an email that belongs to an existing %s account with 409 (R5)',
    async (existingRole) => {
      mockQueryOne.mockResolvedValueOnce(existingLogin({ account_id: 'acct-staff', role: existingRole }));

      const refusal = check({ loginEmail: ' Shared@Example.com ', accountIdHint: 'acct-staff' });

      await expect(refusal).rejects.toMatchObject({ status: 409, code: 'EXISTING_ACCOUNT_ROLE_CONFLICT' });
      await expect(refusal).rejects.toThrow(
        `Conflict: shared@example.com already belongs to an existing ${existingRole} account in this organization. `
        + "Intake does not change an existing account's role, so it cannot make that account a parent login. "
        + 'Use a different email address.',
      );
      // Looked up the way provisioning looks it up: trimmed, lower-cased.
      expect(mockQueryOne).toHaveBeenCalledWith(
        expect.stringContaining('lower(login_email) = $1'),
        ['shared@example.com'],
      );
    },
  );

  test('refuses an account_id that belongs to an existing non-parent account in this organization (R5)', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    mockQueryOne.mockResolvedValueOnce({ account_id: 'acct-coach', organization_id: 'org-1', role: 'coach' });

    const refusal = check({ accountIdHint: 'acct-coach' });

    await expect(refusal).rejects.toMatchObject({ status: 409, code: 'EXISTING_ACCOUNT_ROLE_CONFLICT' });
    await expect(refusal).rejects.toThrow(
      'Conflict: account_id "acct-coach" already belongs to an existing coach account in this organization. '
      + "Intake does not change an existing account's role, so it cannot make that account a parent login. "
      + 'Use a different account_id.',
    );
  });

  test('refuses the platform owner with provisioning\'s own message', async () => {
    mockQueryOne.mockResolvedValueOnce(existingLogin({ role: 'platform_owner', is_platform_owner: true }));

    await expect(check()).rejects.toThrow(/^Forbidden: cannot modify a platform owner account$/);
  });

  test('refuses another organization\'s account with provisioning\'s own message, not naming its role', async () => {
    mockQueryOne.mockResolvedValueOnce(existingLogin({ organization_id: 'org-other', role: 'coach' }));

    await expect(check()).rejects.toThrow(/^Forbidden: account already exists in another organization$/);
  });

  test('refuses an existing parent login that signs in with a PIN', async () => {
    mockQueryOne.mockResolvedValueOnce(existingLogin({ auth_provider: 'ppbf_local' }));

    await expect(check()).rejects.toThrow(/^Forbidden: this email is already used by a PIN-based account/);
  });

  test('refuses a hint that differs from the login the email already has', async () => {
    mockQueryOne.mockResolvedValueOnce(existingLogin());

    const refusal = check({ loginEmail: ' Dana@Example.com ', accountIdHint: 'acct-other-family' });

    await expect(refusal).rejects.toBeInstanceOf(ConflictError);
    await expect(refusal).rejects.toThrow(/already belongs to a different login account than "acct-other-family"/);
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
  });

  test('accepts the hint when it is the parent login the email already has', async () => {
    mockQueryOne.mockResolvedValueOnce(existingLogin());

    await expect(check({ accountIdHint: ' acct-existing ' })).resolves.toBeUndefined();
  });

  test('accepts a hint for a new email when no other identity holds it', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    mockQueryOne.mockResolvedValueOnce(null);

    await expect(check({ accountIdHint: 'acct-new' })).resolves.toBeUndefined();
    expect(mockQueryOne).toHaveBeenLastCalledWith(
      expect.stringContaining('where account_id = $1'),
      ['acct-new'],
    );
  });

  test('refuses a hint for a new email that another parent identity already holds', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    mockQueryOne.mockResolvedValueOnce({ account_id: 'acct-other-family', organization_id: 'org-1', role: 'parent' });

    await expect(check({ accountIdHint: 'acct-other-family' }))
      .rejects.toThrow(/^Forbidden: account_id is already in use by another identity$/);
  });

  test('a hint held in another organization is refused without naming its role', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    mockQueryOne.mockResolvedValueOnce({ account_id: 'acct-elsewhere', organization_id: 'org-other', role: 'coach' });

    await expect(check({ accountIdHint: 'acct-elsewhere' }))
      .rejects.toThrow(/^Forbidden: account_id is already in use by another identity$/);
  });

  test('writes nothing', async () => {
    mockQueryOne.mockResolvedValueOnce(existingLogin({ role: 'coach' }));

    await expect(check()).rejects.toThrow();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(currentClient.query).not.toHaveBeenCalled();
  });
});

// A deleted guardian login (deleted_at set) is refused on intake's path rather
// than reactivated. Provisioning's upsert sets active_flag and the membership
// back to true and reads nothing about deletion, so a family that had been
// deleted came back with a working login when a new child was promoted under
// the old email -- and the retention purge, which reads deleted_at and role but
// not active_flag, later hard-deleted that live login and its guardian records.
describe('intake guardian login: a deleted login is refused, not reactivated', () => {
  const DELETED_AT = '2026-03-01 12:00:00+00';

  const DELETED_MESSAGE =
    'Conflict: the login "dana@example.com" was deleted. A deleted login cannot sign in and nothing here changes it; '
    + 'a deletion is not undone from the app. A returning person needs a new login: a new account_id, or for a '
    + 'staff or guardian login a different email address, because the deleted login keeps its own.';

  // OD-2026-09-30-004 e2 (A): refused for every caller, not only intake. A
  // re-invite used to set a deleted login active again.
  // Intake's own refusal is unchanged, code and wording.
  test('provisioning as intake calls it refuses a deleted parent login with 409 and writes nothing', async () => {
    stubLookups({ existingByEmail: existingLogin({ account_id: 'acct-deleted', account_deleted: true, active_flag: false }) });

    const refusal = createOrUpdateMicrosoftStaffAccount({
      loginEmail: ' Dana@Example.com ',
      organizationId: 'org-1',
      role: 'parent',
      accountIdHint: 'acct-deleted',
      refuseRoleChange: true,
      refuseDeactivatedLogin: true,
    });

    await expect(refusal).rejects.toMatchObject({ status: 409, code: 'DELETED_GUARDIAN_LOGIN' });
    await expect(refusal).rejects.toThrow(
      'Conflict: dana@example.com belongs to a guardian login that was deleted. Intake does not restore a deleted login.',
    );
    expect(currentClient.query).not.toHaveBeenCalled();
  });

  test.each([
    ['a parent invite', { role: 'parent' as const }],
    ['a staff invite at another role', { role: 'coach' as const }],
  ])('provisioning refuses a deleted login with 409 and writes nothing: %s', async (_caller, callerParams) => {
    stubLookups({ existingByEmail: existingLogin({ account_id: 'acct-deleted', account_deleted: true, active_flag: false }) });

    const refusal = createOrUpdateMicrosoftStaffAccount({
      loginEmail: ' Dana@Example.com ',
      organizationId: 'org-1',
      accountIdHint: 'acct-deleted',
      ...callerParams,
    });

    await expect(refusal).rejects.toBeInstanceOf(ConflictError);
    await expect(refusal).rejects.toMatchObject({ status: 409, code: 'DELETED_LOGIN' });
    await expect(refusal).rejects.toThrow(DELETED_MESSAGE);
    expect(currentClient.query).not.toHaveBeenCalled();
  });

  // Fail closed: a lookup that did not select the flag refuses.
  test('a login row with no deletion flag is refused', async () => {
    mockQueryOne.mockResolvedValueOnce({ organization_id: 'org-1' });
    mockQueryOne.mockResolvedValueOnce({
      account_id: 'acct-existing', organization_id: 'org-1', role: 'parent', auth_provider: 'microsoft',
      is_platform_owner: false, active_flag: true,
    });

    await expect(
      createOrUpdateMicrosoftStaffAccount({ loginEmail: 'dana@example.com', organizationId: 'org-1', role: 'parent' }),
    ).rejects.toMatchObject({ code: 'DELETED_LOGIN' });
  });

  test('a deleted login in another organization is refused as another organization, and not named as deleted', async () => {
    stubLookups({ existingByEmail: existingLogin({ organization_id: 'org-other', account_deleted: true }) });

    await expect(
      createOrUpdateMicrosoftStaffAccount({ loginEmail: 'dana@example.com', organizationId: 'org-1', role: 'parent' }),
    ).rejects.toThrow('Forbidden: account already exists in another organization');
  });

  test('a login that was never deleted is still provisioned', async () => {
    stubLookups({ existingByEmail: existingLogin() });

    const result = await createOrUpdateMicrosoftStaffAccount({
      loginEmail: 'dana@example.com',
      organizationId: 'org-1',
      role: 'parent',
      accountIdHint: 'acct-existing',
      refuseRoleChange: true,
    });

    expect(result.accountId).toBe('acct-existing');
    expect(accountUpsertCalls()).toHaveLength(1);
  });

  // The read is outside the transaction. The account write carries the same
  // conditions, and when it writes no row the reason is read back inside it.
  describe('the account write refuses what changed after the read', () => {
    function clientWhereTheWriteMatchesNothing(current: Record<string, unknown>) {
      return fakeClient((sql) => {
        if (sql.includes('insert into pilot.accounts')) return { rows: [], rowCount: 0 };
        if (sql.includes('from pilot.accounts a where account_id = $1')) return { rows: [current], rowCount: 1 };
        return undefined;
      });
    }

    test('the upsert is conditional on not deleted, and for intake on active and same role', async () => {
      stubLookups({ existingByEmail: existingLogin() });

      await createOrUpdateMicrosoftStaffAccount({
        loginEmail: 'dana@example.com', organizationId: 'org-1', role: 'parent',
        refuseRoleChange: true, refuseDeactivatedLogin: true,
      });

      const [sql, params] = accountUpsertCalls()[0];
      expect(sql).toContain('where not (acct.deleted_at is not null)');
      expect(sql).toContain('and acct.organization_id = excluded.organization_id');
      expect(sql).toContain('and (not $5::boolean or acct.active_flag)');
      expect(sql).toContain('and (not $6::boolean or acct.role = excluded.role)');
      expect(params?.slice(4)).toEqual([true, true]);
    });

    test('an invite passes neither intake condition', async () => {
      stubLookups({ existingByEmail: existingLogin() });

      await createOrUpdateMicrosoftStaffAccount({ loginEmail: 'dana@example.com', organizationId: 'org-1', role: 'parent' });

      expect(accountUpsertCalls()[0][1]?.slice(4)).toEqual([false, false]);
    });

    // The reason is looked up only inside the caller's organization. A login
    // that is another gym's by the time of the write gets the answer the
    // read gives for one, and nothing about it -- deleted or not -- is said.
    test('moved to another organization in between: the generic refusal, from a lookup scoped to this organization', async () => {
      stubLookups({ existingByEmail: existingLogin() });
      currentClient = fakeClient((sql) => {
        if (sql.includes('insert into pilot.accounts')) return { rows: [], rowCount: 0 };
        return undefined; // the scoped lookup finds no row in this organization
      });

      await expect(
        createOrUpdateMicrosoftStaffAccount({ loginEmail: 'dana@example.com', organizationId: 'org-1', role: 'parent' }),
      ).rejects.toThrow('Forbidden: account already exists in another organization');

      const lookup = currentClient.query.mock.calls.find(([sql]) => String(sql).includes('as account_deleted'));
      expect(String(lookup?.[0])).toContain('where account_id = $1 and organization_id = $2');
      expect(lookup?.[1]).toEqual(['acct-existing', 'org-1']);
      expect(membershipCalls()).toHaveLength(0);
    });

    test('deleted in between, for intake: its own 409, and no membership is written', async () => {
      stubLookups({ existingByEmail: existingLogin() });
      currentClient = clientWhereTheWriteMatchesNothing({ role: 'parent', account_deleted: true });

      await expect(
        createOrUpdateMicrosoftStaffAccount({
          loginEmail: 'dana@example.com', organizationId: 'org-1', role: 'parent',
          refuseRoleChange: true, refuseDeactivatedLogin: true,
        }),
      ).rejects.toMatchObject({ status: 409, code: 'DELETED_GUARDIAN_LOGIN' });
      expect(membershipCalls()).toHaveLength(0);
    });

    test('deleted in between: 409 DELETED_LOGIN, and no membership is written', async () => {
      stubLookups({ existingByEmail: existingLogin() });
      currentClient = clientWhereTheWriteMatchesNothing({ role: 'parent', account_deleted: true });

      await expect(
        createOrUpdateMicrosoftStaffAccount({ loginEmail: 'dana@example.com', organizationId: 'org-1', role: 'parent' }),
      ).rejects.toMatchObject({ status: 409, code: 'DELETED_LOGIN' });
      expect(membershipCalls()).toHaveLength(0);
    });

    test('re-roled in between, for intake: 409 EXISTING_ACCOUNT_ROLE_CONFLICT', async () => {
      stubLookups({ existingByEmail: existingLogin() });
      currentClient = clientWhereTheWriteMatchesNothing({ role: 'coach', account_deleted: false });

      await expect(
        createOrUpdateMicrosoftStaffAccount({
          loginEmail: 'dana@example.com', organizationId: 'org-1', role: 'parent',
          refuseRoleChange: true, refuseDeactivatedLogin: true,
        }),
      ).rejects.toMatchObject({ status: 409, code: 'EXISTING_ACCOUNT_ROLE_CONFLICT' });
      expect(membershipCalls()).toHaveLength(0);
    });

    test('deactivated in between, for intake: 409 DEACTIVATED_GUARDIAN_LOGIN', async () => {
      stubLookups({ existingByEmail: existingLogin() });
      currentClient = clientWhereTheWriteMatchesNothing({ role: 'parent', account_deleted: false });

      await expect(
        createOrUpdateMicrosoftStaffAccount({
          loginEmail: 'dana@example.com', organizationId: 'org-1', role: 'parent',
          refuseRoleChange: true, refuseDeactivatedLogin: true,
        }),
      ).rejects.toMatchObject({ status: 409, code: 'DEACTIVATED_GUARDIAN_LOGIN' });
      expect(membershipCalls()).toHaveLength(0);
    });
  });

  test('the pre-write check refuses a deleted parent login with 409', async () => {
    mockQueryOne.mockResolvedValueOnce(existingLogin({ deleted_at: DELETED_AT }));

    const refusal = assertGuardianLoginProvisionable({
      loginEmail: 'dana@example.com',
      organizationId: 'org-1',
      accountIdHint: 'acct-existing',
    });

    await expect(refusal).rejects.toMatchObject({ status: 409, code: 'DELETED_GUARDIAN_LOGIN' });
    await expect(refusal).rejects.toThrow(
      'Conflict: dana@example.com belongs to a guardian login that was deleted. Intake does not restore a deleted login.',
    );
    expect(mockQueryOne).toHaveBeenCalledWith(expect.stringContaining('deleted_at'), ['dana@example.com']);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('the pre-write check refuses a deleted non-parent login by its role first', async () => {
    mockQueryOne.mockResolvedValueOnce(existingLogin({ role: 'coach', deleted_at: DELETED_AT }));

    await expect(
      assertGuardianLoginProvisionable({ loginEmail: 'dana@example.com', organizationId: 'org-1', accountIdHint: 'acct-existing' }),
    ).rejects.toMatchObject({ status: 409, code: 'EXISTING_ACCOUNT_ROLE_CONFLICT' });
  });
});

// OD-2026-09-30-004 d1 (Jason, A): a guardian login an admin deactivated
// (active_flag false, deleted_at null) is refused on intake's path rather than
// turned back on; the admin reactivates it on purpose.
describe('intake guardian login: a deactivated login is refused, not reactivated', () => {
  const DEACTIVATED_MESSAGE =
    'Conflict: dana@example.com belongs to a guardian login that was deactivated. Intake does not turn a '
    + 'deactivated login back on. To reactivate it on purpose, add this guardian again on People, '
    + '"Add Coach, Staff Or Guardian", linked to one of their children already on the roster, then promote '
    + 'again. If none is, promote without guardian.account_id first, then add the guardian on People linked '
    + 'to this child.';

  test('the pre-write check refuses a deactivated parent login with 409', async () => {
    mockQueryOne.mockResolvedValueOnce(existingLogin({ deleted_at: null, active_flag: false }));

    const refusal = assertGuardianLoginProvisionable({
      loginEmail: 'dana@example.com',
      organizationId: 'org-1',
      accountIdHint: 'acct-existing',
    });

    await expect(refusal).rejects.toMatchObject({ status: 409, code: 'DEACTIVATED_GUARDIAN_LOGIN' });
    await expect(refusal).rejects.toThrow(DEACTIVATED_MESSAGE);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('provisioning with refuseDeactivatedLogin refuses it with 409 and writes nothing', async () => {
    stubLookups({ existingByEmail: existingLogin({ active_flag: false }) });

    const refusal = createOrUpdateMicrosoftStaffAccount({
      loginEmail: ' Dana@Example.com ',
      organizationId: 'org-1',
      role: 'parent',
      accountIdHint: 'acct-existing',
      refuseRoleChange: true,
      refuseDeactivatedLogin: true,
    });

    await expect(refusal).rejects.toMatchObject({ status: 409, code: 'DEACTIVATED_GUARDIAN_LOGIN' });
    await expect(refusal).rejects.toThrow(DEACTIVATED_MESSAGE);
    expect(currentClient.query).not.toHaveBeenCalled();
  });

  // A PIN-based login is told what it is, not sent to a re-invite that
  // would refuse it.
  test('a deactivated PIN-based parent login gets the PIN refusal, not the reactivation message', async () => {
    mockQueryOne.mockResolvedValueOnce(existingLogin({ auth_provider: 'ppbf_local', active_flag: false }));

    await expect(
      assertGuardianLoginProvisionable({ loginEmail: 'dana@example.com', organizationId: 'org-1', accountIdHint: 'acct-existing' }),
    ).rejects.toThrow(/^Forbidden: this email is already used by a PIN-based account/);
  });

  // Scope: the invite surfaces are unchanged. Re-inviting is the deliberate
  // reactivation the refusal names.
  test('without refuseDeactivatedLogin a deactivated login is reactivated, as before', async () => {
    stubLookups({ existingByEmail: existingLogin({ active_flag: false }) });

    const result = await createOrUpdateMicrosoftStaffAccount({
      loginEmail: 'dana@example.com',
      organizationId: 'org-1',
      role: 'parent',
    });

    expect(result.accountId).toBe('acct-existing');
    expect(accountUpsertCalls()).toHaveLength(1);
  });
});
