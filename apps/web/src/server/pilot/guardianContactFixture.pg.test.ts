// The split-household GATE FIXTURE, exercised against a real database.
//
// The guardian-contact runtime probe asserts a negative about a live response
// body: that Guardian A's read of an athlete contains no trace of Guardian B's
// phone, email or account_id. A negative like that is only as good as the
// fixture behind it -- if the provisioner silently wrote nothing, or wrote a
// guardian with a NULL phone, the probe would report PASS while proving
// nothing at all. That is a green light with no light behind it, and it is
// worse than having no probe.
//
// So this runs the REAL provisioner (scripts/pilot-provision-gate-fixtures.mjs)
// against embedded Postgres and reads back what it actually wrote: two
// guardians linked to one athlete, both carrying contact details, and the
// second of them also recorded as the emergency contact under a byte-identical
// full_name -- the join key the disclosure travelled on.
//
// It also pins the shared fixture module, because the provisioner and the
// probe agree on these strings only by importing the same file. A value that
// drifts on one side turns the probe into a search for something nobody wrote.
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

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-guardian-fixture-pg-test-${Date.now()}`);
const SCRIPTS_DIR = path.resolve(__dirname, '../../../scripts');
const SERVER_SCRIPT_PATH = path.join(SCRIPTS_DIR, 'test-embedded-pg-server.mjs');
const PROVISIONER_PATH = path.join(SCRIPTS_DIR, 'pilot-provision-gate-fixtures.mjs');
const FIXTURE_MODULE_PATH = path.join(SCRIPTS_DIR, 'lib/guardian-contact-fixture.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_guardian_fixture';

const ORG = 'org-gate';
const ATHLETE_ID = 'GATE-SHADOW-ATH-1';
const GUARDIAN_A = 'gate_probe_guardian_a';
const GUARDIAN_B = 'gate_probe_guardian_b';

// ts-jest downlevels a plain dynamic import into require(), which cannot load
// an ESM-only .mjs file. Hiding the call inside `new Function` keeps a real
// dynamic import in the emitted code. Same trick the other .pg suites use.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
        return;
      }
      server.close(() => reject(new Error('Could not determine a free port')));
    });
  });
}

/** Run the real provisioner as its own process, exactly as the workflow does. */
async function runProvisioner(): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PROVISIONER_PATH], {
      cwd: path.resolve(__dirname, '../../..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AZURE_POSTGRES_CONNECTION_STRING: connectionStringFor(TEST_DB_NAME),
        PPBF_POSTGRES_DISABLE_SSL: 'true',
        NODE_ENV: 'test',
        PPBF_EXPECTED_POSTGRES_HOSTNAME: 'localhost',
        PPBF_EXPECTED_POSTGRES_DATABASE: TEST_DB_NAME,
        PPBF_PILOT_DEFAULT_ORG_ID: ORG,
        PILOT_ADMIN_ACCOUNT_ID: 'org_admin_shadow',
        PILOT_SHADOW_ATHLETE_ACCOUNT_ID: 'gate_shadow_athlete',
        PILOT_SHADOW_ATHLETE_PIN: '481937',
        PILOT_SHADOW_ATHLETE_ID: ATHLETE_ID,
        PILOT_PROBE_GUARDIAN_A_ACCOUNT_ID: GUARDIAN_A,
        PILOT_PROBE_GUARDIAN_B_ACCOUNT_ID: GUARDIAN_B,
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.once('exit', (code) => resolve({ code, output }));
  });
}

beforeAll(async () => {
  PG_PORT = await freePort();

  serverProcess = spawn(
    process.execPath,
    [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ) as ChildProcessByStdio<null, Readable, Readable>;

  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => { stderrOutput += String(chunk); });

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
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  db = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await db.connect();
  await db.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
  await db.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, 'Gate Organization', 'active')`,
    [ORG],
  );
});

afterAll(async () => {
  await db?.end().catch(() => {});
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

describe('the provisioner writes a household the probe can actually test', () => {
  let result: { code: number | null; output: string };

  beforeAll(async () => {
    result = await runProvisioner();
  });

  it('completes', () => {
    expect(result.output).toContain('GATE FIXTURE PROVISION PASS');
    expect(result.code).toBe(0);
  });

  it('says in the log that it wrote the split household', () => {
    expect(result.output).toContain('Provisioned the split-household fixture');
  });

  it('links TWO guardians to one athlete, each with a real phone, email and account', async () => {
    const rows = await db.query<{
      parent_id: string; full_name: string; phone: string; email: string;
      account_id: string; relationship_to_athlete: string;
    }>(
      `select p.parent_id, p.full_name, p.phone, p.email, p.account_id, g.relationship_to_athlete
       from pilot.guardian_links g
       join pilot.parents p
         on p.organization_id = g.organization_id and p.parent_id = g.parent_id
       where g.organization_id = $1 and g.athlete_id = $2
       order by p.parent_id`,
      [ORG, ATHLETE_ID],
    );

    expect(rows.rows).toEqual([
      {
        parent_id: 'gate_probe_parent_a',
        full_name: 'Gate Probe Guardian A',
        phone: '555-0101',
        email: 'gate.guardian.a@ppbf.invalid',
        account_id: GUARDIAN_A,
        relationship_to_athlete: 'mother',
      },
      {
        parent_id: 'gate_probe_parent_b',
        full_name: 'Gate Probe Guardian B',
        phone: '555-0202',
        email: 'gate.guardian.b@ppbf.invalid',
        account_id: GUARDIAN_B,
        relationship_to_athlete: 'father',
      },
    ]);
  });

  it('records the second guardian as the emergency contact, under the same name', async () => {
    const rows = await db.query<{ full_name: string; phone: string; email: string; notes: string }>(
      'select full_name, phone, email, notes from pilot.emergency_contacts where organization_id = $1 and athlete_id = $2',
      [ORG, ATHLETE_ID],
    );

    expect(rows.rows).toHaveLength(1);
    // Byte-identical to the pilot.parents full_name: that identity is the join
    // key that let a narrowed guardian list be reassembled into a phone number.
    expect(rows.rows[0].full_name).toBe('Gate Probe Guardian B');
    expect(rows.rows[0].phone).toBe('555-0202');
    expect(rows.rows[0].notes).toContain('Staff-only field');
  });

  /* Both guardian accounts must be Microsoft-authenticated with no PIN hash:
     resolvePrincipal revokes a privileged ppbf_local session on sight, so a
     PIN-backed guardian fixture would be destroyed by its own first use and
     the probe would report an unexplained 401. And an account with no PIN
     cannot be signed into through the public login form at all. */
  it('makes both guardians unusable through the login form', async () => {
    const rows = await db.query<{ account_id: string; auth_provider: string; pin_hash: string | null; role: string }>(
      'select account_id, auth_provider, pin_hash, role from pilot.accounts where account_id = any($1) order by account_id',
      [[GUARDIAN_A, GUARDIAN_B]],
    );

    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(row.auth_provider).toBe('microsoft');
      expect(row.pin_hash).toBeNull();
      expect(row.role).toBe('parent');
    }
  });

  it('gives both an active membership, without which every request answers 401', async () => {
    const rows = await db.query<{ account_id: string }>(
      `select account_id from pilot.organization_memberships
       where organization_id = $1 and account_id = any($2) and active_flag = true and role = 'parent'
       order by account_id`,
      [ORG, [GUARDIAN_A, GUARDIAN_B]],
    );

    expect(rows.rows.map((row) => row.account_id)).toEqual([GUARDIAN_A, GUARDIAN_B]);
  });

  it('is idempotent -- a re-run leaves exactly the same two links', async () => {
    const second = await runProvisioner();
    expect(second.code).toBe(0);

    const links = await db.query<{ n: string }>(
      'select count(*)::text as n from pilot.guardian_links where organization_id = $1 and athlete_id = $2',
      [ORG, ATHLETE_ID],
    );
    const contacts = await db.query<{ n: string }>(
      'select count(*)::text as n from pilot.emergency_contacts where organization_id = $1 and athlete_id = $2',
      [ORG, ATHLETE_ID],
    );

    expect(links.rows[0].n).toBe('2');
    expect(contacts.rows[0].n).toBe('1');
  });
});

/* The provisioner writes these values and the probe searches for them. They
   agree only because both import this module; if the probe looked for a string
   nobody wrote, it would find no leak and call that a pass. */
describe('the shared fixture module', () => {
  it('names every value the probe hunts for, including the account id', async () => {
    const fixtureModule = await nativeDynamicImport(FIXTURE_MODULE_PATH);
    const guardianBSecrets = fixtureModule.guardianBSecrets as (accountId: string) => string[];

    const secrets = guardianBSecrets(GUARDIAN_B);

    expect(secrets).toContain('555-0202');
    expect(secrets).toContain('gate.guardian.b@ppbf.invalid');
    expect(secrets).toContain(GUARDIAN_B);
    // Guardian A's own details are not in Guardian B's secret list -- the probe
    // passes them separately for the athlete's read, and conflating the two
    // would make a real leak of A's number look like a pass for B.
    expect(secrets).not.toContain('555-0101');
  });

  it('uses only addresses and numbers that cannot reach a person', async () => {
    const fixtureModule = await nativeDynamicImport(FIXTURE_MODULE_PATH);
    const fixture = fixtureModule.GUARDIAN_CONTACT_FIXTURE as {
      parentA: { phone: string; email: string };
      parentB: { phone: string; email: string };
    };

    for (const parent of [fixture.parentA, fixture.parentB]) {
      // RFC 2606 reserved TLD, and the 555-01xx fictional range.
      expect(parent.email.endsWith('.invalid')).toBe(true);
      expect(parent.phone.startsWith('555-01') || parent.phone.startsWith('555-02')).toBe(true);
    }
  });
});
