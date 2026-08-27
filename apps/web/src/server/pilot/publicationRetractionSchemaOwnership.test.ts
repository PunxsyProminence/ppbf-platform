import fs from 'node:fs';
import path from 'node:path';

const repositoryRoot = path.resolve(__dirname, '../../../../..');

const migrationPath = path.join(
  repositoryRoot,
  'infra/azure/pilot_slice_postgres_publication_retraction_migration.sql',
);
const runnerPath = path.join(
  repositoryRoot,
  'apps/web/scripts/pilot-apply-publication-retraction-migration.mjs',
);
const workflowPath = path.join(
  repositoryRoot,
  '.github/workflows/apply-migrations.yml',
);
const packageJsonPath = path.join(repositoryRoot, 'apps/web/package.json');

describe('publication retraction schema ownership', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const runner = fs.readFileSync(runnerPath, 'utf8');
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  test('the status constraint is replaced by column scan, not by trusting a generated name', () => {
    // The publications migration wrote the CHECK inline, so Postgres named
    // it. Dropping by a guessed name would silently no-op wherever the name
    // differs, leaving the old six-value constraint conjoined with the new
    // one and every retraction failing. Same doctrine as the
    // drill-vocabulary-widening migration.
    expect(migration).toMatch(/from pg_constraint con/i);
    expect(migration).toMatch(/pg_get_constraintdef\(con\.oid\) ilike '%status%'/i);
    expect(migration).toMatch(/add constraint pilot_video_publications_status_check/i);
    expect(migration).toContain(
      "check (status in ('draft', 'pending_review', 'approved', 'published', 'rejected', 'archived', 'retracted'))",
    );
  });

  test('the whole swap is guarded so all-loop replays are catalog no-ops', () => {
    expect(migration).toMatch(/pg_get_constraintdef\(oid\) like '%retracted%'/i);
  });

  test('suppression columns are added conditionally and the live index is partial', () => {
    for (const column of ['suppressed_at', 'suppressed_by_account_id', 'suppressed_reason']) {
      expect(migration).toMatch(new RegExp(`add column if not exists ${column}\\b`, 'i'));
    }
    expect(migration).toMatch(
      /create index if not exists idx_research_library_live\s+on pilot\.research_library\(organization_id, published_at desc\)\s+where suppressed_at is null and archived_at is null/i,
    );
  });

  // The two runner families take OPPOSITE conventions: a file that carries
  // its own boundaries breaks the runners that open the transaction
  // themselves.
  test('the migration carries no transaction boundary, because this runner opens one', () => {
    expect(migration).not.toMatch(/^\s*begin\s*;/im);
    expect(migration).not.toMatch(/^\s*commit\s*;/im);
    expect(runner).toContain("client.query('BEGIN')");
    expect(runner).toContain("client.query('COMMIT')");
    expect(runner).toContain("client.query('ROLLBACK')");
  });

  test('the runner reads this migration and verifies readiness before committing', () => {
    expect(runner).toContain('pilot_slice_postgres_publication_retraction_migration.sql');
    expect(runner).toContain('PUBLICATION_RETRACTION_NOT_READY');
    expect(runner).toContain('pilot_video_publications_status_check');
    expect(runner).toContain('retracted');
    expect(runner).toContain('suppressed_at');
    expect(runner).toContain('idx_research_library_live');
    expect(runner).toContain('POSTGRES_TARGET_MISMATCH');
    expect(runner).toContain('rejectUnauthorized: true');
  });

  // A migration nobody can dispatch is not in the migration path.
  // Registration takes three separate edits to one workflow, and the `all`
  // list and the list-check allowlist are both hand-maintained.
  test('the migration is dispatchable and covered by every hand-maintained list', () => {
    expect(packageJson.scripts['pilot:apply-publication-retraction']).toBe(
      'node scripts/pilot-apply-publication-retraction-migration.mjs',
    );
    // `test:migrations` no longer names suites: it delegates to
    // scripts/run-migration-suites.mjs, which discovers every
    // `test:migrations:*` script. So the thing to assert is that the SCRIPT
    // exists -- under discovery, existing IS being run, and there is no
    // longer a list it can be absent from.
    expect(packageJson.scripts['test:migrations:publication-retraction']).toBeDefined();
    expect(packageJson.scripts['test:migrations']).toBe('node scripts/run-migration-suites.mjs');
    expect(packageJson.scripts['test:migrations:publication-retraction']).toContain(
      'src/server/pilot/publicationRetraction.pg.test.ts',
    );

    expect(workflow).toMatch(/^\s+- publication-retraction$/m);

    const allList = workflow.match(/for m in ([a-z0-9 -]+); do/)?.[1].split(' ');
    expect(allList).toContain('publication-retraction');

    const listCheck = workflow.match(/case " ([a-z0-9 -]+) " in/)?.[1].split(' ');
    expect(listCheck).toContain('publication-retraction');

    // This file only alters what the publications migration creates, so
    // that migration has to run first.
    expect(allList!.indexOf('publications')).toBeLessThan(
      allList!.indexOf('publication-retraction'),
    );
  });
});
