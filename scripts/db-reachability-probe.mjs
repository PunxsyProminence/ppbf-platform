#!/usr/bin/env node
// db-reachability-probe: can THIS runner open a TCP connection to the database?
//
// WHY THIS EXISTS (lane DBT, 2026-11-17). GitHub now places some `ubuntu-latest`
// jobs on AWS, not Azure, and the Postgres firewall admits Azure ranges
// (allow-azure-services) plus named single IPs. OBSERVED in the run logs since
// 2026-11-03, counting every attempt: 10 of 10 database jobs on AWS runners got
// no answer and died with `connect ETIMEDOUT` after 133-137 s (the driver sets
// no connect timeout; the ~134 s is INFERRED to be the kernel's SYN retries);
// no job on an Azure runner timed out. Which side drops the packets is not
// established. Every retry that passed was a re-run or new run on a new (Azure)
// runner, so a retry inside the same job is not expected to help.
//
// So this check runs once per job, right after the job first resolves the
// connection string and before that job's first database contact. It fails in
// about 20 s with a message that says what happened, instead of a silent
// two-minute hang. (A later check in the same job could not catch this case:
// the runner has already reached the server by then.)
//
// WHAT IT DOES AND DOES NOT DO
//   * Opens a TCP connection to host:port and closes it at once. It writes no
//     byte: no Postgres startup packet, no TLS, no credentials, no SQL. So it
//     cannot authenticate, cannot write, and has no "auth or SQL error" to retry.
//   * Prints the host and port only. The connection string (which carries the
//     password) is read from an environment variable and never printed, not
//     even on a parse failure.
//   * Names the runner's cloud and region when the runner's provisioner file
//     (`.setup_info`, the source of "Set up job -> Runner Image Provisioner")
//     can be found; otherwise says where to look.
//
// Usage (the connection string is passed by NAME, never by value):
//   node scripts/db-reachability-probe.mjs [--env AZURE_POSTGRES_CONNECTION_STRING]
//        [--attempts 3] [--timeout-ms 5000] [--backoff-ms 2000]
// Exit 0: reachable (or the string is not URL-shaped: the check steps aside and
// the database step reports for itself). Exit 1: unreachable or misused.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULTS = Object.freeze({ attempts: 3, timeoutMs: 5000, backoffMs: 2000 });

/** host and port from a postgres URL; null when it is not URL-shaped. Never throws, never echoes the input. */
export function targetFromConnectionString(conn) {
  let u;
  try {
    u = new URL(conn);
  } catch {
    return null;
  }
  // An IPv6 literal comes back bracketed ("[::1]"); net.connect wants it bare.
  const host = u.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (!host) return null;
  const port = u.port ? Number(u.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/** Exponential backoff before attempt n+1 (n counts from 1): base, 2*base, 4*base ... */
export function backoffDelay(attemptJustFailed, backoffMs) {
  return backoffMs * 2 ** (attemptJustFailed - 1);
}

/**
 * One TCP connect, closed the moment it opens. Resolves {ok:true,ms} or
 * {ok:false,code}. No data is ever written to the socket.
 */
export function connectOnce(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, code: 'PROBE_TIMEOUT' }), timeoutMs);
    socket.once('connect', () => finish({ ok: true, ms: Date.now() - started }));
    // `on`, not `once`: an error after the socket is settled is swallowed by the guard in finish.
    socket.on('error', (err) => finish({ ok: false, code: err && err.code ? String(err.code) : 'ERROR' }));
  });
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Try up to `attempts` times. `connect` and `sleep` are injectable for tests.
 * Returns {ok, attempt, ms?, codes[]}.
 */
export async function probe({
  host,
  port,
  attempts = DEFAULTS.attempts,
  timeoutMs = DEFAULTS.timeoutMs,
  backoffMs = DEFAULTS.backoffMs,
  connect = connectOnce,
  sleep = realSleep,
  log = () => {},
}) {
  const codes = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await connect(host, port, timeoutMs);
    if (result.ok) return { ok: true, attempt, ms: result.ms, codes };
    codes.push(result.code);
    log(`db-preflight: attempt ${attempt}/${attempts} to ${host}:${port} failed (${result.code}).`);
    if (attempt < attempts) await sleep(backoffDelay(attempt, backoffMs));
  }
  return { ok: false, attempt: attempts, codes };
}

/**
 * Cloud and region from the runner's `.setup_info` JSON (an array of
 * {group, detail}); the "Runner Image Provisioner" group carries lines such as
 * "Cloud: AWS" and "Region: us-west-2". Returns {cloud, region} or null.
 */
export function parseSetupInfo(text) {
  let groups;
  try {
    groups = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(groups)) return null;
  for (const g of groups) {
    if (!g || typeof g.detail !== 'string') continue;
    const cloud = /^\s*Cloud:\s*(\S+)/m.exec(g.detail);
    if (!cloud) continue;
    const region = /^\s*Region:\s*(\S+)/m.exec(g.detail);
    return { cloud: cloud[1], region: region ? region[1] : null };
  }
  return null;
}

/**
 * The runner writes nothing about its cloud into the environment, but the
 * worker reads `<runner root>/.setup_info` (actions/runner HostContext:
 * WellKnownConfigFile.SetupInfo). Find the root by walking up this process's
 * ancestry to the Runner.Worker binary (<root>/bin/Runner.Worker). Linux only;
 * best effort; null when anything is missing.
 */
export function findRunnerProvisioner({
  procRoot = '/proc',
  startPid = process.ppid,
  maxDepth = 8,
  readlink = fs.readlinkSync,
  readFile = fs.readFileSync,
} = {}) {
  try {
    let pid = startPid;
    for (let i = 0; i < maxDepth && pid > 1; i += 1) {
      let exe = null;
      try {
        exe = readlink(path.posix.join(procRoot, String(pid), 'exe'));
      } catch {
        exe = null;
      }
      if (exe && path.posix.basename(exe) === 'Runner.Worker') {
        const root = path.posix.dirname(path.posix.dirname(exe));
        return parseSetupInfo(readFile(path.posix.join(root, '.setup_info'), 'utf8'));
      }
      const stat = readFile(path.posix.join(procRoot, String(pid), 'stat'), 'utf8');
      // Field 4 is the parent pid; field 2 (comm) may contain spaces, so split after ')'.
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      pid = Number(after[1]);
    }
  } catch {
    return null;
  }
  return null;
}

function describeRunner(runner) {
  if (!runner) return 'Runner cloud: unknown (see "Set up job" -> "Runner Image Provisioner" in this job\'s log).';
  return `Runner cloud: ${runner.cloud}${runner.region ? `, region ${runner.region}` : ''} (from the runner's provisioner info).`;
}

/** The ::error:: text for an unreachable database. Host and port only; never the connection string. */
export function failureMessage({ host, port, attempts, codes, runner }) {
  const last = codes.length ? codes[codes.length - 1] : 'unknown';
  const cause =
    runner && runner.cloud && runner.cloud.toLowerCase() !== 'azure'
      ? 'This runner is not on Azure. As of 2026-11-17, 10 of 10 database jobs GitHub placed on non-Azure runners since 2026-11-03 had failed to connect, and the database firewall admits Azure ranges and named single IPs only (lane DBT; OD-2026-11-17-008).'
      : runner && runner.cloud
        ? 'This runner IS on Azure, so this is not the known non-Azure-runner pattern: check the server\'s status and firewall before re-running.'
        : 'GitHub sometimes places Linux jobs on non-Azure runners; as of 2026-11-17, 10 of 10 such database jobs since 2026-11-03 had failed to connect (lane DBT; OD-2026-11-17-008).';
  return (
    `Could not open a TCP connection to ${host}:${port} after ${attempts} attempt(s) (last: ${last}). ` +
    `${describeRunner(runner)} ${cause} ` +
    "This check sends no data and runs before this job's first database step, so the job has not touched the database. " +
    'A new runner is needed: re-run the job, or dispatch a fresh run where re-runs are refused (release-one-approval).'
  );
}

function parseArgs(argv) {
  const opts = { env: 'AZURE_POSTGRES_CONNECTION_STRING', ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--env') opts.env = value;
    else if (flag === '--attempts') opts.attempts = Number(value);
    else if (flag === '--timeout-ms') opts.timeoutMs = Number(value);
    else if (flag === '--backoff-ms') opts.backoffMs = Number(value);
    else throw new Error(`unknown argument: ${flag}`);
    i += 1;
  }
  for (const k of ['attempts', 'timeoutMs', 'backoffMs']) {
    if (!Number.isInteger(opts[k]) || opts[k] < (k === 'attempts' ? 1 : 0)) throw new Error(`bad value for ${k}`);
  }
  if (!/^[A-Z_][A-Z0-9_]*$/.test(opts.env || '')) throw new Error('--env must name an environment variable');
  return opts;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.log(`::error title=db-preflight misused::${err.message}`);
    return 1;
  }
  const conn = env[opts.env];
  if (!conn) {
    console.log(`::error title=db-preflight misused::${opts.env} is empty or unset in this step.`);
    return 1;
  }
  const target = targetFromConnectionString(conn);
  if (!target) {
    console.log(
      `::warning title=db-preflight skipped::${opts.env} is not a URL-shaped connection string, so the reachability check cannot read a host from it. The database step will report for itself.`,
    );
    return 0;
  }
  const runner = findRunnerProvisioner();
  const result = await probe({ ...target, ...opts, log: (line) => console.log(line) });
  if (result.ok) {
    console.log(
      `db-preflight: ${target.host}:${target.port} reachable (attempt ${result.attempt}, ${result.ms} ms). ${describeRunner(runner)}`,
    );
    return 0;
  }
  console.log(
    `::error title=Database unreachable from this runner::${failureMessage({ ...target, attempts: opts.attempts, codes: result.codes, runner })}`,
  );
  return 1;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    // Real paths on both sides: Node runs the main module by its real path, so a
    // symlinked workspace must not make the check silently skip itself.
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().then((code) => {
    process.exitCode = code;
    // A name lookup still pending in the resolver must not hold the process past
    // its budget. Unref'd, so a process with nothing pending exits at once.
    setTimeout(() => process.exit(code), 2000).unref();
  });
}
