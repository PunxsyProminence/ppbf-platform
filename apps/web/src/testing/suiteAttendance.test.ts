import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import SuiteAttendanceReporter from '../../scripts/suiteAttendanceReporter';
import manifest from './safetyCriticalSuites.json';

/**
 * NO SUITE PASSES BY NOT LOADING.
 *
 * THE INCIDENT, 2026-08-25. #646 and #649 each added a seed-literal scanner to
 * `src/design/safeguardingRedReservation.test.ts` and both declared
 * `LITERAL_SITES` at file scope, so after the second merge the file would not
 * parse. The run reported `Test Suites: 1 failed, 586 passed` and
 * `Tests: 8017 passed` -- and the passing test COUNT WENT UP, because the
 * eight assertions on the reserved medical red did not fail, they ceased to
 * exist. Nobody reading a summary sees a safeguarding guard disappear.
 *
 * That is a cousin of what #651 fixed, arriving through a different door.
 * #651 added non-emptiness FLOORS INSIDE suites, against guards that pass
 * while reading nothing. A floor cannot help a suite that never executes.
 * `readDesignSystemCss.ts` records the same species from the other direction:
 * thirteen guards silently stopped guarding when a sheet was split into
 * `@import`s and every one of them kept passing.
 *
 * ---------------------------------------------------------------------------
 * THE TWO HALVES.
 *
 *   1. `scripts/suiteAttendanceReporter.js` is the enforcement. It is the only
 *      mechanism in Jest that can see what a run ACTUALLY DID -- which suites
 *      loaded, which threw at load, and how many tests each contributed. On an
 *      unnarrowed run it fails the run by name for any register entry that is
 *      missing, failed to load, or came in under its floor.
 *
 *   2. THIS FILE keeps the register honest and proves the reporter bites. A
 *      guard whose failure path is never exercised is the thing it is guarding
 *      against, so the reporter is driven here with synthetic run results for
 *      each failure mode -- and with a correct one, to prove it stays quiet.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE SUITES AND NOT THE OTHER SIXTY-TWO.
 *
 * `src/design/` holds 22 test files contributing 589 tests, and `components/`
 * holds 59 contributing 1,020. Nineteen of those 81 are registered, plus this
 * file, which is registered against itself -- a guard on guards that could
 * vanish silently would leave the register unvalidated and every entry in it
 * unproven. A suite is registered when its disappearance would remove the ONLY
 * automated proof of a rule that, when broken:
 *
 *   (a) miscommunicates a safety state to a coach, a guardian or a child --
 *       the safety ladder, the reserved medical red, the refusal vocabulary,
 *       a corner tint mistakable for a hold;
 *   (b) lets a governed artefact enter the repository unchecked -- the plate
 *       byte gate;
 *   (c) drops a legibility or accessibility floor on a shared surface --
 *       light-ground voices, dark-panel ink, the tap floor, the type ladder;
 *   (d) is the load-bearing mechanism a whole family of other guards stands
 *       on -- the CSS import resolver, the design-system class check;
 *   (e) is a ratchet whose baseline cannot be recovered once lost -- the
 *       frozen ceilings on the retired vocabulary, measured at the reset;
 *   (f) is a role or session boundary -- the front door, the board gate, the
 *       role session every page guard runs;
 *   (g) is an honesty declaration whose absence makes fabricated figures read
 *       as organisational fact.
 *
 * AND the suite must be silent-failure prone: nothing else in the repository
 * goes red when it goes dark.
 *
 * THE EIGHT `goldenEra*Scope` SUITES ARE DELIBERATELY EXCLUDED, on evidence
 * rather than convenience. #654 -- "every golden-era scope is proven in a
 * browser, not by a text scan" -- added `e2e/golden-era-scope-proofs.spec.ts`,
 * which resolves computed styles for all eight scopes (bell, frontoffice,
 * locker, drillcase, afterhours, scheduler, scripts, floorboard). They have a
 * second, independent proof, so they fail the silent-failure test above.
 *
 * `wallSurface.test.tsx` is excluded too: its stated consequence is panel
 * burn-in and four controls on a pointerless screen -- real, and not a safety
 * state, an artefact gate, an accessibility floor or a mechanism other guards
 * stand on. The remaining exclusions from `components/` are component
 * behaviour and visual cascade rules whose breakage surfaces in the component
 * suites around them.
 *
 * If a suite belongs in the register, add it. The register is a floor, and a
 * failing entry is a finding about the repository -- never a reason to shrink
 * the register to fit.
 */

const APP_ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST_PATH = path.join(APP_ROOT, 'src', 'testing', 'safetyCriticalSuites.json');

interface ManifestEntry {
  path: string;
  minimumTests: number;
  guards: string;
}

const ENTRIES: ManifestEntry[] = manifest.suites;

/**
 * The nine the incident review named. Pinned here so the register can never be
 * quietly shrunk below the agreed floor -- the failure mode this whole change
 * exists to prevent is coverage leaving without anything going red, and a
 * register nobody guards is exactly that.
 */
const REQUIRED_BY_NAME = [
  'src/design/safeguardingRedReservation.test.ts',
  'src/design/plateBinaries.test.ts',
  'src/design/brassAlphaChannel.test.ts',
  'src/design/lightGroundVoices.test.ts',
  'src/design/readinessRungPolicy.test.ts',
  'src/design/safetySemanticsSurviveTheThemeSwap.test.ts',
  'src/design/kioskTapFloor.test.tsx',
  'src/design/typeLadder.test.ts',
  'src/design/legacyVisualVocabulary.test.ts',
];

/* ------------------------------------------------------------------------ */
/* The register itself                                                       */
/* ------------------------------------------------------------------------ */

describe('the safety-critical suite register', () => {
  it('is not empty, so it cannot pass by listing nothing', () => {
    expect(ENTRIES.length).toBeGreaterThan(0);
    expect(ENTRIES.length).toBeGreaterThanOrEqual(REQUIRED_BY_NAME.length);
  });

  it('names every suite the incident review required', () => {
    const listed = new Set(ENTRIES.map((entry) => entry.path));
    const absent = REQUIRED_BY_NAME.filter((required) => !listed.has(required));
    expect(absent).toEqual([]);
  });

  it('names each suite exactly once', () => {
    const seen = new Set<string>();
    const duplicates = ENTRIES.map((entry) => entry.path).filter((suitePath) => {
      if (seen.has(suitePath)) return true;
      seen.add(suitePath);
      return false;
    });
    expect(duplicates).toEqual([]);
  });

  it('points every entry at a file that exists, with that exact spelling', () => {
    const missing = ENTRIES.map((entry) => entry.path).filter(
      (suitePath) => !existsSync(path.join(APP_ROOT, suitePath)),
    );
    expect(missing).toEqual([]);
  });

  it('points every entry at a file Jest will collect', () => {
    const config = readFileSync(path.join(APP_ROOT, 'jest.config.js'), 'utf8');
    /* Mirrors testMatch: ['**' + '/*.test.ts', '**' + '/*.test.tsx']. Asserted
     * against the config text rather than restated, so a change to the pattern
     * shows up here instead of silently making the register unenforceable. */
    expect(config).toContain("testMatch: ['**/*.test.ts', '**/*.test.tsx']");
    const uncollectable = ENTRIES.map((entry) => entry.path).filter(
      (suitePath) => !/\.test\.tsx?$/.test(suitePath),
    );
    expect(uncollectable).toEqual([]);
  });

  it('gives every entry a stated reason and a positive measured floor', () => {
    for (const entry of ENTRIES) {
      expect(typeof entry.guards).toBe('string');
      expect(entry.guards.trim().length).toBeGreaterThan(40);
      expect(Number.isInteger(entry.minimumTests)).toBe(true);
      expect(entry.minimumTests).toBeGreaterThan(0);
    }
  });

  it('is wired into jest.config.js, so the enforcement cannot be quietly unhooked', () => {
    const config = readFileSync(path.join(APP_ROOT, 'jest.config.js'), 'utf8');
    expect(config).toContain('scripts/suiteAttendanceReporter.js');
    expect(config).toMatch(/reporters:\s*\['default',/);
  });
});

/* ------------------------------------------------------------------------ */
/* The reporter, driven through every failure mode                           */
/* ------------------------------------------------------------------------ */

/**
 * The parts of Jest's `globalConfig` and `TestResult` the reporter reads.
 * Declared rather than imported: they are the reporter's real contract with
 * `@jest/core`, and writing them out here means a shape change shows up as a
 * type error next to the assertions that depend on it.
 */
interface SyntheticGlobalConfig {
  rootDir: string;
  testPathPatterns: { patterns: string[] };
  testNamePattern?: string;
  runTestsByPath: boolean;
  onlyChanged: boolean;
  onlyFailures: boolean;
  lastCommit: boolean;
  changedSince?: string;
  findRelatedTests: boolean;
  shard?: { shardIndex: number; shardCount: number };
  bail: number;
  filter?: string;
  listTests: boolean;
}

interface SyntheticSuiteResult {
  testFilePath: string;
  testExecError?: { message: string };
  failureMessage: string | null;
  numPassingTests: number;
  numFailingTests: number;
  numPendingTests: number;
  numTodoTests: number;
  testResults: { status: string }[];
}

/** A `globalConfig` shaped like the one a full `npm test` produces. */
function unnarrowedGlobalConfig(): SyntheticGlobalConfig {
  return {
    rootDir: APP_ROOT,
    testPathPatterns: { patterns: [] },
    testNamePattern: undefined,
    runTestsByPath: false,
    onlyChanged: false,
    onlyFailures: false,
    lastCommit: false,
    changedSince: undefined,
    findRelatedTests: false,
    shard: undefined,
    bail: 0,
    filter: undefined,
    listTests: false,
  };
}

const CONTEXTS = [
  {
    config: {
      rootDir: APP_ROOT,
      roots: [APP_ROOT, path.resolve(APP_ROOT, '..', '..', 'packages')],
      testPathIgnorePatterns: ['/node_modules/', '/.next/'],
      testMatch: ['**/*.test.ts', '**/*.test.tsx'],
    },
  },
];

/** A result row for a suite that loaded and passed `count` tests. */
function healthy(suitePath: string, count: number): SyntheticSuiteResult {
  return {
    testFilePath: path.join(APP_ROOT, suitePath),
    testExecError: undefined,
    failureMessage: null,
    numPassingTests: count,
    numFailingTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: Array.from({ length: count }, () => ({ status: 'passed' })),
  };
}

/** Every register entry, present and exactly at its floor. */
function everythingRan(): SyntheticSuiteResult[] {
  return ENTRIES.map((entry) => healthy(entry.path, entry.minimumTests));
}

/**
 * Runs the reporter against a synthetic run and returns what it would tell the
 * operator. `stderr` is captured because the reporter prints its own banner --
 * Jest does not print a reporter's error for it.
 */
function runReporter(
  testResults: SyntheticSuiteResult[],
  globalConfig: SyntheticGlobalConfig = unnarrowedGlobalConfig(),
) {
  const printed: string[] = [];
  const write = jest
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown): boolean => {
      printed.push(String(chunk));
      return true;
    });
  try {
    const reporter = new SuiteAttendanceReporter(globalConfig);
    reporter.onRunComplete(CONTEXTS, { testResults });
    const error = reporter.getLastError();
    return { error, printed: printed.join('') };
  } finally {
    write.mockRestore();
  }
}

describe('the suite attendance reporter', () => {
  it('stays silent when every registered suite ran and met its floor', () => {
    const { error, printed } = runReporter(everythingRan());
    expect(error).toBeUndefined();
    expect(printed).toBe('');
  });

  it('fails the run and names the file when a registered suite FAILS TO LOAD', () => {
    const results = everythingRan();
    results[0] = {
      ...results[0],
      testExecError: { message: "Identifier 'LITERAL_SITES' has already been declared" },
      failureMessage:
        '● Test suite failed to run\n\n' +
        '    src/design/safeguardingRedReservation.test.ts:903\n' +
        "    SyntaxError: Identifier 'LITERAL_SITES' has already been declared",
      numPassingTests: 0,
      numFailingTests: 0,
      testResults: [],
    };

    const { error, printed } = runReporter(results);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(ENTRIES[0].path);
    expect(error?.message).toContain('FAILED TO LOAD');
    expect(error?.message).toContain("Identifier 'LITERAL_SITES' has already been declared");
    expect(printed).toContain('SAFETY-CRITICAL SUITES WENT DARK');
  });

  it('fails the run and names the file when a registered suite is DELETED OR RENAMED', () => {
    /* A rename leaves the old path in no run AND on no disk. Proving that
     * branch in process means a register entry pointing at a file that does not
     * exist, so this uses a throwaway register rather than deleting a real
     * guard out of the working tree. The same branch is proven against the real
     * repository by actually deleting and actually renaming a suite -- see the
     * mutation evidence on the pull request. */
    const scratch = mkdtempSync(path.join(tmpdir(), 'suite-attendance-'));
    const register = path.join(scratch, 'register.json');
    writeFileSync(
      register,
      JSON.stringify({
        suites: [
          {
            path: 'src/design/aSuiteThatWasRenamedAway.test.ts',
            minimumTests: 8,
            guards: 'a stand-in for any registered guard whose file has stopped existing',
          },
        ],
      }),
    );

    try {
      const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const reporter = new SuiteAttendanceReporter(unnarrowedGlobalConfig(), {
          manifestPath: register,
        });
        reporter.onRunComplete(CONTEXTS, { testResults: everythingRan() });
        const error = reporter.getLastError();
        expect(error).toBeInstanceOf(Error);
        expect(error?.message).toContain('src/design/aSuiteThatWasRenamedAway.test.ts');
        expect(error?.message).toContain('DELETED OR RENAMED');
        expect(error?.message).toContain('No file exists at this path');
      } finally {
        write.mockRestore();
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('fails the run when a registered suite exists but was never collected', () => {
    const { error } = runReporter(everythingRan().slice(1));
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(ENTRIES[0].path);
    expect(error?.message).toContain('NOT COLLECTED BY THIS RUN');
  });

  it('fails the run when the register itself cannot be read', () => {
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const reporter = new SuiteAttendanceReporter(unnarrowedGlobalConfig(), {
        manifestPath: path.join(tmpdir(), 'no-such-register-file.json'),
      });
      reporter.onRunComplete(CONTEXTS, { testResults: everythingRan() });
      expect(reporter.getLastError()).toBeInstanceOf(Error);
      expect(reporter.getLastError()?.message).toContain('COULD NOT BE READ');
    } finally {
      write.mockRestore();
    }
  });

  it('fails the run when the register lists nothing, so an empty one cannot pass', () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'suite-attendance-'));
    const register = path.join(scratch, 'register.json');
    writeFileSync(register, JSON.stringify({ suites: [] }));
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const reporter = new SuiteAttendanceReporter(unnarrowedGlobalConfig(), {
        manifestPath: register,
      });
      reporter.onRunComplete(CONTEXTS, { testResults: everythingRan() });
      expect(reporter.getLastError()?.message).toContain('MANIFEST IS EMPTY');
    } finally {
      write.mockRestore();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('fails the run and names the file when a registered suite contributes ZERO tests', () => {
    const results = everythingRan();
    results[0] = healthy(ENTRIES[0].path, 0);

    const { error } = runReporter(results);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(ENTRIES[0].path);
    expect(error?.message).toContain('CONTRIBUTED TOO FEW TESTS');
    expect(error?.message).toContain('executed 0');
  });

  it('fails the run when a registered suite drops below its measured floor', () => {
    const results = everythingRan();
    const entry = ENTRIES.find((candidate) => candidate.minimumTests > 1) as ManifestEntry;
    const index = ENTRIES.indexOf(entry);
    results[index] = healthy(entry.path, entry.minimumTests - 1);

    const { error } = runReporter(results);
    expect(error?.message).toContain(entry.path);
    expect(error?.message).toContain(`measured floor ${entry.minimumTests}`);
  });

  it('counts a skipped test as absent, because a skipped guard guards nothing', () => {
    const results = everythingRan();
    const entry = ENTRIES[0];
    results[0] = {
      ...healthy(entry.path, 0),
      numPendingTests: entry.minimumTests,
      testResults: Array.from({ length: entry.minimumTests }, () => ({ status: 'pending' })),
    };

    const { error } = runReporter(results);
    expect(error?.message).toContain(entry.path);
    expect(error?.message).toContain(`skipped ${entry.minimumTests}`);
  });

  it('names an ignore pattern as the reason when one swallowed a registered suite', () => {
    const results = everythingRan().slice(1);
    const contexts = [
      {
        config: {
          ...CONTEXTS[0].config,
          testPathIgnorePatterns: ['/node_modules/', 'safeguardingRedReservation'],
        },
      },
    ];

    const printed: string[] = [];
    const write = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown): boolean => {
        printed.push(String(chunk));
        return true;
      });
    try {
      const reporter = new SuiteAttendanceReporter(unnarrowedGlobalConfig());
      reporter.onRunComplete(contexts, { testResults: results });
      const error = reporter.getLastError();
      expect(error?.message).toContain(ENTRIES[0].path);
      expect(error?.message).toContain('EXCLUDED FROM THE RUN');
      expect(error?.message).toContain('safeguardingRedReservation');
    } finally {
      write.mockRestore();
    }
  });

  it('says plainly that the passing count is not evidence of coverage', () => {
    const results = everythingRan();
    results[0] = healthy(ENTRIES[0].path, 0);

    const { error } = runReporter(results);
    expect(error?.message).toContain('THE PASSING COUNT IS NOT EVIDENCE OF COVERAGE');
    expect(error?.message).toContain('the run\'s passing test count goes UP, not down');
  });

  it('says plainly that it has not repaired anything', () => {
    const results = everythingRan();
    results[0] = healthy(ENTRIES[0].path, 0);

    const { error } = runReporter(results);
    expect(error?.message).toContain('This guard reports absence');
    expect(error?.message).toContain('Deleting or lowering its manifest entry is not fixing');
  });

  it('reports the reason each dark suite mattered, not just its name', () => {
    const results = everythingRan();
    results[0] = healthy(ENTRIES[0].path, 0);

    const { error } = runReporter(results);
    expect(error?.message).toContain(ENTRIES[0].guards);
  });

  /* --------------------------------------------------------------------- */

  it('enforces nothing on a narrowed run, and says so rather than going quiet', () => {
    const narrowed = {
      ...unnarrowedGlobalConfig(),
      testPathPatterns: { patterns: ['typeLadder'] },
    };
    const { error, printed } = runReporter([healthy('src/design/typeLadder.test.ts', 3)], narrowed);
    expect(error).toBeUndefined();
    expect(printed).toContain('not enforced');
    expect(printed).toContain('typeLadder');
  });

  it.each<[string, Partial<SyntheticGlobalConfig>]>([
    ['-t', { testNamePattern: 'something' }],
    ['--onlyChanged', { onlyChanged: true }],
    ['--onlyFailures', { onlyFailures: true }],
    ['--lastCommit', { lastCommit: true }],
    ['--changedSince', { changedSince: 'main' }],
    ['--findRelatedTests', { findRelatedTests: true }],
    ['--runTestsByPath', { runTestsByPath: true }],
    ['--shard', { shard: { shardIndex: 1, shardCount: 2 } }],
    ['--bail', { bail: 1 }],
    ['--listTests', { listTests: true }],
  ])('enforces nothing under %s', (_flag, overrides) => {
    const { error } = runReporter([], { ...unnarrowedGlobalConfig(), ...overrides });
    expect(error).toBeUndefined();
  });

  it('enforces nothing when --roots aimed the run at a subtree', () => {
    const subtree = [
      {
        config: {
          ...CONTEXTS[0].config,
          roots: [path.join(APP_ROOT, 'src', 'design')],
        },
      },
    ];
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const reporter = new SuiteAttendanceReporter(unnarrowedGlobalConfig());
      reporter.onRunComplete(subtree, { testResults: [] });
      expect(reporter.getLastError()).toBeUndefined();
    } finally {
      write.mockRestore();
    }
  });

  it('fails a full run in which nothing at all was collected', () => {
    const { error } = runReporter([]);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(`${ENTRIES.length} of ${ENTRIES.length} did not run`);
  });
});

/* ------------------------------------------------------------------------ */
/* The register file itself is readable by the reporter                      */
/* ------------------------------------------------------------------------ */

describe('the register file the reporter reads', () => {
  it('is the same file this test imports, and is valid JSON on disk', () => {
    const onDisk = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    expect(onDisk.suites).toHaveLength(ENTRIES.length);
    expect(onDisk.suites.map((entry: ManifestEntry) => entry.path)).toEqual(
      ENTRIES.map((entry) => entry.path),
    );
  });

  it('is read by the reporter from the path the reporter states', () => {
    const source = readFileSync(
      path.join(APP_ROOT, 'scripts', 'suiteAttendanceReporter.js'),
      'utf8',
    );
    expect(source).toContain("'src/testing/safetyCriticalSuites.json'");
  });
});
