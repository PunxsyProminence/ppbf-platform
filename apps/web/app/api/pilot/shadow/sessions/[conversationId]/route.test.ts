import { NextRequest } from 'next/server';

import { DELETE, GET, PATCH } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  loadConversationMessages,
  renameConversation,
  softDeleteConversation,
} from '@/src/server/pilot/shadowConversations';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/shadowConversations', () => ({
  loadConversationMessages: jest.fn(),
  renameConversation: jest.fn(),
  softDeleteConversation: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockLoadConversationMessages = jest.mocked(loadConversationMessages);
const mockRenameConversation = jest.mocked(renameConversation);
const mockSoftDeleteConversation = jest.mocked(softDeleteConversation);
const conversationId = '8d697e85-dde4-47ac-b03f-e6c74595a3bc';

beforeEach(() => {
  jest.resetAllMocks();
  mockRequirePrincipal.mockResolvedValue({
    accountId: 'account-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
  });
});

test('restores the authenticated owner messages in server order', async () => {
  mockLoadConversationMessages.mockResolvedValueOnce([{
    messageId: '09475aaf-e9d6-43c8-af6f-10181f2917ab',
    role: 'assistant',
    content: 'Use the evidence currently available.',
    responseState: 'ok',
    evidenceTier: 'PROVEN',
    handoff: null,
    createdAt: '2026-07-24T12:00:01.000Z',
  }]);

  const response = await GET(
    new NextRequest(
      `http://localhost/api/pilot/shadow/sessions/${conversationId}?limit=50`,
    ),
    { params: Promise.resolve({ conversationId }) },
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    success: true,
    messages: [{ role: 'assistant', responseState: 'ok' }],
  });
  expect(mockLoadConversationMessages).toHaveBeenCalledWith({
    actor: expect.objectContaining({
      accountId: 'account-1',
      organizationId: 'org-1',
    }),
    conversationId,
    limit: 50,
  });
});

test('uses a hidden not-found response when ownership or subject access is gone', async () => {
  mockLoadConversationMessages.mockRejectedValueOnce(
    new Error('SHADOW_CONVERSATION_NOT_FOUND'),
  );

  const response = await GET(
    new NextRequest(
      `http://localhost/api/pilot/shadow/sessions/${conversationId}`,
    ),
    { params: Promise.resolve({ conversationId }) },
  );

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'Not found' });
});

test('denies a Board user read, rename, and delete access to a saved chat from a prior role', async () => {
  mockRequirePrincipal.mockResolvedValue({
    accountId: 'account-1',
    role: 'board',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
  });
  const routeContext = { params: Promise.resolve({ conversationId }) };

  const readResponse = await GET(
    new NextRequest(`http://localhost/api/pilot/shadow/sessions/${conversationId}`),
    routeContext,
  );
  const renameResponse = await PATCH(
    new NextRequest(
      `http://localhost/api/pilot/shadow/sessions/${conversationId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Still private' }),
      },
    ),
    routeContext,
  );
  const deleteResponse = await DELETE(
    new NextRequest(
      `http://localhost/api/pilot/shadow/sessions/${conversationId}`,
      { method: 'DELETE' },
    ),
    routeContext,
  );

  expect([
    readResponse.status,
    renameResponse.status,
    deleteResponse.status,
  ]).toEqual([403, 403, 403]);
  expect(mockLoadConversationMessages).not.toHaveBeenCalled();
  expect(mockRenameConversation).not.toHaveBeenCalled();
  expect(mockSoftDeleteConversation).not.toHaveBeenCalled();
});
