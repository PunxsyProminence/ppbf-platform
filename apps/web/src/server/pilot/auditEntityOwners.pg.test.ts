// Real PostgreSQL-backed proof of auditEntityOwners.ts: for every athlete-owned
// audit entity type, the entity_id a writer records resolves -- through the
// entity's own table, in the caller's organization -- to the athlete that
// record is about, and nothing else resolves.
//
// What reading the SQL cannot prove: that each statement's id shape matches
// the table (uuid::text casts, the milestone's `athlete_id:milestone_key`
// composite), that the three joins carry both halves of the composite key,
// that another organization's id does not resolve, and that a null athlete
// (teaching footage) resolves to nothing.
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

import {
  AUDIT_ATHLETE_OWNED_ENTITY_TYPES,
  auditEntityOwnersOf,
  resolveAuditEntityOwners,
} from './auditEntityOwners';
import { query } from './db';

// The module under test reads through db.ts's pooled `query`; here that is
// pointed at the embedded server's test database for the suite's duration.
jest.mock('./db', () => ({
  query: jest.fn(),
}));
const mockQuery = query as jest.Mock;

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-audit-entity-owners-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

// Every table a resolver reads that the base schema does not create, with
// the migrations those tables' foreign keys need first. Same prerequisite
// chain interventionEvidence.pg.test.ts uses for the intervention tables.
const LAYERED_MIGRATIONS = [
  'pilot_slice_postgres_achievements_migration.sql',
  'pilot_slice_postgres_one_percent_club_migration.sql',
  'pilot_slice_postgres_video_sessions_migration.sql',
  'pilot_slice_postgres_external_competition_migration.sql',
  'pilot_slice_postgres_wrestling_league_migration.sql',
  'pilot_slice_postgres_shadow_decision_loop_migration.sql',
  'pilot_slice_postgres_drill_library_v3_migration.sql',
  'pilot_slice_postgres_session_scripts_migration.sql',
  'pilot_slice_postgres_intervention_protocols_migration.sql',
  'pilot_slice_postgres_intervention_executions_migration.sql',
  'pilot_slice_postgres_intervention_evidence_migration.sql',
];

const ORG = 'org-owners';
const OTHER_ORG = 'org-elsewhere';
const ADMIN = 'acct-owners-admin';
const COACH_A = 'acct-owners-coach-a';
const COACH_B = 'acct-owners-coach-b';
const ATH_A = 'ath-owners-a'; // coach A's athlete
const ATH_B = 'ath-owners-b'; // coach B's athlete
const ATH_X = 'ath-elsewhere-x'; // another gym's athlete
const ATH_Y = 'ath-elsewhere-y'; // another gym's second athlete (mentorship collision)

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string;
let layeredSql: string[];
let client: Client;

/** entity_type -> the entity_id written for ATH_A's record, filled by seed(). */
const ownedByA: Record<string, string> = {};
/** entity_type -> the entity_id written for ATH_B's record, filled by seed(). */
const ownedByB: Record<string, string> = {};

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

  const db = new Client({ connectionString: connectionStringFor(name) });
  await db.connect();
  await db.query(baseSchemaSql);
  for (const sql of layeredSql) {
    await db.query(sql);
  }
  return db;
}

async function seed(db: Client): Promise<void> {
  for (const org of [ORG, OTHER_ORG]) {
    await db.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  await db.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag)
     values ($1, 'organization_admin', $4, 'microsoft', true),
            ($2, 'coach', $4, 'microsoft', true),
            ($3, 'coach', $4, 'microsoft', true)
     on conflict do nothing`,
    [ADMIN, COACH_A, COACH_B, ORG],
  );
  const athlete = `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, $2, '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())`;
  await db.query(athlete, [ORG, ATH_A, COACH_A]);
  await db.query(athlete, [ORG, ATH_B, COACH_B]);
  await db.query(athlete, [OTHER_ORG, ATH_X, ADMIN]);
  await db.query(athlete, [OTHER_ORG, ATH_Y, ADMIN]);

  // One record per type for each of the two children, written the way the
  // routes write it, so the resolver is tested against real entity_id shapes.
  for (const [ath, into] of [[ATH_A, ownedByA], [ATH_B, ownedByB]] as const) {
    const suffix = ath === ATH_A ? 'a' : 'b';

    await db.query(
      `insert into pilot.athlete_milestones (organization_id, athlete_id, milestone_key, awarded_by_role, awarded_by_account_id)
       values ($1, $2, 'first_full_round', 'coach', $3)`,
      [ORG, ath, COACH_A],
    );
    into.athlete_milestone = `${ath}:first_full_round`;

    await db.query(
      `insert into pilot.athlete_programs (organization_id, athlete_id, program) values ($1, $2, 'competitive')`,
      [ORG, ath],
    );
    into.athlete_program = ath;

    const coverage = await db.query<{ coverage_id: string }>(
      `insert into pilot.coach_coverage (organization_id, athlete_id, covering_coach_id, granted_by_account_id, expires_at)
       values ($1, $2, $3, $4, now() + interval '1 day') returning coverage_id::text as coverage_id`,
      [ORG, ath, COACH_B, ADMIN],
    );
    into.coach_coverage = coverage.rows[0].coverage_id;

    const note = await db.query<{ note_id: string }>(
      `insert into pilot.coach_observations (organization_id, note_id, athlete_id, coach_account_id, note_type, note_text)
       values ($1, gen_random_uuid(), $2, $3, 'parent_message', 'hello') returning note_id::text as note_id`,
      [ORG, ath, COACH_A],
    );
    into.coach_note = note.rows[0].note_id;

    await db.query(
      `insert into pilot.sessions (organization_id, session_id, athlete_id, date, rpe, notes, completed_flag, created_at, updated_at)
       values ($1, $2, $3, current_date, 5, '', true, now(), now())`,
      [ORG, `sess-${suffix}`, ath],
    );
    into.session = `sess-${suffix}`;

    await db.query(
      `insert into pilot.coach_reviews (organization_id, review_id, session_id, coach_id, decision, notes, approved_flag, created_at, updated_at)
       values ($1, $2, $3, $4, 'approve', '', true, now(), now())`,
      [ORG, `rev-${suffix}`, `sess-${suffix}`, COACH_A],
    );
    into.coach_review = `rev-${suffix}`;

    await db.query(
      `insert into pilot.external_competitions (organization_id, competition_id, competition_name, competition_date, created_by_account_id)
       values ($1, $2, 'Open', current_date, $3) on conflict do nothing`,
      [ORG, 'comp-1', ADMIN],
    );
    await db.query(
      `insert into pilot.external_competition_entries (organization_id, entry_id, competition_id, athlete_id, created_by_account_id)
       values ($1, $2, 'comp-1', $3, $4)`,
      [ORG, `entry-${suffix}`, ath, ADMIN],
    );
    into.external_competition_entry = `entry-${suffix}`;

    await db.query(
      `insert into pilot.goals (organization_id, goal_id, athlete_id, title, target_date, metric, status, created_at, updated_at)
       values ($1, $2, $3, 'goal', current_date, 'm', 'open', now(), now())`,
      [ORG, `goal-${suffix}`, ath],
    );
    into.goal = `goal-${suffix}`;

    await db.query(
      `insert into pilot.intervention_protocols
         (organization_id, protocol_id, lineage_id, title, target_problem, hypothesis, intervention_description, expected_outcome, created_by_account_id)
       values ($1, $2, $2, 't', 'p', 'h', 'd', 'o', $3) on conflict do nothing`,
      [ORG, 'proto-1', ADMIN],
    );
    await db.query(
      `insert into pilot.intervention_executions
         (organization_id, execution_id, lineage_id, athlete_id, protocol_id, protocol_version, recorded_by_account_id)
       values ($1, $2, $2, $3, 'proto-1', 1, $4)`,
      [ORG, `exec-${suffix}`, ath, COACH_A],
    );
    into.intervention_execution = `exec-${suffix}`;

    await db.query(
      `insert into pilot.intervention_evidence_links
         (organization_id, link_id, execution_id, evidence_role, source_kind, source_id, linked_by_account_id)
       values ($1, $2, $3, 'baseline', 'readiness', 'r-1', $4)`,
      [ORG, `link-${suffix}`, `exec-${suffix}`, COACH_A],
    );
    into.intervention_evidence_link = `link-${suffix}`;

    await db.query(
      `insert into pilot.intervention_outcome_reviews
         (organization_id, review_id, execution_id, performance_result, performance_notes, hypothesis_result, learning_signal, reviewed_by_account_id)
       values ($1, $2, $3, 'improved', 'n', 'supported', 'prior_belief_strengthened', $4)`,
      [ORG, `orev-${suffix}`, `exec-${suffix}`, COACH_A],
    );
    into.intervention_outcome_review = `orev-${suffix}`;

    await db.query(
      `insert into pilot.one_percent_nominations
         (organization_id, nomination_id, athlete_id, source, nominated_by_account_id, nominated_by_role, expires_at)
       values ($1, $2, $3, 'coach_nomination', $4, 'coach', now() + interval '30 days')`,
      [ORG, `nom-${suffix}`, ath, COACH_A],
    );
    into.one_percent_nomination = `nom-${suffix}`;

    await db.query(
      `insert into pilot.recognitions (organization_id, recognition_id, athlete_id, coach_account_id, coach_display_name, kind)
       values ($1, $2, $3, $4, 'Coach', 'good_partner')`,
      [ORG, `rec-${suffix}`, ath, COACH_A],
    );
    into.recognition = `rec-${suffix}`;

    await db.query(
      `insert into pilot.scheduler_coaching_requests
         (organization_id, request_id, athlete_id, requested_by_role, requested_by_account_id, preferred_at, goals, status)
       values ($1, $2, $3, 'coach', $4, now(), 'g', 'pending')`,
      [ORG, `req-${suffix}`, ath, COACH_A],
    );
    into.scheduler_coaching_request = `req-${suffix}`;

    await db.query(
      `insert into pilot.video_sessions
         (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, blob_path, file_name, file_size_bytes, mime_type)
       values ($1, $2, $3, $4, 't', 'blob', 'f.mp4', 1, 'video/mp4')`,
      [`vid-${suffix}`, ORG, COACH_A, ath],
    );
    into.video_session = `vid-${suffix}`;

    await db.query(
      `insert into pilot.wrestling_league_seasons (organization_id, season_id, season_name, starts_on, created_by_account_id)
       values ($1, 'season-1', 'S1', current_date, $2) on conflict do nothing`,
      [ORG, ADMIN],
    );
    await db.query(
      `insert into pilot.wrestling_league_roster_entries (organization_id, entry_id, season_id, athlete_id, created_by_account_id)
       values ($1, $2, 'season-1', $3, $4)`,
      [ORG, `roster-${suffix}`, ath, ADMIN],
    );
    into.wrestling_league_roster_entry = `roster-${suffix}`;
  }

  // A mentorship names two children: A mentors B.
  await db.query(
    `insert into pilot.mentorships (organization_id, mentorship_id, mentor_athlete_id, mentee_athlete_id, created_by_account_id)
     values ($1, 'ment-ab', $2, $3, $4)`,
    [ORG, ATH_A, ATH_B, COACH_A],
  );

  // Teaching footage: a video about nobody.
  await db.query(
    `insert into pilot.video_sessions
       (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, blob_path, file_name, file_size_bytes, mime_type)
     values ('vid-teach', $1, $2, null, 't', 'blob', 'f.mp4', 1, 'video/mp4')`,
    [ORG, COACH_A],
  );

  // Another gym's goal, with an id that collides with nothing here.
  await db.query(
    `insert into pilot.goals (organization_id, goal_id, athlete_id, title, target_date, metric, status, created_at, updated_at)
     values ($1, 'goal-x', $2, 'goal', current_date, 'm', 'open', now(), now())`,
    [OTHER_ORG, ATH_X],
  );

  // COLLIDING ids in the other gym, for every type whose id the application
  // chooses (not the uuid-defaulted coverage and note ids, which cannot
  // collide): a record with the SAME id as child A's, owned by the other
  // gym's child. A lookup that dropped its organization bound, or a join that
  // carried only the id half of the composite key, would resolve child A's
  // record to ATH_X as well; the per-type assertions require exactly [ATH_A].
  await db.query(
    `insert into pilot.athlete_milestones (organization_id, athlete_id, milestone_key, awarded_by_role, awarded_by_account_id)
     values ($1, $2, 'first_full_round', 'coach', $3)`,
    [OTHER_ORG, ATH_X, ADMIN],
  );
  await db.query(
    `insert into pilot.athlete_programs (organization_id, athlete_id, program) values ($1, $2, 'competitive')`,
    [OTHER_ORG, ATH_X],
  );
  await db.query(
    `insert into pilot.sessions (organization_id, session_id, athlete_id, date, rpe, notes, completed_flag, created_at, updated_at)
     values ($1, 'sess-a', $2, current_date, 5, '', true, now(), now())`,
    [OTHER_ORG, ATH_X],
  );
  await db.query(
    `insert into pilot.coach_reviews (organization_id, review_id, session_id, coach_id, decision, notes, approved_flag, created_at, updated_at)
     values ($1, 'rev-a', 'sess-a', $2, 'approve', '', true, now(), now())`,
    [OTHER_ORG, ADMIN],
  );
  await db.query(
    `insert into pilot.external_competitions (organization_id, competition_id, competition_name, competition_date, created_by_account_id)
     values ($1, 'comp-1', 'Open', current_date, $2)`,
    [OTHER_ORG, ADMIN],
  );
  await db.query(
    `insert into pilot.external_competition_entries (organization_id, entry_id, competition_id, athlete_id, created_by_account_id)
     values ($1, 'entry-a', 'comp-1', $2, $3)`,
    [OTHER_ORG, ATH_X, ADMIN],
  );
  await db.query(
    `insert into pilot.goals (organization_id, goal_id, athlete_id, title, target_date, metric, status, created_at, updated_at)
     values ($1, 'goal-a', $2, 'goal', current_date, 'm', 'open', now(), now())`,
    [OTHER_ORG, ATH_X],
  );
  await db.query(
    `insert into pilot.intervention_protocols
       (organization_id, protocol_id, lineage_id, title, target_problem, hypothesis, intervention_description, expected_outcome, created_by_account_id)
     values ($1, 'proto-1', 'proto-1', 't', 'p', 'h', 'd', 'o', $2)`,
    [OTHER_ORG, ADMIN],
  );
  await db.query(
    `insert into pilot.intervention_executions
       (organization_id, execution_id, lineage_id, athlete_id, protocol_id, protocol_version, recorded_by_account_id)
     values ($1, 'exec-a', 'exec-a', $2, 'proto-1', 1, $3)`,
    [OTHER_ORG, ATH_X, ADMIN],
  );
  await db.query(
    `insert into pilot.intervention_evidence_links
       (organization_id, link_id, execution_id, evidence_role, source_kind, source_id, linked_by_account_id)
     values ($1, 'link-a', 'exec-a', 'baseline', 'readiness', 'r-1', $2)`,
    [OTHER_ORG, ADMIN],
  );
  await db.query(
    `insert into pilot.intervention_outcome_reviews
       (organization_id, review_id, execution_id, performance_result, performance_notes, hypothesis_result, learning_signal, reviewed_by_account_id)
     values ($1, 'orev-a', 'exec-a', 'improved', 'n', 'supported', 'prior_belief_strengthened', $2)`,
    [OTHER_ORG, ADMIN],
  );
  await db.query(
    `insert into pilot.mentorships (organization_id, mentorship_id, mentor_athlete_id, mentee_athlete_id, created_by_account_id)
     values ($1, 'ment-ab', $2, $3, $4)`,
    [OTHER_ORG, ATH_X, ATH_Y, ADMIN],
  );
  await db.query(
    `insert into pilot.one_percent_nominations
       (organization_id, nomination_id, athlete_id, source, nominated_by_account_id, nominated_by_role, expires_at)
     values ($1, 'nom-a', $2, 'coach_nomination', $3, 'coach', now() + interval '30 days')`,
    [OTHER_ORG, ATH_X, ADMIN],
  );
  await db.query(
    `insert into pilot.recognitions (organization_id, recognition_id, athlete_id, coach_account_id, coach_display_name, kind)
     values ($1, 'rec-a', $2, $3, 'Coach', 'good_partner')`,
    [OTHER_ORG, ATH_X, ADMIN],
  );
  await db.query(
    `insert into pilot.scheduler_coaching_requests
       (organization_id, request_id, athlete_id, requested_by_role, requested_by_account_id, preferred_at, goals, status)
     values ($1, 'req-a', $2, 'coach', $3, now(), 'g', 'pending')`,
    [OTHER_ORG, ATH_X, ADMIN],
  );
  // video_sessions' primary key is the bare id, so the same id cannot exist
  // in two gyms; the other gym's video gets its own id and the lookup from
  // this gym must not see it.
  await db.query(
    `insert into pilot.video_sessions
       (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, blob_path, file_name, file_size_bytes, mime_type)
     values ('vid-x', $1, $2, $3, 't', 'blob', 'f.mp4', 1, 'video/mp4')`,
    [OTHER_ORG, ADMIN, ATH_X],
  );
  await db.query(
    `insert into pilot.wrestling_league_seasons (organization_id, season_id, season_name, starts_on, created_by_account_id)
     values ($1, 'season-1', 'S1', current_date, $2)`,
    [OTHER_ORG, ADMIN],
  );
  await db.query(
    `insert into pilot.wrestling_league_roster_entries (organization_id, entry_id, season_id, athlete_id, created_by_account_id)
     values ($1, 'roster-a', 'season-1', $2, $3)`,
    [OTHER_ORG, ATH_X, ADMIN],
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
  layeredSql = await Promise.all(
    LAYERED_MIGRATIONS.map((file) => fs.readFile(path.join(INFRA_DIR, file), 'utf8')),
  );

  client = await freshDatabase('audit_entity_owners');
  await seed(client);

  mockQuery.mockImplementation(async (text: string, params?: unknown[]) => {
    const result = await client.query(text, params);
    return result.rows;
  });
});

afterAll(async () => {
  await client?.end().catch(() => {});
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

const SINGLE_OWNER_TYPES = [...AUDIT_ATHLETE_OWNED_ENTITY_TYPES].filter((t) => t !== 'mentorship').sort();

describe('resolveAuditEntityOwners against the real tables', () => {
  test('the seed wrote one record per athlete-owned type', () => {
    expect(Object.keys(ownedByA).sort()).toEqual(SINGLE_OWNER_TYPES);
    expect(Object.keys(ownedByB).sort()).toEqual(SINGLE_OWNER_TYPES);
  });

  // For every type, the other gym holds a record under child A's exact id
  // (except the uuid-keyed coverage and note, and video, whose key is global),
  // so "exactly [ATH_A]" also proves the organization bound and the composite
  // joins: a lookup missing either would return ATH_X here too.
  test.each(SINGLE_OWNER_TYPES)("%s: each child's record resolves to that child and no other, including across gyms", async (entityType) => {
    const result = await resolveAuditEntityOwners(ORG, [
      { entity_type: entityType, entity_id: ownedByA[entityType] },
      { entity_type: entityType, entity_id: ownedByB[entityType] },
      { entity_type: entityType, entity_id: 'no-such-record' },
    ]);

    expect(auditEntityOwnersOf(result, entityType, ownedByA[entityType])).toEqual([ATH_A]);
    expect(auditEntityOwnersOf(result, entityType, ownedByB[entityType])).toEqual([ATH_B]);
    expect(auditEntityOwnersOf(result, entityType, 'no-such-record')).toBeNull();
  });

  test("a mentorship resolves to both children, and not to the other gym's pairing under the same id", async () => {
    const result = await resolveAuditEntityOwners(ORG, [{ entity_type: 'mentorship', entity_id: 'ment-ab' }]);
    expect([...(auditEntityOwnersOf(result, 'mentorship', 'ment-ab') ?? [])].sort()).toEqual([ATH_A, ATH_B].sort());
  });

  test("another gym's video does not resolve from this gym", async () => {
    const result = await resolveAuditEntityOwners(ORG, [{ entity_type: 'video_session', entity_id: 'vid-x' }]);
    expect(auditEntityOwnersOf(result, 'video_session', 'vid-x')).toBeNull();
  });

  test('teaching footage (video with no athlete) resolves to nothing', async () => {
    const result = await resolveAuditEntityOwners(ORG, [{ entity_type: 'video_session', entity_id: 'vid-teach' }]);
    expect(auditEntityOwnersOf(result, 'video_session', 'vid-teach')).toBeNull();
  });

  test("another organization's record does not resolve from this one", async () => {
    const result = await resolveAuditEntityOwners(ORG, [{ entity_type: 'goal', entity_id: 'goal-x' }]);
    expect(auditEntityOwnersOf(result, 'goal', 'goal-x')).toBeNull();

    const theirs = await resolveAuditEntityOwners(OTHER_ORG, [{ entity_type: 'goal', entity_id: 'goal-x' }]);
    expect(auditEntityOwnersOf(theirs, 'goal', 'goal-x')).toEqual([ATH_X]);
  });

  test('one call resolves a mixed page of every type in one statement per type', async () => {
    mockQuery.mockClear();
    const refs = [
      ...SINGLE_OWNER_TYPES.map((t) => ({ entity_type: t, entity_id: ownedByA[t] })),
      { entity_type: 'mentorship', entity_id: 'ment-ab' },
      { entity_type: 'announcement', entity_id: 'ignored' },
    ];

    const result = await resolveAuditEntityOwners(ORG, refs);

    expect(mockQuery).toHaveBeenCalledTimes(AUDIT_ATHLETE_OWNED_ENTITY_TYPES.size);
    for (const t of SINGLE_OWNER_TYPES) {
      expect(auditEntityOwnersOf(result, t, ownedByA[t])).toEqual([ATH_A]);
    }
    expect(result.has('announcement')).toBe(false);
  });
});
