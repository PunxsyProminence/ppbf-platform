import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A source-level guard on the wall display.
 *
 * wallDisplay.test.ts checks the payload that comes out of buildWallBoard, and
 * that is the stronger test -- but it can only see the fields the code puts
 * there today. This one watches the READS, because the way this screen goes
 * wrong is not somebody shipping a readiness score on purpose. It is somebody
 * six months from now adding `select ... , r.score` to make the floor list
 * "more useful", and the payload test passing because they also added the field
 * to the expected shape.
 *
 * So: the tables and columns that must never be joined into a wall board, named
 * out loud, checked against the files that do the reading. A test that fails
 * with "wallDisplayDb.ts mentions pilot.readiness" is a conversation; a code
 * review that has to notice a join is not.
 */

const HERE = __dirname;
const READ_MODULES = [
  path.join(HERE, 'wallDisplay.ts'),
  path.join(HERE, 'wallDisplayDb.ts'),
];

/** Everything on this list is a health, safety, clinical or conduct record. */
const FORBIDDEN_TABLES = [
  'pilot.readiness',
  'pilot.medical_intake',
  'pilot.coach_observations',
  'pilot.assessments',
  'pilot.emergency_contacts',
  'pilot.shadow_medical',
  'pilot.shadow_near_misses',
  'pilot.feedback',
  'pilot.intake_cases',
  'pilot.documents',
];

/**
 * Columns that exist on tables the wall DOES read, and must not be selected
 * from them. scheduler_attendance.note is free text a coach typed about a
 * child; waivers.notes and signed_by_name are the family's paperwork;
 * athletes.gym_status and weight_class are records about a person's body and
 * standing, neither of which belongs on a wall.
 */
const FORBIDDEN_COLUMNS = [
  'clearance_status',
  'signed_by_name',
  'weight_class',
  'gym_status',
  'emergency_contact',
  'checked_in_by_account_id',
  'checked_in_by_role',
];

function sqlOf(source: string): string {
  // Only the query text, so a column named in a comment (this file's own
  // subject matter appears in prose in both modules) is not a failure.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .toLowerCase();
}

describe('the wall display reads nothing it must not', () => {
  const sources = READ_MODULES.map((file) => ({ file: path.basename(file), sql: sqlOf(readFileSync(file, 'utf8')) }));

  it.each(FORBIDDEN_TABLES)('never queries %s', (table) => {
    for (const { file, sql } of sources) {
      expect({ file, mentions: sql.includes(table) }).toEqual({ file, mentions: false });
    }
  });

  it.each(FORBIDDEN_COLUMNS)('never selects %s', (column) => {
    for (const { file, sql } of sources) {
      expect({ file, mentions: sql.includes(column) }).toEqual({ file, mentions: false });
    }
  });

  it('reads attendance only for people who are present', () => {
    // 'absent' and 'excused' are the other two values in the check constraint.
    // A public record of who did not turn up is exactly the thing a wall must
    // not become, so the filter is pinned here rather than left to review.
    const db = sqlOf(readFileSync(path.join(HERE, 'wallDisplayDb.ts'), 'utf8'));
    expect(db).toContain("status = 'present'");
    expect(db).not.toContain("'absent'");
    expect(db).not.toContain("'excused'");
  });

  it('issues no DDL, like every other read path in this app', () => {
    const ddl = /\b(create|alter|drop|truncate)\s+(table|schema|index|extension|view|type|sequence)\b/i;
    for (const file of READ_MODULES) {
      expect({ file: path.basename(file), ddl: ddl.test(readFileSync(file, 'utf8')) }).toEqual({
        file: path.basename(file),
        ddl: false,
      });
    }
  });

  it('never lets the caller choose the organization', () => {
    // The public announcements route learned this the hard way (see its own
    // header comment). An unauthenticated endpoint that accepts an org id is a
    // way to read another gym's children.
    const route = readFileSync(path.join(HERE, '../../../app/api/pilot/wall/route.ts'), 'utf8');
    expect(route).toContain('getPilotDefaultOrganizationId()');
    expect(route).not.toMatch(/searchParams|request\.json\(\)|params\./);
  });

  it('never returns a raw athlete id to an unauthenticated caller', () => {
    // The payload carries wallKey() instead: an id list is a roster even when
    // the names beside it are initials.
    const board = readFileSync(path.join(HERE, 'wallDisplay.ts'), 'utf8');
    const shape = board.slice(board.indexOf('export interface WallPerson'), board.indexOf('export interface WallBoard'));
    expect(shape).not.toMatch(/athlete_id/);
  });
});
