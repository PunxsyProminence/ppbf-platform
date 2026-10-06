// Real PostgreSQL-backed test for videoClipTags.ts and the video-clip-tags
// migration: the composite keys (same organization, and a competition tag
// only for an athlete entered in it), one live tag per athlete per video,
// the refusals for teaching footage and for footage with a live publication,
// the publication gate, the athlete/parent list filter, the coach clip scope,
// and the "no table means no tags" answer before the migration is applied.
// Disposable local embedded Postgres only; NEVER production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import { seedCaptureTake } from '../../testing/captureFixture';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-cliptags-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_cliptags';
const PRE_MIGRATION_DB_NAME = 'ppbf_test_cliptags_pre';

// Order matters: capture-sessions adds capture_take_id to video_sessions, and
// publications references video_sessions.
const PREREQUISITES = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
  // The consent gate the clip tags call reads covers_video, which arrives here.
  'pilot_slice_postgres_guardian_media_consent_migration.sql',
  'pilot_slice_postgres_video_sessions_migration.sql',
  'pilot_slice_postgres_capture_sessions_migration.sql',
  'pilot_slice_postgres_external_competition_migration.sql',
  'pilot_slice_postgres_publications_migration.sql',
  // Before video-clip-tags, as production applies them; the sparring link
  // below needs pilot.sparring_exposure.
  'pilot_slice_postgres_activity_log_migration.sql',
  'pilot_slice_postgres_sparring_exposure_and_load_migration.sql',
];
const MIGRATION_FILE = 'pilot_slice_postgres_video_clip_tags_migration.sql';
// Every tag read selects exposure_id since the sparring link landed, so the
// migrated database carries it too (proven in videoClipTagsSparringLink.pg.test.ts,
// on the full production schema). This suite does not touch sparring_exposure
// itself, so its later alters (session-date, contact-stage) are not applied.
// The consent gate also reads a purged guardian's retained choice
// (pilot.retained_media_consent_restrictions), deployed after video-clip-tags.
const FOLLOW_ON = [
  'pilot_slice_postgres_video_clip_tags_sparring_link_migration.sql',
  'pilot_slice_postgres_retained_media_restriction_migration.sql',
];
const MIGRATION_RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-video-clip-tags-migration.mjs');

const ORG = 'org-cliptags-a';
const OTHER_ORG = 'org-cliptags-b';
const COACH_A = 'coach-cliptags-a';
const COACH_B = 'coach-cliptags-b';
const OTHER_ORG_COACH = 'coach-cliptags-other';
const ATHLETE_A = 'ath-cliptags-a';
const ATHLETE_B = 'ath-cliptags-b';
const ATHLETE_DELETED = 'ath-cliptags-deleted';
const COMPETITION = 'comp-cliptags-1';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let tags: typeof import('./videoClipTags');
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let prerequisiteSql: string[];
let migrationSql: string;
let followOnSql: string[];

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
  for (const sql of prerequisiteSql) {
    await client.query(sql);
  }
  return client;
}

async function seed(client: Client): Promise<void> {
  for (const org of [ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  for (const [account, org] of [[COACH_A, ORG], [COACH_B, ORG], [OTHER_ORG_COACH, OTHER_ORG]]) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
      [account, org],
    );
  }
  for (const [athlete, coach] of [[ATHLETE_A, COACH_A], [ATHLETE_B, COACH_B], [ATHLETE_DELETED, COACH_A]]) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag,
          coach_id, created_at, updated_at)
       values ($1, $2, $2, '2011-01-01', '120lb', 'active', 'Contact', true, $3, now(), now())`,
      [ORG, athlete, coach],
    );
  }
  await client.query(
    `insert into pilot.external_competitions
       (organization_id, competition_id, competition_name, competition_date, created_by_account_id)
     values ($1, $2, 'Silver Gloves', '2026-11-01', $3)`,
    [ORG, COMPETITION, COACH_A],
  );
  // Only athlete A is entered.
  await client.query(
    `insert into pilot.external_competition_entries
       (organization_id, entry_id, competition_id, athlete_id, created_by_account_id)
     values ($1, 'entry-a', $2, $3, $4)`,
    [ORG, COMPETITION, ATHLETE_A, COACH_A],
  );
}

async function insertVideo(
  client: Client,
  videoId: string,
  options: { org?: string; athleteId?: string | null; status?: string; take?: { recordingSessionId: string; captureTakeId: string } } = {},
): Promise<void> {
  await client.query(
    `insert into pilot.video_sessions
       (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title,
        blob_path, file_name, file_size_bytes, mime_type, status, recording_session_id, capture_take_id)
     values ($1, $2, $3, $4, $1, 'p/v.mp4', 'v.mp4', 10, 'video/mp4', $5, $6, $7)`,
    [
      videoId,
      options.org ?? ORG,
      options.org === OTHER_ORG ? OTHER_ORG_COACH : COACH_A,
      options.athleteId === undefined ? ATHLETE_A : options.athleteId,
      options.status ?? 'ready',
      options.take?.recordingSessionId ?? null,
      options.take?.captureTakeId ?? null,
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

  prerequisiteSql = await Promise.all(PREREQUISITES.map((file) => fs.readFile(path.join(INFRA_DIR, file), 'utf8')));
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
  followOnSql = await Promise.all(FOLLOW_ON.map((file) => fs.readFile(path.join(INFRA_DIR, file), 'utf8')));
  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (client: Client, sql: string) => Promise<void>;
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

describe('before the migration is applied', () => {
  let pre: Client;

  beforeAll(async () => {
    pre = await freshDatabase(PRE_MIGRATION_DB_NAME);
    await seed(pre);
    await insertVideo(pre, 'vid-pre');
    process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(PRE_MIGRATION_DB_NAME);
    process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
    jest.resetModules();
    tags = await import('./videoClipTags');
  });

  afterAll(async () => {
    await pre.end();
    const { closePool } = await import('./db');
    await closePool();
  });

  test('no table reads as no tags, so existing video routes keep working', async () => {
    await expect(tags.listLiveTagSubjects(ORG, 'vid-pre')).resolves.toEqual([]);
    await expect(tags.untaggedVideoSql('v')).resolves.toBe('');
    await expect(tags.assertVideoHasNoLiveClipTags(ORG, 'vid-pre')).resolves.toBeUndefined();
  });

  test('the publish-claim form checks by name, leaving the transaction usable', async () => {
    await pre.query('begin');
    await tags.assertVideoHasNoLiveClipTags(ORG, 'vid-pre', pre);
    await expect(pre.query('select 1 as ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
    await pre.query('rollback');
  });
});

describe('video_clip_tags migration and videoClipTags.ts against the real schema', () => {
  let main: Client;

  beforeAll(async () => {
    main = await freshDatabase(TEST_DB_NAME);
    await seed(main);
    await applyMigrationTransaction(main, migrationSql);
    // Idempotent: a second run is a no-op and still passes readiness.
    await applyMigrationTransaction(main, migrationSql);
    for (const sql of followOnSql) {
      await main.query(sql);
    }

    await insertVideo(main, 'vid-bout');
    await insertVideo(main, 'vid-spar', { athleteId: null });
    await insertVideo(main, 'vid-archived', { status: 'archived' });
    await insertVideo(main, 'vid-published');
    await insertVideo(main, 'vid-other-org', { org: OTHER_ORG, athleteId: null });
    const take = await seedCaptureTake(main, { organizationId: ORG, createdByAccountId: COACH_A });
    await insertVideo(main, 'vid-teach', { athleteId: null, take });
    await main.query(
      `insert into pilot.video_publications
         (publication_id, organization_id, video_session_id, athlete_id, submitted_by_account_id,
          publication_type, title, description, status)
       values ('pub-1', $1, 'vid-published', $2, $3, 'research_library', 'Pub', '', 'draft')`,
      [ORG, ATHLETE_A, COACH_A],
    );

    process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
    process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
    jest.resetModules();
    tags = await import('./videoClipTags');
  });

  afterAll(async () => {
    await main.end();
    const { closePool } = await import('./db');
    await closePool();
  });

  const base = {
    organizationId: ORG,
    competitionId: null as string | null,
    note: '',
    taggedByAccountId: COACH_A,
  };

  test('a competition tag is admitted only for an athlete entered in that competition', async () => {
    const tag = await tags.addClipTag({
      ...base, videoSessionId: 'vid-bout', athleteId: ATHLETE_A, eventKind: 'competition', competitionId: COMPETITION,
    });
    expect(tag).toMatchObject({ athlete_id: ATHLETE_A, event_kind: 'competition', competition_id: COMPETITION });

    await expect(tags.addClipTag({
      ...base, videoSessionId: 'vid-bout', athleteId: ATHLETE_B, eventKind: 'competition', competitionId: COMPETITION,
    })).rejects.toMatchObject({ code: 'CLIP_TAG_NOT_ENTERED' });
  });

  test('a withdrawn entry does not admit a competition tag', async () => {
    await main.query(
      `insert into pilot.external_competition_entries
         (organization_id, entry_id, competition_id, athlete_id, status, created_by_account_id)
       values ($1, 'entry-b-withdrawn', $2, $3, 'withdrawn', $4)`,
      [ORG, COMPETITION, ATHLETE_B, COACH_A],
    );
    await expect(tags.addClipTag({
      ...base, videoSessionId: 'vid-bout', athleteId: ATHLETE_B, eventKind: 'competition', competitionId: COMPETITION,
    })).rejects.toMatchObject({ code: 'CLIP_TAG_NOT_ENTERED' });
  });

  test('every athlete on one clip shares its event', async () => {
    // vid-bout is already a competition clip for athlete A.
    await expect(tags.addClipTag({
      ...base, videoSessionId: 'vid-bout', athleteId: ATHLETE_B, eventKind: 'sparring',
    })).rejects.toMatchObject({ code: 'CLIP_TAG_EVENT_MISMATCH' });
  });

  test('a competition tag must name the competition; a sparring tag must not', async () => {
    await expect(tags.addClipTag({
      ...base, videoSessionId: 'vid-spar', athleteId: ATHLETE_A, eventKind: 'competition',
    })).rejects.toMatchObject({ code: 'CLIP_TAG_EVENT_REQUIRED' });
    await expect(tags.addClipTag({
      ...base, videoSessionId: 'vid-spar', athleteId: ATHLETE_A, eventKind: 'sparring', competitionId: COMPETITION,
    })).rejects.toMatchObject({ code: 'CLIP_TAG_EVENT_MIXED' });
  });

  test('the database refuses a mixed event even when the module is bypassed', async () => {
    await expect(main.query(
      `insert into pilot.video_clip_tags
         (organization_id, tag_id, video_session_id, athlete_id, event_kind, competition_id, tagged_by_account_id)
       values ($1, 'raw-1', 'vid-spar', $2, 'sparring', $3, $4)`,
      [ORG, ATHLETE_A, COMPETITION, COACH_A],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(main.query(
      `insert into pilot.video_clip_tags
         (organization_id, tag_id, video_session_id, athlete_id, event_kind, tagged_by_account_id)
       values ($1, 'raw-2', 'vid-spar', $2, 'scored', $3)`,
      [ORG, ATHLETE_A, COACH_A],
    )).rejects.toMatchObject({ code: '23514' });
  });

  test('a tag cannot point at another organization\'s video, even by a raw insert', async () => {
    await expect(main.query(
      `insert into pilot.video_clip_tags
         (organization_id, tag_id, video_session_id, athlete_id, event_kind, tagged_by_account_id)
       values ($1, 'raw-3', 'vid-other-org', $2, 'sparring', $3)`,
      [ORG, ATHLETE_A, COACH_A],
    )).rejects.toMatchObject({ code: '23503' });
    await expect(tags.addClipTag({
      ...base, videoSessionId: 'vid-other-org', athleteId: ATHLETE_A, eventKind: 'sparring',
    })).rejects.toMatchObject({ code: 'CLIP_TAG_VIDEO_NOT_TAGGABLE' });
  });

  test('two athletes on one sparring clip; one live tag each; removal frees the slot', async () => {
    const a = await tags.addClipTag({ ...base, videoSessionId: 'vid-spar', athleteId: ATHLETE_A, eventKind: 'sparring' });
    await tags.addClipTag({ ...base, videoSessionId: 'vid-spar', athleteId: ATHLETE_B, eventKind: 'sparring' });

    await expect(tags.addClipTag({
      ...base, videoSessionId: 'vid-spar', athleteId: ATHLETE_A, eventKind: 'sparring',
    })).rejects.toMatchObject({ code: 'CLIP_TAG_DUPLICATE' });

    const subjects = await tags.listLiveTagSubjects(ORG, 'vid-spar');
    expect(subjects.map((s) => s.athlete_id).sort()).toEqual([ATHLETE_A, ATHLETE_B]);

    const removed = await tags.removeClipTag({ organizationId: ORG, tagId: a.tag_id, removedByAccountId: COACH_A });
    expect(removed?.tag_id).toBe(a.tag_id);
    // Removing twice is a no-op, not a second removal.
    await expect(tags.removeClipTag({ organizationId: ORG, tagId: a.tag_id, removedByAccountId: COACH_A }))
      .resolves.toBeNull();
    // The removed row is kept as the record.
    const kept = await main.query(
      `select removed_by_account_id from pilot.video_clip_tags where tag_id = $1`, [a.tag_id],
    );
    expect(kept.rows[0].removed_by_account_id).toBe(COACH_A);

    await tags.addClipTag({ ...base, videoSessionId: 'vid-spar', athleteId: ATHLETE_A, eventKind: 'sparring' });
    expect(await tags.listLiveClipTagsForVideo(ORG, 'vid-spar')).toHaveLength(2);
  });

  test('teaching footage and archived footage cannot be tagged', async () => {
    await expect(tags.addClipTag({
      ...base, videoSessionId: 'vid-teach', athleteId: ATHLETE_A, eventKind: 'sparring',
    })).rejects.toMatchObject({ code: 'CLIP_TAG_VIDEO_NOT_TAGGABLE' });
    await expect(tags.addClipTag({
      ...base, videoSessionId: 'vid-archived', athleteId: ATHLETE_A, eventKind: 'sparring',
    })).rejects.toMatchObject({ code: 'CLIP_TAG_VIDEO_NOT_TAGGABLE' });
  });

  test('a video with a live publication cannot be tagged; once rejected it can', async () => {
    await expect(tags.addClipTag({
      ...base, videoSessionId: 'vid-published', athleteId: ATHLETE_A, eventKind: 'sparring',
    })).rejects.toMatchObject({ code: 'CLIP_TAG_VIDEO_PUBLISHED' });
    await main.query(`update pilot.video_publications set status = 'rejected' where publication_id = 'pub-1'`);
    await expect(tags.addClipTag({
      ...base, videoSessionId: 'vid-published', athleteId: ATHLETE_A, eventKind: 'sparring',
    })).resolves.toMatchObject({ video_session_id: 'vid-published' });
  });

  test('a tagged clip cannot be published, checked inside a transaction too', async () => {
    await expect(tags.assertVideoHasNoLiveClipTags(ORG, 'vid-spar'))
      .rejects.toMatchObject({ code: 'TAGGED_CLIP_NOT_PUBLISHABLE' });
    await main.query('begin');
    try {
      await expect(tags.assertVideoHasNoLiveClipTags(ORG, 'vid-spar', main))
        .rejects.toMatchObject({ code: 'TAGGED_CLIP_NOT_PUBLISHABLE' });
    } finally {
      await main.query('rollback');
    }
    await insertVideo(main, 'vid-plain');
    await expect(tags.assertVideoHasNoLiveClipTags(ORG, 'vid-plain')).resolves.toBeUndefined();
  });

  test('the athlete/parent list filter drops tagged videos and keeps untagged ones', async () => {
    const predicate = await tags.untaggedVideoSql('pilot.video_sessions');
    const rows = await main.query(
      `select video_session_id from pilot.video_sessions
        where organization_id = $1 and athlete_id = $2 and status = 'ready' ${predicate}
        order by video_session_id`,
      [ORG, ATHLETE_A],
    );
    const ids = rows.rows.map((r) => r.video_session_id);
    expect(ids).toContain('vid-plain');
    expect(ids).not.toContain('vid-bout');
    expect(ids).not.toContain('vid-published');
  });

  test('a video whose only tags were removed is back in the athlete list', async () => {
    await insertVideo(main, 'vid-untagged-later');
    const tag = await tags.addClipTag({
      ...base, videoSessionId: 'vid-untagged-later', athleteId: ATHLETE_A, eventKind: 'sparring',
    });
    const predicate = await tags.untaggedVideoSql('pilot.video_sessions');
    const listed = async () => (await main.query(
      `select video_session_id from pilot.video_sessions
        where organization_id = $1 and video_session_id = 'vid-untagged-later' ${predicate}`,
      [ORG],
    )).rows.length;
    expect(await listed()).toBe(0);
    await tags.removeClipTag({ organizationId: ORG, tagId: tag.tag_id, removedByAccountId: COACH_A });
    expect(await listed()).toBe(1);
  });

  test("a deleted athlete's own video cannot be tagged, and drops out of clip lists", async () => {
    await main.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag,
          coach_id, created_at, updated_at)
       values ($1, 'ath-gone', 'ath-gone', '2011-01-01', '120lb', 'active', 'Contact', true, $2, now(), now())`,
      [ORG, COACH_A],
    );
    await insertVideo(main, 'vid-of-gone', { athleteId: 'ath-gone' });
    await tags.addClipTag({ ...base, videoSessionId: 'vid-of-gone', athleteId: ATHLETE_A, eventKind: 'sparring' });
    await main.query(`update pilot.athletes set deleted_at = now() where athlete_id = 'ath-gone'`);

    const all = await tags.listTaggedClips({ organizationId: ORG, athleteIds: null, limit: 50 });
    expect(all.map((c) => c.video_session_id)).not.toContain('vid-of-gone');
    await expect(tags.addClipTag({
      ...base, videoSessionId: 'vid-of-gone', athleteId: ATHLETE_B, eventKind: 'sparring',
    })).rejects.toMatchObject({ code: 'CLIP_TAG_VIDEO_NOT_TAGGABLE' });
  });

  test('clip lists follow the caller\'s scope and the competition filter', async () => {
    const coachA = await tags.listTaggedClips({ organizationId: ORG, athleteIds: [ATHLETE_A], limit: 50 });
    expect(new Set(coachA.map((c) => c.athlete_id))).toEqual(new Set([ATHLETE_A]));
    expect(coachA.map((c) => c.video_session_id)).toEqual(expect.arrayContaining(['vid-bout', 'vid-spar']));

    const coachB = await tags.listTaggedClips({ organizationId: ORG, athleteIds: [ATHLETE_B], limit: 50 });
    expect(coachB.map((c) => c.video_session_id)).toEqual(['vid-spar']);

    const emptyScope = await tags.listTaggedClips({ organizationId: ORG, athleteIds: [], limit: 50 });
    expect(emptyScope).toEqual([]);

    const bout = await tags.listTaggedClips({ organizationId: ORG, athleteIds: null, competitionId: COMPETITION, limit: 50 });
    expect(bout.map((c) => c.video_session_id)).toEqual(['vid-bout']);

    expect(await tags.listTaggedClips({ organizationId: OTHER_ORG, athleteIds: null, limit: 50 })).toEqual([]);
  });

  test('a deleted athlete\'s tag is reported to the playback gate and left out of clip lists', async () => {
    await tags.addClipTag({ ...base, videoSessionId: 'vid-plain', athleteId: ATHLETE_DELETED, eventKind: 'sparring' });
    await main.query(`update pilot.athletes set deleted_at = now() where athlete_id = $1`, [ATHLETE_DELETED]);
    const subjects = await tags.listLiveTagSubjects(ORG, 'vid-plain');
    expect(subjects).toEqual([{ athlete_id: ATHLETE_DELETED, athlete_deleted: true }]);
    const all = await tags.listTaggedClips({ organizationId: ORG, athleteIds: null, limit: 50 });
    expect(all.map((c) => c.athlete_id)).not.toContain(ATHLETE_DELETED);
  });

  test("a clip whose partner was deleted is left out of the live athlete's list too", async () => {
    await main.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag,
          coach_id, created_at, updated_at)
       values ($1, 'ath-partner-gone', 'ath-partner-gone', '2011-01-01', '120lb', 'active', 'Contact', true, $2, now(), now())`,
      [ORG, COACH_B],
    );
    await insertVideo(main, 'vid-partner-gone', { athleteId: null });
    await tags.addClipTag({ ...base, videoSessionId: 'vid-partner-gone', athleteId: ATHLETE_A, eventKind: 'sparring' });
    await tags.addClipTag({ ...base, videoSessionId: 'vid-partner-gone', athleteId: 'ath-partner-gone', eventKind: 'sparring' });
    const before = await tags.listTaggedClips({ organizationId: ORG, athleteIds: [ATHLETE_A], limit: 50 });
    expect(before.map((c) => c.video_session_id)).toContain('vid-partner-gone');

    await main.query(`update pilot.athletes set deleted_at = now() where athlete_id = 'ath-partner-gone'`);
    const after = await tags.listTaggedClips({ organizationId: ORG, athleteIds: [ATHLETE_A], limit: 50 });
    expect(after.map((c) => c.video_session_id)).not.toContain('vid-partner-gone');
  });

  /*
   * Owner, Jason 2026-10-05: "A: Placeholder title". A tagged clip the scan
   * has not released stays listed with "Awaiting safety check" for a title;
   * the real title comes back once it is released.
   */
  // Infected and archived footage cannot be tagged, but a tagged clip can
  // become either afterwards, so each clip is tagged first, then moved.
  test.each(['quarantined', 'uploaded', 'processing', 'infected', 'error', 'archived'])(
    'a %s clip stays listed with the placeholder in place of its title',
    async (status) => {
      const videoId = `vid-unreleased-${status}`;
      await insertVideo(main, videoId, { athleteId: null, status: 'quarantined' });
      await tags.addClipTag({ ...base, videoSessionId: videoId, athleteId: ATHLETE_A, eventKind: 'sparring' });
      await main.query(`update pilot.video_sessions set status = $1 where video_session_id = $2`, [status, videoId]);
      const all = await tags.listTaggedClips({ organizationId: ORG, athleteIds: [ATHLETE_A], limit: 50 });
      const row = all.find((c) => c.video_session_id === videoId);
      expect(row).toBeDefined();
      expect(row!.title).toBe('Awaiting safety check');
      expect(row!.status).toBe(status);
    },
  );

  test('a released clip shows its own title again', async () => {
    await insertVideo(main, 'vid-released-later', { athleteId: null, status: 'quarantined' });
    await tags.addClipTag({ ...base, videoSessionId: 'vid-released-later', athleteId: ATHLETE_A, eventKind: 'sparring' });
    const before = await tags.listTaggedClips({ organizationId: ORG, athleteIds: null, limit: 50 });
    expect(before.find((c) => c.video_session_id === 'vid-released-later')!.title).toBe('Awaiting safety check');

    await main.query(`update pilot.video_sessions set status = 'ready' where video_session_id = 'vid-released-later'`);
    const after = await tags.listTaggedClips({ organizationId: ORG, athleteIds: null, limit: 50 });
    // insertVideo titles each video with its own id.
    expect(after.find((c) => c.video_session_id === 'vid-released-later')!.title).toBe('vid-released-later');
  });

  test('teaching footage never appears in a clip list, even if a raw row tags it', async () => {
    await main.query(
      `insert into pilot.video_clip_tags
         (organization_id, tag_id, video_session_id, athlete_id, event_kind, tagged_by_account_id)
       values ($1, 'raw-teach', 'vid-teach', $2, 'sparring', $3)`,
      [ORG, ATHLETE_A, COACH_A],
    );
    const all = await tags.listTaggedClips({ organizationId: ORG, athleteIds: null, limit: 50 });
    expect(all.map((c) => c.video_session_id)).not.toContain('vid-teach');
  });
});
