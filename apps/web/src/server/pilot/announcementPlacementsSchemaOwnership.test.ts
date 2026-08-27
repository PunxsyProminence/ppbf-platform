import fs from 'node:fs';
import path from 'node:path';

const repositoryRoot = path.resolve(__dirname, '../../../../..');

const migrationPath = path.join(
  repositoryRoot,
  'infra/azure/pilot_slice_postgres_announcement_placements_migration.sql',
);
const runnerPath = path.join(
  repositoryRoot,
  'apps/web/scripts/pilot-apply-announcement-placements-migration.mjs',
);
const workflowPath = path.join(
  repositoryRoot,
  '.github/workflows/apply-migrations.yml',
);
const packageJsonPath = path.join(repositoryRoot, 'apps/web/package.json');

describe('announcement placements schema ownership', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const runner = fs.readFileSync(runnerPath, 'utf8');
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  test('every column is added conditionally, so re-running is a no-op', () => {
    for (const column of ['placement', 'kind', 'active', 'starts_at', 'ends_at']) {
      expect(migration).toMatch(
        new RegExp(`add column if not exists ${column}\\b`, 'i'),
      );
    }
    // The three defaults are what backfill pre-existing rows into visible gym
    // notices; dropping either half of `not null default` strands them outside
    // a placement-filtered read.
    expect(migration).toMatch(/placement text not null default 'gym_notices'/i);
    expect(migration).toMatch(/kind text not null default 'notice'/i);
    expect(migration).toMatch(/active boolean not null default true/i);
  });

  test('both vocabularies are constrained, and both constraints are catalog-guarded', () => {
    // PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS, so an unguarded
    // constraint makes the second run fail rather than no-op.
    for (const constraint of [
      'pilot_announcements_placement_check',
      'pilot_announcements_kind_check',
    ]) {
      expect(migration).toContain(constraint);
      expect(migration).toMatch(
        new RegExp(`from pg_constraint\\s+where conname = '${constraint}'`, 'i'),
      );
    }
    expect(migration).toMatch(
      /check \(placement in \('gym_notices', 'athlete_workspace', 'coach_workspace', 'everywhere'\)\)/i,
    );
    expect(migration).toMatch(/check \(kind in \('notice', 'motivation'\)\)/i);
  });

  test('the read path index exists and is created conditionally', () => {
    expect(migration).toMatch(
      /create index if not exists idx_pilot_announcements_org_placement_kind_active_created\s+on pilot\.announcements\(organization_id, placement, kind, active, created_at desc\)/i,
    );
  });

  // The two runner families take OPPOSITE conventions: a file that carries its
  // own boundaries breaks the runners that open the transaction themselves.
  test('the migration carries no transaction boundary, because this runner opens one', () => {
    expect(migration).not.toMatch(/^\s*begin\s*;/im);
    expect(migration).not.toMatch(/^\s*commit\s*;/im);
    expect(runner).toContain("client.query('BEGIN')");
    expect(runner).toContain("client.query('COMMIT')");
    expect(runner).toContain("client.query('ROLLBACK')");
  });

  test('the runner reads this migration and verifies readiness before committing', () => {
    expect(runner).toContain('pilot_slice_postgres_announcement_placements_migration.sql');
    expect(runner).toContain('ANNOUNCEMENT_PLACEMENT_COLUMNS_NOT_READY');
    expect(runner).toContain('idx_pilot_announcements_org_placement_kind_active_created');
    expect(runner).toContain('pilot_announcements_placement_check');
    expect(runner).toContain('pilot_announcements_kind_check');
    expect(runner).toContain('POSTGRES_TARGET_MISMATCH');
    expect(runner).toContain('rejectUnauthorized: true');
  });

  // A migration nobody can dispatch is not in the migration path. Registration
  // takes three separate edits to one workflow, and the `all` list and the
  // list-check allowlist are both hand-maintained.
  test('the migration is dispatchable and covered by every hand-maintained list', () => {
    expect(packageJson.scripts['pilot:apply-announcement-placements']).toBe(
      'node scripts/pilot-apply-announcement-placements-migration.mjs',
    );
    // `test:migrations` no longer names suites: it delegates to
    // scripts/run-migration-suites.mjs, which discovers every
    // `test:migrations:*` script. So the thing to assert is that the SCRIPT
    // exists -- under discovery, existing IS being run, and there is no
    // longer a list it can be absent from.
    expect(packageJson.scripts['test:migrations:announcement-placements']).toBeDefined();
    expect(packageJson.scripts['test:migrations']).toBe('node scripts/run-migration-suites.mjs');
    expect(packageJson.scripts['test:migrations:announcement-placements']).toContain(
      'src/server/pilot/announcementPlacements.pg.test.ts',
    );

    expect(workflow).toMatch(/^\s+- announcement-placements$/m);

    const allList = workflow.match(/for m in ([a-z0-9 -]+); do/)?.[1].split(' ');
    expect(allList).toContain('announcement-placements');

    const listCheck = workflow.match(/case " ([a-z0-9 -]+) " in/)?.[1].split(' ');
    expect(listCheck).toContain('announcement-placements');

    // This file only ALTERs pilot.announcements, so the migration that creates
    // the table has to run first.
    expect(allList!.indexOf('announcements')).toBeLessThan(
      allList!.indexOf('announcement-placements'),
    );
  });
});
