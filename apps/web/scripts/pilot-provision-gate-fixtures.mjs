// Provisions the pre-existing fixtures the SHADOW E2E gate requires.
//
// gate-session.mjs deliberately provisions NOTHING -- it refuses to mint a
// session for an account that does not exist, so a misconfigured environment
// produces a precise error instead of a gate that silently invents its own
// fixtures. That stance is correct and this script does not weaken it: it is
// the explicit, declared provisioning step, run as its own workflow step where
// its writes are visible in the run log, not a side effect buried in the gate.
//
// Why it exists: the staging database was recreated on 2026-07-26 when staging
// and production PostgreSQL were separated, and the first-ever enabled gate run
// (30497491164) refused with "Gate fixture account org_admin_shadow does not
// exist". Nothing in the repository created that account -- it predated the
// split and survived only in the old shared database.
//
// What it converges (idempotently, safe to re-run):
//   * the organization row (created if absent; an existing row is left alone,
//     so a suspended organization still fails the gate with a precise error)
//   * the administrator fixture account, as a Microsoft-authenticated
//     organization_admin -- privileged local (PIN) sessions are revoked on
//     first use by design, so 'microsoft' is the only provider the gate can use
//   * the account's active membership, which resolvePrincipal requires
//
// The athlete and guardian fixtures are NOT provisioned here on purpose: the
// gate creates those through the real intake-promotion API, which is part of
// what it is testing.

import { Client } from 'pg';

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

async function run() {
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');
  const organizationId = required('PPBF_PILOT_DEFAULT_ORG_ID');
  const adminAccountId = required('PILOT_ADMIN_ACCOUNT_ID');

  // Fixture-specific address on an RFC 2606 reserved TLD: cannot collide with
  // a real person's login_email under the unique lower(login_email) index, and
  // cannot receive mail.
  const adminLoginEmail = `${adminAccountId}.gate@ppbf.invalid`;

  const client = new Client({ connectionString, ssl: { rejectUnauthorized: true } });
  await client.connect();

  try {
    await client.query('begin');

    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, 'PPBF Gate Default Organization', 'active')
       on conflict (organization_id) do nothing`,
      [organizationId],
    );

    await client.query(
      `insert into pilot.accounts
         (account_id, login_email, auth_provider, role, organization_id,
          pin_hash, must_change_pin, active_flag)
       values ($1, $2, 'microsoft', 'organization_admin', $3, null, false, true)
       on conflict (account_id) do update set
         login_email = excluded.login_email,
         auth_provider = excluded.auth_provider,
         role = excluded.role,
         organization_id = excluded.organization_id,
         must_change_pin = false,
         active_flag = true,
         updated_at = now()`,
      [adminAccountId, adminLoginEmail, organizationId],
    );

    await client.query(
      `insert into pilot.organization_memberships
         (account_id, organization_id, role, active_flag)
       values ($1, $2, 'organization_admin', true)
       on conflict (account_id, organization_id) do update set
         role = excluded.role,
         active_flag = true,
         updated_at = now()`,
      [adminAccountId, organizationId],
    );

    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }

  console.log(`Provisioned gate fixture administrator "${adminAccountId}" in organization "${organizationId}".`);
  console.log('GATE FIXTURE PROVISION PASS');
}

try {
  await run();
} catch (error) {
  console.error('GATE FIXTURE PROVISION FAIL');
  console.error(String(error));
  process.exit(1);
}
