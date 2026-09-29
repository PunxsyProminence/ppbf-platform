import fs from 'node:fs';
import path from 'node:path';

import { datasetsFor, formatPlan, parseCliArgs, readDatabaseEnv } from './contentImport/cli';
import { writeCsv } from './contentImport/csv';
import { LOADABLE_DATASETS, UNIT_OUTCOMES } from './contentImport/datasets';
import type { ImportPlan } from './contentImport/plan';
import { loadOfflineReferenceSets, readCommittedBaseline } from './contentImport/referenceSets';
import { committedPath, DATASETS, fileSpecByName } from './contentImport/specs';
import type { DatasetName, ParsedPackage, RowValues } from './contentImport/types';
import { validatePackage, validateParsed } from './contentImport/validate';

// seed-reference-data.yml is how reference content reaches a real database
// (R1 route 3: files handed over, validated, committed by PR, loaded by this
// workflow). Since IMP-10 every dataset goes through ONE loader, the
// content-import core, by one CLI call (scripts/pilot-content-import.ts). This
// file ties the workflow to that CLI at the source level, the way the workflow
// used to be tied to seven copied seed-*.mjs loaders.
//
// Why source-level at all: the failures it guards leave the YAML perfectly
// valid. The organization id once drifted between the workflow and the loaders
// (PPBF_ORG_ID exported, PPBF_SEED_ORG_ID read) and every loader defaulted the
// missing value to 'ppbf-default-org', so a production dispatch would have
// written hundreds of rows under a fixture organization and reported success.
// No pg suite could see that: they call the loader directly, never through the
// workflow.

const PILOT_DIR = __dirname;
const WEB_DIR = path.resolve(PILOT_DIR, '../../..');
const REPO_ROOT = path.resolve(WEB_DIR, '../..');
const WORKFLOW = path.join(REPO_ROOT, '.github/workflows/seed-reference-data.yml');
const SCRIPTS_DIR = path.join(WEB_DIR, 'scripts');
const SEED_DATA_DIR = path.join(WEB_DIR, 'seed-data');
const CLI_SOURCE = path.join(PILOT_DIR, 'contentImport/cli.ts');

// Normalized because the repo checks out CRLF on Windows, and a trailing \r
// silently defeats any regex anchored with $ or ending in \n. A structural
// assertion that cannot match is a guard that always passes vacuously.
const WORKFLOW_SOURCE = fs.readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');
const PACKAGE_SCRIPTS = (JSON.parse(fs.readFileSync(path.join(WEB_DIR, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;

/** The operator's dataset choices, read off the input block at its own indent (the header comment names datasets too). */
function datasetChoices(workflow: string): string[] {
  const block = workflow.match(/\n {6}dataset:\n([\s\S]*?)\n {6}mode:/);
  if (!block) throw new Error('seed-reference-data.yml: could not read the dataset choices');
  return block[1]
    .split('\n')
    .map((line) => line.trim().match(/^- (\S+)$/)?.[1])
    .filter((value): value is string => Boolean(value));
}

/** One job's text: from its key at two-space indent to the next job key or the end. */
function jobBlock(workflow: string, job: string): string {
  const start = workflow.indexOf(`\n  ${job}:\n`);
  if (start === -1) throw new Error(`seed-reference-data.yml: no job ${job}`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9_-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 2);
}

/** One step's text, from its `- name:` line to the next step. */
function stepBlock(workflow: string, name: string): string {
  const start = workflow.indexOf(`- name: ${name}\n`);
  if (start === -1) throw new Error(`seed-reference-data.yml: no step ${name}`);
  const next = workflow.indexOf('- name:', start + 1);
  return workflow.slice(start, next === -1 ? undefined : next);
}

const at = (needle: string) => WORKFLOW_SOURCE.indexOf(needle);

/** The committed datasets that have at least one file on disk. */
function committedDatasets(): DatasetName[] {
  return DATASETS.filter((dataset) => dataset.files.some((file) => fs.existsSync(path.join(SEED_DATA_DIR, committedPath(file))))).map(
    (dataset) => dataset.name,
  );
}

describe('seed-reference-data workflow contract', () => {
  const workflow = WORKFLOW_SOURCE;
  const choices = datasetChoices(workflow);
  const validateJob = jobBlock(workflow, 'validate');
  const seedJob = jobBlock(workflow, 'seed');

  it('reads the workflow, its two jobs and its choices, so nothing below passes vacuously', () => {
    expect(workflow).toContain('name: seed-reference-data');
    expect(validateJob).toContain('- name: Validate Package');
    expect(seedJob).toContain('- name: Load Reference Data');
    expect(choices).toContain('all');
    expect(choices).toContain('drill-library');
    expect(choices.length).toBeGreaterThan(2);
  });

  it('every dataset choice is a registered content-import dataset and the workflow validates before any Azure or database step', () => {
    // Every choice but 'all' is a dataset the engine loads, and the CLI accepts it.
    for (const choice of choices) {
      expect(() => datasetsFor(choice)).not.toThrow();
      if (choice !== 'all') expect(LOADABLE_DATASETS).toContain(choice);
    }
    // ...and every loadable dataset that has a committed file is offered. A
    // first universal-stop-rules file makes this fail until it is a choice.
    expect(choices.filter((choice) => choice !== 'all').sort()).toEqual(
      LOADABLE_DATASETS.filter((name) => committedDatasets().includes(name)).sort(),
    );

    // The validation runs the offline validator over exactly what the load
    // will read (runValidateCommitted), for the dataset the operator chose.
    const validate = stepBlock(validateJob, 'Validate Package');
    expect(validate).toMatch(/run: npm run --silent content:validate -- --dataset "\$DATASET"/);
    expect(validate).toContain('DATASET: ${{ inputs.dataset }}');
    expect(PACKAGE_SCRIPTS['content:validate']).toBe('tsx scripts/pilot-content-import.ts validate');
    expect(parseCliArgs(['validate', '--dataset', 'all'])).toEqual({ command: 'validate', dataset: 'all', write: false, dryRun: false });

    // BEFORE: in a job that cannot reach Azure or a database at all -- no
    // environment (so no environment secrets), no secrets, no OIDC token, no
    // login, no connection string -- and the job that can does not start
    // until it has passed.
    // Comment lines are left out: the job's own comment explains the absence.
    const validateCode = validateJob
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    for (const forbidden of ['environment:', 'secrets.', 'id-token', 'azure/login', 'az containerapp', 'AZURE_POSTGRES_CONNECTION_STRING', 'content:apply']) {
      expect({ forbidden, found: validateCode.includes(forbidden) }).toEqual({ forbidden, found: false });
    }
    expect(seedJob).toMatch(/\n {4}needs: validate\n/);
    expect(at('- name: Validate Package')).toBeLessThan(at('azure/login'));
    expect(at('- name: Validate Package')).toBeLessThan(at('- name: Resolve Declared Database Target'));
    expect(at('- name: Validate Package')).toBeLessThan(at('- name: Load Reference Data'));
  });

  it("dataset all is ONE apply step and ONE CLI call -- one transaction -- not a chain of per-dataset steps", () => {
    // The old `all` ran a step per loader, each with its own transaction, so a
    // failure half way left earlier datasets committed. Now every choice,
    // `all` included, is one `content:apply` call; runApply plans every
    // dataset, then applies them in one BEGIN .. COMMIT (proved without a
    // database in seedLoaderTransactions.test.ts, and against Postgres in
    // contentImportEngine.pg.test.ts: one import_id, one audit row).
    const applyCalls = [...workflow.matchAll(/content:apply/g)];
    expect(applyCalls).toHaveLength(1);
    const load = stepBlock(seedJob, 'Load Reference Data');
    expect(load).toContain('npm run --silent content:apply -- $DRY_RUN --dataset "$DATASET"');
    expect(load).toContain('DATASET: ${{ inputs.dataset }}');
    expect(PACKAGE_SCRIPTS['content:apply']).toBe('tsx scripts/pilot-content-import.ts apply');
    // No per-dataset steps, and no per-dataset seed script run by the workflow.
    expect(workflow).not.toMatch(/inputs\.dataset == '/);
    expect(workflow).not.toMatch(/npm run seed:/);
    // 'all' is every loadable dataset in apply (dependency) order.
    expect(datasetsFor('all')).toEqual([...LOADABLE_DATASETS]);
  });

  it('keeps dry-run as apply + ROLLBACK, not a plan-only preview', () => {
    // mode=dry-run passes --dry-run to apply (runApply applies, then rolls
    // back), so a dry run still proves the rows fit the live schema. The plan
    // command is never what the workflow runs.
    const load = stepBlock(seedJob, 'Load Reference Data');
    expect(load).toMatch(/if \[ "\$MODE" = "dry-run" \]; then\n\s+DRY_RUN="--dry-run"/);
    expect(load).toContain('MODE: ${{ inputs.mode }}');
    expect(workflow).not.toMatch(/content:plan/);
    expect(parseCliArgs(['apply', '--dry-run', '--dataset', 'all'])).toMatchObject({ command: 'apply', dryRun: true });
  });

  it('prints the plan counts in the run summary, in the exact format the CLI prints them', () => {
    const summary = stepBlock(seedJob, 'Record What Ran');
    expect(summary).toContain('if: always()');
    // The load step keeps its output where the summary reads it.
    expect(stepBlock(seedJob, 'Load Reference Data')).toContain('| tee "$RUNNER_TEMP/content-import.log"');
    expect(summary).toContain('LOG="$RUNNER_TEMP/content-import.log"');

    // The summary's count pattern must match the line formatPlan really
    // prints, or the summary silently shows "(no plan was printed)".
    const pattern = summary.match(/grep -E '(\^ {2}\[a-z-\]\+: [^']+)' "\$LOG"/)?.[1];
    expect(pattern).toBeDefined();
    const plan: ImportPlan = {
      organizationId: 'gym_test',
      actor: { accountId: 'admin@gym_test', role: 'organization_admin', isPlatformOwner: false },
      datasets: ['disciplines', 'drill-library'],
      units: [],
      counts: {
        disciplines: { new: 5, new_version: 0, unchanged: 0, absent: 0, reject: 0 },
        'drill-library': { new: 0, new_version: 2, unchanged: 117, absent: 1, reject: 0 },
      },
      totals: { new: 5, new_version: 2, unchanged: 117, absent: 1, reject: 0 },
      blocking: [],
      warnings: [],
      changes: 7,
      planHash: 'hash',
    };
    const printed = formatPlan(plan);
    const countLines = printed.filter((line) => new RegExp(pattern as string).test(line));
    expect(countLines).toEqual([
      '  disciplines: 5 new, 0 new version, 0 unchanged, 0 absent, 0 reject',
      '  drill-library: 0 new, 2 new version, 117 unchanged, 1 absent, 0 reject',
    ]);
    // Every outcome is in that line, in the order the pattern expects.
    expect(UNIT_OUTCOMES).toEqual(['new', 'new_version', 'unchanged', 'absent', 'reject']);
    // The header line names the organization and must NOT be what the summary picks up.
    expect(printed[0]).toContain('gym_test');
    expect(new RegExp(pattern as string).test(printed[0])).toBe(false);
  });

  it('never prints the resolved organization into the run summary', () => {
    // The value is masked in the log. The summary is not a log, so it carries
    // counts and verdicts only: never the input, never the variable, never a
    // free-text CLI line (the plan header and a refusal message can name it).
    const summary = stepBlock(seedJob, 'Record What Ran');
    expect(summary).not.toMatch(/\$\{\{\s*inputs\.organization_id\s*\}\}/);
    expect(summary).not.toMatch(/\$PPBF_SEED_ORG_ID|\$\{PPBF_SEED_ORG_ID\}/);
    expect(summary).not.toMatch(/cat "\$LOG"|tail [^\n]*"\$LOG"/);
    expect(summary).toContain("grep -oE '^RESULT: [A-Z ]+'");
  });

  it('demands a seeder account for EVERY dataset', () => {
    // The core runs every load as a checked account and records it on every
    // row (contentImport/actor.ts), so no dataset is exempt -- the old list of
    // datasets that "needed" one is gone.
    const input = workflow.slice(at('      seed_account_id:'));
    expect(input.slice(0, input.indexOf('type: string'))).toContain('required: true');
    const confirm = stepBlock(validateJob, 'Confirm Explicit Target And Apply Intent');
    expect(confirm).toContain('SEED_ACCOUNT: ${{ inputs.seed_account_id }}');
    expect(confirm).toMatch(/if \[ -z "\$\{SEED_ACCOUNT\/\/\[\[:space:\]\]\/\}" \]; then/);
    // Unconditional: not inside a per-dataset condition.
    expect(confirm).not.toContain('$DATASET');
    expect(seedJob).toContain('PPBF_SEED_ACCOUNT_ID: ${{ inputs.seed_account_id }}');
  });

  it('every variable the CLI reads is exported to the load step', () => {
    // Read from the CLI's own source, so a renamed variable fails here rather
    // than as "Missing required environment variable" after an approval.
    const cli = fs.readFileSync(CLI_SOURCE, 'utf8');
    const required = [...cli.matchAll(/required\('([A-Z0-9_]+)'\)/g)].map((match) => match[1]);
    expect(required.sort()).toEqual(['AZURE_POSTGRES_CONNECTION_STRING', 'PPBF_SEED_ACCOUNT_ID', 'PPBF_SEED_ORG_ID']);
    // The declared-target check the CLI runs before connecting.
    const targets = ['PPBF_EXPECTED_POSTGRES_HOSTNAME', 'PPBF_EXPECTED_POSTGRES_DATABASE'];
    for (const name of [...required, ...targets]) {
      // Declared in the seed job's env, or written to $GITHUB_ENV before the load step.
      const declared = new RegExp(`^\\s*${name}:`, 'm').test(seedJob);
      const writtenAt = seedJob.indexOf(`${name}=`);
      expect({ name, exported: declared || (writtenAt > -1 && writtenAt < seedJob.indexOf('- name: Load Reference Data')) }).toEqual({ name, exported: true });
    }
  });

  it('resolves the owning organization before the load, from the operator input only, and never defaults it', () => {
    expect(at('- name: Resolve Owning Organization')).toBeGreaterThan(-1);
    expect(at('- name: Resolve Owning Organization')).toBeLessThan(at('- name: Load Reference Data'));
    const resolve = stepBlock(seedJob, 'Resolve Owning Organization');
    expect(resolve).toContain('SUPPLIED: ${{ inputs.organization_id }}');
    expect(resolve).toContain('echo "PPBF_SEED_ORG_ID=$ORG" >> "$GITHUB_ENV"');
    // No fallback to the app's default-org secret (OD-2026-09-28-007): that is
    // how gym material ended up under ppbf-default-org.
    expect(workflow).not.toContain('ppbf-pilot-default-org-id');
    // The CLI has no default either: a blank organization is refused.
    expect(() => readDatabaseEnv({ AZURE_POSTGRES_CONNECTION_STRING: 'postgres://h/db', PPBF_SEED_ACCOUNT_ID: 'a', PPBF_SEED_ORG_ID: ' ' })).toThrow(
      'Missing required environment variable: PPBF_SEED_ORG_ID',
    );
    expect(fs.readFileSync(CLI_SOURCE, 'utf8')).not.toMatch(/PPBF_SEED_ORG_ID[^\n]*(\|\||\?\?)/);
  });

  it('transfer-claims stays out of the choices until its file validates', () => {
    expect(choices).not.toContain('transfer-claims');
    expect(() => datasetsFor('transfer-claims')).toThrow('transfer-claims has no database loader');
    // The reason it is out, made executable: the committed file still fails
    // the validator (173 rows over 61 drill ids not in the library,
    // contentPackageContract.test.ts). The day it validates this fails, and
    // adding it (with a loader) becomes a decision instead of an accident.
    const baseline = readCommittedBaseline(SEED_DATA_DIR);
    const references = loadOfflineReferenceSets(SEED_DATA_DIR, baseline);
    const transfer: ParsedPackage = { files: baseline.files.filter((file) => file.spec.dataset === 'transfer-claims') };
    expect(transfer.files).toHaveLength(1);
    expect(validateParsed(transfer, { references, baseline }).blocking.length).toBeGreaterThan(0);
  });

  it('every npm run seed:<dataset> runs the content-import CLI apply', () => {
    const seeds: Record<string, string> = {
      'seed:disciplines': 'disciplines',
      'seed:competence-cohorts': 'competence-levels,cohort-definitions',
      'seed:drill-library': 'drill-library',
      // Secondary skills are part of a drill's version unit (Jason's default:
      // "a drill's version unit includes ... secondary skills"), so they load
      // with the drill library; a changed link makes a new drill version.
      'seed:drill-secondary-skills': 'drill-library',
      'seed:workout-templates': 'workout-templates',
      'seed:session-scripts': 'session-scripts',
      'seed:transfer-claims': 'transfer-claims',
    };
    for (const [script, dataset] of Object.entries(seeds)) {
      expect({ script, command: PACKAGE_SCRIPTS[script] }).toEqual({ script, command: `tsx scripts/pilot-content-import.ts apply --dataset ${dataset}` });
    }
    expect(PACKAGE_SCRIPTS['seed:drill-library:dry']).toBe('tsx scripts/pilot-content-import.ts apply --dry-run --dataset drill-library');
    expect(datasetsFor(seeds['seed:competence-cohorts'])).toEqual(['competence-levels', 'cohort-definitions']);
    // seed:transfer-claims is refused by name before any connection opens.
    expect(() => datasetsFor(seeds['seed:transfer-claims'])).toThrow('has no database loader');
  });

  it('leaves no second write path for reference content: no seed script reads the owning organization', () => {
    // The seven copied loaders are gone. A new scripts/seed-*.mjs that reads
    // PPBF_SEED_ORG_ID would be an eighth copy beside the core -- the
    // duplication IMP-10 removed -- so it fails here, naming the file.
    const readers = fs
      .readdirSync(SCRIPTS_DIR)
      .filter((file) => /\.(mjs|js|ts)$/.test(file))
      .filter((file) => /process\.env\.PPBF_SEED_ORG_ID|required\(\s*['"]PPBF_SEED_ORG_ID['"]\s*\)/.test(fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf8')));
    expect(readers).toEqual([]);
    // Every `node scripts/...` a package script names still exists.
    for (const [name, command] of Object.entries(PACKAGE_SCRIPTS)) {
      for (const match of command.matchAll(/(?:node|tsx) (scripts\/[\w./-]+\.(?:mjs|ts))/g)) {
        expect({ name, file: match[1], exists: fs.existsSync(path.join(WEB_DIR, match[1])) }).toEqual({ name, file: match[1], exists: true });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The secondary-skill relationship file. Until IMP-10 this test pinned
// seed_drill_secondary_skills.csv to its ONE approved row, header included, so
// any second link failed CI until the test was edited. Jason's default for the
// hand-off: handing files over IS approval of what is in them. So a new link is
// admitted, and what holds the file now is the validator's relationship rules
// (specs/drills.ts secondarySkills.rowRules plus the skill-code checks), the
// same rules the core applies at plan. Checked against the REAL committed
// library, not a fixture.

describe("secondary-skill rows are admitted by the validator's relationship rules", () => {
  const baseline = readCommittedBaseline(SEED_DATA_DIR);
  const references = loadOfflineReferenceSets(SEED_DATA_DIR, baseline);
  const secondarySpec = fileSpecByName('seed_drill_secondary_skills.csv');
  const committedRows = (baseline.files.find((file) => file.spec.file === 'seed_drill_secondary_skills.csv')?.rows ?? []).map((row) => row.values);
  const library = baseline.files.find((file) => file.spec.file === 'seed_drill_library.csv')?.rows.map((row) => row.values) ?? [];

  function packageOf(rows: RowValues[]) {
    const header = ['organization_id', 'drill_id', 'skill_id', 'expected_primary_skill_id'];
    return validatePackage(
      [{ path: 'drill-library/seed_drill_secondary_skills.csv', text: writeCsv(header, rows.map((row) => header.map((name) => row[name] ?? ''))) }],
      { references, baseline },
    );
  }

  // A drill with a primary skill, and an SK code that is neither its primary
  // nor already linked to it: the shape of a new, legitimate link.
  const withPrimary = library.find((row) => row.skill_id && !committedRows.some((link) => link.drill_id === row.drill_id)) as RowValues;
  const otherCode = [...references.skillCodes].sort().find((code) => code !== withPrimary?.skill_id) as string;
  const noPrimary = library.find((row) => !row.skill_id);
  const link = (overrides: Record<string, string>): RowValues => ({ organization_id: '{{PPBF_ORG_ID}}', drill_id: withPrimary.drill_id, skill_id: otherCode, ...overrides });

  it('reads the committed file and a library to link against', () => {
    expect(secondarySpec).toBeDefined();
    expect(committedRows.length).toBeGreaterThanOrEqual(1);
    expect(withPrimary).toBeDefined();
    expect(otherCode).toMatch(/^SK-[A-Z]+-\d{2}$/);
  });

  it('the committed rows pass', () => {
    expect(packageOf(committedRows).blocking).toEqual([]);
  });

  it('a new link beside them is ADMITTED -- the one-row pin is gone', () => {
    const result = packageOf([...committedRows, link({})]);
    expect(result.blocking).toEqual([]);
    // An expected primary that matches is admitted too.
    expect(packageOf([link({ expected_primary_skill_id: withPrimary.skill_id })]).blocking).toEqual([]);
  });

  it.each([
    ['a family id in the skill column', { skill_id: 'SKILL-01' }, 'skill_family_in_skill_column'],
    ['a malformed skill code', { skill_id: 'sk-guard-2' }, 'bad_id'],
    ["the drill's own primary again", { skill_id: '__PRIMARY__' }, 'row_rule'],
    ['an expected primary the drill does not have', { expected_primary_skill_id: '__OTHER__' }, 'row_rule'],
    ['a drill in neither the package nor the library', { drill_id: 'drl_00000000000000' }, 'orphan_reference'],
  ])('%s is refused', (_label, overrides, code) => {
    const resolved = Object.fromEntries(
      Object.entries(overrides).map(([key, value]) => [
        key,
        value === '__PRIMARY__' ? withPrimary.skill_id : value === '__OTHER__' ? otherCode : value,
      ]),
    );
    const result = packageOf([link(resolved)]);
    expect(result.blocking.map((finding) => finding.code)).toContain(code);
  });

  it('a well-formed SK code no family list names yet is admitted with a warning, not refused', () => {
    // Jason's default: a new skill code in handed-over files is approved, its
    // family "not decided yet" -- skillFamilies.ts is edited in the same PR.
    const result = packageOf([link({ skill_id: 'SK-NEWCODE-01' })]);
    expect(result.blocking).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).toContain('unmapped_skill_code');
  });

  it('a drill with no primary skill cannot take a secondary one', () => {
    if (!noPrimary) {
      // Every committed drill has a primary today; the rule is still pinned
      // in contentImportValidate.test.ts on a hand-built drill.
      expect(library.every((row) => row.skill_id)).toBe(true);
      return;
    }
    const result = packageOf([link({ drill_id: noPrimary.drill_id })]);
    expect(result.blocking.map((finding) => finding.message)).toContainEqual(expect.stringContaining('has no primary skill_id'));
  });
});
