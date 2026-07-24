import { randomUUID } from 'node:crypto';

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
export type ShadowReviewStatus = 'open' | 'in_review' | 'resolved' | 'dismissed';

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
  createdAt: string;
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
         (message_id, conversation_id, organization_id, account_id, role, content, response_state, topic, session_type, created_at)
       values
         ($1, $2, $3, $4, 'user', $5, null, $9, $10, statement_timestamp()),
         ($6, $2, $3, $4, 'assistant', $7, $8, $9, $10, statement_timestamp() + interval '1 microsecond')`,
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
    created_at: Date;
  }>(
    `select m.message_id, m.role, m.content, m.response_state, m.created_at
     from pilot.shadow_chat_messages m
     join pilot.shadow_chat_sessions s
       on s.conversation_id = m.conversation_id
      and s.organization_id = m.organization_id
      and s.account_id = m.account_id
     where m.organization_id = $1
       and m.account_id = $2
       and m.conversation_id = $3
       and s.deleted_at is null
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
    createdAt: row.created_at.toISOString(),
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

export async function exportOwnShadowData(actor: ActorIdentity) {
  requireTenantOwner(actor);
  const sessions = await listConversations(actor, 100);
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
