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

import EmbeddedPostgres from 'embedded-postgres';

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
});

async function shutdown(exitCode) {
  try {
    await pg.stop();
  } catch {
    // best-effort
  }
  try {
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
