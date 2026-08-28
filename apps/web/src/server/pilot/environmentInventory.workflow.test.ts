// The general environment-variable inventory guard: every variable a
// deployment actually passes to the PPBF web Container App is represented by
// the local configuration template, or is an explicit, reasoned exclusion.
//
// WHY THIS TEST EXISTS
//
// Three separate incidents in this repository are the same defect: the running
// configuration and the recorded configuration drifted apart while CI stayed
// green, because nothing read the deployment workflows as the source of truth
// about what a running instance is given.
//
//   - PR #81: production deployed PPBF_SHADOW_MAX_COMPLETION_TOKENS=4096 while
//     staging deployed 8192. The existing assertion checked the CODE default,
//     so production degraded on exactly the long-form prompts SHADOW exists to
//     answer, and staging passed. shadowTokenBudget.workflow.test.ts now reads
//     the real workflows.
//   - shadowProviderTimeout.workflow.test.ts records the sibling case: a
//     variable ABSENT from a deployment is not the code default, because
//     `az containerapp update --set-env-vars` updates listed variables and
//     cannot unset a stale value already on the app. Both workflows must
//     therefore state the timeout explicitly.
//   - PR #422: PPBF_APP_ORIGIN existed in application code and in no workflow
//     or template. The magic-link route hides send failures on purpose, so
//     guardians enumerating a roster is impossible -- and so is noticing that
//     no link was ever sent. Every guardian could be told a link was coming
//     while none was.
//
// Those three produced three variable-specific guards. This one covers the
// class rather than the instance: it fails when the SET of deployed variables
// stops being represented locally, which is the drift the specific guards
// cannot see because they only look at the variable they were written for.
//
// WHAT THIS TEST DELIBERATELY DOES NOT DO
//
// It checks NAMES, not VALUES. A name-presence check cannot prove a timeout or
// a token budget is safe, and must never be treated as though it replaces the
// two specialized tests above -- they remain authoritative for the questions
// they answer.
//
// It also does not require the template's values to match a deployment's. The
// three postures differ on purpose: a feature gate is off locally, on in
// staging first, and on in production only once staging has proven it. Equal
// values are not the goal. An unexplained difference is the finding.
//
// It does not assert the reverse direction either (template name => deployed
// somewhere). The template legitimately documents local-only configuration
// that no Container App is given.
//
// WHY IT DOES NOT SHARE A PARSER WITH THE TWO SPECIALIZED TESTS
//
// They match one variable across the whole file; this one must read the
// assignment block itself, so the parsing need is genuinely different rather
// than duplicated. Keeping them independent is also the point: if this block
// parser ever silently stops finding the block, the specialized tests still
// hold their own ground instead of all three going vacuous together. The
// anti-vacuity assertions below exist for the same reason.

import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const WORKFLOW_DIR = path.join(REPO_ROOT, '.github/workflows');
const TEMPLATE_FILE = path.join(REPO_ROOT, '.env.example');

const DEPLOYMENTS: Array<{ environment: string; file: string }> = [
  { environment: 'staging', file: 'deploy-staging.yml' },
  { environment: 'production', file: 'deploy-production.yml' },
];

/**
 * Variables a deployment passes to the app that are deliberately NOT part of
 * the local configuration contract.
 *
 * A growing list here is a finding, not a success condition. Every entry is
 * checked below against two properties that must both hold, so an entry cannot
 * survive on its reason alone:
 *
 *   1. it is actually deployed (a stale exclusion for a variable no deployment
 *      sets is dead text, and dead text is how an exclusion list rots);
 *   2. no non-test application source mentions it (the moment the app reads a
 *      variable, it is application configuration and belongs in the template).
 */
const DEPLOYMENT_ONLY: Record<string, string> = {
  PPBF_RELEASE_SHA:
    'Release provenance stamped BY the deploy from the SHA it just promoted '
    + '(deploy-production.yml: PPBF_RELEASE_SHA="$CONFIRM_SHA"). The application '
    + 'never reads it; the rollback guard reads it back off the app with '
    + '`az containerapp show` to refuse a deploy older than what is running. It '
    + 'is produced by the deployment operation, so a developer has nothing to '
    + 'put in a local file for it.',
};

interface Assignment {
  name: string;
  value: string;
  line: number;
}

/**
 * The `--set-env-vars` assignments a workflow actually deploys.
 *
 * Anchored on the argument line and read as a block, so the prose above it can
 * never satisfy this test -- both workflows discuss these variables at length
 * in comments, and a comment is not a deployment.
 */
function deployedAssignments(workflowFile: string): Assignment[] {
  const lines = fs.readFileSync(path.join(WORKFLOW_DIR, workflowFile), 'utf8').split('\n');

  const starts = lines
    .map((line, index) => (/^\s*--set-env-vars\s*\\\s*$/.test(line) ? index : -1))
    .filter((index) => index >= 0);

  if (starts.length === 0) {
    throw new Error(`${workflowFile} has no --set-env-vars block`);
  }
  if (starts.length > 1) {
    // Two blocks means two `az containerapp update` calls, and this guard would
    // silently inventory only one of them. Refuse rather than half-check.
    throw new Error(
      `${workflowFile} has ${starts.length} --set-env-vars blocks; this guard reads one, `
      + 'so it would inventory only part of what the app is given',
    );
  }

  const assignments: Assignment[] = [];
  for (let i = starts[0] + 1; i < lines.length; i += 1) {
    const match = /^\s+([A-Z][A-Z0-9_]*)=(.*?)\s*\\?\s*$/.exec(lines[i]);
    if (!match) break;
    assignments.push({ name: match[1], value: match[2], line: i + 1 });
  }

  return assignments;
}

/** Variable names the local template represents, ignoring its prose. */
function templateNames(): string[] {
  return fs
    .readFileSync(TEMPLATE_FILE, 'utf8')
    .split('\n')
    .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1]);
}

/** Non-test application source, for checking that an exclusion is still unread. */
function applicationSourceFiles(): string[] {
  const roots = [path.join(REPO_ROOT, 'apps/web/src'), path.join(REPO_ROOT, 'apps/web/app')];
  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        found.push(full);
      }
    }
  };

  roots.filter((root) => fs.existsSync(root)).forEach(walk);
  return found;
}

describe('deployed environment variable inventory', () => {
  const inventory = DEPLOYMENTS.map((deployment) => ({
    ...deployment,
    assignments: deployedAssignments(deployment.file),
  }));
  const template = templateNames();

  // ---------------------------------------------------------------------
  // Anti-vacuity. Every assertion below is "nothing is missing", which an
  // empty parse satisfies perfectly. These three make a broken parser fail
  // loudly instead of reporting a clean bill of health for nothing.
  // ---------------------------------------------------------------------

  test.each(inventory)('$environment deploys a non-empty variable block', ({ assignments }) => {
    expect(assignments.length).toBeGreaterThan(0);
  });

  test.each(inventory)(
    '$environment block is anchored on real assignments, not prose',
    ({ assignments }) => {
      // Both environments give the app its database and its SHADOW key. If
      // these are missing, the block boundary moved and the parse is wrong.
      const names = assignments.map((a) => a.name);
      expect(names).toEqual(expect.arrayContaining(['AZURE_POSTGRES_CONNECTION_STRING', 'AZURE_AI_KEY']));
    },
  );

  test('the local template represents variables at all', () => {
    expect(template.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------
  // The guard itself.
  // ---------------------------------------------------------------------

  test.each(inventory)('$environment assigns each variable exactly once', ({ environment, assignments }) => {
    // `--set-env-vars` takes the last assignment of a repeated name, so a
    // duplicate makes the deployed value depend on line order. That is
    // ambiguous by construction and is refused rather than resolved -- the
    // same stance shadowTokenBudget.workflow.test.ts takes for its variable.
    const seen = new Map<string, number[]>();
    assignments.forEach(({ name, line }) => {
      seen.set(name, [...(seen.get(name) ?? []), line]);
    });

    const duplicated = [...seen.entries()]
      .filter(([, lines]) => lines.length > 1)
      .map(([name, lines]) => `${environment}: ${name} assigned ${lines.length}x (lines ${lines.join(', ')})`);

    expect(duplicated).toEqual([]);
  });

  test.each(inventory)(
    '$environment deploys nothing the local template has lost',
    ({ environment, assignments }) => {
      const missing = assignments
        .filter(({ name }) => !template.includes(name))
        .filter(({ name }) => !(name in DEPLOYMENT_ONLY))
        .map(({ name, line }) =>
          `${name} is deployed to ${environment} (${DEPLOYMENTS.find((d) => d.environment === environment)?.file}:${line}) `
          + 'but is absent from .env.example. Add it there, or add a reasoned entry to DEPLOYMENT_ONLY.');

      expect(missing).toEqual([]);
    },
  );

  // ---------------------------------------------------------------------
  // The exclusion list has to earn its entries.
  // ---------------------------------------------------------------------

  test('every deployment-only exclusion is actually deployed', () => {
    const deployedNames = new Set(inventory.flatMap(({ assignments }) => assignments.map((a) => a.name)));

    const stale = Object.keys(DEPLOYMENT_ONLY).filter((name) => !deployedNames.has(name));

    expect(stale).toEqual([]);
  });

  test('no deployment-only exclusion is read by application code', () => {
    // This is what makes an exclusion a checked claim rather than an assertion
    // in a comment. "Deployment-only" means the application never reads it; the
    // moment any non-test source mentions the name, that reason has expired and
    // the variable belongs in the local template.
    const sources = applicationSourceFiles();
    expect(sources.length).toBeGreaterThan(0);

    const readers: string[] = [];
    for (const file of sources) {
      const contents = fs.readFileSync(file, 'utf8');
      for (const name of Object.keys(DEPLOYMENT_ONLY)) {
        if (contents.includes(name)) {
          readers.push(`${path.relative(REPO_ROOT, file)} mentions ${name}`);
        }
      }
    }

    expect(readers).toEqual([]);
  });

  test('exclusions are not silently duplicated in the template', () => {
    // An exclusion that is ALSO in the template means the two records disagree
    // about whether a developer supplies it. Whichever is right, both cannot be.
    const both = Object.keys(DEPLOYMENT_ONLY).filter((name) => template.includes(name));

    expect(both).toEqual([]);
  });

  test('every exclusion states a reason', () => {
    const unreasoned = Object.entries(DEPLOYMENT_ONLY)
      .filter(([, reason]) => reason.trim().length < 40)
      .map(([name]) => name);

    expect(unreasoned).toEqual([]);
  });
});
