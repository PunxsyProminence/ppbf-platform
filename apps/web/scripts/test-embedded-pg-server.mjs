// Runs a disposable, local-only embedded Postgres instance for the
// PostgreSQL-backed migration tests. This exists as a standalone native-ESM
// script because `embedded-postgres` ships ESM-only output that Jest's
// CommonJS transform can't load directly; the test file instead spawns this
// script as a child process and talks to the resulting server over plain
// TCP via the regular `pg` client.
//
// Never used against production or staging -- the data directory and port
// are test-scoped and torn down when this process receives SIGTERM.
//
// ON WINDOWS THAT SIGTERM NEVER ARRIVES. Node's `kill()` there is
// TerminateProcess: this process ends mid-instruction and the handlers below
// never run, so a passing suite used to leave its data directory behind on
// every run. The detached janitor spawned below is what cleans up in that
// case (and after a Ctrl+C or tool timeout on any platform); the sweep
// removes what earlier runs left. Both live in lib/embedded-pg-cleanup.mjs,
// which explains the mechanism. PPBF_EMBEDDED_PG_JANITOR=off disables both --
// the cleanup suite uses that as its negative control.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import AsyncExitHook from 'async-exit-hook';
import EmbeddedPostgres from 'embedded-postgres';

import { sweepStaleDataDirs, writeHelperPid } from './lib/embedded-pg-cleanup.mjs';

// `embedded-postgres` registers its own SIGTERM/SIGINT handler at import time
// (`AsyncExitHook(gracefulShutdown)` in its module body, via the same
// `async-exit-hook` package imported above -- it is hoisted to a single
// shared copy in node_modules, so this is the same module instance and the
// unhook below actually removes embedded-postgres's listener). That handler
// calls `pg.stop()` and then forces `process.exit()` on its own timeline,
// with no knowledge of the `fs.rm` cleanup below. Because Node invokes every
// listener registered for a signal, both handlers run concurrently on
// SIGTERM/SIGINT: embedded-postgres's only awaits `pg.stop()` before exiting
// (no filesystem I/O after that), while ours also awaits `fs.rm(dataDir)`.
// The former reliably wins the race and calls `process.exit()` before our
// `fs.rm` promise settles, which is exactly how the data directory was
// leaking even on a passing run. Unhooking these two signals here makes our
// own handler below the sole authority over the shutdown order, so `fs.rm`
// is guaranteed to complete before this process exits.
AsyncExitHook.unhookEvent('SIGTERM');
AsyncExitHook.unhookEvent('SIGINT');

const dataDir = process.argv[2];
const port = Number.parseInt(process.argv[3], 10);

if (!dataDir || !Number.isFinite(port)) {
  console.error('Usage: node test-embedded-pg-server.mjs <dataDir> <port>');
  process.exit(1);
}

const cleanupEnabled = process.env.PPBF_EMBEDDED_PG_JANITOR !== 'off';

if (cleanupEnabled) {
  // Spawned before the cluster exists so nothing this process does afterwards
  // is uncovered. `detached` is what lets it outlive this process: libuv puts
  // every non-detached child in a kill-on-close job object, which is also
  // why Postgres itself ends with this process on Windows. The janitor's
  // stdin is the liveness signal -- this process holds the only write end,
  // and the kernel closes it when this process ends, however it ends.
  const janitor = spawn(
    process.execPath,
    [
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-embedded-pg-janitor.mjs'),
      String(process.pid),
      dataDir,
      '--parent-pipe',
    ],
    { detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true },
  );
  janitor.on('error', () => {});
  janitor.stdin.on('error', () => {});
  // Neither the child nor the pipe keeps this process alive: its lifetime is
  // still decided by Postgres and the suite that spawned it, as before.
  janitor.stdin.unref();
  janitor.unref();

  // Clusters earlier runs left behind (a janitor killed along with its run).
  // Live clusters owned by a live helper -- another suite running at the
  // same time -- are left alone.
  const swept = await sweepStaleDataDirs(path.dirname(path.resolve(dataDir)), { ownDataDir: dataDir });
  if (swept.removed.length > 0 || swept.failed.length > 0) {
    console.error(
      `EMBEDDED_PG_SWEEP removed=${swept.removed.length} failed=${swept.failed.length} skipped=${swept.skipped.length}`,
    );
  }
}

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: true, // this script owns cleanup of dataDir, not embedded-postgres
  // Windows otherwise inherits CP-1252; repository migrations are UTF-8.
  // Matches offline-runtime.mjs's existing initdbFlags for the same reason.
  initdbFlags: ['--encoding=UTF8'],
});

async function shutdown(exitCode) {
  try {
    // Fully stop Postgres (embedded-postgres's own gracefulShutdown listener
    // is unhooked above, so this is the only caller of `pg.stop()` and it is
    // awaited to completion) BEFORE attempting to remove its data directory.
    await pg.stop();
  } catch {
    // best-effort
  }
  try {
    // Awaited to completion before `process.exit` below, so a raced SIGTERM
    // can no longer truncate this cleanup (see the unhook above for why that
    // was previously possible).
    await fs.rm(dataDir, { recursive: true, force: true });
  } catch {
    // best-effort -- a lingering temp dir is not a correctness issue
  }
  process.exit(exitCode);
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

try {
  await pg.initialise();
  if (cleanupEnabled) {
    // After initdb (which refuses a non-empty directory) and before start, so
    // a sweep from another helper can tell this cluster is owned by a live
    // process from the moment it has a postmaster.
    await writeHelperPid(dataDir, process.pid);
  }
  await pg.start();
  // Signal readiness on its own line; the parent test process watches
  // stdout for this exact marker before connecting.
  console.log('EMBEDDED_PG_READY');
} catch (error) {
  console.error('EMBEDDED_PG_FAILED', error);
  await shutdown(1);
}
