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
//   * a creator account that is in another organization, missing, inactive,
//     or soft-deleted is refused -- active_flag and deleted_at are columns,
//     so only a real database can say what the WHERE clause does with them
//   * the source video row is not touched by being annotated against
//   * the rows the bootstrap creates are the rows the existing read paths
//     behind /coach/calibration return
//   * each creation writes an audit row carrying the creator's REAL role, read
//     from their account row -- a mock would only prove the argument was passed
//   * a refused creation writes none, and a refused AUDIT write leaves the rows
//     it could not record behind and says so, because the two cannot share a
//     transaction
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
/** Live, in THIS organization, and NOT a coach -- so actor_role has something
 * to be wrong about. A hardcoded 'coach' passes every test that only ever
 * bootstraps as one. */
const ADMIN_ID = 'acct-boot-admin';
const OTHER_ORG_COACH_ID = 'acct-boot-other-coach';
/** In THIS organization, but switched off: active_flag = false. */
const INACTIVE_COACH_ID = 'acct-boot-inactive-coach';
/** In THIS organization, but soft-deleted: deleted_at set. */
const DELETED_COACH_ID = 'acct-boot-deleted-coach';
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
// pilot.accounts.active_flag ships in the base schema; deleted_at is added by
// the retention migration, so the soft-delete half of the creator check cannot
// be exercised without applying it. Same base-plus-retention pair
// sourceRetractionChecks.pg.test.ts uses.
const RETENTION_SQL = 'pilot_slice_postgres_data_retention_deletion_migration.sql';
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
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft') on conflict do nothing`,
    [ADMIN_ID, ORG_ID],
  );

  // Both of these are in ORG_ID, so organization membership alone accepts
  // them. Only liveness does not.
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag)
     values ($1, 'coach', $2, 'microsoft', false) on conflict do nothing`,
    [INACTIVE_COACH_ID, ORG_ID],
  );
  // active_flag is left TRUE here on purpose. A soft-deleted account whose
  // active_flag was also false would pass a check that read only one of the
  // two columns, and the test would not notice.
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag, deleted_at)
     values ($1, 'coach', $2, 'microsoft', true, now()) on conflict do nothing`,
    [DELETED_COACH_ID, ORG_ID],
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

interface AuditRow {
  event_type: string;
  actor_account_id: string | null;
  actor_role: string | null;
  organization_id: string | null;
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown>;
}

/** Every audit row naming one entity, read straight from the table.
 *
 * Not through a read model: the point of these cases is what was WRITTEN, and
 * a reader with its own allow-list (api/pilot/audit/get has one) would hide a
 * row that exists or invent scoping that is not the subject here.
 */
async function auditRowsFor(entityId: string): Promise<AuditRow[]> {
  const client = await freshClient();
  try {
    const result = await client.query<AuditRow>(
      `select event_type, actor_account_id, actor_role, organization_id,
              entity_type, entity_id, details
         from pilot.audit_events
        where entity_id = $1
        order by audit_id asc`,
      [entityId],
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

async function countOf(table: string): Promise<number> {
  const client = await freshClient();
  try {
    const result = await client.query<{ n: number }>(`select count(*)::int as n from ${table}`);
    return result.rows[0].n;
  } finally {
    await client.end();
  }
}

/** Makes the audit INSERT for one entity_type fail, for the duration of one fn.
 *
 * A REAL DATABASE REFUSAL, not a jest mock of the audit module. The behaviour
 * under test is what survives when the audit write fails AFTER the row it
 * describes has already committed on a different pooled connection -- which is
 * a fact about two connections and no transaction, and a mock cannot produce
 * it. The trigger is dropped in a finally so one failing case cannot leave
 * every later one refusing to audit.
 */
async function withAuditWritesRefusedFor<T>(
  entityType: string,
  run: () => Promise<T>,
): Promise<T> {
  const client = await freshClient();
  try {
    await client.query(
      `create or replace function pilot_test_refuse_audit() returns trigger
         language plpgsql as $$
         begin
           raise exception 'AUDIT_WRITE_REFUSED_BY_TEST';
         end $$`,
    );
    await client.query(
      `create trigger pilot_test_refuse_audit_trg
         before insert on pilot.audit_events
         for each row when (new.entity_type = '${entityType}')
         execute function pilot_test_refuse_audit()`,
    );
  } finally {
    await client.end();
  }

  try {
    return await run();
  } finally {
    const cleanup = await freshClient();
    try {
      await cleanup.query('drop trigger if exists pilot_test_refuse_audit_trg on pilot.audit_events');
      await cleanup.query('drop function if exists pilot_test_refuse_audit()');
    } finally {
      await cleanup.end();
    }
  }
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
  await migrateClient.query(await readMigration(RETENTION_SQL));
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

      // One clip, not one-or-more: the bootstrap cuts exactly what it was asked for.
      expect(await calibration.listCalibrationClips(ORG_ID, project.calibration_project_id))
        .toHaveLength(1);
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

  test('REFUSES a creator account from another organization', async () => {
    // created_by_account_id references pilot.accounts(account_id) alone, so
    // the database would accept a coach from another gym as the person who
    // chose these clips. The audit row this module now writes names the same
    // account, so a bad value is recorded twice rather than caught -- which is
    // why the gate, not the record, is what refuses it.
    const before = await projectCount();

    await expect(
      bootstrap.bootstrapCalibrationClip(request({ createdByAccountId: OTHER_ORG_COACH_ID })),
    ).rejects.toThrow(/Not found: no such account in this organization/);

    expect(await projectCount()).toBe(before);
  });

  test('REFUSES a creator account that does not exist, with the same answer', async () => {
    const before = await projectCount();

    await expect(
      bootstrap.bootstrapCalibrationClip(request({ createdByAccountId: 'acct-nobody' })),
    ).rejects.toThrow(/Not found: no such account in this organization/);

    expect(await projectCount()).toBe(before);
  });

  test('REFUSES an INACTIVE creator account in the correct organization', async () => {
    // Membership is satisfied: this account really is in ORG_ID, and the
    // organization_id predicate alone accepts it. What it cannot do is sign
    // in, and created_by_account_id is the only record calibration keeps of
    // who chose these clips -- attributing that to somebody switched off
    // attributes it to nobody. assertActor in import-shadow-research.mjs
    // refuses SEED_ACCOUNT_INACTIVE for the same reason.
    const before = await projectCount();

    await expect(
      bootstrap.bootstrapCalibrationClip(request({ createdByAccountId: INACTIVE_COACH_ID })),
    ).rejects.toThrow(/Not found: no such account in this organization/);

    expect(await projectCount()).toBe(before);
  });

  test('REFUSES a SOFT-DELETED creator account, with the same answer', async () => {
    // Separate from the case above rather than folded into it: this row has
    // active_flag TRUE and deleted_at set, so a check that read active_flag
    // alone would accept it. The single message is deliberate -- distinguishing
    // 'inactive' from 'no such account' would confirm to whoever typed the id
    // that the account exists in THIS organization.
    const before = await projectCount();

    await expect(
      bootstrap.bootstrapCalibrationClip(request({ createdByAccountId: DELETED_COACH_ID })),
    ).rejects.toThrow(/Not found: no such account in this organization/);

    expect(await projectCount()).toBe(before);
  });
});

describe('a clip refused on its own merits, after the study already exists', () => {
  test('leaves the study behind, and SAYS SO, naming it', async () => {
    // THE HONEST VERSION OF THE LIMITATION. The source gate runs before the
    // project is written, so a bad source costs nothing -- but a clip refused
    // for its own reasons is refused after the project INSERT has committed,
    // and the two writes cannot be one transaction from the caller's side.
    //
    // Study names are unique per organization, so a survivor nobody was told
    // about turns the obvious retry into a collision with a row the operator
    // does not know exists. The refusal names it instead.
    const before = await projectCount();
    const transposed = request({
      projectName: 'Round two, offsets transposed',
      startMs: 97_004,
      endMs: 91_337,
    });

    // One refusal carrying both halves: why the clip was refused, and what
    // was left behind.
    await expect(bootstrap.bootstrapCalibrationClip(transposed)).rejects.toThrow(
      /a clip must end after it starts[\s\S]*Round two, offsets transposed[\s\S]*still exists, with no clips/,
    );
    expect(await projectCount()).toBe(before + 1);

    // And THIS is why the survivor has to be named. The obvious next move --
    // fix the offsets, run it again -- now collides with a study the operator
    // would otherwise have no idea existed.
    await expect(bootstrap.bootstrapCalibrationClip({ ...transposed, endMs: 99_000 }))
      .rejects.toThrow(/pilot_calibration_projects_name_uq/);
    expect(await projectCount()).toBe(before + 1);

    const [survivor] = (await calibration.listCalibrationProjects(ORG_ID))
      .filter((row) => row.name === 'Round two, offsets transposed');
    expect(await calibration.listCalibrationClips(ORG_ID, survivor.calibration_project_id))
      .toEqual([]);
  });
});

describe('re-running the bootstrap', () => {
  test('REFUSES a study name this organization has already used', async () => {
    // pilot_calibration_projects_name_uq. Two studies with the same name would
    // be indistinguishable in the annotator's picker, which is the one place
    // the name is read.
    const fixed = request({ projectName: 'Round one, camera A', clipCode: 'C-07' });

    await bootstrap.bootstrapCalibrationClip(fixed);
    // Matched on the constraint by name: a bare toThrow() here would be
    // satisfied by a dropped connection or a typo in the fixture.
    await expect(bootstrap.bootstrapCalibrationClip(fixed))
      .rejects.toThrow(/pilot_calibration_projects_name_uq/);
  });
});

describe('the creation is recorded, not only stamped on the row', () => {
  test('writes one audit row for the study and one for the clip, naming the actor and the entities', async () => {
    const { project, clip } = await bootstrap.bootstrapCalibrationClip(request({ clipCode: 'C-08' }));

    const [projectRow, ...extraProjectRows] = await auditRowsFor(project.calibration_project_id);
    // Exactly one. A second row for the same creation would be a duplicate an
    // agreement count could later divide by.
    expect(extraProjectRows).toEqual([]);
    // 'create' is the closed vocabulary's own value and the entity_type is what
    // carries the meaning -- the convention annotatorGate.ts set for
    // calibration, and the reason this slice needs no migration.
    expect(projectRow.event_type).toBe('create');
    expect(projectRow.entity_type).toBe('calibration_project');
    expect(projectRow.entity_id).toBe(project.calibration_project_id);
    expect(projectRow.actor_account_id).toBe(COACH_ID);
    expect(projectRow.actor_role).toBe('coach');
    expect(projectRow.organization_id).toBe(ORG_ID);
    expect(projectRow.details).toEqual({
      name: project.name,
      ontology_version: ontology.BOXING_ONTOLOGY_VERSION,
      status: 'draft',
    });

    const [clipRow, ...extraClipRows] = await auditRowsFor(clip.calibration_clip_id);
    expect(extraClipRows).toEqual([]);
    expect(clipRow.event_type).toBe('create');
    expect(clipRow.entity_type).toBe('calibration_clip');
    expect(clipRow.entity_id).toBe(clip.calibration_clip_id);
    expect(clipRow.actor_account_id).toBe(COACH_ID);
    expect(clipRow.actor_role).toBe('coach');
    expect(clipRow.organization_id).toBe(ORG_ID);
    // toEqual, not toMatchObject: the absence of athlete_id is deliberate and
    // is the half a later reader would otherwise add back without noticing.
    // The clip row already records the attribution; copying a minor's
    // identifier into a second table buys nothing.
    expect(clipRow.details).toEqual({
      calibration_project_id: project.calibration_project_id,
      video_session_id: READY_VIDEO_ID,
      clip_code: 'C-08',
      start_ms: 91_337,
      end_ms: 97_004,
      primary_sampling_reason: 'simultaneous_exchange',
    });
  });

  test('records the creator’s REAL role, read from their account, not a constant', async () => {
    // The case a coach-only fixture cannot fail. actor_role is free text in the
    // schema, so 'coach' hardcoded at the call site is accepted by the database
    // and by every other test in this file.
    const { project, clip } = await bootstrap.bootstrapCalibrationClip(
      request({ createdByAccountId: ADMIN_ID, clipCode: 'C-09' }),
    );

    const [projectRow] = await auditRowsFor(project.calibration_project_id);
    const [clipRow] = await auditRowsFor(clip.calibration_clip_id);

    expect(projectRow.actor_account_id).toBe(ADMIN_ID);
    expect(projectRow.actor_role).toBe('organization_admin');
    expect(clipRow.actor_account_id).toBe(ADMIN_ID);
    expect(clipRow.actor_role).toBe('organization_admin');
  });

  test('does NOT mirror the creation into SHADOW', async () => {
    // writePilotAuditEvent fans out to pilot.shadow_events unless shadow_mirror
    // is exactly false, and pilot.shadow_events exists in this schema -- so a
    // missing flag writes a real row here rather than erroring. Calibration
    // measures where trained humans disagree; a disagreement corpus that
    // silently became model input would make the measurement unrepeatable.
    const before = await countOf('pilot.shadow_events');

    await bootstrap.bootstrapCalibrationClip(request({ clipCode: 'C-10' }));

    expect(await countOf('pilot.shadow_events')).toBe(before);
  });

  test('a REFUSED creation writes no audit row at all', async () => {
    // The audit stream must not claim a study was opened when none was. Both
    // refusals happen before any row exists: the source gate, and the creator
    // gate that #822 gave its liveness predicates.
    const before = await countOf('pilot.audit_events');

    await expect(
      bootstrap.bootstrapCalibrationClip(request({ videoSessionId: QUARANTINED_VIDEO_ID })),
    ).rejects.toThrow(/not available for calibration/);
    await expect(
      bootstrap.bootstrapCalibrationClip(request({ createdByAccountId: INACTIVE_COACH_ID })),
    ).rejects.toThrow(/Not found: no such account in this organization/);

    expect(await countOf('pilot.audit_events')).toBe(before);
  });
});

describe('when the audit write itself fails', () => {
  test('the study is NOT rolled back, the failure is NOT swallowed, and the refusal names the survivor', async () => {
    // THE DECISION THIS ASSERTS. The audit write cannot share a transaction
    // with the insert it describes -- writePilotAuditEvent, like both creators,
    // takes its own pooled connection, and giving them a client parameter is a
    // change to projects.ts and a different slice. So one of two things has to
    // happen when it fails, and swallowing it is the wrong one: the operator
    // would be told PASS and would then believe an audit trail existed. It
    // throws, and the message names what was left behind, exactly as the
    // stranded-study refusal does.
    const before = await projectCount();
    const name = 'Round three, audit refused';

    const error = await withAuditWritesRefusedFor('calibration_project', () =>
      bootstrap
        .bootstrapCalibrationClip(request({ projectName: name, clipCode: 'C-11' }))
        .then(() => null, (thrown: unknown) => thrown as Error));

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/AUDIT_WRITE_REFUSED_BY_TEST/);
    expect(error?.message).toMatch(/created before its audit record could be written/);
    expect(error?.message).toContain(name);

    // The study committed on its own connection and is still there. Nothing in
    // this module can undo that, so the refusal admits it.
    expect(await projectCount()).toBe(before + 1);
    const [survivor] = (await calibration.listCalibrationProjects(ORG_ID))
      .filter((row) => row.name === name);
    expect(survivor).toBeDefined();
    expect(await auditRowsFor(survivor.calibration_project_id)).toEqual([]);

    // AND THE CLIP WAS NEVER ATTEMPTED. This is what separates "throws" from
    // "logs and carries on": a swallowing implementation reaches the clip
    // insert and returns a result.
    expect(await calibration.listCalibrationClips(ORG_ID, survivor.calibration_project_id))
      .toEqual([]);
  });

  test('a failure on the CLIP audit row does not report itself as a refused clip', async () => {
    // The clip audit write sits OUTSIDE the stranded-study catch on purpose.
    // Folded inside it, this failure would be reported as "created before the
    // clip was refused" -- and the clip was created, not refused, so an
    // operator would go looking for a clip problem that does not exist.
    const before = await projectCount();
    const name = 'Round four, clip audit refused';

    const error = await withAuditWritesRefusedFor('calibration_clip', () =>
      bootstrap
        .bootstrapCalibrationClip(request({ projectName: name, clipCode: 'C-12' }))
        .then(() => null, (thrown: unknown) => thrown as Error));

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/AUDIT_WRITE_REFUSED_BY_TEST/);
    expect(error?.message).toMatch(/created before the audit record for the clip could be written/);
    expect(error?.message).not.toMatch(/the clip was refused/);

    // Both rows exist. The study's audit row was written before the clip's was
    // refused, so the record is partial rather than absent -- and the message
    // above is what tells the operator which half is missing.
    expect(await projectCount()).toBe(before + 1);
    const [survivor] = (await calibration.listCalibrationProjects(ORG_ID))
      .filter((row) => row.name === name);
    const clips = await calibration.listCalibrationClips(ORG_ID, survivor.calibration_project_id);
    expect(clips).toHaveLength(1);
    expect(await auditRowsFor(survivor.calibration_project_id)).toHaveLength(1);
    expect(await auditRowsFor(clips[0].calibration_clip_id)).toEqual([]);
  });
});
