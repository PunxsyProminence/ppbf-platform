import type { PoolClient } from 'pg';

import { query } from './db';

export interface ShadowTelemetryInput {
  organizationId: string;
  metricName: string;
  actorAccountId: string | null;
  actorRole: string | null;
  dimensions?: Record<string, unknown>;
}

// `client` puts the metric on the caller's transaction, so it commits or rolls
// back with the write it counts. Omitted, it is the pooled autocommit insert
// it has always been.
export async function writeShadowTelemetryEvent(input: ShadowTelemetryInput, client?: PoolClient): Promise<void> {
  const text = `insert into pilot.shadow_telemetry_events
     (organization_id, metric_name, actor_account_id, actor_role, dimensions)
     values ($1,$2,$3,$4,$5::jsonb)`;
  const values = [
    input.organizationId,
    input.metricName,
    input.actorAccountId,
    input.actorRole,
    JSON.stringify(input.dimensions ?? {}),
  ];

  if (client) {
    await client.query(text, values);
    return;
  }
  await query(text, values);
}
