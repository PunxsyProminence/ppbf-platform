// Real PostgreSQL-backed contract test for the wrestling-league migration.
//
// What needs proving that reading SQL cannot prove: the migration creates all
// three tables from nothing; re-applying it is a no-op that leaves rows
// untouched; the status vocabularies are enforced by the database; and the
// tenancy shape holds -- events and roster entries can only reference a
// season (and an athlete) in the SAME organization, and an athlete cannot be
// rostered twice on one season.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-wrestling-league-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_wrestling_league_migration.sql';

const ORG_ID = 'org-league';
const OTHER_ORG_ID = 'org-elsewhere';
const ADMIN_ID = 'acct-league-admin';
const COACH_ID = 'acct-league-coach';
const ATHLETE_ID = 'ath-league-1';

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
     values ($1, $2, 'League Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
     on conflict do nothing`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  return client;
}

function insertSeason(client: Client, seasonId: string, overrides: Record<string, string> = {}) {
  return client.query(
    `insert into pilot.wrestling_league_seasons
       (organization_id, season_id, season_name, starts_on, status, created_by_account_id)
     values ($1, $2, $3, $4::date, $5, $6)`,
    [
      overrides.organization_id ?? ORG_ID,
      seasonId,
      overrides.season_name ?? 'Winter League 2026',
      overrides.starts_on ?? '2026-11-01',
      overrides.status ?? 'planned',
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

describe('wrestling league migration', () => {
  test('creates all three tables from nothing and accepts a valid chain', async () => {
    const client = await freshDatabase('league_fresh');
    try {
      await client.query(migrationSql);
      await insertSeason(client, 'season-1');
      await client.query(
        `insert into pilot.wrestling_league_events
           (organization_id, event_id, season_id, event_name, event_date, created_by_account_id)
         values ($1, 'event-1', 'season-1', 'Opening Duals', '2026-11-08'::date, $2)`,
        [ORG_ID, ADMIN_ID],
      );
      await client.query(
        `insert into pilot.wrestling_league_roster_entries
           (organization_id, entry_id, season_id, athlete_id, created_by_account_id)
         values ($1, 'entry-1', 'season-1', $2, $3)`,
        [ORG_ID, ATHLETE_ID, ADMIN_ID],
      );

      const roster = await client.query(
        `select r.athlete_id, a.full_name
         from pilot.wrestling_league_roster_entries r
         join pilot.athletes a on a.organization_id = r.organization_id and a.athlete_id = r.athlete_id
         where r.organization_id = $1 and r.season_id = 'season-1'`,
        [ORG_ID],
      );
      expect(roster.rows).toEqual([{ athlete_id: ATHLETE_ID, full_name: 'League Athlete' }]);
    } finally {
      await client.end();
    }
  });

  test('re-applying over an existing install is a no-op that leaves rows untouched', async () => {
    const client = await freshDatabase('league_noop');
    try {
      await client.query(migrationSql);
      await insertSeason(client, 'season-keep');
      await client.query(migrationSql);

      const rows = await client.query(
        'select season_id from pilot.wrestling_league_seasons where organization_id = $1',
        [ORG_ID],
      );
      expect(rows.rows.map((row) => row.season_id)).toEqual(['season-keep']);
    } finally {
      await client.end();
    }
  });

  test('the vocabularies and date sanity are enforced by the database', async () => {
    const client = await freshDatabase('league_vocab');
    try {
      await client.query(migrationSql);

      await expect(insertSeason(client, 'season-bad', { status: 'someday' }))
        .rejects.toMatchObject({ code: '23514' });
      await expect(insertSeason(client, 'season-blank', { season_name: '   ' }))
        .rejects.toMatchObject({ code: '23514' });
      // An end date before the start is a season that never happened.
      await expect(client.query(
        `insert into pilot.wrestling_league_seasons
           (organization_id, season_id, season_name, starts_on, ends_on, created_by_account_id)
         values ($1, 'season-backwards', 'B', '2026-11-01'::date, '2026-10-01'::date, $2)`,
        [ORG_ID, ADMIN_ID],
      )).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });

  test('tenancy is structural: cross-org references and duplicate roster rows are refused', async () => {
    const client = await freshDatabase('league_tenancy');
    try {
      await client.query(migrationSql);
      await insertSeason(client, 'season-1');

      // An event claiming this season from ANOTHER organization: the
      // composite FK makes the season simply not exist there.
      await expect(client.query(
        `insert into pilot.wrestling_league_events
           (organization_id, event_id, season_id, event_name, event_date, created_by_account_id)
         values ($1, 'event-cross', 'season-1', 'Duals', '2026-11-08'::date, $2)`,
        [OTHER_ORG_ID, ADMIN_ID],
      )).rejects.toMatchObject({ code: '23503' });

      // Same for a roster entry: the athlete FK is composite too.
      await expect(client.query(
        `insert into pilot.wrestling_league_roster_entries
           (organization_id, entry_id, season_id, athlete_id, created_by_account_id)
         values ($1, 'entry-cross', 'season-1', $2, $3)`,
        [OTHER_ORG_ID, ATHLETE_ID, ADMIN_ID],
      )).rejects.toMatchObject({ code: '23503' });

      // One membership per athlete per season.
      await client.query(
        `insert into pilot.wrestling_league_roster_entries
           (organization_id, entry_id, season_id, athlete_id, created_by_account_id)
         values ($1, 'entry-1', 'season-1', $2, $3)`,
        [ORG_ID, ATHLETE_ID, ADMIN_ID],
      );
      await expect(client.query(
        `insert into pilot.wrestling_league_roster_entries
           (organization_id, entry_id, season_id, athlete_id, created_by_account_id)
         values ($1, 'entry-2', 'season-1', $2, $3)`,
        [ORG_ID, ATHLETE_ID, ADMIN_ID],
      )).rejects.toMatchObject({ constraint: 'pilot_wrestling_league_roster_unique' });
    } finally {
      await client.end();
    }
  });
});
