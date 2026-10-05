// Real PostgreSQL-backed test for the video-clip-tags-sparring-link migration:
// a sparring clip tag may name the one sparring_exposure entry it shows.
//
// What needs a real database to prove:
//   * the migration adds the link from nothing, leaves existing tags "not
//     linked", re-applies as a no-op, and the runner refuses a database it
//     never reached -- or one whose foreign key nulls the whole key;
//   * the entry must be the same athlete's, in the same organization, so a
//     partner's tag can only point at the partner's own segment;
//   * only a sparring tag may carry a link;
//   * deleting the entry clears the link and keeps the tag (the column-list
//     SET NULL; a whole-key SET NULL fails on NOT NULL organization_id);
//   * videoClipTags.ts, against those keys: addClipTag and setClipTagExposure
//     link, clear and refuse with named errors, and listLinkedClipsForExposures
//     returns only this athlete's live, visible clips -- a clip with a
//     consent-blocked or deleted athlete on it stays hidden (OD-2026-10-04-009).
//
// Built on the full production schema (scripts/lib/full-schema.mjs).
// Disposable, local-only embedded Postgres. It NEVER connects to production
// or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-cliplink-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_video_clip_tags_sparring_link_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-video-clip-tags-sparring-link-migration.mjs',
);
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-cliplink-a';
const OTHER_ORG = 'org-cliplink-b';
const COACH = 'coach-cliplink';
const OTHER_COACH = 'coach-cliplink-other';
const ATHLETE_A = 'ath-cliplink-a';
const PARTNER = 'ath-cliplink-partner';
const GONE = 'ath-cliplink-gone';
const COMPETITION = 'comp-cliplink';
const DAY = '2026-10-03';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;

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

/** Removes everything this migration adds, so a test can start before it. */
async function unapply(client: Client): Promise<void> {
  await client.query('alter table pilot.video_clip_tags drop constraint if exists pilot_video_clip_tags_exposure_fk');
  await client.query(
    'alter table pilot.video_clip_tags drop constraint if exists pilot_video_clip_tags_exposure_sparring_check',
  );
  await client.query('drop index if exists pilot.idx_video_clip_tags_exposure');
  await client.query('alter table pilot.video_clip_tags drop column if exists exposure_id');
  await client.query('drop index if exists pilot.idx_sparring_exposure_org_exposure_athlete');
}

/**
 * Full production schema; two gyms. ATHLETE_A and PARTNER train in ORG;
 * ATHLETE_A's id also exists in OTHER_ORG as a different child, so only
 * organization scoping keeps their entries apart.
 */
async function freshDatabase(name: string, { preMigration = false } = {}): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active'), ($2, $2, 'active')`,
    [ORG, OTHER_ORG],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft'), ($3, 'coach', $4, 'microsoft')`,
    [COACH, ORG, OTHER_COACH, OTHER_ORG],
  );
  for (const [org, athleteId, coach] of [
    [ORG, ATHLETE_A, COACH], [ORG, PARTNER, COACH], [ORG, GONE, COACH], [OTHER_ORG, ATHLETE_A, OTHER_COACH],
  ]) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, $2, '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())`,
      [org, athleteId, coach],
    );
  }
  await client.query(
    `insert into pilot.external_competitions
       (organization_id, competition_id, competition_name, competition_date, created_by_account_id)
     values ($1, $2, 'Silver Gloves', '2026-11-01', $3)`,
    [ORG, COMPETITION, COACH],
  );
  await client.query(
    `insert into pilot.external_competition_entries
       (organization_id, entry_id, competition_id, athlete_id, created_by_account_id)
     values ($1, 'entry-a', $2, $3, $4)`,
    [ORG, COMPETITION, ATHLETE_A, COACH],
  );
  for (const [org, videoId, coach] of [
    ...['vid-1', 'vid-2', 'vid-3', 'vid-4', 'vid-5', 'vid-6'].map((id) => [ORG, id, COACH]),
    [OTHER_ORG, 'vid-other', OTHER_COACH],
  ]) {
    await client.query(
      `insert into pilot.video_sessions
         (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title,
          blob_path, file_name, file_size_bytes, mime_type, status)
       values ($1, $2, $3, null, $1, 'p/v.mp4', 'v.mp4', 10, 'video/mp4', 'ready')`,
      [videoId, org, coach],
    );
  }

  if (preMigration) await unapply(client);
  return client;
}

async function insertExposure(client: Client, exposureId: string, athleteId: string, org = ORG): Promise<void> {
  await client.query(
    `insert into pilot.sparring_exposure
       (organization_id, exposure_id, athlete_id, segment_number, sparring_type, time_under_impact_sec,
        coach_observed_intensity, coach_observed_head_contact, supervising_coach_account_id, session_date)
     values ($1, $2, $3,
             (select coalesce(max(segment_number), 0) + 1 from pilot.sparring_exposure
               where organization_id = $1 and athlete_id = $3),
             'technical', 60, 'light', 'none', $4, $5::date)`,
    [org, exposureId, athleteId, org === ORG ? COACH : OTHER_COACH, DAY],
  );
}

async function insertTag(
  client: Client,
  tagId: string,
  options: { videoId?: string; athleteId?: string; eventKind?: 'sparring' | 'competition'; exposureId?: string | null; org?: string } = {},
): Promise<void> {
  const org = options.org ?? ORG;
  const eventKind = options.eventKind ?? 'sparring';
  await client.query(
    `insert into pilot.video_clip_tags
       (organization_id, tag_id, video_session_id, athlete_id, event_kind, competition_id,
        tagged_by_account_id, exposure_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      org,
      tagId,
      options.videoId ?? (org === ORG ? 'vid-1' : 'vid-other'),
      options.athleteId ?? ATHLETE_A,
      eventKind,
      eventKind === 'competition' ? COMPETITION : null,
      org === ORG ? COACH : OTHER_COACH,
      options.exposureId ?? null,
    ],
  );
}

async function errorOf(promise: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; constraint?: string };
  }
  throw new Error('expected the statement to be refused');
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
  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
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

describe('video clip tags sparring link migration', () => {
  test('adds the link from nothing; existing tags read "not linked"; a re-apply changes nothing', async () => {
    const client = await freshDatabase('cliplink_fresh', { preMigration: true });
    try {
      const before = await client.query(
        `select 1 from information_schema.columns
          where table_schema = 'pilot' and table_name = 'video_clip_tags' and column_name = 'exposure_id'`,
      );
      expect(before.rows).toHaveLength(0);
      await client.query(
        `insert into pilot.video_clip_tags
           (organization_id, tag_id, video_session_id, athlete_id, event_kind, tagged_by_account_id)
         values ($1, 'old-tag', 'vid-1', $2, 'sparring', $3)`,
        [ORG, ATHLETE_A, COACH],
      );

      await applyMigrationTransaction(client, migrationSql);
      const once = await client.query(`select tag_id, exposure_id, created_at from pilot.video_clip_tags`);
      await applyMigrationTransaction(client, migrationSql);
      const twice = await client.query(`select tag_id, exposure_id, created_at from pilot.video_clip_tags`);

      expect(once.rows).toEqual([expect.objectContaining({ tag_id: 'old-tag', exposure_id: null })]);
      expect(twice.rows).toEqual(once.rows);
      const constraints = await client.query(
        `select count(*)::int as n from pg_constraint
          where conrelid = to_regclass('pilot.video_clip_tags') and conname like 'pilot_video_clip_tags_exposure%'`,
      );
      expect(constraints.rows[0].n).toBe(2);
    } finally {
      await client.end();
    }
  });

  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('cliplink_not_ready', { preMigration: true });
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /VIDEO_CLIP_TAGS_SPARRING_LINK_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner REFUSES a link whose delete action nulls the whole key, or whose check admits bouts', async () => {
    const client = await freshDatabase('cliplink_half', { preMigration: true });
    try {
      await client.query('create unique index idx_sparring_exposure_org_exposure_athlete on pilot.sparring_exposure(organization_id, exposure_id, athlete_id)');
      await client.query('alter table pilot.video_clip_tags add column exposure_id text null');
      await client.query(
        `create index idx_video_clip_tags_exposure on pilot.video_clip_tags(organization_id, exposure_id)
          where exposure_id is not null`,
      );
      await client.query(
        `alter table pilot.video_clip_tags add constraint pilot_video_clip_tags_exposure_sparring_check
           check (exposure_id is null or event_kind = 'sparring')`,
      );
      // The tempting wrong shape: a whole-key SET NULL.
      await client.query(
        `alter table pilot.video_clip_tags add constraint pilot_video_clip_tags_exposure_fk
           foreign key (organization_id, exposure_id, athlete_id)
           references pilot.sparring_exposure(organization_id, exposure_id, athlete_id) on delete set null`,
      );
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /VIDEO_CLIP_TAGS_SPARRING_LINK_NOT_READY/,
      );

      // Right foreign key, but a check that does not name sparring.
      await client.query('alter table pilot.video_clip_tags drop constraint pilot_video_clip_tags_exposure_fk');
      await client.query(
        `alter table pilot.video_clip_tags add constraint pilot_video_clip_tags_exposure_fk
           foreign key (organization_id, exposure_id, athlete_id)
           references pilot.sparring_exposure(organization_id, exposure_id, athlete_id) on delete set null (exposure_id)`,
      );
      // The right shape passes, which shows the refusals below are about the check.
      await applyMigrationTransaction(client, 'select 1');
      for (const wrongCheck of [
        "exposure_id is null or event_kind in ('sparring', 'competition')",
        "exposure_id is null or event_kind <> 'competition'",
      ]) {
        await client.query('alter table pilot.video_clip_tags drop constraint pilot_video_clip_tags_exposure_sparring_check');
        await client.query(
          `alter table pilot.video_clip_tags add constraint pilot_video_clip_tags_exposure_sparring_check check (${wrongCheck})`,
        );
        await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
          /VIDEO_CLIP_TAGS_SPARRING_LINK_NOT_READY/,
        );
      }
    } finally {
      await client.end();
    }
  });

  test('the real runner refuses each wrong piece on its own, with everything else right', async () => {
    const client = await freshDatabase('cliplink_pieces');
    const refuses = async () => expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
      /VIDEO_CLIP_TAGS_SPARRING_LINK_NOT_READY/,
    );
    const fk = (local: string, target: string, onDelete: string) => `
      alter table pilot.video_clip_tags drop constraint pilot_video_clip_tags_exposure_fk;
      alter table pilot.video_clip_tags add constraint pilot_video_clip_tags_exposure_fk
        foreign key (${local}) references pilot.sparring_exposure(${target}) ${onDelete}`;
    const RIGHT = 'organization_id, exposure_id, athlete_id';
    try {
      await applyMigrationTransaction(client, 'select 1');

      // The link column made NOT NULL.
      await client.query('alter table pilot.video_clip_tags alter column exposure_id set not null');
      await refuses();
      await client.query('alter table pilot.video_clip_tags alter column exposure_id drop not null');

      // The link index not partial.
      await client.query('drop index pilot.idx_video_clip_tags_exposure');
      await client.query('create index idx_video_clip_tags_exposure on pilot.video_clip_tags(organization_id, exposure_id)');
      await refuses();
      await client.query('drop index pilot.idx_video_clip_tags_exposure');
      await client.query(
        'create index idx_video_clip_tags_exposure on pilot.video_clip_tags(organization_id, exposure_id) where exposure_id is not null',
      );
      await applyMigrationTransaction(client, 'select 1');

      // A predicate with the right words that admits everything.
      await client.query('alter table pilot.video_clip_tags drop constraint pilot_video_clip_tags_exposure_sparring_check');
      await client.query(
        `alter table pilot.video_clip_tags add constraint pilot_video_clip_tags_exposure_sparring_check
           check (exposure_id is null or event_kind = 'sparring' or exposure_id is not null)`,
      );
      await refuses();
      await client.query('alter table pilot.video_clip_tags drop constraint pilot_video_clip_tags_exposure_sparring_check');
      await client.query(
        `alter table pilot.video_clip_tags add constraint pilot_video_clip_tags_exposure_sparring_check
           check (exposure_id is null or event_kind = 'sparring')`,
      );
      await applyMigrationTransaction(client, 'select 1');

      // SET DEFAULT of the right column; then the target columns in another order.
      await client.query(fk(RIGHT, RIGHT, 'on delete set default (exposure_id)'));
      await refuses();
      await client.query(
        'create unique index idx_cliplink_probe on pilot.sparring_exposure(organization_id, athlete_id, exposure_id)',
      );
      await client.query(fk(RIGHT, 'organization_id, athlete_id, exposure_id', 'on delete set null (exposure_id)'));
      await refuses();
      await client.query(fk(RIGHT, RIGHT, 'on delete set null (exposure_id)'));
      await applyMigrationTransaction(client, 'select 1');

      // The target index, renamed away: the key still builds on another index, readiness refuses.
      await client.query('alter index pilot.idx_sparring_exposure_org_exposure_athlete rename to idx_cliplink_moved');
      await refuses();
    } finally {
      await client.end();
    }
  });

  describe('on the migrated schema', () => {
    let client: Client;
    beforeAll(async () => {
      client = await freshDatabase('cliplink_live');
      await insertExposure(client, 'exp-a-1', ATHLETE_A);
      await insertExposure(client, 'exp-a-2', ATHLETE_A);
      await insertExposure(client, 'exp-partner-1', PARTNER);
      await insertExposure(client, 'exp-other-org', ATHLETE_A, OTHER_ORG);
    });
    afterAll(async () => {
      await client.end();
    });

    test('a sparring tag links to its own athlete\'s entry, or to none', async () => {
      await insertTag(client, 'tag-linked', { exposureId: 'exp-a-1' });
      await insertTag(client, 'tag-unlinked', { videoId: 'vid-2' });
      const { rows } = await client.query(
        `select tag_id, exposure_id from pilot.video_clip_tags where tag_id in ('tag-linked', 'tag-unlinked') order by tag_id`,
      );
      expect(rows).toEqual([
        { tag_id: 'tag-linked', exposure_id: 'exp-a-1' },
        { tag_id: 'tag-unlinked', exposure_id: null },
      ]);
    });

    test('a partner\'s tag cannot point at the other athlete\'s segment, nor the other way round', async () => {
      const intoPartners = await errorOf(insertTag(client, 'tag-x1', { videoId: 'vid-3', athleteId: ATHLETE_A, exposureId: 'exp-partner-1' }));
      expect(intoPartners).toMatchObject({ code: '23503', constraint: 'pilot_video_clip_tags_exposure_fk' });
      const intoOwn = await errorOf(insertTag(client, 'tag-x2', { videoId: 'vid-3', athleteId: PARTNER, exposureId: 'exp-a-2' }));
      expect(intoOwn).toMatchObject({ code: '23503', constraint: 'pilot_video_clip_tags_exposure_fk' });
      // Each athlete on one clip links to their own segment.
      await insertTag(client, 'tag-partner', { videoId: 'vid-1', athleteId: PARTNER, exposureId: 'exp-partner-1' });
    });

    test('a later update cannot move a link to someone else\'s entry', async () => {
      const moved = await errorOf(client.query(
        `update pilot.video_clip_tags set exposure_id = 'exp-partner-1' where organization_id = $1 and tag_id = 'tag-linked'`,
        [ORG],
      ));
      expect(moved).toMatchObject({ code: '23503', constraint: 'pilot_video_clip_tags_exposure_fk' });
    });

    test('another organization\'s entry, under the same athlete id, cannot be linked; nor can an invented one', async () => {
      // exp-other-org belongs to OTHER_ORG's ATHLETE_A, a different child.
      const crossOrg = await errorOf(insertTag(client, 'tag-x3', { videoId: 'vid-3', exposureId: 'exp-other-org' }));
      expect(crossOrg).toMatchObject({ code: '23503', constraint: 'pilot_video_clip_tags_exposure_fk' });
      const invented = await errorOf(insertTag(client, 'tag-x4', { videoId: 'vid-3', exposureId: 'exp-none' }));
      expect(invented).toMatchObject({ code: '23503', constraint: 'pilot_video_clip_tags_exposure_fk' });
    });

    test('a competition tag cannot carry a sparring link', async () => {
      const bout = await errorOf(insertTag(client, 'tag-bout', {
        videoId: 'vid-3', eventKind: 'competition', exposureId: 'exp-a-2',
      }));
      expect(bout).toMatchObject({ code: '23514', constraint: 'pilot_video_clip_tags_exposure_sparring_check' });
    });

    test('two clips may show the same segment', async () => {
      await client.query(
        `update pilot.video_clip_tags set exposure_id = 'exp-a-1' where organization_id = $1 and tag_id = 'tag-unlinked'`,
        [ORG],
      );
      const { rows } = await client.query(
        `select count(*)::int as n from pilot.video_clip_tags where organization_id = $1 and exposure_id = 'exp-a-1'`,
        [ORG],
      );
      expect(rows[0].n).toBe(2);
    });

    test('deleting the entry clears the link and keeps every tag, its organization and its athlete', async () => {
      await client.query(`delete from pilot.sparring_exposure where organization_id = $1 and exposure_id = 'exp-a-1'`, [ORG]);
      const { rows } = await client.query(
        `select tag_id, organization_id, athlete_id, exposure_id from pilot.video_clip_tags
          where tag_id in ('tag-linked', 'tag-unlinked', 'tag-partner') order by tag_id`,
      );
      expect(rows).toEqual([
        { tag_id: 'tag-linked', organization_id: ORG, athlete_id: ATHLETE_A, exposure_id: null },
        { tag_id: 'tag-partner', organization_id: ORG, athlete_id: PARTNER, exposure_id: 'exp-partner-1' },
        { tag_id: 'tag-unlinked', organization_id: ORG, athlete_id: ATHLETE_A, exposure_id: null },
      ]);
    });
  });

  describe('videoClipTags.ts on the migrated schema', () => {
    let client: Client;
    let tags: typeof import('./videoClipTags');
    const base = {
      organizationId: ORG,
      athleteId: ATHLETE_A,
      eventKind: 'sparring' as const,
      competitionId: null as string | null,
      note: '',
      taggedByAccountId: COACH,
    };

    beforeAll(async () => {
      client = await freshDatabase('cliplink_module');
      await insertExposure(client, 'exp-a-1', ATHLETE_A);
      await insertExposure(client, 'exp-a-2', ATHLETE_A);
      await insertExposure(client, 'exp-partner-1', PARTNER);
      process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor('cliplink_module');
      process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
      jest.resetModules();
      tags = await import('./videoClipTags');
    });
    afterAll(async () => {
      await client.end();
      const { closePool } = await import('./db');
      await closePool();
    });

    test('addClipTag stores the link; a partner\'s entry and a bout link are refused by name', async () => {
      const linked = await tags.addClipTag({ ...base, videoSessionId: 'vid-1', exposureId: 'exp-a-1' });
      expect(linked.exposure_id).toBe('exp-a-1');
      const plain = await tags.addClipTag({ ...base, videoSessionId: 'vid-2' });
      expect(plain.exposure_id).toBeNull();

      await expect(tags.addClipTag({ ...base, videoSessionId: 'vid-3', exposureId: 'exp-partner-1' }))
        .rejects.toMatchObject({ code: 'CLIP_TAG_EXPOSURE_NOT_FOUND' });
      await expect(tags.addClipTag({
        ...base, videoSessionId: 'vid-3', eventKind: 'competition', competitionId: COMPETITION, exposureId: 'exp-a-1',
      })).rejects.toMatchObject({ code: 'CLIP_TAG_EXPOSURE_SPARRING_ONLY' });
      // Neither refusal left a tag behind.
      const { rows } = await client.query(`select count(*)::int as n from pilot.video_clip_tags where video_session_id = 'vid-3'`);
      expect(rows[0].n).toBe(0);
    });

    test('setClipTagExposure links, moves and clears; refuses another athlete\'s entry; ignores bout and removed tags', async () => {
      const tag = await tags.addClipTag({ ...base, videoSessionId: 'vid-4' });
      expect((await tags.setClipTagExposure({ organizationId: ORG, tagId: tag.tag_id, exposureId: 'exp-a-1' }))?.exposure_id).toBe('exp-a-1');
      expect((await tags.setClipTagExposure({ organizationId: ORG, tagId: tag.tag_id, exposureId: 'exp-a-2' }))?.exposure_id).toBe('exp-a-2');
      await expect(tags.setClipTagExposure({ organizationId: ORG, tagId: tag.tag_id, exposureId: 'exp-partner-1' }))
        .rejects.toMatchObject({ code: 'CLIP_TAG_EXPOSURE_NOT_FOUND' });
      // Another gym cannot reach this tag at all.
      expect(await tags.setClipTagExposure({ organizationId: OTHER_ORG, tagId: tag.tag_id, exposureId: null })).toBeNull();
      expect((await tags.setClipTagExposure({ organizationId: ORG, tagId: tag.tag_id, exposureId: null }))?.exposure_id).toBeNull();

      const bout = await tags.addClipTag({ ...base, videoSessionId: 'vid-5', eventKind: 'competition', competitionId: COMPETITION });
      expect(await tags.setClipTagExposure({ organizationId: ORG, tagId: bout.tag_id, exposureId: 'exp-a-1' })).toBeNull();

      await tags.removeClipTag({ organizationId: ORG, tagId: tag.tag_id, removedByAccountId: COACH });
      expect(await tags.setClipTagExposure({ organizationId: ORG, tagId: tag.tag_id, exposureId: 'exp-a-1' })).toBeNull();
    });

    test('listLinkedClipsForExposures returns this athlete\'s live, visible clips and hides blocked ones', async () => {
      // vid-1: A linked to exp-a-1 (from the first test) -- visible.
      // vid-2: A linked to exp-a-1, PARTNER tagged too; PARTNER's guardian withdraws -- hidden.
      await tags.setClipTagExposure({
        organizationId: ORG,
        tagId: (await tags.listLiveClipTagsForVideo(ORG, 'vid-2'))[0].tag_id,
        exposureId: 'exp-a-1',
      });
      await insertTag(client, 'tag-partner-vid2', { videoId: 'vid-2', athleteId: PARTNER, exposureId: 'exp-partner-1' });
      // vid-6: A linked to exp-a-1, GONE tagged too, then GONE is deleted -- hidden.
      await insertTag(client, 'tag-a-vid6', { videoId: 'vid-6', exposureId: 'exp-a-1' });
      await insertTag(client, 'tag-gone-vid6', { videoId: 'vid-6', athleteId: GONE });
      // vid-4's tag (linked, then removed) and vid-5's bout tag must not appear either.

      const before = await tags.listLinkedClipsForExposures(ORG, ATHLETE_A, ['exp-a-1', 'exp-a-2', 'exp-partner-1']);
      expect(Object.fromEntries(before)).toEqual({
        'exp-a-1': expect.arrayContaining([
          expect.objectContaining({ video_session_id: 'vid-1' }),
          expect.objectContaining({ video_session_id: 'vid-2' }),
          expect.objectContaining({ video_session_id: 'vid-6' }),
        ]),
      });

      await client.query(`update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`, [ORG, GONE]);
      await client.query(
        `insert into pilot.parents (organization_id, parent_id, full_name) values ($1, 'par-partner', 'Partner Guardian')`,
        [ORG],
      );
      await client.query(
        `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
         values ($1, 'par-partner', $2, 'mother')`,
        [ORG, PARTNER],
      );
      await client.query(
        `insert into pilot.waivers
           (organization_id, waiver_id, athlete_id, parent_id, waiver_type, signed_by_name,
            signed_by_role, signed_at, consent_version, status, covers_video)
         values ($1, gen_random_uuid(), $2, 'par-partner', 'photo_media', 'Partner Guardian',
                 'parent', now(), 'v1', 'withdrawn', false)`,
        [ORG, PARTNER],
      );

      const after = await tags.listLinkedClipsForExposures(ORG, ATHLETE_A, ['exp-a-1', 'exp-a-2', 'exp-partner-1']);
      expect(Object.fromEntries(after)).toEqual({
        'exp-a-1': [{ tag_id: expect.any(String), video_session_id: 'vid-1' }],
      });
      // The partner's own link is the partner's, never A's.
      const partners = await tags.listLinkedClipsForExposures(ORG, PARTNER, ['exp-partner-1']);
      expect(partners.size).toBe(0); // vid-2 is consent-blocked for everyone
      expect((await tags.listLinkedClipsForExposures(ORG, ATHLETE_A, [])).size).toBe(0);
    });

    test('the staff clip list carries the link', async () => {
      const items = await tags.listTaggedClips({ organizationId: ORG, athleteIds: null, athleteId: ATHLETE_A, limit: 50 });
      expect(items.find((item) => item.video_session_id === 'vid-1')?.exposure_id).toBe('exp-a-1');
    });
  });
});
