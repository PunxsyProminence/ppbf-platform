import { readFileSync } from 'node:fs';
import path from 'node:path';

import { AUDIT_EVENT_TYPES, isAuditEventType } from './auditEventTypes';

/**
 * Guards the one failure mode that actually bit this codebase: the audit event
 * vocabulary being declared in TypeScript and in SQL, and the two drifting.
 *
 * 'shadow_research_upload_requirement' was added to the TypeScript union and to
 * the SHADOW upload route, but never to the database check constraint. Nothing
 * failed at build time -- tsc was satisfied, every unit test mocked the database
 * away -- so the mismatch only surfaced as SQLSTATE 23514 in production, after
 * the upload had already been written.
 *
 * These tests read the actual SQL files rather than a copy of their contents, so
 * they fail if either side gains a value the other lacks.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const BASE_SCHEMA = path.join(REPO_ROOT, 'infra/azure/pilot_slice_postgres.sql');
const VOCABULARY_MIGRATION = path.join(
  REPO_ROOT,
  'infra/azure/pilot_slice_postgres_audit_event_vocabulary_migration.sql',
);

/**
 * Pulls the values out of the FIRST `event_type in ( ... )` list in a SQL file.
 * Both files declare the constraint exactly once, so a naive first-match read is
 * unambiguous -- and if that ever stops being true, the assertions below fail
 * loudly rather than silently checking the wrong list.
 */
function eventTypesDeclaredIn(sqlPath: string): string[] {
  const sql = readFileSync(sqlPath, 'utf8');
  const match = sql.match(/event_type\s+in\s*\(([^)]*)\)/i);
  if (!match) {
    throw new Error(`No "event_type in (...)" constraint found in ${sqlPath}`);
  }
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('audit event vocabulary stays in step across TypeScript and SQL', () => {
  test('the base schema declares exactly the canonical vocabulary', () => {
    expect(eventTypesDeclaredIn(BASE_SCHEMA).sort()).toEqual([...AUDIT_EVENT_TYPES].sort());
  });

  test('the widening migration declares exactly the canonical vocabulary', () => {
    expect(eventTypesDeclaredIn(VOCABULARY_MIGRATION).sort()).toEqual([...AUDIT_EVENT_TYPES].sort());
  });

  // The specific value whose absence caused the production failure. Called out
  // separately from the set comparisons above so a regression names itself
  // instead of showing up as an array diff.
  test('includes shadow_research_upload_requirement, the value that was missing', () => {
    expect(AUDIT_EVENT_TYPES).toContain('shadow_research_upload_requirement');
    expect(eventTypesDeclaredIn(BASE_SCHEMA)).toContain('shadow_research_upload_requirement');
    expect(eventTypesDeclaredIn(VOCABULARY_MIGRATION)).toContain('shadow_research_upload_requirement');
  });

  test('the vocabulary has no duplicates', () => {
    expect(new Set(AUDIT_EVENT_TYPES).size).toBe(AUDIT_EVENT_TYPES.length);
  });
});

describe('isAuditEventType', () => {
  test.each([...AUDIT_EVENT_TYPES])('accepts %s', (value) => {
    expect(isAuditEventType(value)).toBe(true);
  });

  test('rejects a value outside the vocabulary', () => {
    expect(isAuditEventType('not_a_real_event')).toBe(false);
  });
});
