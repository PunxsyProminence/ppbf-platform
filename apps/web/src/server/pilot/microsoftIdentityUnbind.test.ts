// Unit cover for unbindMicrosoftIdentity's refusals and the shape of what it
// writes. microsoftIdentityBinding.pg.test.ts proves the same rules against a
// real database; this pins the order -- every refusal before any write.

function fakeClient() {
  return { query: jest.fn().mockResolvedValue({ rows: [] }) };
}

let currentClient: ReturnType<typeof fakeClient>;

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(currentClient)),
}));

import { withTransaction } from './db';
import { unbindMicrosoftIdentity } from './microsoftIdentityUnbind';

const mockWithTransaction = withTransaction as jest.Mock;

const orgAdmin = { accountId: 'ppbf@example.org', role: 'organization_admin' as const, organizationId: 'org-1' };
const owner = { accountId: 'Admin@example.org', role: 'platform_owner' as const, organizationId: 'root' };

function writes() {
  return currentClient.query.mock.calls.filter(([sql]) => /^\s*(update|insert|with)/i.test(sql));
}

beforeEach(() => {
  currentClient = fakeClient();
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('unbindMicrosoftIdentity', () => {
  test.each(['coach', 'athlete', 'parent', 'staff', 'volunteer'] as const)('refuses a %s before touching the database', async (role) => {
    await expect(unbindMicrosoftIdentity({ ...orgAdmin, role }, 'target')).rejects.toThrow('Forbidden: role not allowed');
    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  test('refuses an empty account id', async () => {
    await expect(unbindMicrosoftIdentity(orgAdmin, '  ')).rejects.toThrow('Missing account_id');
    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  test.each([orgAdmin, owner])('refuses the actor\'s own account ($role)', async (actor) => {
    await expect(unbindMicrosoftIdentity(actor, actor.accountId)).rejects.toThrow(
      'Forbidden: an account cannot unbind its own Microsoft identity',
    );
    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  test('an organization admin\'s lookup is scoped to an active membership in their own organization', async () => {
    await expect(unbindMicrosoftIdentity(orgAdmin, 'target')).rejects.toThrow('Not found: account');
    const [sql, params] = currentClient.query.mock.calls[0];
    expect(sql).toMatch(/pilot\.organization_memberships/);
    expect(sql).toMatch(/om\.organization_id = \$2/);
    expect(sql).toMatch(/active_flag = true/);
    expect(sql).toMatch(/a\.role = 'platform_owner' or om\.role = 'platform_owner'/);
    expect(sql).toMatch(/for update/i);
    expect(params).toEqual(['target', 'org-1']);
    expect(writes()).toHaveLength(0);
  });

  test('an organization admin cannot reach the platform owner, and the refusal reads like a missing account', async () => {
    currentClient.query.mockResolvedValueOnce({
      rows: [{ account_id: 'target', organization_id: 'org-1', is_platform_owner: true, microsoft_oid: 'oid-1234', microsoft_tid: 'tid' }],
    });
    await expect(unbindMicrosoftIdentity(orgAdmin, 'target')).rejects.toThrow('Not found: account');
    expect(writes()).toHaveLength(0);
  });

  test('the platform owner\'s lookup is not scoped to an organization', async () => {
    await expect(unbindMicrosoftIdentity(owner, 'target')).rejects.toThrow('Not found: account');
    const [sql, params] = currentClient.query.mock.calls[0];
    expect(sql).not.toMatch(/organization_memberships/);
    expect(params).toEqual(['target']);
  });

  test('clears the pair and writes the audit row in the same transaction, naming the actor', async () => {
    currentClient.query
      .mockResolvedValueOnce({
        rows: [{ account_id: 'target', organization_id: 'org-2', is_platform_owner: false, microsoft_oid: 'oid-abcd', microsoft_tid: 'tid-1' }],
      })
      .mockResolvedValueOnce({ rows: [{ account_id: 'target' }] });

    await expect(unbindMicrosoftIdentity(owner, 'target')).resolves.toEqual({ accountId: 'target', cleared: true });

    const [update, audit] = writes();
    expect(update[0]).toMatch(/set microsoft_oid = null, microsoft_tid = null/);
    expect(audit[0]).toMatch(/insert into pilot\.audit_events/);
    expect(audit[1]).toEqual([
      'update',
      'Admin@example.org',
      'platform_owner',
      'org-2',
      'account',
      'target',
      JSON.stringify({
        change: 'microsoft_identity_cleared',
        reason: 'admin_unbind',
        previous_microsoft_tid: 'tid-1',
        previous_microsoft_oid_suffix: 'abcd',
      }),
    ]);
  });

  test('an organization admin\'s audit row is filed under their own organization', async () => {
    currentClient.query
      .mockResolvedValueOnce({
        rows: [{ account_id: 'target', organization_id: 'org-elsewhere', is_platform_owner: false, microsoft_oid: 'oid-abcd', microsoft_tid: 'tid-1' }],
      })
      .mockResolvedValueOnce({ rows: [{ account_id: 'target' }] });

    await unbindMicrosoftIdentity(orgAdmin, 'target');

    const audit = writes()[1];
    expect(audit[1][3]).toBe('org-1');
  });

  test('an unbound account changes nothing and records nothing', async () => {
    currentClient.query.mockResolvedValueOnce({
      rows: [{ account_id: 'target', organization_id: 'org-1', is_platform_owner: false, microsoft_oid: null, microsoft_tid: null }],
    });
    await expect(unbindMicrosoftIdentity(orgAdmin, 'target')).resolves.toEqual({ accountId: 'target', cleared: false });
    expect(writes()).toHaveLength(0);
  });
});
