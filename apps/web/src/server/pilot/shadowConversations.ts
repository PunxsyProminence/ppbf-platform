import { randomUUID } from 'node:crypto';
import { query } from './db';

export interface ShadowConversation {
  conversationId: string;
  title: string;
  athleteId: string | null;
  sessionType: string;
  createdAt: string;
  updatedAt: string;
}

export interface ShadowConversationMessage {
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

let schemaReady: Promise<void> | null = null;

export function ensureShadowConversationSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await query('CREATE TABLE IF NOT EXISTS pilot.shadow_chat_sessions (conversation_id uuid PRIMARY KEY, organization_id text NOT NULL REFERENCES pilot.organizations(organization_id) ON DELETE CASCADE, user_id text NOT NULL, athlete_id text NULL, title text NOT NULL DEFAULT \'New conversation\', session_type text NOT NULL DEFAULT \'quick_round\', deleted_at timestamptz NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())');
      await query('CREATE INDEX IF NOT EXISTS idx_shadow_chat_sessions_owner ON pilot.shadow_chat_sessions(organization_id, user_id, updated_at DESC) WHERE deleted_at IS NULL');
      await query('CREATE TABLE IF NOT EXISTS pilot.shadow_chat_messages (message_id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES pilot.shadow_chat_sessions(conversation_id) ON DELETE CASCADE, organization_id text NOT NULL REFERENCES pilot.organizations(organization_id) ON DELETE CASCADE, user_id text NOT NULL, role text NOT NULL CHECK (role IN (\'user\', \'assistant\')), content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())');
      await query('CREATE INDEX IF NOT EXISTS idx_shadow_chat_messages_conversation ON pilot.shadow_chat_messages(organization_id, conversation_id, created_at ASC)');
      await query('CREATE TABLE IF NOT EXISTS pilot.shadow_human_review_queue (review_id uuid PRIMARY KEY, organization_id text NOT NULL REFERENCES pilot.organizations(organization_id) ON DELETE CASCADE, conversation_id uuid NULL REFERENCES pilot.shadow_chat_sessions(conversation_id) ON DELETE SET NULL, user_id text NOT NULL, category text NOT NULL, severity text NOT NULL, summary text NOT NULL, status text NOT NULL DEFAULT \'open\' CHECK (status IN (\'open\', \'in_review\', \'resolved\', \'dismissed\')), metadata jsonb NOT NULL DEFAULT \'{}\'::jsonb, reviewed_by text NULL, reviewed_at timestamptz NULL, created_at timestamptz NOT NULL DEFAULT now())');
      await query('CREATE INDEX IF NOT EXISTS idx_shadow_human_review_org_status ON pilot.shadow_human_review_queue(organization_id, status, created_at DESC)');
      await query('CREATE TABLE IF NOT EXISTS pilot.shadow_data_deletion_requests (request_id uuid PRIMARY KEY, organization_id text NOT NULL REFERENCES pilot.organizations(organization_id) ON DELETE CASCADE, user_id text NOT NULL, status text NOT NULL DEFAULT \'pending\' CHECK (status IN (\'pending\', \'approved\', \'completed\', \'denied\')), requested_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz NULL, processed_by text NULL)');
      await query('CREATE TABLE IF NOT EXISTS pilot.shadow_chat_memory_corrections (correction_id uuid PRIMARY KEY, organization_id text NOT NULL REFERENCES pilot.organizations(organization_id) ON DELETE CASCADE, user_id text NOT NULL, fact_key text NOT NULL, corrected_value text NULL, action text NOT NULL CHECK (action IN (\'replace\', \'forget\')), created_at timestamptz NOT NULL DEFAULT now())');
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

export async function resolveConversation(input: { organizationId: string; userId: string; conversationId?: string; athleteId?: string; sessionType: string; firstMessage: string }): Promise<string> {
  await ensureShadowConversationSchema();
  if (input.conversationId) {
    const existing = await query<{ conversation_id: string }>('SELECT conversation_id FROM pilot.shadow_chat_sessions WHERE conversation_id = $1 AND organization_id = $2 AND user_id = $3 AND deleted_at IS NULL', [input.conversationId, input.organizationId, input.userId]);
    if (!existing[0]) throw new Error('SHADOW_CONVERSATION_NOT_FOUND');
    return existing[0].conversation_id;
  }
  const conversationId = randomUUID();
  const title = input.firstMessage.replace(/\s+/g, ' ').trim().slice(0, 80) || 'New conversation';
  await query('INSERT INTO pilot.shadow_chat_sessions (conversation_id, organization_id, user_id, athlete_id, title, session_type) VALUES ($1, $2, $3, $4, $5, $6)', [conversationId, input.organizationId, input.userId, input.athleteId ?? null, title, input.sessionType]);
  return conversationId;
}

export async function appendConversationExchange(input: { organizationId: string; userId: string; conversationId: string; userMessage: string; assistantMessage: string; sessionType: string }): Promise<void> {
  await ensureShadowConversationSchema();
  await query('INSERT INTO pilot.shadow_chat_messages (message_id, conversation_id, organization_id, user_id, role, content) VALUES ($1, $2, $3, $4, \'user\', $5), ($6, $2, $3, $4, \'assistant\', $7)', [randomUUID(), input.conversationId, input.organizationId, input.userId, input.userMessage, randomUUID(), input.assistantMessage]);
  await query('UPDATE pilot.shadow_chat_sessions SET session_type = $1, updated_at = now() WHERE conversation_id = $2 AND organization_id = $3 AND user_id = $4', [input.sessionType, input.conversationId, input.organizationId, input.userId]);
}

export async function loadConversationMessages(input: { organizationId: string; userId: string; conversationId: string; limit?: number }): Promise<ShadowConversationMessage[]> {
  await ensureShadowConversationSchema();
  const limit = Math.max(1, Math.min(input.limit ?? 12, 50));
  const rows = await query<{ message_id: string; role: 'user' | 'assistant'; content: string; created_at: Date }>('SELECT m.message_id, m.role, m.content, m.created_at FROM pilot.shadow_chat_messages m JOIN pilot.shadow_chat_sessions s ON s.conversation_id = m.conversation_id AND s.organization_id = m.organization_id WHERE m.organization_id = $1 AND m.user_id = $2 AND m.conversation_id = $3 AND s.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT $4', [input.organizationId, input.userId, input.conversationId, limit]);
  return rows.reverse().map((row) => ({ messageId: row.message_id, role: row.role, content: row.content, createdAt: row.created_at.toISOString() }));
}

export async function listConversations(organizationId: string, userId: string): Promise<ShadowConversation[]> {
  await ensureShadowConversationSchema();
  const rows = await query<{ conversation_id: string; title: string; athlete_id: string | null; session_type: string; created_at: Date; updated_at: Date }>('SELECT conversation_id, title, athlete_id, session_type, created_at, updated_at FROM pilot.shadow_chat_sessions WHERE organization_id = $1 AND user_id = $2 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100', [organizationId, userId]);
  return rows.map((row) => ({ conversationId: row.conversation_id, title: row.title, athleteId: row.athlete_id, sessionType: row.session_type, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() }));
}

export async function renameConversation(organizationId: string, userId: string, conversationId: string, title: string): Promise<boolean> {
  await ensureShadowConversationSchema();
  const rows = await query<{ conversation_id: string }>('UPDATE pilot.shadow_chat_sessions SET title = $1, updated_at = now() WHERE conversation_id = $2 AND organization_id = $3 AND user_id = $4 AND deleted_at IS NULL RETURNING conversation_id', [title.trim().slice(0, 120), conversationId, organizationId, userId]);
  return Boolean(rows[0]);
}

export async function softDeleteConversation(organizationId: string, userId: string, conversationId: string): Promise<boolean> {
  await ensureShadowConversationSchema();
  const rows = await query<{ conversation_id: string }>('UPDATE pilot.shadow_chat_sessions SET deleted_at = now(), updated_at = now() WHERE conversation_id = $1 AND organization_id = $2 AND user_id = $3 AND deleted_at IS NULL RETURNING conversation_id', [conversationId, organizationId, userId]);
  return Boolean(rows[0]);
}

export async function exportOwnShadowData(organizationId: string, userId: string) {
  await ensureShadowConversationSchema();
  const sessions = await listConversations(organizationId, userId);
  const messages = await query('SELECT message_id, conversation_id, role, content, created_at FROM pilot.shadow_chat_messages WHERE organization_id = $1 AND user_id = $2 ORDER BY created_at ASC', [organizationId, userId]);
  return { exportedAt: new Date().toISOString(), organizationId, userId, sessions, messages };
}

export async function requestOwnShadowDataDeletion(organizationId: string, userId: string): Promise<string> {
  await ensureShadowConversationSchema();
  const existing = await query<{ request_id: string }>('SELECT request_id FROM pilot.shadow_data_deletion_requests WHERE organization_id = $1 AND user_id = $2 AND status = \'pending\' ORDER BY requested_at DESC LIMIT 1', [organizationId, userId]);
  if (existing[0]) return existing[0].request_id;
  const requestId = randomUUID();
  await query('INSERT INTO pilot.shadow_data_deletion_requests (request_id, organization_id, user_id) VALUES ($1, $2, $3)', [requestId, organizationId, userId]);
  return requestId;
}

export async function queueHumanReview(input: { organizationId: string; userId: string; conversationId?: string; category: string; severity: 'moderate' | 'high' | 'critical'; summary: string; metadata?: Record<string, unknown> }): Promise<string> {
  await ensureShadowConversationSchema();
  const reviewId = randomUUID();
  await query('INSERT INTO pilot.shadow_human_review_queue (review_id, organization_id, conversation_id, user_id, category, severity, summary, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)', [reviewId, input.organizationId, input.conversationId ?? null, input.userId, input.category, input.severity, input.summary.slice(0, 1000), JSON.stringify(input.metadata ?? {})]);
  return reviewId;
}

export async function purgeExpiredShadowChatData(input: { retentionDays: number; confirmed: boolean }): Promise<number> {
  if (!input.confirmed || input.retentionDays < 1) return 0;
  await ensureShadowConversationSchema();
  const rows = await query<{ conversation_id: string }>('DELETE FROM pilot.shadow_chat_sessions WHERE deleted_at IS NOT NULL AND deleted_at < now() - ($1 * interval \'1 day\') RETURNING conversation_id', [input.retentionDays]);
  return rows.length;
}


export async function submitMemoryCorrection(input: { organizationId: string; userId: string; factKey: string; correctedValue?: string; action: 'replace' | 'forget' }): Promise<string> {
  await ensureShadowConversationSchema();
  const correctionId = randomUUID();
  await query('INSERT INTO pilot.shadow_chat_memory_corrections (correction_id, organization_id, user_id, fact_key, corrected_value, action) VALUES ($1, $2, $3, $4, $5, $6)', [correctionId, input.organizationId, input.userId, input.factKey.slice(0, 200), input.correctedValue?.slice(0, 2000) ?? null, input.action]);
  return correctionId;
}

export async function listHumanReviews(organizationId: string, status = 'open') {
  await ensureShadowConversationSchema();
  return query('SELECT review_id, conversation_id, user_id, category, severity, summary, status, metadata, created_at FROM pilot.shadow_human_review_queue WHERE organization_id = $1 AND status = $2 ORDER BY CASE severity WHEN \'critical\' THEN 0 WHEN \'high\' THEN 1 ELSE 2 END, created_at ASC LIMIT 200', [organizationId, status]);
}

export async function updateHumanReview(input: { organizationId: string; reviewId: string; reviewerId: string; status: 'in_review' | 'resolved' | 'dismissed' }): Promise<boolean> {
  await ensureShadowConversationSchema();
  const rows = await query<{ review_id: string }>('UPDATE pilot.shadow_human_review_queue SET status = $1, reviewed_by = $2, reviewed_at = CASE WHEN $1 IN (\'resolved\', \'dismissed\') THEN now() ELSE reviewed_at END WHERE review_id = $3 AND organization_id = $4 RETURNING review_id', [input.status, input.reviewerId, input.reviewId, input.organizationId]);
  return Boolean(rows[0]);
}
