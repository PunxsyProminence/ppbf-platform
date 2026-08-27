// Real PostgreSQL-backed test for the calibration project and clip foundation.
//
// These are database behaviors and a mock cannot prove any of them:
//
//   * a clip cannot reference a video, project or athlete in another
//     organization -- refused by composite foreign key, not by a code review
//   * a clip must have width, enforced even against a writer that bypasses
//     the repository module
//   * millisecond bounds survive the round trip as the exact integers written
//   * the ontology version is stamped and returned unchanged
//   * deleting the source footage takes every calibration row with it, so a
//     research dataset can never anchor against a deletion request
//
// The quarantine posture is tested here too, because it is the claim this
// whole subsystem rests on: a clip may only be cut from a video the platform
// already considers watchable, and that is re-checked on every read rather
// than remembered from creation.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import crypto from 'node:crypto';
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-calibration-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_calibration';

const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-calibration-projects-migration.mjs',
);

const ORG_ID = 'org-calib';
const OTHER_ORG_ID = 'org-calib-other';
const COACH_ID = 'acct-calib-coach';
const OTHER_ORG_COACH_ID = 'acct-calib-other-coach';
const ATHLETE_ID = 'ATH-CALIB-1';
const OTHER_ORG_ATHLETE_ID = 'ATH-CALIB-OTHER';

/** Ready, attributed to an athlete. The ordinary calibration source. */
const READY_VIDEO_ID = 'vs-calib-ready';
/** Ready, unattributed team footage -- the PREFERRED calibration source. */
const READY_TEAM_VIDEO_ID = 'vs-calib-team';
/** Still in quarantine. Must never become clippable. */
const QUARANTINED_VIDEO_ID = 'vs-calib-quarantined';
/** Ready, but belongs to the other organization. */
const OTHER_ORG_VIDEO_ID = 'vs-calib-other-org';

const BASE_SQL = 'pilot_slice_postgres.sql';
const VIDEO_SESSIONS_SQL = 'pilot_slice_postgres_video_sessions_migration.sql';
const CALIBRATION_SQL = 'pilot_slice_postgres_calibration_projects_migration.sql';

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as filmStudyRevisions.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
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

async function loadRunner(): Promise<(client: Client, sql: string) => Promise<void>> {
  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  return runnerModule.applyMigrationTransaction as (client: Client, sql: string) => Promise<void>;
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
     values ($1, $2, 'Calibration Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())
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

/** A database with the base schema only -- no calibration migration. Used to
 * prove the runner's readiness gate can actually go red. */
async function runnerDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(await readMigration(BASE_SQL));
  await client.query(await readMigration(VIDEO_SESSIONS_SQL));
  return client;
}

async function newProject(name: string): Promise<string> {
  const projectId = crypto.randomUUID();
  await calibration.createCalibrationProject({
    organizationId: ORG_ID,
    calibrationProjectId: projectId,
    name,
    ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
    createdByAccountId: COACH_ID,
  });
  return projectId;
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

describe('defining a calibration study', () => {
  test('a project stamps the ontology version and starts in draft', async () => {
    const projectId = crypto.randomUUID();
    const created = await calibration.createCalibrationProject({
      organizationId: ORG_ID,
      calibrationProjectId: projectId,
      name: 'Pilot calibration round one',
      ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
      createdByAccountId: COACH_ID,
    });

    expect(created.ontology_version).toBe('boxing-ontology-0.1');
    expect(created.status).toBe('draft');

    const readBack = await calibration.getCalibrationProject(ORG_ID, projectId);
    expect(readBack?.ontology_version).toBe('boxing-ontology-0.1');
  });

  test('a project cannot be opened under a vocabulary this build cannot validate', async () => {
    await expect(
      calibration.createCalibrationProject({
        organizationId: ORG_ID,
        calibrationProjectId: crypto.randomUUID(),
        name: 'Future ontology',
        ontologyVersion: 'boxing-ontology-0.2',
        createdByAccountId: COACH_ID,
      }),
    ).rejects.toThrow(/ontology_version/);
  });

  test('the database still accepts an older stamp, so historical rows keep their true version', async () => {
    // Creation is pinned in code; storage is not. A project collected under
    // 0.1 must still read as 0.1 after the constant moves on, or every past
    // measurement would silently re-label itself.
    const client = await freshClient();
    try {
      const legacyId = crypto.randomUUID();
      await client.query(
        `insert into pilot.calibration_projects
           (organization_id, calibration_project_id, name, ontology_version, status, created_by_account_id)
         values ($1, $2, 'Historical study', 'boxing-ontology-0.0-pilot', 'archived', $3)`,
        [ORG_ID, legacyId, COACH_ID],
      );
      const row = await calibration.getCalibrationProject(ORG_ID, legacyId);
      expect(row?.ontology_version).toBe('boxing-ontology-0.0-pilot');
    } finally {
      await client.end();
    }
  });

  test('a project name is unique within an organization but free across organizations', async () => {
    const client = await freshClient();
    try {
      await calibration.createCalibrationProject({
        organizationId: ORG_ID,
        calibrationProjectId: crypto.randomUUID(),
        name: 'Shared study name',
        ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
        createdByAccountId: COACH_ID,
      });

      await expect(
        calibration.createCalibrationProject({
          organizationId: ORG_ID,
          calibrationProjectId: crypto.randomUUID(),
          name: 'Shared study name',
          ontologyVersion: ontology.BOXING_ONTOLOGY_VERSION,
          createdByAccountId: COACH_ID,
        }),
      ).rejects.toThrow();

      // The other organization is unaffected: uniqueness is per tenant.
      await expect(
        client.query(
          `insert into pilot.calibration_projects
             (organization_id, calibration_project_id, name, ontology_version, status, created_by_account_id)
           values ($1, $2, 'Shared study name', $3, 'draft', $4)`,
          [OTHER_ORG_ID, crypto.randomUUID(), ontology.BOXING_ONTOLOGY_VERSION, OTHER_ORG_COACH_ID],
        ),
      ).resolves.toBeDefined();
    } finally {
      await client.end();
    }
  });

  test('a project from another organization is invisible, not forbidden', async () => {
    const client = await freshClient();
    try {
      const foreignId = crypto.randomUUID();
      await client.query(
        `insert into pilot.calibration_projects
           (organization_id, calibration_project_id, name, ontology_version, status, created_by_account_id)
         values ($1, $2, 'Other gym study', $3, 'draft', $4)`,
        [OTHER_ORG_ID, foreignId, ontology.BOXING_ONTOLOGY_VERSION, OTHER_ORG_COACH_ID],
      );

      expect(await calibration.getCalibrationProject(ORG_ID, foreignId)).toBeNull();
      expect(await calibration.listCalibrationClips(ORG_ID, foreignId)).toEqual([]);

      const mine = await calibration.listCalibrationProjects(ORG_ID);
      expect(mine.every((project) => project.organization_id === ORG_ID)).toBe(true);
      expect(mine.some((project) => project.calibration_project_id === foreignId)).toBe(false);
    } finally {
      await client.end();
    }
  });
});

describe('cutting a clip', () => {
  test('millisecond bounds survive the round trip as the exact integers written', async () => {
    const projectId = await newProject('Round trip study');
    const created = await calibration.createCalibrationClip({
      organizationId: ORG_ID,
      calibrationClipId: crypto.randomUUID(),
      calibrationProjectId: projectId,
      videoSessionId: READY_TEAM_VIDEO_ID,
      clipCode: 'C-01',
      startMs: 91_337,
      endMs: 97_004,
      primarySamplingReason: 'simultaneous_exchange',
      createdByAccountId: COACH_ID,
    });

    // Not toEqual-with-coercion: the exact type matters. node-postgres hands
    // back int8 as a STRING; int4 as a number. A silent switch to bigint on
    // this column would turn every arithmetic comparison downstream into
    // string concatenation, so the type is asserted, not just the value.
    expect(created.start_ms).toBe(91_337);
    expect(created.end_ms).toBe(97_004);
    expect(typeof created.start_ms).toBe('number');

    const [readBack] = await calibration.listCalibrationClips(ORG_ID, projectId);
    expect(readBack.start_ms).toBe(91_337);
    expect(readBack.end_ms).toBe(97_004);
    expect(readBack.primary_sampling_reason).toBe('simultaneous_exchange');
  });

  test('a clip takes its athlete from the video, never from the caller', async () => {
    const projectId = await newProject('Attribution study');

    const attributed = await calibration.createCalibrationClip({
      organizationId: ORG_ID,
      calibrationClipId: crypto.randomUUID(),
      calibrationProjectId: projectId,
      videoSessionId: READY_VIDEO_ID,
      clipCode: 'C-ATT',
      startMs: 0,
      endMs: 4_000,
      primarySamplingReason: 'isolated_punch',
      createdByAccountId: COACH_ID,
    });
    expect(attributed.athlete_id).toBe(ATHLETE_ID);

    // Unattributed team footage stays unattributed. Inventing an athlete here
    // would put a boxer's name on a clip they may not even appear in.
    const team = await calibration.createCalibrationClip({
      organizationId: ORG_ID,
      calibrationClipId: crypto.randomUUID(),
      calibrationProjectId: projectId,
      videoSessionId: READY_TEAM_VIDEO_ID,
      clipCode: 'C-TEAM',
      startMs: 0,
      endMs: 4_000,
      primarySamplingReason: 'isolated_punch',
      createdByAccountId: COACH_ID,
    });
    expect(team.athlete_id).toBeNull();
  });

  test('a clip must have width, and the database enforces it against a writer that skips the module', async () => {
    const projectId = await newProject('Bounds study');

    await expect(
      calibration.createCalibrationClip({
        organizationId: ORG_ID,
        calibrationClipId: crypto.randomUUID(),
        calibrationProjectId: projectId,
        videoSessionId: READY_TEAM_VIDEO_ID,
        clipCode: 'C-BAD',
        startMs: 5_000,
        endMs: 5_000,
        primarySamplingReason: 'other',
        createdByAccountId: COACH_ID,
      }),
    ).rejects.toThrow(/end_ms/);

    const client = await freshClient();
    try {
      await expect(
        client.query(
          `insert into pilot.calibration_clips
             (organization_id, calibration_clip_id, calibration_project_id, video_session_id,
              athlete_id, clip_code, start_ms, end_ms, primary_sampling_reason, created_by_account_id)
           values ($1, $2, $3, $4, null, 'C-RAW', 9000, 9000, 'other', $5)`,
          [ORG_ID, crypto.randomUUID(), projectId, READY_TEAM_VIDEO_ID, COACH_ID],
        ),
      ).rejects.toThrow(/pilot_calibration_clips_bounds/);
    } finally {
      await client.end();
    }
  });

  test('a negative or fractional offset is refused rather than rounded into a timestamp', async () => {
    const projectId = await newProject('Offset validation study');
    const base = {
      organizationId: ORG_ID,
      calibrationProjectId: projectId,
      videoSessionId: READY_TEAM_VIDEO_ID,
      primarySamplingReason: 'other' as const,
      createdByAccountId: COACH_ID,
    };

    await expect(
      calibration.createCalibrationClip({
        ...base,
        calibrationClipId: crypto.randomUUID(),
        clipCode: 'C-NEG',
        startMs: -1,
        endMs: 500,
      }),
    ).rejects.toThrow(/start_ms/);

    await expect(
      calibration.createCalibrationClip({
        ...base,
        calibrationClipId: crypto.randomUUID(),
        clipCode: 'C-FRAC',
        startMs: 12.5,
        endMs: 500,
      }),
    ).rejects.toThrow(/start_ms/);
  });

  test('an unrecognised sampling reason is rejected, never coerced to other', async () => {
    const projectId = await newProject('Sampling vocabulary study');

    await expect(
      calibration.createCalibrationClip({
        organizationId: ORG_ID,
        calibrationClipId: crypto.randomUUID(),
        calibrationProjectId: projectId,
        videoSessionId: READY_TEAM_VIDEO_ID,
        clipCode: 'C-VOCAB',
        startMs: 0,
        endMs: 1_000,
        // A plausible-looking value that is NOT in the ratified list. The
        // failure mode this guards is a silent rewrite to 'other', which
        // would put a fabricated stratum label on a real sample.
        primarySamplingReason: 'clinch_exchange' as never,
        createdByAccountId: COACH_ID,
      }),
    ).rejects.toThrow(/primary_sampling_reason/);

    expect(await calibration.listCalibrationClips(ORG_ID, projectId)).toEqual([]);
  });

  test('a clip code is unique inside a project and reusable across projects', async () => {
    const first = await newProject('Code uniqueness A');
    const second = await newProject('Code uniqueness B');

    const clip = {
      organizationId: ORG_ID,
      videoSessionId: READY_TEAM_VIDEO_ID,
      clipCode: 'C-01',
      startMs: 0,
      endMs: 3_000,
      primarySamplingReason: 'combination' as const,
      createdByAccountId: COACH_ID,
    };

    await calibration.createCalibrationClip({
      ...clip,
      calibrationClipId: crypto.randomUUID(),
      calibrationProjectId: first,
    });

    await expect(
      calibration.createCalibrationClip({
        ...clip,
        calibrationClipId: crypto.randomUUID(),
        calibrationProjectId: first,
      }),
    ).rejects.toThrow();

    // C-01 in a different study is a different clip, not a collision.
    await expect(
      calibration.createCalibrationClip({
        ...clip,
        calibrationClipId: crypto.randomUUID(),
        calibrationProjectId: second,
      }),
    ).resolves.toBeDefined();
  });
});

describe('quarantine is not opened by calibration', () => {
  test('a quarantined video cannot be clipped', async () => {
    const projectId = await newProject('Quarantine study');

    await expect(
      calibration.createCalibrationClip({
        organizationId: ORG_ID,
        calibrationClipId: crypto.randomUUID(),
        calibrationProjectId: projectId,
        videoSessionId: QUARANTINED_VIDEO_ID,
        clipCode: 'C-QUAR',
        startMs: 0,
        endMs: 2_000,
        primarySamplingReason: 'occlusion',
        createdByAccountId: COACH_ID,
      }),
    ).rejects.toThrow(/not available for calibration/);

    expect(await calibration.listCalibrationClips(ORG_ID, projectId)).toEqual([]);
  });

  test('clippability is re-checked on read, so a video that leaves ready stops being usable', async () => {
    // THE INVARIANT: the clip row is a pointer, never a cached grant. A late
    // scanner verdict or an admin block after the clip was cut must take the
    // footage away from annotators.
    const client = await freshClient();
    try {
      await expect(calibration.assertVideoClippable(ORG_ID, READY_VIDEO_ID)).resolves.toBeDefined();

      await client.query(
        `update pilot.video_sessions set status = 'infected' where video_session_id = $1`,
        [READY_VIDEO_ID],
      );

      await expect(calibration.assertVideoClippable(ORG_ID, READY_VIDEO_ID)).rejects.toThrow(
        /not available for calibration/,
      );
    } finally {
      await client.query(
        `update pilot.video_sessions set status = 'ready' where video_session_id = $1`,
        [READY_VIDEO_ID],
      );
      await client.end();
    }
  });

  test('a video in another organization reads as absent, not as refused', async () => {
    // No existence oracle: the answer for "another gym's video" is the same
    // as for "no such video", so calibration cannot be used to enumerate
    // what other organizations hold.
    await expect(calibration.assertVideoClippable(ORG_ID, OTHER_ORG_VIDEO_ID)).rejects.toThrow(
      /Not found/,
    );
    await expect(calibration.assertVideoClippable(ORG_ID, 'vs-does-not-exist')).rejects.toThrow(
      /Not found/,
    );
  });
});

describe('tenancy is enforced by the database, not by the caller', () => {
  test('a clip cannot reference a video belonging to another organization', async () => {
    const projectId = await newProject('Cross-org video study');
    const client = await freshClient();
    try {
      // Bypasses the repository entirely. The composite foreign key is the
      // claim under test, so the app-layer check must not be what refuses.
      await expect(
        client.query(
          `insert into pilot.calibration_clips
             (organization_id, calibration_clip_id, calibration_project_id, video_session_id,
              athlete_id, clip_code, start_ms, end_ms, primary_sampling_reason, created_by_account_id)
           values ($1, $2, $3, $4, null, 'C-XORG', 0, 1000, 'other', $5)`,
          [ORG_ID, crypto.randomUUID(), projectId, OTHER_ORG_VIDEO_ID, COACH_ID],
        ),
      ).rejects.toThrow(/pilot_calibration_clips_video_fk/);
    } finally {
      await client.end();
    }
  });

  test('a clip cannot reference a project belonging to another organization', async () => {
    const client = await freshClient();
    try {
      const foreignProjectId = crypto.randomUUID();
      await client.query(
        `insert into pilot.calibration_projects
           (organization_id, calibration_project_id, name, ontology_version, status, created_by_account_id)
         values ($1, $2, 'Other gym cross-ref', $3, 'draft', $4)`,
        [OTHER_ORG_ID, foreignProjectId, ontology.BOXING_ONTOLOGY_VERSION, OTHER_ORG_COACH_ID],
      );

      await expect(
        client.query(
          `insert into pilot.calibration_clips
             (organization_id, calibration_clip_id, calibration_project_id, video_session_id,
              athlete_id, clip_code, start_ms, end_ms, primary_sampling_reason, created_by_account_id)
           values ($1, $2, $3, $4, null, 'C-XPROJ', 0, 1000, 'other', $5)`,
          [ORG_ID, crypto.randomUUID(), foreignProjectId, READY_TEAM_VIDEO_ID, COACH_ID],
        ),
      ).rejects.toThrow(/pilot_calibration_clips_project_fk/);
    } finally {
      await client.end();
    }
  });

  test('a clip cannot reference an athlete belonging to another organization', async () => {
    const projectId = await newProject('Cross-org athlete study');
    const client = await freshClient();
    try {
      await expect(
        client.query(
          `insert into pilot.calibration_clips
             (organization_id, calibration_clip_id, calibration_project_id, video_session_id,
              athlete_id, clip_code, start_ms, end_ms, primary_sampling_reason, created_by_account_id)
           values ($1, $2, $3, $4, $5, 'C-XATH', 0, 1000, 'other', $6)`,
          [ORG_ID, crypto.randomUUID(), projectId, READY_TEAM_VIDEO_ID, OTHER_ORG_ATHLETE_ID, COACH_ID],
        ),
      ).rejects.toThrow(/pilot_calibration_clips_athlete_fk/);
    } finally {
      await client.end();
    }
  });

  test('the video tenancy key this migration adds cannot reject any existing row', async () => {
    // video_session_id is already the primary key, so (organization_id,
    // video_session_id) is unique by construction. Asserted rather than
    // reasoned about, because the whole safety argument for altering another
    // migration's table rests on it.
    const client = await freshClient();
    try {
      const { rows } = await client.query<{ duplicate_count: string }>(
        `select count(*)::text as duplicate_count from (
           select organization_id, video_session_id
           from pilot.video_sessions
           group by organization_id, video_session_id
           having count(*) > 1
         ) duplicates`,
      );
      expect(rows[0].duplicate_count).toBe('0');

      const { rows: constraintRows } = await client.query(
        `select 1 from pg_constraint
          where conrelid = 'pilot.video_sessions'::regclass
            and conname = 'pilot_video_sessions_org_video_uq'`,
      );
      expect(constraintRows).toHaveLength(1);
    } finally {
      await client.end();
    }
  });
});

describe('calibration data never outranks a deletion request', () => {
  test('deleting the source footage takes its calibration clips with it', async () => {
    const projectId = await newProject('Deletion cascade study');
    const client = await freshClient();
    try {
      await client.query(
        `insert into pilot.video_sessions
           (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title,
            blob_path, file_name, file_size_bytes, mime_type, status)
         values ('vs-calib-doomed', $1, $2, null, 'Doomed', 'p/doomed.mp4', 'd.mp4', 10, 'video/mp4', 'ready')`,
        [ORG_ID, COACH_ID],
      );

      const clipId = crypto.randomUUID();
      await calibration.createCalibrationClip({
        organizationId: ORG_ID,
        calibrationClipId: clipId,
        calibrationProjectId: projectId,
        videoSessionId: 'vs-calib-doomed',
        clipCode: 'C-DOOM',
        startMs: 0,
        endMs: 1_000,
        primarySamplingReason: 'other',
        createdByAccountId: COACH_ID,
      });
      expect(await calibration.getCalibrationClip(ORG_ID, clipId)).not.toBeNull();

      // The footage goes. Research convenience does not get to block that,
      // and RESTRICT here would have let it.
      await client.query(`delete from pilot.video_sessions where video_session_id = 'vs-calib-doomed'`);

      expect(await calibration.getCalibrationClip(ORG_ID, clipId)).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('deleting a project takes its clips but leaves the footage alone', async () => {
    const projectId = await newProject('Project cascade study');
    const client = await freshClient();
    try {
      const clipId = crypto.randomUUID();
      await calibration.createCalibrationClip({
        organizationId: ORG_ID,
        calibrationClipId: clipId,
        calibrationProjectId: projectId,
        videoSessionId: READY_TEAM_VIDEO_ID,
        clipCode: 'C-PROJ',
        startMs: 0,
        endMs: 1_000,
        primarySamplingReason: 'other',
        createdByAccountId: COACH_ID,
      });

      await client.query(
        `delete from pilot.calibration_projects where organization_id = $1 and calibration_project_id = $2`,
        [ORG_ID, projectId],
      );

      expect(await calibration.getCalibrationClip(ORG_ID, clipId)).toBeNull();

      // Abandoning a study must never remove the gym's footage.
      const { rows } = await client.query(
        `select 1 from pilot.video_sessions where video_session_id = $1`,
        [READY_TEAM_VIDEO_ID],
      );
      expect(rows).toHaveLength(1);
    } finally {
      await client.end();
    }
  });
});

describe('project status', () => {
  test('status moves through the workflow and refuses a value outside it', async () => {
    const projectId = await newProject('Status study');

    const annotating = await calibration.setCalibrationProjectStatus(ORG_ID, projectId, 'annotating');
    expect(annotating?.status).toBe('annotating');

    await expect(
      calibration.setCalibrationProjectStatus(ORG_ID, projectId, 'finished' as never),
    ).rejects.toThrow(/status/);

    // A status write scoped to the wrong organization changes nothing and
    // reports nothing, rather than reporting a refusal that confirms the row.
    expect(
      await calibration.setCalibrationProjectStatus(OTHER_ORG_ID, projectId, 'completed'),
    ).toBeNull();

    const unchanged = await calibration.getCalibrationProject(ORG_ID, projectId);
    expect(unchanged?.status).toBe('annotating');
  });
});

describe('the shipped migration runner', () => {
  test('REFUSES a database where the calibration migration never ran', async () => {
    const applyMigrationTransaction = await loadRunner();
    const client = await runnerDatabase('ppbf_test_calib_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /CALIBRATION_PROJECTS_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const applyMigrationTransaction = await loadRunner();
    const client = await runnerDatabase('ppbf_test_calib_rdy_ok');
    try {
      const migrationSql = await readMigration(CALIBRATION_SQL);
      await applyMigrationTransaction(client, migrationSql);
      // The `all` chain re-runs every migration on every dispatch (#489), so
      // the second pass has to survive its own first pass -- including the
      // catalog-guarded ALTER on pilot.video_sessions.
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });
});
