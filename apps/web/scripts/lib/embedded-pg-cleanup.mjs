// Teardown helpers for the disposable embedded-Postgres clusters that every
// `.pg.test.ts` suite stands up through scripts/test-embedded-pg-server.mjs.
//
// WHY THIS EXISTS. A suite ends its cluster with `serverProcess.kill('SIGTERM')`.
// On Linux that runs the helper's SIGTERM handler, which stops Postgres and
// removes the data directory. On Windows there are no signals: Node's
// `kill()` is TerminateProcess, the helper dies mid-instruction and its
// handler never runs. Postgres itself is ended by the kill-on-close job
// object libuv puts every non-detached child in, but nothing removes the
// data directory, so every suite leaves ~20 MB under %TEMP% on every run --
// measured at 352 -> 463 directories in a day on the machine that runs these
// suites. A run killed from outside (Ctrl+C, a tool timeout, a closed
// terminal) leaks the same way on every platform, and there the postmaster
// can outlive its helper as well.
//
// Two mechanisms, both driven from the helper and both implemented here:
//
//   1. A JANITOR (scripts/test-embedded-pg-janitor.mjs) is spawned detached
//      before the cluster is created. It holds the read end of a pipe whose
//      write end only the helper owns; the kernel closes that pipe the
//      instant the helper's process ends, however it ends. The janitor then
//      stops the postmaster the data directory names, if it is still there,
//      and removes the directory (`cleanupDataDir`). This is the path that
//      makes an ordinary Windows run clean.
//   2. A SWEEP (`sweepStaleDataDirs`) runs when a helper starts and removes
//      clusters that earlier runs left behind -- the case where the janitor
//      itself was killed along with everything else. It only ever touches
//      directories following the suite naming convention, and it leaves any
//      cluster alone that a live helper still owns, so suites running
//      concurrently in different worktrees do not interfere.
//
// Nothing here is used by the application. It is test infrastructure and it
// never sees a connection string.

import { execFile } from 'node:child_process';
import { realpath as realpathCallback } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const realpathNative = promisify(realpathCallback.native);

export const IS_WINDOWS = process.platform === 'win32';

/**
 * Every pg suite names its cluster `ppbf-<slug>-pg-test-<Date.now()>` under
 * os.tmpdir(). The sweep considers nothing that does not match this exactly.
 */
export const TEST_DATA_DIR_PATTERN = /^ppbf-[a-z0-9-]+-pg-test-\d+$/;

/**
 * Written into the data directory by the helper once initdb has run (initdb
 * refuses a non-empty directory, so it cannot be written earlier). Names the
 * helper's own PID; the sweep uses it to tell a cluster that is in use from
 * an orphan whose helper is gone.
 */
export const HELPER_PID_FILE = 'ppbf-helper.pid';

/** A directory with no postmaster.pid that has not changed for this long is abandoned. */
export const STALE_AFTER_MS = 10 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isTestDataDirName(name) {
  return TEST_DATA_DIR_PATTERN.test(String(name));
}

/**
 * One comparable spelling for a directory: absolute, symlinks and Windows 8.3
 * short names resolved when the path exists, forward slashes, no trailing
 * slash, case-folded on Windows. postmaster.pid records the data directory
 * the way Postgres canonicalises it (forward slashes), so both sides go
 * through this before they are compared.
 */
export async function canonicalDir(dir) {
  let resolved = path.resolve(String(dir));
  try {
    resolved = await realpathNative(resolved);
  } catch {
    // does not exist (yet, or any more): compare the resolved spelling
  }
  resolved = resolved.replace(/\\/g, '/').replace(/\/+$/, '');
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
}

/**
 * postmaster.pid: line 1 is the postmaster's PID, line 2 the data directory
 * it was started on. Returns null for anything that does not start with a
 * positive integer.
 */
export function parsePostmasterPid(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const pid = Number.parseInt((lines[0] ?? '').trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, dataDir: (lines[1] ?? '').trim() };
}

export async function readPostmasterPid(dataDir) {
  try {
    return parsePostmasterPid(await fs.readFile(path.join(dataDir, 'postmaster.pid'), 'utf8'));
  } catch {
    return null;
  }
}

export async function readHelperPid(dataDir) {
  try {
    const raw = await fs.readFile(path.join(dataDir, HELPER_PID_FILE), 'utf8');
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function writeHelperPid(dataDir, pid) {
  await fs.writeFile(path.join(dataDir, HELPER_PID_FILE), `${pid}\n`, 'utf8');
}

/** Existence only. EPERM means it exists and belongs to someone else. */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** `tasklist /FO CSV /NH` -> Map<pid, image name>. */
export function parseTaskList(csv) {
  const processes = new Map();
  for (const line of String(csv ?? '').split(/\r?\n/)) {
    const match = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (match) processes.set(Number(match[2]), match[1]);
  }
  return processes;
}

/** `ps -A -o pid=,comm=` -> Map<pid, command>. */
export function parsePsList(text) {
  const processes = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) processes.set(Number(match[1]), match[2]);
  }
  return processes;
}

/**
 * Every process on the machine, or null when the listing tool failed. Callers
 * treat null as "cannot tell" and never kill on it.
 */
export async function listProcesses() {
  try {
    if (IS_WINDOWS) {
      const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], {
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
      return parseTaskList(stdout);
    }
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,comm='], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return parsePsList(stdout);
  } catch {
    return null;
  }
}

export function isPostgresImage(name) {
  return /^postgres(\.exe)?$/i.test(path.basename(String(name ?? '')));
}

/**
 * `<pid> <ppid> <0|1 forked>` per line, as listPostgresProcesses() asks
 * PowerShell for it -> [{ pid, ppid, forked }]. `forked` marks a process the
 * postmaster forked (`--forkchild` on Windows), as opposed to a postmaster.
 */
export function parsePostgresProcessLines(text) {
  const processes = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+([01])\s*$/.exec(line);
    if (match) processes.push({ pid: Number(match[1]), ppid: Number(match[2]), forked: match[3] === '1' });
  }
  return processes;
}

/**
 * `ps -A -o pid=,ppid=,args=` -> the postgres processes in it. A postmaster
 * carries `-D <dir>` in its arguments; on Linux a forked child has retitled
 * itself (`postgres: walwriter`), so anything without `-D` is a child.
 */
export function parsePsPostgresProcesses(text) {
  const processes = [];
  for (const line of String(text ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const args = match[3].trim();
    const command = args.split(/\s+/)[0] ?? '';
    if (!isPostgresImage(command.replace(/:$/, ''))) continue;
    processes.push({ pid: Number(match[1]), ppid: Number(match[2]), forked: !/(^|\s)-D(\s|$)/.test(args) });
  }
  return processes;
}

/**
 * Every postgres process with its parent, or null when the listing failed.
 * This is the one place a parent PID is needed: a child the postmaster was
 * still forking when it was terminated is not ended with it (observed on
 * Windows: a kill landing within ~20 ms of the ready line leaves exactly
 * that child running, forever). tasklist has no parent column, so this asks
 * CIM through PowerShell; it costs about a second and runs only when a
 * cluster is being torn down.
 */
export async function listPostgresProcesses() {
  try {
    if (IS_WINDOWS) {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\" | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, [int]($_.CommandLine -match '--forkchild') }",
        ],
        { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      );
      return parsePostgresProcessLines(stdout);
    }
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,args='], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return parsePsPostgresProcesses(stdout);
  } catch {
    return null;
  }
}

/**
 * End the forked children a dead postmaster left behind: postgres processes
 * whose parent is `postmasterPid` and that are children, never a postmaster
 * (a recycled PID that is now some other cluster's helper has a postmaster
 * child, not forked ones, so this cannot reach a live cluster). Returns the
 * PIDs it ended.
 */
export async function killOrphanedChildren(postmasterPid) {
  const processes = await listPostgresProcesses();
  if (!processes) return [];
  const killed = [];
  for (const candidate of processes) {
    if (candidate.ppid !== postmasterPid || !candidate.forked || candidate.pid === process.pid) continue;
    try {
      if (IS_WINDOWS) {
        await execFileAsync('taskkill', ['/pid', String(candidate.pid), '/f'], { windowsHide: true });
      } else {
        process.kill(candidate.pid, 'SIGKILL');
      }
      killed.push(candidate.pid);
    } catch {
      // gone already
    }
  }
  return killed;
}

export function isNodeImage(name) {
  return /^node(\.exe)?$/i.test(path.basename(String(name ?? '')));
}

/**
 * What the PID a postmaster.pid names is today:
 *   'postgres' -- alive and a postgres image: a running cluster
 *   'dead'     -- no such process
 *   'reused'   -- alive, but the PID now belongs to something else
 *   'unknown'  -- alive, and the process list could not be read
 */
export function classifyPid(pid, processes) {
  if (!isProcessAlive(pid)) return 'dead';
  if (!processes) return 'unknown';
  const image = processes.get(pid);
  if (image === undefined) return 'dead';
  return isPostgresImage(image) ? 'postgres' : 'reused';
}

export async function waitForExit(pid, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
  return true;
}

/**
 * Stop a postmaster and everything under it. Windows: the same
 * `taskkill /t /f` embedded-postgres itself uses. Elsewhere: SIGQUIT is
 * Postgres's immediate-shutdown request -- the postmaster forwards it to
 * every child and exits -- with SIGKILL if it has not gone in five seconds.
 */
export async function killProcessTree(pid) {
  if (IS_WINDOWS) {
    try {
      await execFileAsync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true });
    } catch {
      // already gone, or not ours to kill
    }
    return;
  }
  try {
    process.kill(pid, 'SIGQUIT');
  } catch {
    return;
  }
  if (await waitForExit(pid, 5_000)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // gone between the check and the signal
  }
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a directory, retrying while a process that was just stopped still
 * holds files open in it (Windows reports EBUSY/EPERM/ENOTEMPTY for a few
 * hundred milliseconds after the handles close). Returns whether it is gone.
 */
export async function removeDirWithRetries(dir, { attempts = 60, delayMs = 500 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // retried below
    }
    if (!(await exists(dir))) return true;
    await sleep(delayMs);
  }
  return !(await exists(dir));
}

/**
 * Tear down one cluster whose helper is gone: stop the postmaster its
 * postmaster.pid names -- only when that PID is still a postgres process and
 * the file claims this very directory, so a recycled PID is never killed --
 * end any forked child that outlived the postmaster, then remove the
 * directory. `postmaster` is a copy of postmaster.pid read earlier, for a
 * caller that watched the directory while it still had one (a suite that
 * removes its own directory races the janitor for the file).
 */
export async function cleanupDataDir(dataDir, { processes, postmaster: remembered } = {}) {
  const result = { dataDir, killed: false, orphansKilled: [], removed: false };
  const postmaster = (await readPostmasterPid(dataDir)) ?? remembered ?? null;
  if (postmaster) {
    const claimsThisDir =
      postmaster.dataDir === '' ||
      (await canonicalDir(postmaster.dataDir)) === (await canonicalDir(dataDir));
    let state = classifyPid(postmaster.pid, processes ?? (await listProcesses()));
    if (claimsThisDir && state === 'postgres') {
      await killProcessTree(postmaster.pid);
      if (await waitForExit(postmaster.pid, 10_000)) state = 'dead';
      result.killed = true;
    }
    if (state === 'dead' || state === 'reused') {
      result.orphansKilled = await killOrphanedChildren(postmaster.pid);
    }
  }
  result.removed = await removeDirWithRetries(dataDir);
  return result;
}

/**
 * 'remove' or 'keep' for one candidate directory. Removed when its postmaster
 * is gone, when it never got a postmaster and has sat untouched for
 * STALE_AFTER_MS, or when its postmaster is alive but the helper that owned
 * it is not (an orphan: cleanupDataDir stops the postmaster). Kept whenever
 * the answer is not certain.
 */
export async function judgeStaleDir(
  dir,
  { processes, now = Date.now(), staleAfterMs = STALE_AFTER_MS } = {},
) {
  const postmaster = await readPostmasterPid(dir);
  if (!postmaster) {
    let stat;
    try {
      stat = await fs.stat(dir);
    } catch {
      return 'keep'; // vanished while we looked
    }
    return now - stat.mtimeMs >= staleAfterMs ? 'remove' : 'keep';
  }
  const state = classifyPid(postmaster.pid, processes);
  if (state === 'dead' || state === 'reused') return 'remove';
  if (state === 'unknown') return 'keep';
  // A live postmaster. In use, unless the helper that started it is gone.
  const helperPid = await readHelperPid(dir);
  if (helperPid === null) return 'keep'; // started by an older helper, or still starting
  if (!isProcessAlive(helperPid)) return 'remove';
  const helperImage = processes?.get(helperPid);
  return helperImage !== undefined && !isNodeImage(helperImage) ? 'remove' : 'keep';
}

/**
 * Remove every stale cluster beside `ownDataDir`. Returns what was removed,
 * what was left alone and what could not be removed.
 */
export async function sweepStaleDataDirs(
  tmpDir,
  { ownDataDir, processes, now = Date.now(), staleAfterMs = STALE_AFTER_MS } = {},
) {
  const summary = { removed: [], skipped: [], failed: [] };
  let entries;
  try {
    entries = await fs.readdir(tmpDir, { withFileTypes: true });
  } catch {
    return summary;
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory() && isTestDataDirName(entry.name))
    .map((entry) => path.join(tmpDir, entry.name));
  if (candidates.length === 0) return summary;

  const own = ownDataDir ? await canonicalDir(ownDataDir) : null;
  const known = processes === undefined ? await listProcesses() : processes;

  for (const dir of candidates) {
    if (own !== null && (await canonicalDir(dir)) === own) continue;
    const verdict = await judgeStaleDir(dir, { processes: known, now, staleAfterMs });
    if (verdict !== 'remove') {
      summary.skipped.push(dir);
      continue;
    }
    const result = await cleanupDataDir(dir, { processes: known });
    (result.removed ? summary.removed : summary.failed).push(dir);
  }
  return summary;
}
