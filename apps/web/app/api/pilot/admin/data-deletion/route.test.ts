import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import { DELETE } from './route';
import { BUILDING } from '@/components/buildingMap';
import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import { deleteAthleteRecord, deleteGuardianAccount } from '@/src/server/pilot/dataDeletion';
import { ConflictError } from '@/src/server/pilot/errors';
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

// Owner decision 2026-09-29 ("1A"): the service refuses a person already
// deleted with a ConflictError and writes nothing; the route answers 409 with
// the service's own sentence so the screen can show it.
describe('DELETE /api/pilot/admin/data-deletion refuses a person already deleted', () => {
  test.each([
    ['athlete', mockDeleteAthlete, 'This athlete was already deleted on September 1, 2026. Nothing was changed.'],
    ['guardian', mockDeleteGuardian, 'This guardian was already deleted on September 1, 2026. Nothing was changed.'],
  ] as const)('an already-deleted %s is answered 409 with the date, not a 500', async (entityType, mock, message) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mock.mockRejectedValueOnce(new ConflictError(message, 'ALREADY_DELETED'));

    const res = await del({ entityType, entityId: 'x-1', reason: 'again' });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe(message);
    expect(body.code).toBe('ALREADY_DELETED');
  });

  test('a plain Error that merely mentions "already deleted" is not promoted to a disclosed 409', async () => {
    // The mapping is by type. A driver or SQL error is still redacted.
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockDeleteAthlete.mockRejectedValueOnce(new Error('row already deleted by concurrent update (login_email)=(parent@example.com)'));

    const res = await del({ entityType: 'athlete', entityId: 'ath-1' });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('parent@example.com');
  });
});

// Organization isolation, a hard requirement for minors' records. The route
// builds the actor from the session principal only; an organization in the
// body -- under either spelling -- must never reach the service. Dropping that
// would let one gym's admin address another gym's athlete by naming its org.
describe('DELETE /api/pilot/admin/data-deletion takes the organization from the session, never the body', () => {
  const forged = { organizationId: 'org-2', organization_id: 'org-2' };
  const sessionActor = { accountId: 'admin-1', role: 'organization_admin', organizationId: 'org-1' };

  test.each([
    ['athlete', mockDeleteAthlete, mockDeleteGuardian],
    ['guardian', mockDeleteGuardian, mockDeleteAthlete],
  ] as const)('%s: a deletion naming another organization is run against the admin\'s own', async (entityType, called, notCalled) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    called.mockResolvedValueOnce({
      deletedEntityType: entityType,
      deletedEntityId: 'x-1',
      deletedRecordsCounts: {},
      deletedAt: '2026-09-29T16:00:00.000Z',
      auditEventId: 1,
    });

    const res = await del({ entityType, entityId: 'x-1', reason: 'r', ...forged });

    expect(res.status).toBe(200);
    expect(called).toHaveBeenCalledTimes(1);
    expect(called).toHaveBeenCalledWith(sessionActor, 'x-1', 'r');
    expect(JSON.stringify(called.mock.calls)).not.toContain('org-2');
    expect(notCalled).not.toHaveBeenCalled();
  });
});

describe('the door in front of this route', () => {
  const DOOR = '/admin/data-deletion';

  test('advertises only roles the API admits, and never the platform owner', () => {
    /* Runs the route's own gate (isOrganizationAdminRole) for every role the
       door names, rather than comparing two literals. Swapping the door's
       roles for ADMIN_GATE, which carries platform_owner, turns this red. */
    const door = BUILDING.find((entry) => entry.href === DOOR);
    expect(door).toBeDefined();
    expect(door?.roles).not.toBe('open');

    const advertised = door?.roles as readonly string[];
    expect(advertised.length).toBeGreaterThan(0);
    expect(advertised).not.toContain('platform_owner');
    for (const role of advertised) {
      expect(isOrganizationAdminRole(role as PilotPrincipal['role'])).toBe(true);
    }
  });

  test('and the page behind it gates on exactly the roles the door advertises', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../../../../admin/data-deletion/page.tsx'),
      'utf8',
    );
    const gate = /<RoleSessionGate allowedRoles=\{\[([^\]]*)\]\}>/.exec(source);
    expect(gate).not.toBeNull();

    const guarded = (gate?.[1] ?? '')
      .split(',')
      .map((entry) => entry.trim().replace(/^'|'$/g, ''))
      .filter((entry) => entry.length > 0);

    const door = BUILDING.find((entry) => entry.href === DOOR);
    expect([...guarded].sort()).toEqual([...(door?.roles as readonly string[])].sort());
  });

  test('the platform owner is refused by the route itself, whatever the door says', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'platform_owner' }));

    const res = await del({ entityType: 'athlete', entityId: 'ath-1' });

    expect(res.status).toBe(403);
    expect(mockDeleteAthlete).not.toHaveBeenCalled();
    expect(mockDeleteGuardian).not.toHaveBeenCalled();
  });
});
