// Types for postgres-write-target.mjs.
//
// The module is plain JavaScript with JSDoc, and it is consumed by .mjs
// scripts (which need no types) and, until 2026-10-03, by the TypeScript
// laptop seeder under tsconfig.scripts.json (both retired 2026-10-03, OD-2026-10-03-002 section 10). The
// declaration stays for the next TypeScript consumer: without it the import is
// TS7016, and the two ways to silence that are worse than this file --
// flipping allowJs weakens a setting chosen on purpose, and re-declaring the
// shape inside one consumer hides it from the next.
//
// postgresWriteTarget.test.ts exercises the runtime behaviour.
// seedDataWriteTarget.test.ts -- the consumer whose import needs this file --
// pins these names against the module's real runtime exports, so a rename
// cannot leave this file describing a module that no longer looks like it.

/** The identity that matters for "which database am I about to write to". */
export interface PostgresWriteTarget {
  hostname: string;
  database: string;
}

/**
 * Throws INVALID_POSTGRES_CONNECTION_STRING, INVALID_POSTGRES_PROTOCOL or
 * INCOMPLETE_POSTGRES_TARGET -- bare machine tokens, never the connection
 * string, which carries credentials.
 */
export function parseConnectionTarget(connectionString: string): PostgresWriteTarget;

/**
 * Throws MISSING_PPBF_EXPECTED_POSTGRES_HOSTNAME /
 * MISSING_PPBF_EXPECTED_POSTGRES_DATABASE when the expected values are absent,
 * and POSTGRES_TARGET_MISMATCH when they disagree with the connection string.
 * The missing case is an error rather than a skip on purpose.
 */
export function assertDeclaredWriteTarget(
  connectionString: string,
  expected?: { hostname?: string; database?: string },
): PostgresWriteTarget;

/** assertDeclaredWriteTarget, reading the expected target out of the environment. */
export function assertDeclaredWriteTargetFromEnv(
  connectionString: string,
  env?: Record<string, string | undefined>,
): PostgresWriteTarget;
