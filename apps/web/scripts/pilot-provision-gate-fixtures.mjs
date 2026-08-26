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

import { GUARDIAN_CONTACT_FIXTURE } from './lib/guardian-contact-fixture.mjs';
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

// The same two-condition test hatch 76 other scripts in this directory already
// carry; this file was the outlier, hardcoding rejectUnauthorized and therefore
// unable to reach an embedded Postgres. That is why it had no test at all,
// while creating accounts, memberships, an organization and an athlete.
//
// Both conditions are required and neither is settable by accident in a
// deployed environment: NODE_ENV is 'production' in the container, and the
// second variable exists nowhere but the test harness. A caller who sets both
// in production has bypassed far more than this.
function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
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

  // Read-only probe fixtures for pilot:runtime-verify. Deliberately OPTIONAL,
  // unlike everything above: this script already runs in a working pipeline,
  // and promoting these to required() would fail the next staging deploy for
  // anyone who has not set them yet -- including a developer running it by
  // hand. An unset one is skipped and SAID so at the end, never silently.
  //
  // They exist because the runtime-verify manifest's most valuable probes are
  // refusals -- a coach and even the platform owner must be refused by
  // org-admin-gated routes -- and there is no way to prove a refusal without a
  // session of the role being refused. gate-session.mjs will not invent one.
  //
  // Both are 'microsoft' for the same reason the administrator fixture is:
  // resolvePrincipal revokes any privileged ppbf_local session on sight, so a
  // PIN-backed coach or platform_owner would be destroyed by its own first use.
  const probeCoachAccountId = process.env.PILOT_PROBE_COACH_ACCOUNT_ID?.trim() || null;
  const probeOwnerAccountId = process.env.PILOT_PROBE_PLATFORM_OWNER_ACCOUNT_ID?.trim() || null;

  // THE SPLIT HOUSEHOLD, for the guardian-contact probe.
  //
  // Two guardians linked to ONE athlete, each carrying a phone, an email and
  // an account_id, plus an emergency-contact row naming the second of them.
  // That is not a contrived arrangement -- it is what one intake promotion
  // writes (IntakePromotionPayload carries a `guardian` block and an
  // `emergency_contact` block side by side) and it is the ordinary shape of a
  // separated family, and of one under a protective order.
  //
  // It exists because the property under test is a NEGATIVE about a real
  // response body: that Guardian A's read of this athlete contains no trace of
  // Guardian B's number. A negative cannot be proven against an empty table --
  // with one guardian and no emergency contact, every "must not contain" check
  // passes while proving nothing at all.
  //
  // Both are 'microsoft' for the same reason every other privileged fixture
  // is: resolvePrincipal revokes a privileged ppbf_local session on sight.
  const probeGuardianAAccountId = process.env.PILOT_PROBE_GUARDIAN_A_ACCOUNT_ID?.trim() || null;
  const probeGuardianBAccountId = process.env.PILOT_PROBE_GUARDIAN_B_ACCOUNT_ID?.trim() || null;
  const provisionSplitHousehold = Boolean(probeGuardianAAccountId && probeGuardianBAccountId);

  // Fixture-specific address on an RFC 2606 reserved TLD: cannot collide with
  // a real person's login_email under the unique lower(login_email) index, and
  // cannot receive mail.
  const adminLoginEmail = `${adminAccountId}.gate@ppbf.invalid`;

  const client = new Client({ connectionString, ssl: resolveSslConfig() });
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
      /* AND THE ACTIVATION CODES, or the cleanup above can be undone by
         whoever is holding one.

         Clearing pin_hash and revoking sessions leaves the account
         deactivated, which is the point. But an activation code issued
         earlier in the run and never redeemed is still live for its whole
         TTL, and redeeming it sets active_flag = true with a fresh pin_hash
         chosen by the redeemer. The account walks back up on its own.

         The window is real and it grew. The gate issues a code at step 9b and
         redeems it at 9d, and between those two now sit a deliberate refusal
         and two throttle round-trips -- so a throw anywhere in there leaves a
         working credential on a publicly reachable staging login, against an
         account the cleanup step just reported as deactivated.

         Superseded rather than deleted: the redeem path already filters on
         `superseded_at is null`, this is the same mechanism reissuing a code
         uses, and a deleted row destroys the record that the code ever
         existed. Only unconsumed, not-yet-superseded rows are touched, so
         nothing already spent is rewritten. */
      const codes = await client.query(
        `update pilot.account_activation_tokens
         set superseded_at = now()
         where account_id = $1
           and consumed_at is null
           and superseded_at is null
         returning token_hash`,
        [athleteAccountId],
      );
      console.log(result.rowCount > 0
        ? `Deactivated gate fixture athlete "${athleteAccountId}"; PIN cleared, sessions revoked, `
          + `${codes.rowCount} outstanding activation code(s) superseded.`
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

    // Probe fixtures. Same two-statement shape as the administrator above --
    // the account, then the membership resolvePrincipal joins -- and no PIN
    // hash at all, so neither can ever be used through the login form. They are
    // reachable only by a caller that can already read the database, which is
    // exactly the position gate-session.mjs is written for.
    for (const [probeAccountId, probeRole] of [
      [probeCoachAccountId, 'coach'],
      [probeOwnerAccountId, 'platform_owner'],
    ]) {
      if (!probeAccountId) continue;

      await client.query(
        `insert into pilot.accounts
           (account_id, login_email, auth_provider, role, organization_id,
            pin_hash, must_change_pin, active_flag)
         values ($1, $2, 'microsoft', $3, $4, null, false, true)
         on conflict (account_id) do update set
           login_email = excluded.login_email,
           auth_provider = excluded.auth_provider,
           role = excluded.role,
           organization_id = excluded.organization_id,
           pin_hash = null,
           must_change_pin = false,
           active_flag = true,
           updated_at = now()`,
        [probeAccountId, `${probeAccountId}.gate@ppbf.invalid`, probeRole, organizationId],
      );

      await client.query(
        `insert into pilot.organization_memberships
           (account_id, organization_id, role, active_flag)
         values ($1, $2, $3, true)
         on conflict (account_id, organization_id) do update set
           role = excluded.role,
           active_flag = true,
           updated_at = now()`,
        [probeAccountId, organizationId, probeRole],
      );
    }

    if (provisionSplitHousehold) {
      const { parentA, parentB, emergencyContact } = GUARDIAN_CONTACT_FIXTURE;

      for (const [accountId, parent] of [
        [probeGuardianAAccountId, parentA],
        [probeGuardianBAccountId, parentB],
      ]) {
        await client.query(
          `insert into pilot.accounts
             (account_id, login_email, auth_provider, role, organization_id,
              pin_hash, must_change_pin, active_flag)
           values ($1, $2, 'microsoft', 'parent', $3, null, false, true)
           on conflict (account_id) do update set
             login_email = excluded.login_email,
             auth_provider = excluded.auth_provider,
             role = excluded.role,
             organization_id = excluded.organization_id,
             pin_hash = null,
             must_change_pin = false,
             active_flag = true,
             updated_at = now()`,
          [accountId, `${accountId}.gate@ppbf.invalid`, organizationId],
        );

        await client.query(
          `insert into pilot.organization_memberships
             (account_id, organization_id, role, active_flag)
           values ($1, $2, 'parent', true)
           on conflict (account_id, organization_id) do update set
             role = excluded.role,
             active_flag = true,
             updated_at = now()`,
          [accountId, organizationId],
        );

        // The contact columns are the entire point: a probe that asserts a
        // phone number is absent proves nothing unless a phone number was
        // there to withhold.
        await client.query(
          `insert into pilot.parents
             (organization_id, parent_id, account_id, full_name, phone, email)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (organization_id, parent_id) do update set
             account_id = excluded.account_id,
             full_name = excluded.full_name,
             phone = excluded.phone,
             email = excluded.email,
             updated_at = now()`,
          [organizationId, parent.parentId, accountId, parent.fullName, parent.phone, parent.email],
        );

        await client.query(
          `insert into pilot.guardian_links
             (organization_id, parent_id, athlete_id, relationship_to_athlete)
           values ($1, $2, $3, $4)
           on conflict (organization_id, parent_id, athlete_id) do update set
             relationship_to_athlete = excluded.relationship_to_athlete,
             updated_at = now()`,
          [organizationId, parent.parentId, athleteId, parent.relationship],
        );
      }

      await client.query(
        `insert into pilot.emergency_contacts
           (organization_id, contact_id, athlete_id, full_name,
            relationship_to_athlete, phone, email, is_primary, notes)
         values ($1, $2, $3, $4, $5, $6, $7, true, $8)
         on conflict (organization_id, contact_id) do update set
           athlete_id = excluded.athlete_id,
           full_name = excluded.full_name,
           relationship_to_athlete = excluded.relationship_to_athlete,
           phone = excluded.phone,
           email = excluded.email,
           is_primary = true,
           notes = excluded.notes,
           updated_at = now()`,
        [
          organizationId,
          emergencyContact.contactId,
          athleteId,
          emergencyContact.fullName,
          emergencyContact.relationship,
          emergencyContact.phone,
          emergencyContact.email,
          emergencyContact.notes,
        ],
      );
    }

    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }

  for (const [probeAccountId, probeRole, variable] of [
    [probeCoachAccountId, 'coach', 'PILOT_PROBE_COACH_ACCOUNT_ID'],
    [probeOwnerAccountId, 'platform_owner', 'PILOT_PROBE_PLATFORM_OWNER_ACCOUNT_ID'],
  ]) {
    console.log(probeAccountId
      ? `Provisioned ${probeRole} probe fixture "${probeAccountId}" in organization "${organizationId}".`
      : `SKIPPED the ${probeRole} probe fixture: ${variable} is not set. `
        + 'pilot:runtime-verify will report its role probes as SKIPPED rather than invent a fixture.');
  }

  console.log(provisionSplitHousehold
    ? `Provisioned the split-household fixture on athlete_id ${athleteId}: guardians `
      + `"${probeGuardianAAccountId}" and "${probeGuardianBAccountId}", with the second also `
      + 'recorded as the emergency contact.'
    : 'SKIPPED the split-household fixture: PILOT_PROBE_GUARDIAN_A_ACCOUNT_ID and '
      + 'PILOT_PROBE_GUARDIAN_B_ACCOUNT_ID must BOTH be set. The guardian-contact probe will '
      + 'refuse to report a pass without it rather than assert a negative against an empty table.');

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
