import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { resolveConversation } from '@/src/server/pilot/shadowConversations';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/access', () => ({
  assertActorCanAccessAthlete: jest.fn(),
}));
jest.mock('@/src/server/pilot/shadowChatCapabilities', () => ({
  canUseShadowSessionType: jest.fn(() => true),
}));
jest.mock('@/src/server/pilot/shadowConversations', () => ({
  listConversations: jest.fn(),
  resolveConversation: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockResolveConversation = jest.mocked(resolveConversation);

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue({
    accountId: 'account-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
  });
});

test('hides a malformed conversation UUID before it reaches PostgreSQL', async () => {
  const response = await POST(new NextRequest(
    'http://localhost/api/pilot/shadow/sessions',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'not-a-uuid',
        sessionType: 'quick_round',
        firstMessage: 'Hello',
      }),
    },
  ));

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'Not found' });
  expect(mockResolveConversation).not.toHaveBeenCalled();
});
