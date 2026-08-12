#!/usr/bin/env node

/**
 * Reports on, and optionally retires, accounts in pilot.accounts.
 *
 * The owner asked for the account table to be cleaned up: keep
 * Admin@punxsyprominence.org (platform owner), ppbf@ (gym 1), Danielle@ (gym 2)
 * and coach@; clear out what is left. What is left is not uniform -- see
 * docs/PLATFORM_EVIDENCE_BASELINE_HANDOFF.md open question 7 -- so this script
 * separates the part that is safe to automate (28 inactive rows left by the July
 * 2026 gate runs) from the part that needs a person (the owner's own login, an
 * outlook identity, a local probe account, a case-collision pair).
 *
 * The policy lives in scripts/lib/account-cleanup-plan.mjs and is unit-tested.
 * This file connects, prints, and writes.
 *
 *   READ-ONLY BY DEFAULT   A plain run opens `begin read only`, so the reporting
 *                          path cannot write even if a later edit to this file
 *                          gets it wrong. PPBF_ACCOUNT_CLEANUP_APPLY=true is the
 *                          only way to a writable transaction.
 *
 *   TARGET GUARD           Refuses unless PPBF_EXPECTED_POSTGRES_HOSTNAME and
 *                          PPBF_EXPECTED_POSTGRES_DATABASE match the connection
 *                          string -- the same contract the migration runners
 *                          use. An agent shell holding a production connection
 *                          string is what put 361 orphaned rows into production;
 *                          see scripts/lib/postgres-write-target.mjs.
 *
 *   SOFT DELETE ONLY       Sets deleted_at, clears active_flag, revokes
 *                          sessions. Hard deletion stays with
 *                          pilot-cleanup-deleted-data.mjs and its retention
 *                          window, which is also the only thing that makes this
 *                          recoverable.
 *
 *   BLAST RADIUS           Refuses if the plan would retire more than
 *                          PPBF_ACCOUNT_CLEANUP_MAX (default 40). The expected
 *                          set is 28. A run that suddenly wants more means the
 *                          keep list, the roles, or the active flags are not
 *                          what this was written against.
 *
 *   ONE TRANSACTION        Account updates, membership updates, session
 *                          revocations and the audit row commit together or not
 *                          at all.
 *
 * Usage:
 *   npm run pilot:cleanup-accounts
 *       Reports every account and its disposition. Writes nothing.
 *
 *   PPBF_ACCOUNT_CLEANUP_APPLY=true npm run pilot:cleanup-accounts
 *       Retires the accounts the report listed as `retire`.
 *
 *   PPBF_ACCOUNT_CLEANUP_ALSO='jason.c.neale@outlook.com,admin-local-probe'
 *       Confirms held accounts by login email or account id. This is the
 *       "confirming each one" step; there is no flag that confirms them all.
 *
 *   PPBF_ACCOUNT_CLEANUP_ALLOW_ORPHAN_ORGS='audit-test-gym3'
 *       Additionally required to retire the last administrator of an
 *       organization, which leaves that organization with nobody who can
 *       administer it.
 */

import { Pool } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';
import { maskEmailForRole, planAccountCleanup } from './lib/account-cleanup-plan.mjs';

const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;
if (!connectionString) {
  console.error(JSON.stringify({ event: 'account.cleanup.failed', reason: 'MISSING_CONNECTION_STRING' }));
  process.exit(1);
}

// Caught rather than thrown so that a refusal is one structured line, like every
// other exit here, instead of a stack trace with a connection string in it.
try {
  assertDeclaredWriteTargetFromEnv(connectionString);
} catch (error) {
  console.error(JSON.stringify({
    event: 'account.cleanup.refused',
    reason: error instanceof Error ? error.message : 'UNKNOWN_TARGET_ERROR',
  }));
  process.exit(1);
}

const apply = process.env.PPBF_ACCOUNT_CLEANUP_APPLY === 'true';

const maxRetire = Number.parseInt(process.env.PPBF_ACCOUNT_CLEANUP_MAX ?? '40', 10);
if (!Number.isFinite(maxRetire) || maxRetire < 0) {
  console.error(JSON.stringify({ event: 'account.cleanup.failed', reason: 'INVALID_MAX' }));
  process.exit(1);
}

function parseList(raw) {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

const alsoRetire = parseList(process.env.PPBF_ACCOUNT_CLEANUP_ALSO);
const allowOrphanOrganizationIds = parseList(process.env.PPBF_ACCOUNT_CLEANUP_ALLOW_ORPHAN_ORGS);

const pool = new Pool({ connectionString });

function describe(decision) {
  return {
    account_id: decision.account_id,
    login_email: maskEmailForRole(decision.login_email, decision.role),
    role: decision.role,
    organization_id: decision.organization_id,
    organization_status: decision.organization_status ?? null,
    active: decision.active_flag === true,
    disposition: decision.disposition,
    reason: decision.reason,
  };
}

async function main() {
  const client = await pool.connect();

  try {
    // The dry run's transaction is read only at the database, not merely by
    // convention in this file.
    await client.query(apply ? 'begin' : 'begin read only');

    const accounts = await client.query(
      `select a.account_id,
              a.login_email,
              a.role,
              a.organization_id,
              a.is_platform_owner,
              a.athlete_id,
              a.active_flag,
              a.deleted_at,
              o.status as organization_status
         from pilot.accounts a
         left join pilot.organizations o on o.organization_id = a.organization_id
        order by a.organization_id, a.role, a.login_email nulls last, a.account_id`,
    );

    const plan = planAccountCleanup(accounts.rows, { alsoRetire, allowOrphanOrganizationIds });

    // The whole table, with a reason against each row. This is the artifact the
    // owner confirms against, so it prints in full on every run -- including
    // apply runs, where it is the record of what the run was looking at.
    console.log(JSON.stringify({
      event: 'account.cleanup.plan',
      apply,
      total: accounts.rows.length,
      counts: {
        keep: plan.keep.length,
        hold: plan.hold.length,
        retire: plan.retire.length,
        already_soft_deleted: plan.skip.length,
      },
      accounts: plan.decisions.map(describe),
    }, null, 2));

    // Two rows sharing a login email once case is folded. Reported separately
    // because the plan above shows them as `keep` -- correctly, since nothing
    // should happen to them -- and that alone would not tell the owner a
    // duplicate exists. Resolving it is a rename or a merge, not a retirement,
    // so this is a notice rather than a refusal.
    if (plan.collisions.length > 0) {
      console.log(JSON.stringify({
        event: 'account.cleanup.login-email-collision',
        note: 'these rows share a login email once case is folded; nothing was done to them',
        accounts: plan.collisions.map(describe),
      }));
    }

    if (plan.unmatchedNames.length > 0) {
      await client.query('rollback');
      console.error(JSON.stringify({
        event: 'account.cleanup.refused',
        reason: 'NAMED_IDENTITY_NOT_FOUND',
        names: plan.unmatchedNames,
      }));
      process.exitCode = 1;
      return;
    }

    if (plan.refusedNames.length > 0) {
      await client.query('rollback');
      console.error(JSON.stringify({
        event: 'account.cleanup.refused',
        reason: 'NAMED_IDENTITY_IS_PROTECTED',
        accounts: plan.refusedNames,
      }));
      process.exitCode = 1;
      return;
    }

    // A named account that stayed on hold means a guard the name does not lift
    // -- a parent, or a last admin whose organization is not in the orphan
    // allowance. Loud, because the operator asked for something that did not
    // happen.
    if (plan.blockedNames.length > 0) {
      await client.query('rollback');
      console.error(JSON.stringify({
        event: 'account.cleanup.refused',
        reason: 'NAMED_IDENTITY_STILL_GUARDED',
        accounts: plan.blockedNames,
      }));
      process.exitCode = 1;
      return;
    }

    if (plan.retire.length > maxRetire) {
      await client.query('rollback');
      console.error(JSON.stringify({
        event: 'account.cleanup.refused',
        reason: 'BLAST_RADIUS_EXCEEDED',
        retire: plan.retire.length,
        max: maxRetire,
      }));
      process.exitCode = 1;
      return;
    }

    if (!apply) {
      await client.query('rollback');
      console.log(JSON.stringify({
        event: 'account.cleanup.dry-run',
        retire: plan.retire.length,
        hold: plan.hold.length,
        note: 'set PPBF_ACCOUNT_CLEANUP_APPLY=true to retire the listed accounts',
      }));
      return;
    }

    if (plan.retire.length === 0) {
      await client.query('rollback');
      console.log(JSON.stringify({ event: 'account.cleanup.completed', retired: 0, sessions_revoked: 0 }));
      return;
    }

    const ids = plan.retire.map((decision) => decision.account_id);

    // `role <> 'parent'` and `deleted_at is null` restate guarantees the planner
    // already makes. They are here because this statement is the one that can
    // fire pilot.cascade_parent_deletion across minors' records, and a
    // WHERE clause is cheaper than trusting that no future edit to the planner
    // ever lets a parent through.
    const retired = await client.query(
      `update pilot.accounts
          set deleted_at = now(),
              active_flag = false,
              updated_at = now()
        where account_id = any($1::text[])
          and role <> 'parent'
          and deleted_at is null
        returning account_id`,
      [ids],
    );

    // Memberships are a separate table with its own active_flag; leaving them
    // active would keep a retired account listed as staff of its organization.
    await client.query(
      `update pilot.organization_memberships
          set active_flag = false,
              updated_at = now()
        where account_id = any($1::text[])
          and active_flag = true`,
      [ids],
    );

    const revoked = await client.query(
      `update pilot.session_tokens
          set revoked_at = now()
        where account_id = any($1::text[])
          and revoked_at is null
        returning token_hash`,
      [ids],
    );

    // organization_id is null: this run spans organizations, and the column is a
    // foreign key to a single one.
    await client.query(
      `insert into pilot.audit_events (event_type, organization_id, entity_type, entity_id, details)
       values ($1, null, 'account_cleanup', 'system', $2)`,
      [
        'data_deletion_initiated',
        JSON.stringify({
          retired_account_ids: retired.rows.map((row) => row.account_id),
          retired_count: retired.rows.length,
          sessions_revoked: revoked.rows.length,
          held_count: plan.hold.length,
          reasons: plan.retire.reduce((totals, decision) => ({
            ...totals,
            [decision.reason]: (totals[decision.reason] ?? 0) + 1,
          }), {}),
          confirmed_identities: alsoRetire,
          orphan_organizations_allowed: allowOrphanOrganizationIds,
        }),
      ],
    );

    await client.query('commit');

    console.log(JSON.stringify({
      event: 'account.cleanup.completed',
      retired: retired.rows.length,
      sessions_revoked: revoked.rows.length,
      held: plan.hold.length,
    }));
  } catch (error) {
    await client.query('rollback').catch(() => {});
    // Identifier only: this runs against a database of minors' records and its
    // output goes to a terminal or a CI log.
    console.error(JSON.stringify({
      event: 'account.cleanup.failed',
      reason: error instanceof Error ? error.name : 'UnknownError',
      code: error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined,
    }));
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

await main();
