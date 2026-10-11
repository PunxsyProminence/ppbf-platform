import fs from 'node:fs';
import path from 'node:path';

import { VOCABULARIES } from './contentImport/vocabularies';

// The issued workout's shape (lane P7c, #1419): who owns the two tables, who
// may write them, and that the migration is registered where a release will
// run it. Text checks over the sources; what the database does with them is
// workoutIssues.pg.test.ts.

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const read = (relative: string) => fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');

const moduleSource = read('apps/web/src/server/pilot/workoutIssues.ts');
const writerSource = read('apps/web/src/server/pilot/workoutTemplates.ts');
const migration = read('infra/azure/pilot_slice_postgres_workout_issues_migration.sql');
const templatesMigration = read('infra/azure/pilot_slice_postgres_workout_templates_v2_migration.sql');
const runner = read('apps/web/scripts/pilot-apply-workout-issues-migration.mjs');
const workflow = read('.github/workflows/apply-migrations.yml');
const packageJson = JSON.parse(read('apps/web/package.json'));

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const TABLE = /pilot\.workout_issue(?:s|_steps)\b/;

describe('issued workout schema ownership', () => {
  // The module is the write (recordWorkoutIssue) and, below it, the read. The
  // two halves are held to different rules, so they are cut apart here.
  const READ_MARKER = 'export async function listIssuedWorkoutsForAssignments';
  const writeHalf = () => code(moduleSource).slice(0, code(moduleSource).indexOf(READ_MARKER));
  const readHalf = () => code(moduleSource).slice(code(moduleSource).indexOf(READ_MARKER));

  test('the module issues no DDL and never updates or deletes a row: the shape is written once', () => {
    const body = code(moduleSource);
    expect(body.indexOf(READ_MARKER)).toBeGreaterThan(0);
    expect(body).not.toMatch(/create\s+table|create\s+index|alter\s+table|drop\s+table/i);
    expect(body).not.toMatch(/delete\s+from/i);
    expect(body).not.toMatch(/\bupdate\s+pilot\./i);

    const writes = writeHalf().match(/`[^`]*pilot\.workout_issue[^`]*`/g) ?? [];
    expect(writes).toHaveLength(2);
    for (const statement of writes) {
      expect(statement).toMatch(/insert into pilot\.workout_issue(?:s|_steps)\s*\(\s*organization_id/);
    }
    // The read half reads: one statement, no insert.
    const reads = readHalf().match(/`[^`]*pilot\.workout_issue[^`]*`/g) ?? [];
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/^`select /);
    expect(readHalf()).not.toMatch(/insert\s+into/i);
  });

  test('the write has no pooled form: it takes a transaction client and never touches the pool', () => {
    const body = writeHalf();
    expect(body).toMatch(/export async function recordWorkoutIssue\(\s*client: PoolClient,/);
    // Every statement of the write goes through that client.
    expect(body.match(/\bclient\.query\(/g)).toHaveLength(2);
    expect(body.replace(/^import .*$/gm, '')).not.toMatch(/(?<!client\.)\bquery(?:One)?\b/);
  });

  test('the read is scoped to the organization, asked only about named assignments, and joins a step to its assignment on the organization and the athlete', () => {
    const body = readHalf();
    expect(body.match(/\bquery</g)).toHaveLength(1);
    expect(body).not.toMatch(/\bclient\b/);
    expect(body).toMatch(/where s\.organization_id = \$1 and s\.assignment_id = any\(\$2::text\[\]\)/);
    expect(body).toMatch(/join pilot\.workout_issues i\s+on i\.organization_id = s\.organization_id and i\.issue_id = s\.issue_id/);
    expect(body).toMatch(
      /join pilot\.drill_assignments a\s+on a\.organization_id = s\.organization_id and a\.assignment_id = s\.assignment_id\s+and a\.athlete_id = i\.athlete_id/,
    );
    // No assignment ids, no statement: an empty list never becomes "everything".
    expect(body).toMatch(/if \(assignmentIds\.length === 0\) \{\s+return \[\];/);
  });

  test('the shape read has exactly two callers, and each asks only about the rows of its own bounded read', () => {
    // The read takes whatever ids it is given and scopes them by organization
    // only, so WHO may call it, and with what, is the boundary. A new importer
    // is added here deliberately, with the gated read its ids come from.
    const webRoot = path.join(repositoryRoot, 'apps/web');
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          // A named import of it (the only form this codebase uses for server modules; a namespace
          // import or a re-export would not be seen). privacyTiers.ts names it in a string, not an import.
          if (/import\s*\{[^}]*\blistIssuedWorkoutsForAssignments\b[^}]*\}\s*from/.test(code(fs.readFileSync(full, 'utf8')))) {
            importers.push(path.relative(webRoot, full).replace(/\\/g, '/'));
          }
        }
      }
    };
    for (const top of ['app', 'components', 'src']) walk(path.join(webRoot, top));
    expect(importers.sort()).toEqual([
      // The coach's card list: ids from listCoachCards, whose boundary is the
      // coach's current reach (athleteIdsForCoach), re-checked on every read.
      'app/api/pilot/coach/cards/route.ts',
      // The assignments read: ids from getAthleteAssignments behind assertActorCanAccessAthlete.
      'app/api/pilot/progression/assignments/route.ts',
    ]);

    const cards = code(read('apps/web/app/api/pilot/coach/cards/route.ts'));
    const roleGate = cards.lastIndexOf("requireRole(principal, ['coach', 'admin', 'organization_admin']);");
    const boundedRead = cards.indexOf('const rows = await listCoachCards(principal);');
    const cardsShapeRead = cards.indexOf('listIssuedWorkoutsForAssignments(');
    expect(roleGate).toBeGreaterThan(0);
    expect(boundedRead).toBeGreaterThan(roleGate);
    expect(cardsShapeRead).toBeGreaterThan(boundedRead);
    // Its ids are the bounded read's own rows, and its organization the session's.
    expect(cards).toMatch(
      /listIssuedWorkoutsForAssignments\(\s*principal\.organizationId,\s*rows\.map\(\(row\) => row\.assignment_id\),\s*\)/,
    );
    expect(cards.match(/listIssuedWorkoutsForAssignments\(/g)).toHaveLength(1);

    const route = code(read('apps/web/app/api/pilot/progression/assignments/route.ts'));
    const gate = route.indexOf('await assertActorCanAccessAthlete(principal, athleteId);');
    const gatedRead = route.indexOf('const assignments = await getAthleteAssignments(');
    const shapeRead = route.indexOf('listIssuedWorkoutsForAssignments(');
    expect(gate).toBeGreaterThan(0);
    expect(gatedRead).toBeGreaterThan(gate);
    expect(shapeRead).toBeGreaterThan(gatedRead);
    // Its ids are the gated read's own rows, and its organization the session's.
    expect(route).toMatch(
      /listIssuedWorkoutsForAssignments\(\s*principal\.organizationId,\s*assignments\.map\(\(assignment\) => assignment\.assignment_id\),\s*\)/,
    );
    expect(route.match(/listIssuedWorkoutsForAssignments\(/g)).toHaveLength(1);
  });

  test('the family projection is named field by field and carries no account id', () => {
    const projection = code(moduleSource).slice(code(moduleSource).indexOf('export async function toFamilyIssuedWorkouts'));
    expect(projection).not.toMatch(/\.\.\.\s*(?:workout|step)\b/);
    const returned = projection.slice(projection.indexOf('return workouts.map'));
    expect(returned).not.toMatch(/issued_by_account_id:/);
    expect(returned).toMatch(/issued_by_name:/);
  });

  test('a step is tied to an assignment of this athlete in this organization as it is written', () => {
    expect(code(moduleSource)).toMatch(
      /join pilot\.drill_assignments a\s+on a\.assignment_id = s\.assignment_id and a\.organization_id = \$1 and a\.athlete_id = \$3/,
    );
  });

  test('issueWorkoutTemplate records the shape on its own transaction client, once', () => {
    const body = code(writerSource);
    expect(body.match(/recordWorkoutIssue\(/g)).toHaveLength(1);
    expect(body).toMatch(/await recordWorkoutIssue\(client, \{/);
    // The old "not carried" declaration is gone with the gap it described.
    expect(body).not.toMatch(/NOT_CARRIED|not_carried/);
  });

  test('no other source in the app writes either table', () => {
    const webRoot = path.join(repositoryRoot, 'apps/web');
    const writers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name) && !/\.test\.[cm]?[jt]sx?$/.test(entry.name)) {
          const body = code(fs.readFileSync(full, 'utf8'));
          if (/(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?)\s+pilot\.workout_issue(?:s|_steps)\b/i.test(body)) {
            writers.push(path.relative(webRoot, full).replace(/\\/g, '/'));
          }
        }
      }
    };
    for (const top of ['app', 'components', 'src', 'scripts']) walk(path.join(webRoot, top));
    expect(writers).toEqual(['src/server/pilot/workoutIssues.ts']);
  });

  test('the migration is additive and idempotent, and opens no transaction of its own', () => {
    const sql = migration.replace(/^\s*--.*$/gm, '');
    expect(sql).toMatch(TABLE);
    expect(sql).not.toMatch(/\bdrop\b|\btruncate\b|\bdelete\s+from\b|\bupdate\s+pilot\./i);
    expect(sql).not.toMatch(/^\s*(begin|commit)\s*;/im);
    expect(sql.match(/create table\b/gi)).toHaveLength(2);
    expect(sql.match(/create table if not exists\b/gi)).toHaveLength(2);
    expect(sql.match(/create (?:unique )?index\b/gi)).toHaveLength(3);
    expect(sql.match(/create (?:unique )?index if not exists\b/gi)).toHaveLength(3);
    // It adds nothing to a table that already exists.
    expect(sql).not.toMatch(/alter\s+table/i);
  });

  test('a step takes the same contact ladder and scale levels a template item does', () => {
    const ladder = VOCABULARIES.contact_level.values.map((value) => `'${value}'`);
    expect(ladder).toHaveLength(5);
    const stepLadder = migration.match(/contact_level in \(([^)]*)\)/)?.[1].split(',').map((value) => value.trim());
    const itemLadder = templatesMigration.match(/contact_level in \(([^)]*)\)\);/)?.[1].split(',').map((value) => value.trim());
    expect(stepLadder).toEqual(ladder);
    expect(itemLadder).toEqual(ladder);
    for (const value of VOCABULARIES.contact_level.values) {
      expect(runner).toContain(`'${value}'::text`);
    }
    expect(migration).toMatch(/scale_level is null or scale_level in \('A', 'B', 'C'\)/);
    expect(templatesMigration).toMatch(/scale_level is null or scale_level in \('A','B','C'\)/);
    // Nothing gives a scale level or a contact level a default.
    expect(migration.replace(/^\s*--.*$/gm, '')).not.toMatch(/(?:scale_level|contact_level)[^,\n]*\bdefault\b/i);
  });

  test('the migration is registered: a dispatch option, in both `all` lists after what it depends on, and its two scripts', () => {
    expect(workflow).toMatch(/^ {10}- workout-issues$/m);
    // Named in the list the workflow applies and in the list its list-check
    // arm compares against. Not pinned to the tail: the next migration is
    // appended after it.
    const all = workflow.match(/for m in ([^;]*); do/)?.[1].split(' ') ?? [];
    const listCheck = workflow.match(/case " ([^"]*) " in/)?.[1].split(' ') ?? [];
    expect(all).toContain('workout-issues');
    expect(listCheck).toContain('workout-issues');
    for (const dependency of ['progression', 'coach-cards', 'workout-templates-v2']) {
      expect(all.indexOf(dependency)).toBeGreaterThanOrEqual(0);
      expect(all.indexOf(dependency)).toBeLessThan(all.indexOf('workout-issues'));
    }
    expect(packageJson.scripts['pilot:apply-workout-issues']).toBe('node scripts/pilot-apply-workout-issues-migration.mjs');
    expect(packageJson.scripts['test:migrations:workout-issues']).toContain('src/server/pilot/workoutIssues.pg.test.ts');
    expect(runner).toContain('pilot_slice_postgres_workout_issues_migration.sql');
    expect(runner).toContain('assertDeclaredWriteTargetFromEnv');
  });
});
