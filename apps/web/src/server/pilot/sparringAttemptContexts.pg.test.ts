// Real PostgreSQL-backed contract test for the sparring-attempt-contexts
// widening migration (owner decision 2026-08-16).
//
// What needs proving that reading SQL cannot prove: the widening applies
// over a live training_attempts install and is a no-op on re-apply; every
// previously legal context remains legal; the four sparring contexts are
// accepted; and an invented context is still refused -- widened, never
// opened.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-sparring-attempt-contexts-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_sparring_attempt_contexts_migration.sql';
const ATTEMPTS_MIGRATION_FILE = 'pilot_slice_postgres_training_attempts_migration.sql';

const ORG_ID = 'org-sparring';
const OTHER_ORG_ID = 'org-elsewhere';
const ADMIN_ID = 'acct-sparring-admin';
const COACH_ID = 'acct-sparring-coach';
const ATHLETE_ID = 'ath-sparring-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let attemptsSql: string;
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
  await client.query(attemptsSql);
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
     values ($1, $2, 'Sparring Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
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
  attemptsSql = await fs.readFile(path.join(INFRA_DIR, ATTEMPTS_MIGRATION_FILE), 'utf8');
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



function insertAttempt(client: Client, attemptId: string, contextType: string) {
  return client.query(
    `insert into pilot.training_attempts
       (organization_id, attempt_id, athlete_id, context_type, metric_kind, direction, achieved_value, recorded_by_account_id)
     values ($1, $2, $3, $4, 'reps', 'at_least', 8, $5)`,
    [ORG_ID, attemptId, ATHLETE_ID, contextType, ADMIN_ID],
  );
}

describe('sparring attempt contexts widening', () => {
  test('widens over a live install, keeps every old context, admits the sparring contexts, and still refuses inventions', async () => {
    const client = await freshDatabase('sparring_widening');
    try {
      // A pre-widening row proves existing data survives.
      await insertAttempt(client, 'att-before', 'open_floor');

      await client.query(migrationSql);
      await client.query(migrationSql); // idempotent re-apply

      for (const context of ['session', 'drill_assignment', 'assessment', 'film_study', 'open_floor']) {
        await insertAttempt(client, `att-old-${context}`, context);
      }
      for (const context of ['technical_sparring', 'sparring_games', 'sparring_drills', 'open_sparring']) {
        await insertAttempt(client, `att-new-${context}`, context);
      }
      await expect(insertAttempt(client, 'att-invented', 'vibes_sparring'))
        .rejects.toMatchObject({ code: '23514' });

      const count = await client.query(
        `select count(*)::int as n from pilot.training_attempts where organization_id = $1`,
        [ORG_ID],
      );
      expect(count.rows[0].n).toBe(10);
    } finally {
      await client.end();
    }
  });
});
