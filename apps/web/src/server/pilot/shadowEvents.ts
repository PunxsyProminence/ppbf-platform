import type { PoolClient } from 'pg';

import { query } from './db';

export interface ShadowEventInput {
  organizationId: string;
  eventName: string;
  entityType: string;
  entityId: string;
  actorAccountId: string | null;
  actorRole: string | null;
  payload?: Record<string, unknown>;
}

// `client` puts the event on the caller's transaction, so it commits or rolls
// back with the write it describes. Omitted, it is the pooled autocommit
// insert it has always been.
export async function emitShadowEvent(input: ShadowEventInput, client?: PoolClient): Promise<void> {
  const text = `insert into pilot.shadow_events
     (organization_id, event_name, entity_type, entity_id, actor_account_id, actor_role, payload)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb)`;
  const values = [
    input.organizationId,
    input.eventName,
    input.entityType,
    input.entityId,
    input.actorAccountId,
    input.actorRole,
    JSON.stringify(input.payload ?? {}),
  ];

  if (client) {
    await client.query(text, values);
    return;
  }
  await query(text, values);
}
