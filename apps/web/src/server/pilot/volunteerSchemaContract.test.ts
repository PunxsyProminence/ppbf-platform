import fs from 'node:fs';
import path from 'node:path';

const repositoryRoot = path.resolve(__dirname, '../../../../..');

const modulePath = path.join(repositoryRoot, 'apps/web/src/server/pilot/volunteers.ts');
const baseSchemaPath = path.join(repositoryRoot, 'infra/azure/pilot_slice_postgres.sql');
const migrationPath = path.join(
  repositoryRoot,
  'infra/azure/pilot_slice_postgres_volunteer_program_migration.sql',
);
const runnerPath = path.join(
  repositoryRoot,
  'apps/web/scripts/pilot-apply-volunteer-program-migration.mjs',
);
const workflowPath = path.join(repositoryRoot, '.github/workflows/apply-migrations.yml');
const packageJsonPath = path.join(repositoryRoot, 'apps/web/package.json');

/** Columns pilot.volunteers gets from the base schema's CREATE TABLE. */
function baseSchemaColumns(sql: string): string[] {
  const match = sql.match(/create table if not exists pilot\.volunteers\s*\(([\s\S]*?)\n\);/i);
  if (!match) {
    throw new Error('pilot.volunteers not found in the base schema');
  }
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^(primary key|constraint|unique|check|foreign key)/i.test(line))
    .map((line) => line.split(/\s+/)[0])
    .filter(Boolean);
}

/** Columns the additive migration adds. */
function migrationColumns(sql: string): string[] {
  return [...sql.matchAll(/add column if not exists\s+([a-z_]+)/gi)].map((m) => m[1]);
}

/** Columns the module's INSERT statement writes. */
function insertedColumns(source: string): string[] {
  const match = source.match(/insert into pilot\.volunteers\s*\(([\s\S]*?)\)\s*\n\s*values/i);
  if (!match) {
    throw new Error('insert into pilot.volunteers not found in volunteers.ts');
  }
  return match[1]
    .split(',')
    .map((column) => column.trim())
    .filter(Boolean);
}

describe('volunteer schema contract', () => {
  const moduleSource = fs.readFileSync(modulePath, 'utf8');
  const baseSchema = fs.readFileSync(baseSchemaPath, 'utf8');
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const runner = fs.readFileSync(runnerPath, 'utf8');
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  /**
   * THE test. The feature shipped writing five columns that did not exist, and
   * failed on every single call in production from day one, because nothing
   * compared the INSERT's column list against the schema that actually
   * existed. This does exactly that comparison.
   */
  test('every column the insert writes exists in the base schema or the migration', () => {
    const available = new Set([
      ...baseSchemaColumns(baseSchema),
      ...migrationColumns(migration),
    ]);
    const written = insertedColumns(moduleSource);

    // Guard against a regex that silently matched nothing, which would make
    // the subset check below trivially true.
    expect(written.length).toBeGreaterThanOrEqual(12);
    expect(available.size).toBeGreaterThanOrEqual(12);

    const missing = written.filter((column) => !available.has(column));
    expect(missing).toEqual([]);
  });

  test('the five columns that were missing in production are now owned by the migration', () => {
    const added = migrationColumns(migration);
    for (const column of [
      'role_focus',
      'availability',
      'certification_status',
      'background_check_status',
      'notes',
    ]) {
      expect(added).toContain(column);
    }
    expect(added).toContain('status');
  });

  test('the canonical composite key survives -- no sequence-backed id', () => {
    // A bigserial single-column key would break the multi-org model, which is
    // what the deleted runtime DDL declared. Comments are stripped from both
    // files first, since both deliberately EXPLAIN the shape they rejected --
    // prose about a defect must not read as the defect.
    const migrationSql = migration.replace(/^\s*--.*$/gm, '');
    const code = moduleSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');

    expect(migrationSql).not.toMatch(/bigserial/i);
    expect(code).not.toMatch(/bigserial/i);
    expect(migrationSql).toMatch(/add column if not exists/i);
    expect(moduleSource).toContain('randomUUID()');
    expect(insertedColumns(moduleSource)).toContain('volunteer_id');
  });

  test('the module creates no schema at runtime', () => {
    // Comments stripped: this file describes the DDL it removed.
    const code = moduleSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');

    expect(code).not.toMatch(/create\s+table/i);
    expect(code).not.toMatch(/create\s+index/i);
    expect(code).not.toContain('ensureVolunteerTable');

    // The strip must not have eaten the file.
    expect(code).toContain('export async function createVolunteer');
    expect(code).toContain('export async function listVolunteers');
  });

  test('every read, write and update is scoped to an organization', () => {
    // Parse the SQL template literals themselves. Matching loosely from a
    // keyword also swallows the prose above them, which happens to mention
    // "insert" and would make this pass for the wrong reason.
    const literals = moduleSource.match(/`[^`]*`/g) ?? [];
    const touchingVolunteers = literals.filter((sql) => /pilot\.volunteers/i.test(sql));

    // select, insert, update -- at minimum.
    expect(touchingVolunteers.length).toBeGreaterThanOrEqual(3);

    for (const statement of touchingVolunteers) {
      expect(statement).toMatch(/organization_id/i);
    }
  });

  test('the status vocabulary is identical in the code and the constraint', () => {
    const constraint = migration.match(/check \(status in \(([^)]*)\)\)/i);
    const declared = [...(constraint?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual(['active', 'inactive', 'pending']);

    const inCode = moduleSource.match(/VOLUNTEER_STATUSES = \[([^\]]*)\]/);
    const codeValues = [...(inCode?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(codeValues.sort()).toEqual(declared.sort());
  });

  test('the migration carries no transaction boundary, because this runner opens one', () => {
    expect(migration).not.toMatch(/^\s*begin\s*;/im);
    expect(migration).not.toMatch(/^\s*commit\s*;/im);
    expect(runner).toContain("client.query('BEGIN')");
    expect(runner).toContain("client.query('ROLLBACK')");
  });

  test('the runner checks the COLUMNS, not merely that the table exists', () => {
    // Checking `to_regclass('pilot.volunteers') is not null` alone would have
    // reported success throughout the entire period the feature was broken.
    expect(runner).toContain('program_columns_ready');
    expect(runner).toContain('pilot_volunteers_status_check');
    expect(runner).toContain('VOLUNTEER_PROGRAM_COLUMNS_NOT_READY');
  });

  test('the migration is dispatchable and covered by every hand-maintained list', () => {
    expect(packageJson.scripts['pilot:apply-volunteer-program']).toBe(
      'node scripts/pilot-apply-volunteer-program-migration.mjs',
    );
    expect(workflow).toMatch(/^\s+- volunteer-program$/m);

    const allList = workflow.match(/for m in ([a-z0-9 -]+); do/);
    expect(allList?.[1]).toContain('volunteer-program');

    const listCheck = workflow.match(/case " ([a-z0-9 -]+) " in/);
    expect(listCheck?.[1]).toContain('volunteer-program');
  });
});
