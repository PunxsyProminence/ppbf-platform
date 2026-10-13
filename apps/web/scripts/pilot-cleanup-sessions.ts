/**
 * Deletes sign-in session tokens that expired, or were revoked, more than the
 * retention window ago, across every organization.
 *
 * docs/DATA_RETENTION.md: "Session tokens | 30 days after expiration/revocation".
 * The window is SESSION_TOKEN_RETENTION_DAYS (src/server/pilot/sessionPolicy.ts);
 * the predicate is the one cleanupExpiredSessions and countExpiredSessions share
 * (src/server/pilot/auth.ts). Run by .github/workflows/session-token-cleanup.yml.
 * Until that workflow existed nothing called this, and pilot.session_tokens
 * kept every row it was ever given.
 *
 *   TARGET GUARD  Refuses to run unless PPBF_EXPECTED_POSTGRES_HOSTNAME and
 *                 PPBF_EXPECTED_POSTGRES_DATABASE match the connection string,
 *                 the same contract every migration runner, the retention sweep
 *                 and the session auto-close use (scripts/lib/postgres-write-target.mjs).
 *   DRY RUN       Default. Reports how many rows are due and deletes nothing.
 *                 PPBF_SESSION_CLEANUP_APPLY=true makes it delete.
 *   ONE LINE OUT  One JSON line of counts. No token hashes, no account ids: this
 *                 is printed into a CI log.
 *
 * Usage:
 *   npm run session:cleanup                                   # dry run, 30 days
 *   npm run session:cleanup -- 45                             # dry run, 45 days
 *   PPBF_SESSION_CLEANUP_APPLY=true npm run session:cleanup
 */

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';
import { parseRetentionDays, SESSION_TOKEN_RETENTION_DAYS } from '../src/server/pilot/sessionPolicy';

function emit(line: Record<string, unknown>, stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`${JSON.stringify(line)}\n`);
}

/**
 * A machine token for the log, never the connection string. pg surfaces a
 * refused connection as an AggregateError whose own message is EMPTY and
 * whose first inner error carries the code (ECONNREFUSED); see
 * pilot-close-inactive-sessions.ts, which this copies.
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
    emit({ event: 'session.cleanup.failed', reason: 'MISSING_CONNECTION_STRING' }, process.stderr);
    process.exit(1);
  }

  // Before anything that could open a connection.
  try {
    assertDeclaredWriteTargetFromEnv(connectionString);
  } catch (error) {
    emit({ event: 'session.cleanup.refused', reason: reasonFor(error) }, process.stderr);
    process.exit(1);
  }

  const retentionDays = process.argv[2] === undefined
    ? SESSION_TOKEN_RETENTION_DAYS
    : parseRetentionDays(process.argv[2]);
  const apply = process.env.PPBF_SESSION_CLEANUP_APPLY === 'true';

  // Imported only once the target is proven: the db module opens its pool on
  // first use from the same environment variable the guard just checked.
  const [{ cleanupExpiredSessions, countExpiredSessions }, { closePool }] = await Promise.all([
    import('../src/server/pilot/auth'),
    import('../src/server/pilot/db'),
  ]);
  try {
    if (apply) {
      const { deletedCount } = await cleanupExpiredSessions(retentionDays);
      emit({ event: 'session.cleanup.applied', retention_days: retentionDays, deleted: deletedCount });
    } else {
      const { dueCount } = await countExpiredSessions(retentionDays);
      emit({
        event: 'session.cleanup.dry_run',
        retention_days: retentionDays,
        would_delete: dueCount,
        note: 'set PPBF_SESSION_CLEANUP_APPLY=true to delete',
      });
    }
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  emit({ event: 'session.cleanup.failed', reason: reasonFor(error) }, process.stderr);
  process.exit(1);
});
