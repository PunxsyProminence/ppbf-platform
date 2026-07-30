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
// The athlete fixture IS provisioned here, and that deserves an explanation,
// because the original design was for intake promotion to create it through
// the real API. Gate run 30499019009 established that intake approval has
// been unreachable since #17: every uploaded document is born
// pending_security_review and no code path in the product can mark it clean,
// so promotion -- which requires approval -- can never run. Until the
// document-review feature exists, the athlete is provisioned directly so the
// SHADOW chat tiers can still be validated end to end. The guardian fixture
// stays unprovisioned: it has no role in chat validation, and creating it
// belongs to the promotion path the gate will exercise once approval works.

import { scrypt as nodeScrypt, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

const scrypt = promisify(nodeScrypt);

// Mirrors hashPin in src/server/pilot/security.ts exactly -- same derivation,
// same storage format -- so the provisioned PIN works with the real login path.
async function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(pin.trim(), salt, 64);
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

// --deactivate-athlete: clear the gate athlete's PIN hash and deactivate the
// account. The gate's athlete PIN is minted fresh per run and must not remain
// usable afterwards -- a literal PIN previously sat in deploy-staging.yml, in a
// PUBLIC repository, against a publicly reachable staging login, on an account
// written active with must_change_pin=false (audit PPBF-SEC-002). The workflow
// runs this in an always() step so a gate that fails partway through -- exactly
// when a live credential is most likely to be forgotten -- still cleans up.
const DEACTIVATE_ONLY = process.argv.includes('--deactivate-athlete');

async function run() {
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');

  // Refuse to write fixtures into a database the caller did not name. This
  // script creates accounts, an athlete, memberships and an organization; run
  // with a production connection string in the environment it will happily
  // create them there. That is not hypothetical -- it is how production came to
  // hold 361 rows pointing at organizations that do not exist (see the module
  // comment in lib/postgres-write-target.mjs). Asserted before connect() so a
  // wrong target costs no connection at all.
  assertDeclaredWriteTargetFromEnv(connectionString);

  const organizationId = required('PPBF_PILOT_DEFAULT_ORG_ID');
  const adminAccountId = required('PILOT_ADMIN_ACCOUNT_ID');
  const athleteAccountId = required('PILOT_SHADOW_ATHLETE_ACCOUNT_ID');
  const athleteId = required('PILOT_SHADOW_ATHLETE_ID');
  const athletePin = required('PILOT_SHADOW_ATHLETE_PIN');

  // Fixture-specific address on an RFC 2606 reserved TLD: cannot collide with
  // a real person's login_email under the unique lower(login_email) index, and
  // cannot receive mail.
  const adminLoginEmail = `${adminAccountId}.gate@ppbf.invalid`;

  const client = new Client({ connectionString, ssl: { rejectUnauthorized: true } });
  await client.connect();

  if (DEACTIVATE_ONLY) {
    try {
      const result = await client.query(
        `update pilot.accounts
         set pin_hash = null, active_flag = false, updated_at = now()
         where account_id = $1 and organization_id = $2 and role = 'athlete'
         returning account_id`,
        [athleteAccountId, organizationId],
      );
      await client.query(
        'delete from pilot.session_tokens where account_id = $1',
        [athleteAccountId],
      );
      console.log(result.rowCount > 0
        ? `Deactivated gate fixture athlete "${athleteAccountId}"; PIN cleared and sessions revoked.`
        : `Gate fixture athlete "${athleteAccountId}" not found — nothing to deactivate.`);
      console.log('GATE FIXTURE DEACTIVATE PASS');
    } finally {
      await client.end();
    }
    return;
  }

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

    // Athlete fixture: a real PIN-login athlete, same identities the intake
    // promotion path upserts, so when approval works the two paths converge on
    // one fixture instead of diverging. The PIN is hashed fresh on every run;
    // a re-run rotates the salt, which is harmless.
    const pinHash = await hashPin(athletePin);

    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Gate Athlete', '2011-02-10', '119', 'active',
               'Gate Guardian 555-0102', true, $3, now(), now())
       on conflict (organization_id, athlete_id) do update set
         active_flag = true,
         updated_at = now()`,
      [organizationId, athleteId, adminAccountId],
    );

    await client.query(
      `insert into pilot.accounts
         (account_id, login_email, auth_provider, role, organization_id,
          athlete_id, pin_hash, must_change_pin, active_flag)
       values ($1, null, 'ppbf_local', 'athlete', $2, $3, $4, false, true)
       on conflict (account_id) do update set
         auth_provider = excluded.auth_provider,
         role = excluded.role,
         organization_id = excluded.organization_id,
         athlete_id = excluded.athlete_id,
         pin_hash = excluded.pin_hash,
         must_change_pin = false,
         active_flag = true,
         updated_at = now()`,
      [athleteAccountId, organizationId, athleteId, pinHash],
    );

    await client.query(
      `insert into pilot.organization_memberships
         (account_id, organization_id, role, active_flag)
       values ($1, $2, 'athlete', true)
       on conflict (account_id, organization_id) do update set
         role = excluded.role,
         active_flag = true,
         updated_at = now()`,
      [athleteAccountId, organizationId],
    );

    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }

  console.log(`Provisioned gate fixture administrator "${adminAccountId}" in organization "${organizationId}".`);
  console.log(`Provisioned gate fixture athlete "${athleteAccountId}" (athlete_id ${athleteId}).`);
  console.log('GATE FIXTURE PROVISION PASS');
}

try {
  await run();
} catch (error) {
  console.error('GATE FIXTURE PROVISION FAIL');
  console.error(String(error));
  process.exit(1);
}
