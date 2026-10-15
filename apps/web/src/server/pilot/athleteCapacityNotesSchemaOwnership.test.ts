import fs from 'node:fs';
import path from 'node:path';

import { CAPACITY_NOTE_MAX, CAPACITY_NOTE_ROLES } from './athleteCapacityNotes';
import { COACH_ALLOWED_AUDIT_ENTITY_TYPES } from './auditReadAllowlist';

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
      // The two reads alias the table `n`, because they also ask whether the
      // note's author has left (a subquery over accounts and memberships).
      expect(statement).toMatch(
        /where (?:n\.)?organization_id = \$1 and (?:n\.)?athlete_id = \$2|insert into pilot\.athlete_capacity_notes\s*\(\s*organization_id/,
      );
    }
    // "Has left" is asked of the note's OWN organization: a membership in
    // another gym never counts as being here (OD-2026-10-10-003 ruling 4).
    expect(body).toMatch(/om\.organization_id = n\.organization_id\s+and om\.active_flag = true/);
    expect(body).toMatch(/a\.account_id = n\.author_account_id\s+and a\.active_flag = true/);
    // The one UPDATE sets deleted_at and nothing else.
    const updates = statements.filter((s) => /update pilot\.athlete_capacity_notes/.test(s));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(/set deleted_at = clock_timestamp\(\)\s*\n?\s*where/);
  });

  test('a capacity-note audit row is not readable by coaches and is never mirrored', () => {
    // The admin's withdrawal names the departed author by account id in the
    // audit details. audit/get serves coaches only the allow-listed entity
    // types, so the row stays with the organization admin, who sees account
    // ids on every audit row already.
    expect(COACH_ALLOWED_AUDIT_ENTITY_TYPES.has('athlete_capacity_note')).toBe(false);
    const writes = code(moduleSource).match(/writePilotAuditEvent\(\{[\s\S]*?\}, client\)/g) ?? [];
    expect(writes).toHaveLength(2);
    for (const write of writes) {
      expect(write).toContain("entity_type: 'athlete_capacity_note'");
      expect(write).toContain('shadow_mirror: false');
    }
  });

  test('the notes panels and the admin block are mounted only on the coach screen and the admin athlete-records page', () => {
    // Staff only (OD-2026-10-10-003 ruling 3): no athlete or parent page may
    // mount them. A new importer is added here deliberately, under review.
    // SessionRunPresence (F-067): the "Who is here" list on the coach's live
    // session screen, a note per athlete marked present in that run.
    const webRoot = path.join(repositoryRoot, 'apps/web');
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) sources.push(full);
      }
    };
    for (const top of ['app', 'components', 'src']) walk(path.join(webRoot, top));
    expect(sources.length).toBeGreaterThan(100);

    const importersOf = (component: string) => sources
      .filter((file) => new RegExp(`import\\s+${component}\\s+from`).test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(webRoot, file).replace(/\\/g, '/'))
      .sort();
    expect(importersOf('AdminAthleteCoachNotes')).toEqual(['app/admin/athletes/page.tsx']);
    expect(importersOf('CapacityNotesPanel')).toEqual(['components/AdminAthleteCoachNotes.tsx', 'components/CoachWorkspace.tsx']);
    expect(importersOf('SessionStaffNotesPanel')).toEqual([
      'components/AdminAthleteCoachNotes.tsx',
      'components/CoachWorkspace.tsx',
      'components/SessionRunPresence.tsx',
    ]);
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
