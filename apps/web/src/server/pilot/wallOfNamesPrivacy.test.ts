import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A source-level guard on the Wall of Names, built the same way
 * wallDisplayPrivacy.test.ts guards the television.
 *
 * wallOfNames.test.ts checks the payload that comes out of the builder, and
 * that is the stronger test -- but it can only see the fields the code puts
 * there today. This one watches the READS, because the way a wall goes wrong is
 * somebody adding `count(s.session_id)` in six months to make it "more useful",
 * and the payload test passing because they added the field to the shape too.
 */

const HERE = __dirname;
const READ_MODULES = [
  path.join(HERE, 'wallOfNames.ts'),
  path.join(HERE, 'wallOfNamesDb.ts'),
];

/** Health, safety, clinical or conduct records. None of it belongs on a wall. */
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
  'pilot.compliance_records',
];

/**
 * Columns on tables the wall DOES read, which must not be selected from them.
 * weight_class and gym_status are records about a person's body and standing;
 * emergency_contact is a phone number belonging to somebody who never agreed to
 * appear anywhere; waivers.notes and .signed_by_name are the family's own
 * paperwork, and the gate needs only the type, status, signer ROLE and date.
 */
const FORBIDDEN_COLUMNS = [
  'weight_class',
  'gym_status',
  'emergency_contact',
  'clearance_status',
  'signed_by_name',
  'waivers.notes',
];

function sqlOf(source: string): string {
  // Only the code, so a column named in prose -- and both modules discuss their
  // own subject matter at length -- is not a failure.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .toLowerCase();
}

describe('the wall of names reads nothing it must not', () => {
  const sources = READ_MODULES.map((file) => ({
    file: path.basename(file),
    sql: sqlOf(readFileSync(file, 'utf8')),
  }));

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

  it('never reads the training log, so no per-person count can reach the board', () => {
    // Not an oversight -- a decision. A shared board that shows 233 beside one
    // child and 3 beside another ranks children against each other, which
    // achievementPaths.ts forbids platform-wide.
    for (const { file, sql } of sources) {
      expect({ file, mentions: sql.includes('pilot.sessions') }).toEqual({ file, mentions: false });
      expect({ file, mentions: sql.includes('pilot.attendance') }).toEqual({ file, mentions: false });
      expect({ file, mentions: sql.includes('pilot.scheduler_attendance') }).toEqual({ file, mentions: false });
      expect({ file, mentions: sql.includes('pilot.athlete_milestones') }).toEqual({ file, mentions: false });
    }
  });

  it('uses the television’s consent gate rather than a second copy of it', () => {
    const board = readFileSync(path.join(HERE, 'wallOfNames.ts'), 'utf8');
    expect(board).toMatch(/import[\s\S]*?from '\.\/wallDisplay'/);
    expect(board).toContain('resolveDisplayVisibility');
    expect(board).toContain('renderWallName');
    // No parallel gate: nothing in this module may decide a name for itself.
    expect(board).not.toMatch(/wall_display_first_name|wall_display_full_name/);
    expect(board).not.toMatch(/AFFIRMATIVE|GUARDIAN_SIGNER_ROLES/);
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
    const route = readFileSync(
      path.join(HERE, '../../../app/api/pilot/wall-of-names/route.ts'),
      'utf8',
    );
    expect(route).toContain('principal.organizationId');
    // No query parameter, no body, no route params: there is no way to point
    // this at another gym's children.
    expect(route).not.toMatch(/searchParams|request\.json\(\)|params\./);
  });

  it('requires a session, unlike the television', () => {
    const route = readFileSync(
      path.join(HERE, '../../../app/api/pilot/wall-of-names/route.ts'),
      'utf8',
    );
    expect(route).toContain('requirePrincipal');
  });
});
