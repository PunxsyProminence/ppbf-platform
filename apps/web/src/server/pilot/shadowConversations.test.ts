import { writePilotAuditEvent } from './audit';
import { query, withTransaction } from './db';
import {
  appendConversationExchange,
  loadConversationMessages,
  loadHumanReviewExchange,
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
jest.mock('./audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

const mockedWriteAudit = jest.mocked(writePilotAuditEvent);

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

/**
 * The one exchange behind a human-review ticket (OD-2026-10-07-009 question
 * card 2 item 4, "That one exchange"). What is pinned: the ticket is the only
 * handle, every message read is bounded by the ticket's own organization and
 * conversation, exactly one assistant row and at most one user row are
 * selected, and the audit row goes on the same transaction before the words
 * are returned.
 *
 * MUTATION PROOF (run by hand, 2026-10-08): dropping `and conversation_id = $2`
 * from the assistant read, or `limit 1` / `role = 'user'` from the user read,
 * or widening either to the whole conversation, fails the predicate
 * assertions below. A read that answered with a neighbour would need a
 * statement this test does not permit.
 */
describe('loadHumanReviewExchange: one ticket, one exchange, one audit row', () => {
  const REVIEW_ID = '7b0d2c7e-5c6a-4f8e-9c3d-2a1b4c5d6e7f';
  const CONVERSATION_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  const ASSISTANT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const USER_ID = '11111111-2222-4333-8444-555555555555';
  const reader = { accountId: 'admin-1', role: 'organization_admin' as const };

  function clientReturning(rowsBySql: Array<[RegExp, unknown[]]>) {
    const client = {
      query: jest.fn<Promise<{ rows: unknown[]; rowCount: number }>, [string, unknown[]?]>(async (sql) => {
        const hit = rowsBySql.find(([pattern]) => pattern.test(sql));
        return { rows: hit ? hit[1] : [], rowCount: hit ? hit[1].length : 0 };
      }),
    };
    mockedWithTransaction.mockImplementation(async (fn) => fn(client as never));
    return client;
  }

  const ticketRow = (metadata: Record<string, unknown>, conversationId: string | null = CONVERSATION_ID) => ({
    review_id: REVIEW_ID,
    conversation_id: conversationId,
    account_id: 'athlete-9',
    metadata,
  });

  beforeEach(() => {
    mockedQuery.mockReset();
    mockedWithTransaction.mockReset();
    mockedWriteAudit.mockReset();
    mockedWriteAudit.mockResolvedValue(undefined);
  });

  it('returns exactly the flagged answer and the question before it, labelled, and records the read first', async () => {
    const assistantCreated = new Date('2026-08-01T12:00:00.001Z');
    const client = clientReturning([
      [/from pilot\.shadow_human_review_queue/, [ticketRow({ assistantMessageId: ASSISTANT_ID })]],
      [/role = 'assistant'/, [{ message_id: ASSISTANT_ID, content: 'Sit down and tell a coach now.', response_state: 'filtered', created_at: assistantCreated }]],
      [/role = 'user'/, [{ message_id: USER_ID, content: 'my chest hurts when i skip', created_at: new Date('2026-08-01T12:00:00.000Z') }]],
      [/from pilot\.accounts a/, [{ role: 'athlete', dob: '2012-05-04' }]],
    ]);

    const result = await loadHumanReviewExchange({ organizationId: 'org-a', reviewId: REVIEW_ID, reader });

    expect(result).toEqual({
      recorded: true,
      subject: { accountId: 'athlete-9', role: 'athlete', ageBand: 'under_18' },
      userMessage: { messageId: USER_ID, content: 'my chest hurts when i skip', createdAt: '2026-08-01T12:00:00.000Z' },
      assistantMessage: {
        messageId: ASSISTANT_ID,
        content: 'Sit down and tell a coach now.',
        createdAt: '2026-08-01T12:00:00.001Z',
        responseState: 'filtered',
      },
    });

    const statements = client.query.mock.calls.map(([sql, params]) => ({ sql: String(sql), params: params ?? [] }));

    // The ticket is read by its id AND the caller's organization.
    const ticket = statements.find((s) => s.sql.includes('from pilot.shadow_human_review_queue'));
    expect(ticket?.sql).toContain('where review_id = $1 and organization_id = $2');
    expect(ticket?.params).toEqual([REVIEW_ID, 'org-a']);

    // Every read of the message table is bounded by the ticket's conversation
    // and the organization. There are exactly two, and neither is open-ended.
    const messageReads = statements.filter((s) => s.sql.includes('from pilot.shadow_chat_messages'));
    expect(messageReads).toHaveLength(2);
    for (const read of messageReads) {
      expect(read.sql).toMatch(/conversation_id = \$\d/);
      expect(read.sql).toMatch(/organization_id = \$\d/);
    }
    const assistant = messageReads.find((s) => s.sql.includes("role = 'assistant'"));
    expect(assistant?.sql).toContain('where message_id = $1');
    expect(assistant?.sql).toContain('and conversation_id = $2');
    expect(assistant?.sql).toContain('and organization_id = $3');
    expect(assistant?.params).toEqual([ASSISTANT_ID, CONVERSATION_ID, 'org-a']);
    const user = messageReads.find((s) => s.sql.includes("role = 'user'"));
    expect(user?.sql).toContain('created_at <= $3');
    expect(user?.sql).toContain('order by created_at desc');
    expect(user?.sql).toContain('limit 1');
    expect(user?.params).toEqual([CONVERSATION_ID, 'org-a', assistantCreated]);

    // The audit row: who read whose exchange, on the transaction's client,
    // and not fanned out to the SHADOW event/telemetry streams.
    expect(mockedWriteAudit).toHaveBeenCalledTimes(1);
    expect(mockedWriteAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'shadow_review_exchange_read',
        actor_account_id: 'admin-1',
        actor_role: 'organization_admin',
        organization_id: 'org-a',
        entity_type: 'shadow_human_review',
        entity_id: REVIEW_ID,
        details: expect.objectContaining({
          subjectAccountId: 'athlete-9',
          subjectAgeBand: 'under_18',
          conversationId: CONVERSATION_ID,
          assistantMessageId: ASSISTANT_ID,
          userMessageId: USER_ID,
        }),
        shadow_mirror: false,
      }),
      client,
    );
    // No pooled (autocommit) query at all: everything rides the transaction.
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('a ticket that names no message is "not recorded" and nothing is read or audited', async () => {
    const client = clientReturning([
      [/from pilot\.shadow_human_review_queue/, [ticketRow({ jobId: 'job-1', jobType: 'heavy_bag_session' })]],
    ]);
    await expect(loadHumanReviewExchange({ organizationId: 'org-a', reviewId: REVIEW_ID, reader }))
      .resolves.toEqual({ recorded: false, reason: 'no_message_on_ticket' });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('shadow_chat_messages'))).toBe(false);
    expect(mockedWriteAudit).not.toHaveBeenCalled();
  });

  it('a ticket whose conversation is gone is "not recorded", not an error, and not audited', async () => {
    clientReturning([
      [/from pilot\.shadow_human_review_queue/, [ticketRow({ assistantMessageId: ASSISTANT_ID })]],
    ]);
    await expect(loadHumanReviewExchange({ organizationId: 'org-a', reviewId: REVIEW_ID, reader }))
      .resolves.toEqual({ recorded: false, reason: 'messages_not_found' });
    expect(mockedWriteAudit).not.toHaveBeenCalled();
  });

  it('a metadata message id that is not a uuid is not sent to the database', async () => {
    const client = clientReturning([
      [/from pilot\.shadow_human_review_queue/, [ticketRow({ assistantMessageId: "x' or 1=1 --" })]],
    ]);
    await expect(loadHumanReviewExchange({ organizationId: 'org-a', reviewId: REVIEW_ID, reader }))
      .resolves.toEqual({ recorded: false, reason: 'no_message_on_ticket' });
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("another organization's ticket is null, and nothing else is read", async () => {
    const client = clientReturning([]);
    await expect(loadHumanReviewExchange({ organizationId: 'org-b', reviewId: REVIEW_ID, reader }))
      .resolves.toBeNull();
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0][1]).toEqual([REVIEW_ID, 'org-b']);
    expect(mockedWriteAudit).not.toHaveBeenCalled();
  });

  it('a missing date of birth is reported as missing, never read as adult', async () => {
    clientReturning([
      [/from pilot\.shadow_human_review_queue/, [ticketRow({ assistantMessageId: ASSISTANT_ID })]],
      [/role = 'assistant'/, [{ message_id: ASSISTANT_ID, content: 'answer', response_state: 'ok', created_at: new Date() }]],
      [/from pilot\.accounts a/, [{ role: 'coach', dob: null }]],
    ]);
    const result = await loadHumanReviewExchange({ organizationId: 'org-a', reviewId: REVIEW_ID, reader });
    expect(result).toMatchObject({ recorded: true, subject: { role: 'coach', ageBand: 'age_not_on_record' }, userMessage: null });
  });

  it('refuses a reader with no organization or account', async () => {
    await expect(loadHumanReviewExchange({ organizationId: ' ', reviewId: REVIEW_ID, reader }))
      .rejects.toThrow('organization-scoped');
    await expect(loadHumanReviewExchange({ organizationId: 'org-a', reviewId: REVIEW_ID, reader: { accountId: '', role: 'admin' } }))
      .rejects.toThrow('organization-scoped');
    expect(mockedWithTransaction).not.toHaveBeenCalled();
  });
});
