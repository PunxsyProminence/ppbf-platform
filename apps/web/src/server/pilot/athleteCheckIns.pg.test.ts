// Real PostgreSQL-backed contract test for the athlete-check-ins
// migration (Phase 2 slice 1).
//
// What needs proving that reading SQL cannot prove: the migration creates
// the table from nothing and re-applies as a no-op; one check-in per
// athlete per day is a unique index, not a convention; wellness bounds
// (1-5 or null) are database facts; and tenancy holds via the composite
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-athlete-check-ins-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_athlete_check_ins_migration.sql';

const ORG_ID = 'org-checkins';
const OTHER_ORG_ID = 'org-elsewhere';
const ADMIN_ID = 'acct-checkins-admin';
const COACH_ID = 'acct-checkins-coach';
const ATHLETE_ID = 'ath-checkins-1';

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
     values ($1, $2, 'Check-in Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
     on conflict do nothing`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
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




function insertCheckIn(client: Client, checkInId: string, overrides: Record<string, string | number | null> = {}) {
  return client.query(
    `insert into pilot.athlete_check_ins
       (organization_id, check_in_id, athlete_id, checked_in_on, energy)
     values ($1, $2, $3, coalesce($4::date, current_date), $5)`,
    [
      overrides.organization_id ?? ORG_ID,
      checkInId,
      overrides.athlete_id ?? ATHLETE_ID,
      overrides.checked_in_on ?? null,
      overrides.energy ?? null,
    ],
  );
}

describe('athlete check-ins migration', () => {
  test('creates from nothing, re-applies as a no-op, and enforces one check-in per athlete per day', async () => {
    const client = await freshDatabase('checkins_fresh');
    try {
      await client.query(migrationSql);
      await insertCheckIn(client, 'ci-1', { energy: 4 });
      await client.query(migrationSql);

      // The same athlete on the same day is a fact already recorded.
      await expect(insertCheckIn(client, 'ci-dup')).rejects.toMatchObject({ code: '23505' });
      // A different day is a new fact.
      await insertCheckIn(client, 'ci-tomorrow', { checked_in_on: '2030-01-01' });

      // Wellness bounds are database facts: 0 and 6 are refused, null is legal.
      await expect(insertCheckIn(client, 'ci-zero', { checked_in_on: '2030-01-02', energy: 0 }))
        .rejects.toMatchObject({ code: '23514' });
      await expect(insertCheckIn(client, 'ci-six', { checked_in_on: '2030-01-02', energy: 6 }))
        .rejects.toMatchObject({ code: '23514' });

      // Tenancy: another org cannot claim this athlete.
      await expect(insertCheckIn(client, 'ci-cross', { organization_id: OTHER_ORG_ID, checked_in_on: '2030-01-03' }))
        .rejects.toMatchObject({ code: '23503' });

      const rows = await client.query(
        `select count(*)::int as n from pilot.athlete_check_ins where organization_id = $1`,
        [ORG_ID],
      );
      expect(rows.rows[0].n).toBe(2);
    } finally {
      await client.end();
    }
  });
});
