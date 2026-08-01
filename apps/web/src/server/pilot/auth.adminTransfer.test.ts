function fakeClient() {
  return {
    query: jest.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('update pilot.accounts')) {
        return { rows: [{ account_id: 'matched' }] };
      }
      return { rows: [] };
    }),
  };
}

let currentClient: ReturnType<typeof fakeClient>;

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(currentClient)),
}));

import { transferOrganizationAdmin } from './auth';

function accountUpdates() {
  return currentClient.query.mock.calls.filter(([sql]) => sql.includes('update pilot.accounts'));
}

beforeEach(() => {
  currentClient = fakeClient();
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('transferOrganizationAdmin', () => {
  test('promotes only inside the named organization and never a platform owner', async () => {
    await transferOrganizationAdmin('old-admin-1', 'new-admin-1', 'org-1', 'coach');

    const [promoteSql, promoteParams] = accountUpdates()[0];
    expect(promoteSql).toContain("role = 'organization_admin'");
    expect(promoteSql).toContain('organization_id = $2');
    expect(promoteSql).toContain('is_platform_owner = false');
    expect(promoteSql).toContain("role <> 'platform_owner'");
    expect(promoteParams).toEqual(['new-admin-1', 'org-1']);
  });

  test('a target the promote does not match aborts before anything is demoted', async () => {
    // Zero matched rows is how every refusal arrives here: no such account, an
    // account belonging to another organization, or the platform owner.
    currentClient.query.mockResolvedValue({ rows: [] });

    await expect(transferOrganizationAdmin('old-admin-1', 'outsider-1', 'org-1', 'coach'))
      .rejects.toThrow('Missing target account for admin transfer');

    expect(accountUpdates()).toHaveLength(1);
    expect(
      currentClient.query.mock.calls.filter(([sql]) => sql.includes('pilot.organization_memberships')),
    ).toHaveLength(0);
    expect(
      currentClient.query.mock.calls.filter(([sql]) => sql.includes('pilot.session_tokens')),
    ).toHaveLength(0);
  });

  test('demotes the outgoing admin only within the same organization', async () => {
    await transferOrganizationAdmin('old-admin-1', 'new-admin-1', 'org-1', 'coach');

    const [demoteSql, demoteParams] = accountUpdates()[1];
    expect(demoteSql).toContain('where account_id = $1 and organization_id = $2');
    expect(demoteParams).toEqual(['old-admin-1', 'org-1', 'coach']);
  });
});
