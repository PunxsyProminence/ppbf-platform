// Real PostgreSQL-backed proof of deletion scope B (Jason, 2026-09-29, "10 C"):
// "everything tied to the athlete is marked deleted at the same moment".
//
// WHAT IS UNDER TEST. The mark is the athlete row's own deleted_at, written in
// the deletion transaction; every reader of a row tied to an athlete checks it
// (deletedAthletes.ts). So the claim has two halves, and this suite proves
// both against real rows:
//
//   1. the deletion transaction writes what it says -- the athlete's mark, the
//      stamp on the one tied table with a deletion column of its own
//      (shadow_chat_sessions), and the counts it reports;
//   2. every reader this change touched shows a deleted athlete's rows BEFORE
//      the deletion and does not show them AFTER it, while a live athlete's
//      rows -- and a second gym's athlete who shares the deleted athlete's id
//      -- stay visible throughout.
//
// EVERY READER IS RUN BOTH WAYS. The "before" database is the positive
// control: a reader that returned nothing at all would pass every "after"
// assertion, so each one must first be seen returning the deleted athlete's
// row. The live athlete is the second control, in both databases: a filter
// that hid everyone would fail on it.
//
// WHY REAL POSTGRES. Every change here is a SQL predicate, and the failure
// mode is "the predicate is on the wrong alias, the wrong half of the key, or
// not in the query that feeds the screen". A mocked db can only be asked
// whether a string contains 'deleted_at', which stays green for all three.
//
// Spins up the same disposable, local-only embedded Postgres the other suites
// use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { NextRequest } from 'next/server';
import { Client } from 'pg';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

// Routes every module's queries into whichever embedded database the current
// block opened. withTransaction runs on the SAME client, so the deletion and
// everything it marks are one unit of work here exactly as in production.
let activeClient: Client | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows[0] ?? null;
  }),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    await activeClient.query('BEGIN');
    try {
      const result = await fn(activeClient);
      await activeClient.query('COMMIT');
      return result;
    } catch (error) {
      await activeClient.query('ROLLBACK');
      throw error;
    }
  }),
}));

// The route-level readers take their principal from here; the rest of the
// module stays real.
jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return {
    ...actual,
    requirePrincipal: jest.fn(),
    requireMicrosoftAuthenticatedPrincipal: jest.fn(),
    requireMicrosoftOrAttestedLocalPinPrincipal: jest.fn(),
  };
});

// Checks env configuration, not the database; this suite has no SHADOW env.
jest.mock('./shadowReadiness', () => ({ assertShadowRuntimeReadiness: jest.fn() }));

import { GET as exportRosterGET } from '@/app/api/pilot/admin/export/roster/route';
import { GET as pinDirectoryGET } from '@/app/api/pilot/admin/athlete-pin-directory/route';
import { GET as floorPlansGET } from '@/app/api/pilot/floor-plans/route';
import { GET as researchRequirementsGET } from '@/app/api/pilot/shadow/research-requirements/route';
import { GET as videoListGET } from '@/app/api/pilot/video/list/route';

import { athleteIdsForCoach, listActiveCoachCoverage } from './access';
import { listMentorshipsForAthlete } from './achievements';
import { listActivityLog } from './activityLog';
import { getClassAttendanceRoster, getWeeklyAttendanceTrend } from './attendanceReporting';
import { getBoardSummary } from './boardSummary';
import { getCalibrationClip, listCalibrationClips } from './calibration/projects';
import { organizationActionableRoster } from './coachAthleteRoster';
import { getOrganizationViolations } from './compliance';
import type { PilotPrincipal } from './auth';
import { deleteAthleteRecord, deleteGuardianAccount, type ActorIdentity } from './dataDeletion';
import { deletedAthleteIdsAmong } from './deletedAthletes';
import { findDuplicateGuardianGroups } from './duplicateGuardians';
import { listCompetitionEntries } from './externalCompetition';
import { getFloorHoursAdmin, listPersonActivities } from './floorHours';
import { requireMicrosoftAuthenticatedPrincipal, requireMicrosoftOrAttestedLocalPinPrincipal, requirePrincipal } from './http';
import { getNomination, listMembers, listNominations } from './onePercentClub';
import { getAthletePassbook, getCoachPassbookGapQueue, getGuardianPassbook } from './passbook';
import { getSubjectIdentity, listPendingReviewPortraits, resolveRelationship } from './profileDb';
import { listProgramsWithCounts } from './programs';
import { getOrganizationPublications, getPublicationForPublish, getResearchLibrary } from './publication';
import { listRegisteredAthleteIdsForClass, listSchedulerStore, registerForClassTransactionally } from './schedulerDb';
import { listFilmStudyProposals } from './shadowFilmStudyProposals';
import { claimNextVideoSessionForScan, getVideoSessionById } from './videoSessions';
import { loadPublicWallBoard, loadWallBoard } from './wallDisplayDb';
import { loadWallOfNames } from './wallOfNamesDb';
import { listLeagueRoster } from './wrestlingLeague';

jest.setTimeout(600_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-deletion-scope-b-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEMPLATE_DB = 'scope_b_template';

const ORG = 'org-scope-b';
/** A second gym. Its athlete carries the SAME id as the deleted one and is never deleted. */
const OTHER_ORG = 'org-scope-b-other';

const ADMIN = 'acct-sb-admin';
const COACH = 'acct-sb-coach';
const COVERING_COACH = 'acct-sb-covering';
const OTHER_COACH = 'acct-sb-other-coach';
/** Guardian of GONE only -- the portrait relationship test. */
const GUARDIAN_GONE = 'acct-sb-guardian-gone';
/** Guardian of LIVE only -- that test's control. */
const GUARDIAN_LIVE = 'acct-sb-guardian-live';
/** The claimed half of a duplicate-guardian pair. */
const GUARDIAN_DUP = 'acct-sb-guardian-dup';

/** Deleted in the "after" database. */
const GONE = 'ATH-SB-GONE';
const GONE_ACCOUNT = 'acct-sb-athlete-gone';
/** Never deleted: the control in every database. */
const LIVE = 'ATH-SB-LIVE';
const LIVE_ACCOUNT = 'acct-sb-athlete-live';
/** Never deleted, owns nothing but a seat request and a mentorship. */
const THIRD = 'ATH-SB-THIRD';

const CLASS_TODAY = 'class-sb-today';
const CLASS_LAST_WEEK = 'class-sb-last-week';
/** Capacity 1, held by GONE. */
const CLASS_SEAT = 'class-sb-seat';
/** Capacity 1, held by LIVE -- the seat control. */
const CLASS_FULL = 'class-sb-full';

const PROJECT = 'cal-sb-project';
const PROGRAM_NAME = 'Scope B Youth';
const COMPETITION = 'comp-sb';
const SEASON = 'season-sb';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;

const adminActor: ActorIdentity = { accountId: ADMIN, role: 'organization_admin', organizationId: ORG };

function principal(accountId: string, role: PilotPrincipal['role']): PilotPrincipal {
  return {
    accountId,
    role,
    organizationId: ORG,
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

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

async function adminQuery(sql: string): Promise<void> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

/** A copy of the seeded template: every block starts from the same rows. */
async function cloneTemplate(name: string): Promise<Client> {
  await adminQuery(`drop database if exists ${name}`);
  await adminQuery(`create database ${name} template ${TEMPLATE_DB}`);
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

async function seed(client: Client): Promise<void> {
  const q = (sql: string, params: unknown[] = []) => client.query(sql, params);

  for (const org of [ORG, OTHER_ORG]) {
    await q(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [org]);
  }
  for (const [account, role, org, athlete] of [
    [ADMIN, 'organization_admin', ORG, null],
    [COACH, 'coach', ORG, null],
    [COVERING_COACH, 'coach', ORG, null],
    [GUARDIAN_GONE, 'parent', ORG, null],
    [GUARDIAN_LIVE, 'parent', ORG, null],
    [GUARDIAN_DUP, 'parent', ORG, null],
    [OTHER_COACH, 'coach', OTHER_ORG, null],
  ] as const) {
    await q(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, auth_provider, active_flag, login_email)
       values ($1, $2, $3, $4, 'microsoft', true, $1 || '@gym.test')`,
      [account, role, org, athlete],
    );
  }

  for (const [org, athlete, name, coach] of [
    [ORG, GONE, 'Gone Boxer', COACH],
    [ORG, LIVE, 'Live Boxer', COACH],
    [ORG, THIRD, 'Third Boxer', COACH],
    [OTHER_ORG, GONE, 'Other Gym Same Id', OTHER_COACH],
  ] as const) {
    await q(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, $3, '2011-05-06', 'fly', 'active', 'contact', true, $4, now() - interval '1 year', now())`,
      [org, athlete, name, coach],
    );
  }
  for (const [account, org, athlete] of [
    [GONE_ACCOUNT, ORG, GONE],
    [LIVE_ACCOUNT, ORG, LIVE],
    ['acct-sb-other-athlete', OTHER_ORG, GONE],
  ] as const) {
    await q(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, auth_provider, active_flag)
       values ($1, 'athlete', $2, $3, 'ppbf_local', true)`,
      [account, org, athlete],
    );
  }

  // Guardians: one per athlete for the portrait relationship, plus a split
  // duplicate pair whose unclaimed half holds both athletes.
  for (const [parent, account, email] of [
    ['parent-sb-gone', GUARDIAN_GONE, 'gone-guardian@gym.test'],
    ['parent-sb-live', GUARDIAN_LIVE, 'live-guardian@gym.test'],
    ['parent-sb-dup-claimed', GUARDIAN_DUP, 'dup@gym.test'],
    ['parent-sb-dup-unclaimed', null, 'DUP@gym.test'],
  ] as const) {
    await q(
      `insert into pilot.parents (organization_id, parent_id, full_name, account_id, email) values ($1, $2, $2, $3, $4)`,
      [ORG, parent, account, email],
    );
  }
  for (const [parent, athlete] of [
    ['parent-sb-gone', GONE],
    ['parent-sb-live', LIVE],
    ['parent-sb-dup-unclaimed', GONE],
    ['parent-sb-dup-unclaimed', LIVE],
  ] as const) {
    await q(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, $2, $3, 'parent')`,
      [ORG, parent, athlete],
    );
  }

  await q(
    `insert into pilot.calibration_projects (organization_id, calibration_project_id, name, ontology_version, created_by_account_id)
     values ($1, $2, 'Scope B project', 'v1', $3)`,
    [ORG, PROJECT, ADMIN],
  );
  await q(
    `insert into pilot.programs (organization_id, program_id, program_name, created_by_account_id) values ($1, 'prog-sb', $2, $3)`,
    [ORG, PROGRAM_NAME, ADMIN],
  );
  await q(
    `insert into pilot.external_competitions (organization_id, competition_id, competition_name, competition_date, created_by_account_id)
     values ($1, $2, 'Scope B Open', current_date + 30, $3)`,
    [ORG, COMPETITION, ADMIN],
  );
  await q(
    `insert into pilot.wrestling_league_seasons (organization_id, season_id, season_name, starts_on, created_by_account_id)
     values ($1, $2, 'Scope B Season', current_date, $3)`,
    [ORG, SEASON, ADMIN],
  );
  await q(
    `insert into pilot.compliance_rules (rule_id, organization_id, rule_name, rule_category, description, detection_logic, severity, escalation_level, active_flag)
     values ('rule-sb', $1, 'Scope B rule', 'safety', 'd', 'l', 'high', 'coach', true)`,
    [ORG],
  );
  for (const [classId, start, capacity] of [
    [CLASS_TODAY, `now() - interval '1 minute'`, 20],
    [CLASS_LAST_WEEK, `date_trunc('week', now()) - interval '2 days'`, 20],
    [CLASS_SEAT, `now() + interval '2 days'`, 1],
    [CLASS_FULL, `now() + interval '2 days'`, 1],
  ] as const) {
    await q(
      `insert into pilot.scheduler_classes (organization_id, class_id, title, start_at, end_at, location, capacity,
         scheduled_by_account_id, coach_account_id, status)
       values ($1, $2, $2, ${start}, ${start} + interval '1 hour', 'Main floor', $3, $4, $4, 'open')`,
      [ORG, classId, capacity, COACH],
    );
  }

  // Every tied row, once for GONE and once for LIVE.
  for (const [athlete, account] of [
    [GONE, GONE_ACCOUNT],
    [LIVE, LIVE_ACCOUNT],
  ] as const) {
    const k = athlete.toLowerCase();
    await q(
      `insert into pilot.video_sessions (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title,
         blob_path, file_name, file_size_bytes, mime_type, status, scan_state, created_at)
       values ($1, $2, $3, $4, 'clip', $1 || '.mp4', $1 || '.mp4', 10, 'video/mp4', 'ready', 'passed', now() - interval '1 day')`,
      [`vs-${k}`, ORG, COACH, athlete],
    );
    // Quarantined and due for a scan.
    await q(
      `insert into pilot.video_sessions (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title,
         blob_path, file_name, file_size_bytes, mime_type, status, scan_state, scan_next_attempt_at, created_at)
       values ($1, $2, $3, $4, 'held', $1 || '.mp4', $1 || '.mp4', 10, 'video/mp4', 'quarantined', 'pending',
               now() - interval '1 minute', now() - interval '${athlete === GONE ? 3 : 2} hours')`,
      [`vs-${k}-held`, ORG, COACH, athlete],
    );
    await q(
      `insert into pilot.video_publications (publication_id, organization_id, video_session_id, athlete_id,
         submitted_by_account_id, publication_type, title, description, status)
       values ($1, $2, $3, $4, $5, 'research_library', 'pub', 'd', 'pending_review')`,
      [`pub-${k}`, ORG, `vs-${k}`, athlete, COACH],
    );
    await q(
      `insert into pilot.research_library (library_id, organization_id, publication_id, video_session_id, title, description)
       values ($1, $2, $3, $4, 'shelf', 'd')`,
      [`lib-${k}`, ORG, `pub-${k}`, `vs-${k}`],
    );
    await q(
      `insert into pilot.shadow_film_study_proposals (proposal_id, organization_id, athlete_id, video_session_id,
         observation_text, evidence_id, origin, model_deployment, frames_analyzed)
       values (gen_random_uuid(), $1, $2, $3, 'observed', 'ev-1', 'model_proposed', 'vision', 3)`,
      [ORG, athlete, `vs-${k}`],
    );
    await q(
      `insert into pilot.calibration_clips (organization_id, calibration_clip_id, calibration_project_id, video_session_id,
         athlete_id, clip_code, start_ms, end_ms, primary_sampling_reason, created_by_account_id)
       values ($1, $2, $3, $4, $5, $2, 0, 1000, 'isolated_punch', $6)`,
      [ORG, `clip-${k}`, PROJECT, `vs-${k}`, athlete, ADMIN],
    );
    await q(
      `insert into pilot.account_profiles (organization_id, account_id, photo_blob_path, photo_content_type, photo_bytes,
         photo_uploaded_at, photo_review_state)
       values ($1, $2, 'portrait/' || $2 || '.jpg', 'image/jpeg', 100, now(), 'pending_review')`,
      [ORG, account],
    );
    for (let n = 1; n <= 5; n += 1) {
      await q(
        `insert into pilot.sessions (organization_id, session_id, athlete_id, date, notes, completed_flag, created_at, updated_at, rpe_method)
         values ($1, $2, $3, current_date - $4::int, 'session note', true, now(), now(), 'UNKNOWN')`,
        [ORG, `sess-${k}-${n}`, athlete, 6 - n],
      );
    }
    await q(
      `insert into pilot.coach_observations (organization_id, note_id, athlete_id, note_type, note_text, coach_account_id)
       values ($1, gen_random_uuid(), $2, 'general', 'coach note', $3)`,
      [ORG, athlete, COACH],
    );
    for (const classId of [CLASS_TODAY, CLASS_LAST_WEEK]) {
      await q(
        `insert into pilot.scheduler_registrations (organization_id, registration_id, class_id, athlete_id,
           requested_by_role, requested_by_account_id, status)
         values ($1, $2, $3, $4, 'coach', $5, 'registered')`,
        [ORG, `reg-${k}-${classId}`, classId, athlete, COACH],
      );
      await q(
        `insert into pilot.scheduler_attendance (organization_id, attendance_id, class_id, athlete_id, status, method,
           checked_in_by_role, checked_in_by_account_id, checked_in_at)
         values ($1, $2, $3, $4, 'present', 'coach_override', 'coach', $5,
                 ${classId === CLASS_TODAY ? `now() - interval '1 minute'` : `date_trunc('week', now()) - interval '2 days'`})`,
        [ORG, `att-${k}-${classId}`, classId, athlete, COACH],
      );
    }
    await q(
      `insert into pilot.scheduler_registrations (organization_id, registration_id, class_id, athlete_id,
         requested_by_role, requested_by_account_id, status)
       values ($1, $2, $3, $4, 'coach', $5, 'registered')`,
      [ORG, `reg-${k}-seat`, athlete === GONE ? CLASS_SEAT : CLASS_FULL, athlete, COACH],
    );
    await q(
      `insert into pilot.scheduler_coaching_requests (organization_id, request_id, athlete_id, requested_by_role,
         requested_by_account_id, preferred_at, goals, status)
       values ($1, $2, $3, 'coach', $4, now() + interval '1 day', 'goals', 'pending')`,
      [ORG, `req-${k}`, athlete, COACH],
    );
    await q(
      `insert into pilot.activity_log (organization_id, activity_id, person_account_id, athlete_id, activity_domain,
         activity_type, occurred_on, duration_minutes, capture_method, recorded_by_role, recorded_by_account_id, attendance_status)
       values ($1, $2, $3, $4, 'boxing_training', 'technical_session', current_date, 60, 'coach_override', 'coach', $5, 'present')`,
      [ORG, `act-${k}`, account, athlete, COACH],
    );
    await q(
      `insert into pilot.athlete_floor_plans (organization_id, plan_id, athlete_id, generated_at, readiness, athlete_name,
         payload, created_by_account_id, created_by_role)
       values ($1, $2, $3, now(), 'ready', $3, jsonb_build_object('athlete_id', $3::text), $4, 'coach')`,
      [ORG, `plan-${k}`, athlete, COACH],
    );
    await q(
      `insert into pilot.progression_gaps (gap_id, organization_id, athlete_id, coach_account_id, gap_type, gap_description,
         detected_from, status, severity)
       values ($1, $2, $3, $4, 'technique', 'gap', 'coach', 'identified', 'medium')`,
      [`gap-${k}`, ORG, athlete, COACH],
    );
    await q(
      `insert into pilot.program_memberships (organization_id, membership_id, athlete_id, program_name, started_on,
         created_by_account_id, status)
       values ($1, $2, $3, $4, current_date - 30, $5, 'active')`,
      [ORG, `mem-${k}`, athlete, PROGRAM_NAME, ADMIN],
    );
    await q(
      `insert into pilot.external_competition_entries (organization_id, entry_id, competition_id, athlete_id, created_by_account_id)
       values ($1, $2, $3, $4, $5)`,
      [ORG, `entry-${k}`, COMPETITION, athlete, ADMIN],
    );
    await q(
      `insert into pilot.wrestling_league_roster_entries (organization_id, entry_id, season_id, athlete_id, created_by_account_id)
       values ($1, $2, $3, $4, $5)`,
      [ORG, `roster-${k}`, SEASON, athlete, ADMIN],
    );
    await q(
      `insert into pilot.one_percent_nominations (organization_id, nomination_id, athlete_id, source, nominated_by_account_id,
         nominated_by_role, expires_at, status, decided_at)
       values ($1, $2, $3, 'coach_nomination', $4, 'coach', now() + interval '30 days', 'confirmed', now())`,
      [ORG, `nom-${k}`, athlete, COACH],
    );
    await q(
      `insert into pilot.coach_coverage (organization_id, athlete_id, covering_coach_id, granted_by_account_id, starts_at, expires_at)
       values ($1, $2, $3, $4, now() - interval '1 hour', now() + interval '1 hour')`,
      [ORG, athlete, COVERING_COACH, ADMIN],
    );
    await q(
      `insert into pilot.shadow_research_requirements (organization_id, source_event_name, source_entity_type, source_entity_id,
         research_requirement, knowledge_gap, source_status, source_confidence_tier, source_verification_state,
         created_by_account_id, created_by_role, subject_id)
       values ($1, 'manual_review', 'manual', $2, 'requirement', 'gap', 'open', 'low', 'unverified', $3, 'coach', $4)`,
      [ORG, `req-src-${k}`, COACH, athlete],
    );
    await q(
      `insert into pilot.compliance_violations (violation_id, organization_id, rule_id, athlete_id, detected_by_account_id,
         violation_timestamp, severity)
       values ($1, $2, 'rule-sb', $3, $4, now(), 'high')`,
      [`viol-${k}`, ORG, athlete, COACH],
    );
    // The athlete's own SHADOW conversation, and a coach's about them.
    await q(
      `insert into pilot.shadow_chat_sessions (conversation_id, organization_id, account_id, athlete_id, title)
       values (gen_random_uuid(), $1, $2, $3, 'own'), (gen_random_uuid(), $1, $4, $3, 'about')`,
      [ORG, account, athlete, COACH],
    );
  }

  // Controls that belong to nobody being deleted.
  await q(
    `insert into pilot.video_sessions (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title,
       blob_path, file_name, file_size_bytes, mime_type, status, scan_state)
     values ('vs-unassigned', $1, $2, null, 'gym footage', 'u.mp4', 'u.mp4', 10, 'video/mp4', 'ready', 'passed')`,
    [ORG, COACH],
  );
  await q(
    `insert into pilot.shadow_research_requirements (organization_id, source_event_name, source_entity_type, source_entity_id,
       research_requirement, knowledge_gap, source_status, source_confidence_tier, source_verification_state,
       created_by_account_id, created_by_role, subject_id)
     values ($1, 'manual_review', 'manual', 'req-src-org', 'doctrine', 'gap', 'open', 'low', 'unverified', $2, 'coach', null)`,
    [ORG, COACH],
  );
  // A coach conversation about nobody, and one about GONE the coach had
  // already deleted a week earlier -- its date must survive.
  await q(
    `insert into pilot.shadow_chat_sessions (conversation_id, organization_id, account_id, athlete_id, title, deleted_at)
     values (gen_random_uuid(), $1, $2, null, 'general', null),
            (gen_random_uuid(), $1, $2, $3, 'deleted earlier', now() - interval '7 days')`,
    [ORG, COACH, GONE],
  );
  // LIVE mentors GONE and THIRD; GONE mentors THIRD. So the deleted athlete
  // appears on both sides of a pairing somebody live still reads.
  await q(
    `insert into pilot.mentorships (organization_id, mentorship_id, mentor_athlete_id, mentee_athlete_id)
     values ($1, 'mentor-sb-gone', $2, $3), ($1, 'mentor-sb-third', $2, $4), ($1, 'mentor-sb-gone-third', $3, $4)`,
    [ORG, LIVE, GONE, THIRD],
  );
  // GONE's own conversation that names no athlete: reachable only through
  // the account half of the stamp.
  await q(
    `insert into pilot.shadow_chat_sessions (conversation_id, organization_id, account_id, athlete_id, title)
     values (gen_random_uuid(), $1, $2, null, 'own, no athlete')`,
    [ORG, GONE_ACCOUNT],
  );
  // The second gym's athlete who shares GONE's id owns rows too.
  await q(
    `insert into pilot.video_sessions (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title,
       blob_path, file_name, file_size_bytes, mime_type, status, scan_state)
     values ('vs-other-gym', $1, $2, $3, 'other gym', 'o.mp4', 'o.mp4', 10, 'video/mp4', 'ready', 'passed')`,
    [OTHER_ORG, OTHER_COACH, GONE],
  );
  await q(
    `insert into pilot.shadow_chat_sessions (conversation_id, organization_id, account_id, athlete_id, title)
     values (gen_random_uuid(), $1, $2, $3, 'other gym')`,
    [OTHER_ORG, OTHER_COACH, GONE],
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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = helper.applyFullSchema as typeof applyFullSchema;

  /* THE WHOLE SCHEMA, not a hand-picked subset (scripts/lib/full-schema.mjs):
     this suite drives feature code across thirty modules. Built once into a
     template, then copied per block, so every block starts from the same rows. */
  await adminQuery(`create database ${TEMPLATE_DB}`);
  const template = new Client({ connectionString: connectionStringFor(TEMPLATE_DB) });
  await template.connect();
  try {
    await applyFullSchema(template, { infraDir: INFRA_DIR });
    await seed(template);
  } finally {
    await template.end();
  }
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
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockMicrosoftPrincipal = requireMicrosoftAuthenticatedPrincipal as jest.Mock;
const mockPinPrincipal = requireMicrosoftOrAttestedLocalPinPrincipal as jest.Mock;

function request(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

async function items<T>(response: Response): Promise<T[]> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: T[] };
  return body.items;
}

/* The readers, each reduced to the athlete ids it shows. A reader appears here
   because this change made it check the athlete's mark; the suite runs every
   one of them in the "before" database and the "after" database. */
type Reader = { readonly name: string; readonly read: () => Promise<string[]> };

const athleteIdsOf = (rows: ReadonlyArray<{ athlete_id?: string | null }>) =>
  rows.map((row) => row.athlete_id).filter((id): id is string => typeof id === 'string');

const READERS: Reader[] = [
  {
    name: 'video list, coach (no athlete named)',
    read: async () => {
      mockRequirePrincipal.mockResolvedValue(principal(COACH, 'coach'));
      return athleteIdsOf(await items(await videoListGET(request('/api/pilot/video/list'))));
    },
  },
  {
    name: 'video list, organization admin',
    read: async () => {
      mockRequirePrincipal.mockResolvedValue(principal(ADMIN, 'organization_admin'));
      return athleteIdsOf(await items(await videoListGET(request('/api/pilot/video/list?scope=all'))));
    },
  },
  {
    name: 'one video by id (publish, clip, analyse, compliance)',
    read: async () =>
      athleteIdsOf(
        (await Promise.all([getVideoSessionById(ORG, 'vs-ath-sb-gone'), getVideoSessionById(ORG, 'vs-ath-sb-live')]))
          .filter((row): row is NonNullable<typeof row> => row !== null),
      ),
  },
  {
    name: 'publication by id (submit, publish)',
    read: async () =>
      athleteIdsOf(
        (await Promise.all([getPublicationForPublish(ORG, 'pub-ath-sb-gone'), getPublicationForPublish(ORG, 'pub-ath-sb-live')]))
          .filter((row): row is NonNullable<typeof row> => row !== null),
      ),
  },
  { name: 'publications list', read: async () => athleteIdsOf(await getOrganizationPublications(ORG)) },
  {
    name: 'research-library shelf',
    read: async () =>
      (await getResearchLibrary(ORG)).map((row) => (row.library_id === 'lib-ath-sb-gone' ? GONE : LIVE)),
  },
  {
    // Both athletes named on purpose: #1015 makes the caller pass the athletes
    // it authorized, and this asks whether the queue itself still honours the
    // mark when a caller names a deleted one.
    name: 'Film Study proposal queue',
    read: async () =>
      athleteIdsOf(await listFilmStudyProposals({ organizationId: ORG, state: 'all', athleteIds: [GONE, LIVE] })),
  },
  { name: 'calibration clips list', read: async () => athleteIdsOf(await listCalibrationClips(ORG, PROJECT)) },
  {
    name: 'one calibration clip',
    read: async () =>
      athleteIdsOf(
        (await Promise.all([getCalibrationClip(ORG, 'clip-ath-sb-gone'), getCalibrationClip(ORG, 'clip-ath-sb-live')]))
          .filter((row): row is NonNullable<typeof row> => row !== null),
      ),
  },
  { name: 'portrait review queue', read: async () => athleteIdsOf((await listPendingReviewPortraits(ORG)).map((p) => ({ athlete_id: p.athleteId }))) },
  { name: 'activity log (community service totals)', read: async () => athleteIdsOf(await listActivityLog(ORG)) },
  {
    name: 'floor hours, one person',
    read: async () => [
      ...athleteIdsOf((await listPersonActivities(ORG, GONE_ACCOUNT)).rows),
      ...athleteIdsOf((await listPersonActivities(ORG, LIVE_ACCOUNT)).rows),
    ],
  },
  { name: 'floor hours, admin', read: async () => athleteIdsOf(await getFloorHoursAdmin(ORG)) },
  { name: 'passbook gap queue', read: async () => athleteIdsOf(await getCoachPassbookGapQueue(ORG, null)) },
  {
    // Read as the athlete: the access guard's athlete arm compares ids and
    // never reads the mark, so for that reader this lookup is the only thing
    // between a session that outlived the deletion and the book.
    name: 'passbook, the full book by athlete id',
    read: async () =>
      (await Promise.all([getAthletePassbook(ORG, GONE, 'athlete'), getAthletePassbook(ORG, LIVE, 'athlete')]))
        .filter((book): book is NonNullable<typeof book> => book !== null)
        .map((book) => book.athlete.athlete_id),
  },
  {
    name: "passbook, the guardian's book by athlete id",
    read: async () =>
      (await Promise.all([getGuardianPassbook(ORG, GONE), getGuardianPassbook(ORG, LIVE)]))
        .filter((book): book is NonNullable<typeof book> => book !== null)
        .map((book) => book.athlete.athlete_id),
  },
  {
    name: 'scheduler store: registrations, requests, attendance',
    read: async () => {
      const store = await listSchedulerStore(ORG);
      return [
        ...athleteIdsOf(store.registrations),
        ...athleteIdsOf(store.coaching_requests),
        ...athleteIdsOf(store.attendance),
      ];
    },
  },
  { name: 'class marking roster', read: async () => listRegisteredAthleteIdsForClass(ORG, CLASS_LAST_WEEK) },
  { name: 'class attendance roster', read: async () => athleteIdsOf(await getClassAttendanceRoster(ORG, CLASS_LAST_WEEK)) },
  { name: 'competition entries', read: async () => athleteIdsOf(await listCompetitionEntries(ORG, COMPETITION)) },
  { name: 'league roster', read: async () => athleteIdsOf(await listLeagueRoster(ORG, SEASON)) },
  { name: '1% Club nominations', read: async () => athleteIdsOf(await listNominations(ORG)) },
  {
    name: '1% Club nomination by id',
    read: async () =>
      athleteIdsOf(
        (await Promise.all([getNomination(ORG, 'nom-ath-sb-gone'), getNomination(ORG, 'nom-ath-sb-live')]))
          .filter((row): row is NonNullable<typeof row> => row !== null),
      ),
  },
  { name: '1% Club members', read: async () => athleteIdsOf(await listMembers(ORG)) },
  {
    name: "LIVE's and THIRD's mentorships (both parties)",
    read: async () =>
      [...(await listMentorshipsForAthlete(ORG, LIVE)), ...(await listMentorshipsForAthlete(ORG, THIRD))].flatMap((m) => [
        m.mentor_athlete_id,
        m.mentee_athlete_id,
      ]),
  },
  { name: 'active coach coverage', read: async () => athleteIdsOf(await listActiveCoachCoverage(ORG)) },
  {
    name: 'duplicate-guardian hidden children',
    read: async () => (await findDuplicateGuardianGroups(ORG)).flatMap((group) => group.hidden_athlete_ids),
  },
  {
    name: 'compliance violations, the coach arm',
    read: async () => athleteIdsOf(await getOrganizationViolations(ORG, { athleteIds: await athleteIdsForCoach(ORG, COACH) })),
  },
  {
    name: 'floor plans, coach',
    read: async () => {
      mockRequirePrincipal.mockResolvedValue(principal(COACH, 'coach'));
      return athleteIdsOf(await items(await floorPlansGET(request('/api/pilot/floor-plans'))));
    },
  },
  {
    name: 'floor plans, organization admin',
    read: async () => {
      mockRequirePrincipal.mockResolvedValue(principal(ADMIN, 'organization_admin'));
      return athleteIdsOf(await items(await floorPlansGET(request('/api/pilot/floor-plans'))));
    },
  },
  {
    name: 'athlete PIN directory',
    read: async () => {
      mockPinPrincipal.mockResolvedValue(principal(ADMIN, 'organization_admin'));
      return athleteIdsOf(await items(await pinDirectoryGET(request('/api/pilot/admin/athlete-pin-directory'))));
    },
  },
  {
    name: 'roster CSV export',
    read: async () => {
      mockMicrosoftPrincipal.mockResolvedValue(principal(ADMIN, 'organization_admin'));
      const response = await exportRosterGET(request('/api/pilot/admin/export/roster'));
      expect(response.status).toBe(200);
      const csv = await response.text();
      return [GONE, LIVE].filter((id) => csv.includes(id));
    },
  },
  {
    name: 'SHADOW research requirements, organization admin',
    read: async () => {
      mockRequirePrincipal.mockResolvedValue(principal(ADMIN, 'organization_admin'));
      const rows = await items<{ subject_id: string | null }>(
        await researchRequirementsGET(request('/api/pilot/shadow/research-requirements')),
      );
      return rows.map((row) => row.subject_id).filter((id): id is string => typeof id === 'string');
    },
  },
];

describe('before the deletion: every reader shows the athlete (the positive control)', () => {
  beforeAll(async () => {
    activeClient = await cloneTemplate('scope_b_before');
  });
  afterAll(async () => {
    await activeClient?.end();
    activeClient = null;
  });

  test.each(READERS.map((reader) => [reader.name, reader] as const))('%s shows both athletes', async (_name, reader) => {
    const shown = await reader.read();
    expect(shown).toContain(GONE);
    expect(shown).toContain(LIVE);
  });

  test('the seat GONE holds is taken: THIRD is waitlisted', async () => {
    const outcome = await registerForClassTransactionally(ORG, CLASS_SEAT, THIRD, seatRequest('before'));
    expect(outcome.outcome).toBe('waitlisted');
  });

  test('the public wall counts both athletes on the floor and in the marquee', async () => {
    const board = await loadWallBoard({ organizationId: ORG, mode: 'initials' });
    expect(board.on_floor_total).toBe(2);
    expect(board.marquee.length).toBe(2);
  });

  test('the Wall of Names, the weekly trend and program headcount count GONE', async () => {
    expect((await loadWallOfNames({ organizationId: ORG, mode: 'initials' })).total_people).toBe(3);
    expect(totalMarked(await getWeeklyAttendanceTrend(ORG))).toBe(2);
    expect(headcount(await listProgramsWithCounts(ORG))).toBe(2);
  });

  test("a guardian reaches their deleted-to-be child's coach portrait relationship", async () => {
    expect(await guardianToCoach(GUARDIAN_GONE)).toBe('subject_is_my_staff');
  });

  test('the scan queue would claim GONE\'s footage first (it is older)', async () => {
    const claim = await claimNextVideoSessionForScan();
    expect(claim?.athlete_id).toBe(GONE);
  });
  // LAST in this block: it adds four filler athletes, because the board
  // suppresses any count under BOARD_MINIMUM_COHORT_SIZE (5).
  test('the board summary counts GONE as an active athlete', async () => {
    await addBoardFillers();
    expect((await getBoardSummary(ORG)).activeAthletes).toEqual({ status: 'available', count: 7 });
  });
});

describe('after deleteAthleteRecord(GONE)', () => {
  let result: Awaited<ReturnType<typeof deleteAthleteRecord>>;
  let deletedAt: string;

  beforeAll(async () => {
    activeClient = await cloneTemplate('scope_b_after');
    result = await deleteAthleteRecord(adminActor, GONE, 'Family moved away');
    deletedAt = (
      await activeClient.query<{ deleted_at: string }>(
        `select deleted_at::text as deleted_at from pilot.athletes where organization_id = $1 and athlete_id = $2`,
        [ORG, GONE],
      )
    ).rows[0].deleted_at;
  });
  afterAll(async () => {
    await activeClient?.end();
    activeClient = null;
  });

  test.each(READERS.map((reader) => [reader.name, reader] as const))('%s no longer shows GONE, still shows LIVE', async (_name, reader) => {
    const shown = await reader.read();
    expect(shown).not.toContain(GONE);
    expect(shown).toContain(LIVE);
  });

  test('the result counts what the mark now covers', () => {
    expect(result.deletedRecordsCounts).toEqual({
      athletes: 1,
      accounts: 1,
      athleteVideos: 2,
      athletePhotos: 1,
      coachNotes: 1,
      sessionNotes: 5,
      shadowConversations: 3,
    });
  });

  test('the audit event records the same counts, and no longer claims observations "retained"', async () => {
    const audit = await activeClient!.query<{ details: Record<string, unknown> }>(
      `select details from pilot.audit_events where audit_id = $1`,
      [result.auditEventId],
    );
    expect(audit.rows[0].details.tied_records_marked).toEqual({
      videos: 2,
      photos: 1,
      coach_notes: 1,
      session_notes: 5,
      shadow_conversations: 3,
    });
    expect(audit.rows[0].details).not.toHaveProperty('observations_retained');
  });

  test("GONE's own and the coach's conversation about GONE carry the deletion's own timestamp", async () => {
    const rows = await activeClient!.query<{ title: string; deleted_at: string | null }>(
      `select title, deleted_at::text as deleted_at from pilot.shadow_chat_sessions
        where organization_id = $1 and athlete_id = $2 order by title`,
      [ORG, GONE],
    );
    const byTitle = Object.fromEntries(rows.rows.map((row) => [row.title, row.deleted_at]));
    expect(byTitle.own).toBe(deletedAt);
    expect(byTitle.about).toBe(deletedAt);
    // Deleted a week earlier: keeps its own, earlier date.
    expect(byTitle['deleted earlier']).not.toBe(deletedAt);
    expect(byTitle['deleted earlier']).not.toBeNull();

    // GONE's own conversation that names no athlete: found by the account.
    const ownOnly = await activeClient!.query<{ deleted_at: string | null }>(
      `select deleted_at::text as deleted_at from pilot.shadow_chat_sessions where account_id = $1 and athlete_id is null`,
      [GONE_ACCOUNT],
    );
    expect(ownOnly.rows).toEqual([{ deleted_at: deletedAt }]);
  });

  test("LIVE's conversations, the coach's general one and the other gym's are untouched", async () => {
    const rows = await activeClient!.query<{ organization_id: string; title: string; athlete_id: string | null }>(
      `select organization_id, title, athlete_id from pilot.shadow_chat_sessions where deleted_at is null order by 1, 2, 3`,
    );
    expect(rows.rows).toEqual([
      { organization_id: ORG, title: 'about', athlete_id: LIVE },
      { organization_id: ORG, title: 'general', athlete_id: null },
      { organization_id: ORG, title: 'own', athlete_id: LIVE },
      { organization_id: OTHER_ORG, title: 'other gym', athlete_id: GONE },
    ]);
  });

  test('nothing tied to GONE was removed: the rows are marked, not erased', async () => {
    const counts = await activeClient!.query<{ videos: string; sessions: string; notes: string }>(
      `select
         (select count(*) from pilot.video_sessions where organization_id = $1 and athlete_id = $2)::text as videos,
         (select count(*) from pilot.sessions where organization_id = $1 and athlete_id = $2)::text as sessions,
         (select count(*) from pilot.coach_observations where organization_id = $1 and athlete_id = $2)::text as notes`,
      [ORG, GONE],
    );
    expect(counts.rows[0]).toEqual({ videos: '2', sessions: '5', notes: '1' });
  });

  test('the second gym\'s athlete with the same id is not deleted and its footage still reads', async () => {
    expect(await getVideoSessionById(OTHER_ORG, 'vs-other-gym')).not.toBeNull();
    expect(await deletedAthleteIdsAmong(OTHER_ORG, [GONE])).toEqual(new Set());
    expect(await deletedAthleteIdsAmong(ORG, [GONE, LIVE, 'no-such-athlete'])).toEqual(new Set([GONE]));
  });

  test('unassigned gym footage is still listed', async () => {
    mockRequirePrincipal.mockResolvedValue(principal(COACH, 'coach'));
    const rows = await items<{ video_session_id: string }>(await videoListGET(request('/api/pilot/video/list')));
    expect(rows.map((row) => row.video_session_id)).toContain('vs-unassigned');
  });

  test('the seat GONE held is free: THIRD registers, and a live holder still fills CLASS_FULL', async () => {
    expect((await registerForClassTransactionally(ORG, CLASS_SEAT, THIRD, seatRequest('after'))).outcome).toBe('registered');
    expect((await registerForClassTransactionally(ORG, CLASS_FULL, THIRD, seatRequest('after-full'))).outcome).toBe('waitlisted');
  });

  test('the paired wall counts only LIVE on the floor and in the marquee', async () => {
    const board = await loadWallBoard({ organizationId: ORG, mode: 'initials' });
    expect(board.on_floor_total).toBe(1);
    expect(board.marquee.length).toBe(1);
  });

  test('the public wall (head count only, W1) counts only LIVE, in total and per class', async () => {
    const board = await loadPublicWallBoard({ organizationId: ORG });
    expect(board.on_floor_total).toBe(1);
    expect(board.sessions.reduce((sum, session) => sum + session.on_floor, 0)).toBe(1);
  });

  test('the Wall of Names, the weekly trend and program headcount leave GONE out', async () => {
    expect((await loadWallOfNames({ organizationId: ORG, mode: 'initials' })).total_people).toBe(2);
    expect(totalMarked(await getWeeklyAttendanceTrend(ORG))).toBe(1);
    expect(headcount(await listProgramsWithCounts(ORG))).toBe(1);
  });

  test("the admin aggregates' roster (intelligence, readiness, performance, progression) leaves GONE out", async () => {
    const ids = (await organizationActionableRoster(ORG)).map((athlete) => athlete.athlete_id).sort();
    expect(ids).toEqual([LIVE, THIRD].sort());
  });

  test("the link to a deleted child no longer makes their coach the guardian's staff; a live child's still does", async () => {
    expect(await guardianToCoach(GUARDIAN_GONE)).toBe('none');
    expect(await guardianToCoach(GUARDIAN_LIVE)).toBe('subject_is_my_staff');
  });

  test("the scan queue skips GONE's footage and claims LIVE's, then has nothing left", async () => {
    const claim = await claimNextVideoSessionForScan();
    expect(claim?.athlete_id).toBe(LIVE);
    expect(await claimNextVideoSessionForScan()).toBeNull();
  });
  // LAST in this block, for the same reason as its twin above.
  test('the board summary no longer counts GONE as an active athlete', async () => {
    await addBoardFillers();
    expect((await getBoardSummary(ORG)).activeAthletes).toEqual({ status: 'available', count: 6 });
  });
});

describe('after deleteGuardianAccount: a child the trigger withdraws is marked the same way', () => {
  let result: Awaited<ReturnType<typeof deleteGuardianAccount>>;

  beforeAll(async () => {
    activeClient = await cloneTemplate('scope_b_guardian');
    // GONE's guardians are parent-sb-gone and the unclaimed duplicate record.
    // An account-less guardian record counts as remaining (the trigger's own
    // rule), so drop that link first to make GUARDIAN_GONE the last one.
    await activeClient.query(
      `delete from pilot.guardian_links where organization_id = $1 and parent_id = 'parent-sb-dup-unclaimed' and athlete_id = $2`,
      [ORG, GONE],
    );
    result = await deleteGuardianAccount(adminActor, GUARDIAN_GONE, 'Family moved away');
  });
  afterAll(async () => {
    await activeClient?.end();
    activeClient = null;
  });

  test('the trigger withdrew GONE, and the result counts what the mark covers', () => {
    expect(result.deletedRecordsCounts).toEqual({
      accounts: 1,
      athletes: 1,
      athleteVideos: 2,
      athletePhotos: 1,
      coachNotes: 1,
      sessionNotes: 5,
      shadowConversations: 3,
    });
  });

  test("the withdrawn child's conversations carry the guardian deletion's timestamp; LIVE's do not", async () => {
    const guardianDeletedAt = (
      await activeClient!.query<{ deleted_at: string }>(
        `select deleted_at::text as deleted_at from pilot.accounts where account_id = $1`,
        [GUARDIAN_GONE],
      )
    ).rows[0].deleted_at;
    const rows = await activeClient!.query<{ athlete_id: string; title: string; deleted_at: string | null }>(
      `select athlete_id, title, deleted_at::text as deleted_at from pilot.shadow_chat_sessions
        where organization_id = $1 and athlete_id in ($2, $3) and title in ('own', 'about') order by 1, 2`,
      [ORG, GONE, LIVE],
    );
    expect(rows.rows).toEqual([
      { athlete_id: GONE, title: 'about', deleted_at: guardianDeletedAt },
      { athlete_id: GONE, title: 'own', deleted_at: guardianDeletedAt },
      { athlete_id: LIVE, title: 'about', deleted_at: null },
      { athlete_id: LIVE, title: 'own', deleted_at: null },
    ]);
    const ownOnly = await activeClient!.query<{ deleted_at: string | null }>(
      `select deleted_at::text as deleted_at from pilot.shadow_chat_sessions where account_id = $1 and athlete_id is null`,
      [GONE_ACCOUNT],
    );
    expect(ownOnly.rows).toEqual([{ deleted_at: guardianDeletedAt }]);
  });

  test('a reader drops the withdrawn child exactly as it does an explicit deletion', async () => {
    const shown = athleteIdsOf(await getOrganizationPublications(ORG));
    expect(shown).not.toContain(GONE);
    expect(shown).toContain(LIVE);
  });
});

async function addBoardFillers(): Promise<void> {
  for (let n = 1; n <= 4; n += 1) {
    await activeClient!.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Filler', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [ORG, `ATH-SB-FILLER-${n}`, COACH],
    );
  }
}

function seatRequest(tag: string) {
  const now = new Date().toISOString();
  return {
    registration_id: `reg-sb-third-${tag}`,
    class_id: '',
    athlete_id: THIRD,
    requested_by_role: 'coach' as const,
    requested_by_account_id: COACH,
    parent_reviewed: false,
    created_at: now,
    updated_at: now,
  };
}

function totalMarked(rows: ReadonlyArray<{ total_marked: number }>): number {
  return rows.reduce((sum, row) => sum + row.total_marked, 0);
}

function headcount(rows: ReadonlyArray<{ program_name: string; active_member_count: number }>): number {
  return rows.find((row) => row.program_name === PROGRAM_NAME)?.active_member_count ?? -1;
}

async function guardianToCoach(guardianAccount: string) {
  const coach = await getSubjectIdentity(ORG, COACH);
  if (!coach) throw new Error('test bug: coach identity missing');
  return resolveRelationship(
    { accountId: guardianAccount, role: 'parent', organizationId: ORG, athleteId: null },
    coach,
    ORG,
  );
}
