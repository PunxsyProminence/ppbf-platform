// Real PostgreSQL test for the staff side of parent resources (PH-11b): add,
// edit, publish and archive as coach and as organization admin, the seat
// check, refused links and programs, and what a linked family then reads.
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

// Routes the staff, family and author-name queries into whichever embedded database the
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-parent-resources-staff-pg-test-${Date.now()}`);
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

const ORG_ID = 'org-prs';
const OTHER_ORG_ID = 'org-prs-other';
const COACH = 'acct-prs-coach';
const ORG_ADMIN = 'acct-prs-org-admin';
const ENDED_COACH = 'acct-prs-ended-coach';
const OTHER_COACH = 'acct-prs-other-coach';
const GUARDIAN = 'acct-prs-guardian';
const MEMBER = 'ATH-PRS-MEMBER';
const JUNIOR = 'junior-boxing';
const RETIRED_PROGRAM = 'old-program';
const OTHER_PROGRAM = 'other-gym-program';

let staff: typeof import('./parentResourcesStaff');
let family: typeof import('./parentResources');

const coach = { organizationId: ORG_ID, accountId: COACH, role: 'coach' };
const orgAdmin = { organizationId: ORG_ID, accountId: ORG_ADMIN, role: 'organization_admin' };

function fields(overrides: Partial<import('./parentResourcesStaff').ResourceFields> = {}) {
  return { title: 'Hydration guide', summary: 'What to drink before practice.', resource_type: 'guide', destination: '/help', program_id: null, ...overrides };
}

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [org]);
  }
  for (const [accountId, role, org, email, seatActive] of [
    [COACH, 'coach', ORG_ID, 'sam.rivera@example.org', true],
    [ORG_ADMIN, 'organization_admin', ORG_ID, 'pat.lee@example.org', true],
    [ENDED_COACH, 'coach', ORG_ID, 'kim.ended@example.org', false],
    [OTHER_COACH, 'coach', OTHER_ORG_ID, 'lou.other@example.org', true],
    [GUARDIAN, 'parent', ORG_ID, null, true],
  ] as const) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email) values ($1, $2, $3, 'microsoft', $4)`,
      [accountId, role, org, email],
    );
    // Authority is an active seat in the gym, as sign-in grants it (PH-10's guard).
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, $3, $4)`,
      [accountId, org, role, seatActive],
    );
  }
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
       emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Resource Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, MEMBER, COACH],
  );
  await client.query(`insert into pilot.parents (organization_id, parent_id, account_id, full_name) values ($1, 'P-1', $2, 'A Guardian')`, [ORG_ID, GUARDIAN]);
  await client.query(`insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete) values ($1, 'P-1', $2, 'parent')`, [ORG_ID, MEMBER]);
  for (const [org, programId, programName, status, by] of [
    [ORG_ID, JUNIOR, 'Junior Boxing', 'active', COACH],
    [ORG_ID, RETIRED_PROGRAM, 'Old Program', 'archived', COACH],
    [OTHER_ORG_ID, OTHER_PROGRAM, 'Other Gym Program', 'active', OTHER_COACH],
  ] as const) {
    await client.query(
      `insert into pilot.programs (organization_id, program_id, program_name, status, created_by_account_id) values ($1, $2, $3, $4, $5)`,
      [org, programId, programName, status, by],
    );
  }
  await client.query(
    `insert into pilot.program_memberships (organization_id, membership_id, athlete_id, program_name, status, started_on, created_by_account_id)
     values ($1, 'M-1', $2, 'Junior Boxing', 'active', '2026-09-01', $3)`,
    [ORG_ID, MEMBER, COACH],
  );
  return client;
}

async function stored(resourceId: string) {
  const result = await activeClient!.query(
    `select state, published_at, created_by_account_id, created_by_role, updated_by_account_id, updated_by_role
       from pilot.parent_resources where resource_id = $1::uuid`,
    [resourceId],
  );
  return result.rows[0];
}

const familyTitles = async () => (await family.listResourcesForGuardian(ORG_ID, GUARDIAN, MEMBER)).map((item) => item.title);

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

  staff = await import('./parentResourcesStaff');
  family = await import('./parentResources');
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



beforeEach(async () => {
  activeClient = await freshDatabase('ppbf_test_parent_resources_staff');
});

afterEach(async () => {
  await activeClient?.end();
  activeClient = null;
});

describe('parent resources, staff publish (PH-11b)', () => {
  test.each([['coach', coach], ['organization_admin', orgAdmin]] as const)(
    'a %s adds a draft, edits it, publishes it and archives it, each change naming its own seat',
    async (role, writer) => {
      const draft = await staff.createResource(writer, fields(), false);
      expect(draft).toMatchObject({ state: 'draft', published_at: null, edited_by: null, title: 'Hydration guide', parents_cannot_open: false });
      expect(await stored(draft.resource_id)).toMatchObject({ created_by_account_id: writer.accountId, created_by_role: role, updated_by_account_id: null });

      const edited = await staff.editResource(writer, draft.resource_id, fields({ title: 'Water before practice', program_id: JUNIOR }));
      expect(edited).toMatchObject({ title: 'Water before practice', program_id: JUNIOR, program_name: 'Junior Boxing', state: 'draft' });
      expect(edited.edited_by).toEqual(expect.any(String));

      const published = await staff.setResourceState(writer, draft.resource_id, 'published');
      expect(published.state).toBe('published');
      expect(published.published_at).not.toBeNull();

      const archived = await staff.setResourceState(writer, draft.resource_id, 'archived');
      expect(archived.state).toBe('archived');
      expect(await stored(draft.resource_id)).toMatchObject({ updated_by_account_id: writer.accountId, updated_by_role: role });

      // Staff names only: no account id leaves.
      const { items } = await staff.listResourcesForStaff(ORG_ID);
      expect(items.map((item) => item.title)).toEqual(['Water before practice']);
      expect(JSON.stringify(items)).not.toMatch(/acct-|created_by|updated_by/);
    },
  );

  test('the first publication time is stamped by the database and kept through archive and republish', async () => {
    const draft = await staff.createResource(coach, fields(), false);
    const first = (await staff.setResourceState(coach, draft.resource_id, 'published')).published_at;
    const firstStored = (await stored(draft.resource_id)).published_at;
    expect(firstStored).toBeInstanceOf(Date);
    await staff.setResourceState(orgAdmin, draft.resource_id, 'archived');
    expect((await stored(draft.resource_id)).published_at).toEqual(firstStored);
    const again = await staff.setResourceState(orgAdmin, draft.resource_id, 'published');
    expect(again.published_at).toEqual(first);
    expect((await stored(draft.resource_id)).published_at).toEqual(firstStored);

    const born = await staff.createResource(coach, fields({ title: 'Born published' }), true);
    expect(born.state).toBe('published');
    expect(born.published_at).not.toBeNull();
  });

  test('a published resource reaches a linked family, and an archived one does not', async () => {
    const everyone = await staff.createResource(coach, fields({ title: 'For every family' }), true);
    await staff.createResource(orgAdmin, fields({ title: 'For Junior Boxing', program_id: JUNIOR, destination: 'https://usaboxing.org/rules' }), true);
    await staff.createResource(coach, fields({ title: 'Still a draft' }), false);
    expect((await familyTitles()).sort()).toEqual(['For Junior Boxing', 'For every family']);

    await staff.setResourceState(orgAdmin, everyone.resource_id, 'archived');
    expect(await familyTitles()).toEqual(['For Junior Boxing']);
  });

  test("another gym's staff cannot read or touch this gym's resource", async () => {
    const mine = await staff.createResource(coach, fields(), true);
    const other = { organizationId: OTHER_ORG_ID, accountId: OTHER_COACH, role: 'coach' };
    expect((await staff.listResourcesForStaff(OTHER_ORG_ID)).items).toEqual([]);
    await expect(staff.editResource(other, mine.resource_id, fields({ title: 'Taken over' }))).rejects.toThrow(/^Not found/);
    await expect(staff.setResourceState(other, mine.resource_id, 'archived')).rejects.toThrow(/^Not found/);
    expect((await stored(mine.resource_id)).state).toBe('published');
  });

  test('the database judges the seat: no seat in this gym, an ended seat, or a role not held is a 403', async () => {
    const mine = await staff.createResource(coach, fields(), false);
    for (const writer of [
      { organizationId: ORG_ID, accountId: OTHER_COACH, role: 'coach' },
      { organizationId: ORG_ID, accountId: ENDED_COACH, role: 'coach' },
      { organizationId: ORG_ID, accountId: COACH, role: 'organization_admin' },
    ]) {
      await expect(staff.createResource(writer, fields(), true)).rejects.toMatchObject({ status: 403 });
      await expect(staff.setResourceState(writer, mine.resource_id, 'published')).rejects.toMatchObject({ status: 403 });
    }
    expect((await stored(mine.resource_id)).state).toBe('draft');
    expect((await staff.listResourcesForStaff(ORG_ID)).items).toHaveLength(1);
  });

  test('an internal link parents cannot open is refused, and a link that is not a full https address', async () => {
    for (const destination of ['/admin', '/coach/drills', '/dashboard/../admin', 'help', 'https://usaboxing.org@evil', 'http://usaboxing.org']) {
      await expect(staff.createResource(coach, fields({ destination }), true)).rejects.toMatchObject({ status: 400 });
    }
    const mine = await staff.createResource(coach, fields({ destination: '/parent/safety' }), false);
    await expect(staff.editResource(coach, mine.resource_id, fields({ destination: '/admin' }))).rejects.toMatchObject({ status: 400 });
    expect((await staff.listResourcesForStaff(ORG_ID)).items.map((item) => item.destination)).toEqual(['/parent/safety']);
  });

  test("another gym's program, an archived program and an unknown one are refused", async () => {
    for (const program_id of [OTHER_PROGRAM, RETIRED_PROGRAM, 'no-such-program']) {
      await expect(staff.createResource(coach, fields({ program_id }), true)).rejects.toMatchObject({ status: 400 });
    }
    expect((await staff.listResourcesForStaff(ORG_ID)).programs).toEqual([{ program_id: JUNIOR, program_name: 'Junior Boxing' }]);
    expect((await staff.listResourcesForStaff(ORG_ID)).items).toEqual([]);
  });
});
