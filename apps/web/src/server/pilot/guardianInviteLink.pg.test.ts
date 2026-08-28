// Real PostgreSQL-backed test for guardian provisioning in staffProvisioning.ts.
//
// The failure this covers is silent by construction, which is why it needs a
// real database rather than a mocked client. Inviting someone as
// "Parent / Guardian" wrote pilot.accounts and pilot.organization_memberships
// and nothing else, while every parent read path resolves a child by joining
// pilot.parents on account_id and then pilot.guardian_links. Both halves are
// individually correct: the account signs in, the query runs and matches
// nothing. No error is raised anywhere, and a family sees an empty list.
//
// So the suite proves three things that cannot be proven by reading code:
//
// 1. The negative control -- an account row alone genuinely resolves zero
//    children against the real schema. If a future change made the account
//    sufficient on its own, the rest of this suite would pass while testing
//    nothing, so the broken shape is asserted directly.
//
// 2. Provisioning writes the account, pilot.parents and pilot.guardian_links
//    as one transaction, and the resolution query used by
//    /api/pilot/athletes/list and access.ts then returns exactly that child.
//
// 3. A refused link commits nothing. An athlete id from another organization,
//    or one that does not exist, must leave no account behind -- a half-written
//    guardian is the same silent failure by another route.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const TEST_DB_NAME = 'ppbf_test_guardian_invite_link';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-guardian-invite-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

/* ts-jest compiles a plain `await import()` to require(), which cannot load an
   ESM .mjs helper. Building it through Function keeps a real dynamic import in
   the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_A = 'org-guardian-a';
const ORG_B = 'org-guardian-b';
const COACH_A = 'coach-a@example.com';
const COACH_B = 'coach-b@example.com';

// The exact shape of the parent branch in /api/pilot/athletes/list. Restated
// here rather than imported so this suite fails if provisioning and that read
// ever stop agreeing about how a child is resolved.
let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let staffProvisioning: typeof import('./staffProvisioning');
let guardianAccess: typeof import('./guardianAccess');
let access: typeof import('./access');
let guardianConsent: typeof import('./guardianConsent');

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not determine a free port')));
      }
    });
  });
}

/**
 * The SHIPPED resolution, not a restatement of it.
 *
 * This helper used to run its own copy of the guardian join, and the copy
 * could not have been the real thing: it omitted `a.deleted_at is null`,
 * which guardianAccess's guardianAthleteIds carries, because this suite built
 * its database from the BASE SCHEMA ALONE and athletes.deleted_at arrives in
 * the data-retention migration. The column did not exist here, so the query
 * that runs in production could not run in this suite at all.
 *
 * That is the reason the schema below is now the full one. A suite that
 * proves guardian resolution against a database shape no environment has is
 * proving it about a query nothing executes -- and the specific thing its
 * copy could not see is whether a WITHDRAWN athlete still resolves, which is
 * exactly the access question this file exists to answer.
 *
 * Sorted here because guardianAthleteIds returns `select distinct` with no
 * ORDER BY -- the ordering was the copy's, not the contract's, and the
 * existing assertions in this file depend on it.
 */
async function resolvedChildren(organizationId: string, accountId: string): Promise<string[]> {
  const ids = await guardianAccess.guardianAthleteIds(organizationId, accountId);
  return [...ids].sort();
}

async function accountExists(accountId: string): Promise<boolean> {
  const result = await client.query('select 1 from pilot.accounts where account_id = $1', [accountId]);
  return result.rowCount === 1;
}

beforeAll(async () => {
  PG_PORT = await findFreePort();

  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => {
    stderrOutput += chunk.toString();
  });

  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input: serverProcess.stdout });
    const timeout = setTimeout(() => {
      rl.close();
      reject(new Error(`Embedded Postgres did not become ready in time. stderr:\n${stderrOutput}`));
    }, 120_000);

    rl.on('line', (line) => {
      if (line.includes('EMBEDDED_PG_READY')) {
        clearTimeout(timeout);
        rl.close();
        resolve();
      }
    });

    serverProcess.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Embedded Postgres process exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  // Base schema PLUS every migration, in dependency order -- the shape a
  // migrated environment actually has. Hand-picking a subset is how a suite
  // ends up unable to run the function it is testing.
  const { applyFullSchema } = (await nativeDynamicImport(
    pathToFileURL(FULL_SCHEMA_HELPER_PATH).href,
  )) as { applyFullSchema: (c: Client) => Promise<void> };
  await applyFullSchema(client);

  for (const orgId of [ORG_A, ORG_B]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active')`,
      [orgId],
    );
  }

  // pilot.athletes.coach_id is not null and carries a foreign key, so each gym
  // needs a coach before it can hold an athlete.
  await client.query(
    `insert into pilot.accounts (account_id, login_email, auth_provider, role, organization_id, is_platform_owner, athlete_id, pin_hash, active_flag)
     values ($1, $1, 'microsoft', 'coach', $3, false, null, null, true),
            ($2, $2, 'microsoft', 'coach', $4, false, null, null, true)`,
    [COACH_A, COACH_B, ORG_A, ORG_B],
  );

  // created_at/updated_at are not null with no default on pilot.athletes.
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values
       ($1, 'ath-a1', 'Alex Johnson', '2013-04-02', 'bantam', 'active', 'contact', true, $3, now(), now()),
       ($1, 'ath-a2', 'Sam Rivera', '2012-09-11', 'fly', 'active', 'contact', true, $3, now(), now()),
       ($2, 'ath-b1', 'Other Gym Child', '2012-02-20', 'fly', 'active', 'contact', true, $4, now(), now())`,
    [ORG_A, ORG_B, COACH_A, COACH_B],
  );

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  staffProvisioning = await import('./staffProvisioning');
  guardianAccess = await import('./guardianAccess');
  access = await import('./access');
  guardianConsent = await import('./guardianConsent');
});

afterAll(async () => {
  const { closePool } = await import('./db');
  await closePool();
  await client.end();

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(safetyTimer);
      resolve();
    };
    const safetyTimer = setTimeout(finish, 15_000);
    safetyTimer.unref();
    serverProcess.once('exit', finish);
    serverProcess.kill('SIGTERM');
  });
});

describe('the silent failure itself', () => {
  // Negative control. This is the state the old invite produced, written by
  // hand so the suite proves the hazard is real rather than assuming it.
  test('a parent account with no guardian rows resolves zero children and raises nothing', async () => {
    await client.query(
      `insert into pilot.accounts (account_id, login_email, auth_provider, role, organization_id, is_platform_owner, athlete_id, pin_hash, active_flag)
       values ('stranded@example.com', 'stranded@example.com', 'microsoft', 'parent', $1, false, null, null, true)`,
      [ORG_A],
    );
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ('stranded@example.com', $1, 'parent', true)`,
      [ORG_A],
    );

    // The account is indistinguishable from a healthy one at the account level.
    const account = await client.query<{ role: string; active_flag: boolean }>(
      'select role, active_flag from pilot.accounts where account_id = $1',
      ['stranded@example.com'],
    );
    expect(account.rows[0]).toEqual({ role: 'parent', active_flag: true });

    // And the read that matters returns an empty list, with no error.
    await expect(resolvedChildren(ORG_A, 'stranded@example.com')).resolves.toEqual([]);
  });

  test('listOrganizationGuardianLinks is what makes the stranded account visible', async () => {
    const links = await staffProvisioning.listOrganizationGuardianLinks(ORG_A);
    expect(links.some((link) => link.account_id === 'stranded@example.com')).toBe(false);
  });
});

describe('inviting a guardian writes the link that makes the account work', () => {
  const DANA = 'dana@example.com';

  test('the account, the guardian record and the link land together', async () => {
    const result = await staffProvisioning.createOrUpdateMicrosoftStaffAccount({
      loginEmail: DANA,
      organizationId: ORG_A,
      role: 'parent',
      guardian: { athleteId: 'ath-a1', fullName: 'Dana Johnson', relationshipToAthlete: 'mother' },
    });

    expect(result.created).toBe(true);
    expect(result.guardianLink).toEqual({ parentId: `par-${DANA}`, athleteId: 'ath-a1' });

    // The whole point: the read path now returns the child.
    await expect(resolvedChildren(ORG_A, DANA)).resolves.toEqual(['ath-a1']);
  });

  test('a second invite adds a second child to the same guardian record', async () => {
    await staffProvisioning.createOrUpdateMicrosoftStaffAccount({
      loginEmail: DANA,
      organizationId: ORG_A,
      role: 'parent',
      guardian: { athleteId: 'ath-a2', fullName: 'Dana Johnson', relationshipToAthlete: 'mother' },
    });

    await expect(resolvedChildren(ORG_A, DANA)).resolves.toEqual(['ath-a1', 'ath-a2']);

    const parents = await client.query(
      'select parent_id from pilot.parents where organization_id = $1 and account_id = $2',
      [ORG_A, DANA],
    );
    expect(parents.rowCount).toBe(1);
  });

  test('the console read reports both children, scoped to the organization', async () => {
    const links = await staffProvisioning.listOrganizationGuardianLinks(ORG_A);
    const forDana = links.filter((link) => link.account_id === DANA);

    expect(forDana.map((link) => link.athlete_full_name)).toEqual(['Alex Johnson', 'Sam Rivera']);
    expect(await staffProvisioning.listOrganizationGuardianLinks(ORG_B)).toEqual([]);
  });
});

describe('a refused link commits nothing', () => {
  test('an athlete id that does not exist leaves no account behind', async () => {
    await expect(
      staffProvisioning.createOrUpdateMicrosoftStaffAccount({
        loginEmail: 'typo@example.com',
        organizationId: ORG_A,
        role: 'parent',
        guardian: { athleteId: 'ath-typo', fullName: 'Typo Parent', relationshipToAthlete: 'mother' },
      }),
    ).rejects.toThrow('Missing athlete_id');

    await expect(accountExists('typo@example.com')).resolves.toBe(false);
  });

  // Athletes are minors, and the organization is the boundary that keeps one
  // gym's records out of another gym's hands.
  test('an athlete in another organization is refused, and no account is created', async () => {
    await expect(
      staffProvisioning.createOrUpdateMicrosoftStaffAccount({
        loginEmail: 'crossorg@example.com',
        organizationId: ORG_A,
        role: 'parent',
        guardian: { athleteId: 'ath-b1', fullName: 'Cross Org', relationshipToAthlete: 'mother' },
      }),
    ).rejects.toThrow('Missing athlete_id');

    await expect(accountExists('crossorg@example.com')).resolves.toBe(false);
  });
});

describe('removeGuardianLink', () => {
  const DANA = 'dana@example.com';

  test('detaching one child leaves the other resolving', async () => {
    await staffProvisioning.removeGuardianLink({
      organizationId: ORG_A,
      accountId: DANA,
      athleteId: 'ath-a2',
    });

    await expect(resolvedChildren(ORG_A, DANA)).resolves.toEqual(['ath-a1']);
  });

  /* These two own their fixtures rather than inheriting the shared DANA
     links, which the tests above deliberately mutate. Seeding a separate
     guardian with two children keeps a destructive case from depending on
     the order the file happens to run in. */
  const REVOKED = 'revoked-guardian@example.com';

  async function seedTwoChildGuardian(): Promise<void> {
    for (const athleteId of ['ath-a1', 'ath-a2']) {
      await staffProvisioning.createOrUpdateMicrosoftStaffAccount({
        loginEmail: REVOKED,
        organizationId: ORG_A,
        role: 'parent',
        guardian: { athleteId, fullName: 'Revoked Guardian', relationshipToAthlete: 'father' },
      });
    }
  }

  /* SLICE 1 required negative test: "unlinked guardian loses access".
     Proven against the shipped resolution now that this suite runs the real
     one -- detaching is not merely a row leaving a console read, it is the
     guardian ceasing to reach the child. */
  test('a detached child stops resolving through the real access path, immediately', async () => {
    await seedTwoChildGuardian();
    await expect(resolvedChildren(ORG_A, REVOKED)).resolves.toEqual(['ath-a1', 'ath-a2']);

    await staffProvisioning.removeGuardianLink({
      organizationId: ORG_A,
      accountId: REVOKED,
      athleteId: 'ath-a2',
    });

    await expect(resolvedChildren(ORG_A, REVOKED)).resolves.toEqual(['ath-a1']);
    await expect(
      guardianAccess.isGuardianLinkedToAthlete(ORG_A, REVOKED, 'ath-a2'),
    ).resolves.toBe(false);
    // Control: the child they still hold is unaffected, so the refusal above
    // is the unlink and not a guardian who reaches nothing.
    await expect(
      guardianAccess.isGuardianLinkedToAthlete(ORG_A, REVOKED, 'ath-a1'),
    ).resolves.toBe(true);
  });

  /* SLICE 1 required negative test: "old session cannot preserve access after
     relationship removal".

     The actor object is built ONCE and reused across the unlink -- it stands
     for a guardian already signed in when an admin detaches them. It carries
     accountId, role and organizationId and NO athlete scope, and that absence
     is what makes revocation immediate: nothing about which children they
     reach is held in the session, so every request re-derives it. If a future
     change ever cached an athlete list on the principal, this is the test
     that would catch it. */
  test('a principal built before the unlink does not keep its access afterwards', async () => {
    // Its own guardian: the case above already detached one of REVOKED's two
    // children, and removeGuardianLink refuses to take the last one.
    const SESSION_HELD = 'session-held-guardian@example.com';
    for (const athleteId of ['ath-a1', 'ath-a2']) {
      await staffProvisioning.createOrUpdateMicrosoftStaffAccount({
        loginEmail: SESSION_HELD,
        organizationId: ORG_A,
        role: 'parent',
        guardian: { athleteId, fullName: 'Session Held', relationshipToAthlete: 'mother' },
      });
    }

    const actor = {
      accountId: SESSION_HELD,
      role: 'parent' as const,
      organizationId: ORG_A,
      athleteId: null,
    };

    await expect(access.assertActorCanAccessAthlete(actor, 'ath-a2')).resolves.toBeUndefined();

    await staffProvisioning.removeGuardianLink({
      organizationId: ORG_A,
      accountId: SESSION_HELD,
      athleteId: 'ath-a2',
    });

    // Same object, no re-authentication, no new session.
    await expect(access.assertActorCanAccessAthlete(actor, 'ath-a2')).rejects.toThrow();
    // Control: the actor is still a working principal for the child they keep,
    // so the refusal above is the unlink rather than a broken actor.
    await expect(access.assertActorCanAccessAthlete(actor, 'ath-a1')).resolves.toBeUndefined();
  });

  // The one action that could recreate the original bug.
  test('refuses to detach the last child, and the link survives the attempt', async () => {
    await expect(
      staffProvisioning.removeGuardianLink({
        organizationId: ORG_A,
        accountId: DANA,
        athleteId: 'ath-a1',
      }),
    ).rejects.toThrow('Forbidden: this is the only athlete this guardian is linked to');

    await expect(resolvedChildren(ORG_A, DANA)).resolves.toEqual(['ath-a1']);
  });
});

/*
 * WHY A REAL DATABASE FOR THIS ONE.
 *
 * The claim being tested is not "removeGuardianLink throws on a status
 * string" -- a mocked client proves that, and staffProvisioning.test.ts
 * already does. The claim is that WITHOUT the refusal, deleting one row from
 * pilot.guardian_links changes the answer checkGuardianMediaConsent gives
 * about a child, because that function resolves an athlete's guardians from
 * that table live on every call. Two modules, one table, and no error
 * anywhere along the way -- exactly the silent shape the rest of this suite
 * exists for.
 *
 * So the first test here proves the mechanism by deleting the row BY HAND,
 * bypassing the guard entirely. If that test ever stops flipping the answer,
 * the refusal it justifies has become dead weight and should be re-argued
 * rather than kept out of habit.
 */
describe('an unlink cannot quietly clear a withdrawal', () => {
  const CONSENT_ATH = 'ath-consent-1';
  const SPARE_ATH = 'ath-consent-2';
  const WITHDRAWER = 'withdrawer@example.com';
  const CO_GUARDIAN = 'co-guardian@example.com';

  let withdrawerParentId: string;
  let coGuardianParentId: string;

  beforeAll(async () => {
    // Own athletes, not the shared ath-a1/ath-a2: those two accumulate
    // guardians from every test above, and a consent answer about an athlete
    // is a statement about ALL of their guardians. Borrowing them would make
    // these assertions depend on the order this file happens to run in.
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values
         ($1, $2, 'Consent Case', '2013-01-05', 'fly', 'active', 'contact', true, $4, now(), now()),
         ($1, $3, 'Consent Sibling', '2014-03-09', 'fly', 'active', 'contact', true, $4, now(), now())`,
      [ORG_A, CONSENT_ATH, SPARE_ATH, COACH_A],
    );

    // The withdrawing guardian holds TWO children, so the last-link rule is
    // not what refuses the unlink below -- the withdrawal is.
    for (const athleteId of [CONSENT_ATH, SPARE_ATH]) {
      await staffProvisioning.createOrUpdateMicrosoftStaffAccount({
        loginEmail: WITHDRAWER,
        organizationId: ORG_A,
        role: 'parent',
        guardian: { athleteId, fullName: 'Withdrawing Guardian', relationshipToAthlete: 'mother' },
      });
    }

    // A second guardian on the same child who HAS consented. This is what
    // makes the flip visible: with both present the answer is blocked, with
    // only this one present it is allowed.
    // Two children for this one too, so the last-link rule is not what
    // answers when their own link is removed below.
    for (const athleteId of [CONSENT_ATH, SPARE_ATH]) {
      await staffProvisioning.createOrUpdateMicrosoftStaffAccount({
        loginEmail: CO_GUARDIAN,
        organizationId: ORG_A,
        role: 'parent',
        guardian: { athleteId, fullName: 'Consenting Guardian', relationshipToAthlete: 'father' },
      });
    }

    const withdrawer = await guardianConsent.resolveActingParent(ORG_A, WITHDRAWER, CONSENT_ATH);
    const coGuardian = await guardianConsent.resolveActingParent(ORG_A, CO_GUARDIAN, CONSENT_ATH);
    if (!withdrawer || !coGuardian) {
      throw new Error('fixture: both guardians must resolve a parent row for this athlete');
    }
    withdrawerParentId = withdrawer.parentId;
    coGuardianParentId = coGuardian.parentId;

    await guardianConsent.grantMediaConsent({
      organizationId: ORG_A,
      athleteId: CONSENT_ATH,
      parentId: coGuardianParentId,
      signedByName: 'Consenting Guardian',
      coversVideo: true,
      publicUseAllowed: false,
    });
    await guardianConsent.withdrawMediaConsent({
      organizationId: ORG_A,
      athleteId: CONSENT_ATH,
      parentId: withdrawerParentId,
      signedByName: 'Withdrawing Guardian',
    });
  });

  test('the mechanism: deleting the link by hand DOES clear the withdrawal from the answer', async () => {
    const before = await guardianConsent.checkGuardianMediaConsent(ORG_A, CONSENT_ATH);
    expect(before.ok).toBe(false);
    expect(before.perGuardian.map((g) => g.status).sort()).toEqual(['signed', 'withdrawn']);

    // Straight to the table, around removeGuardianLink and its refusal. This
    // is the operation the refusal exists to prevent, performed here only to
    // show what it costs.
    await client.query(
      'delete from pilot.guardian_links where organization_id = $1 and parent_id = $2 and athlete_id = $3',
      [ORG_A, withdrawerParentId, CONSENT_ATH],
    );

    const after = await guardianConsent.checkGuardianMediaConsent(ORG_A, CONSENT_ATH);
    // The withdrawal was not reversed. The guardian who made it simply
    // stopped being asked -- and the athlete now reads as fully consented.
    expect(after.ok).toBe(true);
    expect(after.perGuardian.map((g) => g.status)).toEqual(['signed']);
    expect(after.perGuardian.some((g) => g.status === 'withdrawn')).toBe(false);

    // Put it back for the tests below.
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, $2, $3, 'mother')`,
      [ORG_A, withdrawerParentId, CONSENT_ATH],
    );
    await expect(
      guardianConsent.checkGuardianMediaConsent(ORG_A, CONSENT_ATH).then((c) => c.ok),
    ).resolves.toBe(false);
  });

  test('removeGuardianLink refuses while the withdrawal stands, and the link survives the attempt', async () => {
    await expect(
      staffProvisioning.removeGuardianLink({
        organizationId: ORG_A,
        accountId: WITHDRAWER,
        athleteId: CONSENT_ATH,
      }),
    ).rejects.toThrow('Forbidden: this guardian has withdrawn media consent for this athlete');

    // The refusal is only worth anything if it rolls back. Both the link and
    // the consent answer are unchanged.
    await expect(
      guardianAccess.isGuardianLinkedToAthlete(ORG_A, WITHDRAWER, CONSENT_ATH),
    ).resolves.toBe(true);
    const consent = await guardianConsent.checkGuardianMediaConsent(ORG_A, CONSENT_ATH);
    expect(consent.ok).toBe(false);
    expect(consent.perGuardian.some((g) => g.status === 'withdrawn')).toBe(true);
  });

  test("one guardian's withdrawal does not freeze the OTHER guardian's link", async () => {
    /* The refusal has to read the row belonging to the guardian being
       unlinked, not every row for the athlete. A check scoped by athlete
       alone passes the test above and every parameter assertion in
       staffProvisioning.test.ts -- it was written that way as a mutation and
       survived both -- while refusing an unlink that clears nothing.

       Nothing is cleared here: the withdrawing guardian keeps their link, so
       the answer stays blocked before and after. */
    const before = await guardianConsent.checkGuardianMediaConsent(ORG_A, CONSENT_ATH);
    expect(before.ok).toBe(false);

    await staffProvisioning.removeGuardianLink({
      organizationId: ORG_A,
      accountId: CO_GUARDIAN,
      athleteId: CONSENT_ATH,
    });

    await expect(
      guardianAccess.isGuardianLinkedToAthlete(ORG_A, CO_GUARDIAN, CONSENT_ATH),
    ).resolves.toBe(false);
    const after = await guardianConsent.checkGuardianMediaConsent(ORG_A, CONSENT_ATH);
    expect(after.ok).toBe(false);
    expect(after.perGuardian.map((g) => g.status)).toEqual(['withdrawn']);
  });

  test('the refusal is about THIS child -- the same guardian detaches from the sibling normally', async () => {
    // Control. Without this, a refusal that fired on any withdrawal anywhere
    // in the guardian's family would pass the test above and be wrong.
    await staffProvisioning.removeGuardianLink({
      organizationId: ORG_A,
      accountId: WITHDRAWER,
      athleteId: SPARE_ATH,
    });

    await expect(
      guardianAccess.isGuardianLinkedToAthlete(ORG_A, WITHDRAWER, SPARE_ATH),
    ).resolves.toBe(false);
    await expect(
      guardianAccess.isGuardianLinkedToAthlete(ORG_A, WITHDRAWER, CONSENT_ATH),
    ).resolves.toBe(true);
  });

  test('a fresh signed consent clears the refusal, and only the guardian can write one', async () => {
    // The way out, proven end to end. pilot.waivers is append-only, so the
    // new row supersedes the withdrawal for every reader at once -- there is
    // no separate "clear the withdrawal" step for an admin to reach for, and
    // that absence is the point.
    await guardianConsent.grantMediaConsent({
      organizationId: ORG_A,
      athleteId: CONSENT_ATH,
      parentId: withdrawerParentId,
      signedByName: 'Withdrawing Guardian',
      coversVideo: true,
      publicUseAllowed: false,
    });

    const consent = await guardianConsent.checkGuardianMediaConsent(ORG_A, CONSENT_ATH);
    expect(consent.ok).toBe(true);

    // SPARE_ATH is gone by now (the control above), so CONSENT_ATH is this
    // guardian's last link and the structural rule takes over. That is the
    // right refusal at this point and a different one -- the withdrawal is no
    // longer what is standing in the way.
    await expect(
      staffProvisioning.removeGuardianLink({
        organizationId: ORG_A,
        accountId: WITHDRAWER,
        athleteId: CONSENT_ATH,
      }),
    ).rejects.toThrow('Forbidden: this is the only athlete this guardian is linked to');
  });
});

/*
 * THE RACE ITSELF, against real PostgreSQL and a second connection.
 *
 * The unit suite asserts that removeGuardianLink ISSUES `for update` before
 * it reads the waiver. That is the shape of the fix, not the guarantee. The
 * guarantee is behavioural -- an unlink that meets a held lock waits for it,
 * and the read it does afterwards sees what the holder committed -- and
 * nothing executed it.
 *
 * The lock holder here stands for publication.ts's suppression sweep, which
 * takes `for update` on exactly these rows after a withdrawal commits. It is
 * simulated with a raw connection rather than by calling the sweep, because
 * what is being measured is this transaction's behaviour when the row is
 * locked by anyone; using the real sweep would drag its own retraction
 * semantics into a test about waiting.
 *
 * WHAT THIS DOES NOT CLAIM. The remaining window is unchanged and untested
 * here because it is not closable from this side: withdrawMediaConsent is a
 * bare autocommit insert into pilot.waivers that takes no lock at all, so an
 * insert landing between the read and the DELETE is still lost. Closing that
 * needs the write path to take this same lock before its insert. Stated in
 * the function's own comment and on the review thread; not papered over by a
 * green test that measures something narrower than the claim.
 */
describe('an unlink that meets a held lock waits for it', () => {
  const RACER = 'race-guardian@example.com';
  const RACE_ATH_A = 'ath-race-a';
  const RACE_ATH_B = 'ath-race-b';

  let racerParentId: string;

  beforeAll(async () => {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values
         ($1, $2, 'Race Case A', '2013-06-01', 'fly', 'active', 'contact', true, $4, now(), now()),
         ($1, $3, 'Race Case B', '2013-07-02', 'fly', 'active', 'contact', true, $4, now(), now())`,
      [ORG_A, RACE_ATH_A, RACE_ATH_B, COACH_A],
    );

    // Two children, so the last-link rule is not what answers below.
    for (const athleteId of [RACE_ATH_A, RACE_ATH_B]) {
      await staffProvisioning.createOrUpdateMicrosoftStaffAccount({
        loginEmail: RACER,
        organizationId: ORG_A,
        role: 'parent',
        guardian: { athleteId, fullName: 'Race Guardian', relationshipToAthlete: 'mother' },
      });
    }

    const racer = await guardianConsent.resolveActingParent(ORG_A, RACER, RACE_ATH_A);
    if (!racer) throw new Error('fixture: the racing guardian must resolve a parent row');
    racerParentId = racer.parentId;
  });

  test('it waits, then reads the withdrawal the holder let through, and refuses', async () => {
    /* SEQUENCING, and why each step is where it is:
     *
     *   1. A second connection takes `for update` on the row and holds it.
     *   2. removeGuardianLink is STARTED, not awaited. It gets as far as the
     *      lock and stops there.
     *   3. It is observed genuinely blocked, via pg_stat_activity. Without
     *      this the test would pass for the wrong reason if the lock were
     *      removed -- the unlink would simply run to completion before the
     *      withdrawal was written, and "it refused" would never be reached.
     *   4. The guardian withdraws WHILE the unlink is parked. This is the
     *      interleaving that used to lose the withdrawal.
     *   5. The holder releases. The unlink acquires the lock and reads the
     *      waiver in a new statement -- a fresh snapshot under READ COMMITTED
     *      -- and sees a withdrawal that did not exist when it started.
     *
     * NOTHING IS ASSERTED INSIDE THE TRY. consentWithdrawalRace.pg.test.ts
     * records why in its own words: an assertion that throws mid-block leaves
     * the lock held, the blocked transaction holding its pool connection, and
     * the suite hangs at teardown instead of failing. A test that cannot fail
     * cannot be watched to fail.
     */
    const holder = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await holder.connect();

    let unlinking: Promise<{ refusedWith: string | null }> | null = null;
    let observedBlocked = false;

    try {
      await holder.query('begin');
      await holder.query(
        `select 1 from pilot.guardian_links
          where organization_id = $1 and parent_id = $2 and athlete_id = $3
          for update`,
        [ORG_A, racerParentId, RACE_ATH_A],
      );

      unlinking = staffProvisioning
        .removeGuardianLink({ organizationId: ORG_A, accountId: RACER, athleteId: RACE_ATH_A })
        .then(() => ({ refusedWith: null }))
        .catch((error: unknown) => ({
          refusedWith: error instanceof Error ? error.message : String(error),
        }));

      for (let attempt = 0; attempt < 200 && !observedBlocked; attempt += 1) {
        const waiting = await client.query<{ pid: number }>(
          `select pid from pg_stat_activity
            where datname = current_database()
              and pid <> pg_backend_pid()
              and wait_event_type = 'Lock'`,
        );
        observedBlocked = (waiting.rowCount ?? 0) > 0;
        if (!observedBlocked) await new Promise((resolve) => setTimeout(resolve, 25));
      }

      // The withdrawal lands while the unlink is parked on the lock.
      await guardianConsent.withdrawMediaConsent({
        organizationId: ORG_A,
        athleteId: RACE_ATH_A,
        parentId: racerParentId,
        signedByName: 'Race Guardian',
      });
    } finally {
      await holder.query('rollback').catch(() => {});
      await holder.end().catch(() => {});
    }

    const outcome = await unlinking;

    // The negative control, asserted first: if the lock is gone this is false
    // and the test says so, rather than passing because the unlink happened
    // to finish early.
    expect(observedBlocked).toBe(true);
    expect(outcome?.refusedWith).toMatch(/Forbidden: this guardian has withdrawn media consent/);

    // The refusal rolled back: the link is still there and the withdrawal is
    // still the current answer.
    await expect(
      guardianAccess.isGuardianLinkedToAthlete(ORG_A, RACER, RACE_ATH_A),
    ).resolves.toBe(true);
    const consent = await guardianConsent.checkGuardianMediaConsent(ORG_A, RACE_ATH_A);
    expect(consent.perGuardian.some((g) => g.status === 'withdrawn')).toBe(true);
  });
});
