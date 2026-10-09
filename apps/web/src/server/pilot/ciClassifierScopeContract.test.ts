import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The change-aware classifier must be fed THIS branch's diff, not the delta to
 * its base tip.
 *
 * WHY THIS EXISTS. `ci.yml` decides which suites run from a file list, and it
 * built that list with `git diff "$BASE_SHA" "$HEAD_SHA"` -- two dots. Two dots
 * report every file that DIFFERS between two commits, so a pull request branch
 * that is behind its base reports the base's own newer files as its own
 * changes. Everything downstream then runs against a surface the branch never
 * touched.
 *
 * That is a W20 defect before it is a performance one. The extra suites go
 * GREEN, and a reviewer reading the run sees browser coverage attributed to a
 * diff that cannot have affected it -- "the suite ran" without "the suite
 * traversed the changed path". The mirror case is quieter and worse: where the
 * base moved the other way, a suite whose surface the branch DOES touch can be
 * missed, and CI is green without it.
 *
 * Measured on #842: 26 files classified where the branch changed 8,
 * `guardian_e2e` on off a route the branch never touched, and the extra work
 * pushed the job past `timeout-minutes` so the required check came back
 * `cancelled` -- which `AGENT_KERNEL.md` already records as reading like "never
 * validated" rather than as a failure.
 *
 * TWO HALVES, ON PURPOSE. The first describes the rule and proves it against
 * real git on a real topology, so it fails if the premise is ever wrong. The
 * second checks that `ci.yml` actually follows the rule. Neither alone is
 * enough: a proof about git that the workflow ignores guards nothing, and a
 * string assertion about the workflow proves nothing about what git does.
 */

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const classifier = path.join(repositoryRoot, 'scripts/ci-classify-paths.mjs');

/**
 * The classify step's own shell, lifted out of the workflow and made runnable.
 *
 * Read from `ci.yml` rather than restated here, because a restatement is a
 * second copy that drifts: the point of this suite is what the WORKFLOW does.
 * Two edits are made and both are mechanical -- the `run:` block is dedented
 * out of its YAML nesting, and its hardcoded `/tmp/changed-files.txt` is
 * redirected to a caller-supplied path so a test cannot collide with a real
 * run. The final `node scripts/ci-classify-paths.mjs` line is dropped; this
 * helper's job is the file list, and the classifier is invoked separately with
 * the same module the workflow names.
 */
function runnableClassifyShell(outputPath: string): string {
  const workflow = fs.readFileSync(
    path.join(repositoryRoot, '.github/workflows/ci.yml'),
    'utf8',
  );
  const start = workflow.indexOf('- name: Classify changed surface');
  expect(start).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const end = rest.indexOf('\n      - name: ');
  const step = end === -1 ? rest : rest.slice(0, end);

  const runAt = step.indexOf('run: |');
  expect(runAt).toBeGreaterThan(-1);

  return step
    .slice(runAt + 'run: |'.length)
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .filter((line) => !line.trim().startsWith('node scripts/ci-classify-paths.mjs'))
    .join('\n')
    .replace(/\/tmp\/changed-files\.txt/g, outputPath);
}

/** Run the shipped classifier over a file list and return its flags. */
function classify(files: string[]): Record<string, string> {
  const listFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-cls-')), 'files.txt');
  try {
    fs.writeFileSync(listFile, `${files.join('\n')}\n`);
    const stdout = execFileSync(process.execPath, [classifier, listFile], { encoding: 'utf8' });
    return Object.fromEntries(
      stdout.trim().split('\n').map((line) => line.split('=') as [string, string]),
    );
  } finally {
    // Nothing else clears these: the start-of-run sweep only takes
    // ppbf-*-pg-test-* folders (scripts/lib/embedded-pg-cleanup.mjs:50).
    fs.rmSync(path.dirname(listFile), { recursive: true, force: true });
  }
}

describe('a branch behind its base, diffed both ways against real git', () => {
  let repo: string;

  /** `git` in the scratch repository, returning trimmed stdout. */
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

  const commit = (file: string, message: string) => {
    fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), `${message}\n`);
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', message);
  };

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-scope-'));
    git('init', '-q', '-b', 'main');

    // The fork point.
    commit('README.md', 'base');

    // A branch that changes documentation and nothing else -- the shape of a
    // docs-only pull request.
    git('checkout', '-q', '-b', 'feature');
    commit('docs/current/EVIDENCE_APPLICABILITY.md', 'the branch changes this');

    // Meanwhile the base gains another lane's work. This is the real file that
    // turned guardian_e2e on for #842.
    git('checkout', '-q', 'main');
    commit('apps/web/app/api/pilot/parent/messages/route.ts', 'another lane');
  });

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  const twoDot = () => git('diff', '--name-only', 'main', 'feature').split('\n').filter(Boolean);
  const threeDot = () =>
    git('diff', '--name-only', `${git('merge-base', 'main', 'feature')}`, 'feature')
      .split('\n')
      .filter(Boolean);

  it('two dots report the base branch\'s files as the feature branch\'s own', () => {
    // The premise. If this ever stops being true of git, the rule below is
    // moot and this test says so rather than the workflow silently drifting.
    expect(twoDot().sort()).toEqual([
      'apps/web/app/api/pilot/parent/messages/route.ts',
      'docs/current/EVIDENCE_APPLICABILITY.md',
    ]);
  });

  it('the merge base reports only what the branch actually changed', () => {
    expect(threeDot()).toEqual(['docs/current/EVIDENCE_APPLICABILITY.md']);
  });

  it('and the two file lists classify into different CI work', () => {
    // The consequence, through the shipped classifier rather than a restated
    // rule: the same branch is either a documentation-only change or a
    // guardian-journey browser run, depending only on which diff CI was fed.
    const wrong = classify(twoDot());
    const right = classify(threeDot());

    expect([wrong.guardian_e2e, wrong.docs_only]).toEqual(['true', 'false']);
    expect([right.guardian_e2e, right.docs_only]).toEqual(['false', 'true']);
  });
});

describe("ci.yml's own shell, executed against that topology", () => {
  let repo: string;
  let out: string;

  /**
   * Run the workflow's classify shell the way Actions runs it, with the same
   * two environment variables and the same starting state -- a `BASE_SHA` at
   * the base branch tip and a `HEAD_SHA` at the feature branch.
   */
  function changedFilesPerCi(): string[] {
    execFileSync('bash', ['-c', runnableClassifyShell(out)], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        BASE_SHA: execFileSync('git', ['rev-parse', 'main'], { cwd: repo, encoding: 'utf8' }).trim(),
        HEAD_SHA: execFileSync('git', ['rev-parse', 'feature'], { cwd: repo, encoding: 'utf8' }).trim(),
      },
    });
    return fs.readFileSync(out, 'utf8').split('\n').filter(Boolean);
  }

  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-ci-'));
    repo = path.join(dir, 'repo');
    out = path.join(dir, 'changed-files.txt');
    fs.mkdirSync(repo);

    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    const commit = (file: string, message: string) => {
      fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), `${message}\n`);
      git('add', '-A');
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', message);
    };

    git('init', '-q', '-b', 'main');
    commit('README.md', 'base');
    git('checkout', '-q', '-b', 'feature');
    commit('docs/current/EVIDENCE_APPLICABILITY.md', 'the branch changes this');
    git('checkout', '-q', 'main');
    commit('apps/web/app/api/pilot/parent/messages/route.ts', 'another lane');
  });

  afterAll(() => {
    if (repo) fs.rmSync(path.dirname(repo), { recursive: true, force: true });
  });

  it('hands the classifier only the files the branch changed', () => {
    // Not a string match on the workflow: the workflow's own shell ran, and
    // this is the file it wrote. Restoring the two-dot spelling reds this.
    expect(changedFilesPerCi()).toEqual(['docs/current/EVIDENCE_APPLICABILITY.md']);
  });

  it('so the branch is classified as the docs-only change it is', () => {
    const flags = classify(changedFilesPerCi());

    expect([flags.docs_only, flags.guardian_e2e]).toEqual(['true', 'false']);
  });
});

/**
 * A flagged suite must actually run the spec that flagged it.
 *
 * WHY THIS EXISTS. The classifier deciding `coach_e2e=true` is only the first
 * half of attendance. The step it guards runs an npm script, and that script
 * names its spec FILES explicitly -- so a coach spec can sit in `e2e/`, watch
 * its own step run, and never be executed.
 *
 * MEASURED ON #940, precisely, because the first telling of this was wrong.
 * `coach_e2e` came back `true` from `apps/web/app/coach/visualization/page.tsx`
 * -- NOT from the new spec. The spec's own path matched no predicate at all:
 * `isCoachE2ePath` named `apps/web/e2e/coach-journey`, so a diff touching only
 * `coach-visualization.spec.ts` classified `unknown_code` and ran no browser
 * suite, and `apps/web/src/lib/visualization/` did the same. Meanwhile
 * `test:e2e:coach` ran only `coach-journey.spec.ts`, so the visualization
 * journey's browser checks reported nothing and CI was green without them.
 *
 * So the gap had two halves and this repair closed both: the command now names
 * every coach spec, and the predicate now names the coach spec FAMILY and the
 * visualization source those specs read. The tests below hold each half.
 *
 * AGENT_KERNEL.md's documented check -- confirm the suite's flag comes back
 * `true` -- passes even while the spec is unattended, which is why it is not
 * enough on its own.
 *
 * NOT CIRCULAR. The spec cannot prove it is selected by running; if it is not
 * selected it does not run to fail. So this lives in the fast regression suite
 * that `npm test` runs on every non-docs-only diff, it reads the invoked script
 * out of `ci.yml` rather than assuming its name, and it enumerates the coach
 * specs from the filesystem rather than from a list it also checks.
 */
describe('the coach E2E command attends every coach spec on disk', () => {
  /** The npm script `ci.yml` runs for a `coach_e2e` diff, read from the workflow. */
  function coachScriptPerCi(): string {
    const workflow = fs.readFileSync(
      path.join(repositoryRoot, '.github/workflows/ci.yml'),
      'utf8',
    );
    // The step that RUNS a coach command, not every step whose condition
    // mentions the flag: "Install Playwright browsers" is guarded by an OR
    // across all seven E2E flags and runs no npm script.
    const guarded = workflow
      .split(/\n      - name: /)
      .filter((step) => /steps\.changes\.outputs\.coach_e2e == 'true'/.test(step))
      .filter((step) => /run: npm --workspace web run \S+/.test(step));
    expect(guarded).toHaveLength(1);

    const run = /run: npm --workspace web run (\S+)/.exec(guarded[0]);
    expect(run).not.toBeNull();
    return run![1];
  }

  /** Every coach journey spec on disk, found rather than listed. */
  function coachSpecsOnDisk(): string[] {
    const dir = path.join(repositoryRoot, 'apps/web/e2e');
    return fs
      .readdirSync(dir)
      .filter((name) => /^coach-.*\.spec\.ts$/.test(name))
      .sort();
  }

  function packageScripts(): Record<string, string> {
    return JSON.parse(
      fs.readFileSync(path.join(repositoryRoot, 'apps/web/package.json'), 'utf8'),
    ).scripts;
  }

  // One path at a time, on purpose. A combined list passes as soon as ANY
  // path matches, so it cannot see that two of these three matched nothing --
  // which is exactly what it hid. `unknown_code` is not asserted alongside
  // `coach_e2e`: the classifier computes it as "no predicate matched", so it is
  // implied by the flag rather than evidence for it.
  it.each([
    'apps/web/app/coach/visualization/page.tsx',
    'apps/web/src/lib/visualization/pf001Scenario.ts',
    'apps/web/src/lib/visualization/guidedSession.ts',
    'apps/web/e2e/coach-visualization.spec.ts',
    'apps/web/app/api/pilot/scheduler/route.ts',
    'apps/web/src/lib/gymTime.ts',
  ])('sends %s to the coach suite on its own', (file) => {
    const flags = classify([file]);

    expect(flags.coach_e2e).toBe('true');
    expect(flags.docs_only).toBe('false');
  });

  it('runs every coach spec, so none can flag the suite without being executed', () => {
    const script = packageScripts()[coachScriptPerCi()];
    expect(typeof script).toBe('string');

    // A whitespace-delimited `e2e/<name>` argument, not a substring: the spec
    // has to be handed to Playwright as a path, not mentioned in a comment or
    // carried in a --grep pattern.
    const passedToPlaywright = new Set(
      script.split(/\s+/).filter((argument) => argument.startsWith('e2e/')),
    );
    const missing = coachSpecsOnDisk().filter((spec) => !passedToPlaywright.has(`e2e/${spec}`));
    // Naming the absentees, because "some coach spec is unattended" is only
    // actionable if it says which. Dropping coach-visualization.spec.ts from
    // the command reds this line.
    expect(missing).toEqual([]);

    // Both halves of the pair the defect was measured on, stated outright so a
    // reader does not have to reconstruct the filesystem to see the point.
    expect(coachSpecsOnDisk()).toContain('coach-journey.spec.ts');
    expect(coachSpecsOnDisk()).toContain('coach-visualization.spec.ts');
  });

  it('keeps that command inside the merged-main allow-list, so main runs it too', () => {
    const allowList = fs.readFileSync(
      path.join(repositoryRoot, '.github/workflows/merged-main-e2e.yml'),
      'utf8',
    );

    expect(allowList).toContain(`'${coachScriptPerCi()}'`);
  });
});

/**
 * A seed-data change runs the PostgreSQL suites that load it.
 *
 * WHY THIS EXISTS. The embedded-Postgres suites load the committed rows of
 * `apps/web/seed-data/` into the real schema -- the reference datasets through
 * the content-import core (src/testing/referenceContentFixture.ts, used by
 * drillLibraryV3, multidiscipline, competenceCohorts, workoutTemplates,
 * sessionScriptsTransfer and seedCreatedByRole, plus the contentImport*
 * suites), and shadow-research/2026-08-07 through
 * scripts/import-shadow-research.pg.test.ts -- and `npm test` excludes every
 * .pg suite. So a data row that breaks a CHECK constraint or a foreign key
 * meets the schema ONLY in those suites -- and before `isSeedDataPath` a PR changing only seed
 * data classified `unknown_code` and ran none of them. That is the shape every
 * content hand-off arrives in.
 *
 * Three hops, and each is held here or elsewhere: the file sets `migrations`
 * (below), the step that flag guards runs `npm run test:migrations` (below),
 * and that runner reaches every .pg suite (pgTestCoverage.test.ts).
 */
describe('a seed-data change runs the PostgreSQL suites that load it', () => {
  /** Every file committed under seed-data, repo-relative with forward slashes. */
  function seedDataFilesOnDisk(): string[] {
    const root = path.join(repositoryRoot, 'apps/web/seed-data');
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
      });
    return walk(root)
      .map((file) => path.relative(repositoryRoot, file).split(path.sep).join('/'))
      .sort();
  }

  /**
   * `classifyPaths([file])` for each file ALONE, in one process. One at a time
   * for the reason the coach block gives -- a combined list passes as soon as
   * any path matches -- and one process because spawning the CLI per file
   * across the whole tree is seconds of fork cost for no added fidelity; the
   * CLI's flag lines are exercised through `classify()`.
   *
   * The list goes in on stdin, not argv, so no file path ever sits in argv[1]
   * for the classifier's import-time entry check (the `process.argv[1]` test
   * at the foot of ci-classify-paths.mjs) to read, and the list meets no
   * command-line length ceiling as the folder grows.
   */
  function flagsPerFile(files: string[]): Record<string, { migrations: boolean; docsOnly: boolean }> {
    const script = [
      "import fs from 'node:fs';",
      `import { classifyPaths } from ${JSON.stringify(pathToFileURL(classifier).href)};`,
      "const files = JSON.parse(fs.readFileSync(0, 'utf8'));",
      'console.log(JSON.stringify(Object.fromEntries(files.map((file) => {',
      '  const { migrations, docsOnly } = classifyPaths([file]);',
      '  return [file, { migrations, docsOnly }];',
      '}))));',
    ].join('\n');
    return JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        input: JSON.stringify(files),
      }),
    );
  }

  // Through the CLI, because its `migrations=` line is what the step's `if:`
  // compares. One data shape per format the folder holds or will hold.
  it.each([
    'apps/web/seed-data/drill-library/seed_drill_library.csv',
    'apps/web/seed-data/drill-library/seed_drill_library.json',
    'apps/web/seed-data/shadow-research/2026-08-07/research_triage_view.sql',
  ])('sends %s to the PostgreSQL suite on its own', (file) => {
    const flags = classify([file]);

    expect([flags.migrations, flags.docs_only, flags.unknown_code]).toEqual(['true', 'false', 'false']);
  });

  it('sends the account cleanup\'s SQL module to the PostgreSQL suite on its own', () => {
    // Both of the cleanup's statements are string constants in this file, run
    // only by accountCleanupSql.pg.test.ts. It sits under scripts/lib/, which
    // no migration prefix matched, so an edit to the SQL alone ran no pg suite.
    const flags = classify(['apps/web/scripts/lib/account-cleanup-plan.mjs']);

    expect([flags.migrations, flags.docs_only, flags.unknown_code]).toEqual(['true', 'false', 'false']);
  });

  it('keeps a README under seed-data on the docs-only path', () => {
    const flags = classify(['apps/web/seed-data/drill-library/README.md']);

    expect([flags.docs_only, flags.migrations]).toEqual(['true', 'false']);
  });

  it('does not let a seed-data README hide unrecognised code beside it', () => {
    // The reason documentation is carved out of the predicate rather than the
    // whole folder matched: a README that set `migrations` would turn
    // `unknown_code` off for this diff and the report would name nothing.
    const flags = classify([
      'apps/web/seed-data/drill-library/README.md',
      'apps/web/components/SomeNewSurface.tsx',
    ]);

    expect([flags.unknown_code, flags.migrations]).toEqual(['true', 'false']);
  });

  it('flags every data file committed under seed-data, found rather than listed', () => {
    const files = seedDataFilesOnDisk();
    const data = files.filter((file) => !file.endsWith('.md'));
    const docs = files.filter((file) => file.endsWith('.md'));
    // Floors, so an empty walk cannot pass by checking nothing.
    expect(data.length).toBeGreaterThan(20);
    expect(docs.length).toBeGreaterThan(0);

    const flags = flagsPerFile(files);
    // Naming the absentees, as the coach block does: "some seed file runs no
    // pg suite" is only actionable if it says which.
    expect(data.filter((file) => flags[file].migrations !== true)).toEqual([]);
    expect(docs.filter((file) => flags[file].migrations !== false || flags[file].docsOnly !== true)).toEqual([]);
  });

  it('runs the migration suite from the one step that flag guards', () => {
    const workflow = fs.readFileSync(
      path.join(repositoryRoot, '.github/workflows/ci.yml'),
      'utf8',
    );
    const guarded = workflow
      .split(/\n      - name: /)
      .filter((step) => /steps\.changes\.outputs\.migrations == 'true'/.test(step));

    // A flag nothing reads is the "suite ran" without "the suite traversed the
    // changed path" this file's header describes.
    expect(guarded).toHaveLength(1);
    expect(guarded[0]).toMatch(/\n\s+run: npm run test:migrations\s*(\n|$)/);
  });
});
