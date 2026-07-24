import { query, withTransaction } from './db';
import {
  appendConversationExchange,
  loadConversationMessages,
  listConversations,
  purgeExpiredShadowChatData,
  requestOwnShadowDataDeletion,
  resolveConversation,
  submitMemoryCorrection,
} from './shadowConversations';

const actor = {
  accountId: 'account-a',
  organizationId: 'org-a',
  athleteId: null,
  role: 'coach' as const,
};

jest.mock('./db', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(),
}));

const mockedQuery = query as jest.MockedFunction<typeof query>;
const mockedWithTransaction = withTransaction as jest.MockedFunction<typeof withTransaction>;

describe('SHADOW durable conversation isolation', () => {
  beforeEach(() => {
    mockedQuery.mockReset();
    mockedWithTransaction.mockReset();
    mockedQuery.mockResolvedValue([]);
  });

  it('always scopes session listings by organization and account', async () => {
    await listConversations(actor);
    expect(mockedQuery).toHaveBeenCalledWith(
      expect.stringContaining('where organization_id = $1'),
      ['org-a', 'account-a', 50],
    );
    expect(String(mockedQuery.mock.calls[0][0])).toContain('and account_id = $2');
  });

  it('rejects non-tenant-scoped owners before querying', async () => {
    await expect(listConversations({ ...actor, organizationId: '' })).rejects.toThrow(
      'Forbidden: SHADOW data requires an organization-scoped account',
    );
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('rejects a conversation ID that is not owned by the tenant and account', async () => {
    await expect(resolveConversation({
      actor,
      conversationId: '00000000-0000-0000-0000-000000000001',
      sessionType: 'quick_round',
      firstMessage: 'hello',
    })).rejects.toThrow('SHADOW_CONVERSATION_NOT_FOUND');

    expect(mockedQuery).toHaveBeenCalledWith(
      expect.stringContaining('and account_id = $3'),
      ['00000000-0000-0000-0000-000000000001', 'org-a', 'account-a'],
    );
  });

  it('stores an exchange atomically and returns the durable assistant message ID', async () => {
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [{ conversation_id: 'conversation-a' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mockedWithTransaction.mockImplementation(async (callback) => callback({
      query: clientQuery,
    } as never));

    const messageId = await appendConversationExchange({
      actor,
      conversationId: 'conversation-a',
      userMessage: 'How did today go?',
      assistantMessage: 'The available data is incomplete.',
      sessionType: 'quick_round',
      topic: 'training',
      responseState: 'filtered',
    });

    expect(messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(clientQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('for update'),
      ['conversation-a', 'org-a', 'account-a'],
    );
    expect(clientQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('response_state'),
      expect.arrayContaining([messageId, 'filtered']),
    );
  });

  it('persists only exact citations from the same server-owned bundle and tenant', async () => {
    const bundleId = '00000000-0000-4000-8000-000000000100';
    const evidenceId = '00000000-0000-4000-8000-000000000101';
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [{ conversation_id: 'conversation-a' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ claim_id: 'claim-a' }] })
      .mockResolvedValueOnce({ rows: [{ evidence_id: evidenceId }] });
    mockedWithTransaction.mockImplementation(async (callback) => callback({
      query: clientQuery,
    } as never));

    const messageId = await appendConversationExchange({
      actor,
      conversationId: 'conversation-a',
      userMessage: 'What does approved evidence say?',
      assistantMessage: `Approved evidence supports the claim. [E:${evidenceId}]`,
      sessionType: 'quick_round',
      topic: 'training',
      responseState: 'ok',
      evidence: {
        bundleId,
        availability: 'available',
        citationIds: [evidenceId],
      },
    });

    expect(String(clientQuery.mock.calls[3][0])).toContain('b.organization_id = $2');
    expect(String(clientQuery.mock.calls[3][0])).toContain('b.account_id = $3');
    expect(clientQuery.mock.calls[3][1]).toEqual(expect.arrayContaining([
      'org-a',
      'account-a',
      messageId,
      bundleId,
      'supported',
    ]));
    expect(String(clientQuery.mock.calls[4][0])).toContain('e.bundle_id = $3');
    expect(String(clientQuery.mock.calls[4][0])).toContain('e.organization_id = $4');
    expect(String(clientQuery.mock.calls[4][0])).toContain('e.account_id = $5');
  });

  it('fails the atomic exchange when a citation is not in the exact bundle', async () => {
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [{ conversation_id: 'conversation-a' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ claim_id: 'claim-a' }] })
      .mockResolvedValueOnce({ rows: [] });
    mockedWithTransaction.mockImplementation(async (callback) => callback({
      query: clientQuery,
    } as never));

    await expect(appendConversationExchange({
      actor,
      conversationId: 'conversation-a',
      userMessage: 'Question',
      assistantMessage: 'Claim with forged citation.',
      sessionType: 'quick_round',
      topic: 'training',
      responseState: 'ok',
      evidence: {
        bundleId: '00000000-0000-4000-8000-000000000100',
        availability: 'available',
        citationIds: ['00000000-0000-4000-8000-000000000999'],
      },
    })).rejects.toThrow('SHADOW_EVIDENCE_CITATION_NOT_FOUND');
  });

  it('returns persisted citations only through tenant- and account-scoped joins', async () => {
    mockedQuery
      .mockResolvedValueOnce([{
        conversation_id: 'conversation-a',
        athlete_id: null,
        session_type: 'quick_round',
      }] as never)
      .mockResolvedValueOnce([{
        message_id: '00000000-0000-4000-8000-000000000010',
        role: 'assistant',
        content: 'Supported claim.',
        response_state: 'ok',
        created_at: new Date('2026-07-24T12:00:00.000Z'),
        citations: [{
          evidenceId: '00000000-0000-4000-8000-000000000101',
          token: '[E:00000000-0000-4000-8000-000000000101]',
          sourceTitle: 'Approved source',
          documentName: 'Approved document',
        }],
      }] as never);

    const messages = await loadConversationMessages({
      actor,
      conversationId: 'conversation-a',
    });

    const sql = String(mockedQuery.mock.calls[1][0]);
    expect(sql).toContain('mc.organization_id = m.organization_id');
    expect(sql).toContain('mc.account_id = m.account_id');
    expect(sql).toContain('ei.organization_id = mc.organization_id');
    expect(sql).toContain('ei.account_id = mc.account_id');
    expect(mockedQuery.mock.calls[1][1]).toEqual([
      'org-a',
      'account-a',
      'conversation-a',
      12,
    ]);
    expect(messages[0].citations).toEqual([expect.objectContaining({
      sourceTitle: 'Approved source',
    })]);
  });

  it('reuses a pending deletion request instead of creating duplicates', async () => {
    mockedQuery.mockResolvedValueOnce([{ request_id: 'request-a' }] as never);
    await expect(requestOwnShadowDataDeletion(actor)).resolves.toBe('request-a');
    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });

  it('requires a replacement value for a memory correction', async () => {
    await expect(submitMemoryCorrection({
      actor,
      factKey: 'stance',
      action: 'replace',
    })).rejects.toThrow('Missing corrected SHADOW memory value');
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('fails closed before Board members can access account-level memory', async () => {
    await expect(submitMemoryCorrection({
      actor: { ...actor, role: 'board' },
      factKey: 'stance',
      correctedValue: 'southpaw',
      action: 'replace',
    })).rejects.toThrow('Forbidden: board role cannot access account-level SHADOW memory');
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('requires explicit retention confirmation and bounded whole days', async () => {
    await expect(purgeExpiredShadowChatData({
      retentionDays: 30,
      confirmed: false,
    })).resolves.toBe(0);
    expect(mockedQuery).not.toHaveBeenCalled();

    await expect(purgeExpiredShadowChatData({
      retentionDays: 0,
      confirmed: true,
    })).rejects.toThrow('Invalid SHADOW retention period');
    await expect(purgeExpiredShadowChatData({
      retentionDays: 30.5,
      confirmed: true,
    })).rejects.toThrow('Invalid SHADOW retention period');
  });
});
