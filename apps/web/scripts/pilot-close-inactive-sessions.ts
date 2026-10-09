/**
 * Closes training sessions nobody checked out of, across every organization.
 *
 * The scheduled half of OD-2026-10-06-024 Q4 ("give 20 min before auto close
 * ... and keep record of the 20 min inactivity"). The rule itself lives in
 * src/server/pilot/sessionAutoClose.ts and is shared with the lazy sweep the
 * sessions list read runs; this script exists so a session nobody looks at
 * still closes. Run by .github/workflows/session-autoclose.yml, nightly.
 *
 * It is a TypeScript script run through tsx (like `session:cleanup`) rather
 * than a .mjs, so it imports the ONE SQL statement instead of carrying a
 * second copy that could drift from the tested one.
 *
 *   TARGET GUARD  Refuses to run unless PPBF_EXPECTED_POSTGRES_HOSTNAME and
 *                 PPBF_EXPECTED_POSTGRES_DATABASE match the connection string,
 *                 the same contract every migration runner and the retention
 *                 sweep use (scripts/lib/postgres-write-target.mjs).
 *   DRY RUN       Default. Reports what it WOULD close and closes nothing.
 *                 PPBF_SESSION_AUTOCLOSE_APPLY=true makes it act; the nightly
 *                 workflow sets that, a hand run or a dispatch does not.
 *   ONE LINE OUT  One JSON line of counts per run. No session or athlete ids:
 *                 this is printed into a CI log, and the athletes are minors.
 *
 * Usage:
 *   npm run pilot:close-inactive-sessions                              # dry run
 *   PPBF_SESSION_AUTOCLOSE_APPLY=true npm run pilot:close-inactive-sessions
 */

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

function emit(line: Record<string, unknown>, stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`${JSON.stringify(line)}\n`);
}

/**
 * A machine token for the log, never the connection string. pg surfaces a
 * refused connection as an AggregateError whose own message is EMPTY and
 * whose first inner error carries the code (ECONNREFUSED), so the message
 * alone would log as "" -- the one thing a failed nightly run must not say.
 */
function reasonFor(error: unknown): string {
  if (!(error instanceof Error)) return 'UNKNOWN';
  const inner = (error as { errors?: unknown[] }).errors?.[0] as { code?: string; message?: string } | undefined;
  const code = (error as { code?: string }).code ?? inner?.code;
  return error.message || code || inner?.message || error.name || 'UNKNOWN';
}

async function main(): Promise<void> {
  const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;
  if (!connectionString) {
    emit({ event: 'session.autoclose.failed', reason: 'MISSING_CONNECTION_STRING' }, process.stderr);
    process.exit(1);
  }

  // Before anything that could open a connection: the guard's refusal names
  // only a machine token, never the connection string.
  try {
    assertDeclaredWriteTargetFromEnv(connectionString);
  } catch (error) {
    emit({ event: 'session.autoclose.refused', reason: reasonFor(error) }, process.stderr);
    process.exit(1);
  }

  const apply = process.env.PPBF_SESSION_AUTOCLOSE_APPLY === 'true';

  // Imported only once the target is proven: the db module opens its pool on
  // first use from the same environment variable this guard just checked.
  const [{ runAutoCloseSweep }, { closePool }] = await Promise.all([
    import('../src/server/pilot/sessionAutoClose'),
    import('../src/server/pilot/db'),
  ]);
  try {
    const summary = await runAutoCloseSweep({ apply });
    emit({ event: apply ? 'session.autoclose.applied' : 'session.autoclose.dry_run', ...summary });
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  emit({ event: 'session.autoclose.failed', reason: reasonFor(error) }, process.stderr);
  process.exit(1);
});
