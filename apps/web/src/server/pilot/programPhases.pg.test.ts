// Real PostgreSQL-backed contract test for the program-phases migration
// (module 129).
//
// What needs proving that reading SQL cannot prove: the migration creates
// the table from nothing and re-applies as a no-op; ONE OPEN PHASE per
// program is a partial unique index (a program cannot be in two blocks at
// once) while closed history accumulates freely; and a phase cannot end
// before it began.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-program-phases-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_program_phases_migration.sql';

const ORG_ID = 'org-phases';
const OTHER_ORG_ID = 'org-elsewhere';
const ADMIN_ID = 'acct-phases-admin';
const COACH_ID = 'acct-phases-coach';
const ATHLETE_ID = 'ath-phases-1';

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
     values ($1, $2, 'Phases Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
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





function insertPhase(client: Client, phaseId: string, overrides: Record<string, string | null> = {}) {
  return client.query(
    `insert into pilot.program_phases
       (organization_id, phase_id, program_name, phase_name, started_on, ended_on, created_by_account_id)
     values ($1, $2, $3, $4, $5::date, $6::date, $7)`,
    [
      ORG_ID,
      phaseId,
      overrides.program_name ?? 'Youth Boxing',
      overrides.phase_name ?? 'Foundation',
      overrides.started_on ?? '2026-01-01',
      overrides.ended_on ?? null,
      ADMIN_ID,
    ],
  );
}

describe('program phases migration', () => {
  test('creates from nothing, re-applies as a no-op, and allows exactly one open phase per program', async () => {
    const client = await freshDatabase('phases_fresh');
    try {
      await client.query(migrationSql);
      await insertPhase(client, 'ph-1');
      await client.query(migrationSql);

      // A second OPEN phase for the same program is refused.
      await expect(insertPhase(client, 'ph-dup', { phase_name: 'Competition prep', started_on: '2026-03-01' }))
        .rejects.toMatchObject({ code: '23505' });

      // A different program may run its own open phase.
      await insertPhase(client, 'ph-other', { program_name: 'Wrestling' });

      // Closed history accumulates freely for the same program.
      await client.query(
        `update pilot.program_phases set ended_on = '2026-02-28' where organization_id = $1 and phase_id = 'ph-1'`,
        [ORG_ID],
      );
      await insertPhase(client, 'ph-2', { phase_name: 'Competition prep', started_on: '2026-03-01' });
      await client.query(
        `update pilot.program_phases set ended_on = '2026-05-31' where organization_id = $1 and phase_id = 'ph-2'`,
        [ORG_ID],
      );
      await insertPhase(client, 'ph-3', { phase_name: 'Off season', started_on: '2026-06-01' });

      // A phase cannot end before it began.
      await expect(client.query(
        `update pilot.program_phases set ended_on = '2025-12-31' where organization_id = $1 and phase_id = 'ph-3'`,
        [ORG_ID],
      )).rejects.toMatchObject({ code: '23514' });

      const rows = await client.query(
        `select count(*)::int as n from pilot.program_phases where organization_id = $1`,
        [ORG_ID],
      );
      expect(rows.rows[0].n).toBe(4);
    } finally {
      await client.end();
    }
  });
});
