import fs from 'node:fs';
import path from 'node:path';

// The shipped drill-library seed CSVs carry two values that ONLY the
// vocabulary-widening migration permits: authoring_state='literature_grounded_draft'
// (228 rows) and rule_kind='warmup_decay' (63 rows). Any suite that runs
// seed-drill-library.mjs's seedAll against a database with only
// drill_library_v3 applied will abort on a CHECK violation.
//
// That is not hypothetical. Widening the vocabulary and un-parking the CSVs
// broke workoutTemplates.pg.test.ts, which seeds the real library through its
// own helper -- and because test:migrations is an &&-chain, the failure also
// hid every suite after it. drillLibraryV3.pg.test.ts had been fixed; this one
// was missed because nothing tied the CSVs' requirement to its consumers.
//
// This ties them. It is a source-level check, not a database one, so it costs
// nothing and runs in the fast suite rather than behind the pg chain.

const PILOT_DIR = __dirname;
const SEED_LOADER = 'seed-drill-library';
const WIDENING_MIGRATION = 'pilot_slice_postgres_drill_vocabulary_widening_migration.sql';

/** Suites that reference the loader but never call its seedAll. */
const DOES_NOT_SEED: Record<string, string> = {
  'sessionScriptsTransfer.pg.test.ts':
    'inserts minimal drill_library rows directly, deliberately avoiding seedAll -- '
    + 'that loader\'s single transaction would also seed the scale levels this suite '
    + 'is not testing, and roll them back together on any failure',
};

function pgTestsReferencingSeedLoader(): string[] {
  return fs
    .readdirSync(PILOT_DIR)
    .filter((f) => f.endsWith('.pg.test.ts'))
    .filter((f) => fs.readFileSync(path.join(PILOT_DIR, f), 'utf8').includes(SEED_LOADER));
}

describe('drill-library seed prerequisite', () => {
  const referencing = pgTestsReferencingSeedLoader();

  it('finds the suites that reference the seed loader at all', () => {
    // A broken scan would make the assertion below vacuously pass.
    expect(referencing.length).toBeGreaterThan(0);
    expect(referencing).toContain('drillLibraryV3.pg.test.ts');
  });

  it('every suite that seeds the real drill library also applies the widening migration', () => {
    const missing = referencing.filter((f) => {
      if (f in DOES_NOT_SEED) return false;
      return !fs.readFileSync(path.join(PILOT_DIR, f), 'utf8').includes(WIDENING_MIGRATION);
    });

    // Fix by applying the widening SQL alongside drill_library_v3 in that
    // suite's setup -- or, if it does not actually call seedAll, by adding it
    // to DOES_NOT_SEED with the reason.
    expect(missing).toEqual([]);
  });

  it('does not carry an exemption for a suite that no longer references the loader', () => {
    const stale = Object.keys(DOES_NOT_SEED).filter((f) => !referencing.includes(f));
    expect(stale).toEqual([]);
  });

  it('the widening migration it points at actually exists', () => {
    const infra = path.resolve(__dirname, '../../../../../infra/azure', WIDENING_MIGRATION);
    expect(fs.existsSync(infra)).toBe(true);
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
