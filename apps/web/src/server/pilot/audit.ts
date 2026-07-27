import type { PilotRole } from './contracts';
import { query } from './db';
import { emitShadowEvent } from './shadowEvents';
import { writeShadowTelemetryEvent } from './shadowTelemetry';

export interface PilotAuditEvent {
  event_type:
    | 'create'
    | 'update'
    | 'login'
    | 'logout'
    | 'shadow_classification'
    | 'shadow_routing'
    | 'shadow_research_upload_requirement';
  actor_account_id: string | null;
  actor_role: PilotRole | null;
  organization_id: string | null;
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown>;
  shadow_mirror?: boolean;
}

export async function writePilotAuditEvent(event: PilotAuditEvent): Promise<void> {
  await query(
    `insert into pilot.audit_events (event_type, actor_account_id, actor_role, organization_id, entity_type, entity_id, details)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      event.event_type,
      event.actor_account_id,
      event.actor_role,
      event.organization_id,
      event.entity_type,
      event.entity_id,
      JSON.stringify(event.details),
    ],
  );

  if (!event.organization_id || event.shadow_mirror === false) {
    return;
  }

  const normalizedEventType = event.event_type.toUpperCase();
  const normalizedEntityType = event.entity_type.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

  await emitShadowEvent({
    organizationId: event.organization_id,
    eventName: `SHADOW_AUDIT_${normalizedEventType}_${normalizedEntityType}`,
    entityType: event.entity_type,
    entityId: event.entity_id,
    actorAccountId: event.actor_account_id,
    actorRole: event.actor_role,
    payload: {
      event_type: event.event_type,
      details: event.details,
    },
  });

  await writeShadowTelemetryEvent({
    organizationId: event.organization_id,
    metricName: `shadow.audit.${event.event_type}`,
    actorAccountId: event.actor_account_id,
    actorRole: event.actor_role,
    dimensions: {
      entity_type: event.entity_type,
    },
  });
}
