import { query, withTransaction } from './db';
import { clearMemberConversations } from './shadowConversationDeidentify';
import {
  completeShadowDataDeletionRequest,
  denyShadowDataDeletionRequest,
  getOwnShadowDataDeletionRequest,
  listShadowDataDeletionRequests,
} from './shadowConversations';

/**
 * A deletion request becomes something that happens.
 *
 * pilot.shadow_data_deletion_requests has been written since the SHADOW
 * runtime slice and read by exactly one query in this repository: its own
 * writer's idempotency check. The route that files a request answers
 * `fulfillment: 'manual_review_required'` -- a review nothing surfaced to
 * anyone who could perform it.
 *
 * These cases are about the ways a review queue is worse than no queue. It can
 * mark a request done without deleting anything, which launders inaction into
 * a green tick on a child's data request. It can let two admins each report a
 * deletion when only one happened. It can leak one gym's requests to another.
 * Or it can quietly claim to have erased more than it did.
 *
 * What clearing a chat does to its rows is proved on real Postgres in
 * shadowConversationDeletion.pg.test.ts; here the clearing step is a stub, and
 * these cases pin what reaches it and in what order.
 */

jest.mock('./db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('./shadowConversationDeidentify', () => ({ clearMemberConversations: jest.fn() }));
jest.mock('./access', () => ({
  assertActorCanAccessAthlete: jest.fn(),
  isOrganizationAdminRole: (role: string) => role === 'organization_admin' || role === 'admin',
}));

const mockQuery = query as jest.MockedFunction<typeof query>;
const mockWithTransaction = withTransaction as jest.MockedFunction<typeof withTransaction>;
const mockClear = jest.mocked(clearMemberConversations);

const admin = {
  accountId: 'admin-1',
  organizationId: 'org-a',
  athleteId: null,
  role: 'organization_admin' as const,
};
const coach = { ...admin, accountId: 'coach-1', role: 'coach' as const };

/** SQL a transaction ran, in order, with its parameters. */
let transactionCalls: Array<{ sql: string; params: readonly unknown[] }>;

/**
 * Runs the real transaction body against a fake client that answers on the SQL
 * it is given.
 *
 * A mock that resolved whatever the test handed it would assert its own
 * fixture and pass just as happily against a body that never ran the delete --
 * which is the defect this file exists to hold closed.
 */
function installTransaction(answers: {
  claimedAccountId?: string | null;
  ownedConversationIds?: readonly string[];
  cleared?: number;
  held?: number;
}): void {
  mockClear.mockResolvedValue({ cleared: answers.cleared ?? 0, held: answers.held ?? 0 });
  transactionCalls = [];
  mockWithTransaction.mockImplementation((async (fn: (client: unknown) => Promise<unknown>) => {
    const client = {
      query: async (sql: string, params: readonly unknown[]) => {
        transactionCalls.push({ sql, params });
        if (sql.includes('update pilot.shadow_data_deletion_requests')) {
          return {
            rows: answers.claimedAccountId
              ? [{ account_id: answers.claimedAccountId }]
              : [],
          };
        }
        if (sql.includes('from pilot.shadow_chat_sessions')) {
          return {
            rows: (answers.ownedConversationIds ?? []).map((id) => ({ conversation_id: id })),
          };
        }
        throw new Error(`Unexpected transaction query: ${sql}`);
      },
    };
    return fn(client);
  }) as unknown as typeof withTransaction);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue([] as never);
});

describe('only an organization admin works the queue', () => {
  it.each(['coach', 'parent', 'athlete', 'board'])('refuses %s before reading anything', async (role) => {
    const actor = { ...coach, role: role as typeof coach.role };

    await expect(listShadowDataDeletionRequests(actor)).rejects.toThrow(
      'Forbidden: SHADOW deletion requests are organization admin only',
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('refuses a completion from a coach without touching the transaction', async () => {
    installTransaction({ claimedAccountId: 'acct-child' });

    await expect(completeShadowDataDeletionRequest(coach, 'req-1')).rejects.toThrow('Forbidden');
    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  it('refuses an actor with no tenant, admin role or not', async () => {
    await expect(listShadowDataDeletionRequests({ ...admin, organizationId: '' })).rejects.toThrow(
      'Forbidden: SHADOW data requires an organization-scoped account',
    );
  });
});

describe('the queue', () => {
  it('reads only this organization and counts what each request would clear', async () => {
    mockQuery.mockResolvedValue([] as never);

    await listShadowDataDeletionRequests(admin);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('where r.organization_id = $1');
    expect(params).toEqual(['org-a', null]);
    // Counted per row at read time, not stored. The number an admin acts on
    // changes while a request sits -- the person can delete conversations
    // themselves, and can start new ones.
    expect(String(sql)).toContain('count(*)::int');
    // Every chat still under the account counts, the ones the member already
    // deleted included (completing clears those too); a flagged one counts
    // as held, apart.
    expect(String(sql)).not.toContain('s.deleted_at is null');
    expect(String(sql)).toContain('as conversations_pending');
    expect(String(sql)).toContain('as conversations_held');
    expect(String(sql)).toContain('pilot.shadow_human_review_queue');
  });

  it('passes a status filter through as a parameter rather than into the SQL', async () => {
    await listShadowDataDeletionRequests(admin, 'pending');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['org-a', 'pending']);
    expect(String(sql)).not.toContain("= 'pending'");
  });

  it('maps timestamps out as strings and keeps an unhandled request unstamped', async () => {
    mockQuery.mockResolvedValue([{
      request_id: 'req-1',
      account_id: 'acct-child',
      status: 'pending',
      requested_at: new Date('2026-08-20T10:00:00.000Z'),
      completed_at: null,
      processed_by: null,
      conversations_pending: 11,
      conversations_held: 1,
    }] as never);

    const [item] = await listShadowDataDeletionRequests(admin);

    expect(item.requestedAt).toBe('2026-08-20T10:00:00.000Z');
    // Null stays null. A completed_at defaulted to "now" would make every open
    // request look handled the moment an admin loaded the page.
    expect(item.completedAt).toBeNull();
    expect(item.processedBy).toBeNull();
    expect(item.conversationsPending).toBe(11);
    expect(item.conversationsHeld).toBe(1);
  });
});

describe('completing a request deletes, and then records that it deleted', () => {
  it('clears the requester\'s conversations and reports how many were cleared and how many held', async () => {
    installTransaction({ claimedAccountId: 'acct-child', ownedConversationIds: ['c1', 'c2', 'c3', 'c4'], cleared: 3, held: 1 });

    const outcome = await completeShadowDataDeletionRequest(admin, 'req-1');

    expect(outcome).toEqual({
      requestId: 'req-1',
      status: 'completed',
      conversationsCleared: 3,
      conversationsHeld: 1,
    });
  });

  it('actually runs the clearing rather than only marking the row', async () => {
    // THE CASE THIS FILE EXISTS FOR. An admin marking a row 'completed' with
    // nothing deleted is worse than the dead letter it replaces: a dead letter
    // does not claim to have been answered.
    installTransaction({ claimedAccountId: 'acct-child', ownedConversationIds: ['c1', 'c2'], cleared: 2 });

    await completeShadowDataDeletionRequest(admin, 'req-1');

    // Scoped to the account the CLAIMED ROW named, in the admin's gym, never
    // to anything the caller passed in. A request id is the only thing this
    // route accepts.
    const owned = transactionCalls.find((call) => call.sql.includes('from pilot.shadow_chat_sessions'));
    expect(owned?.params).toEqual(['org-a', 'acct-child']);
    expect(mockClear).toHaveBeenCalledTimes(1);
    expect(mockClear.mock.calls[0][1]).toEqual({
      organizationId: 'org-a',
      accountId: 'acct-child',
      conversationIds: ['c1', 'c2'],
    });
  });

  it('hands over every chat on the account, the ones the member already deleted included', async () => {
    // A delete used to only hide a chat. Completing the request is what
    // clears the ones hidden that way too.
    installTransaction({ claimedAccountId: 'acct-child', ownedConversationIds: [] });

    await completeShadowDataDeletionRequest(admin, 'req-1');

    const owned = transactionCalls.find((call) => call.sql.includes('from pilot.shadow_chat_sessions'));
    expect(owned?.sql).not.toContain('deleted_at');
  });

  it('claims the row in the UPDATE itself, so two admins cannot both clear it', async () => {
    installTransaction({ claimedAccountId: 'acct-child', ownedConversationIds: ['c1'], cleared: 1 });

    await completeShadowDataDeletionRequest(admin, 'req-1');

    const claim = transactionCalls[0];
    expect(claim.sql).toContain('update pilot.shadow_data_deletion_requests');
    // A read-then-write would let both admins pass a check and both clear, and
    // the second would report a deletion that did not happen.
    expect(claim.sql).toContain("status in ('pending', 'approved')");
    expect(claim.sql).toContain('returning account_id');
    expect(claim.params).toEqual(['req-1', 'org-a', 'admin-1']);
  });

  it('refuses a request another admin already handled', async () => {
    installTransaction({ claimedAccountId: null });

    await expect(completeShadowDataDeletionRequest(admin, 'req-1')).rejects.toThrow(
      'SHADOW_DELETION_REQUEST_NOT_ACTIONABLE',
    );
    // Nothing was cleared. A no-op claim that went on to delete anyway would
    // erase a person's history off a request that was already denied.
    expect(transactionCalls.some((call) => call.sql.includes('pilot.shadow_chat_sessions'))).toBe(false);
    expect(mockClear).not.toHaveBeenCalled();
  });

  it('reports zero cleared as zero rather than as a failure', async () => {
    // A person who deleted everything themselves before the admin got to it
    // has had their request honoured. Zero is a real answer.
    installTransaction({ claimedAccountId: 'acct-child', ownedConversationIds: [] });

    const outcome = await completeShadowDataDeletionRequest(admin, 'req-1');

    expect(outcome.conversationsCleared).toBe(0);
    expect(outcome.conversationsHeld).toBe(0);
    expect(outcome.status).toBe('completed');
  });

  it('does not clear memory corrections, and does not pretend to', async () => {
    // Scope is conversation history. Corrections are a person's submitted
    // "SHADOW has this wrong about me" records with their own review workflow,
    // and folding them into a bulk clear would destroy the record of a
    // correction somebody asked for. What matters is that nothing here calls
    // itself a complete erasure -- the count returned is of conversations.
    installTransaction({ claimedAccountId: 'acct-child', ownedConversationIds: ['c1'], cleared: 1 });

    await completeShadowDataDeletionRequest(admin, 'req-1');

    expect(transactionCalls.some((call) =>
      call.sql.includes('shadow_chat_memory_corrections'))).toBe(false);
  });
});

describe('denying a request', () => {
  it('records who denied it and when, and clears nothing', async () => {
    mockQuery.mockResolvedValue([{ request_id: 'req-1' }] as never);

    const outcome = await denyShadowDataDeletionRequest(admin, 'req-1');

    expect(outcome).toEqual({ requestId: 'req-1', status: 'denied', conversationsCleared: 0, conversationsHeld: 0 });
    const [sql, params] = mockQuery.mock.calls[0];
    // "Nobody ever looked at it" and "an admin considered it and said no" are
    // different facts about a child's data request. processed_by is what keeps
    // the second from decaying into the first.
    expect(String(sql)).toContain('processed_by = $3');
    expect(String(sql)).toContain('completed_at = now()');
    expect(params).toEqual(['req-1', 'org-a', 'admin-1']);
  });

  it('refuses a request that is not open', async () => {
    mockQuery.mockResolvedValue([] as never);

    await expect(denyShadowDataDeletionRequest(admin, 'req-1')).rejects.toThrow(
      'SHADOW_DELETION_REQUEST_NOT_ACTIONABLE',
    );
  });

  it('cannot reach another organization\'s request', async () => {
    mockQuery.mockResolvedValue([] as never);

    await denyShadowDataDeletionRequest(admin, 'req-1').catch(() => undefined);

    expect(String(mockQuery.mock.calls[0][0])).toContain('organization_id = $2');
  });
});

describe('what the requester can see about their own request', () => {
  it('reads the caller\'s own row and takes no account id', async () => {
    mockQuery.mockResolvedValue([{
      request_id: 'req-1',
      account_id: 'acct-child',
      status: 'pending',
      requested_at: new Date('2026-08-20T10:00:00.000Z'),
      completed_at: null,
    }] as never);

    const item = await getOwnShadowDataDeletionRequest({
      ...coach,
      accountId: 'acct-child',
    });

    expect(item?.status).toBe('pending');
    expect(mockQuery.mock.calls[0][1]).toEqual(['org-a', 'acct-child']);
    // F-119: the requester's own account id is not sent back to them.
    expect(item).not.toHaveProperty('accountId');
    expect(JSON.stringify(item)).not.toContain('acct-child');
  });

  it('never tells the requester which member of staff handled it', async () => {
    // The fact that a person handled it is theirs to know; which person is not.
    mockQuery.mockResolvedValue([{
      request_id: 'req-1',
      account_id: 'acct-child',
      status: 'completed',
      requested_at: new Date('2026-08-20T10:00:00.000Z'),
      completed_at: new Date('2026-08-21T09:00:00.000Z'),
      processed_by: 'admin-1',
    }] as never);

    const item = await getOwnShadowDataDeletionRequest({ ...coach, accountId: 'acct-child' });

    expect(item?.processedBy).toBeNull();
    expect(item?.status).toBe('completed');
    expect(item?.completedAt).toBe('2026-08-21T09:00:00.000Z');
  });

  it('answers null when there is no request rather than inventing a pending one', async () => {
    mockQuery.mockResolvedValue([] as never);

    expect(await getOwnShadowDataDeletionRequest(coach)).toBeNull();
  });
});
