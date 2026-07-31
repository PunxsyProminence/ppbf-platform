import fs from 'node:fs';
import path from 'node:path';

const repositoryRoot = path.resolve(__dirname, '../../../../..');

const migrationPath = path.join(
  repositoryRoot,
  'infra/azure/pilot_slice_postgres_video_sessions_migration.sql',
);
const runnerPath = path.join(
  repositoryRoot,
  'apps/web/scripts/pilot-apply-video-sessions-migration.mjs',
);
const routeDdlPath = path.join(
  repositoryRoot,
  'apps/web/app/api/pilot/admin/migrate-multiorg/route.ts',
);
const workflowPath = path.join(
  repositoryRoot,
  '.github/workflows/apply-migrations.yml',
);
const packageJsonPath = path.join(repositoryRoot, 'apps/web/package.json');

/** Column names from a `create table` body, ignoring constraint lines. */
function tableColumns(sql: string, table: string): string[] {
  const match = sql.match(
    new RegExp(`create table if not exists ${table}\\s*\\(([\\s\\S]*?)\\n\\s*\\)`, 'i'),
  );
  if (!match) {
    throw new Error(`${table} not found`);
  }
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^(primary key|constraint|unique|check|foreign key)/i.test(line))
    .map((line) => line.split(/\s+/)[0])
    .filter(Boolean);
}

describe('video_sessions schema ownership', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const runner = fs.readFileSync(runnerPath, 'utf8');
  const routeDdl = fs.readFileSync(routeDdlPath, 'utf8');
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  // The defect this closes: pilot.video_sessions had NO migration. Its only
  // definition was inside a 938-line HTTP route carrying 125 DDL statements,
  // so the table existed in an environment if and only if someone had once
  // POSTed to that route there -- the video feature's existence was a
  // property of deploy history rather than of the schema.
  test('the migration owns the table and BOTH indexes the route DDL created', () => {
    expect(migration).toMatch(/create table if not exists pilot\.video_sessions/i);
    expect(migration).toMatch(/create index if not exists idx_video_sessions_org_created/i);
    expect(migration).toMatch(/create index if not exists idx_video_sessions_athlete/i);
  });

  // Applying this to a live environment is safe because the COLUMNS match the
  // route's DDL exactly, so this compares them one by one rather than trusting
  // a hand-copied list. The status CHECK is the single deliberate divergence,
  // asserted separately below.
  test('the columns match the route DDL exactly', () => {
    const fromMigration = tableColumns(migration, 'pilot\\.video_sessions');
    const fromRoute = tableColumns(routeDdl, 'pilot\\.video_sessions');

    expect(fromRoute.length).toBeGreaterThan(0);
    expect(fromMigration).toEqual(fromRoute);
    expect(fromMigration).toEqual([
      'video_session_id',
      'organization_id',
      'uploaded_by_account_id',
      'athlete_id',
      'title',
      'notes',
      'blob_path',
      'file_name',
      'file_size_bytes',
      'mime_type',
      'status',
      'created_at',
      'updated_at',
    ]);
  });

  // The one place this migration deliberately does NOT copy the route DDL.
  // That CHECK allowed only ('uploaded','processing','ready','error',
  // 'archived') while the upload route inserts 'quarantined' and the read
  // path branches on 'infected' -- so every upload failed the constraint,
  // 100% of the time (proved against real Postgres in
  // videoSessionsMigration.pg.test.ts). Codifying the old list would have
  // cemented a total-failure bug into the migration path.
  test('the status CHECK admits the states the application actually writes', () => {
    for (const state of [
      'uploaded',
      'quarantined',
      'infected',
      'processing',
      'ready',
      'error',
      'archived',
    ]) {
      expect(migration).toContain(`'${state}'`);
    }

    // Existing environments already carry the old CHECK, and `create table if
    // not exists` cannot change them -- so the replacement must be explicit
    // and catalog-guarded (PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS).
    expect(migration).toMatch(/do \$\$/i);
    expect(migration).toContain('pg_constraint');
    expect(migration).toMatch(/drop constraint video_sessions_status_check/i);
    expect(migration).toMatch(/add constraint video_sessions_status_check/i);

    // Quarantine-on-upload is the safety posture; a row arriving without an
    // explicit status must not default to a nearly-servable state.
    expect(migration).toMatch(/alter column status set default 'quarantined'/i);
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
    expect(runner).toContain('pilot_slice_postgres_video_sessions_migration.sql');
    expect(runner).toContain('VIDEO_SESSIONS_TABLE_NOT_READY');
    // Readiness covers both indexes, not just the table: an environment that
    // got the table from the route but never the indexes must not pass.
    expect(runner).toContain('idx_video_sessions_org_created');
    expect(runner).toContain('idx_video_sessions_athlete');
    expect(runner).toContain('POSTGRES_TARGET_MISMATCH');
    expect(runner).toContain('rejectUnauthorized: true');
  });

  // A migration nobody can dispatch is not in the migration path. Registration
  // takes three separate edits to one workflow, and the `all` list and the
  // list-check allowlist are both hand-maintained.
  test('the migration is dispatchable and covered by every hand-maintained list', () => {
    expect(packageJson.scripts['pilot:apply-video-sessions']).toBe(
      'node scripts/pilot-apply-video-sessions-migration.mjs',
    );

    expect(workflow).toMatch(/^\s+- video-sessions$/m);

    const allList = workflow.match(/for m in ([a-z0-9 -]+); do/);
    expect(allList?.[1]).toContain('video-sessions');

    const listCheck = workflow.match(/case " ([a-z0-9 -]+) " in/);
    expect(listCheck?.[1]).toContain('video-sessions');
  });
});
