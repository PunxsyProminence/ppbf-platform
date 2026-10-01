import fs from 'node:fs';
import path from 'node:path';

/**
 * A migration and a deploy of the same environment share one concurrency
 * group, so GitHub never runs them at the same time.
 *
 * apply-migrations.yml used to serialize only against itself
 * (`apply-migrations-<target>`), and the two deploy workflows only against
 * themselves. Nothing stopped a production migration from running while a
 * production deploy was mid-flight -- a schema changing underneath the schema
 * check, the SHADOW queue check and the image update that deploy was in the
 * middle of. The fix is one mapping: apply-migrations takes the DEPLOY
 * workflow's group for whichever environment it targets.
 *
 * What is pinned, and why each:
 *   - the mapping itself, built from the literals the deploy workflows actually
 *     declare, so renaming a deploy group without this workflow following
 *     fails here instead of quietly splitting the lock in two;
 *   - cancel-in-progress false on all three: a cancelled migration or deploy is
 *     the half-applied state the lock exists to prevent;
 *   - the target choices are exactly staging and production, because the
 *     expression sends anything that is not `production` to the staging group;
 *   - which workflows are inside the lock, and which target-taking workflows
 *     are NOT. The second list is the honest half: this serializes releases
 *     and migrations, not every write to an environment.
 *
 * METHOD: raw workflow text and regex, the same idiom as
 * deployPromotionContract.test.ts (js-yaml is only an undeclared transitive
 * dependency here). WHAT THIS CANNOT SHOW: it is structural. It does not
 * evaluate the GitHub expression, and it cannot observe how GitHub queues,
 * holds or cancels a run. What is known about that comes from run history, not
 * from here: a run waiting at the production approval DOES hold its
 * workflow-level group (deploy-production run 30786409061 was created at
 * 05:10:46Z on 2026-08-03 and its first job at 05:36:46Z, the second run
 * 30772571138 -- waiting at the approval since 23:35 -- completed). Whether a
 * JOB-level group behaves the same way has not been observed.
 */
const WORKFLOW_DIR = path.resolve(__dirname, '../../../../../.github/workflows');

/** Normalized: a CRLF checkout defeats $-anchored regexes silently. */
function readWorkflow(file: string): string {
  return fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8').replace(/\r\n/g, '\n');
}

const workflowFiles = fs
  .readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .sort();

/**
 * The top-level `concurrency:` block of a workflow, comments removed.
 *
 * Top-level only (column 0), so a job-level block is never mistaken for it,
 * and comment lines are dropped first, so prose that happens to say `group:`
 * cannot satisfy an assertion.
 */
function workflowConcurrency(file: string): { group: string; cancelInProgress: string } {
  const lines = readWorkflow(file).split('\n');
  const start = lines.indexOf('concurrency:');
  if (start === -1) throw new Error(`${file}: no top-level concurrency block`);

  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !/^\s/.test(line)) break;
    if (!/^\s*#/.test(line)) body.push(line);
  }

  const read = (key: string): string => {
    const found = body
      .map((line) => new RegExp(`^  ${key}:\\s*(.+?)\\s*$`).exec(line))
      .filter((match): match is RegExpExecArray => match !== null);
    if (found.length !== 1) {
      throw new Error(`${file}: expected exactly one concurrency ${key}, found ${found.length}`);
    }
    return found[0][1];
  };

  return { group: read('group'), cancelInProgress: read('cancel-in-progress') };
}

/** Every `group:` value in a file, at any depth, comments removed. */
function everyGroup(file: string): string[] {
  return readWorkflow(file)
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => /^\s+group:\s*(.+?)\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1]);
}

const stagingDeploy = workflowConcurrency('deploy-staging.yml');
const productionDeploy = workflowConcurrency('deploy-production.yml');
const migrations = workflowConcurrency('apply-migrations.yml');

/**
 * A workflow's `type: choice` options for one dispatch input.
 *
 * Reads to the END of the options block -- the first line indented no deeper
 * than `options:` -- rather than to the first line that is not an option. A
 * reader that stops at a comment or a blank line never sees a choice added
 * after one, and reports the list it expected. Anything in the block that is
 * neither an option, a comment nor blank is refused, not skipped.
 */
function choiceOptions(workflow: string, input: string): string[] {
  const lines = workflow.split('\n');
  const inputAt = lines.indexOf(`      ${input}:`);
  if (inputAt === -1) throw new Error(`no dispatch input named ${input}`);

  let optionsAt = -1;
  for (let i = inputAt + 1; i < lines.length; i += 1) {
    if (lines[i].trim() !== '' && !/^ {8}/.test(lines[i])) break;
    if (lines[i] === '        options:') {
      optionsAt = i;
      break;
    }
  }
  if (optionsAt === -1) throw new Error(`input ${input} has no options block`);

  const options: string[] = [];
  for (const line of lines.slice(optionsAt + 1)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (!/^ {9,}/.test(line)) break;
    const option = /^ {10}- (\S+)$/.exec(line);
    if (!option) throw new Error(`input ${input}: cannot read the options line "${line}"`);
    options.push(option[1]);
  }
  return options;
}

/**
 * Workflows that take a `target` environment and are outside the two shared
 * groups, so they are NOT serialized against a release or a migration of that
 * environment. Most keep a group of their own; check-database.yml has none.
 *
 * This list is a statement of what the lock does not cover, kept so nobody
 * reads "migrations and deploys share a group" as "every write to an
 * environment is serialized". Bringing one of these inside the lock is a
 * decision about that workflow; it moves out of this list when that is made.
 * A NEW target-taking workflow fails the discovery test below until it is
 * placed on one side or the other. Discovery keys on `inputs.target`, so a
 * workflow that hard-codes its environment, or names the input differently, is
 * not found by it.
 */
const OUTSIDE_THE_LOCK = [
  // The eight the release ruling of 2026-10-01 counts as the other writers.
  'approve-library-baseline.yml',
  'cleanup-membership-orphans.yml',
  'import-shadow-research.yml',
  'move-policy-shelf.yml',
  'repair-research-baseline.yml',
  'rescope-library-baseline.yml',
  'retention-cleanup.yml',
  'seed-reference-data.yml',
  // Three more that take a target. Not classified here as writers or readers.
  'backup.yml',
  'check-database.yml',
  'run-checks.yml',
];

// release-one-approval.yml holds both groups at JOB level, one per job;
// releaseOneApprovalContract.test.ts pins which job holds which.
const INSIDE_THE_LOCK = [
  'apply-migrations.yml',
  'deploy-production.yml',
  'deploy-staging.yml',
  'release-one-approval.yml',
];

describe('migrations and deploys of one environment share one concurrency group', () => {
  test('the deploy workflows declare the groups this contract is built from', () => {
    // Guard against a vacuous file: every assertion below compares against
    // these, and two empty strings would agree with each other perfectly.
    expect(stagingDeploy.group).toBe('deploy-staging-app-ppbf-staging');
    expect(productionDeploy.group).toBe('deploy-production-main');
    expect(stagingDeploy.group).not.toBe(productionDeploy.group);
  });

  test('apply-migrations maps each target to that environment\'s deploy group', () => {
    // Built from what the deploy workflows declare, not from a literal held
    // here, so a renamed deploy group cannot leave this assertion green.
    expect(migrations.group).toBe(
      `\${{ inputs.target == 'production' && '${productionDeploy.group}' || '${stagingDeploy.group}' }}`,
    );
  });

  test('no group of its own survives beside the mapping', () => {
    // A second `apply-migrations-<target>` group anywhere in the file -- at
    // job level, say -- would look harmless and would be the old behaviour.
    expect(everyGroup('apply-migrations.yml')).toEqual([migrations.group]);

    // everyGroup reads the block form only. A job-level group can also be
    // written `concurrency: name` or `concurrency: { group: name }`, so count
    // the keys instead of trusting one spelling: there is exactly one, and it
    // is the top-level block read above.
    const code = readWorkflow('apply-migrations.yml')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line));
    expect(code.filter((line) => /^\s*concurrency\s*:/.test(line))).toEqual(['concurrency:']);
    expect(code.filter((line) => /apply-migrations-\$\{\{/.test(line))).toEqual([]);
  });

  test('the only targets are staging and production', () => {
    // The expression sends every target that is not `production` to the
    // staging group. That is only right while there is no third target.
    expect(choiceOptions(readWorkflow('apply-migrations.yml'), 'target'))
      .toEqual(['staging', 'production']);
  });

  test('the choice reader sees an option added after a comment or a blank line', () => {
    // The first version of this reader matched consecutive option lines and
    // stopped at the first thing that was not one, so a third target placed
    // after a comment was invisible and the test above stayed green.
    const withThird = [
      '      target:',
      '        type: choice',
      '        options:',
      '          - staging',
      '          - production',
      '          # added later',
      '',
      '          - preview',
      '      confirm_target:',
      '        options:',
      '          - not-this-one',
    ].join('\n');
    expect(choiceOptions(withThird, 'target')).toEqual(['staging', 'production', 'preview']);
    expect(() => choiceOptions(withThird.replace('- preview', '-preview'), 'target'))
      .toThrow(/cannot read the options line/);
    expect(() => choiceOptions(withThird, 'migration')).toThrow(/no dispatch input named/);
  });

  test.each([
    ['apply-migrations.yml', migrations],
    ['deploy-staging.yml', stagingDeploy],
    ['deploy-production.yml', productionDeploy],
  ])('%s never cancels a run in progress', (_file, concurrency) => {
    expect(concurrency.cancelInProgress).toBe('false');
  });
});

describe('what the lock covers is stated, not implied', () => {
  const canonical = [stagingDeploy.group, productionDeploy.group];
  const namesCanonicalGroup = (file: string): boolean =>
    everyGroup(file).some((group) => canonical.some((literal) => group.includes(literal)));

  test('the workflow directory was read (guard against a vacuous test)', () => {
    expect(workflowFiles.length).toBeGreaterThan(10);
  });

  test('exactly the release and migration workflows hold the shared groups', () => {
    expect(workflowFiles.filter(namesCanonicalGroup)).toEqual(INSIDE_THE_LOCK);
  });

  test.each(OUTSIDE_THE_LOCK)('%s exists and is outside the lock', (file) => {
    // A stale entry -- a workflow renamed, deleted, or since brought inside --
    // would leave this list claiming a gap that is no longer there.
    expect(workflowFiles).toContain(file);
    expect(namesCanonicalGroup(file)).toBe(false);
  });

  test('every workflow that takes a target is on one side or the other', () => {
    const takesTarget = workflowFiles.filter((file) => /\binputs\.target\b/.test(readWorkflow(file)));
    expect(takesTarget.length).toBeGreaterThan(5);

    const unplaced = takesTarget.filter(
      (file) => !INSIDE_THE_LOCK.includes(file) && !OUTSIDE_THE_LOCK.includes(file),
    );
    expect(unplaced).toEqual([]);
  });
});
