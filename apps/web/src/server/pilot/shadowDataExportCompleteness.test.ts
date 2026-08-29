import { assertActorCanAccessAthlete } from './access';
import { query } from './db';
import { SHADOW_EXPORT_CONVERSATION_LIMIT, exportOwnShadowData } from './shadowConversations';

/**
 * An export says how much of you it contains.
 *
 * GET /api/pilot/shadow/data is the only way a person gets their own SHADOW
 * conversation history out of this platform. It reads at most
 * SHADOW_EXPORT_CONVERSATION_LIMIT conversations, and it used to say nothing
 * about that -- so somebody with a hundred and fifty conversations received a
 * hundred, in a file whose only completeness signal was
 * `completeAccountExport: false`, which speaks to a different question
 * entirely (this is SHADOW history, not everything the gym holds).
 *
 * A partial answer wearing the label of a complete one is worse than a refusal,
 * and the person who asked for their data is precisely the person who cannot
 * check it against anything.
 */

jest.mock('./db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('./access', () => ({ assertActorCanAccessAthlete: jest.fn() }));

const mockQuery = query as jest.MockedFunction<typeof query>;
const mockAssertAccess = assertActorCanAccessAthlete as jest.MockedFunction<
  typeof assertActorCanAccessAthlete
>;

const actor = {
  accountId: 'account-a',
  organizationId: 'org-a',
  athleteId: null,
  role: 'coach' as const,
};

interface Fixture {
  /** Conversation rows the session listing returns, newest first. */
  readonly sessionRows?: Array<{ conversation_id: string; athlete_id: string | null }>;
  /** What count(*) over the account's undeleted conversations answers. */
  readonly storedCount?: number | undefined;
  /** Athlete ids the actor may no longer reach. */
  readonly unreachableAthletes?: readonly string[];
}

/**
 * Dispatches on the SQL the function really built rather than on call order.
 *
 * Ordering-based mocks assert the implementation's sequence and pass just as
 * happily when a query is dropped and another shifts up to take its slot --
 * which is the failure this file is meant to catch, since the whole change is
 * the ADDITION of a count query.
 */
function installQueries(fixture: Fixture = {}): void {
  const sessionRows = fixture.sessionRows ?? [];
  const unreachable = new Set(fixture.unreachableAthletes ?? []);

  mockAssertAccess.mockImplementation(async (_actor, athleteId: string) => {
    if (unreachable.has(athleteId)) throw new Error('Forbidden: athlete not accessible');
  });

  mockQuery.mockImplementation((async (sql: string) => {
    if (sql.includes('from pilot.shadow_chat_sessions') && sql.includes('count(*)')) {
      return fixture.storedCount === undefined ? [] : [{ conversations: fixture.storedCount }];
    }
    if (sql.includes('from pilot.shadow_chat_sessions')) {
      return sessionRows.map((row, index) => ({
        conversation_id: row.conversation_id,
        title: `Session ${index}`,
        athlete_id: row.athlete_id,
        session_type: 'quick_round',
        created_at: new Date('2026-08-01T00:00:00.000Z'),
        updated_at: new Date('2026-08-02T00:00:00.000Z'),
      }));
    }
    if (sql.includes('from pilot.shadow_chat_messages')) return [];
    if (sql.includes('from pilot.shadow_chat_memory_corrections')) return [];
    throw new Error(`Unexpected query: ${sql}`);
  }) as unknown as typeof query);
}

/** `n` conversations with no athlete subject, so none is filtered. */
function plainSessions(n: number): Array<{ conversation_id: string; athlete_id: null }> {
  return Array.from({ length: n }, (_value, index) => ({
    conversation_id: `conv-${index}`,
    athlete_id: null,
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('the export reports its own completeness', () => {
  it('counts what the account holds instead of inferring it from what came back', async () => {
    // THE ASSERTION THE WHOLE CHANGE RESTS ON. `sessions.length === limit` is
    // the tempting signal and it is a proxy, not the property: it reports a
    // truncation for somebody with exactly a hundred conversations and nothing
    // missing. A real count is the only thing that separates those two.
    installQueries({
      sessionRows: plainSessions(SHADOW_EXPORT_CONVERSATION_LIMIT),
      storedCount: SHADOW_EXPORT_CONVERSATION_LIMIT,
    });

    const data = await exportOwnShadowData(actor);

    expect(data.conversationsIncluded).toBe(SHADOW_EXPORT_CONVERSATION_LIMIT);
    expect(data.conversationsStored).toBe(SHADOW_EXPORT_CONVERSATION_LIMIT);
    // Equal counts: nothing is missing, and nothing claims to be.
    expect(data.conversationsIncluded < data.conversationsStored).toBe(false);
  });

  it('says how many were left behind when the cap bites', async () => {
    installQueries({
      sessionRows: plainSessions(SHADOW_EXPORT_CONVERSATION_LIMIT),
      storedCount: 150,
    });

    const data = await exportOwnShadowData(actor);

    expect(data.conversationsIncluded).toBe(100);
    expect(data.conversationsStored).toBe(150);
    expect(data.conversationLimit).toBe(SHADOW_EXPORT_CONVERSATION_LIMIT);
  });

  it('counts a conversation withheld by athlete access as missing too', async () => {
    // The OTHER reason a row is absent, and the reason the payload states two
    // numbers rather than one boolean: listConversations drops any
    // athlete-bearing conversation the actor can no longer reach. That row is
    // stored, is not included, and the export must not read as complete.
    installQueries({
      sessionRows: [
        { conversation_id: 'conv-0', athlete_id: null },
        { conversation_id: 'conv-1', athlete_id: 'ATH-LEFT' },
        { conversation_id: 'conv-2', athlete_id: null },
      ],
      storedCount: 3,
      unreachableAthletes: ['ATH-LEFT'],
    });

    const data = await exportOwnShadowData(actor);

    expect(data.conversationsIncluded).toBe(2);
    expect(data.conversationsStored).toBe(3);
  });

  it('reads the count as a number, not as the string Postgres sends for count(*)', async () => {
    // count(*) is int8, and node-postgres hands int8 back as a STRING. Without
    // the ::int cast this arrives as "150" and every comparison against
    // conversationsIncluded silently does string/number nonsense.
    installQueries({ sessionRows: plainSessions(2), storedCount: 150 });

    const data = await exportOwnShadowData(actor);

    expect(typeof data.conversationsStored).toBe('number');
    const countSql = mockQuery.mock.calls
      .map((call) => String(call[0]))
      .find((sql) => sql.includes('count(*)'));
    expect(countSql).toContain('count(*)::int');
  });

  it('scopes the count to the caller, not to the organization', async () => {
    // A count that swept the whole organization would tell one coach how many
    // conversations the gym has and then report their own export as wildly
    // incomplete. Same two-parameter scoping as every other read here.
    installQueries({ sessionRows: plainSessions(1), storedCount: 1 });

    await exportOwnShadowData(actor);

    const countCall = mockQuery.mock.calls.find((call) => String(call[0]).includes('count(*)'));
    expect(countCall).toBeDefined();
    expect(String(countCall?.[0])).toContain('and account_id = $2');
    expect(countCall?.[1]).toEqual(['org-a', 'account-a']);
  });

  it('excludes conversations the person already deleted', async () => {
    // A deleted conversation is not withheld, it is gone. Counting it would
    // report every export as permanently incomplete for anyone who has ever
    // used the delete button next to a session.
    installQueries({ sessionRows: plainSessions(1), storedCount: 1 });

    await exportOwnShadowData(actor);

    const countCall = mockQuery.mock.calls.find((call) => String(call[0]).includes('count(*)'));
    expect(String(countCall?.[0])).toContain('deleted_at is null');
  });

  it('falls back to the included count rather than reporting a phantom shortfall', async () => {
    // If the count query somehow answers nothing, "0 stored" would make every
    // export look like it had lost everything. The conservative reading of an
    // unanswered count is that what we have is what there is.
    installQueries({ sessionRows: plainSessions(4), storedCount: undefined });

    const data = await exportOwnShadowData(actor);

    expect(data.conversationsStored).toBe(4);
    expect(data.conversationsIncluded).toBe(4);
  });

  it('still says this is not everything the platform holds', async () => {
    // The pre-existing flag, kept: the two questions are different. "Did you
    // get all your conversations" and "is this everything about you" both have
    // to be answerable, and only one of them is about the cap.
    installQueries({ sessionRows: plainSessions(1), storedCount: 1 });

    const data = await exportOwnShadowData(actor);

    expect(data.completeAccountExport).toBe(false);
    expect(data.exportScope).toBe('conversation_history_only');
  });

  it('refuses an actor with no tenant before reading anything', async () => {
    installQueries({ sessionRows: plainSessions(1), storedCount: 1 });

    await expect(exportOwnShadowData({ ...actor, organizationId: '' })).rejects.toThrow(
      'Forbidden: SHADOW data requires an organization-scoped account',
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
