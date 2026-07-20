import { query } from './db';
import { ensureShadowConversationSchema, listConversations, resolveConversation } from './shadowConversations';

jest.mock('./db', () => ({ query: jest.fn() }));
const mockedQuery = query as jest.MockedFunction<typeof query>;

describe('SHADOW durable conversation isolation', () => {
  beforeAll(async () => {
    mockedQuery.mockResolvedValue([]);
    await ensureShadowConversationSchema();
  });

  beforeEach(() => {
    mockedQuery.mockClear();
    mockedQuery.mockResolvedValue([]);
  });

  it('always scopes session listings by organization and user', async () => {
    await listConversations('org-a', 'user-a');
    const call = mockedQuery.mock.calls.find(([sql]) => String(sql).includes('FROM pilot.shadow_chat_sessions WHERE organization_id'));
    expect(call).toBeDefined();
    expect(call?.[1]).toEqual(['org-a', 'user-a']);
  });

  it('rejects a conversation ID that is not owned by the authenticated tenant and user', async () => {
    await expect(resolveConversation({
      organizationId: 'org-a',
      userId: 'user-a',
      conversationId: '00000000-0000-0000-0000-000000000001',
      sessionType: 'quick_round',
      firstMessage: 'hello',
    })).rejects.toThrow('SHADOW_CONVERSATION_NOT_FOUND');

    const call = mockedQuery.mock.calls.find(([sql]) => String(sql).includes('conversation_id = $1 AND organization_id = $2 AND user_id = $3'));
    expect(call?.[1]).toEqual(['00000000-0000-0000-0000-000000000001', 'org-a', 'user-a']);
  });
});
