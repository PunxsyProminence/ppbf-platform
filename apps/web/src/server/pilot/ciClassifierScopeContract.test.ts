import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  fs.writeFileSync(listFile, `${files.join('\n')}\n`);
  const stdout = execFileSync(process.execPath, [classifier, listFile], { encoding: 'utf8' });
  return Object.fromEntries(
    stdout.trim().split('\n').map((line) => line.split('=') as [string, string]),
  );
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
