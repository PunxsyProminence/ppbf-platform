import { NextRequest } from 'next/server';

import { GET, PATCH } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { query, queryOne } from '@/src/server/pilot/db';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('@/src/server/pilot/shadowReadiness', () => ({ assertShadowRuntimeReadiness: jest.fn() }));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockQuery = query as jest.MockedFunction<typeof query>;
const mockQueryOne = queryOne as jest.MockedFunction<typeof queryOne>;
const mockAudit = writePilotAuditEvent as jest.MockedFunction<typeof writePilotAuditEvent>;

const FLAG_ID = '3f0f7b9e-2b1a-4c6d-9e8f-1a2b3c4d5e6f';

function principal(role: PilotPrincipal['role'] = 'organization_admin'): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-real',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

function getRequest(search = '') {
  return new NextRequest(`http://localhost/api/pilot/shadow/library/review-flags${search}`, { method: 'GET' });
}

function patchRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/shadow/library/review-flags', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const verdict = { flag_id: FLAG_ID, review_state: 'resolved' };

/** The organization the UPDATE was bound to: its first parameter. */
function updatedOrganization(): unknown {
  const call = mockQueryOne.mock.calls.find(([sql]) => String(sql).includes('UPDATE pilot.shadow_library_review_flags'));
  return call?.[1]?.[0];
}

function listedOrganization(): unknown {
  const call = mockQuery.mock.calls.find(([sql]) => String(sql).includes('FROM pilot.shadow_library_review_flags'));
  return call?.[1]?.[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue([] as never);
  mockQueryOne.mockResolvedValue({ flag_id: FLAG_ID, topic: 'guard-position' } as never);
  mockAudit.mockResolvedValue(undefined as never);
});

describe('roles', () => {
  test('rejects an unauthenticated caller', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));

    expect((await PATCH(patchRequest(verdict))).status).toBe(401);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test.each(['coach', 'athlete', 'parent'] as const)('refuses %s on both methods', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));

    expect((await GET(getRequest())).status).toBe(403);
    expect((await PATCH(patchRequest(verdict))).status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockQueryOne).not.toHaveBeenCalled();
  });
});

describe('PATCH records a verdict against the session organization', () => {
  test('a gym admin resolves a pending flag of its own organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const response = await PATCH(patchRequest({ ...verdict, organization_id: 'org-attacker' }));

    expect(response.status).toBe(200);
    expect(updatedOrganization()).toBe('org-real');
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ organization_id: 'org-real', entity_id: FLAG_ID }));
  });

  test('a flag that is not pending, or not this organization\'s, is not found', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne.mockResolvedValueOnce(null as never);

    const response = await PATCH(patchRequest(verdict));

    expect(response.status).toBe(404);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

// OD-2026-10-02-013 answer 1B and OD-2026-10-02-015 D3, through
// libraryShelf.ts: a verdict on a review flag is a Library write, so the
// platform owner records one on the platform shelf and no longer on a gym's.
// Listing is a read and is unchanged.
describe('the shelf (OD-2026-10-02-015 D3)', () => {
  test('refuses platform_owner a gym-shelf verdict, with or without naming the shelf', async () => {
    for (const body of [verdict, { ...verdict, shelf: 'gym' }]) {
      mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));
      expect((await PATCH(patchRequest(body))).status).toBe(403);
    }
    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('platform_owner records a verdict on the platform shelf, not its own organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    const response = await PATCH(patchRequest({ ...verdict, shelf: 'platform', organization_id: 'org-attacker' }));

    expect(response.status).toBe(200);
    expect(updatedOrganization()).toBe('__platform__');
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ organization_id: '__platform__' }));
  });

  test.each(['organization_admin', 'admin'] as const)('%s gets 403 for shelf: platform on both methods', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));

    expect((await PATCH(patchRequest({ ...verdict, shelf: 'platform' }))).status).toBe(403);
    expect((await GET(getRequest('?shelf=platform'))).status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('platform_owner lists the platform shelf when it names it', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    expect((await GET(getRequest('?shelf=platform'))).status).toBe(200);
    expect(listedOrganization()).toBe('__platform__');
  });

  // D3 bars the platform owner's gym-shelf WRITES only; reading is unchanged.
  test('platform_owner still lists its gym shelf when no shelf is named', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    expect((await GET(getRequest())).status).toBe(200);
    expect(listedOrganization()).toBe('org-real');
  });
});
