import fs from 'node:fs';
import path from 'node:path';

// seed-reference-data.yml dispatches four reference-data loaders. The
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

// Normalized because the repo checks out CRLF on Windows, and a trailing \r
// silently defeats any regex anchored with $ or ending in \n. A structural
// assertion that cannot match is a guard that always passes vacuously.
const WORKFLOW_SOURCE = fs.readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');

/**
 * The loaders seed-reference-data.yml dispatches, read off the workflow's own
 * dataset choices rather than listed here.
 *
 * A hand-maintained list is what failed. This one was written when three
 * loaders existed; session-scripts later joined the workflow's choices and the
 * list did not grow, so every assertion below -- including the
 * owning-organization guard, the one this file exists for -- silently stopped
 * covering it while still reporting green. Deriving the list means a dataset
 * added to the workflow is covered the day it lands, with nobody having to
 * remember this file.
 *
 * `all` is excluded: it is the aggregate choice, not a loader.
 */
function dispatchedLoaders(workflowSource: string): string[] {
  // Anchored on the YAML key at its own indent, for the reason the
  // dataset-choice test below records: `dataset:` also appears in the
  // workflow's header comment.
  const block = workflowSource.match(/\n {6}dataset:\n([\s\S]*?)\n {6}mode:/);
  if (!block) {
    throw new Error('seed-reference-data.yml: could not read the dataset choices');
  }
  return block[1]
    .split('\n')
    .map((line) => line.trim().match(/^- (\S+)$/)?.[1])
    .filter((value): value is string => Boolean(value) && value !== 'all')
    .map((dataset) => `seed-${dataset}.mjs`)
    .sort();
}

/**
 * The loaders the workflow's STEPS actually invoke, read from the
 * `npm run seed:<dataset>` lines rather than from the input choices.
 *
 * A second, independent reading of the same file. dispatchedLoaders() parses
 * the operator-facing choice list; this parses what the job runs. Asserting
 * the two agree means a derivation that silently returns a SHORT list fails
 * here -- which a "did we get at least one, and more than one" sanity check
 * cannot do, because a truncated list satisfies it.
 */
function stepInvokedLoaders(workflowSource: string): string[] {
  const invoked = [...workflowSource.matchAll(/npm run seed:([a-z0-9-]+)/g)]
    .map((match) => `seed-${match[1]}.mjs`);
  return [...new Set(invoked)].sort();
}

const LOADERS = dispatchedLoaders(WORKFLOW_SOURCE);

/**
 * Every seed loader that resolves an owning organization -- discovered from
 * disk, not listed.
 *
 * Defaulting the owner is wrong however the loader is reached, not just when
 * the workflow dispatches it: `npm run seed:<dataset>` exists for all of them,
 * and the workflow's `Resolve Owning Organization` step (which writes
 * PPBF_SEED_ORG_ID to $GITHUB_ENV) only masks the fallback on the CI path.
 * A loader deliberately absent from the workflow -- transfer-claims, whose
 * rows violate pilot_transfer_drill_fk -- must still not guess its owner.
 *
 * Read off the filesystem because a hand-maintained list is what failed here:
 * LOADERS above was written when three loaders existed and did not grow with
 * them. A new seed-*.mjs that reads PPBF_SEED_ORG_ID is covered the day it
 * lands, with nobody having to remember this file.
 */
function orgOwningLoaders(): string[] {
  return fs
    .readdirSync(SCRIPTS_DIR)
    .filter((file) => file.startsWith('seed-') && file.endsWith('.mjs'))
    .filter((file) => fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf8').includes('PPBF_SEED_ORG_ID'))
    .sort();
}

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
  const workflow = WORKFLOW_SOURCE;

  it('reads a workflow and every dispatched loader that actually exists', () => {
    // A broken path or regex would make every assertion below vacuously pass.
    expect(workflow).toContain('name: seed-reference-data');
    // The derivation feeds every it.each below, so an empty or truncated
    // result would silently reduce this whole suite to nothing. Checked
    // against the workflow's own step invocations -- a second, independent
    // reading of the same file, so a short list fails rather than passing a
    // "more than one" sanity check.
    expect(LOADERS).toEqual(stepInvokedLoaders(workflow));
    expect(LOADERS).toContain('seed-drill-library.mjs');
    for (const loader of LOADERS) {
      expect(fs.existsSync(path.join(SCRIPTS_DIR, loader))).toBe(true);
    }
  });

  // Guards the cross-check above against quietly becoming circular. A
  // stepInvokedLoaders that ignored its argument -- or was rewritten to return
  // the choice-derived list -- would satisfy that equality while proving
  // nothing, so this pins that it genuinely reads what it is given.
  it('derives the step invocations from the text it is given', () => {
    expect(stepInvokedLoaders('')).toEqual([]);
    expect(stepInvokedLoaders('        run: npm run seed:only-this')).toEqual(['seed-only-this.mjs']);
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
    // dependency order.
    //
    // DISCIPLINES MOVED TO THE FRONT, and this list is the record of why.
    // It used to read Drill Library -> Disciplines, described as the runbook's
    // order; the runbook says only "in dependency order" and never named
    // drill-library first. That was survivable while no dependency existed.
    // pilot.drill_library.discipline and pilot.session_scripts.discipline now
    // carry organization-scoped foreign keys into pilot.disciplines, so the
    // registry has to be filled before either loader runs -- seeding 119 drills
    // into an empty registry fails on the key, and a fresh environment never
    // gets its catalogs.
    //
    // Reordering these is therefore a schema question. If this assertion fails,
    // the fix is not to re-sort the list.
    const steps = ['Seed Disciplines', 'Seed Drill Library', 'Seed Competence Cohorts', 'Seed Session Scripts'];
    const positions = steps.map((s) => workflow.indexOf(`- name: ${s}`));
    expect(positions.every((p) => p > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    for (const step of steps) {
      const body = workflow.slice(workflow.indexOf(`- name: ${step}`));
      const condition = body.slice(0, body.indexOf('run:'));
      expect(condition).toContain("inputs.dataset == 'all'");
    }
  });

  it('fills the discipline registry before any loader that references it', () => {
    // The pair above, asserted on its own and by name. The positional check is
    // order-sensitive but not self-explaining: someone re-sorting that array to
    // make a failure go away would satisfy it again and reintroduce the defect.
    // This one cannot be satisfied that way -- it names the constraint's two
    // referencing tables and the registry they point at.
    const at = (step: string) => workflow.indexOf(`- name: ${step}`);

    expect(at('Seed Disciplines')).toBeGreaterThan(-1);
    for (const dependent of ['Seed Drill Library', 'Seed Session Scripts', 'Seed Competence Cohorts']) {
      expect(at(dependent)).toBeGreaterThan(at('Seed Disciplines'));
    }
  });

  it('"all" still demands the seeder account drill-library and session-scripts need', () => {
    // drill-library stamps a seeder onto every row and fails at the insert
    // without one. If `all` skipped that precondition, the run would clear the
    // gate and then die mid-seed against a real database.
    const guard = workflow.slice(workflow.indexOf('SEED_ACCOUNT'));
    expect(guard).toMatch(/DATASET"\s*=\s*"all"/);
    // session-scripts stamps created_by_account_id the same way
    // (seed-session-scripts.mjs requires PPBF_SEED_ACCOUNT_ID), so its
    // single-dataset dispatch must clear the same precondition.
    expect(guard).toMatch(/DATASET"\s*=\s*"session-scripts"/);
  });

  // Discovery must not be able to pass vacuously: a truncated list would make
  // the guard below assert nothing while still reporting green, which is the
  // failure mode this file already warns about for its regexes.
  //
  // So this checks the CLASSIFICATION OF EVERY seed-*.mjs ON DISK, not just
  // the ones discovery returned. Asserting only "discovery contains LOADERS"
  // would be satisfied by a discovery that returned exactly LOADERS and
  // dropped every loader the workflow does not dispatch -- which is precisely
  // the hole this change exists to close.
  it('classifies every seed loader on disk by whether it owns an organization', () => {
    const all = fs
      .readdirSync(SCRIPTS_DIR)
      .filter((file) => file.startsWith('seed-') && file.endsWith('.mjs'));
    const found = orgOwningLoaders();

    expect(all.length).toBeGreaterThan(0);
    expect(found).toEqual(expect.arrayContaining(LOADERS));

    for (const file of all) {
      const ownsAnOrganization = fs
        .readFileSync(path.join(SCRIPTS_DIR, file), 'utf8')
        .includes('PPBF_SEED_ORG_ID');
      expect({ file, covered: found.includes(file) }).toEqual({ file, covered: ownsAnOrganization });
    }
  });

  it.each(orgOwningLoaders())('%s does not default its owning organization', (loader) => {
    const source = fs.readFileSync(path.join(SCRIPTS_DIR, loader), 'utf8');
    // A loader that falls back to some literal organization writes real rows
    // under the wrong owner when the variable is missing, and says nothing.
    expect(source).not.toMatch(/PPBF_SEED_ORG_ID[^\n]*\|\|/);
  });
});
