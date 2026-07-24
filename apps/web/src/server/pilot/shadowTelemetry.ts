import { query } from './db';

export interface ShadowTelemetryInput {
  organizationId: string;
  metricName: string;
  actorAccountId: string | null;
  actorRole: string | null;
  dimensions?: Record<string, unknown>;
}

export async function writeShadowTelemetryEvent(input: ShadowTelemetryInput): Promise<void> {
  await query(
    `insert into pilot.shadow_telemetry_events
     (organization_id, metric_name, actor_account_id, actor_role, dimensions)
     values ($1,$2,$3,$4,$5::jsonb)`,
    [
      input.organizationId,
      input.metricName,
      input.actorAccountId,
      input.actorRole,
      JSON.stringify(input.dimensions ?? {}),
    ],
  );
}
