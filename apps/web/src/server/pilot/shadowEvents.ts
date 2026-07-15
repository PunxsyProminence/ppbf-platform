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

let ensured = false;

async function ensureShadowEventsTable(): Promise<void> {
  if (ensured) {
    return;
  }

  await query(
    `create table if not exists pilot.shadow_events (
      shadow_event_id bigserial primary key,
      organization_id text not null,
      event_name text not null,
      entity_type text not null,
      entity_id text not null,
      actor_account_id text null,
      actor_role text null,
      payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    )`,
  );

  await query(
    `create index if not exists idx_shadow_events_org_created
     on pilot.shadow_events(organization_id, created_at desc)`,
  );

  ensured = true;
}

export async function emitShadowEvent(input: ShadowEventInput): Promise<void> {
  await ensureShadowEventsTable();

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
