import type { PoolClient } from 'pg';

import { query } from './db';

export type ShadowAuditEntityType = 'recommendation' | 'decision' | 'medical_status' | 'near_miss' | 'outcome';

export interface ShadowAuditEntryRow {
  audit_entry_id: string;
  organization_id: string;
  entity_type: ShadowAuditEntityType;
  entity_id: string;
  action: string;
  actor_account_id: string;
  actor_role: string;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  created_at: string;
}

// Minimal client shape so callers inside an existing withTransaction() block
// can pass their transactional `client` straight through -- this write must
// land in the SAME transaction as the primary write it's auditing, never as
// a separate fire-and-forget call.
type QueryClient = Pick<PoolClient, 'query'>;

export async function writeShadowAuditEntry(
  client: QueryClient,
  input: {
    organizationId: string;
    entityType: ShadowAuditEntityType;
    entityId: string;
    action: string;
    actorAccountId: string;
    actorRole: string;
    beforeState?: Record<string, unknown> | null;
    afterState?: Record<string, unknown> | null;
  },
): Promise<void> {
  await client.query(
    `insert into pilot.shadow_audit_entries
     (organization_id, entity_type, entity_id, action, actor_account_id, actor_role, before_state, after_state)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
    [
      input.organizationId,
      input.entityType,
      input.entityId,
      input.action,
      input.actorAccountId,
      input.actorRole,
      input.beforeState != null ? JSON.stringify(input.beforeState) : null,
      input.afterState != null ? JSON.stringify(input.afterState) : null,
    ],
  );
}

export async function listShadowAuditEntries(input: {
  organizationId: string;
  entityType?: ShadowAuditEntityType;
  entityId?: string;
  limit?: number;
}): Promise<ShadowAuditEntryRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  return query<ShadowAuditEntryRow>(
    `select audit_entry_id, organization_id, entity_type, entity_id, action, actor_account_id, actor_role, before_state, after_state, created_at
     from pilot.shadow_audit_entries
     where organization_id = $1
       and ($2::text is null or entity_type = $2)
       and ($3::text is null or entity_id = $3)
     order by created_at desc
     limit $4`,
    [input.organizationId, input.entityType ?? null, input.entityId ?? null, limit],
  );
}
