import {
  buildShadowChatRequest,
  listOwnedShadowSessions,
  loadOwnedShadowSessionMessages,
  mapStoredShadowMessage,
  ShadowSessionsRequestError,
} from './shadowSessions';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('SHADOW session client', () => {
  test('preserves the restored athlete subject on every conversation follow-up request', () => {
    expect(buildShadowChatRequest({
      message: 'How should we adjust the next round?',
      heavyBagMode: false,
      conversationId: '8d697e85-dde4-47ac-b03f-e6c74595a3bc',
      athleteId: 'athlete-42',
    })).toEqual({
      message: 'How should we adjust the next round?',
      tier: undefined,
      conversationId: '8d697e85-dde4-47ac-b03f-e6c74595a3bc',
      athleteId: 'athlete-42',
    });
  });

  test('lists only typed server sessions using credentialed requests', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({
      success: true,
      conversations: [{
        conversationId: '8d697e85-dde4-47ac-b03f-e6c74595a3bc',
        title: 'Footwork review',
        athleteId: null,
        sessionType: 'quick_round',
        createdAt: '2026-07-24T12:00:00.000Z',
        updatedAt: '2026-07-24T12:02:00.000Z',
      }],
    }));

    await expect(listOwnedShadowSessions('https://example.test/', undefined, fetchImpl))
      .resolves.toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.test/api/pilot/shadow/sessions?limit=50',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  test('restores messages and URL-encodes the server-owned conversation id', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({
      success: true,
      messages: [{
        messageId: '09475aaf-e9d6-43c8-af6f-10181f2917ab',
        role: 'assistant',
        content: 'Use only the evidence currently available.',
        responseState: 'ok',
        createdAt: '2026-07-24T12:00:01.000Z',
      }],
    }));

    const messages = await loadOwnedShadowSessionMessages(
      '',
      'conversation with spaces',
      undefined,
      fetchImpl,
    );

    expect(messages).toHaveLength(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      '/api/pilot/shadow/sessions/conversation%20with%20spaces?limit=50',
    );
  });

  test('rejects malformed server payloads instead of rendering them', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({
      success: true,
      conversations: [{
        conversationId: '',
        title: 'Invalid',
        athleteId: null,
        sessionType: 'quick_round',
        createdAt: 'not-a-date',
        updatedAt: 'not-a-date',
      }],
    }));

    await expect(listOwnedShadowSessions('', undefined, fetchImpl))
      .rejects.toBeInstanceOf(ShadowSessionsRequestError);
  });

  test('preserves authorization status without exposing response bodies', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({
      error: 'sensitive server detail',
    }, 403));

    await expect(listOwnedShadowSessions('', undefined, fetchImpl))
      .rejects.toMatchObject({
        status: 403,
        message: 'SHADOW could not load your saved sessions.',
      });
  });

  test('makes only durable assistant messages eligible for feedback', () => {
    expect(mapStoredShadowMessage({
      messageId: 'assistant-message',
      role: 'assistant',
      content: 'Bounded answer',
      responseState: 'filtered',
      createdAt: '2026-07-24T12:00:00.000Z',
    })).toMatchObject({
      id: 'assistant-message',
      type: 'shadow',
      state: 'filtered',
      feedbackEligible: true,
    });

    expect(mapStoredShadowMessage({
      messageId: 'user-message',
      role: 'user',
      content: 'Question',
      responseState: null,
      createdAt: '2026-07-24T12:00:00.000Z',
    })).toMatchObject({
      type: 'user',
      feedbackEligible: false,
    });
  });
});
