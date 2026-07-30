import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { listConversations, resolveConversation } from '@/src/server/pilot/shadowConversations';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});
jest.mock('@/src/server/pilot/shadowChatCapabilities', () => ({
  canUseShadowSessionType: jest.fn(() => true),
}));
jest.mock('@/src/server/pilot/shadowConversations', () => ({
  listConversations: jest.fn(),
  resolveConversation: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockListConversations = jest.mocked(listConversations);
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

test('lists only the authenticated owner sessions with a bounded limit', async () => {
  mockListConversations.mockResolvedValueOnce([{
    conversationId: '8d697e85-dde4-47ac-b03f-e6c74595a3bc',
    title: 'Footwork review',
    athleteId: null,
    sessionType: 'quick_round',
    createdAt: '2026-07-24T12:00:00.000Z',
    updatedAt: '2026-07-24T12:02:00.000Z',
  }]);

  const response = await GET(new NextRequest(
    'http://localhost/api/pilot/shadow/sessions?limit=25',
  ));

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    success: true,
    conversations: [{ title: 'Footwork review' }],
  });
  expect(mockListConversations).toHaveBeenCalledWith(
    expect.objectContaining({
      accountId: 'account-1',
      organizationId: 'org-1',
    }),
    25,
  );
});

test('rejects an invalid list limit before querying session history', async () => {
  const response = await GET(new NextRequest(
    'http://localhost/api/pilot/shadow/sessions?limit=all',
  ));

  expect(response.status).toBe(400);
  expect(mockListConversations).not.toHaveBeenCalled();
});

test('denies a Board user access to saved sessions from a prior role', async () => {
  mockRequirePrincipal.mockResolvedValueOnce({
    accountId: 'account-1',
    role: 'board',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
  });

  const response = await GET(new NextRequest(
    'http://localhost/api/pilot/shadow/sessions',
  ));

  expect(response.status).toBe(403);
  expect(mockListConversations).not.toHaveBeenCalled();
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
