// THE RUNTIME PROOF FOR THE GUARDIAN-CONTACT INVARIANT.
//
// "An athlete or a guardian must never receive another guardian's phone,
// email, or account_id through an intake/domain read. Authorized staff must
// retain the fields needed for legitimate emergency and administrative work."
//
// Unit tests prove the SQL string. The embedded-Postgres suite
// (guardianContactProjection.pg.test.ts) proves the rows a real database
// returns. Neither proves that the image actually running in an environment
// behaves that way -- a stale revision, a half-applied deploy, or a route that
// never made it into the build all pass every test in the repository. This
// signs in against the DEPLOYED application over HTTPS, as three different
// people, and reads what comes back.
//
// WHY THIS IS NOT A pilot:runtime-verify PROBE. That engine refuses, by
// design, any probe that sends a non-read-only method and treats 2xx as a pass
// (assertProbeCannotMutate in lib/runtime-probe.mjs) -- a probe must never be
// able to succeed at changing a real environment. /api/pilot/intake/domain-get
// is a POST that reads, so it cannot be expressed there without weakening that
// guard, and the guard is right. This is a separate, purpose-built check that
// borrows the same session-minting library and the same revoke discipline.
//
// IT WRITES NOTHING except its own short-lived session rows, and it revokes
// every one of them in a finally.

import { GUARDIAN_CONTACT_FIXTURE, guardianBSecrets } from './lib/guardian-contact-fixture.mjs';
import { mintGateSession } from './lib/gate-session.mjs';

const DOMAIN_GET_PATH = '/api/pilot/intake/domain-get';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required. This probe asserts a negative about a real response `
      + 'body, and a negative asserted against a missing fixture is a green light with nothing '
      + 'behind it. Refusing to run rather than report a pass.');
  }
  return value;
}

function resolveBaseUrl() {
  const raw = process.env.PILOT_GATE_BASE_URL?.trim();
  if (!raw) {
    throw new Error('PILOT_GATE_BASE_URL is required -- the deployed application to probe.');
  }
  const url = new URL(raw);
  // Never production, and never a plaintext hop: this request carries a live
  // session cookie for a guardian account.
  if (url.protocol !== 'https:') {
    throw new Error(`Refusing to send a session cookie over ${url.protocol} to ${url.host}.`);
  }
  return url.origin;
}

async function readDomainGet(baseUrl, cookie, athleteId) {
  const response = await fetch(`${baseUrl}${DOMAIN_GET_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ athlete_id: athleteId }),
  });
  const text = await response.text();
  return { status: response.status, text };
}

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`    ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (detail) console.log(`         ${detail}`);
}

/** Every secret must be absent from the body, and the body must be a real answer. */
function assertWithheld(name, { status, text }, secrets) {
  if (status !== 200) {
    record(name, false, `expected 200 from ${DOMAIN_GET_PATH}, observed ${status}`);
    return;
  }
  // A 200 carrying no guardian at all would pass every "does not contain"
  // check below while proving nothing. The reader must genuinely have read the
  // record, and seen the OTHER guardian in it by name.
  if (!text.includes(GUARDIAN_CONTACT_FIXTURE.parentB.fullName)) {
    record(name, false,
      'the response does not name the co-guardian at all, so this proves nothing: the fixture '
      + 'is missing or the reader was not admitted to the record.');
    return;
  }
  const leaked = secrets.filter((secret) => text.includes(secret));
  record(name, leaked.length === 0, leaked.length === 0
    ? `read the record, saw the co-guardian by name, and none of ${secrets.length} contact values`
    : `LEAKED ${leaked.length} value(s): ${leaked.join(', ')}`);
}

function assertRetained(name, { status, text }, expected) {
  if (status !== 200) {
    record(name, false, `expected 200 from ${DOMAIN_GET_PATH}, observed ${status}`);
    return;
  }
  const missing = expected.filter((value) => !text.includes(value));
  record(name, missing.length === 0, missing.length === 0
    ? `all ${expected.length} field(s) present, as an emergency caller needs`
    : `MISSING ${missing.length} field(s) staff must keep: ${missing.join(', ')}`);
}

async function run() {
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');
  const baseUrl = resolveBaseUrl();
  const athleteId = required('PILOT_SHADOW_ATHLETE_ID');

  const readers = [
    { key: 'guardianA', role: 'parent', accountId: required('PILOT_PROBE_GUARDIAN_A_ACCOUNT_ID') },
    { key: 'guardianB', role: 'parent', accountId: required('PILOT_PROBE_GUARDIAN_B_ACCOUNT_ID') },
    { key: 'athlete', role: 'athlete', accountId: required('PILOT_SHADOW_ATHLETE_ACCOUNT_ID') },
    { key: 'admin', role: 'organization_admin', accountId: required('PILOT_ADMIN_ACCOUNT_ID') },
  ];

  console.log('Guardian contact runtime probe');
  console.log('='.repeat(72));
  console.log(`base url:   ${baseUrl}`);
  console.log(`athlete_id: ${athleteId}`);
  console.log('');

  const sessions = new Map();
  try {
    for (const reader of readers) {
      sessions.set(reader.key, await mintGateSession({
        connectionString,
        accountId: reader.accountId,
        expectedRole: reader.role,
        ttlMinutes: 10,
      }));
    }

    const secretsOfB = guardianBSecrets(
      readers.find((reader) => reader.key === 'guardianB').accountId,
    );

    console.log('  the other household, and the child');
    assertWithheld(
      'guardian A cannot read guardian B\'s phone, email, account_id, or the staff-only note',
      await readDomainGet(baseUrl, sessions.get('guardianA').cookie, athleteId),
      secretsOfB,
    );
    assertWithheld(
      'the athlete cannot read either guardian\'s contact details',
      await readDomainGet(baseUrl, sessions.get('athlete').cookie, athleteId),
      [...secretsOfB, GUARDIAN_CONTACT_FIXTURE.parentA.phone, GUARDIAN_CONTACT_FIXTURE.parentA.email],
    );

    console.log('');
    console.log('  and the people who make the emergency call');
    assertRetained(
      'the organization admin still reads both guardians and the emergency contact in full',
      await readDomainGet(baseUrl, sessions.get('admin').cookie, athleteId),
      [
        GUARDIAN_CONTACT_FIXTURE.parentA.phone,
        GUARDIAN_CONTACT_FIXTURE.parentA.email,
        GUARDIAN_CONTACT_FIXTURE.parentB.phone,
        GUARDIAN_CONTACT_FIXTURE.parentB.email,
        GUARDIAN_CONTACT_FIXTURE.emergencyContact.notes,
      ],
    );
  } finally {
    for (const [key, session] of sessions) {
      await session.revoke().catch((error) => {
        console.error(`WARNING: could not revoke the ${key} probe session: ${String(error?.message || error)}`);
      });
    }
    console.log('');
    console.log(`sessions minted: ${sessions.size}, revoke attempted for all.`);
  }

  console.log('='.repeat(72));
  const failed = results.filter((result) => !result.ok);
  console.log(`tally: PASS=${results.length - failed.length} FAIL=${failed.length}`);
  if (failed.length > 0) {
    console.log('');
    console.log('GUARDIAN CONTACT PROBE FAIL');
    process.exit(1);
  }
  console.log('GUARDIAN CONTACT PROBE PASS');
}

try {
  await run();
} catch (error) {
  console.error('GUARDIAN CONTACT PROBE FAILED TO RUN');
  console.error(String(error?.message || error));
  process.exit(1);
}
