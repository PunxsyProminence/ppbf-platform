import fs from 'node:fs';
import path from 'node:path';

// The shipped drill-library seed CSVs carry two values that ONLY the
// vocabulary-widening migration permits: authoring_state='literature_grounded_draft'
// and rule_kind='warmup_decay'. Any suite that loads the committed drill
// library into a database without that migration aborts on a CHECK violation.
//
// That is not hypothetical. Widening the vocabulary and un-parking the CSVs
// broke workoutTemplates.pg.test.ts, which seeded the real library through its
// own helper -- and because test:migrations was an &&-chain, the failure also
// hid every suite after it. Nothing tied the CSVs' requirement to their
// consumers.
//
// This ties them. Since IMP-10 the committed library loads through the
// content-import core (the seed-*.mjs loaders are retired), and a suite that
// loads it either builds the schema production runs -- scripts/lib/full-schema.mjs,
// directly or through src/testing/referenceContentFixture.ts, which carries
// every migration in the workflow's order, the widening included -- or applies
// the widening migration by name. It is a source-level check, not a database
// one, so it costs nothing and runs in the fast suite.

const PILOT_DIR = __dirname;
const SCRIPTS_DIR = path.resolve(__dirname, '../../../scripts');
const WIDENING_MIGRATION = 'pilot_slice_postgres_drill_vocabulary_widening_migration.sql';
const APPLY_MIGRATIONS = path.resolve(__dirname, '../../../../../.github/workflows/apply-migrations.yml');

/**
 * A suite loads the COMMITTED drill library when it names its files or folder,
 * or hands the content-import core a dataset list containing drill-library
 * (or 'all'). Migration names such as drill-library-v3 do not match.
 */
const LOADS_COMMITTED_LIBRARY =
  /seed_drill_library\.csv|seed-data\/drill-library|'drill-library\/|'(?:[a-z-]+,)*drill-library(?:,[a-z-]+)*'|datasets: 'all'|--dataset', 'all'/;

/** Builds the schema production runs, which includes the widening migration. */
const BUILDS_FULL_SCHEMA = /full-schema\.mjs|openFullSchemaDatabase|applyFullSchema/;

/** Suites that name the committed library but never load it, with the reason. */
const DOES_NOT_LOAD: Record<string, string> = {};

/** Every pg suite (both folders pgTestCoverage.test.ts scans) that loads it: basename -> source. */
function pgTestsLoadingCommittedLibrary(): Map<string, string> {
  const files = [
    ...fs.readdirSync(PILOT_DIR).filter((f) => f.endsWith('.pg.test.ts')).map((f) => path.join(PILOT_DIR, f)),
    ...fs.readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.pg.test.ts')).map((f) => path.join(SCRIPTS_DIR, f)),
  ];
  const out = new Map<string, string>();
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (LOADS_COMMITTED_LIBRARY.test(source)) out.set(path.basename(file), source);
  }
  return out;
}

describe('drill-library seed prerequisite', () => {
  const sources = pgTestsLoadingCommittedLibrary();
  const loading = [...sources.keys()].sort();

  it('finds the suites that load the committed drill library at all', () => {
    // A broken scan would make the assertion below vacuously pass.
    expect(loading).toEqual(expect.arrayContaining(['drillLibraryV3.pg.test.ts', 'workoutTemplates.pg.test.ts', 'contentImportDrills.pg.test.ts']));
  });

  it('does not count a migration name as loading the library', () => {
    expect(LOADS_COMMITTED_LIBRARY.test("'drill-library-v3'")).toBe(false);
    expect(LOADS_COMMITTED_LIBRARY.test("datasets: 'disciplines,drill-library'")).toBe(true);
  });

  it('every suite that loads the committed drill library builds the full schema or applies the widening migration', () => {
    const missing = loading.filter((file) => {
      if (file in DOES_NOT_LOAD) return false;
      const source = sources.get(file) as string;
      return !BUILDS_FULL_SCHEMA.test(source) && !source.includes(WIDENING_MIGRATION);
    });

    // Fix by loading into openFullSchemaDatabase (src/testing/referenceContentFixture.ts),
    // or by applying the widening SQL in that suite's setup -- or, if it does
    // not actually load the library, by adding it to DOES_NOT_LOAD with the reason.
    expect(missing).toEqual([]);
  });

  it('does not carry an exemption for a suite that no longer names the library', () => {
    const stale = Object.keys(DOES_NOT_LOAD).filter((f) => !loading.includes(f));
    expect(stale).toEqual([]);
  });

  it('the widening migration it points at exists, and the full schema applies it', () => {
    const infra = path.resolve(__dirname, '../../../../../infra/azure', WIDENING_MIGRATION);
    expect(fs.existsSync(infra)).toBe(true);
    // full-schema.mjs applies the apply-migrations `all` list in order; the
    // widening must be on it for "builds the full schema" to count above.
    expect(fs.readFileSync(APPLY_MIGRATIONS, 'utf8')).toMatch(/for m in [^\n]* drill-vocabulary-widening /);
  });

  it('the seed CSVs still contain the values that make the widening necessary', () => {
    // If these ever stop appearing, the prerequisite is gone and this whole
    // guard should be deleted rather than left asserting a dead rule.
    const seedDir = path.resolve(__dirname, '../../../seed-data/drill-library');
    const scales = fs.readFileSync(path.join(seedDir, 'seed_drill_scale_levels.csv'), 'utf8');
    const rules = fs.readFileSync(path.join(seedDir, 'seed_drill_stop_rules.csv'), 'utf8');

    expect(scales).toContain('literature_grounded_draft');
    expect(rules).toContain('warmup_decay');
  });
});
