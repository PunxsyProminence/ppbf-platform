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

import { promoteAccountToOrganizationAdmin, transferOrganizationAdmin } from './auth';

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

// The assign-admin promotion carries the same structural refusals as the
// transfer above, and for the same history: it used to match on account_id
// alone, overwrite organization_id, and clear is_platform_owner -- so a
// promotion could move an account across organizations, mutate a foreign
// tenant's account, demote the platform owner, or "succeed" against no row
// while still writing a membership record.
describe('promoteAccountToOrganizationAdmin', () => {
  test('promotes only inside the named organization and never a platform owner', async () => {
    await promoteAccountToOrganizationAdmin('acct-1', 'org-1');

    const [sql, params] = accountUpdates()[0];
    expect(sql).toContain("role = 'organization_admin'");
    // The WHERE pins the tenant and excludes the platform owner...
    expect(sql).toContain('and organization_id = $2');
    expect(sql).toContain('is_platform_owner = false');
    expect(sql).toContain("role <> 'platform_owner'");
    // ...and the SET writes neither: cross-organization movement and owner
    // demotion can never be side effects of assigning an admin, and a
    // deactivated account must not be silently reactivated by promotion.
    const setClause = sql.slice(sql.toLowerCase().indexOf('set '), sql.toLowerCase().indexOf('where'));
    expect(setClause).not.toContain('organization_id');
    expect(setClause).not.toContain('is_platform_owner');
    expect(setClause).not.toContain('active_flag');
    expect(params).toEqual(['acct-1', 'org-1']);
  });

  test('membership is written and sessions revoked only after the account row matched', async () => {
    await promoteAccountToOrganizationAdmin('acct-1', 'org-1');

    const calls = currentClient.query.mock.calls.map(([sql]) => sql as string);
    const updateIndex = calls.findIndex((sql) => sql.includes('update pilot.accounts'));
    const membershipIndex = calls.findIndex((sql) => sql.includes('pilot.organization_memberships'));
    const revokeIndex = calls.findIndex((sql) => sql.includes('pilot.session_tokens'));
    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect(membershipIndex).toBeGreaterThan(updateIndex);
    expect(revokeIndex).toBeGreaterThan(membershipIndex);
  });

  test.each([
    ['no such account'],
    ['an account belonging to another organization'],
    ['the platform owner'],
  ])('zero matched rows (%s) aborts before any membership or session write', async () => {
    // All three refusals arrive identically: the guarded UPDATE matches
    // nothing. The throw rolls the transaction back, so no contradictory
    // membership row can survive a failed promotion.
    currentClient.query.mockResolvedValue({ rows: [] });

    await expect(promoteAccountToOrganizationAdmin('target-1', 'org-1'))
      .rejects.toThrow('Missing target account in organization');

    expect(accountUpdates()).toHaveLength(1);
    expect(
      currentClient.query.mock.calls.filter(([sql]) => sql.includes('pilot.organization_memberships')),
    ).toHaveLength(0);
    expect(
      currentClient.query.mock.calls.filter(([sql]) => sql.includes('pilot.session_tokens')),
    ).toHaveLength(0);
  });
});
