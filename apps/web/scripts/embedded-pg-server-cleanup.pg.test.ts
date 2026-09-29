import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

/**
 * scripts/test-embedded-pg-server.mjs must leave nothing behind when the
 * process that started it ends it without a signal handler running -- which
 * is every `serverProcess.kill('SIGTERM')` on Windows, and a Ctrl+C or tool
 * timeout anywhere. Before this suite existed, each pg suite left its
 * ~20 MB cluster under os.tmpdir() on every Windows run.
 *
 * Each test here starts the real helper the same way every other pg suite
 * does, then kills it the hard way (SIGKILL: no handler runs on any
 * platform, which is exactly what SIGTERM already means on Windows) and
 * watches what remains. The last test is the negative control: with the
 * janitor switched off, the same kill leaks -- so a green run of the others
 * is evidence about the janitor and not about the kill.
 */

const SERVER_SCRIPT_PATH = path.resolve(__dirname, 'test-embedded-pg-server.mjs');
const CLEANUP_LIB_URL = pathToFileURL(path.resolve(__dirname, 'lib/embedded-pg-cleanup.mjs')).href;

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

type PostgresProcess = { pid: number; ppid: number; forked: boolean };

type CleanupLib = {
  HELPER_PID_FILE: string;
  readPostmasterPid(dataDir: string): Promise<{ pid: number; dataDir: string } | null>;
  isProcessAlive(pid: number): boolean;
  listProcesses(): Promise<Map<number, string> | null>;
  listPostgresProcesses(): Promise<PostgresProcess[] | null>;
  isPostgresImage(name: string): boolean;
  cleanupDataDir(
    dataDir: string,
  ): Promise<{ dataDir: string; killed: boolean; orphansKilled: number[]; removed: boolean }>;
};

type Helper = { process: ChildProcess; dataDir: string; stderr: () => string };

let lib: CleanupLib;
const started: Helper[] = [];

beforeAll(async () => {
  lib = (await nativeDynamicImport(CLEANUP_LIB_URL)) as unknown as CleanupLib;
});

afterEach(async () => {
  for (const helper of started.splice(0)) {
    if (helper.process.exitCode === null) {
      try {
        helper.process.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    await lib.cleanupDataDir(helper.dataDir);
  }
});

/** The naming every suite uses, so anything this suite leaks is swept like the rest. */
function dataDirFor(slug: string): string {
  return path.join(os.tmpdir(), `ppbf-${slug}-pg-test-${Date.now()}`);
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not determine a free port')));
      }
    });
  });
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Exactly how every pg suite starts the helper. */
async function startHelper(dataDir: string, env: Record<string, string> = {}): Promise<Helper> {
  const port = await findFreePort();
  const child = spawn(process.execPath, [SERVER_SCRIPT_PATH, dataDir, String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  let stderrOutput = '';
  child.stderr.on('data', (chunk) => {
    stderrOutput += chunk.toString();
  });
  const helper: Helper = { process: child, dataDir, stderr: () => stderrOutput };
  started.push(helper);

  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input: child.stdout });
    const timeout = setTimeout(() => {
      rl.close();
      reject(new Error(`Embedded Postgres did not become ready in time. stderr:\n${stderrOutput}`));
    }, 120_000);
    rl.on('line', (line) => {
      if (line.includes('EMBEDDED_PG_READY')) {
        clearTimeout(timeout);
        rl.close();
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Embedded Postgres process exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });
  return helper;
}

/** No handler runs: what SIGTERM already is on Windows, and what a killed run is anywhere. */
async function hardKill(helper: Helper): Promise<void> {
  await new Promise<void>((resolve) => {
    helper.process.once('exit', () => resolve());
    helper.process.kill('SIGKILL');
  });
}

async function postmasterOf(dataDir: string): Promise<{ pid: number; dataDir: string }> {
  const postmaster = await lib.readPostmasterPid(dataDir);
  if (!postmaster) throw new Error(`no postmaster.pid in ${dataDir}`);
  return postmaster;
}

/** Every postgres process the given postmaster forked that is still running. */
async function childrenOf(postmasterPid: number): Promise<PostgresProcess[]> {
  const processes = await lib.listPostgresProcesses();
  if (processes === null) throw new Error('could not list postgres processes');
  return processes.filter((candidate) => candidate.ppid === postmasterPid);
}

/**
 * The cluster is fully gone: directory removed, postmaster ended, and none
 * of its forked children left running. The kills in this suite land within
 * milliseconds of the ready line, while the postmaster is still forking its
 * last children; a child forked at that instant is not ended with its
 * postmaster (observed on Windows), which is what the children check is for.
 */
async function expectClusterGone(dataDir: string, postmasterPid: number): Promise<void> {
  await waitUntil(async () => !(await exists(dataDir)), 60_000, `${dataDir} to be removed`);
  await waitUntil(
    async () => !lib.isProcessAlive(postmasterPid) && (await childrenOf(postmasterPid)).length === 0,
    30_000,
    `postmaster ${postmasterPid} and every child it forked to be gone`,
  );
}

describe('embedded pg helper: cleanup after a hard kill', () => {
  it('removes the cluster and its data directory after the helper is killed with no handler running', async () => {
    const helper = await startHelper(dataDirFor('cleanup-hardkill'));
    const postmaster = await postmasterOf(helper.dataDir);
    expect(lib.isProcessAlive(postmaster.pid)).toBe(true);
    const listed = await lib.listProcesses();
    expect(listed && lib.isPostgresImage(listed.get(postmaster.pid) ?? '')).toBe(true);
    const marker = await fs.readFile(path.join(helper.dataDir, lib.HELPER_PID_FILE), 'utf8');
    expect(marker.trim()).toBe(String(helper.process.pid));

    await hardKill(helper);

    await expectClusterGone(helper.dataDir, postmaster.pid);
  });

  it('a newer helper leaves a cluster a live helper still owns alone, and both are removed once killed', async () => {
    const first = await startHelper(dataDirFor('cleanup-owned'));
    const firstPostmaster = await postmasterOf(first.dataDir);
    // The second helper's startup sweep sees the first cluster: live
    // postmaster, live helper -- another suite running concurrently.
    const second = await startHelper(dataDirFor('cleanup-newer'));
    const secondPostmaster = await postmasterOf(second.dataDir);
    expect(await exists(first.dataDir)).toBe(true);
    expect(lib.isProcessAlive(firstPostmaster.pid)).toBe(true);
    expect((await postmasterOf(first.dataDir)).pid).toBe(firstPostmaster.pid);

    await hardKill(first);
    await hardKill(second);

    await expectClusterGone(first.dataDir, firstPostmaster.pid);
    await expectClusterGone(second.dataDir, secondPostmaster.pid);
  });

  it('a starting helper sweeps clusters earlier runs abandoned and keeps one still being created', async () => {
    const gone = spawnSync(process.execPath, ['-e', '0']).pid;
    const stale = dataDirFor('cleanup-stale');
    const abandoned = dataDirFor('cleanup-abandoned');
    const young = dataDirFor('cleanup-young');
    try {
      // A cluster whose postmaster is gone (a killed run, after its postgres ended).
      await fs.mkdir(stale);
      await fs.writeFile(path.join(stale, 'PG_VERSION'), '16\n');
      await fs.writeFile(path.join(stale, 'postmaster.pid'), `${gone}\n${stale.replace(/\\/g, '/')}\n`);
      // A cluster that never got a postmaster, untouched for longer than the stale threshold.
      await fs.mkdir(abandoned);
      await fs.writeFile(path.join(abandoned, 'PG_VERSION'), '16\n');
      const eleven = new Date(Date.now() - 11 * 60 * 1000);
      await fs.utimes(abandoned, eleven, eleven);
      // A cluster mid-initdb right now.
      await fs.mkdir(young);
      await fs.writeFile(path.join(young, 'PG_VERSION'), '16\n');

      const helper = await startHelper(dataDirFor('cleanup-sweeper'));
      const postmaster = await postmasterOf(helper.dataDir);

      expect(await exists(stale)).toBe(false);
      expect(await exists(abandoned)).toBe(false);
      expect(await exists(young)).toBe(true);
      const report = /EMBEDDED_PG_SWEEP removed=(\d+) failed=(\d+)/.exec(helper.stderr());
      expect(report).not.toBeNull();
      expect(Number(report![1])).toBeGreaterThanOrEqual(2);
      expect(report![2]).toBe('0');

      await hardKill(helper);
      await expectClusterGone(helper.dataDir, postmaster.pid);
    } finally {
      for (const dir of [stale, abandoned, young]) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('NEGATIVE CONTROL: with the janitor off the same kill leaks the directory, and cleanupDataDir recovers it', async () => {
    const helper = await startHelper(dataDirFor('cleanup-nojanitor'), { PPBF_EMBEDDED_PG_JANITOR: 'off' });
    const postmaster = await postmasterOf(helper.dataDir);
    expect(await exists(path.join(helper.dataDir, lib.HELPER_PID_FILE))).toBe(false);

    await hardKill(helper);
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    // The leak this change exists to stop.
    expect(await exists(helper.dataDir)).toBe(true);

    const result = await lib.cleanupDataDir(helper.dataDir);
    expect(result.removed).toBe(true);
    await expectClusterGone(helper.dataDir, postmaster.pid);
  });
});
