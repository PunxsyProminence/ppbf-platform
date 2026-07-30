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

export async function emitShadowEvent(input: ShadowEventInput): Promise<void> {
  await query(
    `insert into pilot.shadow_events
     (organization_id, event_name, entity_type, entity_id, actor_account_id, actor_role, payload)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      input.organizationId,
      input.eventName,
      input.entityType,
      input.entityId,
      input.actorAccountId,
      input.actorRole,
      JSON.stringify(input.payload ?? {}),
    ],
  );
}
