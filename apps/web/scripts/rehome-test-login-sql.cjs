'use strict';

// One-off production data fix (Jason 2026-10-05, option B, recorded by
// overwatch in OWNER_DECISIONS): move ONE login out of the test organization
// `danielles` and into `punxsy_prominence` as a parent, so the normal parent
// screen (assertGuardianLoginProvisionable, then createOrUpdateMicrosoftStaffAccount)
// can attach it to the athlete instead of refusing it with
// "Forbidden: account already exists in another organization".
//
// This file holds the SQL and the decisions, so they are reviewed in the repo
// and proven by rehomeTestLogin.pg.test.ts. The runner that connects to
// production lives OUTSIDE the repo (Documents\PPBF-overwatch\
// prod-rehome-test-login.cjs): it prompts for the email at run time, verifies
// this file's sha256, and passes in a connected pg client. Nothing here reads
// a connection string, an environment variable, or argv.
//
// SHAPE. One transaction. Dry run by default: every statement runs, the
// report is built, then ROLLBACK. `apply: true` COMMITs only when every
// pre-condition held and every post-condition passed; otherwise it rolls back
// too. The report carries counts and flags only, never an id, an email or a
// name.
//
// WHY A CATALOG SCAN. A static list of "tables that key on account_id" is
// stale the day a migration adds one. So the run reads the live catalog: every
// pilot base-table column that is a foreign key to pilot.accounts(account_id),
// plus every text column whose name says it holds an account id (*account_id,
// *_by, coach_id, covering_coach_id, user_id). Both halves read pg_catalog, not
// information_schema, which hides columns the connected role holds no
// privilege on and would shrink the scan without an error. Each one is counted for this
// account. A column with rows that is neither HANDLED nor HISTORY below blocks
// the apply and is named in the report, so unknown test-org data is reported
// for a decision rather than moved or deleted blind.

const FROM_ORG = 'danielles';
const TO_ORG = 'punxsy_prominence';
const FROM_ROLE = 'organization_admin';
const TO_ROLE = 'parent';
const TO_AUTH_PROVIDER = 'magic_link';
const AUDIT_ACTION = 'ops_rehome_test_login_to_parent';

// Columns this module writes, and how. A row in one of these is expected.
const HANDLED = {
  'accounts.account_id': 'move',
  'organization_memberships.account_id': 'replace',
  'session_tokens.account_id': 'revoke',
  'magic_link_tokens.account_id': 'revoke',
  'account_activation_tokens.account_id': 'revoke',
  'shadow_rate_limit_buckets.account_id': 'delete',
  'labeller_credentials.account_id': 'delete',
  'board_seats.account_id': 'delete',
  'account_profiles.account_id': 'delete',
};

// Columns that record that this person DID something. Immutable history: left
// exactly as they are. None of them grants the account any access.
const HISTORY = new Set([
  'audit_events.actor_account_id',
  'shadow_audit_entries.actor_account_id',
  'shadow_events.actor_account_id',
  'shadow_telemetry_events.actor_account_id',
  'shadow_authority_checks.actor_account_id',
  'organizations.created_by_account_id',
]);

const ACCOUNT_COLUMN_SCAN_SQL = `
  with fk_columns as (
    select rel.relname as table_name, att.attname as column_name
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
      join lateral unnest(con.conkey) as k(attnum) on true
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
     where con.contype = 'f'
       and con.confrelid = 'pilot.accounts'::regclass
       and ns.nspname = 'pilot'
  ),
  named_columns as (
    select rel.relname as table_name, att.attname as column_name
      from pg_attribute att
      join pg_class rel on rel.oid = att.attrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
     where ns.nspname = 'pilot'
       and att.attnum > 0
       and not att.attisdropped
       and att.atttypid in ('text'::regtype, 'varchar'::regtype)
       and (att.attname ~ 'account_id$'
            or att.attname ~ '_by$'
            or att.attname in ('coach_id', 'covering_coach_id', 'user_id'))
  )
  select distinct cols.table_name::text as table_name, cols.column_name::text as column_name
    from (select * from fk_columns union select * from named_columns) cols
    join pg_class rel on rel.relname = cols.table_name
    join pg_namespace ns on ns.oid = rel.relnamespace and ns.nspname = 'pilot'
   where rel.relkind in ('r', 'p')
   order by 1, 2`;

function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function count(client, text, values) {
  const result = await client.query(text, values);
  return Number(result.rows[0].n);
}

async function scanAccountColumns(client, accountId) {
  const columns = (await client.query(ACCOUNT_COLUMN_SCAN_SQL)).rows;
  const rows = [];
  for (const { table_name: table, column_name: column } of columns) {
    const key = `${table}.${column}`;
    const n = await count(
      client,
      `select count(*)::int as n from pilot.${quoteIdent(table)} where ${quoteIdent(column)} = $1`,
      [accountId],
    );
    const disposition = HANDLED[key] || (HISTORY.has(key) ? 'history' : 'unhandled');
    rows.push({ column: key, rows: n, disposition });
  }
  return rows;
}

// The refusals assertGuardianLoginProvisionable (staffProvisioning.ts) gives an
// existing login, in its order, read on this transaction. accountIdHint is the
// account's own id: the parent screen must name the login the email already
// has, or the function refuses it as ACCOUNT_ID_HINT_NOT_KEPT.
async function provisionableChecks(client, email, accountId) {
  const found = await client.query(
    `select account_id, organization_id, role, auth_provider, is_platform_owner,
            deleted_at is not null as deleted, active_flag
       from pilot.accounts where lower(login_email) = $1`,
    [email],
  );
  const row = found.rows[0];
  const checks = [
    { name: 'exactly_one_login_for_email', ok: found.rows.length === 1 },
  ];
  if (row) {
    checks.push(
      { name: 'not_platform_owner', ok: !row.is_platform_owner && row.role !== 'platform_owner' },
      { name: 'organization_is_punxsy_prominence', ok: row.organization_id === TO_ORG },
      { name: 'role_is_parent', ok: row.role === TO_ROLE },
      { name: 'not_deleted', ok: !row.deleted },
      { name: 'auth_provider_not_ppbf_local', ok: row.auth_provider !== 'ppbf_local' },
      { name: 'active', ok: row.active_flag === true },
      { name: 'account_id_unchanged', ok: row.account_id === accountId },
    );
  }
  return checks;
}

/**
 * Runs the re-home on `client`, which must be connected and idle (no open
 * transaction). Returns a report of counts and flags; never throws past a
 * rollback.
 *
 * @param {import('pg').Client} client
 * @param {{ email: string, apply?: boolean }} options
 */
async function rehomeTestLogin(client, options) {
  const email = normalizeEmail(options && options.email);
  const apply = Boolean(options && options.apply === true);
  const report = {
    mode: apply ? 'apply' : 'dry_run',
    database: null,
    preconditions: [],
    flags: {},
    columns: [],
    blocking: [],
    statements: {},
    postconditions: [],
    status: 'FAIL',
    outcome: 'rolled_back',
    error: null,
  };

  if (!email || !email.includes('@')) {
    report.error = 'no email given';
    return report;
  }

  report.database = (await client.query('select current_database() as db')).rows[0].db;

  await client.query('begin');
  let committed = false;
  let commitSent = false;
  try {
    await client.query("set local lock_timeout = '5s'");
    await client.query("set local statement_timeout = '120s'");

    // Lock the login first, so nothing signs it in, re-roles or moves it
    // between these reads and the writes below. Matching on either column
    // means a second login that shares the address by account_id or by email
    // (any casing) makes the count 2 and refuses the run.
    const matched = await client.query(
      `select account_id, organization_id, role, auth_provider, active_flag,
              deleted_at is not null as deleted,
              coalesce(is_platform_owner, false) as is_platform_owner,
              lower(account_id) = $1 as id_matches,
              lower(login_email) = $1 as email_matches,
              account_id = lower(btrim(login_email)) as account_id_is_lowercase_email
         from pilot.accounts
        where lower(account_id) = $1 or lower(login_email) = $1
        for update`,
      [email],
    );
    const pre = report.preconditions;
    pre.push({ name: 'exactly_one_account_matches', ok: matched.rows.length === 1 });
    const account = matched.rows.length === 1 ? matched.rows[0] : null;

    if (account) {
      const accountId = account.account_id;
      // A flag, not a refusal: the parent screen must send this login's own
      // account_id as its hint, and an id that is not the lowercase email is
      // easy to get wrong there.
      report.flags.account_id_is_lowercase_email = account.account_id_is_lowercase_email;
      pre.push(
        { name: 'account_id_and_email_both_match', ok: account.id_matches && account.email_matches },
        { name: 'organization_is_danielles', ok: account.organization_id === FROM_ORG },
        { name: 'role_is_organization_admin', ok: account.role === FROM_ROLE },
        { name: 'not_deleted', ok: !account.deleted },
        // Never switch on a login somebody switched off: the move sets
        // active_flag, so this has to hold before it, not only after.
        { name: 'active', ok: account.active_flag === true },
        { name: 'not_platform_owner', ok: !account.is_platform_owner },
        { name: 'auth_provider_not_ppbf_local', ok: account.auth_provider !== 'ppbf_local' },
      );

      // Both organizations, held so neither is deleted or re-keyed under the
      // run. KEY SHARE, not UPDATE: FOR UPDATE would also block the key-share
      // lock every insert referencing the organization takes, stalling the
      // live gym's sign-ins and writes for the length of the run.
      const orgs = await client.query(
        `select organization_id from pilot.organizations
          where organization_id = any($1::text[]) for key share`,
        [[FROM_ORG, TO_ORG]],
      );
      const orgIds = orgs.rows.map((r) => r.organization_id);
      pre.push(
        { name: 'danielles_exists', ok: orgIds.includes(FROM_ORG) },
        { name: 'punxsy_prominence_exists', ok: orgIds.includes(TO_ORG) },
      );

      const memberships = await client.query(
        `select organization_id, role, active_flag from pilot.organization_memberships
          where account_id = $1 for update`,
        [accountId],
      );
      pre.push({
        name: 'only_membership_is_danielles_organization_admin',
        ok: memberships.rows.length === 1
          && memberships.rows[0].organization_id === FROM_ORG
          && memberships.rows[0].role === FROM_ROLE
          && memberships.rows[0].active_flag === true,
      });

      // Evidence that danielles is a test organization: no athlete, no
      // guardian record or link, and no other live login or membership.
      // Deleted athletes count too: a real gym that withdrew its athletes is
      // still a real gym.
      const evidence = await client.query(
        `select
           (select count(*) from pilot.athletes where organization_id = $1)::int as athletes,
           (select count(*) from pilot.guardian_links where organization_id = $1)::int as guardian_links,
           (select count(*) from pilot.parents where organization_id = $1)::int as parents,
           (select count(*) from pilot.accounts
             where organization_id = $1 and account_id <> $2
               and active_flag and deleted_at is null)::int as other_active_accounts,
           (select count(*) from pilot.organization_memberships
             where organization_id = $1 and account_id <> $2 and active_flag)::int as other_active_memberships`,
        [FROM_ORG, accountId],
      );
      const e = evidence.rows[0];
      report.test_org_evidence = e;
      pre.push(
        { name: 'danielles_has_no_athletes', ok: e.athletes === 0 },
        { name: 'danielles_has_no_guardian_links', ok: e.guardian_links === 0 },
        { name: 'danielles_has_no_parents', ok: e.parents === 0 },
        { name: 'danielles_has_no_other_active_accounts', ok: e.other_active_accounts === 0 },
        { name: 'danielles_has_no_other_active_memberships', ok: e.other_active_memberships === 0 },
      );

      // Rows the DELETE steps would remove must all be danielles' own; a
      // profile photo is a stored blob this script will not orphan.
      const deletable = await client.query(
        `select
           (select count(*) from pilot.labeller_credentials where account_id = $1 and organization_id <> $2)::int as labeller_elsewhere,
           (select count(*) from pilot.board_seats where account_id = $1 and organization_id <> $2)::int as seats_elsewhere,
           (select count(*) from pilot.account_profiles where account_id = $1 and organization_id <> $2)::int as profiles_elsewhere,
           (select count(*) from pilot.account_profiles where account_id = $1 and photo_blob_path is not null)::int as profiles_with_photo,
           (select count(*) from pilot.shadow_rate_limit_buckets where account_id = $1 and organization_id <> $2)::int as buckets_elsewhere`,
        [accountId, FROM_ORG],
      );
      const d = deletable.rows[0];
      pre.push(
        { name: 'labeller_credentials_only_in_danielles', ok: d.labeller_elsewhere === 0 },
        { name: 'board_seats_only_in_danielles', ok: d.seats_elsewhere === 0 },
        { name: 'account_profiles_only_in_danielles', ok: d.profiles_elsewhere === 0 },
        { name: 'account_profile_has_no_photo', ok: d.profiles_with_photo === 0 },
        { name: 'rate_limit_buckets_only_in_danielles', ok: d.buckets_elsewhere === 0 },
      );

      report.columns = await scanAccountColumns(client, accountId);
      report.blocking = report.columns.filter((c) => c.disposition === 'unhandled' && c.rows > 0);
      pre.push({ name: 'no_unhandled_table_has_rows', ok: report.blocking.length === 0 });

      if (pre.every((c) => c.ok)) {
        const s = report.statements;
        const rc = async (text, values) => (await client.query(text, values)).rowCount;

        // Every way back in, closed first.
        s.session_tokens_revoked = await rc(
          'update pilot.session_tokens set revoked_at = now() where account_id = $1 and revoked_at is null',
          [accountId],
        );
        s.magic_link_tokens_invalidated = await rc(
          `update pilot.magic_link_tokens set invalidated_at = now()
            where account_id = $1 and consumed_at is null and invalidated_at is null`,
          [accountId],
        );
        s.activation_tokens_superseded = await rc(
          `update pilot.account_activation_tokens set superseded_at = now()
            where account_id = $1 and consumed_at is null and superseded_at is null`,
          [accountId],
        );

        // Test-organization rows that would otherwise outlive the move.
        s.rate_limit_buckets_deleted = await rc(
          'delete from pilot.shadow_rate_limit_buckets where account_id = $1 and organization_id = $2',
          [accountId, FROM_ORG],
        );
        s.labeller_credentials_deleted = await rc(
          'delete from pilot.labeller_credentials where account_id = $1 and organization_id = $2',
          [accountId, FROM_ORG],
        );
        s.board_seats_deleted = await rc(
          'delete from pilot.board_seats where account_id = $1 and organization_id = $2',
          [accountId, FROM_ORG],
        );
        s.account_profiles_deleted = await rc(
          `delete from pilot.account_profiles
            where account_id = $1 and organization_id = $2 and photo_blob_path is null`,
          [accountId, FROM_ORG],
        );
        s.danielles_memberships_deleted = await rc(
          'delete from pilot.organization_memberships where account_id = $1 and organization_id = $2',
          [accountId, FROM_ORG],
        );

        // The move. Conditioned on the row still being what was locked and
        // read above; anything else writes nothing and fails the run.
        s.accounts_moved = await rc(
          `update pilot.accounts
              set organization_id = $2,
                  role = $3,
                  auth_provider = $4,
                  active_flag = true,
                  is_platform_owner = false,
                  has_master_shadow_access = false,
                  athlete_id = null,
                  pin_hash = null,
                  must_change_pin = false,
                  password_hash = null,
                  password_set_at = null,
                  updated_at = now()
            where account_id = $1
              and organization_id = $5
              and role = $6
              and deleted_at is null`,
          [accountId, TO_ORG, TO_ROLE, TO_AUTH_PROVIDER, FROM_ORG, FROM_ROLE],
        );
        s.punxsy_memberships_inserted = await rc(
          `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
           values ($1, $2, $3, true)`,
          [accountId, TO_ORG, TO_ROLE],
        );

        // Same table and columns writePilotAuditEvent (audit.ts) writes, on
        // this transaction, so the record commits or rolls back with the
        // move. No actor account: an operator ran a script, as in
        // pilot-cleanup-accounts.mjs.
        s.audit_events_written = await rc(
          `insert into pilot.audit_events
             (event_type, actor_account_id, actor_role, organization_id, entity_type, entity_id, details)
           values ('update', null, null, $1, 'account', $2, $3::jsonb)`,
          [
            TO_ORG,
            accountId,
            JSON.stringify({
              action: AUDIT_ACTION,
              from_organization_id: FROM_ORG,
              to_organization_id: TO_ORG,
              from_role: FROM_ROLE,
              to_role: TO_ROLE,
              to_auth_provider: TO_AUTH_PROVIDER,
              ruling: 'Jason 2026-10-05, option B (OWNER_DECISIONS)',
              session_tokens_revoked: s.session_tokens_revoked,
              magic_link_tokens_invalidated: s.magic_link_tokens_invalidated,
              activation_tokens_superseded: s.activation_tokens_superseded,
              rows_deleted: {
                shadow_rate_limit_buckets: s.rate_limit_buckets_deleted,
                labeller_credentials: s.labeller_credentials_deleted,
                board_seats: s.board_seats_deleted,
                account_profiles: s.account_profiles_deleted,
                organization_memberships: s.danielles_memberships_deleted,
              },
            }),
          ],
        );

        // Post-conditions, on this transaction, before any commit.
        const post = report.postconditions;
        post.push({ name: 'exactly_one_account_moved', ok: s.accounts_moved === 1 });
        post.push({ name: 'exactly_one_membership_inserted', ok: s.punxsy_memberships_inserted === 1 });
        post.push({ name: 'exactly_one_audit_event', ok: s.audit_events_written === 1 });
        for (const check of await provisionableChecks(client, email, accountId)) {
          post.push({ name: `provisionable_${check.name}`, ok: check.ok });
        }
        const after = (await client.query(
          `select
             (select count(*) from pilot.organization_memberships where account_id = $1)::int as memberships,
             (select count(*) from pilot.organization_memberships
               where account_id = $1 and organization_id = $2 and role = $3 and active_flag)::int as punxsy_parent_memberships,
             (select count(*) from pilot.session_tokens
               where account_id = $1 and revoked_at is null)::int as live_sessions,
             (select count(*) from pilot.magic_link_tokens
               where account_id = $1 and consumed_at is null and invalidated_at is null)::int as live_magic_links,
             (select count(*) from pilot.account_activation_tokens
               where account_id = $1 and consumed_at is null and superseded_at is null)::int as live_activation_tokens,
             (select count(*) from pilot.board_seats where account_id = $1)::int as board_seats,
             (select count(*) from pilot.labeller_credentials where account_id = $1)::int as labeller_credentials,
             (select count(*) from pilot.account_profiles where account_id = $1)::int as account_profiles,
             (select count(*) from pilot.accounts
               where account_id = $1 and pin_hash is null and password_hash is null
                 and athlete_id is null and auth_provider = $4)::int as credentials_cleared`,
          [accountId, TO_ORG, TO_ROLE, TO_AUTH_PROVIDER],
        )).rows[0];
        post.push(
          { name: 'only_membership_is_punxsy_parent', ok: after.memberships === 1 && after.punxsy_parent_memberships === 1 },
          { name: 'no_live_session', ok: after.live_sessions === 0 },
          { name: 'no_live_magic_link', ok: after.live_magic_links === 0 },
          { name: 'no_live_activation_token', ok: after.live_activation_tokens === 0 },
          { name: 'no_board_seat', ok: after.board_seats === 0 },
          { name: 'no_labeller_credential', ok: after.labeller_credentials === 0 },
          { name: 'no_account_profile', ok: after.account_profiles === 0 },
          { name: 'pin_password_athlete_cleared_and_magic_link', ok: after.credentials_cleared === 1 },
        );
        const rescan = await scanAccountColumns(client, accountId);
        post.push({
          name: 'no_unhandled_table_has_rows_after',
          ok: rescan.every((c) => c.disposition !== 'unhandled' || c.rows === 0),
        });

        report.status = post.every((c) => c.ok) ? 'PASS' : 'FAIL';
      } else {
        report.status = 'REFUSED';
      }
    } else {
      report.status = 'REFUSED';
    }

    if (apply && report.status === 'PASS') {
      // From here a lost connection leaves the outcome unknown: the server
      // may have committed. Never report that as "nothing changed".
      commitSent = true;
      await client.query('commit');
      committed = true;
      report.outcome = 'committed';
    } else {
      await client.query('rollback');
    }
  } catch (error) {
    if (commitSent && !committed) {
      report.outcome = 'unknown';
    } else if (!committed) {
      await client.query('rollback').catch(() => {});
    }
    report.status = 'FAIL';
    // A code and a short message; pg messages here name tables and
    // constraints, not row values.
    report.error = `${error && error.code ? `${error.code} ` : ''}${String(error && error.message).slice(0, 160)}`;
  }
  return report;
}

module.exports = {
  rehomeTestLogin,
  ACCOUNT_COLUMN_SCAN_SQL,
  HANDLED,
  HISTORY,
  FROM_ORG,
  TO_ORG,
  AUDIT_ACTION,
};
