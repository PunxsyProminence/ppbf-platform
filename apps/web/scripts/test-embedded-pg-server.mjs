// Runs a disposable, local-only embedded Postgres instance for the
// PostgreSQL-backed migration tests. This exists as a standalone native-ESM
// script because `embedded-postgres` ships ESM-only output that Jest's
// CommonJS transform can't load directly; the test file instead spawns this
// script as a child process and talks to the resulting server over plain
// TCP via the regular `pg` client.
//
// Never used against production or staging -- the data directory and port
// are test-scoped and torn down when this process receives SIGTERM.

import fs from 'node:fs/promises';

import AsyncExitHook from 'async-exit-hook';
import EmbeddedPostgres from 'embedded-postgres';

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
  await pg.start();
  // Signal readiness on its own line; the parent test process watches
  // stdout for this exact marker before connecting.
  console.log('EMBEDDED_PG_READY');
} catch (error) {
  console.error('EMBEDDED_PG_FAILED', error);
  await shutdown(1);
}
