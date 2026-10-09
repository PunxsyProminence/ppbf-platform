import fs from 'node:fs';
import path from 'node:path';

import { STAFF_NOTE_MAX, STAFF_NOTE_ROLES } from './sessionStaffNotes';

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const read = (relative: string) => fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');

const moduleSource = read('apps/web/src/server/pilot/sessionStaffNotes.ts');
const migration = read('infra/azure/pilot_slice_postgres_session_staff_notes_migration.sql');
const runner = read('apps/web/scripts/pilot-apply-session-staff-notes-migration.mjs');
const workflow = read('.github/workflows/apply-migrations.yml');
const packageJson = JSON.parse(read('apps/web/package.json'));

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('session staff notes schema ownership', () => {
  test('the module issues no DDL, never hard-deletes, and scopes every statement by organization', () => {
    const body = code(moduleSource);
    expect(body).not.toMatch(/create\s+table|create\s+index|alter\s+table|drop\s+table/i);
    expect(body).not.toMatch(/delete\s+from/i);

    const statements = body.match(/`[^`]*pilot\.session_staff_notes[^`]*`/g) ?? [];
    expect(statements.length).toBe(5);
    for (const statement of statements) {
      expect(statement).toMatch(
        /where organization_id = \$1 and (session_id|note_id) = \$2|insert into pilot\.session_staff_notes\s*\(\s*organization_id/,
      );
    }
    // Author-only edit and removal live in the UPDATE's own WHERE.
    const updates = statements.filter((statement) => /update pilot\.session_staff_notes/i.test(statement));
    expect(updates.length).toBe(2);
    for (const statement of updates) {
      expect(statement).toMatch(/and author_account_id = \$3 and deleted_at is null/);
    }
  });

  test('the migration does not touch pilot.sessions, and carries the roles and cap the module does', () => {
    expect(code(migration)).not.toMatch(/alter\s+table\s+pilot\.sessions/i);
    expect(migration).toContain(`author_role in (${STAFF_NOTE_ROLES.map((r) => `'${r}'`).join(', ')})`);
    expect(migration).toContain(`length(note) <= ${STAFF_NOTE_MAX}`);
  });

  test('the migration owns the table, its guards and its index, with no transaction of its own', () => {
    expect(migration).toMatch(/create table if not exists pilot\.session_staff_notes/i);
    expect(migration).toMatch(/references pilot\.sessions\(organization_id, session_id\)/i);
    expect(migration).toMatch(/references pilot\.athletes\(organization_id, athlete_id\)/i);
    for (const name of [
      'pilot_session_staff_notes_role_check',
      'pilot_session_staff_notes_note_check',
      'pilot_session_staff_notes_session_fk',
      'pilot_session_staff_notes_athlete_fk',
    ]) {
      expect(migration).toContain(name);
      expect(runner).toContain(name);
    }
    expect(migration).toMatch(/create index if not exists idx_session_staff_notes_session/i);
    expect(migration).not.toMatch(/^\s*begin\s*;/im);
    expect(migration).not.toMatch(/^\s*commit\s*;/im);
  });

  test('the runner reads this migration and checks readiness before committing', () => {
    expect(runner).toContain('pilot_slice_postgres_session_staff_notes_migration.sql');
    expect(runner).toContain('SESSION_STAFF_NOTES_TABLE_NOT_READY');
    expect(runner).toContain('idx_session_staff_notes_session');
    expect(runner).toContain('assertDeclaredWriteTargetFromEnv');
    expect(runner).toContain('rejectUnauthorized: true');
    expect(runner).toContain("client.query('BEGIN')");
    expect(runner).toContain("client.query('ROLLBACK')");
  });

  test('the migration is dispatchable, in every hand-maintained list, and has an embedded-pg suite', () => {
    expect(packageJson.scripts['pilot:apply-session-staff-notes']).toBe(
      'node scripts/pilot-apply-session-staff-notes-migration.mjs',
    );
    expect(packageJson.scripts['test:migrations:session-staff-notes']).toContain(
      'src/server/pilot/sessionStaffNotes.pg.test.ts',
    );
    expect(workflow).toMatch(/^\s+- session-staff-notes$/m);
    expect(workflow.match(/for m in ([a-z0-9 -]+); do/)?.[1]).toContain('session-staff-notes');
    expect(workflow.match(/case " ([a-z0-9 -]+) " in/)?.[1]).toContain('session-staff-notes');
  });
});
