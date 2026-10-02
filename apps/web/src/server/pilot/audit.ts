import type { PoolClient } from 'pg';

import type { AuditEventType } from './auditEventTypes';
import type { PilotRole } from './contracts';
import { query } from './db';
import { emitShadowEvent } from './shadowEvents';
import { writeShadowTelemetryEvent } from './shadowTelemetry';

export interface PilotAuditEvent {
  // Derived from AUDIT_EVENT_TYPES rather than restated, so this type and the
  // database check constraint cannot drift apart again.
  event_type: AuditEventType;
  actor_account_id: string | null;
  actor_role: PilotRole | null;
  organization_id: string | null;
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown>;
  shadow_mirror?: boolean;
}

// `client` puts the audit row -- and its mirrored shadow event and metric,
// when those are written -- on the caller's transaction, so the record of a
// write commits or rolls back with the write. Omitted, every insert here is
// the pooled autocommit insert it has always been.
export async function writePilotAuditEvent(event: PilotAuditEvent, client?: PoolClient): Promise<void> {
  const text = `insert into pilot.audit_events (event_type, actor_account_id, actor_role, organization_id, entity_type, entity_id, details)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb)`;
  const values = [
    event.event_type,
    event.actor_account_id,
    event.actor_role,
    event.organization_id,
    event.entity_type,
    event.entity_id,
    JSON.stringify(event.details),
  ];

  if (client) {
    await client.query(text, values);
  } else {
    await query(text, values);
  }

  if (!event.organization_id || event.shadow_mirror === false) {
    return;
  }

  // Spread rather than passed as `client`: a caller with no transaction must
  // reach the two mirrors with the single argument it always has, not with a
  // trailing undefined.
  const onClient: [] | [PoolClient] = client ? [client] : [];
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
  }, ...onClient);

  await writeShadowTelemetryEvent({
    organizationId: event.organization_id,
    metricName: `shadow.audit.${event.event_type}`,
    actorAccountId: event.actor_account_id,
    actorRole: event.actor_role,
    dimensions: {
      entity_type: event.entity_type,
    },
  }, ...onClient);
}
