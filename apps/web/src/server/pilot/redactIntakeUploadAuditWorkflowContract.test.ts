// The dispatch contract of .github/workflows/redact-intake-upload-audit.yml, the
// only way the intake upload audit redaction reaches a real database (Jason
// 2026-11-09, "Redact the names"; OD-2026-10-02-015 D4; OD-2026-10-03-002
// section 1). Same shape as cleanupIntakeResearchRequirementsWorkflowContract.test.ts.
//
// Pinned here, from the real file: the inputs; the job runs in the environment
// named by `target` (so a production dispatch waits for the production
// environment's approval); the secrets are exactly the ones
// repair-research-baseline.yml uses; free text reaches the shell only through
// the environment. The guard step and the tool step are extracted and RUN by
// bash (npm replaced by a function that prints its arguments), the method of
// researchArchive.workflow.test.ts.
//
// WHAT THIS CANNOT SHOW. Nothing here evaluates a GitHub expression, talks to
// Azure or checks that the production environment really has a required
// reviewer. The tool's own behaviour is proved in
// redactIntakeUploadAudit.pg.test.ts.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const WORKFLOW_DIR = path.join(REPO_ROOT, '.github/workflows');
const FILE = 'redact-intake-upload-audit.yml';
const TOOL = path.join(REPO_ROOT, 'apps/web/scripts/pilot-redact-intake-upload-audit.mjs');
const GUARD_STEP = 'Confirm Explicit Target And Apply Intent';
const TOOL_STEP = 'Redact Intake Upload Audit Rows';
const PHRASE = 'REDACT INTAKE UPLOAD AUDIT ROWS';
const FINGERPRINT = `sha256:${'a'.repeat(64)}`;

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
  return bash(runScript(GUARD_STEP), {
    TARGET: 'production', CONFIRM_TARGET: 'production', ORGANIZATION: 'punxsy_prominence',
    MODE: 'dry-run', CONFIRM_REDACT: '', EXPECTED_FINGERPRINT: '', ...values,
  });
}

/** The arguments the tool step hands npm. */
function toolArgs(organization: string): string[] {
  const stub = 'npm() { printf \'NPM_ARG:%s\\n\' "$@"; }\n';
  const run = bash(`set -o pipefail\n${stub}${runScript(TOOL_STEP)}`, { ORGANIZATION: organization });
  if (run.status !== 0) throw new Error(run.output);
  return run.stdout.filter((line) => line.startsWith('NPM_ARG:')).map((line) => line.slice('NPM_ARG:'.length));
}

describe(`${FILE}: what a dispatch can ask for`, () => {
  const text = readWorkflow(FILE);

  test('dispatch only, with the six inputs and their types', () => {
    expect(text).toMatch(/^on:\n {2}workflow_dispatch:\n {4}inputs:\n/m);
    expect(text).not.toMatch(/^\s+(schedule|push|pull_request|workflow_run):/m);
    const inputs = [...text.matchAll(/^ {6}([a-z_]+):\n {8}description:/gm)].map((m) => m[1]);
    expect(inputs).toEqual(['target', 'confirm_target', 'organization', 'mode', 'confirm_redact', 'expected_fingerprint']);
    expect(text).toContain('      target:\n        description: Database environment\n        required: true\n        type: choice\n        options:\n          - staging\n          - production\n');
    expect(text).toContain('      organization:\n        description: An organization_id, or ALL_ORGANIZATIONS for every organization\n        required: true\n        type: string\n');
    expect(text).toContain('      mode:\n        description: Report the rows (dry run), or redact them\n        required: true\n        default: dry-run\n        type: choice\n        options:\n          - dry-run\n          - apply\n');
  });

  test('one job, in the environment named by target: a production dispatch waits for that environment', () => {
    expect([...text.matchAll(/^ {2}([a-z-]+):\n {4}environment:/gm)].map((m) => m[1])).toEqual(['redact']);
    expect(text).toContain('    environment: ${{ inputs.target }}\n');
    expect(text).toContain('  group: redact-intake-upload-audit-${{ inputs.target }}\n  cancel-in-progress: false\n');
    expect(text).toContain("      PPBF_INTAKE_AUDIT_REDACT_APPLY: ${{ inputs.mode == 'apply' }}\n");
  });

  test('the secrets are exactly the ones repair-research-baseline.yml reads; none invented', () => {
    const secrets = (file: string) => [...new Set([...readWorkflow(file).matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]))].sort();
    expect(secrets(FILE)).toEqual(['AZURE_CLIENT_ID', 'AZURE_PRODUCTION_RESOURCE_GROUP', 'AZURE_SUBSCRIPTION_ID', 'AZURE_TENANT_ID']);
    expect(secrets(FILE)).toEqual(secrets('repair-research-baseline.yml'));
  });

  test('no input is interpolated into a run block', () => {
    const runBodies = text.split('\n').reduce<{ inRun: boolean; lines: string[] }>((acc, line) => {
      if (/^ {8}run: \|/.test(line)) return { inRun: true, lines: acc.lines };
      if (acc.inRun && line.trim() !== '' && !line.startsWith('          ')) return { inRun: false, lines: acc.lines };
      if (acc.inRun) acc.lines.push(line);
      return acc;
    }, { inRun: false, lines: [] }).lines;
    expect(runBodies.length).toBeGreaterThan(20);
    expect(runBodies.filter((line) => line.includes('${{'))).toEqual([]);
    // A one-line `run:` is a run block too.
    expect(text.split('\n').filter((line) => /^\s+run: (?!\|).*\$\{\{/.test(line))).toEqual([]);
  });

  test('the tool step runs under bash with pipefail, so a refused run fails the job through tee', () => {
    expect(stepText(TOOL_STEP)).toContain('        shell: bash\n');
    expect(stepText(TOOL_STEP)).toMatch(/\| tee -a \/tmp\/tool-output\.txt$/m);
  });

  test('the phrase and the environment names agree with the tool', () => {
    const tool = fs.readFileSync(TOOL, 'utf8');
    expect(tool).toContain(`export const CONFIRM_PHRASE = '${PHRASE}';`);
    for (const name of ['PPBF_INTAKE_AUDIT_REDACT_APPLY', 'PPBF_INTAKE_AUDIT_REDACT_CONFIRM', 'PPBF_INTAKE_AUDIT_REDACT_EXPECT_FINGERPRINT']) {
      expect(tool).toContain(`env.${name}`);
      expect(text).toContain(`      ${name}: `);
    }
    expect(stepText(TOOL_STEP)).toContain('          PPBF_INTAKE_AUDIT_REDACT_CONFIRM: ${{ inputs.confirm_redact }}\n');
    expect(stepText(TOOL_STEP)).toContain('          PPBF_INTAKE_AUDIT_REDACT_EXPECT_FINGERPRINT: ${{ inputs.expected_fingerprint }}\n');
  });
});

describe(`${FILE}: the guard step, run`, () => {
  test('a dry run with a matching target passes', () => {
    expect(guard({}).status).toBe(0);
  });

  test('apply with the phrase and a well-formed fingerprint passes', () => {
    expect(guard({ MODE: 'apply', CONFIRM_REDACT: PHRASE, EXPECTED_FINGERPRINT: FINGERPRINT }).status).toBe(0);
  });

  test.each([
    ['a retyped target that differs', { CONFIRM_TARGET: 'staging' }, 'confirm_target does not match'],
    ['an empty organization', { ORGANIZATION: '' }, 'organization must be'],
    ['an organization that reads as a flag', { ORGANIZATION: '--all-organizations' }, 'organization must be'],
    ['apply without the phrase', { MODE: 'apply', EXPECTED_FINGERPRINT: FINGERPRINT }, 'confirm_redact set to'],
    ['apply with the phrase in lower case', { MODE: 'apply', CONFIRM_REDACT: PHRASE.toLowerCase(), EXPECTED_FINGERPRINT: FINGERPRINT }, 'confirm_redact set to'],
    ['apply without a fingerprint', { MODE: 'apply', CONFIRM_REDACT: PHRASE }, 'expected_fingerprint set to'],
    ['apply with a short fingerprint', { MODE: 'apply', CONFIRM_REDACT: PHRASE, EXPECTED_FINGERPRINT: 'sha256:abc' }, 'expected_fingerprint set to'],
  ])('refuses %s', (_label, values, message) => {
    const run = guard(values as Record<string, string>);
    expect(run.status).toBe(1);
    expect(run.output).toContain(message);
  });
});

describe(`${FILE}: the tool step, run`, () => {
  test('the npm script it calls exists and runs this tool', () => {
    const scripts = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'apps/web/package.json'), 'utf8')).scripts as Record<string, string>;
    expect(scripts['pilot:redact-intake-upload-audit']).toBe('node scripts/pilot-redact-intake-upload-audit.mjs');
  });

  test('ALL_ORGANIZATIONS becomes --all-organizations', () => {
    expect(toolArgs('ALL_ORGANIZATIONS')).toEqual(['run', 'pilot:redact-intake-upload-audit', '--', '--all-organizations']);
  });

  test('an organization id is passed as one argument, never parsed by the shell', () => {
    expect(toolArgs('punxsy_prominence')).toEqual(['run', 'pilot:redact-intake-upload-audit', '--', '--organization', 'punxsy_prominence']);
    expect(toolArgs('a b; echo PWNED')).toEqual(['run', 'pilot:redact-intake-upload-audit', '--', '--organization', 'a b; echo PWNED']);
  });
});
