// Real PostgreSQL-backed contract test for the publication retraction
// migration.
//
// Three things need proving, and none can be proven by reading SQL:
//
// 1. The gap is real. Every migrated environment already carries a status
//    CHECK on pilot.video_publications, so a check that only asks whether
//    some constraint exists passes with or without this migration. The
//    first test inserts a 'retracted' row against the six-value constraint
//    and requires the write to FAIL -- if that ever starts passing, the
//    rest of this file is measuring nothing.
//
// 2. Widening did not open the set, and the suppression columns landed.
//    'retracted' must be accepted, an unrecognized status must still be
//    refused, and the live-shelf read (suppressed_at is null and
//    archived_at is null) must stop returning a suppressed row while the
//    row itself remains present -- suppression is not deletion.
//
// 3. Replaying either migration in either order keeps the widened set. The
//    publications migration creates its table with CREATE TABLE IF NOT
//    EXISTS, so its inline six-value check cannot come back on replay; and
//    this migration's own guard makes a second run a catalog no-op instead
//    of a table-revalidating constraint swap.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-retraction-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_publication_retraction_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-publication-retraction-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-retraction';
const COACH_ID = 'acct-retraction-coach';
const ATHLETE_ID = 'ath-retraction-1';

// The live-shelf read path the partial index serves: one organization's
// unsuppressed, unarchived rows, newest first.
const LIVE_SHELF_SQL = `
  select library_id
  from pilot.research_library
  where organization_id = $1 and archived_at is null and suppressed_at is null
  order by published_at desc`;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string;
let videoSessionsSql: string;
let publicationsSql: string;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;

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

/**
 * Fresh database in the state every migrated environment is already in:
 * base schema, video sessions, and the publications tables with their
 * six-value status vocabulary. This migration is NOT applied here -- each
 * test decides when to apply it.
 */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  await client.query(videoSessionsSql);
  await client.query(publicationsSql);
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
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Retraction Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  await client.query(
    `insert into pilot.video_sessions
       (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, notes,
        blob_path, file_name, file_size_bytes, mime_type, status, created_at, updated_at)
     values ('vs-ret-1', $1, $2, $3, 'Session tape', '', $1 || '/vs-ret-1.mp4', 'tape.mp4', 1024, 'video/mp4', 'ready', now(), now())
     on conflict do nothing`,
    [ORG_ID, COACH_ID, ATHLETE_ID],
  );
  return client;
}

async function insertPublication(client: Client, status: string): Promise<string> {
  const publicationId = `pub_${randomUUID().split('-')[0]}`;
  await client.query(
    `insert into pilot.video_publications
       (publication_id, organization_id, video_session_id, athlete_id, submitted_by_account_id,
        publication_type, title, description, status)
     values ($1, $2, 'vs-ret-1', $3, $4, 'research_library', 'Jab mechanics', 'Six rounds.', $5)`,
    [publicationId, ORG_ID, ATHLETE_ID, COACH_ID, status],
  );
  return publicationId;
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
  videoSessionsSql = await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_video_sessions_migration.sql'), 'utf8');
  publicationsSql = await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_publications_migration.sql'), 'utf8');
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;
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

describe('publication retraction migration against real Postgres', () => {
  test('the gap is real: without the migration a retracted write is refused', async () => {
    const client = await freshDatabase('ppbf_test_retraction_absent');
    try {
      await expect(insertPublication(client, 'retracted')).rejects.toThrow(/status/);
    } finally {
      await client.end();
    }
  });

  test('retracted is accepted afterwards, the set stays closed, and the shelf columns land', async () => {
    const client = await freshDatabase('ppbf_test_retraction_vocabulary');
    try {
      await client.query(migrationSql);

      for (const status of ['draft', 'pending_review', 'approved', 'published', 'rejected', 'archived', 'retracted']) {
        await insertPublication(client, status);
      }

      await expect(insertPublication(client, 'unpublished')).rejects.toThrow(
        /pilot_video_publications_status_check/,
      );

      const columns = await client.query(
        `select column_name from information_schema.columns
         where table_schema = 'pilot' and table_name = 'research_library'
           and column_name in ('suppressed_at', 'suppressed_by_account_id', 'suppressed_reason')`,
      );
      expect(columns.rows).toHaveLength(3);

      const indexes = await client.query(
        `select indexname from pg_indexes where schemaname = 'pilot' and tablename = 'research_library'`,
      );
      expect(indexes.rows.map((r: { indexname: string }) => r.indexname)).toContain('idx_research_library_live');
    } finally {
      await client.end();
    }
  });

  test('a suppressed shelf row leaves the live read but never the table', async () => {
    const client = await freshDatabase('ppbf_test_retraction_shelf');
    try {
      await client.query(migrationSql);

      const pubId = await insertPublication(client, 'published');
      for (const libraryId of ['lib-live', 'lib-suppressed']) {
        await client.query(
          `insert into pilot.research_library
             (library_id, organization_id, publication_id, video_session_id, title, description)
           values ($1, $2, $3, 'vs-ret-1', 'Jab mechanics', 'Six rounds.')`,
          [libraryId, ORG_ID, pubId],
        );
      }

      await client.query(
        `update pilot.research_library
         set suppressed_at = now(), suppressed_by_account_id = $2, suppressed_reason = 'guardian_consent_withdrawn'
         where library_id = 'lib-suppressed' and organization_id = $1`,
        [ORG_ID, COACH_ID],
      );

      const live = await client.query(LIVE_SHELF_SQL, [ORG_ID]);
      expect(live.rows.map((r: { library_id: string }) => r.library_id)).toEqual(['lib-live']);

      // Suppression is not deletion: the row, its attribution, and its
      // reason all remain.
      const kept = await client.query(
        `select suppressed_by_account_id, suppressed_reason from pilot.research_library
         where organization_id = $1 and library_id = 'lib-suppressed'`,
        [ORG_ID],
      );
      expect(kept.rows).toEqual([
        { suppressed_by_account_id: COACH_ID, suppressed_reason: 'guardian_consent_withdrawn' },
      ]);
    } finally {
      await client.end();
    }
  });

  test('re-running this migration, or the publications migration after it, keeps the seven values', async () => {
    const client = await freshDatabase('ppbf_test_retraction_idempotent');
    try {
      await client.query(migrationSql);
      const keptId = await insertPublication(client, 'retracted');

      await client.query(migrationSql);
      // The `all` loop replays the publications migration on every dispatch.
      // Its table (and inline six-value check) is CREATE TABLE IF NOT
      // EXISTS, so the replay must be a no-op rather than a downgrade.
      await client.query(publicationsSql);
      await client.query(migrationSql);

      await insertPublication(client, 'retracted');

      const kept = await client.query(
        `select status from pilot.video_publications
         where organization_id = $1 and publication_id = $2`,
        [ORG_ID, keptId],
      );
      expect(kept.rows).toEqual([{ status: 'retracted' }]);
    } finally {
      await client.end();
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// Every case above applies `migrationSql` with a plain `client.query`, which
// proves the schema and proves nothing about
// scripts/pilot-apply-publication-retraction-migration.mjs's READINESS_QUERY -- the
// assertion that gates the dispatch, and the code whose first real execution
// is against a live environment at the most expensive possible moment. #488
// is what that costs: an assertion that could not pass on ANY database,
// found only by a staging dispatch it then blocked.
//
// The query is never restated here. `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so
// this cannot stay green while the runner rots.
describe('publication retraction runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('pubretr_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /PUBLICATION_RETRACTION_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('pubretr_rdy_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      // The `all` chain re-runs every migration on every dispatch (#489), so
      // the second pass has to survive its own first pass.
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });
});
