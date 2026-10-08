// Real PostgreSQL-backed proof of lane W2 (build plan 2026-10-08), three
// rulings on who a record still answers for:
//
//   1. THE GUARDIAN LINK GOES DORMANT AT 18 (OD-2026-10-07-008, question card
//      1 item 3, Jason: "Goes dormant at 18"). Every guardian read in
//      guardianAccess.ts, the portrait relationship in profileDb.ts and both
//      consent writers in guardianConsent.ts stop answering for the guardian
//      from the gym's calendar day of the 18th birthday. The link row stays;
//      staff reads do not change.
//   2. ADMIN-01 (deletion scope B): the admin roster read never returns a
//      deleted athlete, and a membership cannot be created for one.
//   3. N7 (OD-2026-10-06-025 r2, scope B): a deleted nominator or voter in the
//      One Percent Club is not named from the stored display-name copy.
//
// EVERY READER IS RUN BOTH WAYS, as deletionScopeB.pg.test.ts does: a reader
// that returned nothing at all would pass every "after" assertion, so each
// is first seen answering for the live row (the positive control), and a
// live control stays visible after the mark.
//
// WHY REAL POSTGRES. Items 2 and 3 are SQL predicates (a CASE over
// accountNotDeletedSql, a deleted_at filter), and item 1's write side reads
// the athlete row inside the write transaction; a mocked db can only be asked
// whether a string contains the right words.
//
// Spins up the same disposable, local-only embedded Postgres the other suites
// use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

// Routes every module's queries into the embedded database. withTransaction
// runs on the SAME client, so a consent write and the age read it makes are
// one unit of work here exactly as in production.
let activeClient: Client | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows[0] ?? null;
  }),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    await activeClient.query('BEGIN');
    try {
      const result = await fn(activeClient);
      await activeClient.query('COMMIT');
      return result;
    } catch (error) {
      await activeClient.query('ROLLBACK');
      throw error;
    }
  }),
}));

import { getAthletesByOrganization } from './entities';
import {
  guardianAthleteIds,
  guardianParentIdForAthlete,
  isGuardianLinkedToAthlete,
} from './guardianAccess';
import {
  checkGuardianMediaConsent,
  grantMediaConsent,
  GuardianLinkEndedError,
  withdrawMediaConsent,
} from './guardianConsent';
import { getNomination, listMembers, listNominations, listVotes } from './onePercentClub';
import { getSubjectIdentity, resolveRelationship } from './profileDb';
import { createMembership } from './programMemberships';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const PG_DATABASE = 'ppbf_test_w2_identity_reach';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-w2-identity-reach-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const ORG = 'org-w2';
const ADMIN = 'acct-w2-admin';
const COACH = 'acct-w2-coach';
/** The guardian of all three children below. */
const GUARDIAN = 'acct-w2-guardian';
const PARENT_ROW = 'parent-w2';

/** Turned 18 today on the gym's calendar day. */
const ADULT = 'ATH-W2-ADULT';
const ADULT_ACCOUNT = 'acct-w2-adult';
/** Turns 18 tomorrow at the gym: a minor until local midnight. */
const TOMORROW = 'ATH-W2-TOMORROW';
const TOMORROW_ACCOUNT = 'acct-w2-tomorrow';
/** Years from 18. */
const KID = 'ATH-W2-KID';

/** Marked deleted in item 2. */
const GONE = 'ATH-W2-GONE';
/** The item 2 control. */
const LIVE = 'ATH-W2-LIVE';

/** Item 3: a coach and an admin whose logins are marked deleted. */
const GONE_COACH = 'acct-w2-gone-coach';
const GONE_ADMIN = 'acct-w2-gone-admin';
/** Item 3: an athlete nominator whose ATHLETE ROW is marked deleted, login left open. */
const NOMINATOR = 'ATH-W2-NOMINATOR';
const NOMINATOR_ACCOUNT = 'acct-w2-nominator';

const NOM_BY_COACH = 'nom-w2-by-coach';
const NOM_BY_ATHLETE = 'nom-w2-by-athlete';
const NOM_BY_ADMIN = 'nom-w2-by-admin';
const NOM_CONTROL = 'nom-w2-control';

/* The same gym-day arithmetic the rule uses (wallDisplay.ageInYears reads
   today in America/New_York), so the two fixture birthdays sit exactly on
   either side of the boundary whatever clock the test runs on. */
const gymYmd = (date: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const minus18 = (ymd: string) => `${Number(ymd.slice(0, 4)) - 18}${ymd.slice(4)}`;
const ADULT_DOB = minus18(gymYmd(new Date()));
const MINOR_DOB = minus18(gymYmd(new Date(Date.now() + 24 * 60 * 60 * 1000)));

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

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

async function seed(): Promise<void> {
  const q = (sql: string, params: unknown[] = []) => client.query(sql, params);

  await q(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [ORG]);
  for (const [account, role] of [
    [ADMIN, 'organization_admin'],
    [COACH, 'coach'],
    [GUARDIAN, 'parent'],
    [GONE_COACH, 'coach'],
    [GONE_ADMIN, 'organization_admin'],
  ] as const) {
    await q(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag, login_email)
       values ($1, $2, $3, 'microsoft', true, $1 || '@gym.test')`,
      [account, role, ORG],
    );
  }
  for (const [athlete, name, dob] of [
    [ADULT, 'Adult Today', ADULT_DOB],
    [TOMORROW, 'Adult Tomorrow', MINOR_DOB],
    [KID, 'Kid Boxer', '2014-05-06'],
    [GONE, 'Gone Boxer', '2012-05-06'],
    [LIVE, 'Live Boxer', '2012-05-06'],
    [NOMINATOR, 'Nominator Kid', '2011-05-06'],
  ] as const) {
    await q(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, $3, $4, 'fly', 'active', 'contact', true, $5, now() - interval '1 year', now())`,
      [ORG, athlete, name, dob, COACH],
    );
  }
  for (const [account, athlete] of [
    [ADULT_ACCOUNT, ADULT],
    [TOMORROW_ACCOUNT, TOMORROW],
    [NOMINATOR_ACCOUNT, NOMINATOR],
  ] as const) {
    await q(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, auth_provider, active_flag)
       values ($1, 'athlete', $2, $3, 'ppbf_local', true)`,
      [account, ORG, athlete],
    );
  }

  await q(
    `insert into pilot.parents (organization_id, parent_id, full_name, account_id, email) values ($1, $2, 'Dana Reyes', $3, 'dana@gym.test')`,
    [ORG, PARENT_ROW, GUARDIAN],
  );
  for (const athlete of [ADULT, TOMORROW, KID]) {
    await q(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, $2, $3, 'parent')`,
      [ORG, PARENT_ROW, athlete],
    );
  }

  // Item 3. Every nomination names LIVE or KID (nominees that stay live), so
  // the only mark in play is the one on the nominator's or voter's account.
  for (const [nomination, athlete, account, role, name, status] of [
    [NOM_BY_COACH, LIVE, GONE_COACH, 'coach', 'Coach Gone', 'confirmed'],
    [NOM_BY_ATHLETE, KID, NOMINATOR_ACCOUNT, 'athlete', 'Nominator Kid', 'open'],
    [NOM_BY_ADMIN, LIVE, GONE_ADMIN, 'organization_admin', 'Admin Gone', 'withdrawn'],
    [NOM_CONTROL, KID, COACH, 'coach', 'Coach Live', 'open'],
  ] as const) {
    await q(
      `insert into pilot.one_percent_nominations (organization_id, nomination_id, athlete_id, source,
         nominated_by_account_id, nominated_by_role, nominated_by_display_name, expires_at, status, decided_at,
         withdrawal_reason)
       values ($1, $2, $3, $4, $5, $6, $7, now() + interval '30 days', $8,
         case when $8 = 'open' then null else now() end,
         case when $8 = 'withdrawn' then 'test' else null end)`,
      [ORG, nomination, athlete, role === 'athlete' ? 'self_peer_nomination' : 'coach_nomination', account, role, name, status],
    );
  }
  for (const [account, role, name] of [
    [GONE_COACH, 'coach', 'Coach Gone'],
    [GONE_ADMIN, 'organization_admin', 'Admin Gone'],
    [COACH, 'coach', 'Coach Live'],
  ] as const) {
    await q(
      `insert into pilot.one_percent_votes (organization_id, nomination_id, voter_account_id, voter_role, voter_display_name, vote)
       values ($1, $2, $3, $4, $5, 'yes')`,
      [ORG, NOM_CONTROL, account, role, name],
    );
  }
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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${PG_DATABASE}`);
  await admin.query(`create database ${PG_DATABASE}`);
  await admin.end();

  client = new Client({ connectionString: connectionStringFor(PG_DATABASE) });
  await client.connect();

  /* THE WHOLE SCHEMA (scripts/lib/full-schema.mjs): the consent writers,
     memberships and the club each live behind their own migration. */
  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  await (helper.applyFullSchema as (c: Client, opts: { infraDir: string }) => Promise<unknown>)(client, { infraDir: INFRA_DIR });
  await seed();
  activeClient = client;
});

afterAll(async () => {
  activeClient = null;
  await client?.end();
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
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

const guardianViewer = { accountId: GUARDIAN, role: 'parent' as const, organizationId: ORG, athleteId: null };

async function waiverCount(athleteId: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `select count(*)::text as n from pilot.waivers where organization_id = $1 and athlete_id = $2`,
    [ORG, athleteId],
  );
  return Number(rows[0].n);
}

describe('1. the guardian link goes dormant at 18', () => {
  test('the scope list keeps the minors and drops the child who is 18 today', async () => {
    await expect(guardianAthleteIds(ORG, GUARDIAN)).resolves.toEqual(expect.arrayContaining([KID, TOMORROW]));
    const ids = await guardianAthleteIds(ORG, GUARDIAN);
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(ADULT);
  });

  test('the per-athlete link answers true until the birthday and false from it', async () => {
    await expect(isGuardianLinkedToAthlete(ORG, GUARDIAN, TOMORROW)).resolves.toBe(true);
    await expect(isGuardianLinkedToAthlete(ORG, GUARDIAN, KID)).resolves.toBe(true);
    await expect(isGuardianLinkedToAthlete(ORG, GUARDIAN, ADULT)).resolves.toBe(false);
  });

  test('no acting parent resolves for the adult, so the consent route cannot name one', async () => {
    await expect(guardianParentIdForAthlete(ORG, GUARDIAN, TOMORROW)).resolves.toEqual({ parentId: PARENT_ROW, fullName: 'Dana Reyes' });
    await expect(guardianParentIdForAthlete(ORG, GUARDIAN, ADULT)).resolves.toBeNull();
  });

  test("the portrait relationship: still the guardian of tomorrow's adult, another family to today's", async () => {
    const tomorrow = await getSubjectIdentity(ORG, TOMORROW_ACCOUNT);
    const adult = await getSubjectIdentity(ORG, ADULT_ACCOUNT);
    expect(tomorrow?.athleteId).toBe(TOMORROW);
    expect(adult?.athleteId).toBe(ADULT);
    await expect(resolveRelationship(guardianViewer, tomorrow!, ORG)).resolves.toBe('guardian_of_subject');
    await expect(resolveRelationship(guardianViewer, adult!, ORG)).resolves.toBe('none');
  });

  test('a consent grant and a withdrawal for the adult are refused by name, inside the transaction, and write no waiver', async () => {
    const before = await waiverCount(ADULT);
    const grant = () =>
      grantMediaConsent({
        organizationId: ORG, athleteId: ADULT, parentId: PARENT_ROW, signedByName: 'Dana Reyes',
        coversVideo: true, publicUseAllowed: false, recordedByAccountId: GUARDIAN,
      });
    const withdraw = () =>
      withdrawMediaConsent({
        organizationId: ORG, athleteId: ADULT, parentId: PARENT_ROW, signedByName: 'Dana Reyes', recordedByAccountId: GUARDIAN,
      });

    await expect(grant()).rejects.toThrow(GuardianLinkEndedError);
    await expect(withdraw()).rejects.toThrow('this athlete is 18; guardian access has ended');
    expect(await waiverCount(ADULT)).toBe(before);
    // The transaction is closed either way: a later statement runs normally.
    await expect(client.query('select 1')).resolves.toBeDefined();
  });

  test("the same writes for tomorrow's adult are recorded today (the positive control)", async () => {
    const before = await waiverCount(TOMORROW);
    await expect(
      grantMediaConsent({
        organizationId: ORG, athleteId: TOMORROW, parentId: PARENT_ROW, signedByName: 'Dana Reyes',
        coversVideo: true, publicUseAllowed: false, recordedByAccountId: GUARDIAN,
      }),
    ).resolves.toEqual(expect.any(String));
    expect(await waiverCount(TOMORROW)).toBe(before + 1);
  });

  test('nothing is deleted and staff reads do not change: the link row stands and the consent audit still lists the guardian', async () => {
    const { rows } = await client.query(
      `select parent_id from pilot.guardian_links where organization_id = $1 and athlete_id = $2`,
      [ORG, ADULT],
    );
    expect(rows).toEqual([{ parent_id: PARENT_ROW }]);
    // checkGuardianMediaConsent is the staff-facing audit read; it is not a
    // guardian path and keeps naming the guardian of record.
    const consent = await checkGuardianMediaConsent(ORG, ADULT);
    expect(consent.guardianIds).toEqual([PARENT_ROW]);
  });
});

describe('2. ADMIN-01: the admin roster and a new membership never take a deleted athlete', () => {
  test('before the mark, the roster lists GONE and LIVE and a membership can be created for GONE (the positive control)', async () => {
    const ids = (await getAthletesByOrganization(ORG)).map((row) => row.athlete_id);
    expect(ids).toEqual(expect.arrayContaining([GONE, LIVE]));
    const paged = (await getAthletesByOrganization(ORG, { limit: 100 })).map((row) => row.athlete_id);
    expect(paged).toEqual(expect.arrayContaining([GONE, LIVE]));

    const created = await createMembership({
      organizationId: ORG, athleteId: GONE, programName: 'Before Mark', startedOn: '2026-06-01', createdByAccountId: ADMIN,
    });
    expect(created?.athlete_name).toBe('Gone Boxer');
  });

  test('after the mark, both roster reads leave GONE out and keep LIVE', async () => {
    await client.query(`update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`, [ORG, GONE]);

    const ids = (await getAthletesByOrganization(ORG)).map((row) => row.athlete_id);
    expect(ids).not.toContain(GONE);
    expect(ids).toContain(LIVE);
    const paged = (await getAthletesByOrganization(ORG, { limit: 100 })).map((row) => row.athlete_id);
    expect(paged).not.toContain(GONE);
    expect(paged).toContain(LIVE);
  });

  test('after the mark, a membership for GONE is hidden not-found; one for LIVE is created', async () => {
    await expect(
      createMembership({ organizationId: ORG, athleteId: GONE, programName: 'After Mark', startedOn: '2026-06-01', createdByAccountId: ADMIN }),
    ).resolves.toBeNull();
    const live = await createMembership({
      organizationId: ORG, athleteId: LIVE, programName: 'After Mark', startedOn: '2026-06-01', createdByAccountId: ADMIN,
    });
    expect(live?.athlete_name).toBe('Live Boxer');
    const { rows } = await client.query(
      `select count(*)::text as n from pilot.program_memberships where organization_id = $1 and athlete_id = $2 and program_name = 'After Mark'`,
      [ORG, GONE],
    );
    expect(rows[0].n).toBe('0');
  });
});

describe('3. N7: a deleted nominator or voter is not named from the stored copy', () => {
  const nominatorNames = async () =>
    Object.fromEntries((await listNominations(ORG)).map((row) => [row.nomination_id, row.nominated_by_display_name]));
  const voterNames = async () =>
    Object.fromEntries((await listVotes(ORG, NOM_CONTROL)).map((row) => [row.voter_account_id, row.voter_display_name]));

  test('before the marks, every stored name reads back (the positive control)', async () => {
    expect(await nominatorNames()).toEqual({
      [NOM_BY_COACH]: 'Coach Gone',
      [NOM_BY_ATHLETE]: 'Nominator Kid',
      [NOM_BY_ADMIN]: 'Admin Gone',
      [NOM_CONTROL]: 'Coach Live',
    });
    expect(await voterNames()).toEqual({ [GONE_COACH]: 'Coach Gone', [GONE_ADMIN]: 'Admin Gone', [COACH]: 'Coach Live' });
  });

  test("after the marks, each deleted person reads as the module's phrase for their stored role; the live coach keeps their name", async () => {
    // Two logins marked deleted; one athlete row marked deleted with its login left open.
    await client.query(`update pilot.accounts set deleted_at = now() where account_id = any($1)`, [[GONE_COACH, GONE_ADMIN]]);
    await client.query(`update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`, [ORG, NOMINATOR]);

    expect(await nominatorNames()).toEqual({
      [NOM_BY_COACH]: 'Your coach',
      [NOM_BY_ATHLETE]: 'An athlete',
      [NOM_BY_ADMIN]: 'An administrator',
      [NOM_CONTROL]: 'Coach Live',
    });
    expect(await voterNames()).toEqual({ [GONE_COACH]: 'Your coach', [GONE_ADMIN]: 'An administrator', [COACH]: 'Coach Live' });

    // The same field through the other two readers of NOMINATION_FIELDS.
    expect((await getNomination(ORG, NOM_BY_ATHLETE))?.nominated_by_display_name).toBe('An athlete');
    expect((await listMembers(ORG)).map((row) => row.nominated_by_display_name)).toEqual(['Your coach']);
  });

  test('the stored copies are untouched: nothing was deleted or rewritten', async () => {
    const { rows } = await client.query(
      `select nominated_by_display_name from pilot.one_percent_nominations where organization_id = $1 order by nomination_id`,
      [ORG],
    );
    expect(rows.map((row) => row.nominated_by_display_name).sort()).toEqual(['Admin Gone', 'Coach Gone', 'Coach Live', 'Nominator Kid']);
  });
});
