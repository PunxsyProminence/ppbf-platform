// The dispatch contract of .github/workflows/cleanup-audit-test-records.yml, the
// only way the audit test record report (pilot blocker B6; lane W5-B6, B6-2)
// reaches a real database.
//
// Pinned here, from the real file: the three inputs and no mode or apply
// (this version only reports); the job runs in the environment named by
// `target`; the secrets are repair-research-baseline.yml's plus the reference
// key App Overwatch approved (QR A, #2227); free text and the key reach the
// shell only through the environment. The guard, tool and record steps are
// extracted and RUN by bash (npm replaced by a function that prints its
// arguments), the method of cleanupIntakeResearchRequirementsWorkflowContract.
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
const TOOL_STEP = 'Report Audit Test Records';
const RECORD_STEP = 'Record The Report';
const REF_KEY = 'PPBF_AUDIT_TEST_CLEANUP_REF_KEY';

function readWorkflow(file: string): string {
  return fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8').replace(/\r\n/g, '\n');
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

/** Every line of every `run:` body in the file. */
function runBodies(text: string): string[] {
  return text.split('\n').reduce<{ inRun: boolean; lines: string[] }>((acc, line) => {
    if (/^ {8}run: \|/.test(line)) return { inRun: true, lines: acc.lines };
    if (acc.inRun && line.trim() !== '' && !line.startsWith('          ')) return { inRun: false, lines: acc.lines };
    if (acc.inRun) acc.lines.push(line);
    return acc;
  }, { inRun: false, lines: [] }).lines;
}

const BASH = process.platform === 'win32' && fs.existsSync('C:/Program Files/Git/bin/bash.exe')
  ? 'C:/Program Files/Git/bin/bash.exe'
  : 'bash';

function bash(script: string, values: Record<string, string>): { status: number | null; stdout: string[]; output: string } {
  const result = spawnSync(BASH, ['--noprofile', '--norc', '-e', '-s'], {
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
  return bash(runScript(GUARD_STEP), { TARGET: 'production', CONFIRM_TARGET: 'production', ORGANIZATION: 'punxsy_prominence', ...values });
}

/** The arguments the tool step hands npm. */
function toolArgs(organization: string): string[] {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'b6-workflow-'));
  try {
    const stub = 'npm() { printf \'NPM_ARG:%s\\n\' "$@"; }\n';
    const run = bash(`set -o pipefail\n${stub}${runScript(TOOL_STEP)}`, { ORGANIZATION: organization, RUNNER_TEMP: temp });
    if (run.status !== 0) throw new Error(run.output);
    return run.stdout.filter((line) => line.startsWith('NPM_ARG:')).map((line) => line.slice('NPM_ARG:'.length));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/** Runs the record step over `toolOutput` and returns the step summary it wrote. */
function summaryFor(toolOutput: string): string {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'b6-workflow-'));
  try {
    fs.writeFileSync(path.join(temp, 'tool-output.txt'), toolOutput);
    const summary = path.join(temp, 'summary.md');
    const run = bash(runScript(RECORD_STEP), {
      RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: summary, TARGET: 'production', ORGANIZATION: 'ALL_ORGANIZATIONS', JOB_STATUS: 'success',
    });
    if (run.status !== 0) throw new Error(run.output);
    return fs.readFileSync(summary, 'utf8');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

describe(`${FILE}: what a dispatch can ask for`, () => {
  const text = readWorkflow(FILE);

  test('dispatch only, with exactly three inputs: this version has no mode and no apply', () => {
    expect(text).toMatch(/^on:\n {2}workflow_dispatch:\n {4}inputs:\n/m);
    expect(text).not.toMatch(/^\s+(schedule|push|pull_request|workflow_run):/m);
    const inputs = [...text.matchAll(/^ {6}([a-z_]+):\n {8}description:/gm)].map((m) => m[1]);
    expect(inputs).toEqual(['target', 'confirm_target', 'organization']);
    expect(text).toContain('      target:\n        description: Database environment\n        required: true\n        type: choice\n        options:\n          - staging\n          - production\n');
    expect(text).toContain('      organization:\n        description: An organization_id, or ALL_ORGANIZATIONS for every organization\n        required: true\n        type: string\n');
    expect(text).not.toContain('PPBF_AUDIT_TEST_CLEANUP_APPLY');
    expect(text).not.toMatch(/inputs\.(mode|kinds|confirm_delete|expected_fingerprint)/);
  });

  test('one job, in the environment named by target, with a group of its own', () => {
    expect([...text.matchAll(/^ {2}([a-z-]+):\n {4}environment:/gm)].map((m) => m[1])).toEqual(['cleanup']);
    expect(text).toContain('    environment: ${{ inputs.target }}\n');
    expect(text).toContain('  group: cleanup-audit-test-records-${{ inputs.target }}\n  cancel-in-progress: false\n');
  });

  test('the secrets are repair-research-baseline.yml\'s, plus the reference key and nothing else', () => {
    const secrets = (file: string) => [...new Set([...readWorkflow(file).matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]))].sort();
    expect(secrets(FILE)).toEqual([...secrets('repair-research-baseline.yml'), REF_KEY].sort());
  });

  test('the reference key reaches only the tool step, through its environment; no run block names it', () => {
    expect(text.split('\n').filter((line) => line.includes(REF_KEY) && !line.trim().startsWith('#'))).toEqual([
      `          ${REF_KEY}: \${{ secrets.${REF_KEY} }}`,
    ]);
    expect(stepText(TOOL_STEP)).toContain(`          ${REF_KEY}: \${{ secrets.${REF_KEY} }}\n`);
    expect(runBodies(text).filter((line) => line.includes(REF_KEY))).toEqual([]);
    expect(fs.readFileSync(TOOL, 'utf8')).toContain(`env.${REF_KEY}`);
  });

  test('no input is interpolated into a run block', () => {
    expect(runBodies(text).length).toBeGreaterThan(20);
    expect(runBodies(text).filter((line) => line.includes('${{'))).toEqual([]);
    expect(text.split('\n').filter((line) => /^\s+run: (?!\|).*\$\{\{/.test(line))).toEqual([]);
  });

  test('the tool step runs under bash with pipefail, so a refused run fails the job through tee', () => {
    expect(stepText(TOOL_STEP)).toContain('        shell: bash\n');
    expect(stepText(TOOL_STEP)).toMatch(/\| tee -a "\$RUNNER_TEMP\/tool-output\.txt"$/m);
  });
});

describe(`${FILE}: the guard step, run`, () => {
  test('a matching target and an organization pass', () => {
    expect(guard({}).status).toBe(0);
    expect(guard({ ORGANIZATION: 'ALL_ORGANIZATIONS' }).status).toBe(0);
  });

  test.each([
    ['a retyped target that differs', { CONFIRM_TARGET: 'staging' }, 'confirm_target does not match'],
    ['an empty organization', { ORGANIZATION: '' }, 'organization must be'],
    ['an organization that reads as a flag', { ORGANIZATION: '--all-organizations' }, 'organization must be'],
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
});
