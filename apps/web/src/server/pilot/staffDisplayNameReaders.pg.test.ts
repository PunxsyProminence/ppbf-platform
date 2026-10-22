// Real PostgreSQL test for the screens that name a coach or staff member
// reading the name the gym typed (pilot.account_profiles.staff_display_name,
// parent-portal Q1 part B, PR 3), through the one gated expression in
// staffDisplayNameRead.ts.
//
// What needs a real database to prove: that every reader's SQL runs with the
// expression in it, that the typed name reaches what the screen is handed, and
// that the gate holds inside each query -- a name typed for someone who is no
// longer an active staff member here (re-invited as a guardian, membership
// switched off) is not read, and the reader falls back to the name it built
// from the login before. getCoachDisplayName's own cases are in
// coachDisplayName.pg.test.ts.
//
// Spins up the disposable local embedded Postgres the other suites use. It
// never connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

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
}));

import { listAthleteCoachMessages, listGuardianCopiesOfAthleteMessages } from './athleteCoachMessages';
import { listPersonClearancesForVerification, listStaffCredentialStatus } from './clearanceRegister';
import { listFamilyGoalsForStaff } from './familyGoals';
import { listSupportForStaff } from './familySupportRecords';
import { resolveActorDisplayName } from './onePercentClub';
import { listFamilyNotesForStaff } from './parentTasks';
import { getSubjectIdentity } from './profileDb';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-staff-display-name-readers-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const ORG = 'org-sdr';
const OTHER_ORG = 'org-sdr-other';
const ATHLETE = 'ath-sdr-1';
/** Coach here, named "Jordan Rivera" here. */
const COACH = 'acct-sdr-coach';
/** Organization admin here, named "Pat Office" here. */
const ADMIN = 'acct-sdr-admin';
/** Was a named coach; re-invited as a guardian. The stored row is still there. */
const REROLED = 'acct-sdr-reroled';
/** A coach homed here whose membership here is switched off; still named in the database. */
const LAPSED = 'acct-sdr-lapsed';
/** A coach of the other gym, named there only. */
const OTHER_COACH = 'acct-sdr-other-coach';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;

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
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function addAccount(
  client: Client,
  accountId: string,
  loginEmail: string,
  role: string,
  org: string,
  membershipActive = true,
): Promise<void> {
  await client.query(
    `insert into pilot.accounts (account_id, login_email, role, organization_id, auth_provider)
     values ($1, $2, $3, $4, 'microsoft')`,
    [accountId, loginEmail, role, org],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, $3, $4)`,
    [accountId, org, role, membershipActive],
  );
}

/** Written straight to the table, as PR 2's write would leave it (or as an old row a role change left behind). */
async function typed(client: Client, org: string, accountId: string, name: string): Promise<void> {
  await client.query(
    `insert into pilot.account_profiles (organization_id, account_id, staff_display_name) values ($1, $2, $3)`,
    [org, accountId, name],
  );
}

async function seededDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  activeClient = client;

  await applyFullSchema(client, { infraDir: INFRA_DIR });
  for (const org of [ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [org],
    );
  }
  await addAccount(client, COACH, 'j.rivera@ppbf.test', 'coach', ORG);
  await addAccount(client, ADMIN, 'ppbf@ppbf.test', 'organization_admin', ORG);
  await addAccount(client, REROLED, 'r.mills@ppbf.test', 'parent', ORG);
  await addAccount(client, LAPSED, 'd.laurent@ppbf.test', 'coach', ORG, false);
  await addAccount(client, OTHER_COACH, 'm.okafor@ppbf.test', 'coach', OTHER_ORG);
  await typed(client, ORG, COACH, 'Jordan Rivera');
  await typed(client, ORG, ADMIN, 'Pat Office');
  await typed(client, ORG, REROLED, 'Old Coach Name');
  await typed(client, ORG, LAPSED, 'Typed Lapsed');
  await typed(client, OTHER_ORG, OTHER_COACH, 'Their Coach');

  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
       emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Reader Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG, ATHLETE, COACH],
  );
  return client;
}

async function note(
  client: Client,
  author: string,
  authorRole: string,
  noteType: string,
  text: string,
  createdAt: string,
): Promise<void> {
  await client.query(
    `insert into pilot.coach_observations
       (organization_id, note_id, athlete_id, coach_account_id, author_role, note_type, note_text, created_at)
     values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7::timestamptz)`,
    [ORG, ATHLETE, author, authorRole, noteType, text, createdAt],
  );
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

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
});

afterEach(async () => {
  await activeClient?.end();
  activeClient = null;
});

afterAll(async () => {
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

describe('family and athlete screens read the typed name behind the gate (Q1 part B)', () => {
  test("a coach's message to an athlete, and the guardian's copy, carry the typed name; a re-roled author's old name is not read", async () => {
    const client = await seededDatabase('sdr_messages');
    await note(client, COACH, 'coach', 'athlete_message', 'Great footwork today.', '2026-10-20T16:00:00Z');
    await note(client, REROLED, 'coach', 'athlete_message', 'From before the role change.', '2026-10-19T16:00:00Z');

    const toAthlete = await listAthleteCoachMessages(ORG, ATHLETE);
    expect(toAthlete.map((message) => message.from_name)).toEqual(['Coach Jordan Rivera', 'Coach R Mills']);

    const toGuardian = await listGuardianCopiesOfAthleteMessages(ORG, [ATHLETE]);
    expect(toGuardian.map((message) => message.from_name)).toEqual(['Coach Jordan Rivera', 'Coach R Mills']);
  });

  test('a note to the family names the coach and the admin by the typed name on the staff list', async () => {
    const client = await seededDatabase('sdr_family_notes');
    await note(client, COACH, 'coach', 'parent_message', 'Bring the form.', '2026-10-20T16:00:00Z');
    await note(client, ADMIN, 'organization_admin', 'parent_message', 'Fees are due.', '2026-10-19T16:00:00Z');
    await note(client, LAPSED, 'coach', 'parent_message', 'From a lapsed coach.', '2026-10-18T16:00:00Z');

    const notes = await listFamilyNotesForStaff(ORG, ATHLETE);
    expect(notes.map((item) => item.posted_by_name)).toEqual(['Coach Jordan Rivera', 'Admin Pat Office', 'Coach D Laurent']);
  });

  test('a family goal set by a coach is said to be set by the typed name', async () => {
    const client = await seededDatabase('sdr_goals');
    await client.query(
      `insert into pilot.family_goals (organization_id, athlete_id, title, support_action, created_by_account_id, created_by_role)
       values ($1, $2, 'Three sessions a week', 'Drive on Tuesdays.', $3, 'coach')`,
      [ORG, ATHLETE, COACH],
    );

    const goals = await listFamilyGoalsForStaff(ORG, ATHLETE);
    expect(goals.map((goal) => goal.set_by)).toEqual(['Coach Jordan Rivera']);
  });

  test("family support recorded by the admin names the typed name; a former admin's typed name is not read", async () => {
    const client = await seededDatabase('sdr_support');
    const FORMER_ADMIN = 'acct-sdr-former-admin';
    await addAccount(client, FORMER_ADMIN, 'k.lowe@ppbf.test', 'organization_admin', ORG);
    await typed(client, ORG, FORMER_ADMIN, 'Typed Former Admin');
    for (const [recorder, kind] of [
      [ADMIN, 'Gloves and wraps'],
      [FORMER_ADMIN, 'A ride to the tournament'],
    ]) {
      await client.query(
        `insert into pilot.family_support_records
           (organization_id, record_id, athlete_id, support_kind, provided_on, recorded_by_account_id, recorded_by_role)
         values ($1, gen_random_uuid(), $2, $3, '2026-10-05', $4, 'organization_admin')`,
        [ORG, ATHLETE, kind, recorder],
      );
    }
    // Homed here, so the record still names them from the login; the membership is off, so not by the typed name.
    await client.query(
      'update pilot.organization_memberships set active_flag = false where account_id = $1 and organization_id = $2',
      [FORMER_ADMIN, ORG],
    );

    const support = await listSupportForStaff(ORG, ATHLETE);
    const byKind = new Map(support.map((row) => [row.support_kind, row.recorded_by_name]));
    expect(byKind.get('Gloves and wraps')).toBe('Pat Office');
    expect(byKind.get('A ride to the tournament')).toBe('K Lowe');
  });
});

describe('staff lists read the typed name behind the gate (Q1 part B)', () => {
  test('the credential queue and the staff credential list carry the typed name, and nothing for a lapsed coach', async () => {
    const client = await seededDatabase('sdr_credentials');
    await client.query(
      `insert into pilot.clearance_types (organization_id, clearance_type_id, name, issuing_authority, authority_kind)
       values ($1, 'ct-sdr', 'Child abuse clearance', 'PA Dept of Human Services', 'state_statutory')`,
      [ORG],
    );
    await client.query(
      `insert into pilot.person_clearances (organization_id, clearance_id, person_account_id, clearance_type_id, status)
       values ($1, gen_random_uuid(), $2, 'ct-sdr', 'submitted')`,
      [ORG, COACH],
    );

    const queue = await listPersonClearancesForVerification(ORG);
    expect(queue.map((row) => [row.person_account_id, row.person_display_name])).toEqual([[COACH, 'Jordan Rivera']]);

    const status = await listStaffCredentialStatus(ORG);
    const named = new Map(status.filter((row) => row.clearance_type_id === 'ct-sdr').map((row) => [row.account_id, row.staff_display_name]));
    expect(named.get(COACH)).toBe('Jordan Rivera');
    expect(named.get(ADMIN)).toBe('Pat Office');
    expect(named.get(LAPSED)).toBeNull();
  });

  test("the admin's One Percent Club signature and the staff profile subject use the typed name; another gym's name is never read", async () => {
    await seededDatabase('sdr_signature');

    expect(await resolveActorDisplayName({ organizationId: ORG, accountId: ADMIN, role: 'organization_admin' })).toBe(
      'Admin Pat Office',
    );
    expect((await getSubjectIdentity(ORG, ADMIN))?.fullName).toBe('Pat Office');
    expect((await getSubjectIdentity(OTHER_ORG, OTHER_COACH))?.fullName).toBe('Their Coach');
    // Not a member of ORG at all, so ORG's reads cannot name them by OTHER_ORG's name.
    expect(await getSubjectIdentity(ORG, OTHER_COACH)).toBeNull();
    // A guardian now: the subject is named from the login, not by the old typed name.
    expect((await getSubjectIdentity(ORG, REROLED))?.fullName).toBe('R Mills');
  });
});
