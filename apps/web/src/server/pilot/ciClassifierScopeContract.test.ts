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
    // Forward slashes, so Git Bash on Windows does not read the separators as
    // escapes; on Linux this is a no-op.
    .replace(/\/tmp\/changed-files\.txt/g, outputPath.split(path.sep).join('/'));
}

/**
 * ci.yml split into jobs, and each job into its header and steps.
 *
 * Since lane L38 the suites run in separate jobs (classify, static, unit, pg,
 * e2e) whose `if:` reads `needs.classify.outputs.*`, so "which step runs for
 * this flag" is answered per job: a flag can guard a whole job (pg) or one
 * step in it (each E2E suite).
 */
function workflowJobs(): { name: string; header: string; steps: string[] }[] {
  const workflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
  const jobsAt = workflow.indexOf('\njobs:\n');
  expect(jobsAt).toBeGreaterThan(-1);
  const parts = workflow.slice(jobsAt + '\njobs:\n'.length).split(/^ {2}([a-z][\w-]*):\n/m);
  const jobs: { name: string; header: string; steps: string[] }[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const [header, ...steps] = parts[i + 1].split(/\n {6}- name: /);
    jobs.push({ name: parts[i], header, steps });
  }
  return jobs;
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
 * A pull request run is classified from the main it is merged into.
 *
 * WHY THIS EXISTS. On a pull_request event `github.sha` is GitHub's test merge
 * (refs/pull/N/merge): first parent the CURRENT main tip, second parent the PR
 * head. `pull_request.base.sha` is older -- the base the branch last synced
 * with -- and it is an ancestor of that merge, so the merge-base step above
 * cannot remove what main gained since. Measured on #1685 (run 39059770045):
 * base.sha sat 6 main commits behind the merge's first parent, 80 files were
 * classified where the PR changed 31, migrations came on from the five files
 * of #1613's merged migration, and the run was cancelled at 60 minutes.
 *
 * The topology is GitHub's: a branch forks, main moves on, and the merge
 * commit is built on the moved main, with BASE_SHA left at the fork.
 */
describe("ci.yml's own shell, on a pull request's merge ref", () => {
  let dir: string;
  let out: string;

  type Topology = { repo: string; fork: string; merge: string; prHead: string; mainTip: string };

  /** A repository shaped like a pull_request run: fork, branch, main moves, test merge. */
  function pullRequestTopology(
    name: string,
    branchFile: string,
    otherLaneFile: string,
    laterMainFile?: string,
  ): Topology {
    const repo = path.join(dir, name);
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
    const fork = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', 'feature');
    commit(branchFile, 'the branch changes this');
    const prHead = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    commit(otherLaneFile, 'another lane, merged after the branch last synced');
    if (laterMainFile) commit(laterMainFile, 'a second commit on main');
    const mainTip = git('rev-parse', 'HEAD');
    // GitHub's merge ref: the moved main first, the PR head second.
    git('checkout', '-q', '--detach', 'main');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '-q', '--no-ff', '--no-edit', 'feature');
    return { repo, fork, merge: git('rev-parse', 'HEAD'), prHead, mainTip };
  }

  /** Run the workflow's classify shell with the environment ci.yml gives it. */
  function changedFilesPerCi(repo: string, env: Record<string, string>): { files: string[]; log: string } {
    const log = execFileSync('bash', ['-c', runnableClassifyShell(out)], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PR_HEAD_SHA: '', ...env },
    });
    return { files: fs.readFileSync(out, 'utf8').split('\n').filter(Boolean), log };
  }

  let docsPr: Topology;
  let migrationPr: Topology;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-ci-pr-'));
    out = path.join(dir, 'changed-files.txt');
    // The route that turned guardian_e2e on for #842, as the other lane's work.
    // A second main commit after it, so fork..mainTip is a multi-commit push.
    docsPr = pullRequestTopology(
      'docs',
      'docs/current/EVIDENCE_APPLICABILITY.md',
      'apps/web/app/api/pilot/parent/messages/route.ts',
      'apps/web/app/coach/cards/page.tsx',
    );
    // A PR that really adds a migration, while another lane changes a coach page.
    migrationPr = pullRequestTopology(
      'migration',
      'infra/azure/pilot_slice_postgres_example_migration.sql',
      'apps/web/app/coach/cards/page.tsx',
    );
  });

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('hands the classifier only what the PR adds on top of current main', () => {
    // Restoring the base.sha-only path reds this: it reports the other lane's
    // route as well, because the stale base is an ancestor of the merge.
    const { files, log } = changedFilesPerCi(docsPr.repo, {
      BASE_SHA: docsPr.fork,
      HEAD_SHA: docsPr.merge,
      PR_HEAD_SHA: docsPr.prHead,
    });

    expect(files).toEqual(['docs/current/EVIDENCE_APPLICABILITY.md']);
    expect(log).toContain('first parent');
    expect(classify(files).docs_only).toBe('true');
  });

  it('still turns the PostgreSQL suite on for a PR that adds a migration', () => {
    const { files } = changedFilesPerCi(migrationPr.repo, {
      BASE_SHA: migrationPr.fork,
      HEAD_SHA: migrationPr.merge,
      PR_HEAD_SHA: migrationPr.prHead,
    });
    const flags = classify(files);

    expect(files).toEqual(['infra/azure/pilot_slice_postgres_example_migration.sql']);
    expect([flags.migrations, flags.coach_e2e]).toEqual(['true', 'false']);
  });

  it('keeps the old path, and says so, when the merge ref is of a different PR head', () => {
    // Pins the PR-head comparison itself: a merge with SOME second parent is
    // not enough. Without the comparison this would take the first parent
    // silently.
    const { files, log } = changedFilesPerCi(docsPr.repo, {
      BASE_SHA: docsPr.fork,
      HEAD_SHA: docsPr.merge,
      PR_HEAD_SHA: docsPr.fork,
    });

    // The old path's over-inclusive list; the first-parent path would give one file.
    expect(files.sort()).toEqual([
      'apps/web/app/api/pilot/parent/messages/route.ts',
      'apps/web/app/coach/cards/page.tsx',
      'docs/current/EVIDENCE_APPLICABILITY.md',
    ]);
    expect(log).toContain('::warning title=CI classifier::');
    expect(log).not.toContain('first parent');
  });

  it('keeps the old path, and says so, when HEAD_SHA is not a merge of the PR head', () => {
    // A shape GitHub is not documented to produce. The base.sha path is
    // over-inclusive rather than blind, and the warning makes it visible.
    const { files, log } = changedFilesPerCi(docsPr.repo, {
      BASE_SHA: docsPr.fork,
      HEAD_SHA: docsPr.prHead,
      PR_HEAD_SHA: docsPr.prHead,
    });

    expect(files).toEqual(['docs/current/EVIDENCE_APPLICABILITY.md']);
    expect(log).toContain('::warning title=CI classifier::');
  });

  it('leaves a push of several commits classified from `before`, all of them', () => {
    // A push has no PR head. Taking the first parent here would classify only
    // the last commit and could skip a suite an earlier commit needs.
    const { files, log } = changedFilesPerCi(docsPr.repo, {
      BASE_SHA: docsPr.fork,
      HEAD_SHA: docsPr.mainTip,
      PR_HEAD_SHA: '',
    });

    expect(files.sort()).toEqual([
      'apps/web/app/api/pilot/parent/messages/route.ts',
      'apps/web/app/coach/cards/page.tsx',
    ]);
    expect(log).not.toContain('first parent');
  });

  it('lists both paths of a moved file, so a move out of a folder still runs its suite', () => {
    // With git's default rename detection the diff names only the NEW path,
    // and the coach page below lands where no journey predicate looks.
    const repo = path.join(dir, 'rename');
    fs.mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    const page = 'apps/web/app/coach/cards/page.tsx';
    fs.mkdirSync(path.join(repo, path.dirname(page)), { recursive: true });
    fs.writeFileSync(path.join(repo, page), 'export default function Page() { return null; }\n');
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base');
    const before = git('rev-parse', 'HEAD');
    fs.mkdirSync(path.join(repo, 'apps/web/src/lib'), { recursive: true });
    git('mv', page, 'apps/web/src/lib/movedCardsPage.tsx');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'move it');

    const { files } = changedFilesPerCi(repo, {
      BASE_SHA: before,
      HEAD_SHA: git('rev-parse', 'HEAD'),
      PR_HEAD_SHA: '',
    });

    expect(files.sort()).toEqual([page, 'apps/web/src/lib/movedCardsPage.tsx']);
    expect(classify(files).coach_e2e).toBe('true');
  });

  it('is fed the PR head by the workflow, not only by this test', () => {
    // The cases above inject PR_HEAD_SHA themselves. Without this env line
    // every pull request falls back to the old path with no warning at all.
    const workflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
    const step = workflow.slice(workflow.indexOf('- name: Classify changed surface'));
    const env = step.slice(0, step.indexOf('run: |'));

    expect(env).toContain('PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}');
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
    // The step that RUNS a coach command, not every place whose condition
    // mentions the flag: the e2e job's own `if:` is an OR across all seven E2E
    // flags, and its "Install Playwright browsers" runs no npm script.
    const guarded = workflowJobs()
      .flatMap((job) => job.steps)
      .filter((step) => /needs\.classify\.outputs\.coach_e2e == 'true'/.test(step))
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

  it('runs the migration suite from the one job that flag guards, every shard of it', () => {
    const jobs = workflowJobs();
    const guarded = jobs.filter((job) => /needs\.classify\.outputs\.migrations == 'true'/.test(job.header));

    // A flag nothing reads is the "suite ran" without "the suite traversed the
    // changed path" this file's header describes.
    expect(guarded.map((job) => job.name)).toEqual(['pg']);
    const runs = guarded[0].steps.filter((step) => /run: npm run test:migrations/.test(step));
    expect(runs).toHaveLength(1);
    // The total is the matrix's own size, so no edit to the list can leave a
    // shard -- and its suites -- unrun.
    expect(runs[0]).toMatch(
      /\n\s+run: npm run test:migrations -- --shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}\s*(\n|$)/,
    );
    const shards = /\n {8}shard: \[([\d, ]+)\]\n/.exec(guarded[0].header);
    expect(shards).not.toBeNull();
    const list = shards![1].split(',').map((n) => Number(n.trim()));
    expect(list).toEqual(list.map((_, i) => i + 1));
    expect(list.length).toBeGreaterThan(1);

    // Nowhere else: a second, unsharded run would double the suite's time.
    const elsewhere = jobs
      .filter((job) => job.name !== 'pg')
      .flatMap((job) => job.steps)
      .filter((step) => /run: npm run test:migrations/.test(step));
    expect(elsewhere).toEqual([]);
  });
});

describe('the shared chrome components run the journeys that render them (lane N8-02)', () => {
  // Both were `unknown_code`: no predicate matched either name, so an edit to
  // the button or the work axis ran no browser suite at all.
  it.each([
    'apps/web/components/ShadowChatButton.tsx',
    'apps/web/components/ShadowChatButton.test.ts',
    'apps/web/components/WorkAxis.tsx',
    'apps/web/components/WorkAxis.test.tsx',
  ])('sends %s to the three signed-in journeys', (file) => {
    const flags = classify([file]);

    expect([flags.coach_e2e, flags.athlete_e2e, flags.guardian_e2e, flags.unknown_code]).toEqual([
      'true',
      'true',
      'true',
      'false',
    ]);
  });

  it('also sends WorkAxis to the sign-in door suites, because /login renders it', () => {
    const flags = classify(['apps/web/components/WorkAxis.tsx']);

    expect([flags.homepage_e2e, flags.board_e2e]).toEqual(['true', 'true']);
  });

  it('does not widen to unrelated components or to the migration suite', () => {
    const flags = classify(['apps/web/components/SomeNewSurface.tsx']);

    expect([flags.unknown_code, flags.migrations, flags.coach_e2e]).toEqual(['true', 'false', 'false']);
    // The button is not on the sign-in door, so it must not pull those suites in.
    const button = classify(['apps/web/components/ShadowChatButton.tsx']);
    expect([button.homepage_e2e, button.board_e2e, button.migrations]).toEqual(['false', 'false', 'false']);
  });
});

/**
 * A change to anything a PostgreSQL suite imports runs the PostgreSQL suites
 * (F-039).
 *
 * WHY THIS EXISTS. The migration predicate matched the suites' own folders
 * (src/server/pilot/, app/api/) but not what they import from elsewhere:
 * src/lib/gymTime.ts sits under 210 of them, lib/calendarDay.ts under 133, and
 * 20 more shared files likewise, and a PR changing only one of those ran no pg
 * suite. Listing what was missed fixes today; this walk keeps it fixed, by
 * following every suite's imports on disk and naming each file reached that
 * the classifier would not send to the suite.
 *
 * The walk follows relative and "@/" specifiers (the alias resolved as
 * tsconfig and jest.config resolve it: src/ first, then the app root) through
 * static imports, re-exports, dynamic import(), require() and jest.mock().
 * Package imports are not followed; a dependency bump changes package.json,
 * which already runs the suite.
 */
describe('a change to anything a PostgreSQL suite imports runs the PostgreSQL suites', () => {
  const webRoot = path.join(repositoryRoot, 'apps/web');
  const extensions = ['', '.ts', '.tsx', '.mjs', '.js', '.json', '/index.ts', '/index.tsx', '/index.js'];
  const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bjest\.mock\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

  function resolveImport(fromFile: string, spec: string): string | null {
    const bases = spec.startsWith('.')
      ? [path.resolve(path.dirname(fromFile), spec)]
      : spec.startsWith('@/')
        ? [path.join(webRoot, 'src', spec.slice(2)), path.join(webRoot, spec.slice(2))]
        : [];
    for (const base of bases) {
      for (const extension of extensions) {
        const candidate = base + extension;
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      }
    }
    return null;
  }

  function pgSuitesOnDisk(): string[] {
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.name.endsWith('.pg.test.ts') ? [full] : [];
      });
    return walk(webRoot);
  }

  /** Every file any pg suite reaches, repo-relative with forward slashes. */
  function filesThePgSuitesReach(suites: string[]): string[] {
    const reached = new Set<string>(suites);
    const queue = [...suites];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      for (const match of fs.readFileSync(file, 'utf8').matchAll(specifier)) {
        const target = resolveImport(file, match[1]);
        if (target && !reached.has(target)) {
          reached.add(target);
          queue.push(target);
        }
      }
    }
    return [...reached]
      .map((file) => path.relative(repositoryRoot, file).split(path.sep).join('/'))
      .sort();
  }

  it('sends every file a pg suite reaches to the PostgreSQL suite on its own', () => {
    const suites = pgSuitesOnDisk();
    const reached = filesThePgSuitesReach(suites);
    // Floors, so a walk that finds nothing or follows no import cannot pass.
    expect(suites.length).toBeGreaterThan(250);
    expect(reached.length).toBeGreaterThan(suites.length + 100);
    expect(reached).toContain('apps/web/src/lib/gymTime.ts');

    const flags = flagsPerFile(reached);
    // Naming the absentees: add each one to PG_SUITE_DEPENDENCIES in
    // scripts/ci-classify-paths.mjs (or a prefix there, if a whole folder is
    // server-only).
    expect(reached.filter((file) => flags[file].migrations !== true)).toEqual([]);
  });

  it('through the CLI too, for the two files most suites import', () => {
    for (const file of ['apps/web/src/lib/gymTime.ts', 'apps/web/lib/calendarDay.ts']) {
      const flags = classify([file]);
      expect([file, flags.migrations, flags.docs_only, flags.unknown_code]).toEqual([file, 'true', 'false', 'false']);
    }
  });

  it('lists no file that is gone, so the list cannot rot into a false record', () => {
    const script = [
      `import { PG_SUITE_DEPENDENCIES } from ${JSON.stringify(pathToFileURL(classifier).href)};`,
      'console.log(JSON.stringify(PG_SUITE_DEPENDENCIES));',
    ].join('\n');
    const listed: string[] = JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }),
    );
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.filter((file) => !fs.existsSync(path.join(repositoryRoot, file)))).toEqual([]);
  });

  it('stays exact: a sibling client file in the same folders does not run the suite', () => {
    // The reason for exact paths over folder prefixes. A made-up name, so a
    // suite that later imports a real sibling needs only the list edited.
    const sibling = 'apps/web/lib/notAPgDependency.ts';
    expect(flagsPerFile([sibling])[sibling].migrations).toBe(false);
  });
});
