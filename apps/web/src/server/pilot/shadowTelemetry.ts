import { query } from './db';

export interface ShadowTelemetryInput {
  organizationId: string;
  metricName: string;
  actorAccountId: string | null;
  actorRole: string | null;
  dimensions?: Record<string, unknown>;
}

let ensured = false;

async function ensureShadowTelemetryTable(): Promise<void> {
  if (ensured) {
    return;
  }

  await query(
    `create table if not exists pilot.shadow_telemetry_events (
      shadow_telemetry_event_id bigserial primary key,
      organization_id text not null,
      metric_name text not null,
      actor_account_id text null,
      actor_role text null,
      dimensions jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    )`,
  );

  await query(
    `create index if not exists idx_shadow_telemetry_org_created
     on pilot.shadow_telemetry_events(organization_id, created_at desc)`,
  );

  ensured = true;
}

export async function writeShadowTelemetryEvent(input: ShadowTelemetryInput): Promise<void> {
  await ensureShadowTelemetryTable();

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
