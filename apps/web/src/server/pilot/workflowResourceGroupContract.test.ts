import fs from 'node:fs';
import path from 'node:path';

/**
 * Every workflow that accepts target=production must fail closed on the
 * production resource group.
 *
 * apply-migrations.yml, seed-reference-data.yml and check-database.yml all
 * hardcoded `RESOURCE_GROUP: rg-ppbf-enterprise-staging` at job level for BOTH
 * targets while CONTAINER_APP_NAME switched to app-ppbf-production. A
 * production dispatch therefore looked up production's container app inside
 * the staging-named resource group -- which resolves today only by the
 * accident of where that app lives, and which silently points every Azure
 * call at the wrong resource group the day it moves. deploy-production.yml
 * already refuses this shape: its RESOURCE_GROUP comes from
 * secrets.AZURE_PRODUCTION_RESOURCE_GROUP with no staging fallback, because
 * "a wrong-environment deploy that announces success is worse than one that
 * refuses".
 *
 * This test pins the same model onto every target-switching workflow: no
 * unconditional staging literal, the production branch reads the secret, and a
 * guard step fails on an empty secret before the Azure login. backup.yml and
 * retention-cleanup.yml run on a SCHEDULE with no `environment:` and default
 * to production, so for them the guard also depends on the secret being
 * readable at repository scope -- if it is scoped to the production
 * environment only, the nightly run refuses loudly, which is the intended
 * direction (their own comments say the same).
 *
 * METHOD, stated honestly: raw workflow text plus regex, the same idiom as
 * seedWorkflowContract.test.ts, migrationDispatchCoverage.test.ts and
 * workflowCredentialHygiene.test.ts. js-yaml exists in the repository only as
 * an undeclared transitive dependency, so no real YAML parser is used here.
 *
 * WHAT THIS CANNOT CATCH: it is structural. It cannot prove the
 * AZURE_PRODUCTION_RESOURCE_GROUP secret is actually populated in the
 * repository settings, cannot execute the guard's shell to watch it exit 1,
 * and cannot observe GitHub's runtime expression evaluation. It CAN catch the
 * two silent-fallback shapes that already shipped: the unconditional job-level
 * staging literal, and the `secrets.X || 'staging'` expression whose empty
 * secret collapses to the staging value without an error.
 */
const WORKFLOW_DIR = path.resolve(__dirname, '../../../../../.github/workflows');

/** Converted to the fail-closed model; held to the full contract below. */
const COVERED = [
  'apply-migrations.yml',
  'approve-library-baseline.yml',
  'backup.yml',
  'check-database.yml',
  'cleanup-membership-orphans.yml',
  'import-shadow-research.yml',
  'rescope-library-baseline.yml',
  'retention-cleanup.yml',
  'run-checks.yml',
  'seed-reference-data.yml',
];

/**
 * Accept target=production and still hardcode the staging resource group at
 * job level. The list is empty -- the defect class is closed -- but the
 * mechanism stays: a NEW workflow shipping the defect fails the set-equality
 * test immediately, and a covered workflow regressing to the hardcoded form
 * fails the exact-defect test below, naming the file. Adding an entry here is
 * a deliberate, reviewable act of recording a gap, never a default.
 */
const KNOWN_UNFIXED: string[] = [];

const STAGING_RG = 'rg-ppbf-enterprise-staging';

/** Normalized: a CRLF checkout defeats $-anchored regexes silently. */
function readWorkflow(file: string): string {
  return fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8').replace(/\r\n/g, '\n');
}

/** Does this workflow expose a `target` dispatch input offering production? */
function acceptsProductionTarget(contents: string): boolean {
  const at = contents.search(/^ +target:\s*$/m);
  if (at === -1) return false;
  // The options list sits within the input block; 600 characters is generous
  // for description + type + options without reaching into a sibling input.
  return /^ +- production\s*$/m.test(contents.slice(at, at + 600));
}

/** The defect: the staging literal assigned unconditionally as a YAML value. */
function hardcodesStagingRg(contents: string): boolean {
  return /^\s*RESOURCE_GROUP:\s*rg-ppbf-enterprise-staging\s*$/m.test(contents);
}

const allWorkflows = fs.existsSync(WORKFLOW_DIR)
  ? fs.readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  : [];
const productionTargeting = allWorkflows.filter((f) => acceptsProductionTarget(readWorkflow(f)));

describe('production-targeting workflows fail closed on the resource group', () => {
  test('the discovery matched real workflows (guard against a vacuous test)', () => {
    expect(allWorkflows.length).toBeGreaterThan(0);
    expect(productionTargeting.length).toBeGreaterThan(0);
  });

  test('every target=production workflow is either covered or a named known gap', () => {
    // A new workflow that accepts target=production must land in COVERED (or
    // be recorded here as a deliberate gap) -- it cannot join the defect class
    // unnoticed.
    expect([...productionTargeting].sort()).toEqual([...COVERED, ...KNOWN_UNFIXED].sort());
  });

  test('exactly the known-unfixed workflows still hardcode the staging resource group', () => {
    // Two directions at once: a fixed workflow must be promoted into COVERED
    // (its absence here goes red), and no covered workflow may regress to the
    // hardcoded form (its presence here goes red, naming the file).
    const defective = productionTargeting.filter((f) => hardcodesStagingRg(readWorkflow(f)));
    expect(defective.sort()).toEqual([...KNOWN_UNFIXED].sort());
  });

  describe.each(COVERED)('%s', (file) => {
    const contents = readWorkflow(file);

    test('never assigns the staging resource group unconditionally', () => {
      expect(hardcodesStagingRg(contents)).toBe(false);
      // The literal may appear only on the guarded $GITHUB_ENV write inside
      // the resolve step -- any other occurrence is a fallback path.
      for (const line of contents.split('\n')) {
        if (!line.includes(STAGING_RG)) continue;
        expect(line).toMatch(new RegExp(`RESOURCE_GROUP=${STAGING_RG}`));
      }
    });

    test('the production branch reads secrets.AZURE_PRODUCTION_RESOURCE_GROUP', () => {
      expect(contents).toMatch(/\$\{\{\s*secrets\.AZURE_PRODUCTION_RESOURCE_GROUP\s*\}\}/);
    });

    test('a guard step fails on an empty secret before the Azure login', () => {
      const guardAt = contents.indexOf('- name: Resolve Target Resource Group');
      expect(guardAt).toBeGreaterThan(-1);

      const nextStepAt = contents.indexOf('- name:', guardAt + 1);
      const guard = contents.slice(guardAt, nextStepAt === -1 ? undefined : nextStepAt);
      expect(guard).toMatch(/-z "\$PRODUCTION_RESOURCE_GROUP"/);
      expect(guard).toMatch(/::error::.*AZURE_PRODUCTION_RESOURCE_GROUP/);
      expect(guard).toMatch(/^\s*exit 1$/m);
      // The guarded write is what makes RESOURCE_GROUP exist at all -- remove
      // it and every later step reads an empty variable.
      expect(guard).toMatch(/RESOURCE_GROUP=\$PRODUCTION_RESOURCE_GROUP/);

      // Fails closed BEFORE any Azure call: the guard precedes the login step,
      // which is itself the first step that talks to Azure.
      const loginAt = contents.indexOf('azure/login');
      expect(loginAt).toBeGreaterThan(-1);
      expect(guardAt).toBeLessThan(loginAt);
    });

    test('no expression-level fallback can swallow an empty secret', () => {
      // ${{ x && secrets.S || 'literal' }} collapses an EMPTY secret to the
      // literal -- the same silent staging fallback, one layer up, with no
      // error anywhere. The secret may not appear on the left of a ||.
      expect(contents).not.toMatch(/AZURE_PRODUCTION_RESOURCE_GROUP[^\n}]*\|\|/);
    });
  });
});
