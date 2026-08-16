// Real PostgreSQL-backed contract test for the competition-results
// widening migration (owner doctrine 2026-08-16: a loss requires a
// lesson).
//
// What needs proving that reading SQL cannot prove: the widening applies
// over a live external-competition install and re-applies as a no-op;
// existing entries keep a null result (honest: nothing recorded); the
// result vocabulary is closed; and a 'lost' result without a non-blank
// lesson_note is REFUSED BY THE DATABASE -- the unexamined loss has no
// write path at any layer.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-competition-results-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_competition_results_migration.sql';

const ORG_ID = 'org-compresults';
const OTHER_ORG_ID = 'org-elsewhere';
const ADMIN_ID = 'acct-compresults-admin';
const COACH_ID = 'acct-compresults-coach';
const ATHLETE_ID = 'ath-compresults-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let competitionSql: string;
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
  await client.query(competitionSql);
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
     values ($1, $2, 'Results Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
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
  competitionSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_external_competition_migration.sql'), 'utf8');
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





describe('competition results migration', () => {
  test('widens over a live install; a loss without a lesson is refused by the database itself', async () => {
    const client = await freshDatabase('compresults_fresh');
    try {
      await client.query(
        `insert into pilot.external_competitions
           (organization_id, competition_id, competition_name, competition_date, created_by_account_id)
         values ($1, 'comp-1', 'Golden Gloves Regional', '2026-09-01', $2)`,
        [ORG_ID, ADMIN_ID],
      );
      await client.query(
        `insert into pilot.external_competition_entries
           (organization_id, entry_id, competition_id, athlete_id, created_by_account_id)
         values ($1, 'entry-1', 'comp-1', $2, $3)`,
        [ORG_ID, ATHLETE_ID, ADMIN_ID],
      );

      await client.query(migrationSql);
      await client.query(migrationSql); // idempotent re-apply

      const before = await client.query(
        `select result, lesson_note from pilot.external_competition_entries where organization_id = $1 and entry_id = 'entry-1'`,
        [ORG_ID],
      );
      expect(before.rows[0]).toEqual({ result: null, lesson_note: '' });

      await expect(client.query(
        `update pilot.external_competition_entries set result = 'crushed_it' where organization_id = $1 and entry_id = 'entry-1'`,
        [ORG_ID],
      )).rejects.toMatchObject({ code: '23514' });

      // THE RULE: a loss without a lesson has no write path.
      await expect(client.query(
        `update pilot.external_competition_entries set result = 'lost' where organization_id = $1 and entry_id = 'entry-1'`,
        [ORG_ID],
      )).rejects.toMatchObject({ code: '23514' });
      await expect(client.query(
        `update pilot.external_competition_entries set result = 'lost', lesson_note = '   ' where organization_id = $1 and entry_id = 'entry-1'`,
        [ORG_ID],
      )).rejects.toMatchObject({ code: '23514' });

      // The same loss WITH its lesson lands; a win needs none.
      await client.query(
        `update pilot.external_competition_entries
         set result = 'lost', lesson_note = 'kept dropping the right hand in round 2'
         where organization_id = $1 and entry_id = 'entry-1'`,
        [ORG_ID],
      );
      await client.query(
        `update pilot.external_competition_entries set result = 'won', lesson_note = '' where organization_id = $1 and entry_id = 'entry-1'`,
        [ORG_ID],
      );
    } finally {
      await client.end();
    }
  });
});
