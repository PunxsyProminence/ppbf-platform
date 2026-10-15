// Real PostgreSQL test for the family read of parent resources (#1593, PH-11):
// which published resources a linked guardian reads for one child, by the
// child's active programs, on the full schema with the PH-10 table.
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

// Routes parentResources.ts's and guardianAccess.ts's queries into whichever embedded database the
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-parent-resources-read-pg-test-${Date.now()}`);
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

const ORG_ID = 'org-pr';
const OTHER_ORG_ID = 'org-pr-other';
const COACH = 'acct-pr-coach';
const OTHER_COACH = 'acct-pr-other-coach';
const GUARDIAN = 'acct-pr-guardian';
const GUARDIAN_LAPSED = 'acct-pr-guardian-lapsed';
const GUARDIAN_ADULT = 'acct-pr-guardian-adult';
const GUARDIAN_X = 'acct-pr-guardian-x';
const MEMBER = 'ATH-PR-MEMBER';
const LAPSED = 'ATH-PR-LAPSED';
const ADULT = 'ATH-PR-ADULT';
const JUNIOR = 'junior-boxing';
const FITNESS = 'fitness';
const RETIRED_PROGRAM = 'old-program';

let resources: typeof import('./parentResources');

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
  for (const [accountId, role, org] of [
    [COACH, 'coach', ORG_ID],
    [OTHER_COACH, 'coach', OTHER_ORG_ID],
    [GUARDIAN, 'parent', ORG_ID],
    [GUARDIAN_LAPSED, 'parent', ORG_ID],
    [GUARDIAN_ADULT, 'parent', ORG_ID],
    [GUARDIAN_X, 'parent', OTHER_ORG_ID],
  ] as const) {
    await client.query(`insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, $2, $3, 'microsoft')`, [accountId, role, org]);
  }
  for (const [org, athleteId, dob] of [
    [ORG_ID, MEMBER, '2012-03-04'],
    [ORG_ID, LAPSED, '2012-03-04'],
    [ORG_ID, ADULT, '2000-01-01'],
    [OTHER_ORG_ID, MEMBER, '2012-03-04'],
  ] as const) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Resource Athlete', $3, 'fly', 'active', 'contact', true, $4, now(), now())`,
      [org, athleteId, dob, COACH],
    );
  }
  for (const [account, parentId, org, athleteId] of [
    [GUARDIAN, 'P-1', ORG_ID, MEMBER],
    [GUARDIAN_LAPSED, 'P-2', ORG_ID, LAPSED],
    [GUARDIAN_ADULT, 'P-3', ORG_ID, ADULT],
    [GUARDIAN_X, 'P-X', OTHER_ORG_ID, MEMBER],
  ] as const) {
    await client.query(`insert into pilot.parents (organization_id, parent_id, account_id, full_name) values ($1, $2, $3, 'A Guardian')`, [org, parentId, account]);
    await client.query(`insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete) values ($1, $2, $3, 'parent')`, [org, parentId, athleteId]);
  }
  for (const [programId, programName, status] of [
    [JUNIOR, 'Junior Boxing', 'active'],
    [FITNESS, 'Fitness', 'active'],
    [RETIRED_PROGRAM, 'Old Program', 'archived'],
  ] as const) {
    await client.query(
      `insert into pilot.programs (organization_id, program_id, program_name, status, created_by_account_id) values ($1, $2, $3, $4, $5)`,
      [ORG_ID, programId, programName, status, COACH],
    );
  }
  for (const [membershipId, athleteId, programName, status] of [
    // Names as typed on the membership: matched to the program by canonical name.
    ['M-1', MEMBER, '  junior boxing ', 'active'],
    ['M-2', MEMBER, 'Old Program', 'active'],
    ['M-3', LAPSED, 'Junior Boxing', 'lapsed'],
  ] as const) {
    await client.query(
      `insert into pilot.program_memberships (organization_id, membership_id, athlete_id, program_name, status, started_on, created_by_account_id)
       values ($1, $2, $3, $4, $5, '2026-09-01', $6)`,
      [ORG_ID, membershipId, athleteId, programName, status, COACH],
    );
  }
  for (const [org, title, program, state, destination, publishedAt] of [
    [ORG_ID, 'Everyone: hydration guide', null, 'published', '/help', '2026-10-10T12:00:00Z'],
    [ORG_ID, 'Junior: sparring policy', JUNIOR, 'published', 'https://example.org/policy.pdf', '2026-10-12T12:00:00Z'],
    [ORG_ID, 'Fitness: home circuit', FITNESS, 'published', '/help', '2026-10-11T12:00:00Z'],
    [ORG_ID, 'Old program: notes', RETIRED_PROGRAM, 'published', '/help', '2026-10-09T12:00:00Z'],
    [ORG_ID, 'Draft for everyone', null, 'draft', '/help', null],
    [ORG_ID, 'Archived for everyone', null, 'archived', '/help', null],
    [ORG_ID, 'Staff page link', null, 'published', '/admin', '2026-10-13T12:00:00Z'],
    [ORG_ID, 'Parent page link', null, 'published', '/parent/safety?tab=holds', '2026-10-08T12:00:00Z'],
    [OTHER_ORG_ID, 'Other gym for everyone', null, 'published', '/help', '2026-10-14T12:00:00Z'],
  ] as const) {
    await client.query(
      `insert into pilot.parent_resources
         (organization_id, title, summary, resource_type, destination_kind, destination, program_id, state, published_at,
          created_by_account_id, created_by_role)
       values ($1, $2, 'A summary.', 'guide', $3, $4, $5, $6, $7::timestamptz, $8, 'coach')`,
      [org, title, destination.startsWith('https://') ? 'external' : 'internal', destination, program, state, publishedAt, org === ORG_ID ? COACH : OTHER_COACH],
    );
  }
  return client;
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

  resources = await import('./parentResources');
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
  activeClient = await freshDatabase('ppbf_test_parent_resources_read');
});

afterEach(async () => {
  await activeClient?.end();
  activeClient = null;
});

describe('parent resources, the family read (#1593, PH-11)', () => {
  test("an active member's family reads every family's resources and their program's, newest first", async () => {
    const items = await resources.listResourcesForGuardian(ORG_ID, GUARDIAN, MEMBER);
    expect(items.map((item) => item.title)).toEqual([
      'Junior: sparring policy',
      'Everyone: hydration guide',
      'Parent page link',
    ]);
    expect(items[0]).toEqual({
      resource_id: expect.any(String), title: 'Junior: sparring policy', summary: 'A summary.', resource_type: 'guide',
      destination_kind: 'external', destination: 'https://example.org/policy.pdf',
    });
    expect(JSON.stringify(items)).not.toMatch(/acct-|created_by/);
  });

  test("a lapsed member's family reads only every family's resources", async () => {
    const items = await resources.listResourcesForGuardian(ORG_ID, GUARDIAN_LAPSED, LAPSED);
    expect(items.map((item) => item.title)).toEqual(['Everyone: hydration guide', 'Parent page link']);
  });

  test('drafts, archived resources, an archived program, other programs and a staff page never show', async () => {
    const titles = (await resources.listResourcesForGuardian(ORG_ID, GUARDIAN, MEMBER)).map((item) => item.title);
    for (const hidden of ['Draft for everyone', 'Archived for everyone', 'Old program: notes', 'Fitness: home circuit', 'Staff page link']) {
      expect(titles).not.toContain(hidden);
    }
  });

  test('another family, an athlete aged 18 or over, and another gym get nothing', async () => {
    for (const [org, account, athleteId] of [
      [ORG_ID, GUARDIAN_LAPSED, MEMBER],
      [ORG_ID, GUARDIAN_ADULT, ADULT],
      [ORG_ID, GUARDIAN_X, MEMBER],
      [OTHER_ORG_ID, GUARDIAN, MEMBER],
    ] as const) {
      await expect(resources.listResourcesForGuardian(org, account, athleteId)).rejects.toThrow(/^Not found/);
    }
    // The other gym's guardian reads only their own gym's.
    expect((await resources.listResourcesForGuardian(OTHER_ORG_ID, GUARDIAN_X, MEMBER)).map((item) => item.title))
      .toEqual(['Other gym for everyone']);
  });
});
