// Real PostgreSQL-backed contract test for getOrganizationWaiverStatus (#151).
//
// Round 9 adversarial review flagged this function's "latest waiver per
// type" logic (DISTINCT ON (waiver_type) ... ORDER BY waiver_type,
// created_at desc) as having zero real-database coverage -- every existing
// unit test mocks query() with fixtures that are already reduced to one row
// per type, so the ORDER BY direction (newest vs. oldest) and the org/
// athlete correlation inside the LATERAL join were never actually run.
// pilot.waivers is append-only, so picking the wrong row here would show a
// withdrawn waiver as still signed to an admin auditing compliance.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration/contract suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

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
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows;
  }),
}));

import { getOrganizationWaiverStatus } from './waiverCompliance';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-waiver-compliance-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const ORG_A = 'org-waiver-compliance-a';
const ORG_B = 'org-waiver-compliance-b';
const COACH_ID = 'acct-waiver-compliance-coach';
const ATHLETE_ID = 'ATH-WAIVER-COMPLIANCE-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  /* THE WHOLE SCHEMA, not the base file alone. This suite drives feature
     code, so it has no business deciding which migrations exist -- and the
     column it was missing (athletes.deleted_at) belongs to a migration it
     never picked. See scripts/lib/full-schema.mjs. */
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  for (const organizationId of [ORG_A, ORG_B]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG_A],
  );
  return client;
}

async function insertAthlete(client: Client, organizationId: string, athleteId: string, fullName: string, activeFlag = true): Promise<void> {
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, $3, '2011-05-06', 'fly', 'active', 'contact', $4, $5, now(), now())`,
    [organizationId, athleteId, fullName, activeFlag, COACH_ID],
  );
}

async function insertWaiver(
  client: Client,
  params: { organizationId: string; athleteId: string; waiverType: string; status: string; signedAt: string; createdAt: string },
): Promise<void> {
  await client.query(
    `insert into pilot.waivers (
       organization_id, waiver_id, athlete_id, waiver_type, signed_by_name, signed_by_role,
       signed_at, consent_version, status, created_at, updated_at
     ) values ($1, $2, $3, $4, 'Parent Name', 'parent', $5, 'v1', $6, $7, $7)`,
    [params.organizationId, randomUUID(), params.athleteId, params.waiverType, params.signedAt, params.status, params.createdAt],
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
});

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

describe('getOrganizationWaiverStatus against real Postgres', () => {
  afterEach(() => {
    activeClient = null;
  });

  test('picks the newest waiver per type, not an arbitrary one', async () => {
    const client = await freshDatabase('ppbf_test_waiver_compliance_latest');
    activeClient = client;
    try {
      await insertAthlete(client, ORG_A, ATHLETE_ID, 'Compliance Athlete');
      // Inserted out of chronological order on purpose -- if the ORDER BY
      // were missing, reversed, or keyed on the wrong column, insertion
      // order (not created_at) would silently determine which row "wins."
      // A withdrawn waiver is the append-only record of a decision that
      // supersedes an earlier signed one; picking the older row would show
      // a parent's withdrawal as if it never happened.
      await insertWaiver(client, {
        organizationId: ORG_A,
        athleteId: ATHLETE_ID,
        waiverType: 'photo_media',
        status: 'withdrawn',
        signedAt: '2026-08-05T00:00:00Z',
        createdAt: '2026-08-05T00:00:00Z',
      });
      await insertWaiver(client, {
        organizationId: ORG_A,
        athleteId: ATHLETE_ID,
        waiverType: 'photo_media',
        status: 'signed',
        signedAt: '2026-08-01T00:00:00Z',
        createdAt: '2026-08-01T00:00:00Z',
      });

      const statuses = await getOrganizationWaiverStatus(ORG_A);
      expect(statuses).toHaveLength(1);
      expect(statuses[0].waivers.photo_media).toBe('withdrawn');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('an athlete with zero waivers reads as missing across every tracked type, not fabricated as signed', async () => {
    const client = await freshDatabase('ppbf_test_waiver_compliance_missing');
    activeClient = client;
    try {
      await insertAthlete(client, ORG_A, ATHLETE_ID, 'No Waivers Yet');

      const statuses = await getOrganizationWaiverStatus(ORG_A);
      expect(statuses).toHaveLength(1);
      expect(statuses[0].waivers).toEqual({
        general: 'missing',
        medical_release: 'missing',
        photo_media: 'missing',
        travel: 'missing',
      });
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('an untracked waiver_type (e.g. a legacy value) never surfaces as one of the four tracked columns', async () => {
    const client = await freshDatabase('ppbf_test_waiver_compliance_untracked_type');
    activeClient = client;
    try {
      await insertAthlete(client, ORG_A, ATHLETE_ID, 'Legacy Waiver Athlete');
      await insertWaiver(client, {
        organizationId: ORG_A,
        athleteId: ATHLETE_ID,
        waiverType: 'liability_legacy',
        status: 'signed',
        signedAt: '2026-08-01T00:00:00Z',
        createdAt: '2026-08-01T00:00:00Z',
      });

      const statuses = await getOrganizationWaiverStatus(ORG_A);
      expect(statuses[0].waivers).toEqual({
        general: 'missing',
        medical_release: 'missing',
        photo_media: 'missing',
        travel: 'missing',
      });
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a waiver on a different athlete never leaks into this one\'s status', async () => {
    const client = await freshDatabase('ppbf_test_waiver_compliance_athlete_scope');
    activeClient = client;
    try {
      await insertAthlete(client, ORG_A, ATHLETE_ID, 'Athlete One');
      await insertAthlete(client, ORG_A, 'ATH-WAIVER-COMPLIANCE-OTHER', 'Athlete Two');
      await insertWaiver(client, {
        organizationId: ORG_A,
        athleteId: 'ATH-WAIVER-COMPLIANCE-OTHER',
        waiverType: 'general',
        status: 'signed',
        signedAt: '2026-08-01T00:00:00Z',
        createdAt: '2026-08-01T00:00:00Z',
      });

      const statuses = await getOrganizationWaiverStatus(ORG_A);
      const athleteOne = statuses.find((row) => row.athleteId === ATHLETE_ID);
      expect(athleteOne?.waivers.general).toBe('missing');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a waiver in a different organization never leaks into this one\'s status', async () => {
    const client = await freshDatabase('ppbf_test_waiver_compliance_org_scope');
    activeClient = client;
    try {
      await insertAthlete(client, ORG_A, ATHLETE_ID, 'Org A Athlete');
      await insertAthlete(client, ORG_B, ATHLETE_ID, 'Org B Athlete');
      await insertWaiver(client, {
        organizationId: ORG_B,
        athleteId: ATHLETE_ID,
        waiverType: 'general',
        status: 'signed',
        signedAt: '2026-08-01T00:00:00Z',
        createdAt: '2026-08-01T00:00:00Z',
      });

      const statuses = await getOrganizationWaiverStatus(ORG_A);
      expect(statuses).toHaveLength(1);
      expect(statuses[0].waivers.general).toBe('missing');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('activeFlag passes through from pilot.athletes, real value not a default', async () => {
    const client = await freshDatabase('ppbf_test_waiver_compliance_active_flag');
    activeClient = client;
    try {
      await insertAthlete(client, ORG_A, ATHLETE_ID, 'Retired Athlete', false);

      const statuses = await getOrganizationWaiverStatus(ORG_A);
      expect(statuses[0].activeFlag).toBe(false);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});
