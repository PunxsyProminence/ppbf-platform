import { createHash, randomUUID } from 'node:crypto';

import { assertActorCanAccessAthlete, type ActorIdentity } from './access';
import { query, withTransaction } from './db';

export type ShadowConversationSessionType =
  | 'quick_round'
  | 'heavy_bag'
  | 'film_study'
  | 'scout_report'
  | 'board_summary'
  | 'recovery_round';

export type ShadowStoredResponseState = 'ok' | 'filtered';

// Mirrors the client's ShadowEvidenceTier. Stored per assistant message so a
// restored conversation shows the grade the answer was actually given rather
// than falling back to a flattering default -- see the migration note on
// pilot.shadow_chat_messages.
export type ShadowStoredEvidenceTier =
  | 'PROVEN'
  | 'EMERGING'
  | 'EXPERIMENTAL'
  | 'RESEARCH_NEEDED';
export type ShadowReviewStatus = 'open' | 'in_review' | 'resolved' | 'dismissed';
export type ShadowEvidenceClaimStatus = 'supported' | 'research_needed' | 'unavailable' | 'filtered';

export interface ShadowConversation {
  conversationId: string;
  title: string;
  athleteId: string | null;
  sessionType: ShadowConversationSessionType;
  createdAt: string;
  updatedAt: string;
}

export interface ShadowConversationMessage {
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  responseState: ShadowStoredResponseState | null;
  evidenceTier: ShadowStoredEvidenceTier | null;
  handoff: string | null;
  createdAt: string;
  citations?: Array<{
    evidenceId: string;
    token: string;
    sourceTitle: string;
    documentName: string;
  }>;
}

/**
 * Normalises the validator's reason codes for storage.
 *
 * The invariant is enforced here rather than trusted from callers: the column
 * is only meaningful for a withheld answer, and there are two write paths (the
 * synchronous chat route and the background job processor) that must agree
 * byte-for-byte or the same withheld answer is recorded two ways depending on
 * which tier produced it.
 *
 * An 'ok' response stores null even when the validator returned reasons --
 * `human_review` fires without withholding anything, and it already has a
 * durable artifact in pilot.shadow_human_review_queue. Recording it here too
 * would inflate every rule's share of the withheld population with answers that
 * were never withheld.
 *
 * Empty stays null rather than becoming `{}`: "no reasons recorded" and "zero
 * reasons" would both be true of an empty array, and the check script has to
 * tell a pre-migration row from an attribution bug.
 */
export function storedFilterReasons(
  responseState: ShadowStoredResponseState,
  reasons: string[] | undefined,
): string[] | null {
  if (responseState !== 'filtered') return null;
  const deduped = [...new Set((reasons ?? []).map((reason) => reason.trim()).filter(Boolean))];
  return deduped.length > 0 ? deduped.slice(0, 20) : null;
}

function boundedLimit(value: number | undefined, defaultValue: number, maximum: number): number {
  if (value === undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Invalid SHADOW result limit');
  }
  return Math.min(value, maximum);
}

function requireTenantOwner(actor: ActorIdentity): void {
  if (!actor.organizationId.trim() || !actor.accountId.trim()) {
    throw new Error('Forbidden: SHADOW data requires an organization-scoped account');
  }
}

interface OwnedConversationRow {
  conversation_id: string;
  athlete_id: string | null;
  session_type: ShadowConversationSessionType;
}

async function loadOwnedConversation(
  actor: ActorIdentity,
  conversationId: string,
): Promise<OwnedConversationRow | null> {
  requireTenantOwner(actor);
  const rows = await query<OwnedConversationRow>(
    `select conversation_id, athlete_id, session_type
     from pilot.shadow_chat_sessions
     where conversation_id = $1
       and organization_id = $2
       and account_id = $3
       and deleted_at is null`,
    [conversationId, actor.organizationId, actor.accountId],
  );
  return rows[0] ?? null;
}

async function assertConversationSubjectAccess(
  actor: ActorIdentity,
  conversation: OwnedConversationRow,
  requestedAthleteId?: string,
  requireExactSubject = false,
): Promise<void> {
  const storedAthleteId = conversation.athlete_id ?? undefined;
  if (requireExactSubject && storedAthleteId !== requestedAthleteId) {
    throw new Error('SHADOW_CONVERSATION_NOT_FOUND');
  }
  if (storedAthleteId) {
    await assertActorCanAccessAthlete(actor, storedAthleteId);
  }
}

export async function assertConversationAccess(input: {
  actor: ActorIdentity;
  conversationId: string;
  athleteId?: string;
  requireExactSubject?: boolean;
}): Promise<void> {
  const conversation = await loadOwnedConversation(input.actor, input.conversationId);
  if (!conversation) throw new Error('SHADOW_CONVERSATION_NOT_FOUND');
  try {
    await assertConversationSubjectAccess(
      input.actor,
      conversation,
      input.athleteId,
      input.requireExactSubject ?? false,
    );
  } catch {
    throw new Error('SHADOW_CONVERSATION_NOT_FOUND');
  }
}

export async function resolveConversation(input: {
  actor: ActorIdentity;
  conversationId?: string;
  athleteId?: string;
  sessionType: ShadowConversationSessionType;
  firstMessage: string;
}): Promise<string> {
  requireTenantOwner(input.actor);

  if (input.conversationId) {
    const existing = await loadOwnedConversation(input.actor, input.conversationId);
    if (!existing) throw new Error('SHADOW_CONVERSATION_NOT_FOUND');
    try {
      await assertConversationSubjectAccess(input.actor, existing, input.athleteId, true);
    } catch {
      throw new Error('SHADOW_CONVERSATION_NOT_FOUND');
    }
    return existing.conversation_id;
  }

  if (input.athleteId) {
    await assertActorCanAccessAthlete(input.actor, input.athleteId);
  }

  const conversationId = randomUUID();
  const title = input.firstMessage.replace(/\s+/g, ' ').trim().slice(0, 80) || 'New conversation';
  await query(
    `insert into pilot.shadow_chat_sessions
       (conversation_id, organization_id, account_id, athlete_id, title, session_type)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      conversationId,
      input.actor.organizationId,
      input.actor.accountId,
      input.athleteId ?? null,
      title,
      input.sessionType,
    ],
  );
  return conversationId;
}

export async function appendConversationExchange(input: {
  actor: ActorIdentity;
  conversationId: string;
  userMessage: string;
  assistantMessage: string;
  sessionType: ShadowConversationSessionType;
  topic: string;
  responseState: ShadowStoredResponseState;
  // Both are stored so a restored conversation replays what the user actually
  // saw. Omitting evidenceTier is not the same as grading a message well: the
  // read path maps null to RESEARCH_NEEDED.
  evidenceTier?: ShadowStoredEvidenceTier;
  handoff?: string;
  filterReasons?: string[];
  evidence?: {
    bundleId: string;
    availability: 'available' | 'unavailable';
    citationIds: string[];
  };
}): Promise<string> {
  requireTenantOwner(input.actor);

  return withTransaction(async (client) => {
    const owned = await client.query<{ conversation_id: string }>(
      `select conversation_id
       from pilot.shadow_chat_sessions
       where conversation_id = $1
         and organization_id = $2
         and account_id = $3
         and deleted_at is null
       for update`,
      [input.conversationId, input.actor.organizationId, input.actor.accountId],
    );
    if (!owned.rows[0]) {
      throw new Error('SHADOW_CONVERSATION_NOT_FOUND');
    }

    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    await client.query(
      `insert into pilot.shadow_chat_messages
         (message_id, conversation_id, organization_id, account_id, role, content, response_state, topic, session_type, evidence_tier, handoff, filter_reasons, created_at)
       values
         ($1, $2, $3, $4, 'user', $5, null, $9, $10, null, null, null, statement_timestamp()),
         ($6, $2, $3, $4, 'assistant', $7, $8, $9, $10, $11, $12, $13, statement_timestamp() + interval '1 microsecond')`,
      [
        userMessageId,
        input.conversationId,
        input.actor.organizationId,
        input.actor.accountId,
        input.userMessage.slice(0, 12_000),
        assistantMessageId,
        input.assistantMessage.slice(0, 12_000),
        input.responseState,
        input.topic.replace(/\s+/g, ' ').trim().slice(0, 100) || 'general',
        input.sessionType,
        input.evidenceTier ?? null,
        input.handoff?.slice(0, 500) ?? null,
        storedFilterReasons(input.responseState, input.filterReasons),
      ],
    );
    await client.query(
      `update pilot.shadow_chat_sessions
       set session_type = $1, updated_at = now()
       where conversation_id = $2
         and organization_id = $3
         and account_id = $4`,
      [input.sessionType, input.conversationId, input.actor.organizationId, input.actor.accountId],
    );

    if (input.evidence) {
      await writeAssistantEvidenceRecords(client, {
        actor: input.actor,
        conversationId: input.conversationId,
        assistantMessageId,
        responseState: input.responseState,
        evidence: input.evidence,
      });
    }
    return assistantMessageId;
  });
}

// Shared by the synchronous exchange write above and the background
// completion write below -- the evidence claim and citation rows for an
// assistant message must be byte-identical no matter which path produced the
// answer, or restored conversations would grade the same answer two ways.
async function writeAssistantEvidenceRecords(
  client: { query: <T extends object>(text: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  input: {
    actor: ActorIdentity;
    conversationId: string;
    assistantMessageId: string;
    responseState: ShadowStoredResponseState;
    evidence: {
      bundleId: string;
      availability: 'available' | 'unavailable';
      citationIds: string[];
    };
  },
): Promise<void> {
  const citationIds = [...new Set(input.evidence.citationIds)].slice(0, 8);
  const claimStatus: ShadowEvidenceClaimStatus = input.responseState === 'filtered'
    ? 'filtered'
    : citationIds.length > 0
      ? 'supported'
      : input.evidence.availability === 'unavailable'
        ? 'unavailable'
        : 'research_needed';
  const claimId = randomUUID();
  const claim = await client.query<{ claim_id: string }>(
    `insert into pilot.shadow_evidence_claims
       (claim_id, organization_id, account_id, conversation_id, assistant_message_id, bundle_id, claim_status)
     select $1, $2, $3, $4, $5, b.bundle_id, $7
     from pilot.shadow_evidence_bundles b
     where b.bundle_id = $6
       and b.organization_id = $2
       and b.account_id = $3
     returning claim_id`,
    [
      claimId,
      input.actor.organizationId,
      input.actor.accountId,
      input.conversationId,
      input.assistantMessageId,
      input.evidence.bundleId,
      claimStatus,
    ],
  );
  if (!claim.rows[0]) {
    throw new Error('SHADOW_EVIDENCE_BUNDLE_NOT_FOUND');
  }

  for (const [index, evidenceId] of citationIds.entries()) {
    const citation = await client.query<{ evidence_id: string }>(
      `insert into pilot.shadow_message_citations
         (assistant_message_id, evidence_id, bundle_id, organization_id, account_id, ordinal)
       select $1, e.evidence_id, e.bundle_id, e.organization_id, e.account_id, $6
       from pilot.shadow_evidence_items e
       where e.evidence_id = $2
         and e.bundle_id = $3
         and e.organization_id = $4
         and e.account_id = $5
       returning evidence_id`,
      [
        input.assistantMessageId,
        evidenceId,
        input.evidence.bundleId,
        input.actor.organizationId,
        input.actor.accountId,
        index + 1,
      ],
    );
    if (!citation.rows[0]) {
      throw new Error('SHADOW_EVIDENCE_CITATION_NOT_FOUND');
    }
  }
}

/**
 * Persist the user's question at enqueue time, before the background job
 * exists. The question must be durable the moment the user sends it -- a
 * queued job can fail hours later, and the conversation still has to show
 * what was asked.
 */
export async function appendUserMessage(input: {
  actor: ActorIdentity;
  conversationId: string;
  content: string;
  topic: string;
  sessionType: ShadowConversationSessionType;
}): Promise<string> {
  requireTenantOwner(input.actor);

  return withTransaction(async (client) => {
    const owned = await client.query<{ conversation_id: string }>(
      `select conversation_id
       from pilot.shadow_chat_sessions
       where conversation_id = $1
         and organization_id = $2
         and account_id = $3
         and deleted_at is null
       for update`,
      [input.conversationId, input.actor.organizationId, input.actor.accountId],
    );
    if (!owned.rows[0]) {
      throw new Error('SHADOW_CONVERSATION_NOT_FOUND');
    }

    const userMessageId = randomUUID();
    await client.query(
      `insert into pilot.shadow_chat_messages
         (message_id, conversation_id, organization_id, account_id, role, content, response_state, topic, session_type, evidence_tier, handoff, created_at)
       values ($1, $2, $3, $4, 'user', $5, null, $6, $7, null, null, statement_timestamp())`,
      [
        userMessageId,
        input.conversationId,
        input.actor.organizationId,
        input.actor.accountId,
        input.content.slice(0, 12_000),
        input.topic.replace(/\s+/g, ' ').trim().slice(0, 100) || 'general',
        input.sessionType,
      ],
    );
    await client.query(
      `update pilot.shadow_chat_sessions
       set session_type = $1, updated_at = now()
       where conversation_id = $2
         and organization_id = $3
         and account_id = $4`,
      [input.sessionType, input.conversationId, input.actor.organizationId, input.actor.accountId],
    );
    return userMessageId;
  });
}

/**
 * Persist a background completion as an assistant message, with the same
 * evidence claim and citation records the synchronous path writes. Called by
 * the job processor under the enqueuing actor's re-validated identity -- the
 * ownership predicate here is therefore the same one the live chat satisfies.
 */
/**
 * Deterministic message id for a caller that may legitimately retry.
 *
 * Formatted as a v5 UUID (version nibble 5, RFC-4122 variant) so it satisfies
 * the same validation as a random one -- isUuid() checks the version digit.
 */
function messageIdForKey(key: string): string {
  const hex = createHash('sha256').update(`shadow-assistant-message:${key}`).digest('hex');
  const version = `5${hex.slice(13, 16)}`;
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${version}-${variant}-${hex.slice(20, 32)}`;
}

export async function appendAssistantMessage(input: {
  actor: ActorIdentity;
  conversationId: string;
  content: string;
  topic: string;
  sessionType: ShadowConversationSessionType;
  responseState: ShadowStoredResponseState;
  evidenceTier?: ShadowStoredEvidenceTier;
  handoff?: string;
  filterReasons?: string[];
  evidence?: {
    bundleId: string;
    availability: 'available' | 'unavailable';
    citationIds: string[];
  };
  /**
   * Makes the append idempotent (audit B1). A background job persists its
   * answer here and is marked complete afterwards; if the worker dies between
   * those two writes, the lease expires, the job is re-claimed, and the answer
   * is appended a SECOND time -- the user reads the same answer twice, from a
   * second paid model call.
   *
   * The audit's suggestion was to complete before appending, but that only
   * swaps which side loses: complete-then-crash leaves the user with no answer
   * at all. Deriving the message id from a stable key instead removes the race
   * rather than moving it, and needs no schema change because message_id is
   * already the primary key.
   */
  idempotencyKey?: string;
}): Promise<string> {
  requireTenantOwner(input.actor);

  return withTransaction(async (client) => {
    const owned = await client.query<{ conversation_id: string }>(
      `select conversation_id
       from pilot.shadow_chat_sessions
       where conversation_id = $1
         and organization_id = $2
         and account_id = $3
         and deleted_at is null
       for update`,
      [input.conversationId, input.actor.organizationId, input.actor.accountId],
    );
    if (!owned.rows[0]) {
      throw new Error('SHADOW_CONVERSATION_NOT_FOUND');
    }

    const assistantMessageId = input.idempotencyKey
      ? messageIdForKey(input.idempotencyKey)
      : randomUUID();
    // ON CONFLICT rather than a pre-SELECT: the conversation row is already
    // locked FOR UPDATE above, but the primary key is what actually makes a
    // concurrent re-claim a no-op instead of a duplicate.
    const inserted = await client.query(
      `insert into pilot.shadow_chat_messages
         (message_id, conversation_id, organization_id, account_id, role, content, response_state, topic, session_type, evidence_tier, handoff, filter_reasons, created_at)
       values ($1, $2, $3, $4, 'assistant', $5, $6, $7, $8, $9, $10, $11, statement_timestamp())
       on conflict (message_id) do nothing
       returning message_id`,
      [
        assistantMessageId,
        input.conversationId,
        input.actor.organizationId,
        input.actor.accountId,
        input.content.slice(0, 12_000),
        input.responseState,
        input.topic.replace(/\s+/g, ' ').trim().slice(0, 100) || 'general',
        input.sessionType,
        input.evidenceTier ?? null,
        input.handoff?.slice(0, 500) ?? null,
        storedFilterReasons(input.responseState, input.filterReasons),
      ],
    );
    // Already appended by an earlier attempt at the same job. Return the id
    // and write nothing further -- re-running the evidence writes would
    // duplicate the citation records the message already carries.
    if (inserted.rowCount === 0) {
      return assistantMessageId;
    }
    await client.query(
      `update pilot.shadow_chat_sessions
       set session_type = $1, updated_at = now()
       where conversation_id = $2
         and organization_id = $3
         and account_id = $4`,
      [input.sessionType, input.conversationId, input.actor.organizationId, input.actor.accountId],
    );

    if (input.evidence) {
      await writeAssistantEvidenceRecords(client, {
        actor: input.actor,
        conversationId: input.conversationId,
        assistantMessageId,
        responseState: input.responseState,
        evidence: input.evidence,
      });
    }
    return assistantMessageId;
  });
}

export async function loadConversationMessages(input: {
  actor: ActorIdentity;
  conversationId: string;
  athleteId?: string;
  limit?: number;
}): Promise<ShadowConversationMessage[]> {
  await assertConversationAccess({
    actor: input.actor,
    conversationId: input.conversationId,
    athleteId: input.athleteId,
  });
  const limit = boundedLimit(input.limit, 12, 50);
  const rows = await query<{
    message_id: string;
    role: 'user' | 'assistant';
    content: string;
    response_state: ShadowStoredResponseState | null;
    evidence_tier: ShadowStoredEvidenceTier | null;
    handoff: string | null;
    created_at: Date;
    citations: Array<{
      evidenceId: string;
      token: string;
      sourceTitle: string;
      documentName: string;
    }>;
  }>(
    `select
       m.message_id,
       m.role,
       m.content,
       m.response_state,
       m.evidence_tier,
       m.handoff,
       m.created_at,
       coalesce(
         jsonb_agg(
           jsonb_build_object(
             'evidenceId', mc.evidence_id,
             'token', '[E:' || mc.evidence_id::text || ']',
             'sourceTitle', ls.title,
             'documentName', d.document_name
           )
           order by mc.ordinal
         ) filter (where mc.evidence_id is not null),
         '[]'::jsonb
       ) as citations
     from pilot.shadow_chat_messages m
     join pilot.shadow_chat_sessions s
       on s.conversation_id = m.conversation_id
       and s.organization_id = m.organization_id
       and s.account_id = m.account_id
     left join pilot.shadow_message_citations mc
       on mc.assistant_message_id = m.message_id
      and mc.organization_id = m.organization_id
      and mc.account_id = m.account_id
     left join pilot.shadow_evidence_items ei
       on ei.evidence_id = mc.evidence_id
      and ei.bundle_id = mc.bundle_id
      and ei.organization_id = mc.organization_id
      and ei.account_id = mc.account_id
     -- library_organization_id, not organization_id: the latter is the tenant
     -- whose bundle this is, and a citation of the platform evidence baseline
     -- names a row that tenant does not own. Joining on the wrong one leaves a
     -- baseline citation resolving to nothing, so the message renders with a
     -- null source title and reads as a broken citation.
     left join pilot.shadow_library_sources ls
       on ls.source_id = ei.source_id
      and ls.organization_id = ei.library_organization_id
     left join pilot.shadow_library_documents d
       on d.document_id = ei.document_id
      and d.organization_id = ei.library_organization_id
     where m.organization_id = $1
       and m.account_id = $2
       and m.conversation_id = $3
       and s.deleted_at is null
     group by m.message_id, m.role, m.content, m.response_state, m.evidence_tier, m.handoff, m.created_at
     order by m.created_at desc,
              case m.role when 'assistant' then 1 else 0 end desc,
              m.message_id desc
     limit $4`,
    [input.actor.organizationId, input.actor.accountId, input.conversationId, limit],
  );
  return rows.reverse().map((row) => ({
    messageId: row.message_id,
    role: row.role,
    content: row.content,
    responseState: row.response_state,
    evidenceTier: row.evidence_tier,
    handoff: row.handoff,
    createdAt: row.created_at.toISOString(),
    citations: Array.isArray(row.citations) ? row.citations : [],
  }));
}

export async function listConversations(
  actor: ActorIdentity,
  requestedLimit?: number,
): Promise<ShadowConversation[]> {
  requireTenantOwner(actor);
  const limit = boundedLimit(requestedLimit, 50, 100);
  const rows = await query<{
    conversation_id: string;
    title: string;
    athlete_id: string | null;
    session_type: ShadowConversationSessionType;
    created_at: Date;
    updated_at: Date;
  }>(
    `select conversation_id, title, athlete_id, session_type, created_at, updated_at
     from pilot.shadow_chat_sessions
     where organization_id = $1
       and account_id = $2
       and deleted_at is null
     order by updated_at desc
     limit $3`,
    [actor.organizationId, actor.accountId, limit],
  );
  const authorizedRows = await Promise.all(rows.map(async (row) => {
    if (!row.athlete_id) return row;
    try {
      await assertActorCanAccessAthlete(actor, row.athlete_id);
      return row;
    } catch {
      return null;
    }
  }));
  return authorizedRows.filter((row): row is NonNullable<typeof row> => row !== null).map((row) => ({
      conversationId: row.conversation_id,
      title: row.title,
      athleteId: row.athlete_id,
      sessionType: row.session_type,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }));
}

export async function renameConversation(
  actor: ActorIdentity,
  conversationId: string,
  title: string,
): Promise<boolean> {
  requireTenantOwner(actor);
  const normalizedTitle = title.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!normalizedTitle) {
    throw new Error('Missing conversation title');
  }
  const rows = await query<{ conversation_id: string }>(
    `update pilot.shadow_chat_sessions
     set title = $1, updated_at = now()
     where conversation_id = $2
       and organization_id = $3
       and account_id = $4
       and deleted_at is null
     returning conversation_id`,
    [normalizedTitle, conversationId, actor.organizationId, actor.accountId],
  );
  return Boolean(rows[0]);
}

export async function softDeleteConversation(
  actor: ActorIdentity,
  conversationId: string,
): Promise<boolean> {
  requireTenantOwner(actor);
  const rows = await query<{ conversation_id: string }>(
    `update pilot.shadow_chat_sessions
     set deleted_at = now(), updated_at = now()
     where conversation_id = $1
       and organization_id = $2
       and account_id = $3
       and deleted_at is null
     returning conversation_id`,
    [conversationId, actor.organizationId, actor.accountId],
  );
  return Boolean(rows[0]);
}

/**
 * How many conversations one export carries.
 *
 * Named rather than left as a literal argument because the export now has to
 * REPORT it. listConversations caps at 100 (boundedLimit), and an export that
 * silently returned the most recent hundred of somebody's hundred and fifty
 * conversations would be a partial answer wearing the label of a complete one
 * -- the person who asked for their data would have no way to know a fifty
 * was missing.
 */
export const SHADOW_EXPORT_CONVERSATION_LIMIT = 100;

export async function exportOwnShadowData(actor: ActorIdentity) {
  requireTenantOwner(actor);
  const sessions = await listConversations(actor, SHADOW_EXPORT_CONVERSATION_LIMIT);
  /* What the account actually holds, counted rather than inferred.
     `sessions.length === limit` looks like the same signal and is not: it
     reports a truncation for somebody with exactly a hundred conversations and
     nothing missing, and it cannot see the OTHER reason a row is absent --
     listConversations drops any athlete-bearing conversation the actor can no
     longer reach (assertActorCanAccessAthlete). Two numbers say the true thing
     without either of them having to guess which reason applied. */
  const storedRows = await query<{ conversations: number }>(
    `select count(*)::int as conversations
     from pilot.shadow_chat_sessions
     where organization_id = $1
       and account_id = $2
       and deleted_at is null`,
    [actor.organizationId, actor.accountId],
  );
  const allowedConversationIds = sessions.map((session) => session.conversationId);
  const messages = await query<{
    message_id: string;
    conversation_id: string;
    role: 'user' | 'assistant';
    content: string;
    response_state: ShadowStoredResponseState | null;
    created_at: Date;
  }>(
    `select message_id, conversation_id, role, content, response_state, created_at
     from pilot.shadow_chat_messages
     where organization_id = $1
       and account_id = $2
       and conversation_id = any($3::uuid[])
     order by created_at asc,
              case role when 'user' then 0 else 1 end asc,
              message_id asc`,
    [actor.organizationId, actor.accountId, allowedConversationIds],
  );
  const corrections = await query(
    `select correction_id, fact_key, corrected_value, action, status, created_at, reviewed_at
     from pilot.shadow_chat_memory_corrections
     where organization_id = $1 and account_id = $2
     order by created_at asc`,
    [actor.organizationId, actor.accountId],
  );
  return {
    exportedAt: new Date().toISOString(),
    exportScope: 'conversation_history_only' as const,
    completeAccountExport: false,
    /* The three numbers that let a reader tell a whole export from a partial
       one. conversationsIncluded < conversationsStored means something was
       left out; WHICH reason is deliberately not asserted here, because both
       can apply at once and this function cannot tell them apart. */
    conversationLimit: SHADOW_EXPORT_CONVERSATION_LIMIT,
    conversationsStored: storedRows[0]?.conversations ?? sessions.length,
    conversationsIncluded: sessions.length,
    sessions,
    messages: messages.map((row) => ({
      ...row,
      created_at: row.created_at.toISOString(),
    })),
    corrections,
  };
}

export async function requestOwnShadowDataDeletion(
  actor: ActorIdentity,
): Promise<string> {
  requireTenantOwner(actor);
  const existing = await query<{ request_id: string }>(
    `select request_id
     from pilot.shadow_data_deletion_requests
     where organization_id = $1 and account_id = $2 and status = 'pending'
     order by requested_at desc
     limit 1`,
    [actor.organizationId, actor.accountId],
  );
  if (existing[0]) return existing[0].request_id;

  const requestId = randomUUID();
  await query(
    `insert into pilot.shadow_data_deletion_requests
       (request_id, organization_id, account_id)
     values ($1, $2, $3)`,
    [requestId, actor.organizationId, actor.accountId],
  );
  return requestId;
}

export async function submitMemoryCorrection(input: {
  actor: ActorIdentity;
  factKey: string;
  correctedValue?: string;
  action: 'replace' | 'forget';
}): Promise<string> {
  requireTenantOwner(input.actor);
  if (input.actor.role === 'board') {
    throw new Error('Forbidden: board role cannot access account-level SHADOW memory');
  }
  const factKey = input.factKey.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!factKey) throw new Error('Missing SHADOW memory fact key');
  if (input.action === 'replace' && !input.correctedValue?.trim()) {
    throw new Error('Missing corrected SHADOW memory value');
  }

  const correctionId = randomUUID();
  await query(
    `insert into pilot.shadow_chat_memory_corrections
       (correction_id, organization_id, account_id, fact_key, corrected_value, action)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      correctionId,
      input.actor.organizationId,
      input.actor.accountId,
      factKey,
      input.correctedValue?.trim().slice(0, 2_000) ?? null,
      input.action,
    ],
  );
  return correctionId;
}

export async function queueHumanReview(input: {
  organizationId: string;
  accountId: string;
  conversationId?: string;
  category: string;
  severity: 'moderate' | 'high' | 'critical';
  summary: string;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  if (!input.organizationId.trim() || !input.accountId.trim()) {
    throw new Error('Forbidden: SHADOW review requires an organization-scoped account');
  }
  const reviewId = randomUUID();
  await query(
    `insert into pilot.shadow_human_review_queue
       (review_id, organization_id, conversation_id, account_id, category, severity, summary, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      reviewId,
      input.organizationId,
      input.conversationId ?? null,
      input.accountId,
      input.category.slice(0, 100),
      input.severity,
      input.summary.slice(0, 1_000),
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return reviewId;
}

export async function listHumanReviews(
  organizationId: string,
  status: ShadowReviewStatus = 'open',
) {
  if (!organizationId.trim()) {
    throw new Error('Forbidden: SHADOW reviews require an organization');
  }
  return query(
    `select review_id, conversation_id, account_id, category, severity, summary,
            status, metadata, reviewed_by, reviewed_at, created_at
     from pilot.shadow_human_review_queue
     where organization_id = $1 and status = $2
     order by
       case severity when 'critical' then 0 when 'high' then 1 else 2 end,
       created_at asc
     limit 200`,
    [organizationId, status],
  );
}

export async function updateHumanReview(input: {
  organizationId: string;
  reviewId: string;
  reviewerId: string;
  status: Exclude<ShadowReviewStatus, 'open'>;
}): Promise<boolean> {
  const rows = await query<{ review_id: string }>(
    `update pilot.shadow_human_review_queue
     set status = $1,
         reviewed_by = $2,
         reviewed_at = case when $1 in ('resolved', 'dismissed') then now() else reviewed_at end
     where review_id = $3 and organization_id = $4
     returning review_id`,
    [input.status, input.reviewerId, input.reviewId, input.organizationId],
  );
  return Boolean(rows[0]);
}

export async function purgeExpiredShadowChatData(input: {
  retentionDays: number;
  confirmed: boolean;
}): Promise<number> {
  if (!input.confirmed) return 0;
  if (!Number.isSafeInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 3_650) {
    throw new Error('Invalid SHADOW retention period');
  }
  const rows = await query<{ conversation_id: string }>(
    `delete from pilot.shadow_chat_sessions
     where deleted_at is not null
       and deleted_at < now() - ($1 * interval '1 day')
     returning conversation_id`,
    [input.retentionDays],
  );
  return rows.length;
}
