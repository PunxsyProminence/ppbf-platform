// Real PostgreSQL-backed test for issue #1480 C2: a minor's photo circle under
// the whole-gym coach rule.
//
// Jason, 2026-10-12: "Any coach all coaches coach all athletes"
// (OD-2026-10-12-016), applied by Overwatch to the photo circle (#1480 Q5) on
// top of OD-2026-10-11-007 ("lets make it coaches to whole gym"). Every coach
// of the athlete's gym is now coach_of_subject -- inside a minor's circle --
// while the organization admin, another gym's coach, an unlinked parent, the
// platform owner and the board stay outside.
//
// The relationship is read from real rows (getSubjectIdentity +
// resolveRelationship), then put through the real portrait and ring-name
// decisions. A deleted athlete has no identity at all.
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

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

let activeClient: Client | null = null;

jest.mock('./db', () => ({
  ...jest.requireActual('./db'),
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

import type { ActorIdentity } from './access';
import { getSubjectIdentity, resolveRelationship } from './profileDb';
import { decidePortrait, decideRingName, type ProfileRelationship } from './profileVisibility';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-photo-circle-whole-gym-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const ORG = 'org-pc';
const OTHER_ORG = 'org-pc-other';
const RECORD_COACH = 'acct-pc-coach-record';
const UNASSIGNED_COACH = 'acct-pc-coach-unassigned';
const ORG_ADMIN = 'acct-pc-admin';
const OTHER_GYM_COACH = 'acct-pc-coach-other-gym';
const LINKED_PARENT = 'acct-pc-parent-linked';
const UNLINKED_PARENT = 'acct-pc-parent-unlinked';

const CHILD = 'ATH-PC-CHILD';
const CHILD_ACCOUNT = 'acct-pc-child';
const GONE = 'ATH-PC-GONE';
const GONE_ACCOUNT = 'acct-pc-gone';

/** Eleven years old on any date this suite runs: unambiguously a minor. */
const CHILD_DOB = `${new Date().getUTCFullYear() - 11}-03-04`;
const NOW = new Date();

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

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const organizationId of [ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
  }
  for (const [accountId, role, organizationId] of [
    [RECORD_COACH, 'coach', ORG],
    [UNASSIGNED_COACH, 'coach', ORG],
    [ORG_ADMIN, 'organization_admin', ORG],
    [LINKED_PARENT, 'parent', ORG],
    [UNLINKED_PARENT, 'parent', ORG],
    [OTHER_GYM_COACH, 'coach', OTHER_ORG],
  ] as const) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag, login_email)
       values ($1, $2, $3, 'microsoft', true, $1 || '@gym.test')`,
      [accountId, role, organizationId],
    );
  }
  for (const [athleteId, accountId, name] of [[CHILD, CHILD_ACCOUNT, 'Rosa Delgado'], [GONE, GONE_ACCOUNT, 'Gone Child']]) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, $3, $4, 'fly', 'active', 'contact', true, $5, now(), now())`,
      [ORG, athleteId, name, CHILD_DOB, RECORD_COACH],
    );
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, auth_provider, active_flag)
       values ($1, 'athlete', $2, $3, 'ppbf_local', true)`,
      [accountId, ORG, athleteId],
    );
  }
  await client.query(
    `insert into pilot.parents (organization_id, parent_id, full_name, account_id, email)
     values ($1, 'PAR-PC-1', 'Dana Delgado', $2, 'dana@gym.test')`,
    [ORG, LINKED_PARENT],
  );
  await client.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, 'PAR-PC-1', $2, 'parent')`,
    [ORG, CHILD],
  );
  await client.query(
    'update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2',
    [ORG, GONE],
  );

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

afterEach(() => {
  activeClient = null;
});

function viewer(accountId: string, role: ActorIdentity['role'], organizationId = ORG): ActorIdentity {
  return { accountId, role, organizationId, athleteId: null };
}

/** The child's released portrait and ring name, as the viewer would see them. */
async function whatTheViewerSees(who: ActorIdentity): Promise<{
  relationship: ProfileRelationship;
  portrait: string;
  ringName: string | null;
}> {
  const identity = await getSubjectIdentity(ORG, CHILD_ACCOUNT);
  if (!identity) throw new Error('test bug: the child has no identity');
  const relationship = await resolveRelationship(who, identity, ORG);
  const subject = {
    accountId: identity.accountId,
    isAthlete: true,
    dob: identity.dob,
    hasPhoto: true,
    photoReviewState: 'released' as const,
    nickname: 'Sparks',
    nicknameClearedAt: null,
  };
  return {
    relationship,
    portrait: decidePortrait(subject, relationship, NOW).show,
    ringName: decideRingName(subject, relationship, NOW),
  };
}

describe("a minor's photo circle under the whole-gym coach rule (real database)", () => {
  test('the coach of record is inside the circle (the positive control)', async () => {
    const client = await freshDatabase('pc_record_coach');
    activeClient = client;
    try {
      await expect(whatTheViewerSees(viewer(RECORD_COACH, 'coach'))).resolves.toEqual({
        relationship: 'coach_of_subject', portrait: 'photo', ringName: 'Sparks',
      });
    } finally {
      await client.end();
    }
  });

  test('a coach of the same gym with no assignment is inside the circle too (#1480 Q5)', async () => {
    const client = await freshDatabase('pc_unassigned_coach');
    activeClient = client;
    try {
      await expect(whatTheViewerSees(viewer(UNASSIGNED_COACH, 'coach'))).resolves.toEqual({
        relationship: 'coach_of_subject', portrait: 'photo', ringName: 'Sparks',
      });
    } finally {
      await client.end();
    }
  });

  test('the organization admin stays outside: the plate, no ring name', async () => {
    const client = await freshDatabase('pc_org_admin');
    activeClient = client;
    try {
      await expect(whatTheViewerSees(viewer(ORG_ADMIN, 'organization_admin'))).resolves.toEqual({
        relationship: 'organization_staff', portrait: 'plate', ringName: null,
      });
    } finally {
      await client.end();
    }
  });

  test("another gym's coach stays outside, even asking about this gym's child", async () => {
    const client = await freshDatabase('pc_other_gym_coach');
    activeClient = client;
    try {
      await expect(whatTheViewerSees(viewer(OTHER_GYM_COACH, 'coach', OTHER_ORG))).resolves.toEqual({
        relationship: 'none', portrait: 'plate', ringName: null,
      });
    } finally {
      await client.end();
    }
  });

  test('the linked guardian is inside and an unlinked parent is outside, unchanged', async () => {
    const client = await freshDatabase('pc_parents');
    activeClient = client;
    try {
      await expect(whatTheViewerSees(viewer(LINKED_PARENT, 'parent'))).resolves.toEqual({
        relationship: 'guardian_of_subject', portrait: 'photo', ringName: 'Sparks',
      });
      await expect(whatTheViewerSees(viewer(UNLINKED_PARENT, 'parent'))).resolves.toEqual({
        relationship: 'none', portrait: 'plate', ringName: null,
      });
    } finally {
      await client.end();
    }
  });

  test.each(['platform_owner', 'board'] as const)('the %s stays outside', async (role) => {
    const client = await freshDatabase(`pc_${role}`);
    activeClient = client;
    try {
      await expect(whatTheViewerSees(viewer(`acct-pc-${role}`, role))).resolves.toEqual({
        relationship: 'none', portrait: 'plate', ringName: null,
      });
    } finally {
      await client.end();
    }
  });

  test('a deleted child has no identity, so no coach is in any circle for them', async () => {
    const client = await freshDatabase('pc_deleted');
    activeClient = client;
    try {
      await expect(getSubjectIdentity(ORG, GONE_ACCOUNT)).resolves.toBeNull();
    } finally {
      await client.end();
    }
  });
});
