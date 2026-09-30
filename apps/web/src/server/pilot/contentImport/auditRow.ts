import type { DbClient, ImportActor } from './actor';

// THE AUDIT ROW OF AN IMPORT, written INSIDE the import's transaction.
//
// writePilotAuditEvent cannot do this: it inserts through the global pool
// (audit.ts:20-33, `query` from db.ts), which is a different connection, so its
// row would commit even when the import rolls back -- and db.ts reads the
// connection string from the environment, which the engine never does. So the
// same insert is issued here on the caller's client: the audit row and the
// content it describes commit together or not at all.
//
// THE SHADOW MIRROR COMES AFTER COMMIT. writePilotAuditEvent also mirrors every
// organization-scoped event into pilot.shadow_events and
// pilot.shadow_telemetry_events (audit.ts:35-63). Those are observations of an
// event that happened, so they are written only once it has: the caller calls
// emitContentImportAuditMirror AFTER its COMMIT (the seed CLI does; a dry run,
// which rolls back, emits nothing). The names are derived exactly as
// audit.ts:39-40 derives them, so a reader of the SHADOW stream sees the same
// event name any other audited create produces.

export const CONTENT_IMPORT_ENTITY_TYPE = 'content_import';
const EVENT_TYPE = 'create';

export interface ContentImportAuditRecord {
  importId: string;
  organizationId: string;
  actor: ImportActor;
  details: Record<string, unknown>;
}

export async function insertContentImportAuditRow(client: DbClient, record: ContentImportAuditRecord): Promise<string> {
  const { rows } = await client.query<{ audit_id: string }>(
    `insert into pilot.audit_events
       (event_type, actor_account_id, actor_role, organization_id, entity_type, entity_id, details)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)
     returning audit_id::text as audit_id`,
    [
      EVENT_TYPE,
      record.actor.accountId,
      record.actor.role,
      record.organizationId,
      CONTENT_IMPORT_ENTITY_TYPE,
      record.importId,
      JSON.stringify(record.details),
    ],
  );
  return rows[0].audit_id;
}

/** Call AFTER the import's transaction committed; never for a dry run. */
export async function emitContentImportAuditMirror(client: DbClient, record: ContentImportAuditRecord): Promise<void> {
  const eventName = `SHADOW_AUDIT_${EVENT_TYPE.toUpperCase()}_${CONTENT_IMPORT_ENTITY_TYPE.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  await client.query(
    `insert into pilot.shadow_events
       (organization_id, event_name, entity_type, entity_id, actor_account_id, actor_role, payload)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      record.organizationId,
      eventName,
      CONTENT_IMPORT_ENTITY_TYPE,
      record.importId,
      record.actor.accountId,
      record.actor.role,
      JSON.stringify({ event_type: EVENT_TYPE, details: record.details }),
    ],
  );
  await client.query(
    `insert into pilot.shadow_telemetry_events
       (organization_id, metric_name, actor_account_id, actor_role, dimensions)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [
      record.organizationId,
      `shadow.audit.${EVENT_TYPE}`,
      record.actor.accountId,
      record.actor.role,
      JSON.stringify({ entity_type: CONTENT_IMPORT_ENTITY_TYPE }),
    ],
  );
}
