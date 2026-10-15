// Real PostgreSQL contract for the athlete's "From your coach" inbox (#1542,
// FC-06): this athlete's athlete_message notes, newest first, written by staff
// (coach, organization admin, admin), named by the writer's login and never by
// account id; parent messages, staff observations, behaviour notes, another
// athlete's messages, another gym's, and an athlete_message carrying a
// non-staff author role are all excluded; a message whose writer's account is
// gone stays, from "Your coach".
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

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

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

// Routes athleteCoachMessages.ts's query into whichever embedded database the
// current test opened. Declared before the import so jest's mock
// hoisting sees it.
let activeClient: Client | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows[0] ?? null;
  }),
}));

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-athlete-coach-messages-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');


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
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not determine a free port')));
      }
    });
  });
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

  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = helper.applyFullSchema as typeof applyFullSchema;

  messages = await import('./athleteCoachMessages');
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
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

const ORG_ID = 'org-acm';
const OTHER_ORG_ID = 'org-acm-other';
const COACH = 'acct-acm-coach';
const LEAVING_COACH = 'acct-acm-coach-leaving';
const ADMIN = 'acct-acm-admin';
const PARENT = 'acct-acm-parent';
const OTHER_COACH = 'acct-acm-coach-x';
const ATHLETE = 'ATH-ACM-1';
const OTHER_ATHLETE = 'ATH-ACM-2';

let messages: typeof import('./athleteCoachMessages');

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [org]);
  }
  for (const [accountId, role, org, login] of [
    [COACH, 'coach', ORG_ID, 'pat.smith@ppbf.test'],
    [LEAVING_COACH, 'coach', ORG_ID, 'sam.jones@ppbf.test'],
    [ADMIN, 'organization_admin', ORG_ID, 'office@ppbf.test'],
    [PARENT, 'parent', ORG_ID, 'parent@ppbf.test'],
    [OTHER_COACH, 'coach', OTHER_ORG_ID, 'other.coach@ppbf.test'],
  ] as const) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email) values ($1, $2, $3, 'microsoft', $4)`,
      [accountId, role, org, login],
    );
  }
  for (const [org, athleteId] of [[ORG_ID, ATHLETE], [ORG_ID, OTHER_ATHLETE], [OTHER_ORG_ID, ATHLETE]] as const) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Msg Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [org, athleteId, COACH],
    );
  }

  const notes: Array<[string, string, string, string, string, string, string]> = [
    // [org, athlete, author, author_role, note_type, text, created_at]
    [ORG_ID, ATHLETE, COACH, 'coach', 'athlete_message', 'Great work on the jab.', '2026-10-13T22:00:00Z'],
    [ORG_ID, ATHLETE, ADMIN, 'organization_admin', 'athlete_message', 'Your membership card is ready.', '2026-10-12T15:00:00Z'],
    [ORG_ID, ATHLETE, LEAVING_COACH, 'coach', 'athlete_message', 'See you Thursday.', '2026-10-10T15:00:00Z'],
    [ORG_ID, ATHLETE, PARENT, 'parent', 'athlete_message', 'Labelled as a coach message, written by a guardian.', '2026-10-13T23:00:00Z'],
    [ORG_ID, ATHLETE, COACH, 'coach', 'parent_message', 'To the family: bring gloves.', '2026-10-13T21:00:00Z'],
    [ORG_ID, ATHLETE, COACH, 'coach', 'coach_observation', 'Staff observation.', '2026-10-13T20:00:00Z'],
    [ORG_ID, ATHLETE, COACH, 'coach', 'behavior_standard', 'Conduct note.', '2026-10-13T19:00:00Z'],
    [ORG_ID, OTHER_ATHLETE, COACH, 'coach', 'athlete_message', 'For the other athlete.', '2026-10-13T18:00:00Z'],
    [OTHER_ORG_ID, ATHLETE, OTHER_COACH, 'coach', 'athlete_message', 'Other gym.', '2026-10-13T17:00:00Z'],
  ];
  for (const [org, athleteId, author, role, noteType, text, createdAt] of notes) {
    await client.query(
      `insert into pilot.coach_observations
         (organization_id, note_id, athlete_id, coach_account_id, author_role, note_type, note_text, created_at)
       values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7::timestamptz)`,
      [org, athleteId, author, role, noteType, text, createdAt],
    );
  }
  return client;
}

beforeEach(async () => {
  activeClient = await freshDatabase('ppbf_test_athlete_coach_messages');
});

afterEach(async () => {
  await activeClient?.end();
  activeClient = null;
});

describe('listAthleteCoachMessages on real rows (FC-06)', () => {
  test("this athlete's messages from staff, newest first, named by the writer, and nothing else", async () => {
    const items = await messages.listAthleteCoachMessages(ORG_ID, ATHLETE);

    expect(items.map(({ note_text, created_at, from_name }) => ({ note_text, created_at, from_name }))).toEqual([
      { note_text: 'Great work on the jab.', created_at: '2026-10-13T22:00:00.000Z', from_name: 'Coach Pat Smith' },
      { note_text: 'Your membership card is ready.', created_at: '2026-10-12T15:00:00.000Z', from_name: 'Your gym' },
      { note_text: 'See you Thursday.', created_at: '2026-10-10T15:00:00.000Z', from_name: 'Coach Sam Jones' },
    ]);
  });

  test('no account id or login leaves the read', async () => {
    const items = await messages.listAthleteCoachMessages(ORG_ID, ATHLETE);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(['created_at', 'from_name', 'note_id', 'note_text']);
    }
    expect(JSON.stringify(items)).not.toMatch(/acct-|@ppbf\.test/);
  });

  test("another athlete's messages and another gym's are never read", async () => {
    expect((await messages.listAthleteCoachMessages(ORG_ID, OTHER_ATHLETE)).map((item) => item.note_text)).toEqual(['For the other athlete.']);
    expect((await messages.listAthleteCoachMessages(OTHER_ORG_ID, ATHLETE)).map((item) => item.note_text)).toEqual(['Other gym.']);
  });

  test("a message whose writer's account is gone stays, from your coach", async () => {
    await activeClient!.query('delete from pilot.accounts where account_id = $1', [LEAVING_COACH]);
    const items = await messages.listAthleteCoachMessages(ORG_ID, ATHLETE);
    expect(items.find((item) => item.note_text === 'See you Thursday.')?.from_name).toBe('Your coach');
  });
});

/*
 * GUARDIANS OF A MINOR GET A COPY (FC-06 Q-2, ruled B): the scope is
 * guardianAthleteIds -- linked children, under 18, not deleted -- resolved by
 * the caller. Seeded here: a guardian of the minor athlete, a second guardian
 * of the same minor, a guardian of an athlete aged 18 or over, a guardian of
 * another family's child, and a guardian in the other gym.
 */
describe('guardian copies (listGuardianCopiesOfAthleteMessages, FC-06 Q-2 B)', () => {
  const ADULT = 'ATH-ACM-ADULT';
  const GUARDIANS: Array<[string, string, string, string]> = [
    // [account, parent id, org, linked athlete]
    ['acct-acm-guardian-a', 'P-A', ORG_ID, ATHLETE],
    ['acct-acm-guardian-b', 'P-B', ORG_ID, ATHLETE],
    ['acct-acm-guardian-adult', 'P-ADULT', ORG_ID, ADULT],
    ['acct-acm-guardian-other', 'P-OTHER', ORG_ID, OTHER_ATHLETE],
    ['acct-acm-guardian-x', 'P-X', OTHER_ORG_ID, ATHLETE],
  ];

  async function addGuardians(client: Client) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Adult Athlete', '2000-01-01', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [ORG_ID, ADULT, COACH],
    );
    await client.query(
      `insert into pilot.coach_observations
         (organization_id, note_id, athlete_id, coach_account_id, author_role, note_type, note_text, created_at)
       values ($1, gen_random_uuid(), $2, $3, 'coach', 'athlete_message', 'For the adult athlete.', '2026-10-13T16:00:00Z')`,
      [ORG_ID, ADULT, COACH],
    );
    for (const [account, parentId, org, athleteId] of GUARDIANS) {
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, 'parent', $2, 'microsoft')`,
        [account, org],
      );
      await client.query(
        `insert into pilot.parents (organization_id, parent_id, account_id, full_name) values ($1, $2, $3, 'A Guardian')`,
        [org, parentId, account],
      );
      await client.query(
        `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete) values ($1, $2, $3, 'parent')`,
        [org, parentId, athleteId],
      );
    }
  }

  async function guardianReads(account: string, org = ORG_ID) {
    const { guardianAthleteIds } = await import('./guardianAccess');
    const scope = await guardianAthleteIds(org, account);
    return messages.listGuardianCopiesOfAthleteMessages(org, scope);
  }

  test("each guardian of the minor reads what staff wrote to them, named, newest first", async () => {
    await addGuardians(activeClient!);
    for (const account of ['acct-acm-guardian-a', 'acct-acm-guardian-b']) {
      const items = await guardianReads(account);
      expect(items.map(({ athlete_id, note_text, from_name }) => ({ athlete_id, note_text, from_name }))).toEqual([
        { athlete_id: ATHLETE, note_text: 'Great work on the jab.', from_name: 'Coach Pat Smith' },
        { athlete_id: ATHLETE, note_text: 'Your membership card is ready.', from_name: 'Your gym' },
        { athlete_id: ATHLETE, note_text: 'See you Thursday.', from_name: 'Coach Sam Jones' },
      ]);
      expect(JSON.stringify(items)).not.toMatch(/acct-|@ppbf\.test/);
    }
  });

  test('a guardian of an athlete aged 18 or over reads no copy', async () => {
    await addGuardians(activeClient!);
    expect(await guardianReads('acct-acm-guardian-adult')).toEqual([]);
  });

  test("another family's guardian reads only their own child's, and the other gym's guardian only theirs", async () => {
    await addGuardians(activeClient!);
    expect((await guardianReads('acct-acm-guardian-other')).map((item) => item.note_text)).toEqual(['For the other athlete.']);
    expect((await guardianReads('acct-acm-guardian-x', OTHER_ORG_ID)).map((item) => item.note_text)).toEqual(['Other gym.']);
  });

  test('the athlete still reads their own, and an empty scope reads nothing', async () => {
    await addGuardians(activeClient!);
    expect((await messages.listAthleteCoachMessages(ORG_ID, ATHLETE)).map((item) => item.note_text)).toEqual([
      'Great work on the jab.', 'Your membership card is ready.', 'See you Thursday.',
    ]);
    expect(await messages.listGuardianCopiesOfAthleteMessages(ORG_ID, [])).toEqual([]);
  });
});
