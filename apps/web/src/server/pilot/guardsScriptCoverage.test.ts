import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * `npm run guards` must actually run the guards.
 *
 * WHY THIS EXISTS. The guards script selects suites by PATTERN rather than by
 * a hand-written list, deliberately: a hand-maintained list is one somebody has
 * to remember to update, and this repository has been bitten by that three
 * times over (the CI Playwright-install disjunction, the seed-loader guard in
 * #700, the test:migrations chain that silently lost seven suites).
 *
 * A pattern has the opposite failure mode, and it is quieter. A rename, a
 * directory move, or a jest flag change can leave the pattern matching NOTHING
 * -- and `jest` with a pattern that matches nothing exits 0. `npm run guards`
 * would report success, having run not one guard, and every future push would
 * be "checked" by a command that does nothing.
 *
 * So this asserts the pattern still selects a real, plural set. It lives in a
 * plain .test.ts rather than inside the guards selection itself, on purpose: a
 * suite that only runs when the pattern works cannot be the thing that detects
 * the pattern not working. This one runs in `npm test` regardless.
 */

const PACKAGE_JSON = path.resolve(__dirname, '../../../package.json');
const PILOT_DIR = __dirname;

function guardsPattern(): RegExp {
  const parsed = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
    scripts: Record<string, string>;
  };
  const script = parsed.scripts.guards;
  expect(typeof script).toBe('string');

  // The pattern as the script actually passes it, single-quoted after the
  // flag. Read out of the command rather than restated here -- a copy would
  // let the script and this test drift apart, each looking correct alone.
  const match = /--testPathPatterns='([^']+)'/.exec(script);
  expect(match).not.toBeNull();
  return new RegExp((match as RegExpExecArray)[1]);
}

/** Every meta-guard suite on disk, by the naming convention they all follow. */
function metaGuardFilesOnDisk(): string[] {
  return readdirSync(PILOT_DIR)
    .filter((file) => /(Coverage|Contract|Ownership)\.test\.ts$/.test(file))
    .filter((file) => !file.endsWith('.pg.test.ts'))
    .sort();
}

describe('the guards script selects the guards', () => {
  test('package.json defines a guards script that runs jest with a path pattern', () => {
    const parsed = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(parsed.scripts.guards).toContain('jest');
    expect(parsed.scripts.guards).toContain('--testPathPatterns=');
  });

  test('the pattern matches a plural set, not zero and not one', () => {
    const pattern = guardsPattern();
    const matched = metaGuardFilesOnDisk().filter((file) => pattern.test(file));

    // The floor is the point. `jest` exits 0 on a pattern matching nothing, so
    // without a number here a broken pattern reads as a passing guards run.
    expect(matched.length).toBeGreaterThanOrEqual(10);
  });

  test('every meta-guard file on disk is selected by the pattern', () => {
    const pattern = guardsPattern();
    const missed = metaGuardFilesOnDisk().filter((file) => !pattern.test(file));

    // Catches a narrowing edit: a pattern tightened to fix one thing, that
    // quietly stops selecting a dozen others.
    expect(missed).toEqual([]);
  });

  test('pg suites are NOT selected -- guards must stay fast enough to run before every push', () => {
    const pattern = guardsPattern();
    const pgSuites = readdirSync(PILOT_DIR).filter((file) => file.endsWith('.pg.test.ts'));
    expect(pgSuites.length).toBeGreaterThan(50);

    // Each pg suite boots an embedded Postgres. Sweeping even a few of them in
    // turns a 3-second check into a multi-minute one, and a check that is
    // slow to run is a check people stop running.
    const swept = pgSuites.filter((file) => pattern.test(file));
    expect(swept).toEqual([]);
  });
});
