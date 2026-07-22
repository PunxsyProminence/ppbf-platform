function fakeClient() {
  return { query: jest.fn().mockResolvedValue({ rows: [] }) };
}

let currentClient: ReturnType<typeof fakeClient>;

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(currentClient)),
}));

jest.mock('./security', () => ({
  hashPin: jest.fn(async () => 'hashed-pin'),
  verifyPin: jest.fn(),
  createOpaqueToken: jest.fn(),
  hashToken: jest.fn(),
}));

import {
  createCoachAccount,
  createOrRotateAdminAccount,
  createOrUpdateAthleteAccount,
  createOrUpdateMicrosoftPlatformOwnerAccount,
  createParentAccount,
  promoteAccountToOrganizationAdmin,
  revokeAllSessionsForAccountInOrganization,
  setAccountActiveStatus,
  setOrganizationStatus,
  transferOrganizationAdmin,
  upsertOrganizationMembership,
} from './auth';
import { query, queryOne } from './db';

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

function revokeCalls() {
  return currentClient.query.mock.calls.filter(([sql]) => sql.includes('pilot.session_tokens') && sql.includes('revoked_at'));
}

function membershipCalls() {
  return currentClient.query.mock.calls.filter(([sql]) => sql.includes('pilot.organization_memberships') && sql.includes('insert'));
}

beforeEach(() => {
  currentClient = fakeClient();
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('session revocation after credential changes', () => {
  test('createOrUpdateAthleteAccount revokes sessions when updating an existing account (PIN change)', async () => {
    mockQuery.mockResolvedValueOnce([{ organization_id: 'org-1' }]); // existing account lookup
    await createOrUpdateAthleteAccount('acct-1', 'ath-1', '123456', 'org-1');
    expect(revokeCalls()).toHaveLength(1);
    expect(revokeCalls()[0][1]).toEqual(['acct-1']);
  });

  test('createOrUpdateAthleteAccount does not revoke anything for a brand-new account', async () => {
    mockQuery.mockResolvedValueOnce([]); // no existing account
    await createOrUpdateAthleteAccount('acct-new', 'ath-1', '123456', 'org-1');
    expect(revokeCalls()).toHaveLength(0);
  });

  test('createCoachAccount revokes sessions when updating an existing account', async () => {
    mockQuery.mockResolvedValueOnce([{ organization_id: 'org-1' }]);
    await createCoachAccount('acct-1', '123456', 'org-1');
    expect(revokeCalls()).toHaveLength(1);
  });

  test('createParentAccount revokes sessions when updating an existing account', async () => {
    mockQuery.mockResolvedValueOnce([{ organization_id: 'org-1' }]);
    await createParentAccount('acct-1', '123456', 'org-1');
    expect(revokeCalls()).toHaveLength(1);
  });

  test('createOrRotateAdminAccount always revokes sessions and assigns a matching active membership', async () => {
    await createOrRotateAdminAccount('acct-1', '123456', 'org-1', 'organization_admin');
    expect(revokeCalls()).toHaveLength(1);
    expect(membershipCalls()).toHaveLength(1);
    expect(membershipCalls()[0][1]).toEqual(['acct-1', 'org-1', 'organization_admin']);
  });

  test('createOrRotateAdminAccount assigns a platform_owner membership when rotating a platform owner', async () => {
    await createOrRotateAdminAccount('owner-1', '123456', 'org-1', 'platform_owner');
    expect(membershipCalls()).toHaveLength(1);
    expect(membershipCalls()[0][1]).toEqual(['owner-1', 'org-1', 'platform_owner']);
  });
});

describe('session revocation after provider/role/organization changes', () => {
  test('createOrUpdateMicrosoftPlatformOwnerAccount revokes sessions for an existing account', async () => {
    mockQueryOne
      .mockResolvedValueOnce(null) // no existing account by email
      .mockResolvedValueOnce({ account_id: 'owner-1' }); // existing account by id
    await createOrUpdateMicrosoftPlatformOwnerAccount({ loginEmail: 'owner@example.com', organizationId: 'org-1', accountIdHint: 'owner-1' });
    expect(revokeCalls()).toHaveLength(1);
  });

  test('createOrUpdateMicrosoftPlatformOwnerAccount does not revoke for a brand-new account', async () => {
    mockQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await createOrUpdateMicrosoftPlatformOwnerAccount({ loginEmail: 'new-owner@example.com', organizationId: 'org-1' });
    expect(revokeCalls()).toHaveLength(0);
  });

  // pilot.accounts.role/organization_id are read live on every request, so
  // ANY membership mutation can change what an existing session resolves
  // to. upsertOrganizationMembership must therefore revoke unconditionally
  // -- these cases mirror the exact scenarios issue review called out.
  test.each([
    ['brand-new membership with the same role the account already has elsewhere', 'coach', true],
    ['brand-new membership with a different role', 'organization_admin', true],
    ['a role change on an existing membership', 'organization_admin', true],
    ['reactivating a membership', 'coach', true],
  ])('upsertOrganizationMembership always revokes sessions: %s', async (_label, role, activeFlag) => {
    currentClient.query.mockResolvedValue({ rows: [{ account_id: 'acct-1' }] });
    await upsertOrganizationMembership('acct-1', 'org-1', role as never, activeFlag);
    expect(revokeCalls()).toHaveLength(1);
    expect(revokeCalls()[0][1]).toEqual(['acct-1']);
  });

  test('upsertOrganizationMembership revokes sessions on deactivation', async () => {
    currentClient.query.mockResolvedValue({ rows: [{ account_id: 'acct-1' }] });
    await upsertOrganizationMembership('acct-1', 'org-1', 'coach', false);
    expect(revokeCalls()).toHaveLength(1);
  });

  test('an old session bound to organization A is revoked when a role is assigned to the same account in organization B (prevents cross-organization privilege inheritance)', async () => {
    currentClient.query.mockResolvedValue({ rows: [{ account_id: 'acct-1' }] });
    await upsertOrganizationMembership('acct-1', 'org-B', 'organization_admin', true);
    // revokeAllSessionsForAccountTx revokes by account_id alone (every
    // session for this account, in every organization) -- specifically
    // because a session in org A must not be allowed to keep resolving
    // with a role that was just granted in org B.
    expect(revokeCalls()).toHaveLength(1);
    expect(revokeCalls()[0][1]).toEqual(['acct-1']);
  });

  test('setAccountActiveStatus revokes sessions on deactivation', async () => {
    currentClient.query.mockResolvedValue({ rows: [{ account_id: 'acct-1' }] });
    await setAccountActiveStatus('acct-1', 'org-1', false);
    expect(revokeCalls()).toHaveLength(1);
  });

  test('setAccountActiveStatus does not revoke on activation', async () => {
    currentClient.query.mockResolvedValue({ rows: [{ account_id: 'acct-1' }] });
    await setAccountActiveStatus('acct-1', 'org-1', true);
    expect(revokeCalls()).toHaveLength(0);
  });

  test('setOrganizationStatus revokes every session in that organization when it becomes inactive', async () => {
    await setOrganizationStatus('org-1', 'suspended');
    const orgRevoke = currentClient.query.mock.calls.filter(
      ([sql]) => sql.includes('pilot.session_tokens') && sql.includes('organization_id = $1'),
    );
    expect(orgRevoke).toHaveLength(1);
    expect(orgRevoke[0][1]).toEqual(['org-1']);
  });

  test('setOrganizationStatus does not revoke sessions when the organization stays active', async () => {
    await setOrganizationStatus('org-1', 'active');
    expect(revokeCalls()).toHaveLength(0);
  });

  test('promoteAccountToOrganizationAdmin revokes sessions', async () => {
    await promoteAccountToOrganizationAdmin('acct-1', 'org-1');
    expect(revokeCalls()).toHaveLength(1);
  });

  test('transferOrganizationAdmin revokes sessions for both accounts', async () => {
    currentClient.query.mockResolvedValue({ rows: [{ account_id: 'acct-1' }] });
    await transferOrganizationAdmin('from-1', 'to-1', 'org-1', 'coach');
    expect(revokeCalls()).toHaveLength(2);
  });
});

describe('revokeAllSessionsForAccountInOrganization (cross-tenant administrator revocation)', () => {
  test('revokes only the account\'s sessions in the requesting organization, scoped by both account_id and organization_id', async () => {
    mockQueryOne.mockResolvedValueOnce({ account_id: 'acct-1', is_platform_owner: false });
    await expect(revokeAllSessionsForAccountInOrganization('acct-1', 'org-1')).resolves.toBeUndefined();
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('pilot.session_tokens'),
      ['acct-1', 'org-1'],
    );
  });

  test('authorizes via an active organization_memberships row, not accounts.organization_id -- a legitimate secondary membership is revocable', async () => {
    mockQueryOne.mockResolvedValueOnce({ account_id: 'acct-1', is_platform_owner: false });
    await revokeAllSessionsForAccountInOrganization('acct-1', 'org-secondary');
    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toContain('pilot.organization_memberships');
    expect(sql).toContain('om.active_flag = true');
    expect(params).toEqual(['acct-1', 'org-secondary']);
  });

  test('denies revocation for an account with no membership in this organization (nonexistent account, or a foreign organization)', async () => {
    // The join against an active membership row for this exact organization
    // means neither a nonexistent account nor an account whose only
    // membership is elsewhere produces a match -- queryOne returns null
    // either way.
    mockQueryOne.mockResolvedValueOnce(null);
    await expect(revokeAllSessionsForAccountInOrganization('acct-in-other-org', 'org-1')).rejects.toThrow(
      'Account not found or cannot be revoked',
    );
  });

  test('denies revocation when the membership in this organization exists but is inactive', async () => {
    // active_flag = true in the join means an inactive membership row also
    // produces no match.
    mockQueryOne.mockResolvedValueOnce(null);
    await expect(revokeAllSessionsForAccountInOrganization('acct-inactive-member', 'org-1')).rejects.toThrow(
      'Account not found or cannot be revoked',
    );
  });

  test('denies revocation of a platform owner even if the organization matches', async () => {
    mockQueryOne.mockResolvedValueOnce({ account_id: 'owner-1', is_platform_owner: true });
    await expect(revokeAllSessionsForAccountInOrganization('owner-1', 'org-1')).rejects.toThrow(
      'Account not found or cannot be revoked',
    );
  });
});
