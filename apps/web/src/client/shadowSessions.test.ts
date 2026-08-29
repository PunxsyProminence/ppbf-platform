import {
  buildShadowChatRequest,
  deleteOwnedShadowSession,
  fetchOwnShadowDataExport,
  listOwnedShadowSessions,
  loadOwnedShadowSessionMessages,
  mapStoredShadowMessage,
  normalizeShadowSessionTitle,
  renameOwnedShadowSession,
  RESTORED_MESSAGE_FALLBACK_TIER,
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

  test('preferAsync rides the wire only as an explicit true', () => {
    const base = { message: 'q', heavyBagMode: true };
    expect(buildShadowChatRequest({ ...base, preferAsync: true }).preferAsync).toBe(true);
    // Omitted or false stays off the wire entirely (undefined is dropped by
    // JSON.stringify), so older servers that reject unknown values never see it.
    expect(buildShadowChatRequest(base).preferAsync).toBeUndefined();
    expect(buildShadowChatRequest({ ...base, preferAsync: false }).preferAsync).toBeUndefined();
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

  test('replays the stored evidence grade and handoff instead of a default', () => {
    expect(mapStoredShadowMessage({
      messageId: 'graded-message',
      role: 'assistant',
      content: 'Bounded answer',
      responseState: 'ok',
      evidenceTier: 'RESEARCH_NEEDED',
      handoff: 'Talk to your medical team before changing any weight-cut plan.',
      createdAt: '2026-07-24T12:00:00.000Z',
      citations: [],
    })).toMatchObject({
      evidenceTier: 'RESEARCH_NEEDED',
      handoff: 'Talk to your medical team before changing any weight-cut plan.',
    });
  });

  test('an ungraded assistant message restores at the flattest tier, never a better one', () => {
    // Rows written before evidence_tier existed have no grade to recover. The
    // renderer used to default these to EMERGING -- the second darkest, meaning
    // well-evidenced -- which silently promoted an unevidenced answer.
    const restored = mapStoredShadowMessage({
      messageId: 'ungraded-message',
      role: 'assistant',
      content: 'Legacy answer with no stored grade',
      responseState: 'ok',
      evidenceTier: null,
      handoff: null,
      createdAt: '2026-07-24T12:00:00.000Z',
      citations: [],
    });
    expect(restored.evidenceTier).toBe(RESTORED_MESSAGE_FALLBACK_TIER);
    expect(restored.evidenceTier).toBe('RESEARCH_NEEDED');
    expect(restored.evidenceTier).not.toBe('EMERGING');
    expect(restored.handoff).toBeUndefined();
  });

  test('makes only durable assistant messages eligible for feedback', () => {
    expect(mapStoredShadowMessage({
      messageId: 'assistant-message',
      role: 'assistant',
      content: 'Bounded answer',
      responseState: 'filtered',
      evidenceTier: 'EXPERIMENTAL',
      handoff: null,
      createdAt: '2026-07-24T12:00:00.000Z',
      citations: [],
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
      evidenceTier: null,
      handoff: null,
      createdAt: '2026-07-24T12:00:00.000Z',
      citations: [],
    })).toMatchObject({
      type: 'user',
      feedbackEligible: false,
    });
  });
});

describe('restored citations', () => {
  const base = {
    messageId: 'cited-message',
    role: 'assistant' as const,
    content: 'Answer with receipts',
    responseState: 'ok' as const,
    evidenceTier: 'EMERGING' as const,
    handoff: null,
    createdAt: '2026-07-24T12:00:00.000Z',
  };
  const citation = {
    evidenceId: 'ev-1',
    token: '[E:ev-1]',
    sourceTitle: 'SHADOW Canonical Authority Model',
    documentName: 'Authority Model',
  };

  test('replays stored citations so a reopened answer keeps its receipts', () => {
    const restored = mapStoredShadowMessage({ ...base, citations: [citation] });
    expect(restored.citations).toEqual([citation]);
  });

  test('an answer stored without citations restores with none, not an empty block', () => {
    const restored = mapStoredShadowMessage({ ...base, citations: [] });
    expect(restored.citations).toBeUndefined();
  });

  test('a user turn never carries citations, even if a malformed row had them', () => {
    const restored = mapStoredShadowMessage({
      ...base,
      role: 'user',
      responseState: null,
      evidenceTier: null,
      citations: [citation],
    });
    expect(restored.citations).toBeUndefined();
  });
});

describe('session rename and delete', () => {
  const CONVERSATION_ID = '8d697e85-dde4-47ac-b03f-e6c74595a3bc';

  test('rename PATCHes the normalized title with credentials and returns it', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ success: true }));

    // The client normalizes exactly like the server (collapse whitespace,
    // trim, cap 120) so the optimistic title matches what was stored.
    await expect(renameOwnedShadowSession(
      'https://example.test/',
      CONVERSATION_ID,
      '  Corner   notes \n week 3  ',
      fetchImpl,
    )).resolves.toBe('Corner notes week 3');

    expect(fetchImpl).toHaveBeenCalledWith(
      `https://example.test/api/pilot/shadow/sessions/${CONVERSATION_ID}`,
      expect.objectContaining({
        method: 'PATCH',
        credentials: 'include',
        body: JSON.stringify({ title: 'Corner notes week 3' }),
      }),
    );
  });

  test('a whitespace-only title is refused before any request is sent', async () => {
    const fetchImpl = jest.fn();

    await expect(renameOwnedShadowSession('', CONVERSATION_ID, '   ', fetchImpl))
      .rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('normalizeShadowSessionTitle caps at the server limit of 120', () => {
    expect(normalizeShadowSessionTitle(`${'x'.repeat(200)}`)).toHaveLength(120);
  });

  test('delete sends a credentialed DELETE for the session', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ success: true }));

    await expect(deleteOwnedShadowSession('https://example.test/', CONVERSATION_ID, fetchImpl))
      .resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledWith(
      `https://example.test/api/pilot/shadow/sessions/${CONVERSATION_ID}`,
      expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
    );
  });

  test.each([
    ['rename', () => renameOwnedShadowSession('', CONVERSATION_ID, 'New name', jest.fn().mockResolvedValue(jsonResponse({ error: 'Not found' }, 404)))],
    ['delete', () => deleteOwnedShadowSession('', CONVERSATION_ID, jest.fn().mockResolvedValue(jsonResponse({ error: 'Not found' }, 404)))],
  ])('%s surfaces a 404 so the page can drop the dead session', async (_label, run) => {
    await expect(run()).rejects.toMatchObject({ status: 404 });
  });

  test.each([
    ['rename', () => renameOwnedShadowSession('', CONVERSATION_ID, 'New name', jest.fn().mockResolvedValue(jsonResponse({ ok: 1 })))],
    ['delete', () => deleteOwnedShadowSession('', CONVERSATION_ID, jest.fn().mockResolvedValue(jsonResponse({ ok: 1 })))],
  ])('a malformed %s response is an error, not a silent success', async (_label, run) => {
    await expect(run()).rejects.toBeInstanceOf(ShadowSessionsRequestError);
  });
});

describe('the self-service export', () => {
  const COMPLETE = {
    exportedAt: '2026-08-28T12:00:00.000Z',
    exportScope: 'conversation_history_only',
    completeAccountExport: false,
    conversationLimit: 100,
    conversationsStored: 4,
    conversationsIncluded: 4,
    sessions: [],
    messages: [],
    corrections: [],
  };

  test('asks for the caller\'s own data with credentials and reads the counts back', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ success: true, data: COMPLETE }));

    const result = await fetchOwnShadowDataExport('https://example.test/', undefined, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.test/api/pilot/shadow/data',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
    expect(result.conversationsIncluded).toBe(4);
    expect(result.conversationsStored).toBe(4);
    expect(result.conversationLimit).toBe(100);
    // The raw payload is passed through unread -- it is what gets written to
    // the file, and re-shaping it here would hand somebody a version of their
    // history that this module invented.
    expect(result.payload).toEqual(COMPLETE);
  });

  test.each([
    ['conversationLimit', 'conversation limit'],
    ['conversationsStored', 'stored conversation count'],
    ['conversationsIncluded', 'included conversation count'],
  ])('an export missing %s is an error, never a zero', async (field, label) => {
    // Reading an absent count as 0 would render "0 of 0 conversations" over a
    // file full of them -- a false reassurance in one direction or a false
    // alarm in the other, depending which count went missing.
    const data: Record<string, unknown> = { ...COMPLETE };
    delete data[field];
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ success: true, data }));

    await expect(fetchOwnShadowDataExport('', undefined, fetchImpl))
      .rejects.toThrow(new RegExp(label));
  });

  test('treats a missing completeAccountExport as NOT complete', async () => {
    // The safe reading of a server that did not say whether this is everything
    // is that it is not.
    const data: Record<string, unknown> = { ...COMPLETE };
    delete data.completeAccountExport;
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ success: true, data }));

    const result = await fetchOwnShadowDataExport('', undefined, fetchImpl);

    expect(result.completeAccountExport).toBe(false);
  });

  test('a refusal is surfaced with its status rather than an empty file', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ error: 'Forbidden' }, 403));

    await expect(fetchOwnShadowDataExport('', undefined, fetchImpl))
      .rejects.toMatchObject({ status: 403 });
  });

  test('a success flag with no data is malformed, not an empty history', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ success: true }));

    await expect(fetchOwnShadowDataExport('', undefined, fetchImpl))
      .rejects.toBeInstanceOf(ShadowSessionsRequestError);
  });
});
