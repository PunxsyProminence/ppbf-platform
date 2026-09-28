// Detached companion of scripts/test-embedded-pg-server.mjs. Waits for that
// helper to end -- by any means, including the TerminateProcess that
// `serverProcess.kill('SIGTERM')` is on Windows -- then stops the Postgres
// cluster it owned, if it is still running, and removes the data directory.
// See scripts/lib/embedded-pg-cleanup.mjs for why the helper cannot do this
// itself.
//
//   node test-embedded-pg-janitor.mjs <helperPid> <dataDir> [--parent-pipe]
//
// With --parent-pipe, stdin is a pipe whose write end only the helper holds:
// EOF on it is the helper's death, delivered by the kernel with no polling.
// Without it (started by hand), the helper PID is polled once a second.

import { cleanupDataDir, isProcessAlive, readPostmasterPid } from './lib/embedded-pg-cleanup.mjs';

const helperPid = Number.parseInt(process.argv[2], 10);
const dataDir = process.argv[3];
const parentPipe = process.argv.includes('--parent-pipe');

if (!Number.isInteger(helperPid) || helperPid <= 0 || !dataDir) {
  console.error('Usage: node test-embedded-pg-janitor.mjs <helperPid> <dataDir> [--parent-pipe]');
  process.exit(1);
}

// postmaster.pid is read while the cluster is up and remembered, because the
// suites that remove their own directory can take the file away before the
// helper's death is noticed here -- and the postmaster's PID is the only way
// to find a child it left behind.
let postmaster = null;

await new Promise((resolve) => {
  const poll = setInterval(async () => {
    if (postmaster === null) postmaster = await readPostmasterPid(dataDir);
    if (!isProcessAlive(helperPid)) {
      clearInterval(poll);
      resolve();
    }
  }, 500);
  if (parentPipe) {
    const gone = () => {
      clearInterval(poll);
      resolve();
    };
    process.stdin.once('end', gone);
    process.stdin.once('close', gone);
    process.stdin.once('error', gone);
    process.stdin.resume();
  }
});

if (postmaster === null) postmaster = await readPostmasterPid(dataDir);
await cleanupDataDir(dataDir, { postmaster });
process.exit(0);
