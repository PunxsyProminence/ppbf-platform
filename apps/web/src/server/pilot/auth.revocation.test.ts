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

  test('createOrRotateAdminAccount always revokes sessions', async () => {
    await createOrRotateAdminAccount('acct-1', '123456', 'org-1');
    expect(revokeCalls()).toHaveLength(1);
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

  test('upsertOrganizationMembership revokes sessions when the role changes', async () => {
    currentClient.query.mockImplementation((sql: string) => {
      if (sql.includes('select role from pilot.organization_memberships')) {
        return Promise.resolve({ rows: [{ role: 'coach' }] });
      }
      return Promise.resolve({ rows: [{ account_id: 'acct-1' }] });
    });
    await upsertOrganizationMembership('acct-1', 'org-1', 'organization_admin', true);
    expect(revokeCalls()).toHaveLength(1);
  });

  test('upsertOrganizationMembership revokes sessions on deactivation even without a role change', async () => {
    currentClient.query.mockImplementation((sql: string) => {
      if (sql.includes('select role from pilot.organization_memberships')) {
        return Promise.resolve({ rows: [{ role: 'coach' }] });
      }
      return Promise.resolve({ rows: [{ account_id: 'acct-1' }] });
    });
    await upsertOrganizationMembership('acct-1', 'org-1', 'coach', false);
    expect(revokeCalls()).toHaveLength(1);
  });

  test('upsertOrganizationMembership does not revoke when nothing sensitive changed', async () => {
    currentClient.query.mockImplementation((sql: string) => {
      if (sql.includes('select role from pilot.organization_memberships')) {
        return Promise.resolve({ rows: [{ role: 'coach' }] });
      }
      return Promise.resolve({ rows: [{ account_id: 'acct-1' }] });
    });
    await upsertOrganizationMembership('acct-1', 'org-1', 'coach', true);
    expect(revokeCalls()).toHaveLength(0);
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
  test('revokes when the account belongs to the requesting organization and is not a platform owner', async () => {
    mockQueryOne.mockResolvedValueOnce({ account_id: 'acct-1', is_platform_owner: false });
    await expect(revokeAllSessionsForAccountInOrganization('acct-1', 'org-1')).resolves.toBeUndefined();
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('pilot.session_tokens'), ['acct-1']);
  });

  test('denies revocation for an account in a different organization', async () => {
    // Scoping the lookup by organization_id means an account in another org
    // simply doesn't match -- queryOne returns null either way.
    mockQueryOne.mockResolvedValueOnce(null);
    await expect(revokeAllSessionsForAccountInOrganization('acct-in-other-org', 'org-1')).rejects.toThrow(
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
