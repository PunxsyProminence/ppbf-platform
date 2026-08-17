import { NextRequest } from 'next/server';

import { DELETE } from './route';
import { deleteAthleteRecord, deleteGuardianAccount } from '@/src/server/pilot/dataDeletion';
import { requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requireMicrosoftAuthenticatedPrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/dataDeletion', () => ({
  deleteAthleteRecord: jest.fn(),
  deleteGuardianAccount: jest.fn(),
}));

const mockRequirePrincipal = requireMicrosoftAuthenticatedPrincipal as jest.Mock;
const mockDeleteAthlete = deleteAthleteRecord as jest.Mock;
const mockDeleteGuardian = deleteGuardianAccount as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'admin-1',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  };
}

function del(body: Record<string, unknown>) {
  return DELETE(new NextRequest('http://localhost/api/pilot/admin/data-deletion', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

// Every jsonError() call in this route used to pass a plain string. jsonError
// dispatches on TYPE (Error vs. anything else) -- a string always fails
// `instanceof Error`, so the real message was replaced by the hardcoded
// 'Unknown server error' before the caller ever saw it, even though the
// intended status code (403/400) still came through correctly. These tests
// pin that the ACTUAL message survives, not just the status.
describe('DELETE /api/pilot/admin/data-deletion error messages', () => {
  test('a non-admin role gets its real message back, not "Unknown server error"', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));

    const res = await del({ entityType: 'athlete', entityId: 'ath-1' });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe('Forbidden: role not allowed');
    expect(body.error).not.toBe('Unknown server error');
  });

  test('a missing field gets its real message back, not "Unknown server error"', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));

    const res = await del({ entityType: 'athlete' });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('Missing entityType or entityId');
    expect(body.error).not.toBe('Unknown server error');
  });

  test('an invalid entityType gets its real message back, not "Unknown server error"', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));

    const res = await del({ entityType: 'coach', entityId: 'x' });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('entityType must be "athlete" or "guardian"');
  });

  test('a Forbidden thrown by the service layer surfaces its real message at 403', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockDeleteAthlete.mockRejectedValueOnce(new Error('Forbidden: athlete belongs to another organization'));

    const res = await del({ entityType: 'athlete', entityId: 'ath-1' });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe('Forbidden: athlete belongs to another organization');
  });

  test('a Not found thrown by the service layer surfaces its real message at 404', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockDeleteGuardian.mockRejectedValueOnce(new Error('Not found: guardian account does not exist'));

    const res = await del({ entityType: 'guardian', entityId: 'acct-1' });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe('Not found: guardian account does not exist');
  });

  // The genuinely-unexpected-failure path: this is a right-to-be-forgotten
  // route deleting PII for a minor/guardian, so a raw DB error must still be
  // redacted to a generic message, never echoed to the client.
  test('an unexpected failure is redacted to a generic 500', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockDeleteAthlete.mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint "pilot_accounts_login_email_key" (login_email)=(parent@example.com)'),
    );

    const res = await del({ entityType: 'athlete', entityId: 'ath-1' });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('parent@example.com');
  });

  test('a successful deletion still returns 200 with the result', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockDeleteAthlete.mockResolvedValueOnce({
      deletedEntityType: 'athlete',
      deletedEntityId: 'ath-1',
      deletedRecordsCounts: {},
      deletedAt: '2026-08-17T00:00:00.000Z',
      auditEventId: 1,
    });

    const res = await del({ entityType: 'athlete', entityId: 'ath-1' });

    expect(res.status).toBe(200);
    expect(mockDeleteAthlete).toHaveBeenCalledWith(
      { accountId: 'admin-1', role: 'organization_admin', organizationId: 'org-1' },
      'ath-1',
      undefined,
    );
  });
});
