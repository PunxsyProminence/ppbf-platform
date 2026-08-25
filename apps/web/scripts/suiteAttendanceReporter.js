'use strict';

/**
 * NO SUITE PASSES BY NOT LOADING.
 *
 * THE INCIDENT. #646 and #649 each added a seed-literal scanner to
 * `src/design/safeguardingRedReservation.test.ts`, and both declared
 * `LITERAL_SITES` at file scope. Merged in sequence, the file stopped
 * parsing:
 *
 *     SyntaxError: Identifier 'LITERAL_SITES' has already been declared
 *
 * The run then said `Test Suites: 1 failed, 586 passed` and
 * `Tests: 8017 passed` -- and the passing test count went UP, because the
 * eight assertions that file owns did not fail, they ceased to exist. The
 * guard on the reserved medical red (#A81E22 / MEDICALLY_NOT_ALLOWED) was
 * absent from `main` and no summary said so.
 *
 * WHY THIS IS A DIFFERENT HOLE FROM THE ONE #651 CLOSED. #651 added
 * non-emptiness FLOORS inside suites, for guards that pass while reading
 * nothing. A floor lives in the suite, so it cannot help a suite that never
 * executes. `readDesignSystemCss.ts` records the same species from the other
 * direction: thirteen guards silently stopped guarding when a sheet became
 * two `@import` lines. Every one of these is the same shape -- coverage
 * leaves without the coverage report changing sign.
 *
 * WHAT THIS DOES. It reads `src/testing/safetyCriticalSuites.json`, and at the
 * end of every unnarrowed run compares that register against what actually
 * ran. A named suite that is missing, that failed to load, or that contributed
 * fewer executed tests than its measured floor fails the run BY NAME, through
 * `getLastError()` -- which `@jest/core`'s TestScheduler folds into
 * `aggregatedResults.success`, so the process exits non-zero.
 *
 * WHY A REPORTER RATHER THAN A TEST OR A CI STEP.
 *
 *   - A CI step running `jest --listTests` compares FILENAMES. A file that
 *     exists but does not parse is still listed, so the actual incident walks
 *     straight past it. It is also CI-only: a developer's own `npm test` stays
 *     unguarded, and this repository's history is mostly about the gap between
 *     "CI would have caught it" and "it reached main".
 *   - `globalSetup` runs BEFORE any suite executes. It can stat files and
 *     nothing more -- the same blind spot as `--listTests`, and it can never
 *     see a test count.
 *   - A plain test that `require()`s each named suite re-registers all of
 *     their `describe`/`it` blocks into itself (~426 tests run twice, and the
 *     expensive filesystem scanners with them), needs a jsdom environment for
 *     the `.tsx` entries in a `node`-default config, and still cannot tell
 *     "registered nothing" from "registered into somebody else's suite".
 *   - A test that spawns a child `jest --json` gets the right answer and pays
 *     for it by running the watched suites a second time.
 *   - Type-checking each file answers a different question. `tsc --noEmit`
 *     does catch this particular collision (TS2451) and did not prevent it
 *     reaching `main`; and a suite that is deleted, renamed, emptied, skipped,
 *     or broken by a throwing module-scope import is perfectly type-clean.
 *
 * The reporter is the only mechanism that sees what a run actually did.
 *
 * IT REPORTS ABSENCE. IT DOES NOT REPAIR ANYTHING. A dark suite is still a
 * dark suite after this fires; the rule it holds is unguarded until somebody
 * fixes the file. Deleting the manifest entry is not fixing the file.
 *
 * Its own behaviour is proven under mutation by
 * `src/testing/suiteAttendance.test.ts`, which drives it with synthetic run
 * results for each failure mode.
 */

/* Jest resolves and `require`s a custom reporter itself, outside the ts-jest
 * transform this project configures for `.ts`/`.tsx`. So this file has to be
 * plain CommonJS -- it cannot be TypeScript and it cannot use ESM import
 * syntax. The rule is disabled for these two lines only. */
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');
/* eslint-enable @typescript-eslint/no-require-imports */

const MANIFEST_RELATIVE = 'src/testing/safetyCriticalSuites.json';
const MANIFEST_PATH = path.resolve(__dirname, '..', MANIFEST_RELATIVE);

const RULE = '='.repeat(78);

/* The sentence this whole file exists to put on the screen. */
const COUNT_IS_NOT_COVERAGE = [
  'A suite that does not load reports as ONE failing file while every assertion it',
  'owns disappears from the totals -- the run\'s passing test count goes UP, not down.',
  'THE PASSING COUNT IS NOT EVIDENCE OF COVERAGE. Read the list above instead.',
].join('\n');

const NOT_A_FIX = [
  'This guard reports absence. It does not repair a suite and it does not stand in',
  'for one: until each file above runs again, the rule it holds is unguarded.',
  'Fix the suite. Deleting or lowering its manifest entry is not fixing the suite.',
].join('\n');

/* Jest colours its failure messages. The pattern is built from a char code
 * rather than written as an escape in a literal, so the source of a file that
 * exists to make failures legible carries no control characters itself. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** Strip ANSI so a quoted loader error stays readable in a log file. */
function plain(text) {
  return String(text).replace(ANSI, '');
}

/**
 * The line shapes worth quoting out of a loader failure: the thrown error, a
 * TypeScript diagnostic, an unresolved module, and the file:line the loader
 * stopped at.
 */
const DIAGNOSTIC = /\b\w*Error\b|\berror TS\d{4}\b|Cannot find module|\.tsx?:\d+/;

/**
 * A short, USEFUL excerpt of a Jest failure message.
 *
 * Not simply the first N lines. When a suite fails to parse, Jest's first
 * fifteen lines are generic advice about Babel and `transformIgnorePatterns`,
 * and the sentence that actually identifies the fault -- "SyntaxError:
 * Identifier 'LITERAL_SITES' has already been declared" -- is well below them.
 * An excerpt that quotes the boilerplate tells the reader nothing they can act
 * on, which is most of the way back to the failure this file exists to end.
 */
function excerpt(text, limit) {
  const lines = plain(text)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return '      Test suite failed to run.';

  const diagnostic = lines.slice(1).filter((line) => DIAGNOSTIC.test(line));
  const chosen = diagnostic.length > 0 ? diagnostic.slice(0, limit - 1) : lines.slice(1, limit);
  return [lines[0], ...chosen].map((line) => `      ${line.trim()}`).join('\n');
}

/**
 * Why this run is not a complete one, or null if it is.
 *
 * Enforcement is for runs that were asked to collect everything. Someone
 * running one file must not be told the other nineteen went dark -- that is
 * how a guard gets switched off for being noisy. The full `npm test`, which
 * is what CI runs, passes none of these.
 */
function narrowingReason(globalConfig, contexts) {
  const raw = globalConfig.testPathPatterns;
  const patterns = Array.isArray(raw) ? raw : (raw && raw.patterns) || [];
  if (patterns.length > 0) {
    return `test path pattern ${JSON.stringify(patterns)}`;
  }
  if (globalConfig.testNamePattern) return `-t ${JSON.stringify(globalConfig.testNamePattern)}`;
  if (globalConfig.runTestsByPath) return '--runTestsByPath';
  if (globalConfig.onlyChanged) return '--onlyChanged';
  if (globalConfig.onlyFailures) return '--onlyFailures';
  if (globalConfig.lastCommit) return '--lastCommit';
  if (globalConfig.changedSince) return `--changedSince=${globalConfig.changedSince}`;
  if (globalConfig.findRelatedTests) return '--findRelatedTests';
  if (globalConfig.shard) return '--shard';
  if (globalConfig.bail) return '--bail';
  if (globalConfig.filter) return '--filter';
  if (globalConfig.listTests) return '--listTests';

  /* `--roots` is not a flag this can read off globalConfig, so it is read off
   * what the run was actually pointed at: a run whose roots do not include the
   * project root was aimed at a subtree and is not a whole-repository run. */
  const rootDir = path.resolve(globalConfig.rootDir);
  const reachesRoot = contexts.some((context) =>
    ((context && context.config && context.config.roots) || []).some(
      (root) => path.resolve(root) === rootDir,
    ),
  );
  if (!reachesRoot) return '--roots (this run was pointed at a subtree)';

  return null;
}

/** The configured ignore pattern that swallowed `absolutePath`, if any. */
function ignoredBy(contexts, absolutePath) {
  for (const context of contexts) {
    const patterns = (context && context.config && context.config.testPathIgnorePatterns) || [];
    for (const pattern of patterns) {
      try {
        if (new RegExp(pattern).test(absolutePath)) return pattern;
      } catch {
        /* An unparsable pattern is Jest's problem to report, not this one's. */
      }
    }
  }
  return null;
}

class SuiteAttendanceReporter {
  /**
   * `options.manifestPath` exists so `src/testing/suiteAttendance.test.ts` can
   * drive the deleted-suite branch against a throwaway register without
   * deleting a real guard from the working tree. It is not a production knob:
   * `jest.config.js` registers this reporter as a bare string with no options,
   * and that wiring is itself asserted by the same test file -- so pointing the
   * real run at a different register cannot be done quietly.
   */
  constructor(globalConfig, options) {
    this._globalConfig = globalConfig || {};
    this._manifestPath = (options && options.manifestPath) || MANIFEST_PATH;
    this._error = undefined;
  }

  /**
   * `@jest/core` calls this after `onRunComplete` and folds a returned Error
   * into `aggregatedResults.success`, which is what sets the exit code.
   */
  getLastError() {
    return this._error;
  }

  onRunComplete(contexts, results) {
    this._error = undefined;

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(this._manifestPath, 'utf8'));
    } catch (cause) {
      this._fail(
        'THE SAFETY-CRITICAL SUITE MANIFEST COULD NOT BE READ',
        [
          `  ${this._manifestPath}`,
          `    ${plain(cause && cause.message)}`,
          '',
          'Without it nothing checks that the named suites ran at all, so the run fails',
          'rather than continuing unguarded.',
        ].join('\n'),
      );
      return;
    }

    const entries = Array.isArray(manifest.suites) ? manifest.suites : [];
    if (entries.length === 0) {
      this._fail(
        'THE SAFETY-CRITICAL SUITE MANIFEST IS EMPTY',
        [
          `  ${this._manifestPath} lists no suites, so it can never report one missing.`,
          '',
          'An empty register is the same failure as a suite that does not load: a check',
          'that reads nothing passes.',
        ].join('\n'),
      );
      return;
    }

    const contextList = Array.from(contexts || []);
    const reason = narrowingReason(this._globalConfig, contextList);
    if (reason) {
      process.stderr.write(
        `\nsuite attendance: not enforced -- this run was narrowed by ${reason}. ` +
          `${entries.length} safety-critical suites were not checked for attendance.\n`,
      );
      return;
    }

    const rootDir = path.resolve(this._globalConfig.rootDir || path.resolve(__dirname, '..'));
    const ran = new Map();
    for (const result of (results && results.testResults) || []) {
      ran.set(path.resolve(result.testFilePath), result);
    }

    const dark = [];
    for (const entry of entries) {
      const absolute = path.resolve(rootDir, entry.path);
      const floor =
        Number.isInteger(entry.minimumTests) && entry.minimumTests > 0 ? entry.minimumTests : 1;
      const result = ran.get(absolute);

      if (!result) {
        if (!fs.existsSync(absolute)) {
          dark.push({
            entry,
            kind: 'DELETED OR RENAMED',
            detail:
              '      No file exists at this path. If the suite moved, move its manifest\n' +
              '      entry with it; if it was deleted, say in the same change what now\n' +
              '      holds the rule it held.',
          });
          continue;
        }
        const pattern = ignoredBy(contextList, absolute);
        dark.push({
          entry,
          kind: pattern ? 'EXCLUDED FROM THE RUN' : 'NOT COLLECTED BY THIS RUN',
          detail: pattern
            ? `      The file exists but testPathIgnorePatterns entry ${JSON.stringify(pattern)}\n` +
              '      matched it, so Jest never ran it.'
            : '      The file exists but Jest did not collect it. Check that its name still\n' +
              '      matches testMatch (**/*.test.ts, **/*.test.tsx).',
        });
        continue;
      }

      const registered = ((result.testResults || []).length) || 0;
      const executed = (result.numPassingTests || 0) + (result.numFailingTests || 0);
      const skipped = (result.numPendingTests || 0) + (result.numTodoTests || 0);

      if (result.testExecError || (registered === 0 && result.failureMessage)) {
        dark.push({
          entry,
          kind: 'FAILED TO LOAD',
          detail: excerpt(
            result.failureMessage ||
              (result.testExecError && (result.testExecError.stack || result.testExecError.message)) ||
              'Test suite failed to run.',
            6,
          ),
        });
        continue;
      }

      if (executed < floor) {
        dark.push({
          entry,
          kind: 'CONTRIBUTED TOO FEW TESTS',
          detail:
            `      executed ${executed}, measured floor ${floor} ` +
            `(registered ${registered}, skipped ${skipped}).`,
        });
      }
    }

    if (dark.length === 0) return;

    const body = dark
      .map((item) =>
        [
          `  ${item.entry.path}`,
          `    ${item.kind}`,
          `    guards: ${item.entry.guards || '(no reason recorded in the manifest)'}`,
          item.detail,
        ].join('\n'),
      )
      .join('\n\n');

    this._fail(
      `SAFETY-CRITICAL SUITES WENT DARK -- ${dark.length} of ${entries.length} did not run`,
      `${body}\n\n${COUNT_IS_NOT_COVERAGE}\n\n${NOT_A_FIX}\nManifest: apps/web/${MANIFEST_RELATIVE}`,
    );
  }

  _fail(headline, body) {
    const message = `${RULE}\n${headline}\n${RULE}\n\n${body}\n${RULE}\n`;
    process.stderr.write(`\n${message}`);
    this._error = new Error(message);
  }
}

module.exports = SuiteAttendanceReporter;
