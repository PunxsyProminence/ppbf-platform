// Real PostgreSQL-backed test for the video_sessions migration.
//
// Two things need proving, and neither can be proven by reading SQL:
//
// 1. The migration repairs a 100%-failure bug. The upload route inserts
//    status = 'quarantined', but the CHECK constraint the route-borne DDL
//    created allowed only ('uploaded','processing','ready','error',
//    'archived'). Every video upload therefore failed at the database --
//    the same shape as the volunteers feature (#113), which had also never
//    worked once. This suite runs the route's real INSERT and asserts it now
//    succeeds.
//
// 2. It repairs environments that ALREADY have the table. `create table if
//    not exists` is a no-op against them, so the old CHECK survives unless
//    the catalog-guarded DO block replaces it. This suite creates the OLD
//    shape first, applies the migration over it, and asserts the upload works
//    afterwards -- which is the only case that matters for staging and
//    production, since both may already carry the route-created table.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-video-sessions-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_video_sessions_migration.sql';

// Verbatim from apps/web/app/api/pilot/video/upload/route.ts. Copied rather
// than imported because the statement lives inside a Next route handler; if
// the route's columns or its 'quarantined' literal ever change, this test
// keeps asserting the old contract and the mismatch shows up here.
const UPLOAD_INSERT = `insert into pilot.video_sessions
   (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, notes, blob_path, file_name, file_size_bytes, mime_type, status, created_at, updated_at)
 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'quarantined', now(), now())`;

const UPLOAD_PARAMS = [
  'vs-1', 'org-video', 'acct-coach', null, 'Session tape', '',
  'org-video/vs-1.mp4', 'tape.mp4', 1024, 'video/mp4',
];

// The shape the route-borne DDL creates today, including the stale CHECK.
const LEGACY_TABLE = `
  create table if not exists pilot.video_sessions (
    video_session_id text primary key,
    organization_id text not null,
    uploaded_by_account_id text not null,
    athlete_id text null,
    title text not null,
    notes text not null default '',
    blob_path text not null,
    file_name text not null,
    file_size_bytes bigint not null,
    mime_type text not null,
    status text not null default 'uploaded' check (status in ('uploaded', 'processing', 'ready', 'error', 'archived')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;

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

/** Fresh database per case, so each starts from a known schema state. */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query('create schema if not exists pilot');
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

describe('video_sessions migration against real Postgres', () => {
  test('the defect is real: the legacy CHECK rejects the status the app writes', async () => {
    const client = await freshDatabase('ppbf_test_video_legacy');
    try {
      await client.query(LEGACY_TABLE);
      await expect(client.query(UPLOAD_INSERT, UPLOAD_PARAMS)).rejects.toThrow(
        /violates check constraint "video_sessions_status_check"/,
      );
    } finally {
      await client.end();
    }
  });

  test('a fresh install accepts the real upload INSERT', async () => {
    const client = await freshDatabase('ppbf_test_video_fresh');
    try {
      await client.query(migrationSql);
      await client.query(UPLOAD_INSERT, UPLOAD_PARAMS);

      const row = await client.query('select status from pilot.video_sessions where video_session_id = $1', ['vs-1']);
      expect(row.rows[0].status).toBe('quarantined');
    } finally {
      await client.end();
    }
  });

  test('an environment that already has the legacy table is repaired', async () => {
    // The case that matters for staging and production: both may already
    // carry the route-created table, where `create table if not exists` does
    // nothing and only the DO block can replace the stale constraint.
    const client = await freshDatabase('ppbf_test_video_upgrade');
    try {
      await client.query(LEGACY_TABLE);
      await expect(client.query(UPLOAD_INSERT, UPLOAD_PARAMS)).rejects.toThrow(/check constraint/);

      await client.query(migrationSql);
      await client.query(UPLOAD_INSERT, UPLOAD_PARAMS);

      const row = await client.query('select status from pilot.video_sessions where video_session_id = $1', ['vs-1']);
      expect(row.rows[0].status).toBe('quarantined');
    } finally {
      await client.end();
    }
  });

  test('existing rows survive the constraint replacement', async () => {
    const client = await freshDatabase('ppbf_test_video_rows');
    try {
      await client.query(LEGACY_TABLE);
      await client.query(UPLOAD_INSERT.replace("'quarantined'", "'ready'"), UPLOAD_PARAMS);

      await client.query(migrationSql);

      const row = await client.query('select status from pilot.video_sessions where video_session_id = $1', ['vs-1']);
      expect(row.rows[0].status).toBe('ready');
    } finally {
      await client.end();
    }
  });

  test('re-running is idempotent and leaves the corrected constraint in place', async () => {
    const client = await freshDatabase('ppbf_test_video_idempotent');
    try {
      await client.query(migrationSql);
      await client.query(migrationSql);
      await client.query(migrationSql);

      await client.query(UPLOAD_INSERT, UPLOAD_PARAMS);

      const constraints = await client.query(
        `select count(*)::int as n
         from pg_constraint
         where conrelid = 'pilot.video_sessions'::regclass
           and conname = 'video_sessions_status_check'`,
      );
      expect(constraints.rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('the corrected constraint still rejects an unknown status', async () => {
    // Widening the allowed set must not turn the column into free text: the
    // read path branches on these values, so an unrecognized one would be a
    // video in an unhandled state.
    const client = await freshDatabase('ppbf_test_video_reject');
    try {
      await client.query(migrationSql);
      await expect(
        client.query(UPLOAD_INSERT.replace("'quarantined'", "'definitely-not-a-state'"), UPLOAD_PARAMS),
      ).rejects.toThrow(/violates check constraint/);
    } finally {
      await client.end();
    }
  });

  // ─── Scan bookkeeping (#49) ───────────────────────────────────────────────
  // Quarantine now has an exit. These prove the columns the sweep claims and
  // settles into actually arrive -- on a fresh install AND on the legacy
  // route-created table, which is the shape staging and production carry.

  test('a fresh install lands every scan column with the safe defaults', async () => {
    const client = await freshDatabase('ppbf_test_video_scan_fresh');
    try {
      await client.query(migrationSql);
      await client.query(UPLOAD_INSERT, UPLOAD_PARAMS);

      const row = await client.query(
        `select status, scan_state, scan_detail, scan_attempts, scan_claimed_at, scanned_at,
                scan_next_attempt_at <= now() as due_now
         from pilot.video_sessions where video_session_id = $1`,
        ['vs-1'],
      );
      // A fresh upload is quarantined, unscanned, and immediately eligible.
      expect(row.rows[0]).toMatchObject({
        status: 'quarantined',
        scan_state: 'pending',
        scan_attempts: 0,
        scan_claimed_at: null,
        scanned_at: null,
        due_now: true,
      });
      expect(row.rows[0].scan_detail).toEqual({});
    } finally {
      await client.end();
    }
  });

  test('the legacy route-created table gains the scan columns', async () => {
    // The case that matters operationally. Without this the sweep's claim
    // query would reference columns that are not there, and every scan attempt
    // would error against a table the environment believes is up to date.
    const client = await freshDatabase('ppbf_test_video_scan_upgrade');
    try {
      await client.query(LEGACY_TABLE);
      await expect(
        client.query('select scan_state from pilot.video_sessions'),
      ).rejects.toThrow(/column "scan_state" does not exist/);

      await client.query(migrationSql);
      await client.query(UPLOAD_INSERT, UPLOAD_PARAMS);

      const row = await client.query(
        'select scan_state, scan_attempts from pilot.video_sessions where video_session_id = $1',
        ['vs-1'],
      );
      expect(row.rows[0]).toMatchObject({ scan_state: 'pending', scan_attempts: 0 });
    } finally {
      await client.end();
    }
  });

  test('a video quarantined BEFORE this migration becomes eligible for its first scan', async () => {
    // The owner's own upload is exactly this row: it landed quarantined while
    // nothing could promote it. Backfilling it to 'pending' with an immediate
    // next-attempt time is what lets the sweep pick it up rather than leaving
    // it stranded for having arrived too early.
    const client = await freshDatabase('ppbf_test_video_scan_backfill');
    try {
      // Reconstruct the pre-#49 migration by cutting at the section marker.
      // Asserted rather than assumed: if the marker is ever renamed, this
      // fails loudly instead of quietly applying the WHOLE migration and
      // "passing" without testing the backfill at all.
      //
      // The marker is plain ASCII deliberately. A box-drawing divider here
      // made the whole migration unapplicable to any Postgres not encoded
      // UTF-8, which passed on CI and failed on every Windows developer
      // machine. Do not decorate it.
      const markerIndex = migrationSql.indexOf('-- Scan bookkeeping');
      expect(markerIndex).toBeGreaterThan(0);
      await client.query(migrationSql.slice(0, markerIndex));
      await client.query(UPLOAD_INSERT, UPLOAD_PARAMS);

      await client.query(migrationSql);

      const row = await client.query(
        `select status, scan_state, scan_next_attempt_at <= now() as due_now
         from pilot.video_sessions where video_session_id = $1`,
        ['vs-1'],
      );
      expect(row.rows[0]).toMatchObject({ status: 'quarantined', scan_state: 'pending', due_now: true });
    } finally {
      await client.end();
    }
  });

  test('scan_state is constrained, not free text', async () => {
    const client = await freshDatabase('ppbf_test_video_scan_reject');
    try {
      await client.query(migrationSql);
      await client.query(UPLOAD_INSERT, UPLOAD_PARAMS);

      await expect(
        client.query('update pilot.video_sessions set scan_state = $1', ['definitely-not-a-scan-state']),
      ).rejects.toThrow(/violates check constraint "video_sessions_scan_state_check"/);

      // Every state the policy can produce must be accepted, or a real scan
      // would fail at settle time with the verdict already computed.
      for (const state of ['pending', 'scanning', 'passed', 'infected', 'blocked', 'needs_human_review', 'unconfigured']) {
        await client.query('update pilot.video_sessions set scan_state = $1', [state]);
      }
    } finally {
      await client.end();
    }
  });

  test('re-running leaves exactly one scan_state constraint and one scan-queue index', async () => {
    const client = await freshDatabase('ppbf_test_video_scan_idempotent');
    try {
      await client.query(migrationSql);
      await client.query(migrationSql);
      await client.query(migrationSql);

      const constraints = await client.query(
        `select count(*)::int as n
         from pg_constraint
         where conrelid = 'pilot.video_sessions'::regclass
           and conname = 'video_sessions_scan_state_check'`,
      );
      expect(constraints.rows[0].n).toBe(1);

      const indexes = await client.query(
        `select count(*)::int as n from pg_indexes
         where schemaname = 'pilot' and indexname = 'idx_video_sessions_scan_queue'`,
      );
      expect(indexes.rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('both indexes exist after the migration', async () => {
    const client = await freshDatabase('ppbf_test_video_indexes');
    try {
      await client.query(migrationSql);
      const indexes = await client.query(
        `select indexname from pg_indexes where schemaname = 'pilot' and tablename = 'video_sessions' order by indexname`,
      );
      const names = indexes.rows.map((r: { indexname: string }) => r.indexname);
      expect(names).toContain('idx_video_sessions_org_created');
      expect(names).toContain('idx_video_sessions_athlete');
    } finally {
      await client.end();
    }
  });
});
