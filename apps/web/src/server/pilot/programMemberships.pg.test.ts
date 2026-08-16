// Real PostgreSQL-backed contract test for the program-memberships migration.
//
// What needs proving that reading SQL cannot prove: the migration creates
// the table from nothing; re-applying it is a no-op; the vocabularies and
// the scholarship 0-100 bounds are enforced by the database; the
// one-active-membership-per-athlete-per-program rule is a partial unique
// index (a second ACTIVE row is refused, but history rows for the same
// athlete+program coexist); and the tenancy shape holds via the composite
// athlete FK.
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

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-program-memberships-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_program_memberships_migration.sql';

const ORG_ID = 'org-memberships';
const OTHER_ORG_ID = 'org-elsewhere';
const ADMIN_ID = 'acct-memberships-admin';
const COACH_ID = 'acct-memberships-coach';
const ATHLETE_ID = 'ath-memberships-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let baseSchemaSql: string;

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
  await client.query(baseSchemaSql);
  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft'), ($3, 'coach', $2, 'microsoft')
     on conflict do nothing`,
    [ADMIN_ID, ORG_ID, COACH_ID],
  );
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Membership Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
     on conflict do nothing`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  return client;
}

function insertMembership(client: Client, membershipId: string, overrides: Record<string, string | number> = {}) {
  return client.query(
    `insert into pilot.program_memberships
       (organization_id, membership_id, athlete_id, program_name, status, started_on, scholarship_percent, created_by_account_id)
     values ($1, $2, $3, $4, $5, $6::date, $7, $8)`,
    [
      overrides.organization_id ?? ORG_ID,
      membershipId,
      ATHLETE_ID,
      overrides.program_name ?? 'Youth Boxing',
      overrides.status ?? 'active',
      overrides.started_on ?? '2026-06-01',
      overrides.scholarship_percent ?? 0,
      ADMIN_ID,
    ],
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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
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

describe('program memberships migration', () => {
  test('creates the table from nothing and accepts a valid enrollment', async () => {
    const client = await freshDatabase('memberships_fresh');
    try {
      await client.query(migrationSql);
      await insertMembership(client, 'mem-1', { scholarship_percent: 100 });

      const rows = await client.query(
        `select m.program_name, m.scholarship_percent, a.full_name
         from pilot.program_memberships m
         join pilot.athletes a on a.organization_id = m.organization_id and a.athlete_id = m.athlete_id
         where m.organization_id = $1`,
        [ORG_ID],
      );
      expect(rows.rows).toEqual([{ program_name: 'Youth Boxing', scholarship_percent: 100, full_name: 'Membership Athlete' }]);
    } finally {
      await client.end();
    }
  });

  test('re-applying over an existing install is a no-op that leaves rows untouched', async () => {
    const client = await freshDatabase('memberships_noop');
    try {
      await client.query(migrationSql);
      await insertMembership(client, 'mem-keep');
      await client.query(migrationSql);

      const rows = await client.query(
        'select membership_id from pilot.program_memberships where organization_id = $1',
        [ORG_ID],
      );
      expect(rows.rows.map((row) => row.membership_id)).toEqual(['mem-keep']);
    } finally {
      await client.end();
    }
  });

  test('the vocabularies, scholarship bounds, and ended-only end date are database facts', async () => {
    const client = await freshDatabase('memberships_vocab');
    try {
      await client.query(migrationSql);

      await expect(insertMembership(client, 'mem-bad-status', { status: 'paused' }))
        .rejects.toMatchObject({ code: '23514' });
      await expect(insertMembership(client, 'mem-bad-pct', { scholarship_percent: 150 }))
        .rejects.toMatchObject({ code: '23514' });
      await expect(insertMembership(client, 'mem-blank', { program_name: '   ' }))
        .rejects.toMatchObject({ code: '23514' });
      // An end date on an active row is a bookkeeping error.
      await insertMembership(client, 'mem-1');
      await expect(client.query(
        `update pilot.program_memberships set ended_on = current_date
         where organization_id = $1 and membership_id = 'mem-1'`,
        [ORG_ID],
      )).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });

  test('one ACTIVE membership per athlete per program; history rows coexist; tenancy is composite', async () => {
    const client = await freshDatabase('memberships_shape');
    try {
      await client.query(migrationSql);
      await insertMembership(client, 'mem-1');

      // A second live enrollment in the same program is refused.
      await expect(insertMembership(client, 'mem-2'))
        .rejects.toMatchObject({ code: '23505' });
      // But an ENDED prior stint and a new active one coexist -- history kept.
      await client.query(
        `update pilot.program_memberships set status = 'ended', ended_on = current_date
         where organization_id = $1 and membership_id = 'mem-1'`,
        [ORG_ID],
      );
      await insertMembership(client, 'mem-3');

      // An enrollment claiming this athlete from ANOTHER organization: the
      // composite FK makes the athlete simply not exist there.
      await expect(insertMembership(client, 'mem-cross', { organization_id: OTHER_ORG_ID }))
        .rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.end();
    }
  });
});
