import fs from 'node:fs';
import path from 'node:path';

const repositoryRoot = path.resolve(__dirname, '../../../../..');

const modulePath = path.join(
  repositoryRoot,
  'apps/web/src/server/pilot/announcements.ts',
);
const migrationPath = path.join(
  repositoryRoot,
  'infra/azure/pilot_slice_postgres_announcements_migration.sql',
);
const runnerPath = path.join(
  repositoryRoot,
  'apps/web/scripts/pilot-apply-announcements-migration.mjs',
);
const workflowPath = path.join(
  repositoryRoot,
  '.github/workflows/apply-migrations.yml',
);
const packageJsonPath = path.join(repositoryRoot, 'apps/web/package.json');

describe('announcements schema ownership', () => {
  // Not named `module`: @next/next/no-assign-module-variable rejects that
  // identifier even in a test file.
  const moduleSource = fs.readFileSync(modulePath, 'utf8');
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const runner = fs.readFileSync(runnerPath, 'utf8');
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  // The defect this pins: `ensureAnnouncementTable()` ran CREATE TABLE from
  // inside listAnnouncements/createAnnouncement. Once
  // GET /api/pilot/announcements/public shipped unauthenticated, an anonymous
  // internet request could execute DDL against production Postgres.
  test('the module issues no DDL -- schema belongs to the migration, not a request handler', () => {
    // Comments are stripped first: this file deliberately DESCRIBES the DDL it
    // removed, and prose about a defect must not be mistaken for the defect.
    const code = moduleSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');

    expect(code).not.toMatch(/create\s+table/i);
    expect(code).not.toMatch(/create\s+index/i);
    expect(code).not.toMatch(/alter\s+table/i);
    expect(code).not.toMatch(/drop\s+table/i);
    expect(code).not.toContain('ensureAnnouncementTable');

    // Guard against the strip above eating the whole file and making the
    // assertions above vacuous.
    expect(code).toContain('export async function listAnnouncements');
    expect(code).toContain('export async function createAnnouncement');
  });

  test('the migration owns the table and the index the runtime DDL used to create', () => {
    expect(migration).toMatch(/create table if not exists pilot\.announcements/i);
    expect(migration).toMatch(
      /create index if not exists idx_pilot_announcements_org_created/i,
    );

    // Copied verbatim from the runtime DDL so applying it where the table
    // already exists is a no-op rather than a redefinition.
    for (const column of [
      'organization_id',
      'announcement_id',
      'message',
      'author_name',
      'author_role',
      'created_at',
      'updated_at',
    ]) {
      expect(migration).toContain(column);
    }
    expect(migration).toMatch(/references pilot\.organizations\(organization_id\)/i);
    expect(migration).toMatch(/primary key \(organization_id, announcement_id\)/i);
  });

  // The two runner families take OPPOSITE conventions, and getting this
  // backwards is not hypothetical: on 2026-07-30 a file was added to the
  // shadow-runtime runner without its own boundaries and took every migration
  // in that set down with it (#107).
  test('the migration carries no transaction boundary, because this runner opens one', () => {
    expect(migration).not.toMatch(/^\s*begin\s*;/im);
    expect(migration).not.toMatch(/^\s*commit\s*;/im);
    expect(runner).toContain("client.query('BEGIN')");
    expect(runner).toContain("client.query('COMMIT')");
    expect(runner).toContain("client.query('ROLLBACK')");
  });

  test('the runner reads this migration and verifies readiness before committing', () => {
    expect(runner).toContain('pilot_slice_postgres_announcements_migration.sql');
    expect(runner).toContain('ANNOUNCEMENTS_TABLE_NOT_READY');
    expect(runner).toContain('idx_pilot_announcements_org_created');
    expect(runner).toContain('POSTGRES_TARGET_MISMATCH');
    expect(runner).toContain('rejectUnauthorized: true');
  });

  // A migration nobody can dispatch is not in the migration path. Registration
  // takes three separate edits to one workflow, and the `all` list and the
  // list-check allowlist are both hand-maintained.
  test('the migration is dispatchable and covered by every hand-maintained list', () => {
    expect(packageJson.scripts['pilot:apply-announcements']).toBe(
      'node scripts/pilot-apply-announcements-migration.mjs',
    );

    // Offered as a workflow_dispatch choice.
    expect(workflow).toMatch(/^\s+- announcements$/m);

    // Included in `all`, and in the allowlist that `list-check` compares
    // pilot:apply-* scripts against.
    const allList = workflow.match(/for m in ([a-z0-9 -]+); do/);
    expect(allList?.[1]).toContain('announcements');

    const listCheck = workflow.match(/case " ([a-z0-9 -]+) " in/);
    expect(listCheck?.[1]).toContain('announcements');
  });
});
