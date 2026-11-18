import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * infra/gh-runner -- the PPBF self-hosted runner image (lane DBT, PR-1 of the
 * Azure-runner design; OD-2026-11-17-008; Jason's card answers of 2026-11-17).
 *
 * The repository is public and owned by a user account, so GitHub offers no
 * runner groups and no "selected workflows" restriction. The image's guard hook
 * is the last check that only our own database jobs run on it. These tests hold
 * the guard to its contract, keep its allowlist and the workflows in step, and
 * pin the properties of the image and its build workflow that the security
 * model depends on.
 */

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const dir = path.join(repositoryRoot, 'infra/gh-runner');
const workflowsDir = path.join(repositoryRoot, '.github/workflows');
const guard = path.join(dir, 'job-started-guard.sh');
const entrypoint = path.join(dir, 'entrypoint.sh');
const setupInfo = path.join(dir, 'write-setup-info.sh');
const allowlistPath = path.join(dir, 'allowed-jobs.txt');
const REPO = 'PunxsyProminence/ppbf-platform';

/** bash on every platform the suite runs on; paths in forward slashes for Git Bash on Windows. */
const posix = (p: string) => p.replace(/\\/g, '/');

/**
 * Called with no arguments (as the runner calls it) the guard SIGKILLs the
 * process named Runner.Worker on refusal, and the CI machine running this suite
 * has one. With arguments it stops only what argument 3 names. Every test passes
 * arguments and names a process that does not exist, except the kill test, which
 * names its own decoy. Never run the guard here without arguments.
 */
const NO_PROCESS = 'ppbf-no-such-process';

function runGuard(env: Record<string, string>): { code: number; out: string } {
  // `bash -e`: how the runner itself runs a .sh hook.
  const r = spawnSync('bash', ['-e', posix(guard), posix(allowlistPath), REPO, NO_PROCESS], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv,
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

const allowed = fs
  .readFileSync(allowlistPath, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

function ctx(entry: string, over: Record<string, string> = {}): Record<string, string> {
  const [file, job] = entry.split(':');
  return {
    GITHUB_REPOSITORY: REPO,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/${file}@refs/heads/main`,
    GITHUB_JOB: job,
    ...over,
  };
}

describe('job-started-guard.sh: allows exactly our jobs', () => {
  it('lists the 19 database jobs', () => {
    expect(allowed).toHaveLength(19);
    expect(new Set(allowed).size).toBe(19);
  });

  it.each(allowed)('allows %s on workflow_dispatch and on schedule', (entry) => {
    for (const event of ['workflow_dispatch', 'schedule']) {
      const r = runGuard(ctx(entry, { GITHUB_EVENT_NAME: event }));
      expect({ entry, event, code: r.code }).toEqual({ entry, event, code: 0 });
      expect(r.out).toContain(`ppbf-runner-guard: allowed ${entry}`);
    }
  });
});

describe('job-started-guard.sh: refuses everything else', () => {
  const base = 'apply-migrations.yml:apply';
  const cases: Array<[string, Record<string, string>]> = [
    ['another repository (a fork)', { GITHUB_REPOSITORY: 'someone/ppbf-platform' }],
    ['pull_request', { GITHUB_EVENT_NAME: 'pull_request' }],
    ['pull_request_target', { GITHUB_EVENT_NAME: 'pull_request_target' }],
    ['push', { GITHUB_EVENT_NAME: 'push' }],
    ['workflow_run', { GITHUB_EVENT_NAME: 'workflow_run' }],
    ['a branch other than main', { GITHUB_REF: 'refs/heads/feature' }],
    ['a pull-request merge ref', { GITHUB_REF: 'refs/pull/1/merge' }],
    ['a tag', { GITHUB_REF: 'refs/tags/main' }],
    ['a workflow file from another branch', { GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/apply-migrations.yml@refs/heads/x` }],
    ['a workflow from another repository', { GITHUB_WORKFLOW_REF: `someone/x/.github/workflows/apply-migrations.yml@refs/heads/main` }],
    ['a workflow not on the list', { GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/ci.yml@refs/heads/main`, GITHUB_JOB: 'apply' }],
    ['an allowed file with another job', { GITHUB_JOB: 'other' }],
    ['the image-building staging job of release-one-approval', {
      GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/release-one-approval.yml@refs/heads/main`, GITHUB_JOB: 'staging',
    }],
    ['a nested workflow path', { GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/x/apply-migrations.yml@refs/heads/main` }],
    ['a traversal in the workflow path', { GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/../apply-migrations.yml@refs/heads/main` }],
    ['an empty job', { GITHUB_JOB: '' }],
    ['an empty repository', { GITHUB_REPOSITORY: '' }],
    ['an empty event', { GITHUB_EVENT_NAME: '' }],
    ['an empty ref', { GITHUB_REF: '' }],
    ['an empty workflow ref', { GITHUB_WORKFLOW_REF: '' }],
    ['a job id with an odd character', { GITHUB_JOB: 'apply;id' }],
    // The allowlist match is whole-line: neither a prefix nor a suffix of a listed line passes.
    ['a job id that is a prefix of a listed one', { GITHUB_JOB: 'appl' }],
    ['a file name that is a suffix of a listed one', { GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/migrations.yml@refs/heads/main` }],
    ['a line break in the workflow file name', { GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/evil\napply-migrations.yml@refs/heads/main` }],
    ['a line break in the job id', { GITHUB_JOB: 'x\napply' }],
    ['a carriage return in the ref', { GITHUB_REF: 'refs/heads/main\r' }],
  ];

  it.each(cases)('refuses %s', (_label, over) => {
    const r = runGuard(ctx(base, over));
    expect(r.code).toBe(1);
    expect(r.out).toContain('ppbf-runner-guard: REFUSED');
  });

  it('refuses when no GITHUB_* variable is set at all', () => {
    const r = runGuard({});
    expect(r.code).toBe(1);
  });

  it('never echoes a value that could be read as a workflow command', () => {
    const r = runGuard(ctx(base, { GITHUB_REF: 'refs/heads/::error::pwned%0A::add-mask::x' }));
    expect(r.code).toBe(1);
    expect(r.out).not.toContain('::');
    expect(r.out).not.toContain('%');
  });

  it('refuses when its allowlist is missing', () => {
    const r = spawnSync('bash', ['-e', posix(guard), posix(path.join(dir, 'no-such-file.txt')), REPO, NO_PROCESS], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ...ctx(base) } as unknown as NodeJS.ProcessEnv,
    });
    expect(r.status).toBe(1);
    expect(`${r.stdout}`).toContain('allowlist missing');
  });

  it('with no arguments uses the allowlist the Dockerfile installs, this repository and the Worker; with arguments stops nothing unless told', () => {
    const text = fs.readFileSync(guard, 'utf8');
    const noArgs = text.slice(text.indexOf('if [ "$#" -eq 0 ]; then'), text.indexOf('\nfi\n'));
    expect(noArgs).toContain('ALLOWED_FILE=/opt/ppbf-runner/allowed-jobs.txt');
    expect(noArgs).toContain(`EXPECTED_REPO=${REPO}`);
    expect(noArgs).toContain('STOP_PROCESSES=Runner.Worker');
    expect(noArgs).toContain('STOP_PROCESSES="${3:-}"');
    expect(fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8')).toContain('allowed-jobs.txt /opt/ppbf-runner/');
  });

  it('fails closed: the stop is armed for every exit and disarmed only right before the allow', () => {
    const text = fs.readFileSync(guard, 'utf8');
    const armed = text.indexOf("trap 'stop_runner' EXIT");
    const disarmed = text.indexOf('trap - EXIT');
    expect(armed).toBeGreaterThan(-1);
    expect(armed).toBeLessThan(text.indexOf('repo="${GITHUB_REPOSITORY:-}"'));
    expect(disarmed).toBeGreaterThan(text.indexOf('grep -Fxq'));
    expect(text.slice(disarmed).split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'))).toEqual([
      'trap - EXIT',
      'echo "ppbf-runner-guard: allowed $file:$job ($event on $ref)."',
      'exit 0',
    ]);
  });

  // The runner queues the hook as an always() step (actions/runner JobExtension.cs), so a
  // failing hook alone would let a foreign job's `if: always()` steps run. The guard kills
  // the Worker instead. Linux only: it needs a parent process with a chosen name in /proc.
  const linuxOnly = process.platform === 'linux' ? it : it.skip;
  linuxOnly('on refusal it kills the runner process, so nothing after it runs; on allow it does not', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-guard-kill-'));
    const decoy = path.join(tmp, 'ppbf-decoy-wkr');
    fs.copyFileSync('/bin/bash', decoy);
    fs.chmodSync(decoy, 0o755);
    const run = (over: Record<string, string>) =>
      spawnSync(decoy, ['-c', `bash -e "${guard}" "${allowlistPath}" "${REPO}" ppbf-decoy-wkr; echo AFTER-GUARD`], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', ...ctx('apply-migrations.yml:apply', over) } as unknown as NodeJS.ProcessEnv,
      });
    try {
      const refused = run({ GITHUB_EVENT_NAME: 'push' });
      expect(refused.signal).toBe('SIGKILL');
      expect(refused.stdout).not.toContain('AFTER-GUARD');
      const allowedRun = run({});
      expect(allowedRun.status).toBe(0);
      expect(allowedRun.stdout).toContain('AFTER-GUARD');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('allowed-jobs.txt agrees with the workflows', () => {
  interface Job { file: string; job: string; text: string }
  const jobs: Job[] = [];
  const triggers = new Map<string, string[]>();
  for (const file of fs.readdirSync(workflowsDir).filter((f) => f.endsWith('.yml'))) {
    const lines = fs.readFileSync(path.join(workflowsDir, file), 'utf8').split('\n');
    const onAt = lines.findIndex((l) => /^on:\s*$/.test(l));
    const on: string[] = [];
    for (let i = onAt + 1; onAt >= 0 && i < lines.length && !/^\S/.test(lines[i]); i += 1) {
      const m = /^ {2}([a-z_]+):/.exec(lines[i]);
      if (m) on.push(m[1]);
    }
    triggers.set(file, on);
    const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
    let current: Job | null = null;
    for (let i = jobsAt + 1; jobsAt >= 0 && i < lines.length; i += 1) {
      const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
      if (m) {
        current = { file, job: m[1], text: '' };
        jobs.push(current);
      } else if (/^\S/.test(lines[i])) {
        break;
      } else if (current && !lines[i].trim().startsWith('#')) {
        // Code only: a comment that mentions docker builds nothing.
        current.text += `${lines[i]}\n`;
      }
    }
  }

  const reachesPostgres = (j: Job) => j.text.includes('--secret-name azure-postgres-connection-string');
  const buildsImages = (j: Job) => /\bdocker\b|buildx|build-push-action/.test(j.text);

  it.each(allowed)('%s exists, reaches Postgres, builds no image, and runs only on dispatch or schedule', (entry) => {
    const [file, job] = entry.split(':');
    const found = jobs.find((j) => j.file === file && j.job === job);
    expect(found).toBeDefined();
    expect(reachesPostgres(found as Job)).toBe(true);
    expect(buildsImages(found as Job)).toBe(false);
    const on = triggers.get(file) ?? [];
    expect(on.length).toBeGreaterThan(0);
    expect(on.filter((t) => t !== 'workflow_dispatch' && t !== 'schedule')).toEqual([]);
  });

  it('no allowed job calls a reusable workflow (the guard sees the caller file name)', () => {
    for (const entry of allowed) {
      const [file, job] = entry.split(':');
      const found = jobs.find((j) => j.file === file && j.job === job) as Job;
      expect({ entry, reusable: /^ {4}uses:/m.test(found.text) }).toEqual({ entry, reusable: false });
    }
  });

  it('every job that reaches Postgres and builds no image is on the list', () => {
    const expected = jobs.filter((j) => reachesPostgres(j) && !buildsImages(j)).map((j) => `${j.file}:${j.job}`).sort();
    expect([...allowed].sort()).toEqual(expected);
  });
});

describe('entrypoint.sh', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-runner-entry-'));
  // A stand-in for the runner: prints its arguments and whether JIT_CONFIG leaked through.
  fs.writeFileSync(
    path.join(tmp, 'run.sh'),
    '#!/usr/bin/env bash\necho "ARGS=$*"\necho "LEFT=${JIT_CONFIG:-unset}"\n'
      + 'echo "HOOK=${ACTIONS_RUNNER_HOOK_JOB_STARTED:-unset}"\necho "DONE_HOOK=${ACTIONS_RUNNER_HOOK_JOB_COMPLETED:-unset}"\n'
      + 'echo "CONTAINER_HOOKS=${ACTIONS_RUNNER_CONTAINER_HOOKS:-unset}"\necho "BASH_ENV=${BASH_ENV:-unset}"\n'
      + 'echo "KILL_IS=$(type -t kill)"\n',
    { mode: 0o755 },
  );
  // The entrypoint's paths are fixed on purpose; the tests run a copy with them rewritten.
  const original = fs.readFileSync(entrypoint, 'utf8');
  const copyWith = (guardPath: string): string => {
    const out = path.join(tmp, `entrypoint-${Math.random().toString(36).slice(2)}.sh`);
    const text = original
      .replace('readonly GUARD=/opt/ppbf-runner/job-started-guard.sh', `readonly GUARD=${guardPath}`)
      .replace('readonly RUNNER_HOME=/home/runner', `readonly RUNNER_HOME=${posix(tmp)}`);
    expect(text).not.toBe(original);
    fs.writeFileSync(out, text, { mode: 0o755 });
    return posix(out);
  };
  const testEntrypoint = copyWith(posix(guard));
  const baseEnv = { PATH: process.env.PATH ?? '' };
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('refuses to start without a JIT configuration', () => {
    const r = spawnSync('bash', [testEntrypoint], {
      encoding: 'utf8',
      env: { ...baseEnv } as unknown as NodeJS.ProcessEnv,
    });
    expect(r.status).toBe(64);
    expect(r.stderr).toContain('JIT_CONFIG is empty');
  });

  it('runs the runner once with --jitconfig and does not pass JIT_CONFIG on in the environment', () => {
    const r = spawnSync('bash', [testEntrypoint], {
      encoding: 'utf8',
      env: { ...baseEnv, JIT_CONFIG: 'eyJmYWtlIjp0cnVlfQ==' } as unknown as NodeJS.ProcessEnv,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ARGS=--jitconfig eyJmYWtlIjp0cnVlfQ==');
    expect(r.stdout).toContain('LEFT=unset');
  });

  it('forces the guard hook on and other hooks off, whatever the job execution set', () => {
    const r = spawnSync('bash', [testEntrypoint], {
      encoding: 'utf8',
      env: {
        ...baseEnv,
        JIT_CONFIG: 'x',
        ACTIONS_RUNNER_HOOK_JOB_STARTED: '',
        ACTIONS_RUNNER_HOOK_JOB_COMPLETED: '/tmp/evil.sh',
        ACTIONS_RUNNER_CONTAINER_HOOKS: '/tmp/evil.js',
        BASH_ENV: '/tmp/evil-env.sh',
      } as unknown as NodeJS.ProcessEnv,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`HOOK=${posix(guard)}`);
    expect(r.stdout).toContain('DONE_HOOK=unset');
    expect(r.stdout).toContain('CONTAINER_HOOKS=unset');
    expect(r.stdout).toContain('BASH_ENV=unset');
  });

  it('drops exported bash functions, so no child bash can replace kill, trap or grep', () => {
    const injected = { 'BASH_FUNC_kill%%': '() {  echo hijacked\n}' };
    // Control: run straight, the stand-in's bash DOES import the function, so the variable arrives.
    const control = spawnSync('bash', [posix(path.join(tmp, 'run.sh'))], {
      encoding: 'utf8',
      env: { ...baseEnv, ...injected } as unknown as NodeJS.ProcessEnv,
    });
    expect(control.stdout).toContain('KILL_IS=function');
    const r = spawnSync('bash', [testEntrypoint], {
      encoding: 'utf8',
      env: { ...baseEnv, JIT_CONFIG: 'x', ...injected } as unknown as NodeJS.ProcessEnv,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('KILL_IS=builtin');
    expect(r.stdout).not.toContain('hijacked');
  });

  it('fixes its paths, and runs as bash -p so BASH_ENV is not read', () => {
    expect(original.split('\n')[0]).toBe('#!/bin/bash -p');
    expect(original).toContain('readonly GUARD=/opt/ppbf-runner/job-started-guard.sh');
    expect(original).toContain('readonly RUNNER_HOME=/home/runner');
    expect(original).not.toMatch(/PPBF_GUARD_PATH|PPBF_RUNNER_HOME/);
  });

  it('refuses to start when the guard is missing', () => {
    const r = spawnSync('bash', [copyWith(posix(path.join(tmp, 'missing.sh')))], {
      encoding: 'utf8',
      env: { ...baseEnv, JIT_CONFIG: 'x' } as unknown as NodeJS.ProcessEnv,
    });
    expect(r.status).toBe(65);
    expect(r.stdout).not.toContain('ARGS=');
  });
});

describe('write-setup-info.sh', () => {
  it('writes the provisioner group the runner prints and the preflight reads', () => {
    const out = execFileSync('bash', [posix(setupInfo), 'ppbf-gh-runner:2.338.2-abc123', '2.338.2', 'eastus'], { encoding: 'utf8' });
    const parsed = JSON.parse(out) as Array<{ group: string; detail: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].group).toBe('Runner Image Provisioner');
    expect(parsed[0].detail).toMatch(/^Cloud: Azure$/m);
    expect(parsed[0].detail).toMatch(/^Region: eastus$/m);
    expect(parsed[0].detail).toMatch(/^Image: ppbf-gh-runner:2\.338\.2-abc123$/m);
  });

  it('is read as Azure by the database preflight (scripts/db-reachability-probe.mjs, #1957)', () => {
    const out = execFileSync('bash', [posix(setupInfo), 'ppbf-gh-runner:2.338.2-abc123', '2.338.2', 'eastus'], { encoding: 'utf8' });
    const probeUrl = pathToFileURL(path.join(repositoryRoot, 'scripts/db-reachability-probe.mjs')).href;
    const script = `import { parseSetupInfo } from ${JSON.stringify(probeUrl)}; console.log(JSON.stringify(parseSetupInfo(${JSON.stringify(out)})));`;
    const parsed = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
    expect(parsed).toEqual({ cloud: 'Azure', region: 'eastus' });
  });

  it('refuses a value that would need escaping', () => {
    const r = spawnSync('bash', [posix(setupInfo), 'a"b', '2.338.2', 'eastus'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});

describe('Dockerfile', () => {
  const text = fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8');
  const code = text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

  it('takes its base only from a build argument with no default', () => {
    expect(code).toMatch(/^ARG BASE_IMAGE\s*$/m);
    expect(code).toMatch(/^FROM \$\{BASE_IMAGE\}\s*$/m);
    expect(code.match(/^FROM /gm)).toHaveLength(1);
    expect(code).not.toMatch(/:latest\b/);
  });

  it('installs the guard as the job-started hook and starts through the entrypoint as the runner user', () => {
    expect(code).toMatch(/^ENV ACTIONS_RUNNER_HOOK_JOB_STARTED=\/opt\/ppbf-runner\/job-started-guard\.sh\s*$/m);
    expect(code).toMatch(/^ENTRYPOINT \["\/opt\/ppbf-runner\/entrypoint\.sh"\]\s*$/m);
    const users = code.match(/^USER \S+/gm) ?? [];
    expect(users[users.length - 1]).toBe('USER runner');
    expect(code).toContain('write-setup-info.sh "$IMAGE_TAG" "$RUNNER_VERSION" "$RUNNER_REGION" > /home/runner/.setup_info');
  });

  it('fails piped build steps, keeps the runner trace out of Container Apps logs, and matches hosted runners where jobs notice', () => {
    expect(code).toMatch(/^SHELL \["\/bin\/bash", "-o", "pipefail", "-c"\]\s*$/m);
    expect(code).toMatch(/^ENV ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT=0\s*$/m);
    expect(code).toMatch(/^ENV LANG=C\.UTF-8\s*$/m);
    expect(code).toMatch(/\bzstd\b/);
  });

  it('carries no credential and no Docker daemon', () => {
    expect(code).not.toMatch(/\b(ARG|ENV)\s+\S*(KEY|TOKEN|SECRET|PASSWORD|PAT|JIT)/i);
    expect(code).not.toMatch(/dockerd|docker-ce\b|--privileged|VOLUME/);
  });
});

describe('build-runner-image.yml', () => {
  const text = fs.readFileSync(path.join(workflowsDir, 'build-runner-image.yml'), 'utf8');
  const code = text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

  it('runs on dispatch only: no schedule, no push, no pull request', () => {
    const on = code.slice(code.indexOf('\non:\n'), code.indexOf('\npermissions:\n'));
    expect(on).toMatch(/^ {2}workflow_dispatch:/m);
    expect(on).not.toMatch(/^ {2}(schedule|push|pull_request|pull_request_target|workflow_run|repository_dispatch):/m);
  });

  it('asks for no more than reading the code and an OIDC token', () => {
    const perms = code.slice(code.indexOf('\npermissions:\n') + 1, code.indexOf('\nconcurrency:\n'));
    expect(perms.trim().split('\n').map((l) => l.trim()).sort()).toEqual(['contents: read', 'id-token: write', 'permissions:']);
  });

  it('refuses any ref but main before it signs in to Azure', () => {
    expect(code.indexOf('Refuse Anything But main')).toBeGreaterThan(-1);
    expect(code.indexOf('Refuse Anything But main')).toBeLessThan(code.indexOf('azure/login'));
    expect(code).toContain('if [ "$REF" != "refs/heads/main" ]; then');
  });

  it('builds in Azure from a base pinned by version and digest', () => {
    expect(code).toContain('az acr build');
    expect(code).toContain('--build-arg "BASE_IMAGE=ghcr.io/actions/actions-runner:${VERSION}@${DIGEST}"');
    expect(code).toContain('[[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]');
    expect(code).not.toMatch(/docker (build|push|login)|build-push-action/);
  });

  it('uses only the Azure sign-in secrets and the registry name', () => {
    const secrets = [...new Set(code.match(/secrets\.[A-Z_]+/g) ?? [])].sort();
    expect(secrets).toEqual([
      'secrets.AZURE_CLIENT_ID',
      'secrets.AZURE_CONTAINER_REGISTRY',
      'secrets.AZURE_SUBSCRIPTION_ID',
      'secrets.AZURE_TENANT_ID',
    ]);
  });
});
