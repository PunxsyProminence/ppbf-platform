/**
 * Worktree-scoped lifecycle for the local offline replica.
 * Process matching is always relative to the repository root that launched
 * this copy. A hardcoded machine path must never appear here: two checkouts
 * on the same machine have to start and stop independently.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const RUNTIME_STATE_VERSION = 1;
export const RUNTIME_STATE_FILE = 'runtime-state.json';

export function runtimePaths(repoDir) {
  const runtimeDir = path.join(repoDir, '.ppbf-offline');
  return {
    runtimeDir,
    databaseDir: path.join(runtimeDir, 'postgres'),
    stateFile: path.join(runtimeDir, RUNTIME_STATE_FILE),
  };
}

export function parseRuntimeArgs(argv) {
  const args = [...argv];
  let command = 'start';
  let reset = false;
  let port = '3100';
  let portProvided = false;

  const takeCommand = (value) => {
    if (command !== 'start' && command !== value) {
      throw new Error(`PPBF offline runtime received two commands: ${command} and ${value}.`);
    }
    command = value;
  };

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--reset') {
      reset = true;
      continue;
    }
    if (token === '--port') {
      port = args[i + 1];
      portProvided = true;
      i += 1;
      continue;
    }
    if (token === '--help' || token === '-h') {
      takeCommand('help');
      continue;
    }
    if (token === 'start' || token === 'stop' || token === 'status' || token === 'restart') {
      takeCommand(token);
      continue;
    }
    if (token.startsWith('-')) {
      throw new Error(`Unknown PPBF offline runtime flag: ${token}.`);
    }
    throw new Error(`Unknown PPBF offline runtime command: ${token}.`);
  }

  if ((command === 'stop' || command === 'status' || command === 'help') && reset) {
    throw new Error(`--reset cannot be combined with ${command}.`);
  }
  if ((command === 'stop' || command === 'status' || command === 'help') && portProvided) {
    throw new Error(`--port cannot be combined with ${command}.`);
  }

  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new Error(`Invalid --port ${port}.`);
  }

  return { command, reset, port: parsedPort };
}

export function normalizeFsPath(value) {
  return String(value ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

export function pathOccursInHaystack(haystack, dir) {
  const nHay = normalizeFsPath(haystack);
  const nDir = normalizeFsPath(dir);
  if (!nHay || !nDir) return false;
  let from = 0;
  while (from <= nHay.length) {
    const index = nHay.indexOf(nDir, from);
    if (index < 0) return false;
    const after = nHay[index + nDir.length];
    if (after === undefined || after === '\\' || after === '"' || after === "'" || after === ' ') {
      return true;
    }
    from = index + 1;
  }
  return false;
}

const RUNTIME_MARKERS = /offline-runtime\.mjs|\.ppbf-offline|\.next-offline|embedded-postgres|node_modules[\\/]+next[\\/]/i;

export function belongsToOfflineRuntime({ commandLine, executablePath, repoDir }) {
  const haystack = `${commandLine ?? ''} ${executablePath ?? ''}`;
  if (!pathOccursInHaystack(haystack, repoDir)) return false;
  return RUNTIME_MARKERS.test(haystack);
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

export function windowsProcessQueryCommand(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error('windowsProcessQueryCommand requires a positive integer pid');
  }
  return `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ProcessId,CommandLine,ExecutablePath | ConvertTo-Json -Compress`;
}

export function parseWindowsProcessQuery(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!row || row.ProcessId == null) return null;
    const pid = Number(row.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return {
      pid,
      commandLine: row.CommandLine == null ? '' : String(row.CommandLine),
      executablePath: row.ExecutablePath == null ? '' : String(row.ExecutablePath),
    };
  } catch {
    return null;
  }
}

/**
 * POSIX counterpart to parseWindowsProcessQuery. `ps -o args=` prints one line
 * per process and no header, so anything other than exactly one non-empty line
 * is ambiguous and proves nothing. Truncation can only drop characters, never
 * invent a checkout path or a runtime marker, so a clipped command line fails
 * the ownership test rather than passing it falsely.
 */
export function parsePosixProcessQuery(pid, stdout) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const lines = String(stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) return null;
  return { pid, commandLine: lines[0], executablePath: '' };
}

export function windowsListenerPidQueryCommand(port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('windowsListenerPidQueryCommand requires a valid port');
  }
  return `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ConvertTo-Json -Compress`;
}

export function parseWindowsListenerPid(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    const pids = [...new Set(values.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))];
    return pids.length === 1 ? pids[0] : null;
  } catch {
    const pid = Number(text);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }
}

export function isOwnedOfflineProcess(processInfo, repoDir) {
  if (!processInfo || !repoDir) return false;
  return belongsToOfflineRuntime({
    commandLine: processInfo.commandLine,
    executablePath: processInfo.executablePath,
    repoDir,
  });
}

async function defaultLookupProcess(pid) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  if (process.platform !== 'win32') {
    try {
      const { stdout } = await execFileAsync('ps', ['-ww', '-p', String(pid), '-o', 'args='], {
        timeout: 5000,
      });
      return parsePosixProcessQuery(pid, stdout);
    } catch {
      return null;
    }
  }

  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      windowsProcessQueryCommand(pid),
    ], { windowsHide: true, timeout: 5000 });
    return parseWindowsProcessQuery(stdout);
  } catch {
    return null;
  }
}

async function defaultLookupListenerPid(port) {
  if (process.platform !== 'win32') return null;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      windowsListenerPidQueryCommand(port),
    ], { windowsHide: true, timeout: 5000 });
    return parseWindowsListenerPid(stdout);
  } catch {
    return null;
  }
}

function defaultSignalProcess(pid, signal) {
  if (signal) process.kill(pid, signal);
  else process.kill(pid);
}

export async function readPostmasterPid(databaseDir) {
  try {
    const content = await fs.readFile(path.join(databaseDir, 'postmaster.pid'), 'utf8');
    const pid = Number(content.split(/\r?\n/)[0]?.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function removeStaleLockFileIfNeeded(databaseDir) {
  const lockFile = path.join(databaseDir, 'postmaster.pid');
  try {
    const content = await fs.readFile(lockFile, 'utf8');
    const pidText = content.split(/\r?\n/)[0]?.trim();
    if (!pidText) {
      await fs.rm(lockFile, { force: true });
      return;
    }
    const pid = Number(pidText);
    if (!Number.isFinite(pid) || pid <= 0 || !isProcessAlive(pid)) {
      await fs.rm(lockFile, { force: true });
    }
  } catch {
    // No lock file; nothing to do.
  }
}

export function createRuntimeState({
  repoDir,
  appPort,
  databasePort,
  launcherPid,
  nextPid,
  postgresPid,
  startedAt = new Date().toISOString(),
}) {
  return {
    version: RUNTIME_STATE_VERSION,
    repoDir,
    appPort,
    databasePort,
    launcherPid,
    nextPid,
    postgresPid,
    startedAt,
  };
}

export async function readRuntimeState(stateFile, repoDir) {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    if (!parsed || parsed.version !== RUNTIME_STATE_VERSION) return null;
    if (normalizeFsPath(parsed.repoDir) !== normalizeFsPath(repoDir)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeRuntimeState(stateFile, state) {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

export async function removeRuntimeState(stateFile) {
  await fs.rm(stateFile, { force: true });
}

function uniquePids(values) {
  return [...new Set(values.filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid))];
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntilDead(pids, timeoutMs = 8000) {
  const tracked = uniquePids(pids);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (tracked.every((pid) => !isProcessAlive(pid))) return [];
    await sleep(100);
  }
  return tracked.filter((pid) => isProcessAlive(pid));
}

/**
 * The single ownership gate, used on every platform and at every point a signal
 * could be sent. Windows and POSIX differ only in how the metadata is acquired;
 * the decision itself is shared. Anything that is not a positive proof -- a
 * missing process, a failed or timed-out query, unreadable or ambiguous output,
 * an absent repoDir -- leaves ownership unproven, and unproven never authorizes
 * a signal.
 */
async function proveOwnership(pid, repoDir, lookupProcess) {
  if (!repoDir) return false;
  let info = null;
  try {
    info = await lookupProcess(pid);
  } catch {
    info = null;
  }
  return isOwnedOfflineProcess(info, repoDir);
}

export async function stopRecordedProcesses(state, databaseDir, options = {}) {
  const platform = options.platform ?? process.platform;
  const repoDir = options.repoDir ?? state?.repoDir ?? null;
  const lookupProcess = options.lookupProcess ?? defaultLookupProcess;
  const signalProcess = options.signalProcess ?? defaultSignalProcess;
  const wait = options.waitUntilDead ?? waitUntilDead;
  const alive = options.isProcessAlive ?? isProcessAlive;
  const lookupListenerPid = options.lookupListenerPid
    ?? (options.platform === undefined ? defaultLookupListenerPid : async () => null);

  const postmasterPid = databaseDir ? await readPostmasterPid(databaseDir) : null;
  let listenerPid = null;

  if (platform === 'win32' && Number.isInteger(state?.appPort)) {
    try {
      listenerPid = await lookupListenerPid(state.appPort);
    } catch {
      listenerPid = null;
    }
  }

  // A recorded PID was written by this launcher into runtime state and exists
  // nowhere else, so an unresolved one has to block: deleting the state file
  // would lose it permanently. A discovered PID is re-read from postmaster.pid
  // or the listening port on every call, so passing over one loses nothing.
  const recorded = uniquePids([state?.launcherPid, state?.nextPid, state?.postgresPid]);
  const isRecorded = new Set(recorded);
  const discovered = uniquePids([postmasterPid, listenerPid]).filter((pid) => !isRecorded.has(pid));

  const owned = [];
  const unproven = [];

  for (const pid of [...recorded, ...discovered]) {
    if (await proveOwnership(pid, repoDir, lookupProcess)) {
      owned.push(pid);
      continue;
    }
    // Liveness cannot prove ownership, but its absence does prove there is
    // nothing left to resolve.
    if (isRecorded.has(pid) && alive(pid)) unproven.push(pid);
  }

  for (const pid of owned) {
    try { signalProcess(pid); } catch { /* already gone */ }
  }

  const survivors = await wait(owned);
  const forceEligible = [];

  for (const pid of survivors) {
    if (await proveOwnership(pid, repoDir, lookupProcess)) forceEligible.push(pid);
  }

  for (const pid of forceEligible) {
    try { signalProcess(pid, 'SIGKILL'); } catch { /* already gone */ }
  }

  const unstopped = uniquePids(await wait(forceEligible, 2000));

  // Stopping a proven Next lets the launcher run its own exit path, so give any
  // unproven recorded PID the same bounded chance to disappear before the
  // lifecycle refuses to continue. Nothing here is ever signalled.
  const ambiguous = unproven.length ? uniquePids(await wait(unproven, 2000)) : [];

  return { unstopped, ambiguous };
}

export function inspectRuntime(state) {
  if (!state) {
    return {
      status: 'stopped',
      launcherAlive: false,
      nextAlive: false,
      postgresAlive: false,
    };
  }
  const launcherAlive = isProcessAlive(state.launcherPid);
  const nextAlive = isProcessAlive(state.nextPid);
  const postgresAlive = isProcessAlive(state.postgresPid);
  const running = launcherAlive || nextAlive || postgresAlive;
  return {
    status: running ? 'running' : 'stale',
    launcherAlive,
    nextAlive,
    postgresAlive,
  };
}

export function formatStatus(state, inspection) {
  if (!state || inspection.status === 'stopped') {
    return 'PPBF offline runtime: stopped';
  }
  if (inspection.status === 'stale') {
    return `PPBF offline runtime: stopped (stale state in ${state.repoDir})`;
  }
  return [
    'PPBF offline runtime: running',
    `  worktree: ${state.repoDir}`,
    `  app: http://127.0.0.1:${state.appPort}`,
    `  postgres: 127.0.0.1:${state.databasePort}`,
    `  launcher pid: ${state.launcherPid}${inspection.launcherAlive ? '' : ' (dead)'}`,
    `  next pid: ${state.nextPid}${inspection.nextAlive ? '' : ' (dead)'}`,
    `  postgres pid: ${state.postgresPid}${inspection.postgresAlive ? '' : ' (dead)'}`,
  ].join('\n');
}

export const HELP_TEXT = `PPBF offline runtime

  npm --workspace web run offline -- [--port 3100] [--reset]
  npm --workspace web run offline -- stop
  npm --workspace web run offline -- status
  npm --workspace web run offline -- restart [--port 3100] [--reset]

Start, stop, and status are scoped to this checkout's .ppbf-offline directory.
They will not stop another worktree's replica.
`;
