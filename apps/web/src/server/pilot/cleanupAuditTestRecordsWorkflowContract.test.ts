// The dispatch contract of .github/workflows/cleanup-audit-test-records.yml, the
// only way the audit test record report (pilot blocker B6; lane W5-B6, B6-2)
// reaches a real database (B6-2; the apply inputs, B6-3).
//
// Pinned here, from the real file: the seven inputs; mode apply is the only
// way PPBF_AUDIT_TEST_CLEANUP_APPLY becomes 'true', and only in the tool
// step; the guard refuses an apply without kinds, the phrase and a
// fingerprint, and a dry run that carries the phrase or a fingerprint (a dry
// run may name kinds: they are bound into its fingerprint); the job runs in the environment named by
// `target`; the secrets are repair-research-baseline.yml's plus the reference
// key App Overwatch approved (QR A, #2227); free text and the key reach the
// shell only through the environment. The guard, tool and record steps are
// extracted and RUN by bash (npm replaced by a function), the method of
// cleanupIntakeResearchRequirementsWorkflowContract. The tool step runs with
// the flags GitHub gives a `shell: bash` step (actions/runner,
// src/Runner.Worker/Handlers/ScriptHandlerHelpers.cs: "--noprofile --norc -e
// -o pipefail {0}"); a step with no `shell:` gets `bash -e {0}`.
//
// Where it runs (Codex finding 4723994429 on #2242): `cleanup` takes its
// runner from a `launch` job built as session-token-cleanup.yml's is (a
// single-use Azure runner when PPBF_AZURE_DB_RUNNER is 'true' and the run is
// from main, otherwise GitHub's); the route step's own bash is RUN here too.
//
// WHAT THIS CANNOT SHOW. Nothing here evaluates a GitHub expression, talks to
// Azure or checks the production environment's approval rule. The tool's own
// behaviour is proved in cleanupAuditTestRecords.pg.test.ts.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const WORKFLOW_DIR = path.join(REPO_ROOT, '.github/workflows');
const FILE = 'cleanup-audit-test-records.yml';
const TOOL = path.join(REPO_ROOT, 'apps/web/scripts/pilot-cleanup-audit-test-records.mjs');
const GUARD_STEP = 'Confirm Explicit Target';
const TOOL_STEP = 'Run The Audit Test Record Cleanup';
const RECORD_STEP = 'Record The Report';
const REF_KEY = 'PPBF_AUDIT_TEST_CLEANUP_REF_KEY';
const APPLY_VAR = 'PPBF_AUDIT_TEST_CLEANUP_APPLY';
const PHRASE = 'DELETE AUDIT TEST RECORDS';
const FINGERPRINT = `sha256:${'a'.repeat(64)}`;

function readWorkflow(file: string): string {
  return fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8').replace(/\r\n/g, '\n');
}

/** Each job under `jobs:`, by id, as its whole block of lines. */
function jobBlocks(text: string): Map<string, string> {
  const jobsAt = text.indexOf('\njobs:\n');
  if (jobsAt === -1) throw new Error(`${FILE}: no jobs: section`);
  const lines = text.slice(jobsAt + '\njobs:\n'.length).split('\n');
  const blocks = new Map<string, string>();
  let current: string | null = null;
  for (const line of lines) {
    const id = /^ {2}([A-Za-z_][A-Za-z0-9_-]*):$/.exec(line);
    if (id) {
      current = id[1];
      blocks.set(current, '');
    } else if (current !== null) {
      blocks.set(current, `${blocks.get(current)}${line}\n`);
    }
  }
  return blocks;
}

/** One named step, from its `- name:` line to the line before the next step. */
function stepText(step: string): string {
  const lines = readWorkflow(FILE).split('\n');
  const starts = lines.flatMap((line, index) => (line === `      - name: ${step}` ? [index] : []));
  if (starts.length !== 1) throw new Error(`${FILE}: expected one step "${step}", found ${starts.length}`);
  let end = starts[0] + 1;
  while (end < lines.length && !/^ {6}- name: /.test(lines[end]) && !/^ {0,4}\S/.test(lines[end])) end += 1;
  return lines.slice(starts[0], end).join('\n');
}

/** The step's `run: |` body, dedented, with GitHub expressions made inert. */
function runScript(step: string): string {
  const lines = stepText(step).split('\n');
  const runAt = lines.indexOf('        run: |');
  if (runAt === -1) throw new Error(`${FILE}: step "${step}" has no run block`);
  const body: string[] = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== '' && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n').replace(/\$\{\{[^}]*\}\}/g, 'GITHUB_EXPRESSION');
}

/**
 * Every line of every `run:` value in the text, in any form: `run: x`,
 * `- run: x`, and `|` or `>` blocks (with chomping), to the first line indented
 * no deeper than the key.
 */
function runBodies(text: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^( *)(- +)?run:(.*)$/.exec(lines[i]);
    if (!m) continue;
    const value = m[3].trim();
    if (!/^[|>][+-]?[0-9]?$/.test(value)) {
      out.push(value);
      continue;
    }
    const keyIndent = m[1].length + (m[2] ?? '').length;
    while (i + 1 < lines.length && (lines[i + 1].trim() === '' || lines[i + 1].search(/\S/) > keyIndent)) {
      i += 1;
      out.push(lines[i]);
    }
  }
  return out;
}

const BASH = process.platform === 'win32' && fs.existsSync('C:/Program Files/Git/bin/bash.exe')
  ? 'C:/Program Files/Git/bin/bash.exe'
  : 'bash';

// What GitHub runs a step with: `shell: bash`, or no `shell:` at all.
const SHELL_BASH = ['--noprofile', '--norc', '-e', '-o', 'pipefail'];
const SHELL_DEFAULT = ['-e'];

function bash(
  script: string,
  values: Record<string, string>,
  flags: string[] = SHELL_DEFAULT,
): { status: number | null; stdout: string[]; output: string } {
  const result = spawnSync(BASH, [...flags, '-s'], {
    input: script,
    // Deliberately NOT process.env: only what this call sets is present.
    env: { PATH: process.env.PATH ?? '', ...values } as unknown as NodeJS.ProcessEnv,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout.replace(/\r\n/g, '\n').split('\n'),
    output: `${result.stdout}\n${result.stderr}`,
  };
}

function guard(values: Record<string, string>) {
  return bash(runScript(GUARD_STEP), {
    TARGET: 'production', CONFIRM_TARGET: 'production', ORGANIZATION: 'punxsy_prominence',
    MODE: 'dry-run', KINDS: '', CONFIRM_DELETE: '', EXPECTED_FINGERPRINT: '', ...values,
  });
}

const APPLY = { MODE: 'apply', KINDS: 'classes,tvs', CONFIRM_DELETE: PHRASE, EXPECTED_FINGERPRINT: FINGERPRINT };

/** Runs the tool step as a `shell: bash` step, `npm` replaced by `npmBody`. */
function toolStep(organization: string, npmBody: string, kinds = ''): { status: number | null; stdout: string[]; captured: string } {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'b6-workflow-'));
  try {
    const run = bash(`npm() { ${npmBody}; }\n${runScript(TOOL_STEP)}`, { ORGANIZATION: organization, KINDS: kinds, RUNNER_TEMP: temp }, SHELL_BASH);
    const file = path.join(temp, 'tool-output.txt');
    return { status: run.status, stdout: run.stdout, captured: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/** The arguments the tool step hands npm. */
function toolArgs(organization: string, kinds = ''): string[] {
  const run = toolStep(organization, 'printf \'NPM_ARG:%s\\n\' "$@"', kinds);
  if (run.status !== 0) throw new Error(run.stdout.join('\n'));
  return run.stdout.filter((line) => line.startsWith('NPM_ARG:')).map((line) => line.slice('NPM_ARG:'.length));
}

/** Runs the record step over `toolOutput` and returns the step summary it wrote. */
function summaryFor(toolOutput: string, values: Record<string, string> = {}): string {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'b6-workflow-'));
  try {
    fs.writeFileSync(path.join(temp, 'tool-output.txt'), toolOutput);
    const summary = path.join(temp, 'summary.md');
    const run = bash(runScript(RECORD_STEP), {
      RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: summary, TARGET: 'production', ORGANIZATION: 'ALL_ORGANIZATIONS', JOB_STATUS: 'success',
      MODE: 'dry-run', KINDS: '', EXPECTED_FINGERPRINT: '', ...values,
    });
    if (run.status !== 0) throw new Error(run.output);
    return fs.readFileSync(summary, 'utf8');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

describe(`${FILE}: what a dispatch can ask for`, () => {
  const text = readWorkflow(FILE);

  test('dispatch only, with exactly seven inputs; mode defaults to dry-run', () => {
    expect(text).toMatch(/^on:\n {2}workflow_dispatch:\n {4}inputs:\n/m);
    expect(text).not.toMatch(/^\s+(schedule|push|pull_request|workflow_run):/m);
    // Every key directly under `inputs:`, however the input is written.
    const inputs: string[] = [];
    for (const line of text.slice(text.indexOf('\n    inputs:\n') + '\n    inputs:\n'.length).split('\n')) {
      if (line.trim() === '' || line.trim().startsWith('#')) continue;
      if (!line.startsWith('      ')) break;
      const key = /^ {6}([^ :#][^:]*):/.exec(line);
      if (key) inputs.push(key[1]);
    }
    expect(inputs).toEqual(['target', 'confirm_target', 'organization', 'mode', 'kinds', 'confirm_delete', 'expected_fingerprint']);
    expect(text).toContain('      target:\n        description: Database environment\n        required: true\n        type: choice\n        options:\n          - staging\n          - production\n');
    expect(text).toContain('      organization:\n        description: An organization_id, or ALL_ORGANIZATIONS for every organization\n        required: true\n        type: string\n');
    expect(text).toContain('      mode:\n        description: Report the records (dry run), or act on the reviewed plan\n        required: true\n'
      + '        default: dry-run\n        type: choice\n        options:\n          - dry-run\n          - apply\n');
  });

  test('the apply variable is set in one place only: the tool step, from mode apply', () => {
    expect(text.split('\n').filter((line) => line.includes(APPLY_VAR) && !line.trim().startsWith('#'))).toEqual([
      `          ${APPLY_VAR}: \${{ inputs.mode == 'apply' }}`,
    ]);
    expect(stepText(TOOL_STEP)).toContain(`          ${APPLY_VAR}: \${{ inputs.mode == 'apply' }}\n`);
    for (const [name, input] of [['PPBF_AUDIT_TEST_CLEANUP_CONFIRM', 'confirm_delete'], ['PPBF_AUDIT_TEST_CLEANUP_EXPECT_FINGERPRINT', 'expected_fingerprint']]) {
      expect(text.split('\n').filter((line) => line.includes(name) && !line.trim().startsWith('#')))
        .toEqual([`          ${name}: \${{ inputs.${input} }}`]);
    }
    expect(runBodies(text).filter((line) => line.includes(APPLY_VAR))).toEqual([]);
  });

  test('the guard\'s phrase is the tool\'s', () => {
    expect(fs.readFileSync(TOOL, 'utf8')).toContain(`export const CONFIRM_PHRASE = '${PHRASE}';`);
    expect(runScript(GUARD_STEP)).toContain(`[ "$CONFIRM_DELETE" != "${PHRASE}" ]`);
  });

  test('two jobs, launch and cleanup; only cleanup runs in the environment named by target; a group of its own', () => {
    const jobs = jobBlocks(text);
    expect([...jobs.keys()]).toEqual(['cleanup', 'launch']);
    expect([...jobs].filter(([, block]) => /^ {4}environment:/m.test(block)).map(([id]) => id)).toEqual(['cleanup']);
    expect(jobs.get('cleanup')).toContain('    environment: ${{ inputs.target }}\n');
    expect(text).toContain('  group: cleanup-audit-test-records-${{ inputs.target }}\n  cancel-in-progress: false\n');
  });

  test('the secrets are repair-research-baseline.yml\'s, plus the reference key and nothing else', () => {
    const secrets = (file: string) => [...new Set([...readWorkflow(file).matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
    expect(secrets(FILE)).toEqual([...secrets('repair-research-baseline.yml'), REF_KEY].sort());
  });

  test('every secret is named one by one: no step reads the whole secrets context', () => {
    // `toJSON(secrets)`, `secrets[...]` or a bare `secrets` would hand a step
    // every secret, the reference key included, past the list above.
    const whole = text.split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .filter((line) => /\bsecrets\b(?!\.[A-Z0-9_]+\b)/.test(line));
    expect(whole).toEqual([]);
    expect(text).not.toMatch(/\bsecrets: inherit\b/);
  });

  test('the reference key reaches only the tool step, through its environment; no run block names it', () => {
    expect(text.split('\n').filter((line) => line.includes(REF_KEY) && !line.trim().startsWith('#'))).toEqual([
      `          ${REF_KEY}: \${{ secrets.${REF_KEY} }}`,
    ]);
    expect(stepText(TOOL_STEP)).toContain(`          ${REF_KEY}: \${{ secrets.${REF_KEY} }}\n`);
    expect(runBodies(text).filter((line) => line.includes(REF_KEY))).toEqual([]);
    expect(fs.readFileSync(TOOL, 'utf8')).toContain(`env.${REF_KEY}`);
  });

  test('the run-block reader sees every way of writing run', () => {
    const forms = [
      'steps:',
      '  - run: echo "${{ inputs.a }}"',
      '  - run: |',
      '      echo ok',
      '      echo "${{ inputs.b }}"',
      '  - name: Folded',
      '    run: >-',
      '      echo "${{ inputs.c }}"',
      '    env:',
      '      NOT_RUN: ${{ inputs.d }}',
    ].join('\n');
    expect(runBodies(forms).filter((line) => line.includes('${{'))).toEqual([
      'echo "${{ inputs.a }}"',
      '      echo "${{ inputs.b }}"',
      '      echo "${{ inputs.c }}"',
    ]);
  });

  test('no input is interpolated into a run block', () => {
    expect(runBodies(text).length).toBeGreaterThan(20);
    expect(runBodies(text).filter((line) => line.includes('${{'))).toEqual([]);
  });

  test('the tool step runs under `shell: bash`, which brings pipefail', () => {
    expect(stepText(TOOL_STEP)).toContain('        shell: bash\n');
  });

  test('the record step runs only after the guard passed, and on every outcome after that', () => {
    expect(stepText(GUARD_STEP)).toContain('        id: guard\n');
    expect(stepText(RECORD_STEP)).toContain("        if: always() && steps.guard.outcome == 'success'\n");
  });
});

describe(`${FILE}: where the job runs (Codex finding 4723994429 on #2242)`, () => {
  const text = readWorkflow(FILE);
  const allowed = fs.readFileSync(path.join(REPO_ROOT, 'infra/gh-runner/allowed-jobs.txt'), 'utf8').split('\n');

  /** Runs the launch job's route step as GitHub would (no `shell:`: bash -e) and returns what it wrote. */
  function route(values: Record<string, string>): string {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'b6-route-'));
    try {
      const output = path.join(temp, 'output');
      fs.writeFileSync(output, '');
      const run = bash(runScript('Choose The Runner'), { GITHUB_OUTPUT: output, ...values });
      if (run.status !== 0) throw new Error(run.output);
      return fs.readFileSync(output, 'utf8');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }

  test('cleanup keeps its job id, waits for launch and takes its runner from it; it is on the runner allow-list', () => {
    expect(text).toMatch(/\n {2}cleanup:\n {4}needs: launch\n {4}environment: \$\{\{ inputs\.target \}\}\n {4}runs-on: \$\{\{ fromJSON\(needs\.launch\.outputs\.runs-on\) \}\}\n/);
    expect(jobBlocks(text).get('cleanup')).not.toMatch(/^ {4}runs-on: ubuntu-latest$/m);
    expect(allowed).toContain('cleanup-audit-test-records.yml:cleanup');
  });

  test('launch is session-token-cleanup.yml\'s: last in the file, no environment, four steps gated on the route, GitHub\'s runner as the fallback, fail-closed', () => {
    const launch = /\n {2}launch:\n([\s\S]*)$/.exec(text)?.[1] ?? '';
    expect(launch).not.toBe('');
    expect(launch).not.toMatch(/\n {2}[a-z-]+:\n/);
    expect(launch).not.toMatch(/^ {4}environment:/m);
    expect(launch).toMatch(/^ {4}runs-on: ubuntu-latest$/m);
    expect(launch).toContain('SWITCH: ${{ vars.PPBF_AZURE_DB_RUNNER }}');
    // The gates read these ids: renamed, every gated step would be skipped and the fallback taken.
    expect(launch).toMatch(/- name: Choose The Runner\n {8}id: route\n/);
    expect(launch).toMatch(/- name: Launch A Runner In Azure\n {8}id: azure\n/);
    const gated = launch.split(/\n {6}- name: /).slice(2);
    expect(gated).toHaveLength(4);
    for (const step of gated) expect(step).toContain("if: steps.route.outputs.azure == 'true'");
    expect(launch).toContain(`runs-on: \${{ steps.azure.outputs.runs-on || '"ubuntu-latest"' }}`);
    expect(launch).toContain('uses: ./.github/actions/azure-runner-launch');
    expect(launch).toContain('app-id: ${{ vars.PPBF_RUNNER_APP_ID }}');
    expect(launch).toContain('installation-id: ${{ vars.PPBF_RUNNER_INSTALLATION_ID }}');
    expect(launch).toMatch(/- name: Check A Runner Was Named\n {8}if: steps\.route\.outputs\.azure == 'true'\n {8}env:\n {10}RUNS_ON: \$\{\{ steps\.azure\.outputs\.runs-on \}\}\n {8}run: test -n "\$RUNS_ON"\n/);
    // launch never reaches the database, so it is not on the runner allow-list.
    expect(allowed).not.toContain('cleanup-audit-test-records.yml:launch');
  });

  test('the route step sends cleanup to Azure only when the switch is true, the run is from main and the retyped target matches', () => {
    const ok = { SWITCH: 'true', GITHUB_REF: 'refs/heads/main', TARGET: 'production', CONFIRM_TARGET: 'production' };
    expect(route(ok)).toBe('azure=true\n');
    expect(route({ ...ok, SWITCH: 'TRUE' })).toBe('azure=true\n');
    expect(route({ ...ok, GITHUB_REF: 'refs/heads/claude/some-branch' })).toBe('azure=false\n');
    expect(route({ ...ok, SWITCH: '' })).toBe('azure=false\n');
    expect(route({ ...ok, SWITCH: 'false' })).toBe('azure=false\n');
    expect(route({ ...ok, CONFIRM_TARGET: 'staging' })).toBe('azure=false\n');
    expect(route({ ...ok, CONFIRM_TARGET: '' })).toBe('azure=false\n');
  });

  test('the route reads the target and its retyped copy from the inputs, through env', () => {
    expect(stepText('Choose The Runner')).toContain('          TARGET: ${{ inputs.target }}\n          CONFIRM_TARGET: ${{ inputs.confirm_target }}\n');
  });

  test('the resource-group guard still comes before the file\'s first Azure login', () => {
    const guardAt = text.indexOf('- name: Resolve Target Resource Group');
    const loginAt = text.indexOf('uses: azure/login@');
    expect(guardAt).toBeGreaterThan(-1);
    expect(loginAt).toBeGreaterThan(guardAt);
  });
});

describe(`${FILE}: the guard step, run`, () => {
  test('a matching target and an organization pass, as a dry run and as a complete apply', () => {
    expect(guard({}).status).toBe(0);
    expect(guard({ ORGANIZATION: 'ALL_ORGANIZATIONS' }).status).toBe(0);
    expect(guard(APPLY).status).toBe(0);
    expect(guard({ ...APPLY, KINDS: 'test-organizations' }).status).toBe(0);
    expect(guard({ KINDS: 'classes,tvs' }).status).toBe(0);
  });

  test.each([
    ['a retyped target that differs', { CONFIRM_TARGET: 'staging' }, 'confirm_target does not match'],
    ['an empty organization', { ORGANIZATION: '' }, 'organization must be'],
    ['an organization that reads as a flag', { ORGANIZATION: '--all-organizations' }, 'organization must be'],
    ['an organization that starts with one dash', { ORGANIZATION: '-x' }, 'organization must be'],
    ['an organization with a line break', { ORGANIZATION: 'gym\n::warning::injected' }, 'one line'],
    ['an organization with a carriage return', { ORGANIZATION: 'gym\r' }, 'one line'],
    ['an organization with a tab', { ORGANIZATION: 'gym\tx' }, 'one line'],
    ['a mode that is neither', { MODE: 'delete' }, 'mode must be dry-run or apply'],
    ['a dry run with malformed kinds', { KINDS: 'classes, tvs' }, 'kinds must be'],
    ['a dry run with the phrase', { CONFIRM_DELETE: PHRASE }, 'for apply mode only'],
    ['a dry run with a fingerprint', { EXPECTED_FINGERPRINT: FINGERPRINT }, 'for apply mode only'],
    ['an apply with no kinds', { ...APPLY, KINDS: '' }, 'apply mode needs kinds'],
    ['an apply with a space in kinds', { ...APPLY, KINDS: 'classes, tvs' }, 'kinds must be'],
    ['an apply with kinds in capitals', { ...APPLY, KINDS: 'CLASSES' }, 'kinds must be'],
    ['an apply with no phrase', { ...APPLY, CONFIRM_DELETE: '' }, 'apply mode needs confirm_delete'],
    ['an apply with the phrase in lower case', { ...APPLY, CONFIRM_DELETE: PHRASE.toLowerCase() }, 'apply mode needs confirm_delete'],
    ['an apply with no fingerprint', { ...APPLY, EXPECTED_FINGERPRINT: '' }, 'apply mode needs expected_fingerprint'],
    ['an apply with a short fingerprint', { ...APPLY, EXPECTED_FINGERPRINT: 'sha256:abc' }, 'apply mode needs expected_fingerprint'],
    ['kinds with a line break', { ...APPLY, KINDS: 'classes\n::warning::injected' }, 'one line'],
    ['a phrase with a line break', { ...APPLY, CONFIRM_DELETE: `${PHRASE}\n` }, 'one line'],
    ['a fingerprint with a line break', { ...APPLY, EXPECTED_FINGERPRINT: `${FINGERPRINT}\n` }, 'one line'],
  ])('refuses %s', (_label, values, message) => {
    const run = guard(values as Record<string, string>);
    expect(run.status).toBe(1);
    expect(run.output).toContain(message);
  });
});

describe(`${FILE}: the tool step, run`, () => {
  test('ALL_ORGANIZATIONS becomes --all-organizations', () => {
    expect(toolArgs('ALL_ORGANIZATIONS')).toEqual(['run', 'pilot:cleanup-audit-test-records', '--', '--all-organizations']);
  });

  test('an organization id is passed as one argument, never parsed by the shell', () => {
    expect(toolArgs('punxsy_prominence')).toEqual(['run', 'pilot:cleanup-audit-test-records', '--', '--organization', 'punxsy_prominence']);
    expect(toolArgs('a b; echo PWNED')).toEqual(['run', 'pilot:cleanup-audit-test-records', '--', '--organization', 'a b; echo PWNED']);
  });

  test('kinds reach npm as one argument after --kinds, and only when given', () => {
    expect(toolArgs('punxsy_prominence', 'classes,tvs'))
      .toEqual(['run', 'pilot:cleanup-audit-test-records', '--', '--organization', 'punxsy_prominence', '--kinds', 'classes,tvs']);
    expect(toolArgs('ALL_ORGANIZATIONS', 'a b; echo PWNED'))
      .toEqual(['run', 'pilot:cleanup-audit-test-records', '--', '--all-organizations', '--kinds', 'a b; echo PWNED']);
    expect(toolArgs('ALL_ORGANIZATIONS')).not.toContain('--kinds');
  });

  test('a refusal on stderr fails the step and is captured for the summary', () => {
    const refused = '{"event":"audit_test_cleanup.refused","reason":"ORGANIZATION_NOT_FOUND"}';
    const run = toolStep('punxsy_prominence', `printf '%s\\n' '${refused}' >&2; return 1`);
    expect(run.status).toBe(1);
    expect(run.captured).toContain(refused);
    expect(summaryFor(run.captured)).toContain(refused);
  });

  test('a dry run passes the step and its result line is captured', () => {
    const result = '{"event":"audit_test_cleanup.dry-run","plan_fingerprint":"sha256:abc"}';
    const run = toolStep('ALL_ORGANIZATIONS', `printf '%s\\n' '${result}'; return 0`);
    expect(run.status).toBe(0);
    expect(run.captured).toContain(result);
  });

  test('the npm script it runs exists and points at the tool', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'apps/web/package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['pilot:cleanup-audit-test-records']).toBe('node scripts/pilot-cleanup-audit-test-records.mjs');
  });
});

describe(`${FILE}: the record step, run`, () => {
  const plan = [
    '{',
    '  "event": "audit_test_cleanup.plan",',
    '  "classes": [ { "class_id": "PLAN-ONLY-CLASS-ID" } ]',
    '}',
  ].join('\n');
  const resultLine = '{"event":"audit_test_cleanup.dry-run","plan_fingerprint":"sha256:abc","person_ref":"per-run key","counts":{"classes":3}}';

  test('the summary carries the result line, never the plan', () => {
    const summary = summaryFor(`> npm run ...\n${plan}\n${resultLine}\n`);
    expect(summary).toContain(resultLine);
    expect(summary).toContain('- organization: `ALL_ORGANIZATIONS`');
    expect(summary).not.toContain('PLAN-ONLY-CLASS-ID');
  });

  test('a refusal is shown when there is no result line', () => {
    const refused = '{"event":"audit_test_cleanup.refused","reason":"ORGANIZATION_NOT_FOUND"}';
    const summary = summaryFor(`${refused}\n`);
    expect(summary).toContain(refused);
    expect(summary).toContain('refused or failed');
  });

  test('with no output at all it says so, and does not fail', () => {
    expect(summaryFor('')).toContain('No result line was captured');
  });

  test('a dry run says nothing was written, and where the full plan is', () => {
    const summary = summaryFor(`${resultLine}\n`);
    expect(summary).toContain('### Audit test record cleanup (dry-run)');
    expect(summary).toContain('Dry run: nothing was written.');
    expect(summary).toContain('The full plan (classes, TVs, test gyms, "hiit fit", the sweep) is in the');
  });

  test('an apply records its applied line, or that there was nothing to apply, with the mode, kinds and fingerprint', () => {
    const applied = '{"event":"audit_test_cleanup.applied","status":"applied","kinds":["classes"],"counts":{"classes":3}}';
    const values = { MODE: 'apply', KINDS: 'classes', EXPECTED_FINGERPRINT: FINGERPRINT };
    const summary = summaryFor(`${plan}\n${applied}\n`, values);
    expect(summary).toContain(applied);
    expect(summary).toContain('### Audit test record cleanup (apply)');
    expect(summary).toContain('- kinds: `classes`');
    expect(summary).toContain(`- expected fingerprint: \`${FINGERPRINT}\``);
    expect(summary).not.toContain('nothing was written');
    expect(summary).not.toContain('The full plan');
    expect(summary).toContain('Apply mode: the applied, nothing-to-apply or refused line above says what was written, if anything.');
    const nothing = '{"event":"audit_test_cleanup.nothing-to-apply","kinds":["tvs"]}';
    expect(summaryFor(`${nothing}\n`, values)).toContain(nothing);
  });
});
