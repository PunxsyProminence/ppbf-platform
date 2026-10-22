import { NextRequest } from 'next/server';

import { POST } from './route';
import { resolvePrincipal, type PilotPrincipal } from '@/src/server/pilot/auth';
import { listOrganizationFeedback, listPlatformFeedback } from '@/src/server/pilot/feedback';
import { staffNamesByAccount } from '@/src/server/pilot/staffNameLookup';

jest.mock('@/src/server/pilot/auth', () => ({
  resolvePrincipal: jest.fn(),
}));

jest.mock('@/src/server/pilot/feedback', () => ({
  ...jest.requireActual('@/src/server/pilot/feedback'),
  listOrganizationFeedback: jest.fn(),
  listPlatformFeedback: jest.fn(),
}));

// Who a staff submitter is, by name (staffNameLookup.test.ts covers the lookup).
jest.mock('@/src/server/pilot/staffNameLookup', () => ({
  staffNamesByAccount: jest.fn(async () => new Map()),
}));

const mockStaffNames = staffNamesByAccount as jest.Mock;
const mockResolvePrincipal = resolvePrincipal as jest.MockedFunction<typeof resolvePrincipal>;
const mockListOrganization = listOrganizationFeedback as jest.MockedFunction<typeof listOrganizationFeedback>;
const mockListPlatform = listPlatformFeedback as jest.MockedFunction<typeof listPlatformFeedback>;

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'acct-admin',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token-1',
    authProvider: 'microsoft',
    signInMethod: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

function request(body: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/pilot/feedback/list', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListOrganization.mockResolvedValue([]);
  mockListPlatform.mockResolvedValue([]);
});

describe('POST /api/pilot/feedback/list', () => {
  test('rejects an unauthenticated caller', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(null);

    const res = await POST(request());

    expect(res.status).toBe(401);
  });

  // Everyone below is a person whose own submissions are in this queue
  // alongside other people's -- including children writing about being hurt.
  test.each(['coach', 'athlete', 'parent', 'board', 'volunteer', 'staff'] as const)(
    'refuses a %s',
    async (role) => {
      mockResolvePrincipal.mockResolvedValueOnce(principal({ role, accountId: `acct-${role}` }));

      const res = await POST(request());

      expect(res.status).toBe(403);
      expect(mockListOrganization).not.toHaveBeenCalled();
      expect(mockListPlatform).not.toHaveBeenCalled();
    },
  );

  test('refuses a PIN session even when it holds an admin role', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ authProvider: 'ppbf_local' }));

    const res = await POST(request());

    expect(res.status).toBe(403);
    expect(mockListOrganization).not.toHaveBeenCalled();
  });

  test('a gym admin reads their own gym, named, and cannot ask for another', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    const res = await POST(request({ organization_id: 'org-2', limit: 10 }));
    const payload = (await res.json()) as { scope: string; organization_id: string };

    expect(res.status).toBe(200);
    expect(payload.scope).toBe('organization');
    expect(payload.organization_id).toBe('org-1');
    expect(mockListOrganization).toHaveBeenCalledWith('org-1', {
      route: null,
      triageStatus: null,
      limit: 10,
    });
    expect(mockListPlatform).not.toHaveBeenCalled();
  });

  // OD-2026-10-06-025, "Show coach name, hide ID": a staff submitter is named,
  // not addressed. The query returns the login for anyone who is not an
  // athlete; a parent keeps it (no staff name applies to a family and the admin
  // needs it to reach them), and a submission whose account is gone stays null.
  const row = (overrides: Record<string, unknown>) => ({
    submission_id: 'sub', submitted_by_account_id: 'acct', submitted_by_role: 'coach', submitter_name: 'x@example.org', ...overrides,
  });
  const submitters = async (rows: Array<Record<string, unknown>>) => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());
    mockListOrganization.mockResolvedValueOnce(rows as never);
    const res = await POST(request());
    return (await res.json()) as { items: Array<Record<string, string | null>> };
  };

  test('names a staff submitter, keeps a parent login, and leaves a removed account null', async () => {
    mockStaffNames.mockResolvedValueOnce(new Map([['acct-coach', 'Sam Rivera'], ['acct-admin', 'Gym office']]));

    const payload = await submitters([
      row({ submission_id: 'coach-1', submitted_by_account_id: 'acct-coach', submitted_by_role: 'coach', submitter_name: 'sam@example.org' }),
      row({ submission_id: 'coach-2', submitted_by_account_id: 'acct-coach', submitted_by_role: 'coach', submitter_name: 'sam@example.org' }),
      row({ submission_id: 'admin-1', submitted_by_account_id: 'acct-admin', submitted_by_role: 'organization_admin', submitter_name: 'info@example.org' }),
      row({ submission_id: 'parent-1', submitted_by_account_id: 'acct-parent', submitted_by_role: 'parent', submitter_name: 'mom@example.org' }),
      row({ submission_id: 'athlete-1', submitted_by_account_id: 'acct-athlete', submitted_by_role: 'athlete', submitter_name: 'Maya Alvarez' }),
      row({ submission_id: 'gone-1', submitted_by_account_id: 'acct-gone', submitted_by_role: 'coach', submitter_name: null }),
    ]);

    // One lookup, for the staff submitters who still have an account, once each.
    expect(mockStaffNames).toHaveBeenCalledTimes(1);
    expect(mockStaffNames).toHaveBeenCalledWith('org-1', ['acct-admin', 'acct-coach']);
    expect(payload.items.map((item) => [item.submission_id, item.submitter_name])).toEqual([
      ['coach-1', 'Sam Rivera'],
      ['coach-2', 'Sam Rivera'],
      ['admin-1', 'Gym office'],
      ['parent-1', 'mom@example.org'],
      ['athlete-1', 'Maya Alvarez'],
      ['gone-1', null],
    ]);
    expect(JSON.stringify(payload)).not.toContain('sam@example.org');
    expect(JSON.stringify(payload)).not.toContain('info@example.org');
  });

  test.each(['coach', 'staff', 'volunteer', 'admin', 'organization_admin'] as const)(
    'a %s submitter is named',
    async (role) => {
      mockStaffNames.mockResolvedValueOnce(new Map([['acct-1', 'Sam Rivera']]));

      const payload = await submitters([row({ submitted_by_account_id: 'acct-1', submitted_by_role: role })]);

      expect(payload.items[0].submitter_name).toBe('Sam Rivera');
    },
  );

  test.each(['parent', 'board', 'platform_owner'] as const)(
    'a %s submitter keeps the login the query returned: no staff name applies',
    async (role) => {
      const payload = await submitters([row({ submitted_by_account_id: 'acct-1', submitted_by_role: role, submitter_name: 'who@example.org' })]);

      expect(mockStaffNames).toHaveBeenCalledWith('org-1', []);
      expect(payload.items[0].submitter_name).toBe('who@example.org');
    },
  );

  // A safeguarding queue still has to answer "who wrote it": two different
  // staff who read the same are numbered, in account-id order, so the number
  // does not move when a newer submission arrives.
  test('numbers two different staff who read the same, by account id, and not one person twice', async () => {
    mockStaffNames.mockResolvedValueOnce(new Map([['acct-b', 'Sam'], ['acct-a', 'Sam'], ['acct-c', 'Pat Lowe']]));

    const payload = await submitters([
      row({ submission_id: 'newest', submitted_by_account_id: 'acct-b' }),
      row({ submission_id: 'middle', submitted_by_account_id: 'acct-c' }),
      row({ submission_id: 'older', submitted_by_account_id: 'acct-a' }),
      row({ submission_id: 'oldest', submitted_by_account_id: 'acct-b' }),
    ]);

    expect(payload.items.map((item) => [item.submission_id, item.submitter_name])).toEqual([
      ['newest', 'Sam (2 of 2)'],
      ['middle', 'Pat Lowe'],
      ['older', 'Sam (1 of 2)'],
      ['oldest', 'Sam (2 of 2)'],
    ]);
  });

  test('the legacy admin role reads the same gym-scoped queue', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ role: 'admin' }));

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(mockListOrganization).toHaveBeenCalledWith('org-1', expect.any(Object));
  });

  // The de-identification is a property of the platform statement, so the only
  // thing this route has to get right is never sending the owner down the
  // named path.
  test('the platform owner reads every gym and never the named query', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(
      principal({ role: 'platform_owner', accountId: 'acct-omega' }),
    );

    const res = await POST(request({ route: 'safeguarding' }));
    const payload = (await res.json()) as { scope: string; organization_id?: string };

    expect(res.status).toBe(200);
    expect(payload.scope).toBe('platform');
    expect(payload).not.toHaveProperty('organization_id');
    expect(mockListPlatform).toHaveBeenCalledWith({
      route: 'safeguarding',
      triageStatus: null,
      limit: undefined,
    });
    expect(mockListOrganization).not.toHaveBeenCalled();
  });

  test('refuses a route or status outside the stored vocabulary', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());
    expect((await POST(request({ route: 'backlog' }))).status).toBe(400);

    mockResolvePrincipal.mockResolvedValueOnce(principal());
    expect((await POST(request({ triage_status: 'wontfix' }))).status).toBe(400);

    expect(mockListOrganization).not.toHaveBeenCalled();
    expect(mockListPlatform).not.toHaveBeenCalled();
  });

  test('an omitted filter reads both lanes rather than silently hiding one', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    await POST(request());

    expect(mockListOrganization).toHaveBeenCalledWith('org-1', {
      route: null,
      triageStatus: null,
      limit: undefined,
    });
  });
});
