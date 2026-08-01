import { NextRequest, NextResponse } from 'next/server';

import { POST } from './route';
import { POST as postShadowChat } from '@/app/api/pilot/shadow/chat/route';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/app/api/pilot/shadow/chat/route', () => ({
  POST: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockPostShadowChat = postShadowChat as jest.MockedFunction<typeof postShadowChat>;

function principal(role: PilotPrincipal['role'] = 'organization_admin'): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-real',
    athleteId: role === 'athlete' ? 'ath-1' : null,
    sessionToken: 'token',
    authProvider: role === 'athlete' ? 'ppbf_local' : 'microsoft',
  };
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/board/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPostShadowChat.mockResolvedValue(NextResponse.json({
    success: true,
    state: 'ok',
    response: 'test response',
    messageId: 'message-1',
    createdAt: '2026-07-26T00:00:00.000Z',
    filtered: false,
    requiresHumanReview: false,
    evidenceTier: 'RESEARCH_NEEDED',
  }));
});

describe('POST /api/pilot/board/chat adapter', () => {
  // The organization-scope drop is a real defense and is unchanged: a
  // client-supplied organizationId must never reach the canonical route.
  //
  // The session-type expectation is corrected. This used to assert the adapter
  // forced 'board_summary', which is a background mode the canonical route
  // answers 503 to because no worker runs it -- so the endpoint failed for
  // every input, and overriding last also discarded the caller's own choice.
  test('drops client organization scope and keeps the caller session type', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(postRequest({
      message: 'hello',
      organizationId: 'org-attacker',
      sessionType: 'quick_round',
    }));

    expect(response.status).toBe(200);
    const forwarded = mockPostShadowChat.mock.calls[0][0];
    await expect(forwarded.json()).resolves.toEqual({
      message: 'hello',
      sessionType: 'quick_round',
    });
  });

  test('rejects a role that cannot use the board adapter', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await POST(postRequest({ message: 'hello' }));

    expect(response.status).toBe(403);
    expect(mockPostShadowChat).not.toHaveBeenCalled();
  });

  // The board role is refused by the route that carries its name, and that is
  // the contract rather than an oversight: SHADOW chat is free-form and cannot
  // be held to the k-anonymity floor the board role depends on. The refusal
  // must say so, because a bare "Forbidden" on a board-addressed URL reads as a
  // bug and invites someone to "fix" it by adding the role to the allow-list.
  test('refuses the board role and says why', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('board'));

    const response = await POST(postRequest({ message: 'hello' }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: expect.stringContaining('aggregate-only'),
    });
    expect(mockPostShadowChat).not.toHaveBeenCalled();
  });
});
