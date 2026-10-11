import { NextRequest } from 'next/server';

import { POST } from './route';
import { requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';
import { repairStrandedGuardianAuthProvider } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requireMicrosoftAuthenticatedPrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/auth', () => ({
  repairStrandedGuardianAuthProvider: jest.fn(),
}));
jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

const mockPrincipal = jest.mocked(requireMicrosoftAuthenticatedPrincipal);
const mockRepair = jest.mocked(repairStrandedGuardianAuthProvider);
const mockAudit = jest.mocked(writePilotAuditEvent);

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/pilot/admin/accounts/repair-auth-provider', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockPrincipal.mockResolvedValue({
    accountId: 'admin-1',
    organizationId: 'org-1',
    role: 'organization_admin',
  } as never);
  mockRepair.mockResolvedValue({
    account_id: 'acct-stranded',
    role: 'parent',
    login_email: 'guardian@example.org',
  } as never);
  mockAudit.mockResolvedValue(undefined as never);
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/pilot/admin/accounts/repair-auth-provider', () => {
  test('repairs a stranded account and writes the audit row', async () => {
    const response = await POST(makeRequest({ account_id: 'acct-stranded' }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      ok: true,
      account_id: 'acct-stranded',
      role: 'parent',
      auth_provider: 'microsoft',
    });
    expect(mockRepair).toHaveBeenCalledWith('acct-stranded', 'org-1');
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][0]).toMatchObject({
      entity_id: 'acct-stranded',
      details: expect.objectContaining({ action: 'auth_provider_repair' }),
    });
  });

  test('refuses roles below organization admin', async () => {
    mockPrincipal.mockResolvedValue({
      accountId: 'coach-1',
      organizationId: 'org-1',
      role: 'coach',
    } as never);
    const response = await POST(makeRequest({ account_id: 'acct-stranded' }));
    expect(response.status).toBe(403);
    expect(mockRepair).not.toHaveBeenCalled();
  });

  // The repair reaches only accounts of the caller's own gym, so it is gym
  // work: the platform owner is refused before anything is changed or audited
  // (OD-2026-10-10-004 ruling 3).
  test.each([
    ['naming an account', { account_id: 'acct-stranded' }],
    ['with no account named', {}],
  ])('refuses the platform owner %s, and repairs nothing', async (_label, body) => {
    mockPrincipal.mockResolvedValue({
      accountId: 'owner-1',
      organizationId: 'org-1',
      role: 'platform_owner',
    } as never);
    const response = await POST(makeRequest(body));
    expect(response.status).toBe(403);
    expect(mockRepair).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('the legacy admin role still repairs, filed under its own gym', async () => {
    mockPrincipal.mockResolvedValue({
      accountId: 'admin-2',
      organizationId: 'org-1',
      role: 'admin',
    } as never);
    const response = await POST(makeRequest({ account_id: 'acct-stranded' }));
    expect(response.status).toBe(200);
    expect(mockRepair).toHaveBeenCalledWith('acct-stranded', 'org-1');
    expect(mockAudit.mock.calls[0][0]).toMatchObject({
      actor_role: 'admin',
      organization_id: 'org-1',
      entity_id: 'acct-stranded',
    });
  });

  test('requires account_id', async () => {
    const response = await POST(makeRequest({}));
    expect(response.status).toBe(400);
    expect(mockRepair).not.toHaveBeenCalled();
  });

  test('an ineligible account surfaces the helper refusal as 404, unaudited', async () => {
    mockRepair.mockRejectedValue(new Error('Not found: no active, stranded (ppbf_local) non-athlete account with a login email matches that account_id in this organization'));
    const response = await POST(makeRequest({ account_id: 'acct-athlete' }));
    expect(response.status).toBe(404);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
