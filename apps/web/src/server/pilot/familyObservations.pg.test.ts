// Real PostgreSQL contract for the coach's read of what the family recorded at
// home (F-073; #1542's track): one athlete's parent_observation notes, newest
// first, parsed back into category, rating and notes, with no author and no
// account id; other note types and another gym's same-id athlete excluded; and
// a guardian's observations still listed after their account is purged (D-9).
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

// Routes familyObservations.ts's query into whichever embedded database the
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-family-observations-pg-test-${Date.now()}`);
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

  observations = await import('./familyObservations');
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

const ORG_ID = 'org-fobs';
const OTHER_ORG_ID = 'org-fobs-other';
const COACH = 'acct-fobs-coach';
const GUARDIAN = 'acct-fobs-guardian';
const OTHER_GUARDIAN = 'acct-fobs-guardian-x';
const ATHLETE = 'ATH-FOBS-1';
const SIBLING = 'ATH-FOBS-2';

let observations: typeof import('./familyObservations');

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
  for (const [accountId, role, org] of [
    [COACH, 'coach', ORG_ID],
    [GUARDIAN, 'parent', ORG_ID],
    [OTHER_GUARDIAN, 'parent', OTHER_ORG_ID],
  ] as const) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, $2, $3, 'microsoft')`,
      [accountId, role, org],
    );
  }
  for (const [org, athleteId] of [[ORG_ID, ATHLETE], [ORG_ID, SIBLING], [OTHER_ORG_ID, ATHLETE]] as const) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Obs Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [org, athleteId, COACH],
    );
  }

  const notes: Array<[string, string, string, string, string, string, string]> = [
    // [org, athlete, author, author_role, note_type, text, created_at]
    [ORG_ID, ATHLETE, GUARDIAN, 'parent', 'parent_observation', 'Energy · 4 out of 10\n\nTired after the school week.', '2026-10-12T23:30:00Z'],
    [ORG_ID, ATHLETE, GUARDIAN, 'parent', 'parent_observation', 'Sleep & recovery\n\nSlept well all week.', '2026-10-10T14:00:00Z'],
    [ORG_ID, ATHLETE, GUARDIAN, 'parent', 'parent_observation', 'free text that is not in the grammar', '2026-10-01T12:00:00Z'],
    [ORG_ID, ATHLETE, COACH, 'coach', 'parent_message', 'Bring gloves Thursday.', '2026-10-11T12:00:00Z'],
    [ORG_ID, ATHLETE, GUARDIAN, 'parent', 'home_barrier', 'No lift on Thursdays.', '2026-10-11T13:00:00Z'],
    [ORG_ID, ATHLETE, COACH, 'coach', 'coach_observation', 'Good footwork.', '2026-10-11T14:00:00Z'],
    // A staff note given the guardians' label through a staff write: never shown as the family's.
    [ORG_ID, ATHLETE, COACH, 'coach', 'parent_observation', 'Sleep & recovery\n\nWritten by staff.', '2026-10-12T20:00:00Z'],
    [ORG_ID, SIBLING, GUARDIAN, 'parent', 'parent_observation', 'Motivation · 9 out of 10\n\nCannot wait for Saturday.', '2026-10-12T12:00:00Z'],
    [OTHER_ORG_ID, ATHLETE, OTHER_GUARDIAN, 'parent', 'parent_observation', 'Energy · 2 out of 10\n\nOther gym.', '2026-10-12T12:00:00Z'],
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
  activeClient = await freshDatabase('ppbf_test_family_observations');
});

afterEach(async () => {
  await activeClient?.end();
  activeClient = null;
});

describe('listFamilyObservationsForStaff on real rows (F-073)', () => {
  test("one athlete's observations, newest first, parsed, and nothing else", async () => {
    const items = await observations.listFamilyObservationsForStaff(ORG_ID, ATHLETE);

    expect(items.map(({ category, rating, notes, created_at }) => ({ category, rating, notes, created_at }))).toEqual([
      { category: 'energy', rating: 4, notes: 'Tired after the school week.', created_at: '2026-10-12T23:30:00.000Z' },
      { category: 'sleep_recovery', rating: null, notes: 'Slept well all week.', created_at: '2026-10-10T14:00:00.000Z' },
      // Text outside the grammar is still shown, as written.
      { category: 'general_development', rating: null, notes: 'free text that is not in the grammar', created_at: '2026-10-01T12:00:00.000Z' },
    ]);
  });

  test("a staff note labelled as the family's is not shown as the family's", async () => {
    const items = await observations.listFamilyObservationsForStaff(ORG_ID, ATHLETE);
    expect(items.map((item) => item.notes)).not.toContain('Written by staff.');
  });

  test('no author and no account id leave the read', async () => {
    const items = await observations.listFamilyObservationsForStaff(ORG_ID, ATHLETE);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(['category', 'created_at', 'note_id', 'notes', 'rating']);
    }
    expect(JSON.stringify(items)).not.toContain(GUARDIAN);
  });

  test("another gym's athlete with the same id is not read", async () => {
    const mine = await observations.listFamilyObservationsForStaff(ORG_ID, ATHLETE);
    expect(mine.map((item) => item.notes)).not.toContain('Other gym.');
    const theirs = await observations.listFamilyObservationsForStaff(OTHER_ORG_ID, ATHLETE);
    expect(theirs.map((item) => item.notes)).toEqual(['Other gym.']);
  });

  test("a purged guardian's observations stay listed", async () => {
    await activeClient!.query('delete from pilot.accounts where account_id = $1', [GUARDIAN]);
    const items = await observations.listFamilyObservationsForStaff(ORG_ID, ATHLETE);
    expect(items).toHaveLength(3);
  });
});
