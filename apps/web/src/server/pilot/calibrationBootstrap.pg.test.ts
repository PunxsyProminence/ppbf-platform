// Real PostgreSQL-backed test for the operator bootstrap that turns an
// existing 'ready' video into a calibration study and clip.
//
// These are database behaviors and a mock cannot prove any of them:
//
//   * the clip carries the SOURCE video's own video_session_id, so the study
//     points at the footage the platform already holds rather than a copy
//   * the athlete on the clip is the athlete on the video row -- and is null
//     when the footage is unattributed team footage
//   * a source that is quarantined, missing, or in another organization is
//     refused, and leaves NO study behind to be mistaken for a real one
//   * the source video row is not touched by being annotated against
//   * the rows the bootstrap creates are the rows the existing read paths
//     behind /coach/calibration return
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-calibration-bootstrap-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_calibration_bootstrap';

const ORG_ID = 'org-boot';
const OTHER_ORG_ID = 'org-boot-other';
const COACH_ID = 'acct-boot-coach';
const OTHER_ORG_COACH_ID = 'acct-boot-other-coach';
const ATHLETE_ID = 'ATH-BOOT-1';
const OTHER_ORG_ATHLETE_ID = 'ATH-BOOT-OTHER';

/** Ready, attributed to an athlete. */
const READY_VIDEO_ID = 'vs-boot-ready';
/** Ready, unattributed team footage. */
const READY_TEAM_VIDEO_ID = 'vs-boot-team';
/** Still in quarantine. Must never become clippable. */
const QUARANTINED_VIDEO_ID = 'vs-boot-quarantined';
/** Ready, but belongs to the other organization. */
const OTHER_ORG_VIDEO_ID = 'vs-boot-other-org';

const BASE_SQL = 'pilot_slice_postgres.sql';
const VIDEO_SESSIONS_SQL = 'pilot_slice_postgres_video_sessions_migration.sql';
const CALIBRATION_SQL = 'pilot_slice_postgres_calibration_projects_migration.sql';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let bootstrap: typeof import('./calibration/bootstrap');
let calibration: typeof import('./calibration/projects');
let ontology: typeof import('./calibration/ontology');

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

async function readMigration(name: string): Promise<string> {
  return fs.readFile(path.join(INFRA_DIR, name), 'utf8');
}

async function seedTenancy(client: Client): Promise<void> {
  for (const orgId of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [orgId],
    );
  }

  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [OTHER_ORG_COACH_ID, OTHER_ORG_ID],
  );

  // pilot.athletes declares created_at/updated_at NOT NULL with no defaults.
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Bootstrap Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())
     on conflict do nothing`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Other Org Athlete', '2010-02-02', 'fly', 'active', 'contact', true, $3, now(), now())
     on conflict do nothing`,
    [OTHER_ORG_ID, OTHER_ORG_ATHLETE_ID, OTHER_ORG_COACH_ID],
  );

  const videos: Array<[string, string, string | null, string, string]> = [
    [READY_VIDEO_ID, ORG_ID, ATHLETE_ID, 'ready', COACH_ID],
    [READY_TEAM_VIDEO_ID, ORG_ID, null, 'ready', COACH_ID],
    [QUARANTINED_VIDEO_ID, ORG_ID, ATHLETE_ID, 'quarantined', COACH_ID],
    [OTHER_ORG_VIDEO_ID, OTHER_ORG_ID, OTHER_ORG_ATHLETE_ID, 'ready', OTHER_ORG_COACH_ID],
  ];
  for (const [videoId, orgId, athleteId, status, uploader] of videos) {
    await client.query(
      `insert into pilot.video_sessions
         (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title,
          blob_path, file_name, file_size_bytes, mime_type, status)
       values ($1, $2, $3, $4, 'Sparring round', $5, 'round.mp4', 1024, 'video/mp4', $6)
       on conflict do nothing`,
      [videoId, orgId, uploader, athleteId, `${orgId}/${videoId}.mp4`, status],
    );
  }
}

async function freshClient(): Promise<Client> {
  const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  return client;
}

/** A bootstrap request with the meaningful values fixed, overridable per test. */
function request(
  overrides: Partial<import('./calibration/bootstrap').CalibrationBootstrapRequest> = {},
): import('./calibration/bootstrap').CalibrationBootstrapRequest {
  return {
    organizationId: ORG_ID,
    videoSessionId: READY_VIDEO_ID,
    projectName: `Study ${crypto.randomUUID()}`,
    clipCode: 'C-01',
    startMs: 91_337,
    endMs: 97_004,
    primarySamplingReason: 'simultaneous_exchange',
    createdByAccountId: COACH_ID,
    ...overrides,
  };
}

async function projectCount(): Promise<number> {
  return (await calibration.listCalibrationProjects(ORG_ID)).length;
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

  const migrateClient = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await migrateClient.connect();
  await migrateClient.query(await readMigration(BASE_SQL));
  await migrateClient.query(await readMigration(VIDEO_SESSIONS_SQL));
  await migrateClient.query(await readMigration(CALIBRATION_SQL));
  await seedTenancy(migrateClient);
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  bootstrap = await import('./calibration/bootstrap');
  calibration = await import('./calibration/projects');
  ontology = await import('./calibration/ontology');
});

afterAll(async () => {
  const { closePool } = await import('./db');
  await closePool();

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

describe('establishing a ready video as a calibration study', () => {
  test('creates a draft study and one clip against the existing services', () => {
    return (async () => {
      const { project, clip } = await bootstrap.bootstrapCalibrationClip(request());

      // Nothing here is chosen by the bootstrap: 'draft' is the only status
      // createCalibrationProject can write, and the ontology version is the
      // only one this build can validate.
      expect(project.status).toBe('draft');
      expect(project.ontology_version).toBe(ontology.BOXING_ONTOLOGY_VERSION);
      expect(project.organization_id).toBe(ORG_ID);

      expect(clip.calibration_project_id).toBe(project.calibration_project_id);
      expect(clip.clip_code).toBe('C-01');
      expect(clip.start_ms).toBe(91_337);
      expect(clip.end_ms).toBe(97_004);
      expect(clip.primary_sampling_reason).toBe('simultaneous_exchange');
    })();
  });

  test('the clip carries the REAL source video_session_id, not a copy or a new id', async () => {
    // The whole point of the slice: the study points at footage the platform
    // already holds. A clip that invented an id would be a study about nothing.
    const { clip } = await bootstrap.bootstrapCalibrationClip(request({ clipCode: 'C-02' }));
    expect(clip.video_session_id).toBe(READY_VIDEO_ID);
  });

  test('attribution is read off the video: the athlete when there is one', async () => {
    const { clip } = await bootstrap.bootstrapCalibrationClip(request({ clipCode: 'C-03' }));
    expect(clip.athlete_id).toBe(ATHLETE_ID);
  });

  test('attribution is read off the video: null for unattributed team footage', async () => {
    // The request type has no athlete field at all, so there is no way for an
    // operator to fill this in. Team footage stays team footage.
    const { clip } = await bootstrap.bootstrapCalibrationClip(
      request({ videoSessionId: READY_TEAM_VIDEO_ID, clipCode: 'C-04' }),
    );
    expect(clip.athlete_id).toBeNull();
  });

  test('creates no derived media and does not touch the source row', async () => {
    const client = await freshClient();
    try {
      const before = await client.query(
        'select * from pilot.video_sessions where video_session_id = $1',
        [READY_VIDEO_ID],
      );
      const countBefore = await client.query('select count(*)::int as n from pilot.video_sessions');

      await bootstrap.bootstrapCalibrationClip(request({ clipCode: 'C-05' }));

      const after = await client.query(
        'select * from pilot.video_sessions where video_session_id = $1',
        [READY_VIDEO_ID],
      );
      const countAfter = await client.query('select count(*)::int as n from pilot.video_sessions');

      // Byte-for-byte the same row -- blob_path, status, updated_at and all.
      // Entering calibration is not an event in the life of the footage.
      expect(after.rows[0]).toEqual(before.rows[0]);
      expect(countAfter.rows[0].n).toBe(countBefore.rows[0].n);
    } finally {
      await client.end();
    }
  });

  test('the resulting rows are the ones the existing picker reads', async () => {
    // Acceptance criterion 6, at the layer /coach/calibration's two GET routes
    // actually call: listCalibrationProjects then listCalibrationClips.
    const { project, clip } = await bootstrap.bootstrapCalibrationClip(
      request({ clipCode: 'C-06' }),
    );

    const projects = await calibration.listCalibrationProjects(ORG_ID);
    expect(projects.map((row) => row.calibration_project_id))
      .toContain(project.calibration_project_id);

    const clips = await calibration.listCalibrationClips(ORG_ID, project.calibration_project_id);
    expect(clips.map((row) => row.calibration_clip_id)).toContain(clip.calibration_clip_id);
    expect(clips[0].video_session_id).toBe(READY_VIDEO_ID);
  });
});

describe('a source the platform will not open is refused, and leaves nothing behind', () => {
  test('REFUSES a quarantined source', async () => {
    const before = await projectCount();

    await expect(
      bootstrap.bootstrapCalibrationClip(request({ videoSessionId: QUARANTINED_VIDEO_ID })),
    ).rejects.toThrow(/not available for calibration/);

    // THE REASON THE GATE RUNS FIRST. If the study were created before the
    // source was checked, a refused run would still leave an empty draft
    // study, and the operator's next attempt would be their second one.
    expect(await projectCount()).toBe(before);
  });

  test('REFUSES a source that does not exist', async () => {
    const before = await projectCount();

    await expect(
      bootstrap.bootstrapCalibrationClip(request({ videoSessionId: 'vs-does-not-exist' })),
    ).rejects.toThrow(/Not found/);

    expect(await projectCount()).toBe(before);
  });

  test('REFUSES another organization’s video, with the same answer as for no video', async () => {
    // No existence oracle: the operator learns nothing about whether another
    // gym's footage exists.
    const before = await projectCount();

    await expect(
      bootstrap.bootstrapCalibrationClip(request({ videoSessionId: OTHER_ORG_VIDEO_ID })),
    ).rejects.toThrow(/Not found/);

    expect(await projectCount()).toBe(before);
  });

  test('REFUSES a clip with no width, through the existing bounds check', async () => {
    await expect(
      bootstrap.bootstrapCalibrationClip(request({ startMs: 97_004, endMs: 91_337 })),
    ).rejects.toThrow(/a clip must end after it starts/);
  });
});

describe('re-running the bootstrap', () => {
  test('REFUSES a study name this organization has already used', async () => {
    // pilot_calibration_projects_name_uq. Two studies with the same name would
    // be indistinguishable in the annotator's picker, which is the one place
    // the name is read.
    const fixed = request({ projectName: 'Round one, camera A', clipCode: 'C-07' });

    await bootstrap.bootstrapCalibrationClip(fixed);
    await expect(bootstrap.bootstrapCalibrationClip(fixed)).rejects.toThrow();
  });
});
