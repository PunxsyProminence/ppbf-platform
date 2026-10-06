// Real PostgreSQL-backed test: the retention purge removes a purged athlete's
// video rows, their stored video files and the athlete's portrait file.
//
// WHY. pilot.video_sessions.athlete_id has no foreign key to pilot.athletes, so
// deleting the athlete row left every video row behind, still naming an
// athlete_id the roster is free to give to a different child once the purge has
// run (rosterImport.ts rejects only ids still present in pilot.athletes). The
// stored files were never touched either (audit CL-B3; DATA_RETENTION.md,
// "Stored files").
//
// The blob store is a directory on disk here, reached through the script's
// PPBF_RETENTION_BLOB_STUB_DIR seam, which the script honours only for a
// localhost database. Everything else -- the dry-run default, the savepoints,
// the audit row -- is the real script run as its own process, as the schedule
// runs it. It NEVER connects to production or staging.

import { type ChildProcessByStdio, execFile, spawn } from 'node:child_process';
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-retention-video-pg-test-${Date.now()}`);
const BLOB_DIR = path.join(os.tmpdir(), `ppbf-retention-video-blobs-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const CLEANUP_SCRIPT = path.resolve(__dirname, '../../../scripts/pilot-cleanup-deleted-data.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_retention_video';

const ORG = 'org-video-purge';
const COACH = 'acct-video-purge-coach';
const PURGED = 'ATH-VIDEO-PURGED';
const KEPT = 'ATH-VIDEO-KEPT';
const PURGED_LOGIN = 'acct-video-purged-athlete';
const VIDEO_A = 'vid-purged-1';
const VIDEO_B = 'vid-purged-2';
const VIDEO_KEPT = 'vid-kept-1';
const VIDEO_CONTAINER = 'ppbf-pilot-video';
const PROFILE_CONTAINER = 'ppbf-pilot-profile';
const PORTRAIT_PATH = `${ORG}/${PURGED_LOGIN}/portrait.jpg`;

const videoPath = (videoId: string) => `${ORG}/${videoId}/clip.mp4`;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('NO_PORT')));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function applyMigration(file: string): Promise<void> {
  await client.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
}

async function putBlob(container: string, blobPath: string): Promise<void> {
  const target = path.join(BLOB_DIR, container, ...blobPath.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, 'bytes');
}

async function blobExists(container: string, blobPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(BLOB_DIR, container, ...blobPath.split('/')));
    return true;
  } catch {
    return false;
  }
}

async function runCleanup(extraEnv: Record<string, string>): Promise<{
  code: number;
  event: Record<string, unknown>;
  output: string;
}> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLEANUP_SCRIPT],
      {
        env: {
          ...process.env,
          AZURE_POSTGRES_CONNECTION_STRING: connectionStringFor(TEST_DB_NAME),
          PPBF_EXPECTED_POSTGRES_HOSTNAME: 'localhost',
          PPBF_EXPECTED_POSTGRES_DATABASE: TEST_DB_NAME,
          PPBF_POSTGRES_DISABLE_SSL: 'true',
          // Never real storage from a test, whatever the developer's shell holds.
          PPBF_RETENTION_STORAGE_ACCOUNT_URL: '',
          PPBF_RETENTION_BLOB_STUB_DIR: '',
          PPBF_PILOT_VIDEO_CONTAINER: '',
          PPBF_PILOT_PROFILE_CONTAINER: '',
          ...extraEnv,
        },
      },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`;
        const lines = output.split('\n').filter((entry) => entry.trim().startsWith('{'));
        // The run's own verdict is its LAST structured line.
        const line = lines[lines.length - 1];
        if (!line) {
          reject(new Error(`No JSON output. stdout=${stdout} stderr=${stderr}`));
          return;
        }
        const code = error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as unknown as { code: number }).code
          : 0;
        resolve({ code, event: JSON.parse(line) as Record<string, unknown>, output });
      },
    );
  });
}

async function videoIds(): Promise<string[]> {
  const rows = await client.query<{ video_session_id: string }>(
    'select video_session_id from pilot.video_sessions',
  );
  // Sorted here, not by the database's collation, which orders '-' differently.
  return rows.rows.map((row) => row.video_session_id).sort();
}

/** Seeds, from nothing, the expired athlete with two videos and a portrait. */
async function seedPurgeable(): Promise<void> {
  await client.query(`delete from pilot.compliance_violations`);
  await client.query(`delete from pilot.video_sessions`);
  await client.query(`delete from pilot.account_profiles`);
  await client.query(`delete from pilot.accounts where account_id = $1`, [PURGED_LOGIN]);
  await client.query(`delete from pilot.athletes`);
  await fs.rm(BLOB_DIR, { recursive: true, force: true });

  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
     values ($1, $2, 'Purged Athlete', '2013-05-06', 'fly', 'inactive', 'contact', false, $4, now(), now(), now() - interval '3 years'),
            ($1, $3, 'Kept Athlete', '2013-05-06', 'fly', 'active', 'contact', true, $4, now(), now(), null)`,
    [ORG, PURGED, KEPT, COACH],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, deleted_at, active_flag)
     values ($1, 'athlete', $2, 'ppbf_local', $3, now() - interval '3 years', false)`,
    [PURGED_LOGIN, ORG, PURGED],
  );
  for (const [videoId, athleteId] of [[VIDEO_A, PURGED], [VIDEO_B, PURGED], [VIDEO_KEPT, KEPT]]) {
    await client.query(
      `insert into pilot.video_sessions
         (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, blob_path,
          file_name, file_size_bytes, mime_type)
       values ($1, $2, $3, $4, 'clip', $5, 'clip.mp4', 5, 'video/mp4')`,
      [videoId, ORG, COACH, athleteId, videoPath(videoId)],
    );
    await putBlob(VIDEO_CONTAINER, videoPath(videoId));
  }
  await client.query(
    `insert into pilot.account_profiles
       (organization_id, account_id, photo_blob_path, photo_content_type, photo_bytes, photo_review_state)
     values ($1, $2, $3, 'image/jpeg', 5, 'released')`,
    [ORG, PURGED_LOGIN, PORTRAIT_PATH],
  );
  await putBlob(PROFILE_CONTAINER, PORTRAIT_PATH);
  // A violation recorded against the KEPT athlete on the purged athlete's
  // video: its foreign key onto video_sessions has no delete action, so it
  // would refuse the video's deletion. The record is the other child's and
  // must survive; only its pointer at the gone video is cleared.
  await client.query(
    `insert into pilot.compliance_violations
       (violation_id, organization_id, rule_id, video_session_id, athlete_id, detected_by_account_id,
        violation_timestamp, severity)
     values ('viol-1', $1, 'rule-1', $2, $3, $4, now(), 'low')`,
    [ORG, VIDEO_A, KEPT, COACH],
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

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  await applyMigration('pilot_slice_postgres.sql');
  await applyMigration('pilot_slice_postgres_data_retention_deletion_migration.sql');
  await applyMigration('pilot_slice_postgres_onboarding_migration.sql');
  await applyMigration('pilot_slice_postgres_video_sessions_migration.sql');
  await applyMigration('pilot_slice_postgres_compliance_migration.sql');
  await applyMigration('pilot_slice_postgres_profile_identity_migration.sql');

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [ORG],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft')`,
    [COACH, ORG],
  );
  await client.query(
    `insert into pilot.compliance_rules (rule_id, organization_id, rule_name, rule_category, description, detection_logic)
     values ('rule-1', $1, 'rule', 'safety', 'd', 'l')`,
    [ORG],
  );
});

afterAll(async () => {
  if (client) await client.end();
  await fs.rm(BLOB_DIR, { recursive: true, force: true });
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

describe("the retention purge removes a purged athlete's videos and files", () => {
  test('a dry run lists the video rows and files it would delete, and deletes none', async () => {
    await seedPurgeable();
    const { code, event } = await runCleanup({ PPBF_RETENTION_BLOB_STUB_DIR: BLOB_DIR });

    expect(code).toBe(0);
    expect(event.event).toBe('retention.cleanup.dry-run');
    expect(event.would_delete_athletes).toBe(1);
    expect(event.would_delete_videos).toBe(2);
    // Two video files and one portrait, all present.
    expect(event.would_delete_files).toBe(3);
    expect(event.files_missing).toBe(0);

    expect(await videoIds()).toEqual([VIDEO_KEPT, VIDEO_A, VIDEO_B].sort());
    expect(await blobExists(VIDEO_CONTAINER, videoPath(VIDEO_A))).toBe(true);
    expect(await blobExists(VIDEO_CONTAINER, videoPath(VIDEO_B))).toBe(true);
    expect(await blobExists(PROFILE_CONTAINER, PORTRAIT_PATH)).toBe(true);
  });

  test("applying deletes the athlete's video rows, video files and portrait, and nobody else's", async () => {
    await seedPurgeable();
    const { code, event } = await runCleanup({
      PPBF_RETENTION_BLOB_STUB_DIR: BLOB_DIR,
      PPBF_RETENTION_APPLY: 'true',
    });

    expect(code).toBe(0);
    expect(event.event).toBe('retention.cleanup.completed');
    expect(event.athletes).toBe(1);
    expect(event.videos).toBe(2);
    expect(event.files_deleted).toBe(3);

    expect(await videoIds()).toEqual([VIDEO_KEPT]);
    expect(await blobExists(VIDEO_CONTAINER, videoPath(VIDEO_A))).toBe(false);
    expect(await blobExists(VIDEO_CONTAINER, videoPath(VIDEO_B))).toBe(false);
    expect(await blobExists(VIDEO_CONTAINER, videoPath(VIDEO_KEPT))).toBe(true);
    expect(await blobExists(PROFILE_CONTAINER, PORTRAIT_PATH)).toBe(false);

    const profile = await client.query(
      `select photo_blob_path, photo_review_state from pilot.account_profiles
        where organization_id = $1 and account_id = $2`,
      [ORG, PURGED_LOGIN],
    );
    expect(profile.rows[0]).toEqual({ photo_blob_path: null, photo_review_state: 'removed' });

    // The other child's compliance record survives; it just no longer points
    // at a video that is gone.
    const violation = await client.query(
      `select athlete_id, video_session_id from pilot.compliance_violations where violation_id = 'viol-1'`,
    );
    expect(violation.rows[0]).toEqual({ athlete_id: KEPT, video_session_id: null });

    const audit = await client.query<{ details: Record<string, unknown> }>(
      `select details from pilot.audit_events where event_type = 'data_purged' order by created_at desc limit 1`,
    );
    expect(audit.rows[0].details).toMatchObject({ videos_deleted: 2, files_deleted: 3 });
    // Counts only: no stored-file path reaches the audit row.
    expect(JSON.stringify(audit.rows[0].details)).not.toContain(ORG + '/');
  });

  test('a reissued athlete_id does not inherit the purged child\'s video', async () => {
    await seedPurgeable();
    await runCleanup({ PPBF_RETENTION_BLOB_STUB_DIR: BLOB_DIR, PPBF_RETENTION_APPLY: 'true' });
    // The roster gives the freed id to a new child.
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'New Child', '2015-01-01', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [ORG, PURGED, COACH],
    );
    const inherited = await client.query(
      'select count(*)::int as n from pilot.video_sessions where organization_id = $1 and athlete_id = $2',
      [ORG, PURGED],
    );
    expect(inherited.rows[0].n).toBe(0);
  });

  test('with no storage access, the athlete is not purged and the run fails loudly', async () => {
    await seedPurgeable();
    const { code, event, output } = await runCleanup({ PPBF_RETENTION_APPLY: 'true' });

    expect(code).not.toBe(0);
    expect(event.blocked_by).toEqual({ STORAGE_CREDENTIAL_MISSING: 1 });
    expect(event.athletes).toBe(0);
    // Rows stay so the next run, with access, can delete the files they point at.
    expect(await videoIds()).toEqual([VIDEO_KEPT, VIDEO_A, VIDEO_B].sort());
    const athlete = await client.query(
      'select count(*)::int as n from pilot.athletes where organization_id = $1 and athlete_id = $2',
      [ORG, PURGED],
    );
    expect(athlete.rows[0].n).toBe(1);
    expect(output).not.toContain(videoPath(VIDEO_A));
  });

  test('a dry run with no storage access fails too, so the schedule warns before anyone applies', async () => {
    await seedPurgeable();
    const { code, event } = await runCleanup({});
    expect(code).not.toBe(0);
    expect(event.blocked_by).toEqual({ STORAGE_CREDENTIAL_MISSING: 1 });
  });

  test("an athlete's videos do not count against the blast radius, which counts people", async () => {
    await seedPurgeable();
    // One athlete, two videos: a cap of 1 still purges them.
    const { code, event } = await runCleanup({
      PPBF_RETENTION_BLOB_STUB_DIR: BLOB_DIR,
      PPBF_RETENTION_APPLY: 'true',
      PPBF_RETENTION_MAX_ROWS: '1',
    });
    expect(code).toBe(0);
    expect(event.athletes).toBe(1);
    expect(event.videos).toBe(2);
  });

  test('a file already gone does not block the purge of its row', async () => {
    await seedPurgeable();
    await fs.rm(path.join(BLOB_DIR, VIDEO_CONTAINER, ...videoPath(VIDEO_B).split('/')));
    const dry = await runCleanup({ PPBF_RETENTION_BLOB_STUB_DIR: BLOB_DIR });
    expect(dry.event.files_missing).toBe(1);

    const { code, event } = await runCleanup({
      PPBF_RETENTION_BLOB_STUB_DIR: BLOB_DIR,
      PPBF_RETENTION_APPLY: 'true',
    });
    expect(code).toBe(0);
    expect(event.videos).toBe(2);
    expect(event.files_deleted).toBe(2);
    expect(await videoIds()).toEqual([VIDEO_KEPT]);
  });

  test('the blob stub is refused when ?host= would send the connection elsewhere', async () => {
    const { code, event } = await runCleanup({
      PPBF_RETENTION_BLOB_STUB_DIR: BLOB_DIR,
      AZURE_POSTGRES_CONNECTION_STRING: `${connectionStringFor(TEST_DB_NAME)}?host=db.example.test`,
    });
    expect(code).not.toBe(0);
    expect(event.reason).toBe('BLOB_STUB_NOT_LOCAL');
  });

  test('a storage account URL that is not an Azure blob endpoint is refused', async () => {
    await seedPurgeable();
    const { code, event } = await runCleanup({ PPBF_RETENTION_STORAGE_ACCOUNT_URL: 'https://example.test/' });
    expect(code).not.toBe(0);
    expect(event.code).toBe('STORAGE_ACCOUNT_URL_INVALID');
    expect(await videoIds()).toEqual([VIDEO_KEPT, VIDEO_A, VIDEO_B].sort());
  });

  test('the blob stub is refused for a database that is not local', async () => {
    await seedPurgeable();
    const { code, event } = await runCleanup({
      PPBF_RETENTION_BLOB_STUB_DIR: BLOB_DIR,
      AZURE_POSTGRES_CONNECTION_STRING: `postgres://u:p@db.example.test:5432/${TEST_DB_NAME}`,
      PPBF_EXPECTED_POSTGRES_HOSTNAME: 'db.example.test',
    });
    expect(code).not.toBe(0);
    expect(event.event).toBe('retention.cleanup.refused');
    expect(event.reason).toBe('BLOB_STUB_NOT_LOCAL');
  });
});
