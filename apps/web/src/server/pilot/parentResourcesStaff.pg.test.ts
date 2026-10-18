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
const LEGACY_ADMIN = 'acct-prs-legacy-admin';
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
const legacyAdmin = { organizationId: ORG_ID, accountId: LEGACY_ADMIN, role: 'admin' };
const otherCoach = { organizationId: OTHER_ORG_ID, accountId: OTHER_COACH, role: 'coach' };

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
    [LEGACY_ADMIN, 'admin', ORG_ID, 'jo.legacy@example.org', true],
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

async function stored(resourceId: string, organizationId = ORG_ID) {
  const result = await activeClient!.query(
    `select title, summary, resource_type, destination, program_id, state, published_at, updated_at,
            created_by_account_id, created_by_role, updated_by_account_id, updated_by_role
       from pilot.parent_resources where organization_id = $1 and resource_id = $2::uuid`,
    [organizationId, resourceId],
  );
  return result.rows[0];
}

type Fields = import('./parentResourcesStaff').ResourceFields;
type Seat = typeof coach;

// The version a page sends back: updated_at exactly as the staff list hands it out.
async function versionOf(resourceId: string, organizationId = ORG_ID) {
  const item = (await staff.listResourcesForStaff(organizationId)).items.find((one) => one.resource_id === resourceId);
  if (!item) throw new Error(`test bug: ${resourceId} is not listed`);
  return item.updated_at;
}

const edit = async (writer: Seat, id: string, input: Partial<Fields>) =>
  staff.editResource(writer, id, await versionOf(id, writer.organizationId), input);
const publish = async (writer: Seat, id: string) =>
  staff.setResourceState(writer, id, 'published', await versionOf(id, writer.organizationId));
const archive = async (writer: Seat, id: string) =>
  staff.setResourceState(writer, id, 'archived', await versionOf(id, writer.organizationId));

// A draft put in by hand, as an older version of the app or a changed building
// map could have left it: the staff checks are not asked.
async function insertByHand(values: { destination?: string; program_id?: string | null }) {
  const result = await activeClient!.query(
    `insert into pilot.parent_resources (organization_id, title, summary, resource_type, destination_kind, destination,
       program_id, created_by_account_id, created_by_role)
     values ($1, 'By hand', 'Stored before.', 'guide', $5, $2, $3, $4, 'coach')
     returning resource_id::text as resource_id`,
    [ORG_ID, values.destination ?? '/help', values.program_id ?? null, COACH,
      (values.destination ?? '/help').startsWith('https://') ? 'external' : 'internal'],
  );
  return result.rows[0].resource_id as string;
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
  test.each([['coach', coach], ['organization_admin', orgAdmin], ['admin', legacyAdmin]] as const)(
    'a %s adds a draft, edits it, publishes it and archives it, each change naming its own seat',
    async (role, writer) => {
      const draft = await staff.createResource(writer, fields(), false);
      expect(draft).toMatchObject({ state: 'draft', published_at: null, edited_by: null, title: 'Hydration guide', parents_cannot_open: false, program_archived: false });
      expect(draft.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      expect(await stored(draft.resource_id)).toMatchObject({ created_by_account_id: writer.accountId, created_by_role: role, updated_by_account_id: null });

      const edited = await edit(writer, draft.resource_id, fields({ title: 'Water before practice', program_id: JUNIOR }));
      expect(edited).toMatchObject({ title: 'Water before practice', program_id: JUNIOR, program_name: 'Junior Boxing', state: 'draft' });
      expect(edited.edited_by).toEqual(expect.any(String));

      const published = await publish(writer, draft.resource_id);
      expect(published.state).toBe('published');
      expect(published.published_at).not.toBeNull();

      const archived = await archive(writer, draft.resource_id);
      expect(archived.state).toBe('archived');
      expect(await stored(draft.resource_id)).toMatchObject({ updated_by_account_id: writer.accountId, updated_by_role: role });

      // Staff names only: no account id or email leaves.
      const { items } = await staff.listResourcesForStaff(ORG_ID);
      expect(items.map((item) => item.title)).toEqual(['Water before practice']);
      expect(JSON.stringify(items)).not.toMatch(/acct-|@|created_by|updated_by/);
    },
  );

  // The time itself is stamped by the database whatever a writer sends (PH-10's
  // migration test); this side sends none. What this side owns is that archive
  // and republish never move it.
  test('the first publication time is kept through archive and republish', async () => {
    const draft = await staff.createResource(coach, fields(), false);
    const first = (await publish(coach, draft.resource_id)).published_at;
    const firstStored = (await stored(draft.resource_id)).published_at;
    await archive(orgAdmin, draft.resource_id);
    expect((await stored(draft.resource_id)).published_at).toEqual(firstStored);
    const again = await publish(orgAdmin, draft.resource_id);
    expect(again.published_at).toEqual(first);
    expect((await stored(draft.resource_id)).published_at).toEqual(firstStored);

    const born = await staff.createResource(coach, fields({ title: 'Born published' }), true);
    expect(born.state).toBe('published');
    expect(born.published_at).not.toBeNull();
  });

  test('publishing what is published, or archiving what is archived, writes nothing', async () => {
    const mine = await staff.createResource(coach, fields(), true);
    const before = await stored(mine.resource_id);
    expect(await publish(orgAdmin, mine.resource_id)).toEqual(mine);
    expect(await stored(mine.resource_id)).toEqual(before);

    const archived = await archive(coach, mine.resource_id);
    const archivedRow = await stored(mine.resource_id);
    expect(await archive(orgAdmin, mine.resource_id)).toEqual(archived);
    expect(await stored(mine.resource_id)).toEqual(archivedRow);
  });

  test('a published resource reaches a linked family, and an archived one does not', async () => {
    const everyone = await staff.createResource(coach, fields({ title: 'For every family' }), true);
    await staff.createResource(orgAdmin, fields({ title: 'For Junior Boxing', program_id: JUNIOR, destination: 'https://usaboxing.org/rules' }), true);
    await staff.createResource(coach, fields({ title: 'Still a draft' }), false);
    expect((await familyTitles()).sort()).toEqual(['For Junior Boxing', 'For every family']);

    await archive(orgAdmin, everyone.resource_id);
    expect(await familyTitles()).toEqual(['For Junior Boxing']);
  });

  test("an edit keeps every field it does not send, and an organization admin's edit leaves the coach as writer", async () => {
    const mine = await staff.createResource(coach, fields({ program_id: JUNIOR, destination: 'https://usaboxing.org/rules', resource_type: 'policy' }), false);
    const edited = await edit(orgAdmin, mine.resource_id, { title: 'Rules of the ring' });
    expect(edited).toMatchObject({
      title: 'Rules of the ring', summary: 'What to drink before practice.', resource_type: 'policy',
      destination: 'https://usaboxing.org/rules', destination_kind: 'external', program_id: JUNIOR,
    });
    expect(await stored(mine.resource_id)).toMatchObject({
      created_by_account_id: COACH, created_by_role: 'coach', updated_by_account_id: ORG_ADMIN, updated_by_role: 'organization_admin',
    });
    // null is every family; left out is kept.
    expect((await edit(coach, mine.resource_id, { program_id: null })).program_id).toBeNull();
  });

  test('editing an archived resource keeps it archived', async () => {
    const mine = await staff.createResource(coach, fields(), false);
    await archive(coach, mine.resource_id);
    expect((await edit(orgAdmin, mine.resource_id, { title: 'Still away' })).state).toBe('archived');
    expect(await stored(mine.resource_id)).toMatchObject({ state: 'archived', published_at: null, title: 'Still away' });
  });

  test('a change against an older version is a 409 and the newer change is kept', async () => {
    const mine = await staff.createResource(coach, fields(), false);
    const seen = mine.updated_at;
    await staff.editResource(orgAdmin, mine.resource_id, seen, { title: 'First one in' });
    const after = await stored(mine.resource_id);
    for (const late of [
      () => staff.editResource(coach, mine.resource_id, seen, { title: 'Second one in' }),
      () => staff.setResourceState(coach, mine.resource_id, 'published', seen),
      () => staff.setResourceState(coach, mine.resource_id, 'archived', seen),
    ]) {
      await expect(late()).rejects.toMatchObject({ status: 409, message: staff.STALE_MESSAGE });
    }
    expect(await stored(mine.resource_id)).toEqual(after);
    expect(after).toMatchObject({ title: 'First one in', state: 'draft', updated_by_account_id: ORG_ADMIN });
    // A version that is not one the list hands out is a 400.
    for (const version of ['', 'yesterday', '2026-02-31T00:00:00.000000Z']) {
      await expect(staff.editResource(coach, mine.resource_id, version, { title: 'x' })).rejects.toMatchObject({ status: 400 });
    }
  });

  test("another gym's staff cannot read or touch this gym's resource", async () => {
    const mine = await staff.createResource(coach, fields(), true);
    expect((await staff.listResourcesForStaff(OTHER_ORG_ID)).items).toEqual([]);
    await expect(staff.editResource(otherCoach, mine.resource_id, mine.updated_at, fields({ title: 'Taken over' }))).rejects.toThrow(/^Not found/);
    await expect(staff.setResourceState(otherCoach, mine.resource_id, 'archived', mine.updated_at)).rejects.toThrow(/^Not found/);
    expect((await stored(mine.resource_id)).state).toBe('published');
  });

  test("a change reaches only its own gym's row, even where another gym holds the same id at the same version", async () => {
    // The key is (gym, id), so two gyms can hold one id, and one statement
    // gives both rows the same updated_at: only the write's gym filter
    // separates them.
    const id = '6f1c2b8e-3d4a-4c5b-9e6f-7a8b9c0d1e2f';
    const twins = await activeClient!.query(
      `insert into pilot.parent_resources (organization_id, resource_id, title, summary, resource_type, destination_kind, destination,
         created_by_account_id, created_by_role)
       values ($1, $5::uuid, 'Ours', 'Ours.', 'guide', 'internal', '/help', $2, 'coach'),
              ($3, $5::uuid, 'Theirs', 'Theirs.', 'guide', 'internal', '/help', $4, 'coach')
       returning updated_at`,
      [ORG_ID, COACH, OTHER_ORG_ID, OTHER_COACH, id],
    );
    expect(twins.rows[0].updated_at).toEqual(twins.rows[1].updated_at);
    expect((await edit(otherCoach, id, { title: 'Theirs, edited' })).title).toBe('Theirs, edited');
    await archive(otherCoach, id);
    expect(await stored(id)).toMatchObject({ title: 'Ours', state: 'draft', updated_by_account_id: null });
    expect(await stored(id, OTHER_ORG_ID)).toMatchObject({ title: 'Theirs, edited', state: 'archived', updated_by_account_id: OTHER_COACH });
  });

  test('the database judges the seat: no seat in this gym, an ended seat, or a role not held is a 403', async () => {
    const mine = await staff.createResource(coach, fields(), false);
    for (const writer of [
      { organizationId: ORG_ID, accountId: OTHER_COACH, role: 'coach' },
      { organizationId: ORG_ID, accountId: ENDED_COACH, role: 'coach' },
      { organizationId: ORG_ID, accountId: COACH, role: 'organization_admin' },
    ]) {
      await expect(staff.createResource(writer, fields(), true)).rejects.toMatchObject({ status: 403 });
      await expect(publish(writer, mine.resource_id)).rejects.toMatchObject({ status: 403 });
      await expect(edit(writer, mine.resource_id, { title: 'Not theirs to change' })).rejects.toMatchObject({ status: 403 });
    }
    expect(await stored(mine.resource_id)).toMatchObject({ state: 'draft', title: 'Hydration guide', updated_by_account_id: null });
    expect((await staff.listResourcesForStaff(ORG_ID)).items).toHaveLength(1);
  });

  test('an internal link parents cannot open is refused, and a link that is not a full https address', async () => {
    for (const destination of ['/admin', '/coach/drills', '/dashboard/../admin', 'help', 'https://usaboxing.org@evil', 'http://usaboxing.org',
      'https://usaboxing.org:65536/path', 'https://usaboxing.org:99999', 'https://usaboxing.org:0/']) {
      await expect(staff.createResource(coach, fields({ destination }), true)).rejects.toMatchObject({ status: 400 });
    }
    const mine = await staff.createResource(coach, fields({ destination: '/parent/safety' }), false);
    await expect(edit(coach, mine.resource_id, { destination: '/admin' })).rejects.toMatchObject({ status: 400 });
    expect((await staff.listResourcesForStaff(ORG_ID)).items.map((item) => item.destination)).toEqual(['/parent/safety']);
  });

  test('an app link over 2000 characters, or with a space or backslash, is refused in words', async () => {
    for (const destination of [`/help?q=${'a'.repeat(2000)}`, '/help?q=a b', '/help?q=a\\b']) {
      await expect(staff.createResource(coach, fields({ destination }), false))
        .rejects.toMatchObject({ status: 400, message: 'That app link is over 2000 characters or has a space or backslash in it.' });
    }
    expect((await staff.listResourcesForStaff(ORG_ID)).items).toEqual([]);
  });

  test('a stored https link no browser opens (a port past 65535) is not published until it changes', async () => {
    const id = await insertByHand({ destination: 'https://usaboxing.org:99999/guide' });
    await expect(publish(coach, id)).rejects.toMatchObject({ status: 400 });
    expect(await stored(id)).toMatchObject({ state: 'draft', published_at: null, updated_by_account_id: null });
    await edit(coach, id, { destination: 'https://usaboxing.org/guide' });
    expect((await publish(coach, id)).state).toBe('published');
  });

  test('a stored link parents cannot open is marked, and is not published until it changes', async () => {
    const id = await insertByHand({ destination: '/admin' });
    const [item] = (await staff.listResourcesForStaff(ORG_ID)).items;
    expect(item).toMatchObject({ resource_id: id, parents_cannot_open: true, state: 'draft' });
    await expect(publish(coach, id)).rejects.toMatchObject({ status: 400 });
    expect(await stored(id)).toMatchObject({ state: 'draft', published_at: null, updated_by_account_id: null });
  });

  test('a resource whose program was archived is marked, and is not published until it names an active one or every family', async () => {
    const id = await insertByHand({ program_id: JUNIOR });
    const live = await staff.createResource(coach, fields({ title: 'Already out', program_id: JUNIOR }), true);
    expect((await staff.listResourcesForStaff(ORG_ID)).items.every((one) => !one.program_archived)).toBe(true);
    await activeClient!.query(`update pilot.programs set status = 'archived' where organization_id = $1 and program_id = $2`, [ORG_ID, JUNIOR]);

    const items = (await staff.listResourcesForStaff(ORG_ID)).items;
    expect(items.find((one) => one.resource_id === id)).toMatchObject({ program_archived: true, program_id: JUNIOR });
    await expect(publish(coach, id)).rejects.toMatchObject({ status: 400, message: staff.PROGRAM_ARCHIVED_MESSAGE });
    expect(await stored(id)).toMatchObject({ state: 'draft', updated_by_account_id: null });

    // A draft may keep it while it is edited; a published one may not.
    expect((await edit(coach, id, { title: 'Kept program, draft' })).program_id).toBe(JUNIOR);
    await expect(edit(coach, live.resource_id, { title: 'Kept program, published' }))
      .rejects.toMatchObject({ status: 400, message: staff.PROGRAM_ARCHIVED_MESSAGE });
    expect((await stored(live.resource_id)).title).toBe('Already out');

    // Every family instead: it publishes.
    await edit(coach, id, { program_id: null });
    expect((await publish(coach, id)).state).toBe('published');
  });

  test('a malformed resource id is not in this gym: a 404, never a database error', async () => {
    for (const id of ['-'.repeat(36), 'not-an-id']) {
      await expect(staff.setResourceState(coach, id, 'published', '2026-10-17T12:00:00.000000Z')).rejects.toMatchObject({ status: 404 });
      await expect(staff.editResource(coach, id, '2026-10-17T12:00:00.000000Z', { title: 'x' })).rejects.toMatchObject({ status: 404 });
    }
  });

  test('a title and summary are counted in characters, as the database counts them', async () => {
    const title = '\u{1F94A}'.repeat(200);
    expect((await staff.createResource(coach, fields({ title, summary: '\u{1F94A}'.repeat(1000) }), false)).title).toBe(title);
    await expect(staff.createResource(coach, fields({ title: '\u{1F94A}'.repeat(201) }), false))
      .rejects.toMatchObject({ status: 400, message: 'A title is 1 to 200 characters.' });
  });

  // A program archived on another connection while a write that needs it active
  // is under way: the write waits for that archive and then refuses, never
  // writing a resource the family read would hide.
  async function whileArchiving<T>(run: () => Promise<T>): Promise<{ outcome: PromiseSettledResult<T>; settledEarly: boolean }> {
    const archiver = new Client({ connectionString: connectionStringFor('ppbf_test_parent_resources_staff') });
    await archiver.connect();
    let running: Promise<T> | null = null;
    try {
      await archiver.query('begin');
      await archiver.query(`update pilot.programs set status = 'archived' where organization_id = $1 and program_id = $2`, [ORG_ID, JUNIOR]);
      running = run();
      const settledEarly = await Promise.race([
        running.then(() => true, () => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
      await archiver.query('commit');
      const [outcome] = await Promise.allSettled([running]);
      return { outcome, settledEarly };
    } finally {
      await archiver.query('rollback').catch(() => {});
      // The write is settled before the next test's database: never left running into it.
      if (running) await Promise.allSettled([running]);
      await archiver.end();
    }
  }

  test('a program archived while a resource is being added to it: the add waits, then is refused, and nothing is stored', async () => {
    const { outcome, settledEarly } = await whileArchiving(() => staff.createResource(coach, fields({ program_id: JUNIOR }), true));
    expect(settledEarly).toBe(false);
    expect(outcome).toMatchObject({ status: 'rejected', reason: { status: 400, message: staff.NOT_ACTIVE_PROGRAM_MESSAGE } });
    expect((await staff.listResourcesForStaff(ORG_ID)).items).toEqual([]);
  });

  test('a program archived while a resource is being moved to it: the edit waits, then is refused, and the resource is unchanged', async () => {
    const draft = await staff.createResource(coach, fields(), false);
    const { outcome, settledEarly } = await whileArchiving(() => edit(coach, draft.resource_id, { program_id: JUNIOR }));
    expect(settledEarly).toBe(false);
    expect(outcome).toMatchObject({ status: 'rejected', reason: { status: 400, message: staff.NOT_ACTIVE_PROGRAM_MESSAGE } });
    expect(await stored(draft.resource_id)).toMatchObject({ program_id: null, updated_by_account_id: null });
  });

  test('a program archived while its resource is being published: the publish waits, then is refused, and it stays a draft', async () => {
    const draft = await staff.createResource(coach, fields({ program_id: JUNIOR }), false);
    const { outcome, settledEarly } = await whileArchiving(() => publish(coach, draft.resource_id));
    expect(settledEarly).toBe(false);
    expect(outcome).toMatchObject({ status: 'rejected', reason: { status: 400, message: staff.PROGRAM_ARCHIVED_MESSAGE } });
    expect(await stored(draft.resource_id)).toMatchObject({ state: 'draft', updated_by_account_id: null });
  });

  test("another gym's program, an archived program and an unknown one are refused", async () => {
    for (const program_id of [OTHER_PROGRAM, RETIRED_PROGRAM, 'no-such-program']) {
      await expect(staff.createResource(coach, fields({ program_id }), true)).rejects.toMatchObject({ status: 400 });
    }
    expect((await staff.listResourcesForStaff(ORG_ID)).programs).toEqual([{ program_id: JUNIOR, program_name: 'Junior Boxing' }]);
    expect((await staff.listResourcesForStaff(ORG_ID)).items).toEqual([]);
  });
});
