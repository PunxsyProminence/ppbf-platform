#!/usr/bin/env node
/**
 * Starts ONE single-use GitHub runner inside Azure for the job that follows (lane DBT,
 * OD-2026-11-17-008). Run by .github/actions/azure-runner-launch after azure/login (OIDC).
 *
 * WHY. GitHub places some Linux jobs on AWS machines, and the Postgres firewall admits Azure
 * addresses only. A runner started in Azure Container Apps always reaches the database.
 *
 * WHAT IT DOES, in order (infra/gh-runner/README.md has the security model):
 *   1. reads the GitHub App private key from the dedicated Key Vault (azure-runner.conf);
 *   2. signs a 9-minute App JWT and trades it for an installation token limited to this
 *      repository and "administration: write" (the permission JIT runners need);
 *   3. asks GitHub for a just-in-time runner registered with ONE unguessable label, and reads
 *      its labels back;
 *   4. starts one execution of the Container Apps job with the image DIGEST, cpu, memory and the
 *      JIT configuration, passed in a 0600 file that is deleted at once (Azure replaces the whole
 *      template when an execution overrides anything, so all of it is sent);
 *   5. waits until the runner is online, then prints `runs-on` for the next job.
 * On any failure after step 3, a thrown error included, it deletes the runner registration and
 * stops the execution if one started.
 * The installation token is revoked before it exits.
 *
 * NEVER PRINTED: the key, the JWT, the token, the JIT configuration. Each is add-masked as
 * soon as it exists, and error text is redacted against them before it is printed.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG = path.resolve(HERE, '../infra/gh-runner/azure-runner.conf');

export const REQUIRED_KEYS = [
  'RESOURCE_GROUP', 'JOB_NAME', 'REGISTRY_SERVER', 'IMAGE', 'CONTAINER_NAME', 'CPU', 'MEMORY',
  'KEY_VAULT_NAME', 'KEY_VAULT_SECRET_NAME',
];
const POLL_MS = 5000;

/** An error whose message is safe to print as it stands. */
class LaunchError extends Error {}
const fail = (message) => { throw new LaunchError(message); };

/** azure-runner.conf: KEY=value lines, plain values only. Never sourced or evaluated. */
export function parseConfig(text) {
  const out = {};
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = /^([A-Z][A-Z0-9_]*)=([A-Za-z0-9._:/@-]+)$/.exec(line);
    if (!m) fail(`azure-runner.conf line ${i + 1} is not KEY=value with a plain value`);
    if (Object.hasOwn(out, m[1])) fail(`azure-runner.conf sets ${m[1]} twice`);
    out[m[1]] = m[2];
  });
  for (const key of REQUIRED_KEYS) if (!out[key]) fail(`azure-runner.conf is missing ${key}`);
  if (!out.IMAGE.startsWith(`${out.REGISTRY_SERVER}/`) || !/@sha256:[0-9a-f]{64}$/.test(out.IMAGE)) {
    fail('azure-runner.conf IMAGE must be in REGISTRY_SERVER and pinned by digest (@sha256:...)');
  }
  if (!/^\d+(\.\d+)?$/.test(out.CPU) || !/^\d+(\.\d+)?Gi$/.test(out.MEMORY)) fail('azure-runner.conf CPU or MEMORY is malformed');
  return out;
}

/** The App key as Key Vault returns it: proper PEM, or PEM whose line breaks a paste turned into spaces. */
export function loadPrivateKey(text) {
  const m = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]*?)-----END (RSA )?PRIVATE KEY-----/.exec(String(text));
  if (!m || (m[1] ?? '') !== (m[3] ?? '')) fail('the Key Vault secret is not a PEM private key');
  const body = m[2].replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) fail('the Key Vault secret is not a PEM private key');
  try {
    return crypto.createPrivateKey({ key: Buffer.from(body, 'base64'), format: 'der', type: m[1] ? 'pkcs1' : 'pkcs8' });
  } catch {
    return fail('the Key Vault secret is not a usable private key');
  }
}

/** A GitHub App JWT: issued 60 s in the past (clock drift), valid 9 minutes (GitHub allows 10). */
export function makeAppJwt({ appId, key, nowSeconds }) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iss = /^\d+$/.test(appId) ? Number(appId) : appId;
  const data = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss })}`;
  return `${data}.${crypto.sign('sha256', Buffer.from(data), key).toString('base64url')}`;
}

/** The execution template. Azure replaces the job's whole template, so image, cpu and memory go too. */
export function executionTemplate(cfg, jitConfig) {
  return {
    containers: [{
      name: cfg.CONTAINER_NAME,
      image: cfg.IMAGE,
      resources: { cpu: Number(cfg.CPU), memory: cfg.MEMORY },
      env: [{ name: 'JIT_CONFIG', value: jitConfig }],
    }],
  };
}

/** Printable form of text we did not write: secrets replaced, one line, no control characters, short. */
export function clean(text, secrets = []) {
  let s = String(text ?? '');
  for (const secret of secrets) if (secret && secret.length >= 8) s = s.split(secret).join('***');
  return s.replace(/[^\x20-\x7E]+/g, ' ').replace(/:{2,}/g, ':').trim().slice(0, 300);
}

function need(value, pattern, name) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${name} is missing or malformed`);
  return value;
}

export async function launch(deps) {
  const {
    env, fetch: fetchFn, execFile: execFileFn, tmpdir,
    configPath = DEFAULT_CONFIG,
    readFile = (p) => fs.readFileSync(p, 'utf8'),
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }),
    randomBytes = crypto.randomBytes,
    log = (line) => { process.stdout.write(`${line}\n`); },
  } = deps;

  const cfg = parseConfig(readFile(configPath));
  const appId = need(env.PPBF_RUNNER_APP_ID, /^[A-Za-z0-9.]{1,64}$/, 'app-id (repository variable PPBF_RUNNER_APP_ID)');
  const installationId = need(env.PPBF_RUNNER_INSTALLATION_ID, /^\d{1,20}$/, 'installation-id (repository variable PPBF_RUNNER_INSTALLATION_ID)');
  const repo = need(env.GITHUB_REPOSITORY, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'GITHUB_REPOSITORY');
  const runId = need(env.GITHUB_RUN_ID, /^\d{1,20}$/, 'GITHUB_RUN_ID');
  const attempt = need(env.GITHUB_RUN_ATTEMPT, /^\d{1,4}$/, 'GITHUB_RUN_ATTEMPT');
  const api = need(env.GITHUB_API_URL || 'https://api.github.com', /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._/-]*)?$/, 'GITHUB_API_URL').replace(/\/+$/, '');
  // 480 s covers a cold pull of the image; at most 540 s, inside the launch job's 12-minute limit.
  const timeoutSeconds = Math.min(540, Math.max(30, Number(env.PPBF_RUNNER_ONLINE_TIMEOUT_SECONDS) || 480));

  const secrets = [];
  const mask = (value) => {
    if (secrets.includes(value)) return;
    secrets.push(value);
    log(`::add-mask::${value}`);
  };

  const az = (args) => new Promise((resolve) => {
    execFileFn('az', args, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env: { ...env, AZURE_CORE_ONLY_SHOW_ERRORS: 'true' },
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (Number.isInteger(err.code) ? err.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
  const azFail = (what, r) => fail(`${what} (az exit ${r.code}): ${clean(r.stderr, secrets) || 'no message'}`);

  const github = async (method, urlPath, auth, body) => {
    const res = await fetchFn(`${api}${urlPath}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: auth,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'ppbf-azure-runner-launch',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = JSON.parse(await res.text()); } catch { json = null; }
    return { status: res.status, json };
  };
  const ghFail = (what, r) => fail(`${what} returned HTTP ${r.status}: ${clean(r.json && r.json.message, secrets) || 'no message'}`);

  // 1. The App key, from Key Vault only.
  const keyRead = await az(['keyvault', 'secret', 'show', '--vault-name', cfg.KEY_VAULT_NAME, '--name', cfg.KEY_VAULT_SECRET_NAME, '--query', 'value', '-o', 'tsv']);
  if (keyRead.code !== 0 || !keyRead.stdout.trim()) azFail(`reading the GitHub App key from Key Vault ${cfg.KEY_VAULT_NAME}`, keyRead);
  for (const token of keyRead.stdout.split(/\s+/)) if (/^[A-Za-z0-9+/=]{16,}$/.test(token)) mask(token);
  // Also the key body in 64-character pieces, in case it was pasted with no line breaks at all.
  const keyBody = (/PRIVATE KEY-----([\s\S]*?)-----END/.exec(keyRead.stdout)?.[1] ?? '').replace(/\s+/g, '');
  for (let i = 0; i < keyBody.length; i += 64) if (keyBody.length - i >= 16) mask(keyBody.slice(i, i + 64));
  const key = loadPrivateKey(keyRead.stdout);

  // 2. JWT -> installation token, narrowed to this repository and the one permission.
  const jwt = makeAppJwt({ appId, key, nowSeconds: Math.floor(now() / 1000) });
  mask(jwt);
  const tokenRes = await github('POST', `/app/installations/${installationId}/access_tokens`, `Bearer ${jwt}`, {
    repositories: [repo.split('/')[1]],
    permissions: { administration: 'write' },
  });
  if (tokenRes.status !== 201 || typeof (tokenRes.json && tokenRes.json.token) !== 'string') ghFail('GitHub installation token', tokenRes);
  const token = tokenRes.json.token;
  mask(token);
  const auth = `Bearer ${token}`;

  // On ANY failure after registration -- a thrown error included -- the runner registration is
  // removed and a started execution stopped; the token is revoked on every path.
  let runnerId = null;
  let execution = null;
  const cleanUp = async () => {
    if (runnerId !== null) {
      const r = await github('DELETE', `/repos/${repo}/actions/runners/${runnerId}`, auth).catch(() => ({ status: 0 }));
      log(r.status === 204 || r.status === 404
        ? `azure-runner-launch: runner registration ${runnerId} removed.`
        : `::warning::azure-runner-launch: could not remove runner registration ${runnerId} (HTTP ${r.status}).`);
    }
    if (execution !== null) {
      const stop = await az(['containerapp', 'job', 'stop', '--name', cfg.JOB_NAME, '--resource-group', cfg.RESOURCE_GROUP, '--job-execution-name', execution, '-o', 'none']);
      log(stop.code === 0
        ? `azure-runner-launch: execution ${execution} stopped.`
        : `::warning::azure-runner-launch: could not stop execution ${execution} (az exit ${stop.code}).`);
    }
  };

  try {
    // 3. One JIT runner, registered with one label nobody can know in advance.
    const label = `ppbf-db-${runId}-${attempt}-${randomBytes(8).toString('hex')}`;
    const jitRes = await github('POST', `/repos/${repo}/actions/runners/generate-jitconfig`, auth, {
      name: label, runner_group_id: 1, labels: [label], work_folder: '_work',
    });
    const runner = jitRes.json && jitRes.json.runner;
    if (Number.isInteger(runner && runner.id)) runnerId = runner.id;
    if (jitRes.status !== 201 || runnerId === null || typeof jitRes.json.encoded_jit_config !== 'string') {
      ghFail('GitHub generate-jitconfig', jitRes);
    }
    const jitConfig = jitRes.json.encoded_jit_config;
    mask(jitConfig);
    const labels = Array.isArray(runner.labels) ? runner.labels : [];
    const names = labels.map((l) => clean(l && l.name));
    const foreign = labels.filter((l) => (l && l.type) !== 'read-only' && (l && l.name) !== label);
    log(`azure-runner-launch: runner ${label} registered (id ${runnerId}); labels: ${names.join(', ') || 'none'}.`);
    if (!names.includes(label) || foreign.length > 0) fail('the runner was registered with labels other than its own; removed it');

    // 4. One execution, everything in a 0600 file that is gone before the next step.
    const dir = fs.mkdtempSync(path.join(tmpdir, 'ppbf-runner-'));
    const file = path.join(dir, 'execution.yaml');
    let start;
    try {
      fs.writeFileSync(file, JSON.stringify(executionTemplate(cfg, jitConfig)), { mode: 0o600 });
      start = await az(['containerapp', 'job', 'start', '--name', cfg.JOB_NAME, '--resource-group', cfg.RESOURCE_GROUP, '--yaml', file, '--query', 'name', '-o', 'tsv']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const started = start.stdout.trim();
    if (start.code !== 0 || !/^[A-Za-z0-9-]{1,80}$/.test(started)) azFail(`starting Container Apps job ${cfg.JOB_NAME}`, start);
    execution = started;
    log(`azure-runner-launch: started execution ${execution} of ${cfg.JOB_NAME}.`);

    // 5. Wait for the runner. GitHub would hold the next job for 24 h on a runner that never comes.
    //    A failed status read (a network error) counts as "not online yet".
    const startedAt = now();
    const deadline = startedAt + timeoutSeconds * 1000;
    for (;;) {
      const r = await github('GET', `/repos/${repo}/actions/runners/${runnerId}`, auth).catch(() => ({ status: 0, json: null }));
      if (r.status === 200 && r.json && (r.json.status === 'online' || r.json.busy === true)) break;
      if (now() >= deadline) {
        const st = await az(['containerapp', 'job', 'execution', 'show', '--name', cfg.JOB_NAME, '--resource-group', cfg.RESOURCE_GROUP, '--job-execution-name', execution, '--query', 'properties.status', '-o', 'tsv']);
        fail(`runner ${label} was not online within ${timeoutSeconds} s (execution ${execution}: ${clean(st.stdout) || 'status unknown'})`);
      }
      await sleep(POLL_MS);
    }
    log(`azure-runner-launch: runner online ${Math.round((now() - startedAt) / 1000)} s after the execution started.`);
    return { label, runnerId, execution, runsOn: JSON.stringify([label]) };
  } catch (err) {
    await cleanUp();
    throw err;
  } finally {
    const r = await github('DELETE', '/installation/token', auth).catch(() => ({ status: 0 }));
    if (r.status !== 204) log(`::warning::azure-runner-launch: could not revoke the installation token (HTTP ${r.status}); it expires within the hour.`);
  }
}

async function main() {
  const secretsSeen = [];
  try {
    const r = await launch({
      env: process.env,
      fetch: globalThis.fetch,
      execFile,
      tmpdir: process.env.RUNNER_TEMP || os.tmpdir(),
      log: (line) => {
        if (line.startsWith('::add-mask::')) secretsSeen.push(line.slice(12));
        process.stdout.write(`${line}\n`);
      },
    });
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `runs-on=${r.runsOn}\nlabel=${r.label}\nrunner-id=${r.runnerId}\nexecution=${r.execution}\n`);
    }
    process.stdout.write(`azure-runner-launch: runner ${r.label} is online; the next job runs on it.\n`);
  } catch (err) {
    const message = err instanceof LaunchError
      ? err.message
      : `unexpected ${clean(err && err.name) || 'error'}: ${clean(err && err.message, secretsSeen)}`;
    process.stdout.write(`::error::azure-runner-launch: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
