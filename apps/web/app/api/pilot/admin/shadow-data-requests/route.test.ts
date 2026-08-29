import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  completeShadowDataDeletionRequest,
  denyShadowDataDeletionRequest,
  listShadowDataDeletionRequests,
} from '@/src/server/pilot/shadowConversations';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import type { PilotRole } from '@/src/server/pilot/contracts';

/**
 * The queue route.
 *
 * requirePrincipal is faked and the shadowConversations functions are stubbed,
 * because what this file tests is the DECISION the route composes: who may
 * reach it, what it refuses to accept, what it records afterwards, and how it
 * answers a request a colleague already handled. The real access.ts and the
 * real http.ts are kept, so the 403 is the one a caller would receive.
 */
jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/shadowConversations', () => ({
  listShadowDataDeletionRequests: jest.fn(),
  completeShadowDataDeletionRequest: jest.fn(),
  denyShadowDataDeletionRequest: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockList = listShadowDataDeletionRequests as jest.Mock;
const mockComplete = completeShadowDataDeletionRequest as jest.Mock;
const mockDeny = denyShadowDataDeletionRequest as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

function principal(role: PilotRole): PilotPrincipal {
  return {
    accountId: 'admin-1',
    role,
    organizationId: 'org-a',
    athleteId: null,
    sessionToken: 'session-token',
    authProvider: 'ppbf_local',
    mustChangePin: false,
  };
}

function getRequest(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/pilot/admin/shadow-data-requests${query}`);
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/pilot/admin/shadow-data-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal('organization_admin'));
  mockList.mockResolvedValue([]);
});

describe('who may work the queue', () => {
  it.each(['organization_admin', 'admin'] as const)('admits %s', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));

    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    expect(mockList).toHaveBeenCalled();
  });

  it.each(['coach', 'parent', 'athlete', 'board'] as const)(
    'refuses %s before reading the queue',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue(principal(role));

      const response = await GET(getRequest());

      expect(response.status).toBe(403);
      expect(mockList).not.toHaveBeenCalled();
    },
  );

  it('refuses a coach acting on a request before the server function is reached', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));

    const response = await POST(postRequest({ request_id: 'req-1', action: 'complete' }));

    expect(response.status).toBe(403);
    expect(mockComplete).not.toHaveBeenCalled();
  });
});

describe('the status filter', () => {
  it('passes a recognised status through', async () => {
    await GET(getRequest('?status=pending'));

    expect(mockList).toHaveBeenCalledWith(expect.anything(), 'pending');
  });

  it('rejects an unrecognised one rather than widening the queue', async () => {
    // A typo'd filter that quietly listed everything is how an admin ends up
    // acting on a row they did not mean to see.
    const response = await GET(getRequest('?status=all'));

    expect(response.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('lists everything when no filter is given', async () => {
    await GET(getRequest());

    expect(mockList).toHaveBeenCalledWith(expect.anything(), undefined);
  });
});

describe('what the action has to carry', () => {
  it.each([
    ['no request_id', { action: 'complete' }],
    ['a blank request_id', { request_id: '  ', action: 'complete' }],
  ])('rejects %s', async (_label, body) => {
    const response = await POST(postRequest(body));

    expect(response.status).toBe(400);
    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockDeny).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing action', { request_id: 'req-1' }],
    ['an unknown action', { request_id: 'req-1', action: 'purge' }],
    ['a non-string action', { request_id: 'req-1', action: 3 }],
  ])('rejects %s rather than guessing which one was meant', async (_label, body) => {
    const response = await POST(postRequest(body));

    expect(response.status).toBe(400);
    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockDeny).not.toHaveBeenCalled();
  });
});

describe('completing a request', () => {
  it('reports what was cleared and records it', async () => {
    mockComplete.mockResolvedValue({
      requestId: 'req-1',
      status: 'completed',
      conversationsCleared: 3,
    });

    const response = await POST(postRequest({ request_id: 'req-1', action: 'complete' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      ok: true,
      requestId: 'req-1',
      status: 'completed',
      conversationsCleared: 3,
    });
    expect(mockComplete).toHaveBeenCalledWith(expect.anything(), 'req-1');
  });

  it('audits the COUNT and never the conversations', async () => {
    // An audit row listing which conversations were cleared would carry the
    // shape of a person's chat history into a table read by more people than
    // the chat ever was -- republishing what they asked to have removed. How
    // many is the fact an auditor needs; which ones is not.
    mockComplete.mockResolvedValue({
      requestId: 'req-1',
      status: 'completed',
      conversationsCleared: 3,
    });

    await POST(postRequest({ request_id: 'req-1', action: 'complete' }));

    expect(mockAudit).toHaveBeenCalledTimes(1);
    const event = mockAudit.mock.calls[0][0];
    expect(event.entity_type).toBe('shadow_data_deletion_request');
    expect(event.entity_id).toBe('req-1');
    expect(event.details).toEqual({ action: 'complete', conversations_cleared: 3 });
    expect(event.shadow_mirror).toBe(false);
    expect(['create', 'update', 'delete']).toContain(event.event_type);
    expect(JSON.stringify(event)).not.toMatch(/conversation_id/i);
  });

  it('answers 409 for a request a colleague already handled, and audits nothing', async () => {
    // The three cases behind this error -- no such request, another
    // organization's, and one already handled -- get the same answer. Telling
    // them apart would leak the existence of rows outside this organization,
    // and the useful instruction is identical either way.
    mockComplete.mockRejectedValue(new Error('SHADOW_DELETION_REQUEST_NOT_ACTIONABLE'));

    const response = await POST(postRequest({ request_id: 'req-1', action: 'complete' }));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toContain('no longer open');
    // An audit row for an action that did not happen is a trail that cannot
    // be read.
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('denying a request', () => {
  it('records the denial with zero cleared', async () => {
    mockDeny.mockResolvedValue({ requestId: 'req-1', status: 'denied', conversationsCleared: 0 });

    const response = await POST(postRequest({ request_id: 'req-1', action: 'deny' }));

    expect(response.status).toBe(200);
    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockAudit.mock.calls[0][0].details)
      .toEqual({ action: 'deny', conversations_cleared: 0 });
  });
});
