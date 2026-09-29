import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { datasetsFor, parseCliArgs, readDatabaseEnv, readDatasetFiles, runValidateCommitted, seedSslConfig } from './contentImport/cli';
import { LOADABLE_DATASETS } from './contentImport/datasets';

// The argument and environment rules of `plan` and `apply`, the database
// commands of scripts/pilot-content-import.ts. Checked here, with no database,
// because every one of them is decided before a connection is opened: a
// mistyped dataset or a missing variable should cost no network at all, and a
// guessed organization or account is the failure the seed loaders were built
// to refuse (the retired seed-*.mjs loaders once defaulted it).

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
    expect(datasetsFor('all')).toEqual([
      'disciplines',
      'competence-levels',
      'cohort-definitions',
      'drill-library',
      'universal-stop-rules',
      'workout-templates',
      'session-scripts',
    ]);
    expect(datasetsFor('all')).toEqual([...LOADABLE_DATASETS]);
    expect(datasetsFor('cohort-definitions')).toEqual(['cohort-definitions']);
    expect(datasetsFor('drill-library')).toEqual(['drill-library']);
    expect(() => datasetsFor('transfer-claims')).toThrow('transfer-claims has no database loader');
    expect(() => datasetsFor('competence-cohorts')).toThrow('unknown dataset competence-cohorts');
  });

  it('a comma-separated list is loaded together, in apply order whatever order it was typed in', () => {
    // npm run seed:competence-cohorts: one seed-data folder, two datasets, one
    // transaction (runApply takes the whole list).
    expect(datasetsFor('cohort-definitions,competence-levels')).toEqual(['competence-levels', 'cohort-definitions']);
    expect(datasetsFor('workout-templates, drill-library ,disciplines')).toEqual(['disciplines', 'drill-library', 'workout-templates']);
    expect(() => datasetsFor('disciplines,disciplines')).toThrow('named twice');
    expect(() => datasetsFor('all,disciplines')).toThrow("'all' cannot be combined");
    expect(() => datasetsFor('disciplines,transfer-claims')).toThrow('transfer-claims has no database loader');
    expect(() => datasetsFor('disciplines,')).toThrow('unknown dataset (empty)');
  });

  it('validate takes --dataset for the committed files a load would read, or --dir for a hand-off, never both', () => {
    expect(parseCliArgs(['validate', '--dataset', 'all'])).toEqual({ command: 'validate', dataset: 'all', write: false, dryRun: false });
    expect(parseCliArgs(['validate', '--dir', 'x'])).toEqual({ command: 'validate', dir: 'x', write: false, dryRun: false });
    expect(() => parseCliArgs(['validate', '--dir', 'x', '--dataset', 'all'])).toThrow('not both');
    expect(() => parseCliArgs(['validate'])).toThrow('validate needs --dir <path>');
    expect(() => parseCliArgs(['prepare', '--dir', 'x', '--dataset', 'all'])).toThrow('prepare does not take --dataset');
  });

  it('reads only the committed files of the datasets asked for', () => {
    const files = readDatasetFiles(`${__dirname}/../../../seed-data`, ['competence-levels', 'cohort-definitions']);
    expect(Object.keys(files).sort()).toEqual([
      'competence-cohorts/seed_cohort_definitions.csv',
      'competence-cohorts/seed_competence_levels.csv',
    ]);
  });
});

describe('validate --dataset: the committed files, offline', () => {
  const SEED_DATA_DIR = path.resolve(__dirname, '../../../seed-data');
  const io = () => {
    const lines: string[] = [];
    return { lines, log: (line: string) => lines.push(line) };
  };

  it("passes every dataset 'all' loads today -- what the seed workflow checks before its Azure login", () => {
    const out = io();
    expect(runValidateCommitted({ seedDataDir: SEED_DATA_DIR, datasets: datasetsFor('all') }, out)).toBe(0);
    expect(out.lines[out.lines.length - 1]).toMatch(/^RESULT: PASS -- 0 blocking/);
    expect(out.lines.some((line) => line.includes('read drill-library/seed_drill_library.csv'))).toBe(true);
  });

  it('blocks when a committed file a load would read breaks the contract, naming it', () => {
    // A scratch copy of the committed tree with one bad row: exactly what a
    // dispatch from an unmerged branch could carry.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-validate-committed-'));
    try {
      fs.cpSync(SEED_DATA_DIR, dir, { recursive: true });
      const file = path.join(dir, 'multidiscipline/seed_disciplines.csv');
      const text = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, `${text.replace(/\n$/, '')}\n{{PPBF_ORG_ID}},karate,Karate,not-a-lane,none,,,true,true,false,,true\n`);
      const out = io();
      expect(runValidateCommitted({ seedDataDir: dir, datasets: ['disciplines'] }, out)).toBe(1);
      expect(out.lines.some((line) => line.startsWith('  [unknown_value] multidiscipline/seed_disciplines.csv:'))).toBe(true);
      expect(out.lines[out.lines.length - 1]).toMatch(/^RESULT: BLOCKED -- /);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
