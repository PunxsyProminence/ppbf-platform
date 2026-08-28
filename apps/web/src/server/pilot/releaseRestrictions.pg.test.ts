// Real PostgreSQL-backed contract test for the staff-only release-restriction
// signal.
//
// WHAT IS UNDER TEST, and why it needs a real database. Two things:
//
//   1. THE PROJECTION. A guardian and an athlete must never learn that this
//      flag exists. A restriction on who may collect a child frequently
//      concerns one of the guardians, so "show it to the parent" can mean
//      showing it to the person it is about -- and the platform cannot tell
//      the two households apart well enough to decide which parent is which.
//      That is a refusal in code, and asserted here as a throw rather than a
//      falsy answer.
//
//   2. THE SHAPE OF THE TABLE. pilot.athlete_release_restrictions carries no
//      free-text column, and that absence is the entire design: a schema
//      cannot stop somebody writing a custody narrative, but it can refuse to
//      offer a column to write it in. A census against information_schema is
//      the only thing that can hold that line, because the failure mode is a
//      later migration adding `notes text` and nobody noticing.
//
// PPBF models no custody status, protective order, authorized-pickup list or
// travel authorization. Owner decision, 2026-08-28: a minimal staff-only
// signal, with no legal narrative stored. These tests are what keep it minimal.
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

// Routes access.ts's and guardianAccess.ts's queries into whichever embedded
// database the current test opened. Declared before the import so jest's mock
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-release-restrictions-pg-test-${Date.now()}`);
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

  releaseRestrictions = await import('./releaseRestrictions');
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

const ORG_ID = 'org-release';
const OTHER_ORG_ID = 'org-release-other';
const COACH = 'acct-release-coach';
const ADMIN_ACCOUNT = 'acct-release-admin';
const GUARDIAN_ACCOUNT = 'acct-release-guardian';
const ATHLETE = 'ATH-RELEASE-1';
const OTHER_ATHLETE = 'ATH-RELEASE-2';

let releaseRestrictions: typeof import('./releaseRestrictions');

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const organizationId of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
  }

  for (const [accountId, role] of [
    [COACH, 'coach'],
    [ADMIN_ACCOUNT, 'organization_admin'],
    [GUARDIAN_ACCOUNT, 'parent'],
  ] as const) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'microsoft') on conflict do nothing`,
      [accountId, role, ORG_ID],
    );
  }

  for (const [athleteId, organizationId] of [
    [ATHLETE, ORG_ID],
    [OTHER_ATHLETE, ORG_ID],
    [ATHLETE, OTHER_ORG_ID],
  ] as const) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class,
         gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Release Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [organizationId, athleteId, COACH],
    );
  }

  return client;
}

beforeEach(async () => {
  activeClient = await freshDatabase('ppbf_test_release_restrictions');
});

afterEach(async () => {
  await activeClient?.end();
  activeClient = null;
});

describe('the table refuses to hold a narrative', () => {
  /* THE LOAD-BEARING TEST OF THIS WHOLE FEATURE.

     The approved design is a signal, not a record of the restriction. What
     makes that hold over time is not the comment in the migration -- it is
     that there is no column to write into. A later migration adding
     `notes text` would turn this into the custody store PPBF deliberately does
     not have, and it would do so silently: every other test here would still
     pass. */
  test('carries no free-text column at all, beyond the identifiers it is keyed by', async () => {
    const columns = await activeClient!.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
        where table_schema = 'pilot' and table_name = 'athlete_release_restrictions'`,
    );

    const narrative = columns.rows.filter(
      (row) => ['text', 'character varying', 'character', 'json', 'jsonb'].includes(row.data_type)
        && !['organization_id', 'athlete_id', 'set_by_account_id', 'updated_by_account_id']
          .includes(row.column_name),
    );

    expect(narrative.map((row) => row.column_name)).toEqual([]);
  });

  test('holds exactly the seven columns the design allows', async () => {
    const columns = await activeClient!.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'pilot' and table_name = 'athlete_release_restrictions'`,
    );

    expect(columns.rows.map((row) => row.column_name).sort()).toEqual([
      'athlete_id',
      'organization_id',
      'restrictions_apply',
      'set_at',
      'set_by_account_id',
      'updated_at',
      'updated_by_account_id',
    ]);
  });
});

describe('who may read the signal', () => {
  beforeEach(async () => {
    await releaseRestrictions.setReleaseRestrictions({
      organizationId: ORG_ID,
      athleteId: ATHLETE,
      restrictionsApply: true,
      actorAccountId: ADMIN_ACCOUNT,
      actorRole: 'organization_admin',
    });
  });

  test('a coach on the floor is told, because a coach is who has to ask', async () => {
    await expect(
      releaseRestrictions.athleteHasReleaseRestrictions(ORG_ID, ATHLETE, 'coach'),
    ).resolves.toBe(true);
  });

  test('an organization admin is told', async () => {
    await expect(
      releaseRestrictions.athleteHasReleaseRestrictions(ORG_ID, ATHLETE, 'organization_admin'),
    ).resolves.toBe(true);
  });

  /* REFUSED, NOT FALSE. A `false` here would be indistinguishable from "this
     child has no restriction" -- the answer most likely to be acted on, and
     the one that must never be produced by an authorization failure. */
  test('a parent is refused, rather than told there is no restriction', async () => {
    await expect(
      releaseRestrictions.athleteHasReleaseRestrictions(ORG_ID, ATHLETE, 'parent'),
    ).rejects.toThrow(/Forbidden/);
  });

  test('an athlete is refused too', async () => {
    await expect(
      releaseRestrictions.athleteHasReleaseRestrictions(ORG_ID, ATHLETE, 'athlete'),
    ).rejects.toThrow(/Forbidden/);
  });

  test('the floor list refuses a parent as well, so neither read leaks it', async () => {
    await expect(
      releaseRestrictions.athletesWithReleaseRestrictions(ORG_ID, 'parent'),
    ).rejects.toThrow(/Forbidden/);
  });

  test('an athlete with no row is not restricted', async () => {
    await expect(
      releaseRestrictions.athleteHasReleaseRestrictions(ORG_ID, OTHER_ATHLETE, 'coach'),
    ).resolves.toBe(false);
  });

  test('the same athlete id at another gym is a different child', async () => {
    await expect(
      releaseRestrictions.athleteHasReleaseRestrictions(OTHER_ORG_ID, ATHLETE, 'coach'),
    ).resolves.toBe(false);
  });

  test('the floor list names only the restricted athlete', async () => {
    await expect(
      releaseRestrictions.athletesWithReleaseRestrictions(ORG_ID, 'coach'),
    ).resolves.toEqual([ATHLETE]);
  });
});

describe('who may set the signal', () => {
  test('an organization admin may record one', async () => {
    const record = await releaseRestrictions.setReleaseRestrictions({
      organizationId: ORG_ID,
      athleteId: ATHLETE,
      restrictionsApply: true,
      actorAccountId: ADMIN_ACCOUNT,
      actorRole: 'organization_admin',
    });

    expect(record.restrictionsApply).toBe(true);
    expect(record.setByAccountId).toBe(ADMIN_ACCOUNT);
    expect(record.updatedByAccountId).toBe(ADMIN_ACCOUNT);
  });

  /* A coach must KNOW, and must not be the one who decides. Recording that a
     restriction exists is an administrative act with a named accountable
     person behind it. */
  test('a coach may read but may not set', async () => {
    await expect(releaseRestrictions.setReleaseRestrictions({
      organizationId: ORG_ID,
      athleteId: ATHLETE,
      restrictionsApply: true,
      actorAccountId: COACH,
      actorRole: 'coach',
    })).rejects.toThrow(/Forbidden/);
  });

  test('a parent may not set one, and may not clear one', async () => {
    await expect(releaseRestrictions.setReleaseRestrictions({
      organizationId: ORG_ID,
      athleteId: ATHLETE,
      restrictionsApply: true,
      actorAccountId: GUARDIAN_ACCOUNT,
      actorRole: 'parent',
    })).rejects.toThrow(/Forbidden/);

    await releaseRestrictions.setReleaseRestrictions({
      organizationId: ORG_ID,
      athleteId: ATHLETE,
      restrictionsApply: true,
      actorAccountId: ADMIN_ACCOUNT,
      actorRole: 'organization_admin',
    });

    await expect(releaseRestrictions.setReleaseRestrictions({
      organizationId: ORG_ID,
      athleteId: ATHLETE,
      restrictionsApply: false,
      actorAccountId: GUARDIAN_ACCOUNT,
      actorRole: 'parent',
    })).rejects.toThrow(/Forbidden/);

    await expect(
      releaseRestrictions.athleteHasReleaseRestrictions(ORG_ID, ATHLETE, 'coach'),
    ).resolves.toBe(true);
  });

  /* Lifting is an UPDATE, not a DELETE, so who set it originally survives. */
  test('lifting a restriction keeps who first set it', async () => {
    await releaseRestrictions.setReleaseRestrictions({
      organizationId: ORG_ID,
      athleteId: ATHLETE,
      restrictionsApply: true,
      actorAccountId: ADMIN_ACCOUNT,
      actorRole: 'organization_admin',
    });

    await activeClient!.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ('acct-release-admin-2', 'organization_admin', $1, 'microsoft')`,
      [ORG_ID],
    );

    const lifted = await releaseRestrictions.setReleaseRestrictions({
      organizationId: ORG_ID,
      athleteId: ATHLETE,
      restrictionsApply: false,
      actorAccountId: 'acct-release-admin-2',
      actorRole: 'organization_admin',
    });

    expect(lifted.restrictionsApply).toBe(false);
    expect(lifted.setByAccountId).toBe(ADMIN_ACCOUNT);
    expect(lifted.updatedByAccountId).toBe('acct-release-admin-2');

    await expect(
      releaseRestrictions.athleteHasReleaseRestrictions(ORG_ID, ATHLETE, 'coach'),
    ).resolves.toBe(false);
    await expect(
      releaseRestrictions.athletesWithReleaseRestrictions(ORG_ID, 'coach'),
    ).resolves.toEqual([]);
  });

  test('an athlete that does not exist here is refused by the foreign key', async () => {
    await expect(releaseRestrictions.setReleaseRestrictions({
      organizationId: ORG_ID,
      athleteId: 'ATH-DOES-NOT-EXIST',
      restrictionsApply: true,
      actorAccountId: ADMIN_ACCOUNT,
      actorRole: 'organization_admin',
    })).rejects.toThrow();
  });
});
