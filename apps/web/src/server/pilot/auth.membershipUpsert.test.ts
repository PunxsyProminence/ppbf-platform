// upsertOrganizationMembership is the platform owner's membership route
// (app/api/pilot/platform/organizations/memberships). It may move a gym's
// staff login between organizations, change its role and deactivate it. It
// must not do any of that to an athlete -- a child's login belongs to their
// own gym, the boundary platform/users/status holds -- nor to the platform
// owner's own account, which the update used to strip of is_platform_owner
// (audit CL-A5). Refused before any membership row or session is touched.

interface TargetRow {
  role: string;
  is_platform_owner: boolean;
  athlete_id: string | null;
}

// The locked read computes both refusals in SQL; this fake answers it from the
// row as PostgreSQL would.
function fakeClient(target: TargetRow | null) {
  return {
    query: jest.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('from pilot.accounts') && sql.includes('for update')) {
        expect(sql).toContain("role = 'athlete' or athlete_id is not null");
        expect(sql).toContain("is_platform_owner or role = 'platform_owner'");
        return {
          rows: target
            ? [{
              athlete_login: target.role === 'athlete' || target.athlete_id !== null,
              platform_owner: target.is_platform_owner || target.role === 'platform_owner',
            }]
            : [],
        };
      }
      if (sql.includes('update pilot.accounts')) {
        return { rows: [{ account_id: 'matched' }] };
      }
      return { rows: [] };
    }),
  };
}

let currentClient: ReturnType<typeof fakeClient>;

jest.mock('./db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(currentClient)),
}));

import { upsertOrganizationMembership } from './auth';

function writes() {
  return currentClient.query.mock.calls
    .map(([sql]) => sql as string)
    .filter((sql) => /insert into|update /.test(sql));
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('upsertOrganizationMembership target refusals', () => {
  test('an athlete login is refused and nothing is written', async () => {
    currentClient = fakeClient({ role: 'athlete', is_platform_owner: false, athlete_id: 'ATH-1' });

    await expect(upsertOrganizationMembership('acct-athlete-1', 'org-2', 'coach', true))
      .rejects.toThrow(/^Forbidden: an athlete account is administered by their own gym/);
    expect(writes()).toEqual([]);
  });

  test('an account linked to an athlete record is refused whatever its role says', async () => {
    currentClient = fakeClient({ role: 'coach', is_platform_owner: false, athlete_id: 'ATH-1' });

    await expect(upsertOrganizationMembership('acct-athlete-2', 'org-1', 'coach', false))
      .rejects.toThrow(/^Forbidden/);
    expect(writes()).toEqual([]);
  });

  test('the platform owner account is refused and keeps platform ownership', async () => {
    currentClient = fakeClient({ role: 'platform_owner', is_platform_owner: true, athlete_id: null });

    await expect(upsertOrganizationMembership('acct-owner', 'org-1', 'organization_admin', true))
      .rejects.toThrow(/^Forbidden: the platform owner/);
    expect(writes()).toEqual([]);
  });

  test('is_platform_owner alone is enough to refuse', async () => {
    currentClient = fakeClient({ role: 'organization_admin', is_platform_owner: true, athlete_id: null });

    await expect(upsertOrganizationMembership('acct-owner', 'org-1', 'coach', true))
      .rejects.toThrow(/^Forbidden: the platform owner/);
    expect(writes()).toEqual([]);
  });

  test('a staff login still has its membership written and its sessions revoked', async () => {
    currentClient = fakeClient({ role: 'coach', is_platform_owner: false, athlete_id: null });

    await upsertOrganizationMembership('acct-coach-1', 'org-2', 'coach', true);

    const all = writes();
    expect(all.some((sql) => sql.includes('insert into pilot.organization_memberships'))).toBe(true);
    expect(all.some((sql) => sql.includes('update pilot.accounts'))).toBe(true);
    expect(all.some((sql) => sql.includes('update pilot.session_tokens'))).toBe(true);
  });

  test('the account update itself cannot match a platform owner or athlete', async () => {
    // Structural, beside the read above: the WHERE refuses the same targets.
    currentClient = fakeClient({ role: 'coach', is_platform_owner: false, athlete_id: null });

    await upsertOrganizationMembership('acct-coach-1', 'org-2', 'coach', true);

    const update = writes().find((sql) => sql.includes('update pilot.accounts')) as string;
    const where = update.slice(update.indexOf('where'));
    expect(where).toContain('is_platform_owner = false');
    expect(where).toContain("role not in ('platform_owner', 'athlete')");
    expect(where).toContain('athlete_id is null');
  });
});
