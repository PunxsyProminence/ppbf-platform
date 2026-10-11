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
  test('the module issues no DDL and never updates or deletes a row: the shape is written once', () => {
    const body = code(moduleSource);
    expect(body).not.toMatch(/create\s+table|create\s+index|alter\s+table|drop\s+table/i);
    expect(body).not.toMatch(/delete\s+from/i);
    expect(body).not.toMatch(/\bupdate\s+pilot\./i);

    const statements = body.match(/`[^`]*pilot\.workout_issue[^`]*`/g) ?? [];
    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      expect(statement).toMatch(/insert into pilot\.workout_issue(?:s|_steps)\s*\(\s*organization_id/);
    }
  });

  test('the write has no pooled form: it takes a transaction client and imports nothing from ./db', () => {
    const body = code(moduleSource);
    expect(body).not.toMatch(/from '\.\/db'/);
    expect(body).toMatch(/export async function recordWorkoutIssue\(\s*client: PoolClient,/);
    // Every statement goes through that client.
    expect(body.match(/\bclient\.query\(/g)).toHaveLength(2);
    expect(body).not.toMatch(/(?<!client\.)\bquery(?:One)?\(/);
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

  test('the migration is registered: a dispatch option, last in both `all` lists, and its two scripts', () => {
    expect(workflow).toMatch(/^ {10}- workout-issues$/m);
    expect(workflow).toMatch(/ athlete-capacity-notes workout-issues; do$/m);
    expect(workflow).toMatch(/ athlete-capacity-notes workout-issues " in$/m);
    // After everything it depends on.
    const all = workflow.match(/for m in ([^;]*); do/)?.[1].split(' ') ?? [];
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
