import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * PR-2b of the Azure-hosted database runners (lane DBT, OD-2026-11-17-008): the launch script,
 * its action, the pilot switch in session-token-cleanup.yml and the negative control
 * runner-guard-check.yml. resources.sh is held to its own tests in azureRunnerResources.test.ts.
 *
 * What these tests hold it to:
 *   - the launch reads the key from the vault only, narrows the installation token, registers the
 *     runner with its one label, starts the execution with the pinned digest through a 0600 file
 *     that is gone afterwards, waits for the runner, and revokes the token on every path;
 *   - on any failure after registration, a thrown error included, it removes the runner and
 *     stops an execution that started;
 *   - no key, JWT, token or JIT configuration reaches the log outside an add-mask line;
 *   - the pilot stays on GitHub's runner unless the variable is 'true' and the run is from main,
 *     and no workflow that launches a runner takes a pull-request trigger.
 * METHOD: the launch runs against fake GitHub and fake az (injected; no az process is spawned);
 * workflows are read as text. None of it proves Azure or GitHub accept these calls;
 * runner-guard-check and the pilot do (infra/gh-runner/README.md, "Switching a workflow over").
 */

const root = path.resolve(__dirname, '../../../../..');
const launchPath = path.join(root, 'scripts/azure-runner-launch.mjs');
const confPath = path.join(root, 'infra/gh-runner/azure-runner.conf');
const resourcesPath = path.join(root, 'infra/gh-runner/resources.sh');
const workflows = path.join(root, '.github/workflows');
const posix = (p: string) => p.replace(/\\/g, '/');
const read = (p: string) => fs.readFileSync(p, 'utf8');

const TOKEN = `ghs_${'T0k3n'.repeat(8)}`;
const JIT = `JITCONFIG${'Q1'.repeat(40)}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-runner-launch-test-'));

// A harness that imports the script and runs launch() against fakes described by SCENARIO.
const harness = path.join(tmp, 'harness.mjs');
fs.writeFileSync(harness, `
import crypto from 'node:crypto';
import fs from 'node:fs';
import * as m from ${JSON.stringify(pathToFileURL(launchPath).href)};
const sc = JSON.parse(process.env.SCENARIO);
const TOKEN = ${JSON.stringify(TOKEN)}, JIT = ${JSON.stringify(JIT)};
const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = pair.privateKey.export({ type: sc.keyType || 'pkcs1', format: 'pem' });
const nobreaks = pem.replace(/\\n(?!-----)/g, '').replace(/KEY-----/, 'KEY-----\\n');
const keyText = sc.keyForm === 'garbage' ? 'not a key at all' : sc.keyForm === 'spaces' ? pem.replace(/\\n/g, ' ')
  : sc.keyForm === 'nobreaks' ? nobreaks : pem;
const keyBody = pem.split('\\n')[1];
const calls = [], logs = [];
let t = 1700000000000, polls = 0, file = null;
const respond = (status, json) => ({ status, text: async () => (json === undefined ? '' : JSON.stringify(json)) });
const fetchFn = async (url, init) => {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ kind: 'http', method: init.method, path: u.pathname, auth: init.headers.authorization, body });
  if (u.pathname.endsWith('/access_tokens')) {
    return (sc.tokenStatus || 201) === 201 ? respond(201, { token: TOKEN }) : respond(sc.tokenStatus, { message: 'Bad credentials' });
  }
  if (u.pathname.endsWith('/generate-jitconfig')) {
    const labels = [...(sc.readOnly || []).map((n) => ({ name: n, type: 'read-only' })), { name: body.labels[0], type: 'custom' },
      ...(sc.extraCustom || []).map((n) => ({ name: n, type: 'custom' }))];
    return respond(sc.jitStatus || 201, { runner: { id: 42, name: body.name, labels }, encoded_jit_config: JIT });
  }
  if (init.method === 'GET' && u.pathname.endsWith('/runners/42')) {
    polls += 1;
    if (polls <= (sc.pollThrows || 0)) throw new TypeError('fetch failed');
    return respond(200, { id: 42, status: sc.onlineAfter >= 0 && polls > sc.onlineAfter ? 'online' : 'offline', busy: false });
  }
  if (init.method === 'DELETE') return respond(204);
  return respond(404, { message: 'not found' });
};
const execFile = (cmd, args, opts, cb) => {
  calls.push({ kind: 'az', cmd, args, onlyErrors: opts.env.AZURE_CORE_ONLY_SHOW_ERRORS });
  const a = args.join(' ');
  if (a.startsWith('keyvault secret show')) return sc.keyCode ? cb({ code: sc.keyCode }, '', 'Forbidden: caller lacks getSecret') : cb(null, keyText, '');
  if (a.startsWith('containerapp job start')) {
    if (sc.startThrows) throw new Error('spawn az EACCES');
    const f = args[args.indexOf('--yaml') + 1];
    file = { path: f, text: fs.readFileSync(f, 'utf8'), mode: fs.statSync(f).mode & 0o777 };
    return sc.startCode ? cb({ code: sc.startCode }, '', 'BadRequest for template with ' + JIT) : cb(null, 'caj-ppbf-gh-runner-x1y2z3\\n', '');
  }
  if (a.startsWith('containerapp job execution show')) return cb(null, 'Running\\n', '');
  if (a.startsWith('containerapp job stop')) return cb(null, '', '');
  return cb({ code: 9 }, '', 'unexpected call');
};
let out;
try {
  const result = await m.launch({
    env: { PPBF_RUNNER_APP_ID: '123456', PPBF_RUNNER_INSTALLATION_ID: '987654', GITHUB_REPOSITORY: 'PunxsyProminence/ppbf-platform',
      GITHUB_RUN_ID: '555', GITHUB_RUN_ATTEMPT: '2', ...(sc.env || {}) },
    fetch: fetchFn, execFile, tmpdir: fs.mkdtempSync(${JSON.stringify(posix(tmp))} + '/run-'),
    now: () => t, sleep: async (ms) => { t += ms; }, randomBytes: (n) => Buffer.alloc(n, 0xab),
    log: (line) => { logs.push(line); },
  });
  out = { ok: true, result };
} catch (err) {
  out = { ok: false, error: String(err && err.message), kind: err && err.constructor && err.constructor.name };
}
const jwtCall = calls.find((c) => c.kind === 'http' && c.path.endsWith('/access_tokens'));
let jwt = null;
if (jwtCall) {
  const [h, p, s] = jwtCall.auth.replace('Bearer ', '').split('.');
  jwt = { valid: crypto.verify('sha256', Buffer.from(h + '.' + p), pair.publicKey, Buffer.from(s, 'base64url')),
    header: JSON.parse(Buffer.from(h, 'base64url')), payload: JSON.parse(Buffer.from(p, 'base64url')), raw: h + '.' + p + '.' + s };
}
console.log(JSON.stringify({ ...out, calls, logs, file: file && { ...file, existsAfter: fs.existsSync(file.path) }, jwt, keyBody }));
`);

interface Call { kind: 'http' | 'az'; method?: string; path?: string; auth?: string; body?: Record<string, unknown>; args?: string[]; onlyErrors?: string }
interface Run {
  ok: boolean; error?: string; kind?: string;
  result?: { label: string; runnerId: number; execution: string; runsOn: string };
  calls: Call[]; logs: string[]; keyBody: string;
  file: { path: string; text: string; mode: number; existsAfter: boolean } | null;
  jwt: { valid: boolean; header: Record<string, unknown>; payload: Record<string, unknown>; raw: string } | null;
}
function launch(scenario: Record<string, unknown>): Run {
  const r = spawnSync(process.execPath, [harness], { encoding: 'utf8', env: { ...process.env, SCENARIO: JSON.stringify(scenario) } });
  if (r.status !== 0) throw new Error(`harness failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as Run;
}
const http = (run: Run, method: string, suffix: string) => run.calls.filter((c) => c.kind === 'http' && c.method === method && (c.path ?? '').endsWith(suffix));
const az = (run: Run, prefix: string) => run.calls.filter((c) => c.kind === 'az' && (c.args ?? []).join(' ').startsWith(prefix));
/** Every secret the run handled appears only in add-mask lines. */
function expectNoSecretInLogs(run: Run) {
  const secrets = [TOKEN, JIT, run.keyBody, ...(run.jwt ? [run.jwt.raw] : [])];
  for (const line of run.logs.filter((l) => !l.startsWith('::add-mask::'))) {
    for (const s of secrets) expect(line.includes(s)).toBe(false);
  }
  if (run.error) for (const s of secrets) expect(run.error.includes(s)).toBe(false);
}

describe('azure-runner-launch.mjs, the happy path', () => {
  const run = launch({ onlineAfter: 2 });

  it('reads the key from the vault named in azure-runner.conf, with az warnings off', () => {
    expect(run.ok).toBe(true);
    const [kv] = az(run, 'keyvault secret show');
    expect(kv.args).toEqual(['keyvault', 'secret', 'show', '--vault-name', 'kv-ppbf-gh-runner', '--name', 'github-app-private-key', '--query', 'value', '-o', 'tsv']);
    expect(kv.onlyErrors).toBe('true');
  });

  it('signs a valid RS256 App JWT: issued 60 s back, 9 minutes long, numeric App ID as issuer', () => {
    expect(run.jwt?.valid).toBe(true);
    expect(run.jwt?.header).toEqual({ alg: 'RS256', typ: 'JWT' });
    const p = run.jwt?.payload as { iat: number; exp: number; iss: unknown };
    expect(p.exp - p.iat).toBe(600);
    expect(p.iss).toBe(123456);
  });

  it('narrows the installation token to this repository and administration: write', () => {
    const [tok] = http(run, 'POST', '/app/installations/987654/access_tokens');
    expect(tok.body).toEqual({ repositories: ['ppbf-platform'], permissions: { administration: 'write' } });
  });

  it('registers one JIT runner whose only label is its own unguessable name', () => {
    const [jit] = http(run, 'POST', '/repos/PunxsyProminence/ppbf-platform/actions/runners/generate-jitconfig');
    const label = `ppbf-db-555-2-${'ab'.repeat(8)}`;
    expect(jit.body).toEqual({ name: label, runner_group_id: 1, labels: [label], work_folder: '_work' });
    expect(jit.auth).toBe(`Bearer ${TOKEN}`);
    expect(run.result).toEqual({ label, runnerId: 42, execution: 'caj-ppbf-gh-runner-x1y2z3', runsOn: JSON.stringify([label]) });
  });

  it('starts the execution from a 0600 file holding the pinned digest, cpu, memory and the JIT config, and deletes it', () => {
    const [start] = az(run, 'containerapp job start');
    expect(start.args?.slice(0, 7)).toEqual(['containerapp', 'job', 'start', '--name', 'caj-ppbf-gh-runner', '--resource-group', 'rg-ppbf-enterprise-staging']);
    expect(start.args?.join(' ')).not.toContain(JIT);
    const image = /^IMAGE=(.+)$/m.exec(read(confPath))?.[1];
    expect(JSON.parse(run.file?.text ?? '')).toEqual({
      containers: [{ name: 'runner', image, resources: { cpu: 2, memory: '4Gi' }, env: [{ name: 'JIT_CONFIG', value: JIT }] }],
    });
    if (process.platform !== 'win32') expect(run.file?.mode).toBe(0o600);
    expect(run.file?.existsAfter).toBe(false);
  });

  it('waits until the runner is online, then revokes the token', () => {
    expect(http(run, 'GET', '/actions/runners/42')).toHaveLength(3);
    const revoke = http(run, 'DELETE', '/installation/token');
    expect(revoke).toHaveLength(1);
    expect(revoke[0].auth).toBe(`Bearer ${TOKEN}`);
    expect(http(run, 'DELETE', '/actions/runners/42')).toHaveLength(0);
  });

  it('masks the key, the JWT, the token and the JIT config, and prints none of them', () => {
    const masks = run.logs.filter((l) => l.startsWith('::add-mask::')).map((l) => l.slice(12));
    expect(masks).toEqual(expect.arrayContaining([TOKEN, JIT, run.keyBody, run.jwt?.raw]));
    expectNoSecretInLogs(run);
  });
});

describe('azure-runner-launch.mjs, the key and the JWT', () => {
  it('accepts the key with its line breaks turned into spaces (a portal paste), and a PKCS#8 key', () => {
    for (const run of [launch({ onlineAfter: 0, keyForm: 'spaces' }), launch({ onlineAfter: 0, keyType: 'pkcs8' })]) {
      expect(run.ok).toBe(true);
      expect(run.jwt?.valid).toBe(true);
    }
  });

  it('a key pasted with no line breaks at all is still masked, in 64-character pieces', () => {
    const run = launch({ onlineAfter: 0, keyForm: 'nobreaks' });
    expect(run.ok).toBe(true);
    expect(run.logs).toContain(`::add-mask::${run.keyBody}`);
    expectNoSecretInLogs(run);
  });

  it('refuses a vault value that is not a key, says so plainly, and calls GitHub not at all', () => {
    const run = launch({ onlineAfter: 0, keyForm: 'garbage' });
    expect(run).toMatchObject({ ok: false, kind: 'LaunchError', error: 'the Key Vault secret is not a PEM private key' });
    expect(run.calls.filter((c) => c.kind === 'http')).toHaveLength(0);
  });

  it('uses a client ID as a string issuer', () => {
    const run = launch({ onlineAfter: 0, env: { PPBF_RUNNER_APP_ID: 'Iv23liAbCdEf' } });
    expect(run.jwt?.payload.iss).toBe('Iv23liAbCdEf');
  });
});

describe('azure-runner-launch.mjs, failures', () => {
  it('a vault read failure is reported with az\'s message and stops before GitHub', () => {
    const run = launch({ onlineAfter: 0, keyCode: 1 });
    expect(run.ok).toBe(false);
    expect(run.error).toBe('reading the GitHub App key from Key Vault kv-ppbf-gh-runner (az exit 1): Forbidden: caller lacks getSecret');
    expect(run.calls.filter((c) => c.kind === 'http')).toHaveLength(0);
  });

  it('a refused installation token stops before any runner exists', () => {
    const run = launch({ onlineAfter: 0, tokenStatus: 401 });
    expect(run.error).toBe('GitHub installation token returned HTTP 401: Bad credentials');
    expect(http(run, 'POST', '/generate-jitconfig')).toHaveLength(0);
    expect(az(run, 'containerapp')).toHaveLength(0);
  });

  it('a runner registered with any other custom label is removed and the launch fails', () => {
    const run = launch({ onlineAfter: 0, extraCustom: ['self-hosted-extra'] });
    expect(run.error).toBe('the runner was registered with labels other than its own; removed it');
    expect(http(run, 'DELETE', '/actions/runners/42')).toHaveLength(1);
    expect(az(run, 'containerapp job start')).toHaveLength(0);
    expect(http(run, 'DELETE', '/installation/token')).toHaveLength(1);
  });

  it('GitHub\'s read-only default labels are reported, not refused (the guard covers them)', () => {
    const run = launch({ onlineAfter: 0, readOnly: ['self-hosted', 'Linux', 'X64'] });
    expect(run.ok).toBe(true);
    expect(run.logs.join('\n')).toMatch(/labels: self-hosted, Linux, X64, ppbf-db-555-2-/);
  });

  it('a failed start removes the runner, deletes the file, and redacts the JIT config from az\'s message', () => {
    const run = launch({ onlineAfter: 0, startCode: 1 });
    expect(run.ok).toBe(false);
    expect(run.error).toBe('starting Container Apps job caj-ppbf-gh-runner (az exit 1): BadRequest for template with ***');
    expect(http(run, 'DELETE', '/actions/runners/42')).toHaveLength(1);
    expect(run.file?.existsAfter).toBe(false);
    expect(http(run, 'DELETE', '/installation/token')).toHaveLength(1);
    expectNoSecretInLogs(run);
  });

  it('a runner that never comes online: status read, runner removed, execution stopped, token revoked', () => {
    const run = launch({ onlineAfter: -1 });
    expect(run.error).toBe(`runner ppbf-db-555-2-${'ab'.repeat(8)} was not online within 480 s (execution caj-ppbf-gh-runner-x1y2z3: Running)`);
    expect(http(run, 'GET', '/actions/runners/42').length).toBe(97);
    expect(az(run, 'containerapp job execution show')).toHaveLength(1);
    expect(http(run, 'DELETE', '/actions/runners/42')).toHaveLength(1);
    expect(az(run, 'containerapp job stop')[0].args).toContain('caj-ppbf-gh-runner-x1y2z3');
    expect(http(run, 'DELETE', '/installation/token')).toHaveLength(1);
    expectNoSecretInLogs(run);
  });

  it('network errors while waiting count as "not online yet"; the launch still succeeds and says how long it took', () => {
    const run = launch({ onlineAfter: 0, pollThrows: 3 });
    expect(run.ok).toBe(true);
    expect(http(run, 'GET', '/actions/runners/42')).toHaveLength(4);
    expect(run.logs).toContain('azure-runner-launch: runner online 15 s after the execution started.');
    expect(http(run, 'DELETE', '/actions/runners/42')).toHaveLength(0);
  });

  it('a network error on every status read ends as a timeout, with the same cleanup', () => {
    const run = launch({ onlineAfter: 0, pollThrows: 1000 });
    expect(run.error).toMatch(/was not online within 480 s/);
    expect(http(run, 'DELETE', '/actions/runners/42')).toHaveLength(1);
    expect(az(run, 'containerapp job stop')).toHaveLength(1);
  });

  it('a thrown error after registration still removes the runner and revokes the token, and stops nothing that never started', () => {
    const run = launch({ onlineAfter: 0, startThrows: true });
    expect(run).toMatchObject({ ok: false, error: 'spawn az EACCES' });
    expect(http(run, 'DELETE', '/actions/runners/42')).toHaveLength(1);
    expect(az(run, 'containerapp job stop')).toHaveLength(0);
    expect(http(run, 'DELETE', '/installation/token')).toHaveLength(1);
    expect(fs.readdirSync(tmp).filter((d) => d.startsWith('run-')).every((d) => fs.readdirSync(path.join(tmp, d)).length === 0)).toBe(true);
  });

  it('missing repository variables fail before anything is called', () => {
    for (const env of [{ PPBF_RUNNER_APP_ID: '' }, { PPBF_RUNNER_INSTALLATION_ID: '12a' }, { GITHUB_RUN_ID: '' }]) {
      const run = launch({ onlineAfter: 0, env });
      expect(run).toMatchObject({ ok: false, kind: 'LaunchError' });
      expect(run.calls).toHaveLength(0);
    }
  });

  it('as a command, prints one ::error:: line and exits 1', () => {
    // An empty AZURE_CONFIG_DIR: even if it got as far as az, there would be no login to use.
    const r = spawnSync(process.execPath, [launchPath], {
      encoding: 'utf8',
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', AZURE_CONFIG_DIR: fs.mkdtempSync(path.join(tmp, 'azure-config-cli-')) },
    });
    expect(r.status).toBe(1);
    expect(r.stdout.trim()).toBe('::error::azure-runner-launch: app-id (repository variable PPBF_RUNNER_APP_ID) is missing or malformed');
  });
});

describe('azure-runner.conf', () => {
  const inModule = (body: string) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import * as m from ${JSON.stringify(pathToFileURL(launchPath).href)};\n${body}`], { encoding: 'utf8' });
    return JSON.parse(r.stdout) as unknown;
  };
  const conf = read(confPath);

  it('pins the image by digest in the registry, and is the only file that names a digest', () => {
    expect(conf).toMatch(/^IMAGE=acrppbfenterprise\.azurecr\.io\/ppbf-gh-runner@sha256:[0-9a-f]{64}$/m);
    for (const p of [launchPath, resourcesPath, path.join(root, '.github/actions/azure-runner-launch/action.yml')]) {
      expect(read(p)).not.toMatch(/sha256:[0-9a-f]{64}/);
    }
  });

  it('the parser takes plain KEY=value only: a tag, a duplicate, a shell value or a missing key is refused', () => {
    const cases = [
      conf,
      conf.replace(/@sha256:[0-9a-f]{64}/, ':latest'),
      `${conf}\nJOB_NAME=other\n`,
      conf.replace('CPU=2', 'CPU=$(id)'),
      conf.replace(/^KEY_VAULT_NAME=.*$/m, ''),
    ];
    const r = inModule(`console.log(JSON.stringify(${JSON.stringify(cases)}.map((t) => { try { return m.parseConfig(t).JOB_NAME; } catch (e) { return e.message; } })));`);
    expect(r).toEqual([
      'caj-ppbf-gh-runner',
      'azure-runner.conf IMAGE must be in REGISTRY_SERVER and pinned by digest (@sha256:...)',
      'azure-runner.conf sets JOB_NAME twice',
      expect.stringMatching(/^azure-runner.conf line \d+ is not KEY=value with a plain value$/),
      'azure-runner.conf is missing KEY_VAULT_NAME',
    ]);
  });
});

describe('the workflows', () => {
  const pilot = read(path.join(workflows, 'session-token-cleanup.yml'));
  const check = read(path.join(workflows, 'runner-guard-check.yml'));
  const allowed = read(path.join(root, 'infra/gh-runner/allowed-jobs.txt'));

  it('the pilot goes to Azure only when PPBF_AZURE_DB_RUNNER is true and the run is from main', () => {
    expect(pilot).toContain('SWITCH: ${{ vars.PPBF_AZURE_DB_RUNNER }}');
    expect(pilot).toContain('if [ "${SWITCH,,}" = "true" ] && [ "$GITHUB_REF" = "refs/heads/main" ]; then');
    // The last job in the file (below `sweep`, see the comment there).
    const launchJob = /\n {2}launch:\n([\s\S]*)$/.exec(pilot)?.[1] ?? '';
    expect(launchJob).not.toMatch(/\n {2}[a-z-]+:\n/);
    const gated = launchJob.split(/\n {6}- name: /).slice(2);
    expect(gated).toHaveLength(4);
    for (const step of gated) expect(step).toContain("if: steps.route.outputs.azure == 'true'");
    expect(launchJob).toContain(`runs-on: \${{ steps.azure.outputs.runs-on || '"ubuntu-latest"' }}`);
    expect(launchJob).toContain('uses: ./.github/actions/azure-runner-launch');
    // Fails closed if a launch reports success but names no runner.
    expect(launchJob).toMatch(/- name: Check A Runner Was Named\n {8}if: steps\.route\.outputs\.azure == 'true'\n {8}env:\n {10}RUNS_ON: \$\{\{ steps\.azure\.outputs\.runs-on \}\}\n {8}run: test -n "\$RUNS_ON"\n/);
  });

  it('sweep keeps its job id and steps, and takes its runner from launch', () => {
    expect(pilot).toMatch(/\n {2}sweep:\n {4}needs: launch\n {4}runs-on: \$\{\{ fromJSON\(needs\.launch\.outputs\.runs-on\) \}\}\n/);
    expect(allowed.split('\n')).toContain('session-token-cleanup.yml:sweep');
    expect(pilot).not.toMatch(/^\s+environment:/m);
  });

  it('the pilot never takes a pull-request trigger (Overwatch 2026-11-18, condition b)', () => {
    expect(pilot).not.toMatch(/pull_request/);
    const on = /\non:\n((?: {2}.*\n|\s*\n)*)/.exec(pilot)?.[1] ?? '';
    expect([...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]).sort()).toEqual(['schedule', 'workflow_dispatch']);
  });

  it('every workflow that launches an Azure runner runs only on workflow_dispatch or schedule, never on a pull request', () => {
    const launching = fs.readdirSync(workflows).filter((f) => /\.ya?ml$/.test(f) && read(path.join(workflows, f)).includes('azure-runner-launch'));
    expect(launching).toEqual(expect.arrayContaining(['runner-guard-check.yml', 'session-token-cleanup.yml']));
    for (const file of launching) {
      const text = read(path.join(workflows, file));
      expect({ file, pr: /pull_request|pull_request_target/.test(text) }).toEqual({ file, pr: false });
      const on = /\non:\n((?: {2}.*\n|\s*\n)*)/.exec(text)?.[1] ?? '';
      const triggers = [...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
      expect(triggers.length).toBeGreaterThan(0);
      expect({ file, other: triggers.filter((t) => t !== 'workflow_dispatch' && t !== 'schedule') }).toEqual({ file, other: [] });
    }
  });

  it('runner-guard-check: dispatch only, from main only, and its job is NOT on the guard allowlist', () => {
    expect(check).toMatch(/\non:\n {2}workflow_dispatch:\n\n/);
    expect(check).toContain('if [ "$GITHUB_REF" != "refs/heads/main" ]; then');
    expect(check).toMatch(/\n {2}refused:\n {4}needs: launch\n {4}runs-on: \$\{\{ fromJSON\(needs\.launch\.outputs\.runs-on\) \}\}\n {4}timeout-minutes: 5\n(?: {4}#.*\n)* {4}permissions: \{\}\n/);
    expect(check).toMatch(/if: always\(\)\n\s+run: echo "PPBF-GUARD-MARKER/);
    expect(allowed).not.toContain('runner-guard-check');
  });

  it('the launch action runs the script from the checked-out workspace and passes only the two IDs', () => {
    const action = read(path.join(root, '.github/actions/azure-runner-launch/action.yml'));
    expect(action).toContain('run: node "$GITHUB_WORKSPACE/scripts/azure-runner-launch.mjs"');
    expect(action.match(/\$\{\{ inputs\.[a-z-]+ \}\}/g)).toEqual(['${{ inputs.app-id }}', '${{ inputs.installation-id }}']);
    expect(action).not.toMatch(/secrets\./);
  });
});
