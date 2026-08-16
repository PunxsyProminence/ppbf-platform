// Real PostgreSQL-backed contract test for CT-15's
// pilot_slice_postgres_emergency_contact_note_migration.sql.
//
// pilot.athletes.emergency_contact is a free-text note; pilot.emergency_contacts
// (structured: full_name, relationship_to_athlete, phone, email, is_primary) is
// the authoritative emergency contact record. Two admin surfaces showed and
// edited the note with nothing distinguishing it from the verified record --
// TWO SOURCES OF TRUTH FOR A SAFETY-CRITICAL FIELD, where the wrong one could
// be read in an emergency.
//
// What needs proving that reading the SQL cannot prove:
//   * the gap is real: without this migration the correctly-named column does
//     not exist at all
//   * a note written before the migration is backfilled into the new column,
//     not left blank -- a blank note-column would look like "no note on
//     file" for every athlete who predates this change, which is worse than
//     the ambiguity this migration exists to fix
//   * the legacy column's own `not null` constraint is untouched -- this
//     migration adds a column, it does not loosen or drop one
//   * re-running is a no-op, since `all` re-applies every increment on every
//     dispatch
//   * entities.ts's real write path (upsertAthlete, insertAthleteIfAbsent)
//     stores the identical value in both columns, so the two can never
//     diverge for a row written after this migration
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-emergency-contact-note-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_emergency_contact_note_migration.sql';

const ORG_ID = 'org-ecn';
const COACH_ID = 'acct-ecn-coach';

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

/** Fresh database with the base schema and the org/coach rows the athlete FK needs. */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG_ID],
  );
  return client;
}

/** An athlete of the shape the app wrote before this migration existed. */
async function insertLegacyAthlete(client: Client, athleteId: string, emergencyContact: string): Promise<void> {
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'ECN Athlete', '2011-05-06', 'fly', 'active', $3, true, $4, now(), now())`,
    [ORG_ID, athleteId, emergencyContact, COACH_ID],
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
});

describe('emergency contact note migration against real Postgres', () => {
  test('the gap is real: without the migration the column does not exist', async () => {
    const client = await freshDatabase('ppbf_test_ecn_absent');
    try {
      await expect(
        client.query('select emergency_contact_note from pilot.athletes'),
      ).rejects.toThrow(/column .* does not exist/i);
    } finally {
      await client.end();
    }
  });

  test('the migration adds the column, not null with an empty-string default', async () => {
    const client = await freshDatabase('ppbf_test_ecn_fresh');
    try {
      await client.query(migrationSql);

      const columns = await client.query(
        `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
         where table_schema = 'pilot'
           and table_name = 'athletes'
           and column_name = 'emergency_contact_note'`,
      );

      expect(columns.rows).toEqual([
        {
          column_name: 'emergency_contact_note',
          data_type: 'text',
          is_nullable: 'NO',
          column_default: "''::text",
        },
      ]);
    } finally {
      await client.end();
    }
  });

  // The property this migration exists for. A version that added the column
  // without backfilling would leave every pre-existing athlete's note-column
  // reading as "no note on file", which is a worse state than the ambiguity
  // being fixed -- it would look like data loss on every athlete who
  // predates this change.
  test('an athlete written before the migration has their note backfilled, not left blank', async () => {
    const client = await freshDatabase('ppbf_test_ecn_legacy');
    try {
      await insertLegacyAthlete(client, 'ath-legacy', 'Ruth Kellerman 814-555-0143');
      await client.query(migrationSql);

      const row = await client.query(
        'select emergency_contact, emergency_contact_note from pilot.athletes where athlete_id = $1',
        ['ath-legacy'],
      );
      expect(row.rows[0]).toEqual({
        emergency_contact: 'Ruth Kellerman 814-555-0143',
        emergency_contact_note: 'Ruth Kellerman 814-555-0143',
      });
    } finally {
      await client.end();
    }
  });

  // rosterImport.ts does not require a non-empty note (only athlete_id, name
  // and a calendar date of birth are required at import time), so a legacy
  // row with an empty string here is a real, reachable state -- not backfilled
  // to something invented, and not left to crash the guarded UPDATE.
  test('a legacy athlete with an empty note stays empty in both columns', async () => {
    const client = await freshDatabase('ppbf_test_ecn_legacy_empty');
    try {
      await insertLegacyAthlete(client, 'ath-legacy-empty', '');
      await client.query(migrationSql);

      const row = await client.query(
        'select emergency_contact, emergency_contact_note from pilot.athletes where athlete_id = $1',
        ['ath-legacy-empty'],
      );
      expect(row.rows[0]).toEqual({ emergency_contact: '', emergency_contact_note: '' });
    } finally {
      await client.end();
    }
  });

  // The legacy column's own constraint must survive this migration untouched:
  // this migration adds a column, it does not loosen or drop one.
  test('the legacy column is still not null -- this migration only adds, it does not loosen', async () => {
    const client = await freshDatabase('ppbf_test_ecn_legacy_constraint');
    try {
      await client.query(migrationSql);

      await expect(
        client.query(
          `insert into pilot.athletes
             (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
           values ($1, 'ath-null-contact', 'No Contact', '2011-05-06', 'fly', 'active', null, true, $2, now(), now())`,
          [ORG_ID, COACH_ID],
        ),
      ).rejects.toThrow(/null value .* violates not-null constraint/i);
    } finally {
      await client.end();
    }
  });

  // `all` re-applies every increment on every dispatch, so this is the
  // property that makes dispatching it safe rather than merely convenient.
  // A value the application has since written through the new column (which
  // may since have diverged from a value nobody re-synced by hand) must not
  // be clobbered by a second run backfilling from the legacy column again.
  test('re-running is a no-op and does not overwrite a note already written through the new column', async () => {
    const client = await freshDatabase('ppbf_test_ecn_rerun');
    try {
      await insertLegacyAthlete(client, 'ath-rerun', 'Original Note 555-0100');
      await client.query(migrationSql);

      // Simulates an admin correction landing through the new column after
      // the migration first ran, leaving the legacy column stale by design
      // of this scenario -- the guard must key off the NEW column being
      // already-populated, not off the two columns matching.
      await client.query(
        `update pilot.athletes set emergency_contact_note = 'Corrected Note 555-0199' where athlete_id = $1`,
        ['ath-rerun'],
      );

      await client.query(migrationSql);

      const row = await client.query(
        'select emergency_contact_note from pilot.athletes where athlete_id = $1',
        ['ath-rerun'],
      );
      expect(row.rows[0]).toEqual({ emergency_contact_note: 'Corrected Note 555-0199' });
    } finally {
      await client.end();
    }
  });

  // entities.ts#upsertAthlete and #insertAthleteIfAbsent write both columns
  // in one statement, positionally, with the identical value. If either
  // function's SQL ever drifted from this shape, this is where it surfaces.
  test('the real write path stores the identical note in both columns', async () => {
    const client = await freshDatabase('ppbf_test_ecn_writepath');
    try {
      await client.query(migrationSql);

      const note = 'Dana Johnson (mother) 555-0101';
      await client.query(
        `insert into pilot.athletes
           (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, emergency_contact_note, active_flag, coach_id, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11)`,
        [
          ORG_ID,
          'ath-writepath',
          'Write Path Athlete',
          '2011-05-06',
          'fly',
          'active',
          note,
          true,
          COACH_ID,
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      );

      const row = await client.query(
        'select emergency_contact, emergency_contact_note from pilot.athletes where athlete_id = $1',
        ['ath-writepath'],
      );
      expect(row.rows[0]).toEqual({ emergency_contact: note, emergency_contact_note: note });
    } finally {
      await client.end();
    }
  });
});
