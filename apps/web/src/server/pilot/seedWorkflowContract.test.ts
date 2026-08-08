import fs from 'node:fs';
import path from 'node:path';

// seed-reference-data.yml dispatches the three reference-data loaders. The
// operator types an organization_id into the workflow form; the loader reads an
// environment variable. Nothing tied those two names together, and they drifted:
// the workflow exported PPBF_ORG_ID / SEED_ACCOUNT_ID while the loaders read
// PPBF_SEED_ORG_ID / PPBF_SEED_ACCOUNT_ID.
//
// The failure that drift produced was not a crash. Every loader defaulted a
// missing PPBF_SEED_ORG_ID to 'ppbf-default-org', so a production dispatch would
// have written hundreds of owned rows under a hardcoded fixture organization and
// reported success, with the operator's typed value discarded in silence.
//
// The pg suites could not catch it: they import seedAll and pass placeholders as
// arguments, so run() -- the entry point the workflow actually invokes, and the
// only place these variables are read -- was never executed by any test.
//
// This ties the workflow to the loaders at the source level, like
// drillSeedPrerequisite.test.ts ties the CSVs to their consumers.

const PILOT_DIR = __dirname;
const REPO_ROOT = path.resolve(PILOT_DIR, '../../../../..');
const WORKFLOW = path.join(REPO_ROOT, '.github/workflows/seed-reference-data.yml');
const SCRIPTS_DIR = path.resolve(PILOT_DIR, '../../../scripts');

const LOADERS = [
  'seed-drill-library.mjs',
  'seed-disciplines.mjs',
  'seed-competence-cohorts.mjs',
];

/** Seed-specific variables a loader reads out of the environment. */
function seedVarsRequiredBy(loader: string): string[] {
  const source = fs.readFileSync(path.join(SCRIPTS_DIR, loader), 'utf8');
  const names = new Set<string>();
  for (const m of source.matchAll(/required\(\s*['"]([A-Z0-9_]+)['"]\s*\)/g)) {
    names.add(m[1]);
  }
  for (const m of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
    names.add(m[1]);
  }
  // The database connection variables are resolved at run time into $GITHUB_ENV
  // from the Container App's own secret, not passed through the job env block.
  // Only the seed-specific values come from operator input.
  return [...names].filter((n) => n.startsWith('PPBF_SEED_'));
}

describe('seed-reference-data workflow contract', () => {
  // Normalized because the repo checks out CRLF on Windows, and a trailing \r
  // silently defeats any regex anchored with $ or ending in \n. A structural
  // assertion that cannot match is a guard that always passes vacuously.
  const workflow = fs.readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');

  it('reads a workflow and three loaders that actually exist', () => {
    // A broken path or regex would make every assertion below vacuously pass.
    expect(workflow).toContain('name: seed-reference-data');
    for (const loader of LOADERS) {
      expect(fs.existsSync(path.join(SCRIPTS_DIR, loader))).toBe(true);
    }
  });

  it.each(LOADERS)('%s reads at least one seed variable', (loader) => {
    expect(seedVarsRequiredBy(loader).length).toBeGreaterThan(0);
  });

  it.each(LOADERS)('every variable %s reads is exported by the workflow', (loader) => {
    for (const name of seedVarsRequiredBy(loader)) {
      // Either declared in a job/step `env:` block, or written to $GITHUB_ENV.
      const exported = new RegExp(`(^\\s*${name}:)|(${name}=)`, 'm').test(workflow);
      expect(exported).toBe(true);
    }
  });

  it('names the two operator-supplied values explicitly', () => {
    // Guards the specific pair that drifted, so a rename of either side fails
    // here rather than silently seeding the wrong organization.
    expect(seedVarsRequiredBy('seed-drill-library.mjs').sort()).toEqual([
      'PPBF_SEED_ACCOUNT_ID',
      'PPBF_SEED_ORG_ID',
    ]);
  });

  it('resolves the owning organization before any loader runs', () => {
    // PPBF_SEED_ORG_ID is written to $GITHUB_ENV by a step rather than declared
    // at job level, because a blank organization_id is resolved from the target
    // app's own secret at run time. $GITHUB_ENV only reaches LATER steps, so a
    // resolution step ordered after a seed step would hand that loader an empty
    // variable -- which now stops it rather than silently defaulting, but still
    // fails a real dispatch for a reason nobody would guess from the form.
    const resolveAt = workflow.indexOf('name: Resolve Owning Organization');
    expect(resolveAt).toBeGreaterThan(-1);

    const seedSteps = [...workflow.matchAll(/name: Seed [A-Za-z ]+/g)];
    expect(seedSteps.length).toBeGreaterThan(0);
    for (const step of seedSteps) {
      expect(step.index).toBeGreaterThan(resolveAt);
    }
  });

  it('never prints the resolved organization into the run summary', () => {
    // The value is a secret the app reads for itself. Echoing it into
    // GITHUB_STEP_SUMMARY would publish it to anyone with repo read access.
    const summary = workflow.slice(workflow.indexOf('name: Record What Ran'));
    expect(summary).not.toMatch(/\$\{\{\s*inputs\.organization_id\s*\}\}/);
    expect(summary).not.toMatch(/\$PPBF_SEED_ORG_ID|\$\{PPBF_SEED_ORG_ID\}/);
  });

  it('every dataset choice is actually run by a step', () => {
    // A choice with no matching `if:` would dispatch, consume an approval on a
    // protected environment, seed nothing, and finish green -- the same shape
    // of failure as the org-id drift above, where the run reported success and
    // the operator's input reached nothing.
    //
    // Anchored on the YAML key at its own indent, not on the first occurrence
    // of the word: `dataset:` also appears in this file's header comment, and
    // slicing from there swept in `target:`'s own staging/production options.
    const block = workflow.match(/\n {6}dataset:\n([\s\S]*?)\n {6}mode:/);
    expect(block).not.toBeNull();

    const options = block![1]
      .split('\n')
      .map((l) => l.trim().match(/^- (\S+)$/)?.[1])
      .filter((v): v is string => Boolean(v));

    expect(options).toContain('all');
    expect(options).toContain('drill-library');
    expect(options.length).toBeGreaterThan(1);

    for (const option of options) {
      if (option === 'all') continue;
      expect(workflow).toContain(`inputs.dataset == '${option}'`);
    }
  });

  it('"all" runs every single-dataset step, in the order the runbook requires', () => {
    // Not just that each step mentions `all`, but that the steps appear in
    // dependency order -- the drill-library vocabulary widening has to land
    // before anything reads the drill library.
    const steps = ['Seed Drill Library', 'Seed Disciplines', 'Seed Competence Cohorts'];
    const positions = steps.map((s) => workflow.indexOf(`- name: ${s}`));
    expect(positions.every((p) => p > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    for (const step of steps) {
      const body = workflow.slice(workflow.indexOf(`- name: ${step}`));
      const condition = body.slice(0, body.indexOf('run:'));
      expect(condition).toContain("inputs.dataset == 'all'");
    }
  });

  it('"all" still demands the seeder account drill-library needs', () => {
    // drill-library stamps a seeder onto every row and fails at the insert
    // without one. If `all` skipped that precondition, the run would clear the
    // gate and then die mid-seed against a real database.
    const guard = workflow.slice(workflow.indexOf('SEED_ACCOUNT'));
    expect(guard).toMatch(/DATASET"\s*=\s*"all"/);
  });

  it.each(LOADERS)('%s does not default its owning organization', (loader) => {
    const source = fs.readFileSync(path.join(SCRIPTS_DIR, loader), 'utf8');
    // A loader that falls back to some literal organization writes real rows
    // under the wrong owner when the variable is missing, and says nothing.
    expect(source).not.toMatch(/PPBF_SEED_ORG_ID[^\n]*\|\|/);
  });
});
