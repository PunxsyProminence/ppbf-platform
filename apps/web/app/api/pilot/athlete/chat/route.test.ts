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

function principal(role: PilotPrincipal['role'] = 'athlete'): PilotPrincipal {
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
  return new NextRequest('http://localhost/api/pilot/athlete/chat', {
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

describe('POST /api/pilot/athlete/chat adapter', () => {
  test('drops client organization scope and injects the authenticated athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(postRequest({
      message: 'hello',
      organizationId: 'org-attacker',
      athleteId: 'ath-attacker',
    }));

    expect(response.status).toBe(200);
    expect(mockPostShadowChat).toHaveBeenCalledTimes(1);
    const forwarded = mockPostShadowChat.mock.calls[0][0];
    await expect(forwarded.json()).resolves.toEqual({
      message: 'hello',
      athleteId: 'ath-1',
    });
  });

  test('rejects a role that cannot use the athlete adapter', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await POST(postRequest({ message: 'hello' }));

    expect(response.status).toBe(403);
    expect(mockPostShadowChat).not.toHaveBeenCalled();
  });
});
