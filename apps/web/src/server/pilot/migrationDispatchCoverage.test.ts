/**
 * Every migration SQL file must be dispatchable.
 *
 * The workflow already guarded the forward direction -- every `pilot:apply-*`
 * npm script appears in the `all` list -- and that guard was structurally blind
 * to the failure it most needed to catch. A migration with no npm script has
 * nothing for it to check, so seven of them sat in `infra/azure` reachable by
 * nothing at all:
 *
 *   onboarding                 account_activation_tokens
 *   shadow-evidence            4 tables + 4 tenant-identity unique indexes
 *   shadow-decision-loop       6 tables
 *   shadow-job-lease           shadow_jobs.lease_token / lease_expires_at
 *   shadow-chunk-embedding     shadow_library_chunks.embedding
 *   shadow-formula-foundation  columns across all three formula tables
 *   board-role                 the constraints that admit the 'board' role
 *
 * All seven are read or written by live application code, so a rebuilt
 * environment was missing eleven tables and four sets of columns the platform
 * queries -- including the SHADOW chat persistence path and the job queue's
 * lease.
 *
 * This test asserts the direction that catches that: start from the SQL on
 * disk, not from the scripts. A migration file is only real if an operator can
 * dispatch it, and it is only in the rebuild path if `all` names it.
 */
import fs from 'node:fs';
import path from 'node:path';

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const infraDir = path.join(repositoryRoot, 'infra/azure');
const scriptsDir = path.join(repositoryRoot, 'apps/web/scripts');
const workflowPath = path.join(repositoryRoot, '.github/workflows/apply-migrations.yml');
const packageJsonPath = path.join(repositoryRoot, 'apps/web/package.json');

/**
 * Migration slugs whose SQL filename does not mechanically produce the name the
 * workflow uses. Kept as an explicit map rather than a looser derivation, so a
 * new mismatch is a decision someone records here rather than a silent miss.
 */
const SLUG_OVERRIDES: Record<string, string> = {
  'scheduler_registration_race': 'scheduler-race',
  'sparring_exposure_and_load': 'sparring-exposure',
};

function slugFor(sqlFileName: string): string {
  const stem = sqlFileName
    .replace(/^pilot_slice_postgres_/, '')
    .replace(/_migration\.sql$/, '');
  return SLUG_OVERRIDES[stem] ?? stem.replace(/_/g, '-');
}

const migrationFiles = fs
  .readdirSync(infraDir)
  .filter((name) => /^pilot_slice_postgres_.+_migration\.sql$/.test(name))
  .sort();

const workflow = fs.readFileSync(workflowPath, 'utf8');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
  scripts: Record<string, string>;
};

const allList = workflow.match(/for m in ([a-z0-9 -]+); do/)?.[1].split(' ').filter(Boolean) ?? [];
const allowList = workflow.match(/case " ([a-z0-9 -]+) " in/)?.[1].split(' ').filter(Boolean) ?? [];

describe('every migration is dispatchable and in the rebuild path', () => {
  test('the migration set is non-empty and the workflow lists parsed', () => {
    // Guards the guard: a regex that silently stopped matching would make every
    // assertion below vacuous.
    expect(migrationFiles.length).toBeGreaterThan(20);
    expect(allList.length).toBeGreaterThan(20);
    expect(allowList.length).toBeGreaterThan(20);
  });

  test.each(migrationFiles)('%s has a runner, a script, and is in `all`', (fileName) => {
    const slug = slugFor(fileName);

    const runner = path.join(scriptsDir, `pilot-apply-${slug}-migration.mjs`);
    expect(fs.existsSync(runner)).toBe(true);

    // The runner must read the migration it claims to apply. A copy-pasted
    // runner pointing at its template's SQL would pass every other check here
    // while applying the wrong file.
    const runnerSource = fs.readFileSync(runner, 'utf8');
    expect(runnerSource).toContain(fileName);

    // Naming the file is not the same as reaching it. The data-retention-deletion
    // runner shipped with '../../infra/azure', which resolves to apps/infra/azure
    // -- it passed the assertion above, passed CI, and died with ENOENT against
    // staging, because nothing here had ever checked the path depth. Every runner
    // sits at apps/web/scripts, so infra/azure is exactly three levels up.
    expect(runnerSource).toContain('../../../infra/azure');

    expect(packageJson.scripts[`pilot:apply-${slug}`]).toBe(
      `node scripts/pilot-apply-${slug}-migration.mjs`,
    );

    expect(allList).toContain(slug);
    expect(allowList).toContain(slug);

    // The dropdown is what an operator actually picks from; a migration absent
    // from it can only ever be run as part of `all`.
    expect(workflow).toMatch(new RegExp(`^\\s+- ${slug}$`, 'm'));
  });

  test('`all` and the allowlist agree, so neither can drift alone', () => {
    // `schema` is deliberately in the allowlist and not in `all`: the base
    // schema is applied to a new environment, not re-run across every existing
    // one. It is the only permitted difference.
    expect(allowList.filter((entry) => !allList.includes(entry))).toEqual(['schema']);
    expect(allList.filter((entry) => !allowList.includes(entry))).toEqual([]);
  });

  test('every `all` entry is a real migration file', () => {
    const slugs = new Set(migrationFiles.map(slugFor));
    expect(allList.filter((entry) => !slugs.has(entry))).toEqual([]);
  });

  test('a migration that alters a table runs after the migration that creates it', () => {
    // shadow-runtime creates the SHADOW tables the four column migrations widen,
    // and multiorg creates the organization columns board-role and onboarding
    // depend on. Ordering is only expressible in the `all` loop, and getting it
    // wrong fails a rebuild at the first ALTER against a missing table.
    const at = (slug: string) => allList.indexOf(slug);
    for (const dependent of [
      'research-triage-view',
      'shadow-evidence',
      'shadow-decision-loop',
      'shadow-chunk-embedding',
      'shadow-formula-foundation',
      'shadow-job-lease',
    ]) {
      expect(at(dependent)).toBeGreaterThan(at('shadow-runtime'));
    }
    for (const dependent of ['onboarding', 'board-role']) {
      expect(at(dependent)).toBeGreaterThan(at('multiorg'));
    }
  });
});
