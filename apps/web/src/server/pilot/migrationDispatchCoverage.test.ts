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
    // platform-library-scope splits shadow_evidence_items.organization_id into
    // two columns, and shadow-evidence is the migration that creates the table
    // and the library foreign keys it repoints.
    expect(at('platform-library-scope')).toBeGreaterThan(at('shadow-evidence'));
    // medical-clearance-expiry adds expires_at to
    // pilot.shadow_medical_administrative_status, which shadow-decision-loop
    // creates. Applied first, a rebuild dies on ALTER against a missing table.
    expect(at('medical-clearance-expiry')).toBeGreaterThan(at('shadow-decision-loop'));
    // film-study-coach-reported widens shadow_film_study_proposals -- adding
    // origin, the reporter, the correction column and the 'corrected' verdict
    // -- against the table film-study-proposals creates.
    expect(at('film-study-coach-reported')).toBeGreaterThan(at('film-study-proposals'));
    /* athlete-development-block-competition-target ALTERs
       pilot.athlete_development_blocks and points it at
       pilot.external_competitions and pilot.wrestling_league_events, so all
       three have to exist first. Applied before any of them, a rebuild dies
       on the ALTER or on the foreign key. */
    expect(at('athlete-development-block-competition-target'))
      .toBeGreaterThan(at('athlete-development-blocks'));
    expect(at('athlete-development-block-competition-target'))
      .toBeGreaterThan(at('external-competition'));
    expect(at('athlete-development-block-competition-target'))
      .toBeGreaterThan(at('wrestling-league'));
    /* coach-development hangs both of its tables off
       pilot.organization_memberships with a composite FK, and multiorg is the
       migration that creates that table. Applied before it, a rebuild dies on
       the foreign key -- and this ordering is easy to get wrong precisely
       because the base schema ALSO declares organization_memberships, so a
       reader checking pilot_slice_postgres.sql would conclude no dependency
       exists. The `all` loop is applied to environments that already have the
       base schema, and multiorg is where that table's current shape comes
       from. */
    expect(at('coach-development')).toBeGreaterThan(at('multiorg'));
    /* session-block-link joins pilot.session_script_runs to
       pilot.athlete_development_blocks with a composite FK into each, so both
       have to exist first. The session-scripts dependency is the one a reader
       is likeliest to miss: this migration's name says "block", and nothing in
       it mentions scripts. */
    expect(at('session-block-link')).toBeGreaterThan(at('session-scripts'));
    expect(at('session-block-link')).toBeGreaterThan(at('athlete-development-blocks'));
    /* session-objective-link's two composite FKs point at the objectives table
       and at session-block-link's own table, so BOTH have to exist first. It
       also adds a unique index to pilot.athlete_development_block_objectives,
       which is a second reason that migration cannot come later. */
    expect(at('session-objective-link'))
      .toBeGreaterThan(at('athlete-development-block-objectives'));
    expect(at('session-objective-link')).toBeGreaterThan(at('session-block-link'));
    // session-scripts-discipline-fk points pilot.session_scripts at
    // pilot.disciplines. It needs BOTH: multidiscipline creates the registry it
    // references, session-scripts creates the table it constrains. Applied
    // before either, a rebuild dies on ALTER against a missing table -- and
    // this is the ordering a fresh environment depends on, because
    // multidiscipline sits at 62 while the table it constrains was created at
    // 63 and the drill library it does NOT constrain at 49.
    for (const prerequisite of ['multidiscipline', 'session-scripts']) {
      expect(at('session-scripts-discipline-fk')).toBeGreaterThan(at(prerequisite));
    }
    // drill-library-discipline-fk is the same shape and the ordering is LESS
    // obvious, which is exactly why it is asserted: drill-library-v3 creates
    // the table at 49, and the registry it must now reference is not created
    // until 62. Anyone grouping this migration next to the table it constrains
    // would place it thirteen entries too early, and a rebuild would die on
    // ALTER against a pilot.disciplines that does not exist yet.
    for (const prerequisite of ['multidiscipline', 'drill-library-v3']) {
      expect(at('drill-library-discipline-fk')).toBeGreaterThan(at(prerequisite));
    }
    // cohort-definitions-discipline-fk completes the set. competence-cohorts
    // creates the table it constrains; multidiscipline creates the registry.
    for (const prerequisite of ['multidiscipline', 'competence-cohorts']) {
      expect(at('cohort-definitions-discipline-fk')).toBeGreaterThan(at(prerequisite));
    }
    // athlete-check-in-measures adds the six extended-check-in columns to
    // pilot.athlete_check_ins, which athlete-check-ins creates. The owner's
    // growth model for this table is one migration per measure decided, so
    // this is the first of a series that will all sit behind the same
    // prerequisite -- asserting it once here is what stops the next one being
    // grouped next to its sibling instead of after its table.
    expect(at('athlete-check-in-measures')).toBeGreaterThan(at('athlete-check-ins'));
  });
});
