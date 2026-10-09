import fs from 'node:fs';
import path from 'node:path';

import { CAPACITY_NOTE_MAX, CAPACITY_NOTE_ROLES } from './athleteCapacityNotes';

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const read = (relative: string) => fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');

const moduleSource = read('apps/web/src/server/pilot/athleteCapacityNotes.ts');
const routeSource = read('apps/web/app/api/pilot/coach/athlete-capacity-notes/route.ts');
const panelSource = read('apps/web/components/CapacityNotesPanel.tsx');
const migration = read('infra/azure/pilot_slice_postgres_athlete_capacity_notes_migration.sql');
const runner = read('apps/web/scripts/pilot-apply-athlete-capacity-notes-migration.mjs');
const workflow = read('.github/workflows/apply-migrations.yml');
const packageJson = JSON.parse(read('apps/web/package.json'));

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('athlete capacity notes schema ownership', () => {
  test('the module issues no DDL, never hard-deletes or edits a note, and scopes every statement by organization', () => {
    const body = code(moduleSource);
    expect(body).not.toMatch(/create\s+table|create\s+index|alter\s+table|drop\s+table/i);
    // History: a note is withdrawn (deleted_at), never erased or reworded.
    expect(body).not.toMatch(/delete\s+from/i);
    expect(body).not.toMatch(/set\s+note\s*=/i);

    const statements = body.match(/`[^`]*pilot\.athlete_capacity_notes[^`]*`/g) ?? [];
    expect(statements.length).toBe(4);
    for (const statement of statements) {
      expect(statement).toMatch(
        /where organization_id = \$1 and athlete_id = \$2|insert into pilot\.athlete_capacity_notes\s*\(\s*organization_id/,
      );
    }
    // The one UPDATE sets deleted_at and nothing else.
    const updates = statements.filter((s) => /update pilot\.athlete_capacity_notes/.test(s));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(/set deleted_at = clock_timestamp\(\)\s*\n?\s*where/);
  });

  test('neither the module, the route nor the panel parses, scores or recommends from a note (module 013 boundaries; OD-2026-09-21-001)', () => {
    // A note is the coach's words. These are the shapes an app-made number or
    // judgement would take; none may appear outside comments.
    for (const source of [code(moduleSource), code(routeSource), code(panelSource)]) {
      expect(source).not.toMatch(/recommend|risk|score|parseInt|parseFloat|Number\(|diagnos|metric|sensor/i);
    }
  });

  test('the migration carries the same role list and note cap as the module', () => {
    expect(migration).toContain(`author_role in (${CAPACITY_NOTE_ROLES.map((r) => `'${r}'`).join(', ')})`);
    expect(migration).toContain(`length(note) <= ${CAPACITY_NOTE_MAX}`);
    expect(runner).toContain(`(length(note) <= ${CAPACITY_NOTE_MAX})`);
  });

  test('the migration owns the table, its guards and its live-rows index, with no transaction of its own', () => {
    expect(migration).toMatch(/create table if not exists pilot\.athlete_capacity_notes/i);
    expect(migration).toMatch(/references pilot\.athletes\(organization_id, athlete_id\)/i);
    expect(migration).toMatch(/deleted_at\s+timestamptz null/);
    for (const name of [
      'pilot_athlete_capacity_notes_note_check',
      'pilot_athlete_capacity_notes_role_check',
      'pilot_athlete_capacity_notes_athlete_fk',
    ]) {
      expect(migration).toContain(name);
      expect(runner).toContain(name);
    }
    expect(migration).toMatch(/create index if not exists idx_athlete_capacity_notes_athlete_seq[\s\S]*where deleted_at is null/i);
    expect(migration).not.toMatch(/^\s*begin\s*;/im);
    expect(migration).not.toMatch(/^\s*commit\s*;/im);
  });

  test('the runner reads this migration and checks readiness before committing', () => {
    expect(runner).toContain('pilot_slice_postgres_athlete_capacity_notes_migration.sql');
    expect(runner).toContain('ATHLETE_CAPACITY_NOTES_TABLE_NOT_READY');
    expect(runner).toContain('idx_athlete_capacity_notes_athlete_seq');
    expect(runner).toContain('assertDeclaredWriteTargetFromEnv');
    expect(runner).toContain('rejectUnauthorized: true');
    expect(runner).toContain("client.query('BEGIN')");
    expect(runner).toContain("client.query('ROLLBACK')");
  });

  test('the migration is dispatchable, in every hand-maintained list, and has an embedded-pg suite', () => {
    expect(packageJson.scripts['pilot:apply-athlete-capacity-notes']).toBe(
      'node scripts/pilot-apply-athlete-capacity-notes-migration.mjs',
    );
    expect(packageJson.scripts['test:migrations:athlete-capacity-notes']).toContain(
      'src/server/pilot/athleteCapacityNotes.pg.test.ts',
    );
    expect(workflow).toMatch(/^\s+- athlete-capacity-notes$/m);
    expect(workflow.match(/for m in ([a-z0-9 -]+); do/)?.[1]).toContain('athlete-capacity-notes');
    expect(workflow.match(/case " ([a-z0-9 -]+) " in/)?.[1]).toContain('athlete-capacity-notes');
  });

  test('the route answers the author by name and never by account id, and the panel never asks for one', () => {
    const route = code(routeSource);
    expect(route).toContain('author_name: row.author_name');
    expect(route).not.toMatch(/author_account_id:\s*row/);
    expect(code(panelSource)).not.toContain('author_account_id');
  });
});
