import { query, withTransaction } from './db';
import {
  appendConversationExchange,
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
