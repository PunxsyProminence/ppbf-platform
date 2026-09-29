import { datasetsFor, parseCliArgs, readDatabaseEnv, readDatasetFiles, seedSslConfig } from './contentImport/cli';
import { LOADABLE_DATASETS } from './contentImport/datasets';

// The argument and environment rules of `plan` and `apply`, the database
// commands of scripts/pilot-content-import.ts. Checked here, with no database,
// because every one of them is decided before a connection is opened: a
// mistyped dataset or a missing variable should cost no network at all, and a
// guessed organization or account is the failure the seed loaders were built
// to refuse (seed-disciplines.mjs:224-226, "No default").

describe('plan and apply arguments', () => {
  it('plan and apply take --dataset <name|all>; apply alone takes --dry-run', () => {
    expect(parseCliArgs(['plan', '--dataset', 'all'])).toEqual({ command: 'plan', dataset: 'all', write: false, dryRun: false });
    expect(parseCliArgs(['apply', '--dry-run', '--dataset=disciplines'])).toEqual({
      command: 'apply',
      dataset: 'disciplines',
      write: false,
      dryRun: true,
    });
    expect(() => parseCliArgs(['plan'])).toThrow('plan needs --dataset <name|all>');
    expect(() => parseCliArgs(['plan', '--dataset', 'all', '--dry-run'])).toThrow('plan never writes');
    // They load what the PR merged, never a folder a person points at.
    expect(() => parseCliArgs(['apply', '--dataset', 'all', '--dir', 'x'])).toThrow('reads the committed seed-data');
    expect(() => parseCliArgs(['validate', '--dir', 'x', '--dry-run'])).toThrow('validate does not take --dry-run');
    expect(() => parseCliArgs(['load'])).toThrow('plan --dataset <name|all>');
  });

  it("'all' is every dataset the engine loads, in dependency order; a dataset it cannot load yet is named as such", () => {
    expect(datasetsFor('all')).toEqual(['disciplines', 'competence-levels', 'cohort-definitions', 'drill-library', 'universal-stop-rules']);
    expect(datasetsFor('all')).toEqual([...LOADABLE_DATASETS]);
    expect(datasetsFor('cohort-definitions')).toEqual(['cohort-definitions']);
    expect(datasetsFor('drill-library')).toEqual(['drill-library']);
    expect(() => datasetsFor('transfer-claims')).toThrow('transfer-claims has no database loader');
    expect(() => datasetsFor('competence-cohorts')).toThrow('unknown dataset competence-cohorts');
  });

  it('reads only the committed files of the datasets asked for', () => {
    const files = readDatasetFiles(`${__dirname}/../../../seed-data`, ['competence-levels', 'cohort-definitions']);
    expect(Object.keys(files).sort()).toEqual([
      'competence-cohorts/seed_cohort_definitions.csv',
      'competence-cohorts/seed_competence_levels.csv',
    ]);
  });
});

describe('plan and apply environment', () => {
  const full = {
    AZURE_POSTGRES_CONNECTION_STRING: 'postgres://u:p@db.example:5432/ppbf',
    PPBF_SEED_ORG_ID: 'punxsy_prominence',
    PPBF_SEED_ACCOUNT_ID: 'ppbf@punxsyprominence.org',
  };

  it('needs the connection, the organization and the account, with no defaults', () => {
    expect(readDatabaseEnv(full)).toEqual({
      connectionString: full.AZURE_POSTGRES_CONNECTION_STRING,
      organizationId: 'punxsy_prominence',
      actorAccountId: 'ppbf@punxsyprominence.org',
    });
    for (const name of Object.keys(full)) {
      expect(() => readDatabaseEnv({ ...full, [name]: '  ' })).toThrow(`Missing required environment variable: ${name}`);
    }
  });

  it('keeps TLS on unless a test run asks for it off', () => {
    expect(seedSslConfig({})).toEqual({ rejectUnauthorized: true });
    expect(seedSslConfig({ PPBF_POSTGRES_DISABLE_SSL: 'true' })).toEqual({ rejectUnauthorized: true });
    expect(seedSslConfig({ NODE_ENV: 'test', PPBF_POSTGRES_DISABLE_SSL: 'true' })).toBe(false);
  });
});
