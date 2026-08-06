/**
 * The canonical audit event vocabulary -- the single place the set of legal
 * `pilot.audit_events.event_type` values is written down.
 *
 * This exists because the vocabulary was previously declared twice: once as a
 * TypeScript union in audit.ts, and once as a check constraint in
 * pilot_slice_postgres.sql. The two drifted. 'shadow_research_upload_requirement'
 * was added to the union and to a calling route, but never to the constraint, so
 * every SHADOW research-requirement upload reached writePilotAuditEvent and died
 * on SQLSTATE 23514 -- after the file had been stored and the requirement row
 * written, leaving the caller with a failed request on top of completed work.
 *
 * Nothing here prevents a future value being added; what it prevents is adding
 * one to only half the system. auditEventVocabulary.test.ts parses the schema and
 * the migration and asserts both agree with this array, so the drift fails a test
 * run rather than a production request.
 *
 * ADDING A VALUE: append it here, then add a migration widening the constraint
 * (see pilot_slice_postgres_audit_event_vocabulary_migration.sql for the shape).
 * The test will tell you if you have only done one of the two.
 */
export const AUDIT_EVENT_TYPES = [
  'create',
  'update',
  'login',
  'logout',
  'shadow_classification',
  'shadow_routing',
  'shadow_research_upload_requirement',
  // #82: pausing a child's training is a safety action, not bookkeeping. A
  // hold recorded as a generic 'update' would be indistinguishable from a
  // typo correction in the audit stream.
  'safety_hold_placed',
  'safety_hold_lifted',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

const AUDIT_EVENT_TYPE_SET: ReadonlySet<string> = new Set(AUDIT_EVENT_TYPES);

export function isAuditEventType(value: string): value is AuditEventType {
  return AUDIT_EVENT_TYPE_SET.has(value);
}
