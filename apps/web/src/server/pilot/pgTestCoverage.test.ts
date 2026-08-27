import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Every .pg.test.ts file must be reachable from `npm run test:migrations`.
 *
 * These tests boot an embedded Postgres and apply real migration SQL, so they
 * are deliberately excluded from the default `test` script
 * (`--testPathIgnorePatterns=\.pg\.test\.ts$`). That exclusion means the *only*
 * thing that runs them is the hand-maintained `test:migrations` chain -- and a
 * hand-maintained list of 29 entries is a list that silently loses entries.
 *
 * It had lost seven. `complianceMigration`, `progressionMigration`,
 * `publicationsMigration`, `drillsPersistence`, `guardianInviteLink`,
 * `durableRateLimit` and `assistantMessageIdempotency` all existed, all passed,
 * and none had ever run in CI. The migrations they guard looked covered to
 * anyone counting test files, and were not covered at all.
 *
 * That is the failure this file exists to make impossible. Writing a .pg.test.ts
 * and forgetting to wire it up is the natural mistake -- nothing fails, the file
 * looks like every other test in the directory, and the gap is invisible until
 * someone diffs the directory against the script by hand.
 *
 * THE CHECK IS NOW ONE HOP, NOT TWO. `test:migrations` used to be a chain
 * naming 118 scripts, so a suite could be unreachable two different ways: no
 * script, or a script the chain forgot. This file followed both hops
 * deliberately. The chain is now a discovery runner
 * (scripts/run-migration-suites.mjs) that executes every `test:migrations:*`
 * script it finds, which makes the second way UNREPRESENTABLE -- there is no
 * list left to fall off. What remains to check is that every .pg.test.ts has a
 * script at all, and that every script names a file that exists.
 *
 * Equivalence was measured at the swap rather than assumed: the chain named
 * 118 scripts, package.json defined 118, and the difference was empty in both
 * directions. That property is asserted below so it cannot rot.
 */

const PILOT_DIR = __dirname;
const SCRIPTS_DIR = path.resolve(__dirname, '../../../scripts');
const PACKAGE_JSON = path.resolve(__dirname, '../../../package.json');

// Every .pg.test.ts file, full stop -- not just the ones under this
// directory. Most live in src/server/pilot/, but a script with no
// database-connecting counterpart in this directory (e.g. a standalone
// data importer) can carry its own .pg.test.ts in scripts/ instead, and
// that file needs this same guard just as much.
function pgTestFiles(): string[] {
  return [
    ...readdirSync(PILOT_DIR).filter((file) => file.endsWith('.pg.test.ts')),
    ...readdirSync(SCRIPTS_DIR).filter((file) => file.endsWith('.pg.test.ts')),
  ].sort();
}

function migrationChainScripts(): { chain: string; scripts: Record<string, string> } {
  const parsed = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
    scripts: Record<string, string>;
  };
  return { chain: parsed.scripts['test:migrations'] ?? '', scripts: parsed.scripts };
}

/**
 * The set of .pg.test.ts filenames the chain actually executes: every
 * `test:migrations:*` the chain names, resolved to the path its jest invocation
 * runs. Deliberately follows the indirection rather than searching package.json
 * for the filename -- a script that exists but is missing from the chain is
 * exactly the bug here, and a naive text search would call that covered.
 */
function suiteScriptNames(): string[] {
  const { scripts } = migrationChainScripts();
  // The same predicate the runner uses. Restated rather than imported because
  // this file must be able to disagree with the runner: a test that asks the
  // runner what it runs cannot notice the runner running the wrong thing.
  return Object.keys(scripts).filter((name) => /^test:migrations:[a-z0-9-]+$/.test(name));
}

function coveredPgTests(): Set<string> {
  const { scripts } = migrationChainScripts();
  const covered = new Set<string>();

  for (const scriptName of suiteScriptNames()) {
    const command = scripts[scriptName];
    if (!command) continue;

    for (const match of command.matchAll(/--runTestsByPath\s+(\S+)/g)) {
      covered.add(path.basename(match[1]));
    }
  }

  return covered;
}

describe('pg test coverage', () => {
  it('runs every .pg.test.ts file from the test:migrations runner', () => {
    const orphaned = pgTestFiles().filter((file) => !coveredPgTests().has(file));

    expect(orphaned).toEqual([]);
  });

  it('names only .pg.test.ts files that exist', () => {
    const onDisk = new Set(pgTestFiles());
    const missing = [...coveredPgTests()].filter((file) => !onDisk.has(file));

    // A chain entry pointing at a deleted file fails the whole chain at that
    // step, so this direction is loud rather than silent -- but it fails after
    // however many minutes of embedded Postgres came before it, and it fails in
    // a migrations job rather than in the fast suite. Better to catch it here.
    expect(missing).toEqual([]);
  });

  it('detects an orphan when one exists', () => {
    // Negative control. Both assertions above pass trivially if the helpers
    // return empty sets -- a typo in the glob or the regex would make this file
    // permanently green while covering nothing, which is precisely the class of
    // failure it was written to catch.
    const covered = coveredPgTests();
    const pretendNewFile = 'somethingBrandNew.pg.test.ts';

    expect(covered.size).toBeGreaterThan(0);
    expect(pgTestFiles().length).toBeGreaterThan(0);
    expect(covered.has(pretendNewFile)).toBe(false);
  });

  it('test:migrations delegates to the runner rather than naming suites itself', () => {
    const { chain } = migrationChainScripts();

    // If somebody reintroduces a hand-written chain, the two-hop gap comes back
    // with it and the comment above stops being true. Naming the file keeps the
    // failure legible.
    expect(chain).toBe('node scripts/run-migration-suites.mjs');
    expect(chain).not.toContain('npm run test:migrations:');
  });

  it('the runner would discover a plural set, not a truncated one', () => {
    // The failure a discovery runner can have and a chain cannot: matching
    // nothing, running nothing, and exiting 0. The runner refuses below 50 for
    // this reason; this asserts the manifest actually holds that many, so the
    // refusal is a floor and not the normal case.
    expect(suiteScriptNames().length).toBeGreaterThanOrEqual(100);
  });
});
