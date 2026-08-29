/**
 * Every read-only check script must be reachable from run-checks.yml.
 *
 * This is migrationDispatchCoverage.test.ts's question asked about the other
 * workflow, and it starts from the same end for the same reason: from the
 * FILES on disk, not from the npm scripts. An audit keyed on npm scripts is
 * structurally blind to a script that has no npm script, and that is precisely
 * how three checks came to be unreachable:
 *
 *   seed-identity           npm script, no workflow entry -- laptop-only
 *   runtime-claims          npm script, no workflow entry -- laptop-only
 *   videos-missing-consent  a file, and nothing else at all
 *
 * The third is the one that matters most and the one an npm-keyed guard could
 * never have found. It is the standing guardian media consent sweep for
 * minors, delivered against a P1 safeguarding ticket (T-008), and it could not
 * be run by name from anywhere -- not from CI, not from the workflow, not with
 * `npm run` on a laptop. A compliance sweep nobody can invoke is a compliance
 * sweep that does not exist.
 *
 * run-checks.yml has a `list-check` dispatch option that asserts the same
 * things. This test exists as well as that one, not instead of it, because a
 * dispatchable audit only runs when somebody remembers to dispatch it, and the
 * failure being guarded here is somebody forgetting.
 */
import fs from 'node:fs';
import path from 'node:path';

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const scriptsDir = path.join(repositoryRoot, 'apps/web/scripts');
const workflowPath = path.join(repositoryRoot, '.github/workflows/run-checks.yml');
const packageJsonPath = path.join(repositoryRoot, 'apps/web/package.json');

const workflow = fs.readFileSync(workflowPath, 'utf8');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
  scripts: Record<string, string>;
};

/** `pilot-check-<slug>.mjs` in apps/web/scripts. The source of truth. */
const checkSlugs = fs
  .readdirSync(scriptsDir)
  .filter((name) => /^pilot-check-.+\.mjs$/.test(name))
  .map((name) => name.replace(/^pilot-check-/, '').replace(/\.mjs$/, ''))
  .sort();

const scriptSlugs = Object.keys(packageJson.scripts)
  .filter((name) => name.startsWith('pilot:check-'))
  .map((name) => name.replace('pilot:check-', ''))
  .sort();

/**
 * The `all` arm, as an ordered list of slugs. Parsed from the `run_one` lines
 * between `all)` and the `;;` that closes it, rather than from a flat search of
 * the file, so a check that appears only in its own case arm does not read as
 * being in `all`.
 */
const allArmBody = workflow.match(/^\s+all\)\n([\s\S]*?)^\s+;;/m)?.[1] ?? '';
const allList = [...allArmBody.matchAll(/run_one\s+([a-z0-9-]+)\s+pilot:check-([a-z0-9-]+)$/gm)].map(
  (match) => ({ label: match[1], script: match[2] }),
);

/** Single-line case arms: `slug) run_one slug pilot:check-slug ;;`. */
const caseArms = [
  ...workflow.matchAll(/^\s+([a-z0-9-]+)\)\s+run_one\s+([a-z0-9-]+)\s+pilot:check-([a-z0-9-]+)\s+;;$/gm),
].map((match) => ({ arm: match[1], label: match[2], script: match[3] }));

/**
 * Checks that answer a question the database does not hold.
 *
 * The read-only-transaction assertion at the bottom is an assertion about SQL,
 * and a check that issues none cannot satisfy it. video-readiness reads three
 * named variables off the deployed Container App's environment -- whether a
 * quarantined video can promote at all is a fact about the deploy, not about
 * any table -- so it holds no connection string and opens no transaction.
 *
 * An exemption from that assertion is not an exemption from being read-only,
 * so it comes with a stricter one in its place: an exempt script must not carry
 * a database client or a connection string at all. Absence of the write is then
 * a property of the file rather than of Postgres, which is the only form of the
 * guarantee available to a script that never connects.
 */
const NON_DATABASE_CHECKS = new Set(['video-readiness']);

/** Every `- foo` under an `options:` block, flattened across both inputs. */
const dropdownOptions = [...workflow.matchAll(/^\s+- ([a-z0-9-]+)$/gm)].map((match) => match[1]);

describe('every read-only check is dispatchable', () => {
  test('the script set is non-empty and every workflow list parsed', () => {
    // Guards the guard. A regex that quietly stopped matching -- a reindent, a
    // switch to multi-line case arms -- would make every assertion below pass
    // vacuously, which is the failure mode of a test that reads source text.
    expect(checkSlugs.length).toBeGreaterThanOrEqual(7);
    expect(allList.length).toBeGreaterThanOrEqual(7);
    expect(caseArms.length).toBeGreaterThanOrEqual(7);
    expect(dropdownOptions).toContain('all');
    expect(dropdownOptions).toContain('list-check');
  });

  test.each(checkSlugs)('pilot-check-%s.mjs has an npm script', (slug) => {
    // The direction that catches a file reachable by nothing. Asserting the
    // exact command, not merely that a key exists, so a script pointing at a
    // copy-pasted sibling's file fails here.
    expect(packageJson.scripts[`pilot:check-${slug}`]).toBe(`node scripts/pilot-check-${slug}.mjs`);
  });

  test.each(checkSlugs)('%s is in the dropdown, in `all`, and has its own case arm', (slug) => {
    // Three lists, three ways to be partly unreachable. Absent from the
    // dropdown, a check can only ever run as part of `all`; absent from `all`,
    // it is skipped by the option operators actually pick; absent from its own
    // arm, choosing it by name falls through to the unknown-check error.
    expect(dropdownOptions).toContain(slug);
    expect(allList.map((entry) => entry.script)).toContain(slug);
    expect(caseArms.map((entry) => entry.arm)).toContain(slug);
  });

  test('every dropdown option runs a real check', () => {
    // The reverse direction: an option with nothing behind it gives an operator
    // a green run and no answer, which reads as "checked and clean".
    //
    // `list-check` and `contested-overlap` are exempt because neither is a
    // `pilot-check-*` database script: each has its own job in the workflow,
    // reading the checkout or the GitHub API rather than Postgres. The
    // exemption does NOT mean they go unchecked -- it means the check moved.
    // contestedOverlapContract.test.ts asserts that its option is in the
    // dropdown, that the job really invokes `node
    // scripts/check-contested-overlap.mjs`, and that the job carries no
    // `environment:` gate. Anything added here without that coverage
    // somewhere is an option with nothing behind it, which is what this test
    // exists to catch.
    const notChecks = new Set(['all', 'list-check', 'contested-overlap', 'staging', 'production']);
    const orphaned = dropdownOptions.filter(
      (option) => !notChecks.has(option) && !scriptSlugs.includes(option),
    );
    expect(orphaned).toEqual([]);
  });

  test('every `all` entry and case arm names a real check', () => {
    expect(allList.filter((entry) => !scriptSlugs.includes(entry.script))).toEqual([]);
    expect(caseArms.filter((entry) => !scriptSlugs.includes(entry.script))).toEqual([]);
  });

  test('a label never disagrees with the script it runs', () => {
    // `run_one stranded-guardians pilot:check-multiorg-orphans` would run the
    // wrong check under the right heading, and the step summary would report
    // the heading. Both lines are hand-written and the two halves look alike.
    expect(allList.filter((entry) => entry.label !== entry.script)).toEqual([]);
    expect(
      caseArms.filter((entry) => entry.arm !== entry.label || entry.label !== entry.script),
    ).toEqual([]);
  });

  test('`all` and the case arms cover exactly the same set', () => {
    // Unlike apply-migrations, where `schema` is deliberately dispatch-only,
    // there is no check here that should be reachable one way and not the
    // other: none of them writes, so none needs holding back from `all`.
    const inAll = new Set(allList.map((entry) => entry.script));
    const inArms = new Set(caseArms.map((entry) => entry.arm));
    expect([...inArms].filter((slug) => !inAll.has(slug))).toEqual([]);
    expect([...inAll].filter((slug) => !inArms.has(slug))).toEqual([]);
  });

  test('every check runs read-only against the database it is pointed at', () => {
    // The workflow's stated safety property -- "these scripts cannot write" --
    // is what justifies dispatching them against production with no
    // confirm_target. It is a property of the scripts, so it is asserted on the
    // scripts: Postgres refuses the write, rather than a reviewer noticing.
    for (const slug of checkSlugs) {
      const source = fs.readFileSync(path.join(scriptsDir, `pilot-check-${slug}.mjs`), 'utf8');
      if (NON_DATABASE_CHECKS.has(slug)) {
        // The substitute guarantee. A script listed here must not be able to
        // reach a database at all -- so adding a query to one later, without
        // also taking it off the list, fails here rather than shipping an
        // unwrapped statement against production.
        expect(source).not.toContain("from 'pg'");
        expect(source).not.toContain('AZURE_POSTGRES_CONNECTION_STRING');
        continue;
      }
      expect(source).toContain('BEGIN TRANSACTION READ ONLY');
    }
  });

  test('the non-database exemption names only checks that exist', () => {
    // A stale entry here silently disarms the assertion above for a check that
    // was renamed, and a typo'd one disarms it for nothing while looking like
    // it covers something. Neither is visible in the test that uses the set.
    expect([...NON_DATABASE_CHECKS].filter((slug) => !checkSlugs.includes(slug))).toEqual([]);
  });
});
