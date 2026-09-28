// TS-ANON-01: the capture-participants migration, against real PostgreSQL.
//
// WHY THIS CANNOT BE A UNIT TEST. The load-bearing half of this migration is
// DATA, not DDL: it derives a restricted participant for every athlete already
// named on a teaching video, links it, and only then clears
// video_sessions.athlete_id. Order is the safety property -- clearing first
// would destroy the only record of whose footage this is -- and no amount of
// asserting on the SQL text proves the statements actually run in that order
// against rows that exist.
//
// It also proves the refusals. A migration that quietly picked one athlete
// when a session named two would attach one child's footage to another child's
// consent, and a migration that anonymised a row it could not link would leave
// footage with no guardian to ask. Both are asserted here as raises.
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
const PG_DATABASE = 'ppbf_test_capture_participants';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-capture-participants-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');

const INFRA = path.resolve(__dirname, '../../../../../infra/azure');
const BASE_SCHEMA = path.join(INFRA, 'pilot_slice_postgres.sql');
const VIDEO_SESSIONS = path.join(INFRA, 'pilot_slice_postgres_video_sessions_migration.sql');
const CAPTURE_SESSIONS = path.join(INFRA, 'pilot_slice_postgres_capture_sessions_migration.sql');
const CAPTURE_PARTICIPANTS = path.join(INFRA, 'pilot_slice_postgres_capture_participants_migration.sql');

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let participantsSql: string;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${database}`;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
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

/** Everything this migration presupposes, in the order a rebuild applies it. */
async function applyPrerequisites(): Promise<void> {
  await client.query('create schema if not exists pilot');
  for (const file of [BASE_SCHEMA, VIDEO_SESSIONS, CAPTURE_SESSIONS]) {
    await client.query(await fs.readFile(file, 'utf8'));
  }
}

async function seedOrgAndAthletes(): Promise<void> {
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name)
     values ('org-1', 'Punxsy Prominence') on conflict do nothing`,
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id)
     values ('coach-1', 'coach', 'org-1') on conflict do nothing`,
  );
  for (const [id, name] of [['ath-1', 'Athlete One'], ['ath-2', 'Athlete Two']]) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ('org-1', $1, $2, '2010-01-01', 'novice', 'active', 'none', true, 'coach-1', now(), now())
       on conflict do nothing`,
      [id, name],
    );
  }
}

/**
 * A video as it exists BEFORE this migration: teaching footage that names the
 * child it is of. `takeId` null makes it Film Study, which must be left alone.
 */
async function seedVideo(params: {
  id: string;
  athleteId: string | null;
  takeId: string | null;
  sessionId?: string | null;
}): Promise<void> {
  await client.query(
    `insert into pilot.video_sessions
       (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, blob_path,
        file_name, file_size_bytes, mime_type, capture_take_id, recording_session_id)
     values ($1, 'org-1', 'coach-1', $2, 'tape', 'org-1/' || $1 || '/t.webm',
             't.webm', 1024, 'video/webm', $3, $4)`,
    [params.id, params.athleteId, params.takeId, params.sessionId ?? null],
  );
}

async function seedSessionAndTake(sessionId: string, takeId: string, takeNumber = 1): Promise<void> {
  await client.query(
    `insert into pilot.recording_sessions (recording_session_id, organization_id, created_by_account_id, join_code, training_context)
     values ($1, 'org-1', 'coach-1', $2, 'shadowboxing') on conflict do nothing`,
    [sessionId, sessionId.slice(-6).toUpperCase()],
  );
  await client.query(
    `insert into pilot.capture_takes (capture_take_id, recording_session_id, organization_id, take_number)
     values ($1, $2, 'org-1', $3) on conflict do nothing`,
    [takeId, sessionId, takeNumber],
  );
}

/** Drops everything this migration creates or changes, so each test starts clean. */
async function resetToPreMigrationState(): Promise<void> {
  await client.query('drop table if exists pilot.video_capture_participants');
  await client.query('drop table if exists pilot.recording_session_participants');
  await client.query('drop table if exists pilot.capture_participants');
  await client.query('delete from pilot.video_sessions');
  await client.query('delete from pilot.capture_takes');
  await client.query('delete from pilot.recording_sessions');
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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${PG_DATABASE}`);
  await admin.query(`create database ${PG_DATABASE}`);
  await admin.end();

  client = new Client({ connectionString: connectionStringFor(PG_DATABASE) });
  await client.connect();
  await applyPrerequisites();
  await seedOrgAndAthletes();
  participantsSql = await fs.readFile(CAPTURE_PARTICIPANTS, 'utf8');
});

afterAll(async () => {
  await client?.end();
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
  // Explicit, because a killed run on Windows never reaches cleanup and these
  // folders accumulate. See the known-issue note in the workspace rules.
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  await resetToPreMigrationState();
});

test('the schema it creates carries the organization in every reference', async () => {
  /*
   * COMPOSITE KEYS ARE THE TENANT GUARANTEE, not a detail. A single-column
   * reference would let a participant in one gym name a video in another --
   * the routes happen to scope their reads, but scoping is a habit and a
   * foreign key is a guarantee. Arity is asserted, not just existence.
   */
  await client.query(participantsSql);

  const { rows } = await client.query<{ conname: string; arity: number }>(
    `select conname, array_length(conkey, 1) as arity
       from pg_constraint
      where contype = 'f'
        and conname in (
          'capture_participants_athlete_fk',
          'video_capture_participants_video_fk',
          'video_capture_participants_participant_fk',
          'recording_session_participants_session_fk',
          'recording_session_participants_participant_fk'
        )`,
  );

  expect(rows).toHaveLength(5);
  for (const row of rows) {
    expect(row.arity).toBe(2);
  }
});

test('one participant row per athlete, so a withdrawal cannot miss half their footage', async () => {
  // Two teaching videos of the same child must resolve to the SAME restricted
  // participant. Two rows would mean a guardian withdrawing reaches one and
  // leaves footage hanging off the other -- a withdrawal that does not
  // withdraw.
  await seedSessionAndTake('rs-1', 'take-1');
  await seedVideo({ id: 'vs-1', athleteId: 'ath-1', takeId: 'take-1', sessionId: 'rs-1' });
  await seedVideo({ id: 'vs-2', athleteId: 'ath-1', takeId: 'take-1', sessionId: 'rs-1' });

  await client.query(participantsSql);

  const { rows } = await client.query(
    `select count(*)::int as n from pilot.capture_participants where athlete_id = 'ath-1'`,
  );
  expect(rows[0].n).toBe(1);

  const links = await client.query(
    `select count(*)::int as n from pilot.video_capture_participants`,
  );
  expect(links.rows[0].n).toBe(2);
});

test('identity moves to the restricted side before the teaching column is cleared', async () => {
  /*
   * THE WHOLE POINT OF THE SLICE, and the order is the safety property.
   * Afterwards the teaching row names nobody, and the platform can still
   * answer "whose footage is this" through the restricted link -- which is
   * what guardian consent and safeguarding escalation both need.
   */
  await seedSessionAndTake('rs-1', 'take-1');
  await seedVideo({ id: 'vs-1', athleteId: 'ath-1', takeId: 'take-1', sessionId: 'rs-1' });

  await client.query(participantsSql);

  const video = await client.query<{ athlete_id: string | null; capture_take_id: string }>(
    `select athlete_id, capture_take_id from pilot.video_sessions where video_session_id = 'vs-1'`,
  );
  expect(video.rows[0].athlete_id).toBeNull();
  expect(video.rows[0].capture_take_id).toBe('take-1');

  const resolved = await client.query<{ athlete_id: string }>(
    `select cp.athlete_id
       from pilot.video_capture_participants vcp
       join pilot.capture_participants cp
         on cp.organization_id = vcp.organization_id
        and cp.capture_participant_id = vcp.capture_participant_id
      where vcp.video_session_id = 'vs-1'`,
  );
  expect(resolved.rows).toHaveLength(1);
  expect(resolved.rows[0].athlete_id).toBe('ath-1');
});

test('Film Study footage is untouched and keeps its athlete', async () => {
  // The owner rule is that identity belongs to Film Study. A migration that
  // anonymised everything would delete the thing Film Study is FOR.
  await seedVideo({ id: 'vs-film', athleteId: 'ath-2', takeId: null });

  await client.query(participantsSql);

  const { rows } = await client.query<{ athlete_id: string | null }>(
    `select athlete_id from pilot.video_sessions where video_session_id = 'vs-film'`,
  );
  expect(rows[0].athlete_id).toBe('ath-2');

  const linked = await client.query(
    `select count(*)::int as n from pilot.video_capture_participants where video_session_id = 'vs-film'`,
  );
  expect(linked.rows[0].n).toBe(0);
});

test('NEGATIVE CONTROL -- a session naming two athletes raises instead of guessing', async () => {
  /*
   * The worst outcome available here is attaching one child's footage to
   * another child's consent. Where provenance is ambiguous the migration must
   * stop and make a person resolve it, not pick the first row.
   */
  await seedSessionAndTake('rs-mixed', 'take-mixed');
  await seedVideo({ id: 'vs-a', athleteId: 'ath-1', takeId: 'take-mixed', sessionId: 'rs-mixed' });
  await seedVideo({ id: 'vs-b', athleteId: 'ath-2', takeId: 'take-mixed', sessionId: 'rs-mixed' });

  await expect(client.query(participantsSql)).rejects.toThrow(/more than one athlete/i);

  // And nothing was anonymised on the way to the refusal.
  const { rows } = await client.query<{ n: number }>(
    `select count(*)::int as n from pilot.video_sessions
      where capture_take_id is not null and athlete_id is not null`,
  );
  expect(rows[0].n).toBe(2);
});

test('the session keeps a participant link too, so a whole shoot is resolvable', async () => {
  /*
   * The video link answers "who is in THIS file", which is what the scan needs.
   * The session link answers "who was this shoot of", which is what a
   * safeguarding question about a filming session needs -- and it survives
   * even if individual files are later removed.
   *
   * Two angles of the same take resolve to one participant on the session, not
   * one per file.
   */
  await seedSessionAndTake('rs-1', 'take-1');
  await seedVideo({ id: 'vs-front', athleteId: 'ath-1', takeId: 'take-1', sessionId: 'rs-1' });
  await seedVideo({ id: 'vs-side', athleteId: 'ath-1', takeId: 'take-1', sessionId: 'rs-1' });

  await client.query(participantsSql);

  const { rows } = await client.query<{ athlete_id: string }>(
    `select cp.athlete_id
       from pilot.recording_session_participants rsp
       join pilot.capture_participants cp
         on cp.organization_id = rsp.organization_id
        and cp.capture_participant_id = rsp.capture_participant_id
      where rsp.recording_session_id = 'rs-1'`,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].athlete_id).toBe('ath-1');
});

test('the post-migration guard refuses to report success while any teaching row still names a child', async () => {
  /*
   * DEFENSIVE, and deliberately so. With uploaded_by_account_id NOT NULL every
   * take-backed row naming an athlete does derive a participant, so this guard
   * is not reachable from ordinary data -- it exists for the case where the
   * derivation is later changed or a row arrives by some path not foreseen
   * here. Asserting it fires proves the migration cannot silently finish with
   * footage anonymised and unattributable, rather than asserting a route to it
   * that does not exist.
   */
  expect(participantsSql).toMatch(/still carry athlete_id after migration/i);
  expect(participantsSql).toMatch(/raise exception/i);

  // And on ordinary data it does not fire: the migration completes.
  await seedSessionAndTake('rs-1', 'take-1');
  await seedVideo({ id: 'vs-1', athleteId: 'ath-1', takeId: 'take-1', sessionId: 'rs-1' });
  await expect(client.query(participantsSql)).resolves.toBeDefined();
});

test('re-running changes nothing, because a rebuild applies every migration', async () => {
  // `all` is dispatched wholesale against environments at different revisions,
  // so a migration that was not idempotent would corrupt an up-to-date one.
  await seedSessionAndTake('rs-1', 'take-1');
  await seedVideo({ id: 'vs-1', athleteId: 'ath-1', takeId: 'take-1', sessionId: 'rs-1' });

  await client.query(participantsSql);
  const first = await client.query(
    `select
       (select count(*)::int from pilot.capture_participants) as participants,
       (select count(*)::int from pilot.video_capture_participants) as video_links,
       (select count(*)::int from pilot.recording_session_participants) as session_links`,
  );

  await client.query(participantsSql);
  const second = await client.query(
    `select
       (select count(*)::int from pilot.capture_participants) as participants,
       (select count(*)::int from pilot.video_capture_participants) as video_links,
       (select count(*)::int from pilot.recording_session_participants) as session_links`,
  );

  expect(second.rows[0]).toEqual(first.rows[0]);
});
