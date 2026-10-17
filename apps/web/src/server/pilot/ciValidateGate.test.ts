import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * `validate` -- the one required check -- passes only when every part of ci.yml
 * that this diff needs passed (lane L38).
 *
 * WHY THIS EXISTS. ci.yml runs its gates as parallel jobs and `validate` only
 * judges them, through scripts/ci-validate-gate.mjs. A gate that passed a part
 * which never ran would make "validate is green" mean nothing, and GitHub will
 * not catch it: a skipped job reports as passing. So the table below is the
 * gate's contract, run through the real command line exactly as ci.yml runs
 * it, and the last block checks that ci.yml is wired to it.
 */

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const gate = path.join(repositoryRoot, 'scripts/ci-validate-gate.mjs');
const workflowPath = path.join(repositoryRoot, '.github/workflows/ci.yml');

type Result = 'success' | 'failure' | 'cancelled' | 'skipped';

const E2E_FLAGS = [
  'board_e2e',
  'homepage_e2e',
  'coach_e2e',
  'athlete_e2e',
  'guardian_e2e',
  'activation_e2e',
  'admin_narrow_e2e',
];

/** classify's outputs, as GitHub passes them: strings. */
function flags(set: Record<string, boolean> = {}): Record<string, string> {
  const out: Record<string, string> = { docs_only: 'false', migrations: 'false', unknown_code: 'false' };
  for (const name of E2E_FLAGS) out[name] = 'false';
  for (const [name, value] of Object.entries(set)) out[name] = String(value);
  return out;
}

function needs(
  outputs: Record<string, string>,
  results: Partial<Record<'classify' | 'static' | 'unit' | 'pg' | 'e2e', Result>>,
): Record<string, unknown> {
  const all = { classify: 'success', static: 'success', unit: 'success', pg: 'success', e2e: 'success', ...results };
  return Object.fromEntries(
    Object.entries(all).map(([name, result]) => [
      name,
      { result, outputs: name === 'classify' ? outputs : {} },
    ]),
  );
}

/** Run the gate the way ci.yml does; return its exit status and output. */
function runGate(input: unknown): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [gate], {
      encoding: 'utf8',
      env: { ...process.env, NEEDS: typeof input === 'string' ? input : JSON.stringify(input), GITHUB_STEP_SUMMARY: '' },
    });
    return { status: 0, output };
  } catch (error) {
    const failed = error as { status: number; stdout: string };
    return { status: failed.status, output: failed.stdout };
  }
}

describe('the validate gate passes exactly the runs where everything needed passed', () => {
  it.each([
    ['a code PR that needs every part', flags({ migrations: true, coach_e2e: true }), {}],
    ['a code PR with no migration surface', flags({ coach_e2e: true }), { pg: 'skipped' as Result }],
    ['a code PR with no browser surface', flags({ migrations: true }), { e2e: 'skipped' as Result }],
    ['a code PR that needs neither', flags(), { pg: 'skipped' as Result, e2e: 'skipped' as Result }],
    [
      'a documentation-only change',
      flags({ docs_only: true }),
      { static: 'skipped' as Result, unit: 'skipped' as Result, pg: 'skipped' as Result, e2e: 'skipped' as Result },
    ],
  ])('green: %s', (_label, outputs, results) => {
    const { status, output } = runGate(needs(outputs, results));

    expect(output).not.toContain('FAIL');
    expect(output.trim().split('\n').pop()).toBe('validate: GREEN');
    expect(status).toBe(0);
  });

  it.each([
    ['a part failed', flags({ migrations: true }), { pg: 'failure' as Result, e2e: 'skipped' as Result }, 'pg: result failure'],
    ['a part was cancelled (a timeout, a superseded run)', flags(), { unit: 'cancelled' as Result, pg: 'skipped' as Result, e2e: 'skipped' as Result }, 'unit: result cancelled'],
    ['pg skipped although migrations is true', flags({ migrations: true }), { pg: 'skipped' as Result, e2e: 'skipped' as Result }, 'pg: result skipped, expected success'],
    ['e2e skipped although a journey flag is true', flags({ athlete_e2e: true }), { pg: 'skipped' as Result, e2e: 'skipped' as Result }, 'e2e: result skipped, expected success'],
    ['static skipped on a code change', flags(), { static: 'skipped' as Result, pg: 'skipped' as Result, e2e: 'skipped' as Result }, 'static: result skipped, expected success'],
    ['a part ran on a docs-only change', flags({ docs_only: true }), { unit: 'skipped' as Result, pg: 'skipped' as Result, e2e: 'skipped' as Result }, 'static: result success, expected skipped'],
    ['classify failed', flags(), { classify: 'failure' as Result, static: 'skipped' as Result, unit: 'skipped' as Result, pg: 'skipped' as Result, e2e: 'skipped' as Result }, 'classify: result failure'],
    ['classify was cancelled', flags(), { classify: 'cancelled' as Result }, 'classify: result cancelled'],
  ])('red: %s', (_label, outputs, results, reason) => {
    const { status, output } = runGate(needs(outputs, results));

    expect(output).toContain(`FAIL ${reason}`);
    expect(output.trim().split('\n').pop()).toBe('validate: RED');
    expect(status).toBe(1);
  });

  it('red when a flag is missing or not exactly true/false', () => {
    const missing = flags();
    delete missing.migrations;
    expect(runGate(needs(missing, { pg: 'skipped', e2e: 'skipped' })).output).toContain('FAIL classify: output migrations missing');

    // An empty output is what a step that never wrote its flags leaves behind.
    expect(runGate(needs(flags({ docs_only: '' as unknown as boolean }), {})).status).toBe(1);
    expect(runGate(needs({ docs_only: 'false', migrations: 'false' }, {})).output).toContain('no *_e2e outputs');
  });

  it('red on a needs entry it does not know, and on a part missing from needs', () => {
    const extra = { ...needs(flags(), { pg: 'skipped', e2e: 'skipped' }), lint2: { result: 'success', outputs: {} } };
    expect(runGate(extra).output).toContain('FAIL lint2: a needs entry the gate does not know');

    const short = needs(flags(), { pg: 'skipped', e2e: 'skipped' });
    delete short.unit;
    expect(runGate(short).output).toContain('FAIL unit: missing from validate\'s needs');
  });

  it('red when NEEDS is absent or not JSON', () => {
    expect(runGate('').status).toBe(1);
    expect(runGate('{not json').status).toBe(1);
  });

  it('counts any *_e2e flag, so a journey added to the classifier is covered', () => {
    const outputs = { ...flags(), future_e2e: 'true' };
    const { output } = runGate(needs(outputs, { pg: 'skipped', e2e: 'skipped' }));

    expect(output).toContain('FAIL e2e: result skipped, expected success');
  });
});

/** ci.yml's jobs: name, header (everything before `steps:`), and body. */
function workflowJobs(): Map<string, { header: string; body: string }> {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const parts = workflow.slice(workflow.indexOf('\njobs:\n') + '\njobs:\n'.length).split(/^ {2}([a-z][\w-]*):\n/m);
  const jobs = new Map<string, { header: string; body: string }>();
  for (let i = 1; i < parts.length; i += 2) {
    const body = parts[i + 1];
    jobs.set(parts[i], { header: body.slice(0, body.indexOf('\n    steps:\n')), body });
  }
  return jobs;
}

describe('ci.yml is wired to the gate', () => {
  const jobs = workflowJobs();

  it('keeps one job named validate that needs every other job and always runs', () => {
    const validate = jobs.get('validate');
    expect(validate).toBeDefined();
    const needed = /(?:^|\n) {4}needs: \[([^\]]*)\]\n/.exec(validate!.header);
    expect(needed).not.toBeNull();
    const others = [...jobs.keys()].filter((name) => name !== 'validate');

    // A job left out of needs is a part the gate never sees.
    expect(needed![1].split(',').map((name) => name.trim()).sort()).toEqual([...others].sort());
    expect(validate!.header).toMatch(/\n {4}if: always\(\)\n/);
    expect(validate!.body).toContain('NEEDS: ${{ toJSON(needs) }}');
    // The exit status survives the pipe, and a run with no verdict line is red.
    expect(validate!.body).toContain('set -euo pipefail');
    expect(validate!.body).toMatch(/\n {10}node scripts\/ci-validate-gate\.mjs \| tee "\$RUNNER_TEMP\/validate-gate\.txt"\n/);
    expect(validate!.body).toMatch(/\n {10}grep -qx 'validate: GREEN' "\$RUNNER_TEMP\/validate-gate\.txt"\n/);
  });

  it('leaves no other pull-request workflow a job that could answer to `validate`', () => {
    // Branch protection matches the required check by name. Since the split,
    // ci.yml's `validate` appears only once every part has finished, so a
    // green job of the same name elsewhere -- research-bridge-ci.yml's was one,
    // done in ~40 s on any package.json PR -- could satisfy it first.
    const dir = path.dirname(workflowPath);
    const clashes = fs
      .readdirSync(dir)
      .filter((file) => /\.ya?ml$/.test(file) && file !== 'ci.yml')
      .filter((file) => {
        const text = fs.readFileSync(path.join(dir, file), 'utf8');
        const on = text.slice(text.search(/^on:/m), text.search(/^jobs:/m));
        if (!/\n {2}pull_request(_target)?:/.test(on)) return false;
        return /^ {2}validate:\s*$/m.test(text) || /^ {4}name:\s*['"]?validate['"]?\s*$/m.test(text);
      });

    expect(clashes).toEqual([]);
  });

  it('gives every E2E step the flag of the suite it runs', () => {
    // The e2e job starts on any journey flag; inside it each suite must still
    // wait for its own, or one journey's diff runs (or skips) another's suite.
    const steps = jobs.get('e2e')!.body.split(/\n {6}- name: /).slice(1);
    const suites = steps
      .map((step) => ({ step, script: /run: npm --workspace web run test:e2e:([a-z-]+)\s*\n/.exec(step) }))
      .filter((entry) => entry.script);
    expect(suites.length).toBe(E2E_FLAGS.length);

    for (const { step, script } of suites) {
      const flag = `${script![1].replace(/-/g, '_')}_e2e`;
      expect(E2E_FLAGS).toContain(flag);
      expect(step).toMatch(new RegExp(`\\n {8}if: needs\\.classify\\.outputs\\.${flag} == 'true'\\n`));
    }
  });

  it('gives every other job but classify a rule in the gate', () => {
    const script = `import { PARTS } from ${JSON.stringify(pathToFileURL(gate).href)};
      process.stdout.write(JSON.stringify(Object.keys(PARTS)));`;
    const parts: string[] = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
    const others = [...jobs.keys()].filter((name) => name !== 'validate' && name !== 'classify');

    expect([...parts].sort()).toEqual([...others].sort());
  });

  it('exposes every flag the classifier prints as a classify job output', () => {
    // The classifier's own output lines, from its command line on a real path.
    const list = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-gate-')), 'files.txt');
    fs.writeFileSync(list, 'README.md\n');
    const printed = execFileSync(process.execPath, [path.join(repositoryRoot, 'scripts/ci-classify-paths.mjs'), list], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' },
    })
      .trim()
      .split('\n')
      .map((line) => line.split('=')[0]);
    fs.rmSync(path.dirname(list), { recursive: true, force: true });

    const header = jobs.get('classify')!.header;
    for (const flag of printed) {
      expect(header).toContain(`      ${flag}: \${{ steps.changes.outputs.${flag} }}\n`);
    }
    // And the e2e job starts for every journey flag among them.
    const e2eIf = /\n {4}if: (.*)\n/.exec(jobs.get('e2e')!.header)![1];
    for (const flag of printed.filter((name) => name.endsWith('_e2e'))) {
      expect(e2eIf).toContain(`needs.classify.outputs.${flag} == 'true'`);
    }
  });
});
