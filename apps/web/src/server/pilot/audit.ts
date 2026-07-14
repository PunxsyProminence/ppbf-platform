import type { PilotRole } from './contracts';
import { query } from './db';

export interface PilotAuditEvent {
  event_type: 'create' | 'update' | 'login' | 'logout' | 'shadow_classification' | 'shadow_routing';
  actor_account_id: string | null;
  actor_role: PilotRole | null;
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown>;
}

export async function writePilotAuditEvent(event: PilotAuditEvent): Promise<void> {
  await query(
    `insert into pilot.audit_events (event_type, actor_account_id, actor_role, entity_type, entity_id, details)
     values ($1,$2,$3,$4,$5,$6::jsonb)`,
    [event.event_type, event.actor_account_id, event.actor_role, event.entity_type, event.entity_id, JSON.stringify(event.details)],
  );
}
