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
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');

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

  it.each(LOADERS)('%s does not default its owning organization', (loader) => {
    const source = fs.readFileSync(path.join(SCRIPTS_DIR, loader), 'utf8');
    // A loader that falls back to some literal organization writes real rows
    // under the wrong owner when the variable is missing, and says nothing.
    expect(source).not.toMatch(/PPBF_SEED_ORG_ID[^\n]*\|\|/);
  });
});
