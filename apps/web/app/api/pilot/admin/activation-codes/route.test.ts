import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { issueActivationCode, listOutstandingActivationCodes } from '@/src/server/pilot/activation';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import type { PilotRole } from '@/src/server/pilot/contracts';

/**
 * Behavioural cover for the inline gate in this route, resolveTargetOrganization.
 *
 * That function is the ENTIRE authorization for both GET and POST, and before
 * this file nothing exercised it. The two places that named it --
 * routeGateDeclaration.convention.test.ts's allowlist and
 * organizationScope.convention.test.ts's guard regex -- both match the
 * IDENTIFIER. They assert a resolver exists and is declared; neither calls it,
 * so widening the role test or deleting the requested-organization comparison
 * left every suite in the repository green.
 *
 * What the gate does, read off route.ts rather than off its header:
 *
 *   1. refuse unless isOrganizationAdminRole(principal.role) -- which is
 *      'organization_admin' or the legacy 'admin' alias, and NOTHING else
 *      (access.ts:25-27). platform_owner is refused here even though it
 *      outranks an org admin elsewhere.
 *   2. refuse a non-empty requested organization that is not the principal's.
 *   3. return principal.organizationId -- never the requested value, even when
 *      the requested value was accepted in step 2.
 *
 * Step 3 is why the empty-string and missing-parameter cases below assert the
 * value handed to the service: when the caller names their own organization
 * the two values are identical, so only the paths where the request carries no
 * organization can tell "returns the principal's" apart from "returns the
 * request's".
 *
 * MOCKING. requireMicrosoftAuthenticatedPrincipal is the only thing replaced in
 * http.ts -- jsonError is the real one, so every status code asserted below is
 * produced by production code rather than restated in this file. access.ts is
 * NOT mocked, so isOrganizationAdminRole is the real role predicate; mocking it
 * would turn each role case into an assertion about a jest.fn's return value.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requireMicrosoftAuthenticatedPrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/activation', () => ({
  issueActivationCode: jest.fn(),
  listOutstandingActivationCodes: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockRequirePrincipal = requireMicrosoftAuthenticatedPrincipal as jest.Mock;
const mockIssue = issueActivationCode as jest.Mock;
const mockList = listOutstandingActivationCodes as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

const PRINCIPAL_ORG = 'org-alpha';
const OTHER_ORG = 'org-bravo';

function principal(role: PilotRole, overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'actor-1',
    role,
    organizationId: PRINCIPAL_ORG,
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  };
}

function getRequest(search = ''): NextRequest {
  return new NextRequest(`http://localhost/api/pilot/admin/activation-codes${search}`);
}

function postRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/pilot/admin/activation-codes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Every role in the PilotRole union, and what the gate does with it.
 *
 * Typed as Record<PilotRole, ...> deliberately: adding a tenth role to the
 * union without deciding here is a compile error. Jest does not typecheck in
 * this repository (ts-jest runs with diagnostics off and isolatedModules on),
 * so the command that actually enforces this exhaustiveness is
 * `npm run typecheck` -- in CI, and locally, not this suite.
 */
const ROLE_GATE: Record<PilotRole, 'admitted' | 'refused'> = {
  organization_admin: 'admitted',
  // access.ts:25-27 treats the legacy 'admin' row as an organization admin.
  admin: 'admitted',
  // The deliberate exclusion. An activation code is a bearer credential for
  // one named athlete: its holder sets that child's PIN and can then sign in
  // as them. Minting one would route the platform owner around the boundary
  // assertActorCanAccessAthlete enforces, so the tier that outranks an org
  // admin everywhere else is refused here.
  platform_owner: 'refused',
  coach: 'refused',
  athlete: 'refused',
  parent: 'refused',
  board: 'refused',
  volunteer: 'refused',
  staff: 'refused',
};

const ROLE_CASES = Object.entries(ROLE_GATE) as Array<[PilotRole, 'admitted' | 'refused']>;

beforeEach(() => {
  jest.clearAllMocks();
  mockList.mockResolvedValue([]);
  mockIssue.mockImplementation(async (params: { accountId: string; organizationId: string }) => ({
    accountId: params.accountId,
    organizationId: params.organizationId,
    code: 'ABCD-2345-EFGH',
    expiresAt: '2026-09-01T00:00:00Z',
  }));
});

describe('GET /api/pilot/admin/activation-codes -- inline gate', () => {
  test.each(ROLE_CASES)('%s is %s', async (role, outcome) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal(role));

    const response = await GET(getRequest());

    if (outcome === 'admitted') {
      expect(response.status).toBe(200);
      expect(mockList).toHaveBeenCalledWith(PRINCIPAL_ORG);
      await expect(response.json()).resolves.toMatchObject({ ok: true, organization_id: PRINCIPAL_ORG });
    } else {
      expect(response.status).toBe(403);
      expect(mockList).not.toHaveBeenCalled();
    }
  });

  // Called out on its own because it is the case the route header exists to
  // explain, and because the table above would still pass if it were the only
  // row deleted.
  test('refuses the platform owner by role, naming the role as the reason', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    const response = await GET(getRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden: role not allowed' });
    expect(mockList).not.toHaveBeenCalled();
  });

  test('refuses an admin naming an organization other than their own', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await GET(getRequest(`?organization_id=${OTHER_ORG}`));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Forbidden: cannot act on another organization',
    });
    expect(mockList).not.toHaveBeenCalled();
  });

  test('admits an admin naming their own organization explicitly', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await GET(getRequest(`?organization_id=${PRINCIPAL_ORG}`));

    expect(response.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(PRINCIPAL_ORG);
  });

  // The three no-organization-named paths. These are the ones that can tell
  // "the gate returns the principal's organization" apart from "the gate
  // returns whatever was requested" -- see the file header.
  test.each([
    ['the parameter is absent', ''],
    ['the parameter is an empty string', '?organization_id='],
    ['the parameter is whitespace that trims to empty', '?organization_id=%20%20'],
  ])('reads the principal organization when %s', async (_label, search) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await GET(getRequest(search));

    expect(response.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(PRINCIPAL_ORG);
    expect(mockList).not.toHaveBeenCalledWith('');
    await expect(response.json()).resolves.toMatchObject({ organization_id: PRINCIPAL_ORG });
  });

  test('a PIN session never reaches the gate', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(
      new Error('Forbidden: Microsoft-authenticated session required'),
    );

    const response = await GET(getRequest());

    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe('POST /api/pilot/admin/activation-codes -- inline gate', () => {
  test.each(ROLE_CASES)('%s is %s', async (role, outcome) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal(role));

    const response = await POST(postRequest({ account_id: 'athlete-account-1' }));

    if (outcome === 'admitted') {
      expect(response.status).toBe(200);
      expect(mockIssue).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'athlete-account-1', organizationId: PRINCIPAL_ORG }),
      );
    } else {
      expect(response.status).toBe(403);
      expect(mockIssue).not.toHaveBeenCalled();
    }
  });

  test('refuses the platform owner, mints nothing and writes no audit event', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    const response = await POST(postRequest({ account_id: 'athlete-account-1' }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden: role not allowed' });
    expect(mockIssue).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('refuses an admin naming an organization other than their own', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(
      postRequest({ account_id: 'athlete-account-1', organization_id: OTHER_ORG }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Forbidden: cannot act on another organization',
    });
    expect(mockIssue).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('admits an admin naming their own organization explicitly', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(
      postRequest({ account_id: 'athlete-account-1', organization_id: PRINCIPAL_ORG }),
    );

    expect(response.status).toBe(200);
    expect(mockIssue).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'athlete-account-1', organizationId: PRINCIPAL_ORG }),
    );
  });

  test.each([
    ['organization_id is absent', {}],
    ['organization_id is an empty string', { organization_id: '' }],
    ['organization_id is whitespace that trims to empty', { organization_id: '   ' }],
  ])('hands the principal organization to the issuer when %s', async (_label, extra) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(postRequest({ account_id: 'athlete-account-1', ...extra }));

    expect(response.status).toBe(200);
    expect(mockIssue).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: PRINCIPAL_ORG }),
    );
    expect(mockIssue).not.toHaveBeenCalledWith(expect.objectContaining({ organizationId: '' }));
  });

  /**
   * The cross-tenant case the gate and the issuer defend together.
   *
   * The gate refuses a caller who NAMES another organization, but nothing stops
   * gym A's admin from putting gym B's athlete account_id in the body and
   * naming no organization at all. What defeats that is which organization the
   * route hands down: activation.ts:196-208 requires
   * `account_id = $1 and organization_id = $2 and role = 'athlete' and
   * is_platform_owner = false` before it supersedes or inserts anything, and
   * returns one generic "Not found" for every miss so the endpoint cannot be
   * used to probe which accounts exist.
   *
   * That defence only holds if $2 is the PRINCIPAL's organization. This case
   * pins that argument. It does not exercise the SQL -- issueActivationCode is
   * mocked here, and activation.test.ts covers the query itself; what is
   * established below is that the route supplies the tenant the query filters
   * on, not the one the caller supplied.
   */
  test('an admin cannot mint for another gym athlete by supplying its account_id', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockIssue.mockRejectedValueOnce(
      new Error('Not found: no pending athlete account matches that identifier'),
    );

    const response = await POST(postRequest({ account_id: 'other-gym-athlete' }));

    // The organization filtered on is the caller's own, so gym B's athlete is
    // simply not in the set this call can reach.
    expect(mockIssue).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'other-gym-athlete', organizationId: PRINCIPAL_ORG }),
    );
    expect(mockIssue).not.toHaveBeenCalledWith(expect.objectContaining({ organizationId: OTHER_ORG }));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'Not found: no pending athlete account matches that identifier',
    });
    // Nothing was issued, so nothing is recorded as issued.
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('records the issuing actor and the principal organization on the audit event', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(
      principal('organization_admin', { accountId: 'admin-7' }),
    );

    const response = await POST(postRequest({ account_id: 'athlete-account-1' }));

    expect(response.status).toBe(200);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_account_id: 'admin-7',
        actor_role: 'organization_admin',
        organization_id: PRINCIPAL_ORG,
        entity_type: 'account_activation_token',
        entity_id: 'athlete-account-1',
      }),
    );

    // The plaintext code is returned to the caller exactly once and must not
    // reach the audit trail, or an audit reader could activate the account.
    const audited = JSON.stringify(mockAudit.mock.calls[0][0]);
    expect(audited).not.toContain('ABCD-2345-EFGH');
  });

  test('a PIN session never reaches the gate', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(
      new Error('Forbidden: Microsoft-authenticated session required'),
    );

    const response = await POST(postRequest({ account_id: 'athlete-account-1' }));

    expect(response.status).toBe(403);
    expect(mockIssue).not.toHaveBeenCalled();
  });

  /**
   * Ordering note, pinned as a security property rather than as a status code.
   *
   * The account_id check runs BEFORE resolveTargetOrganization, so a caller of
   * any role who omits account_id currently gets 400 "Missing account_id"
   * rather than 403. That discloses nothing about the caller's role -- an
   * admin gets the same 400 -- and nothing is minted either way, which is what
   * this asserts. Deliberately not asserting the status, so moving the gate
   * ahead of the body validation would not red this case.
   */
  test('mints nothing when account_id is missing, whatever the role', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await POST(postRequest({ organization_id: OTHER_ORG }));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockIssue).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
