// Refuses a fixture/seed write against a database the operator did not name.
//
// WHY THIS EXISTS
//
// On 2026-07-18 the SHADOW gates were deliberately run against the *production*
// endpoint and database as a verification exercise -- see
// docs/PHASE2_PRODUCTION_VERIFICATION_2026-07-18.md ("Execution order against
// production endpoint") and the Phase 3 companion document. Those runs used
// "disposable identities" scoped to per-run organization ids
// (org_phase2_20260718223012, gate_org_a_*, phase4-org-*, postdeploy-org-*,
// rerun_org_*, org-alpha, org-bravo). At the time the gate path did not create
// the pilot.organizations row those ids referred to.
//
// The result, measured against production on 2026-07-30: 361 rows across
// pilot.accounts (43), pilot.athletes (14), pilot.shadow_intake (31) and
// pilot.audit_events (273) whose organization_id resolves to no organization.
// That is what blocks the corrected multi-org FK migration from #53 -- the
// backfill fails with
// organization_memberships_organization_id_fkey.
//
// The deploy-staging workflow itself cannot cause this: it resolves the gate's
// connection string from `app-ppbf-staging` by name, not from inputs.target. The
// exposure is a run from a laptop or an agent shell that happens to hold a
// production connection string in the environment -- which is precisely what
// happened. Nothing in the fixture provisioner objected, because it had no
// notion of an intended target at all.
//
// The migration runners already solved this: they require
// PPBF_EXPECTED_POSTGRES_HOSTNAME / PPBF_EXPECTED_POSTGRES_DATABASE and throw
// POSTGRES_TARGET_MISMATCH when the connection string disagrees. This module
// applies the same contract, with the same error tokens, to scripts that write
// fixture data.
//
// Deliberately a separate implementation from the one inside
// pilot-apply-shadow-runtime-migration.mjs rather than a refactor of it: that
// file is an applied production migration runner, and rewiring its guard as a
// side effect of adding a guard elsewhere would put a working, load-bearing
// path at risk for a cosmetic gain. If they are ever unified, that should be
// its own change with its own review.

/**
 * Parses a PostgreSQL connection string down to the identity that matters for
 * "which database am I about to write to": lowercased hostname, and the
 * database name from the path.
 *
 * Throws bare machine tokens, never the connection string -- these messages are
 * printed by callers and a connection string carries credentials.
 */
export function parseConnectionTarget(connectionString) {
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('INVALID_POSTGRES_CONNECTION_STRING');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('INVALID_POSTGRES_PROTOCOL');
  }

  const hostname = parsed.hostname.toLowerCase();
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!hostname || !database) {
    throw new Error('INCOMPLETE_POSTGRES_TARGET');
  }

  return { hostname, database };
}

/**
 * Asserts the connection string points at the database the caller declared.
 *
 * Fails closed in both directions:
 *   * the expected values missing  -> MISSING_PPBF_EXPECTED_POSTGRES_HOSTNAME
 *                                     / MISSING_PPBF_EXPECTED_POSTGRES_DATABASE
 *   * the expected values present but disagreeing -> POSTGRES_TARGET_MISMATCH
 *
 * The missing case is an error rather than a skip on purpose. A guard that
 * silently does nothing when unconfigured protects the environments that
 * remembered to configure it and no others -- which is the same as no guard for
 * the ad-hoc laptop run this exists to stop.
 *
 * @param {string} connectionString
 * @param {{ hostname?: string, database?: string }} expected
 */
export function assertDeclaredWriteTarget(connectionString, expected = {}) {
  const expectedHostname = expected.hostname?.trim() || '';
  const expectedDatabase = expected.database?.trim() || '';

  if (!expectedHostname) {
    throw new Error('MISSING_PPBF_EXPECTED_POSTGRES_HOSTNAME');
  }
  if (!expectedDatabase) {
    throw new Error('MISSING_PPBF_EXPECTED_POSTGRES_DATABASE');
  }

  const target = parseConnectionTarget(connectionString);

  if (
    target.hostname !== expectedHostname.toLowerCase()
    || target.database !== expectedDatabase
  ) {
    throw new Error('POSTGRES_TARGET_MISMATCH');
  }

  return target;
}

/**
 * Reads the expected target from the environment and asserts it, so callers
 * do not each re-derive the variable names.
 */
export function assertDeclaredWriteTargetFromEnv(connectionString, env = process.env) {
  return assertDeclaredWriteTarget(connectionString, {
    hostname: env.PPBF_EXPECTED_POSTGRES_HOSTNAME,
    database: env.PPBF_EXPECTED_POSTGRES_DATABASE,
  });
}
