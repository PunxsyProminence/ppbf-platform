// The write and the read of a child's pain report, against real PostgreSQL.
//
// WHY THIS FILE EXISTS
//   The path is complete and live: AthleteWorkspace posts an observation, the
//   route calls alertCoachToPainReport BEFORE persisting it, that writes a
//   near-miss row and emits a SHADOW event, and CoachWorkspace reads it back
//   through /api/pilot/coach/pain-reports.
//
//   Nothing had ever executed the read against a database. Every existing test
//   mocks flagNearMiss, emitShadowEvent and query, so the strongest assertion
//   in the suite was that the writer was CALLED with the right arguments --
//   not that a row comes back. The two halves live in different modules and
//   meet only through jsonb: painReportAlert.ts writes `trigger` into a
//   metadata object, shadowNearMisses.ts serialises it with JSON.stringify,
//   and the coach's read finds it again with `metadata->>'trigger' = $2`.
//   A mock cannot see that seam at all.
//
//   This is a minor's health information. "The function was called correctly"
//   is not the assertion that matters; "the coach can retrieve it" is.
//
// WHAT IS REAL HERE
//   Everything except the database's address. alertCoachToPainReport runs
//   unmocked, so flagNearMiss's transaction, its audit entry, the automatic
//   escalation for high/critical, and emitShadowEvent all execute. The reads
//   are the same two exported functions the coach route calls.
//
// Spins up the same disposable, local-only embedded Postgres every other
// migration suite uses. It NEVER connects to production or staging.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-pain-report-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_pain_report';

// Mirror of MIGRATION_FILES in scripts/pilot-apply-shadow-runtime-migration.mjs.
// pilot.safety_escalations comes from the base schema, which matters here:
// a pain score of 4 or more escalates automatically inside flagNearMiss's
// transaction, so a missing escalations table would fail the WRITE rather
// than the read and disguise which half is broken.
const SHADOW_RUNTIME_MIGRATION_FILES = [
  'pilot_slice_postgres_shadow_runtime_migration.sql',
  'pilot_slice_postgres_shadow_formula_foundation_migration.sql',
  'pilot_slice_postgres_shadow_evidence_migration.sql',
  'pilot_slice_postgres_shadow_job_lease_migration.sql',
  'pilot_slice_postgres_board_role_migration.sql',
  'pilot_slice_postgres_shadow_decision_loop_migration.sql',
  'pilot_slice_postgres_shadow_chunk_embedding_migration.sql',
];

const ORG_A = 'org-pain-a';
const ORG_B = 'org-pain-b';
const COACH_A = 'acct-pain-coach-a';
const COACH_B = 'acct-pain-coach-b';
const ATHLETE_A = 'ATH-PAIN-1';
const ATHLETE_A2 = 'ATH-PAIN-2';
const ATHLETE_B = 'ATH-PAIN-B1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let painReport: typeof import('./formulas/painReportAlert');
let nearMisses: typeof import('./shadowNearMisses');
let db: typeof import('./db');

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

/** One athlete self-reporting pain, exactly as the observations route submits it. */
function report(overrides: {
  organizationId?: string;
  athleteId?: string;
  actorAccountId?: string;
  actorRole?: string;
  value: number;
  location?: string;
  painType?: string;
  observedAt?: string;
}) {
  return painReport.alertCoachToPainReport({
    organizationId: overrides.organizationId ?? ORG_A,
    athleteId: overrides.athleteId ?? ATHLETE_A,
    kind: painReport.PAIN_REPORT_KIND,
    value: overrides.value,
    dimensions: {
      location: overrides.location ?? 'left shoulder',
      painType: overrides.painType ?? 'aching',
    },
    actorAccountId: overrides.actorAccountId ?? COACH_A,
    actorRole: overrides.actorRole ?? 'athlete',
    contextId: 'ctx-pain-round-trip',
    observedAt: overrides.observedAt ?? '2026-08-26T18:30:00.000Z',
  });
}

async function insertOrganization(client: Client, organizationId: string): Promise<void> {
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [organizationId],
  );
}

async function insertAccount(client: Client, accountId: string, organizationId: string): Promise<void> {
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [accountId, organizationId],
  );
}

async function insertAthlete(
  client: Client,
  organizationId: string,
  athleteId: string,
  fullName: string,
  coachId: string,
): Promise<void> {
  // pilot.athletes declares created_at/updated_at NOT NULL with no defaults.
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, $3, '2012-03-04', 'fly', 'active', 'contact', true, $4, now(), now())`,
    [organizationId, athleteId, fullName, coachId],
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

  const migrateClient = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await migrateClient.connect();
  await migrateClient.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
  for (const file of SHADOW_RUNTIME_MIGRATION_FILES) {
    await migrateClient.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
  }

  // Two gyms, because the coach read is organization-scoped and a suite with
  // one organization cannot tell a working predicate from a missing one.
  await insertOrganization(migrateClient, ORG_A);
  await insertOrganization(migrateClient, ORG_B);
  await insertAccount(migrateClient, COACH_A, ORG_A);
  await insertAccount(migrateClient, COACH_B, ORG_B);
  await insertAthlete(migrateClient, ORG_A, ATHLETE_A, 'Pain Athlete One', COACH_A);
  await insertAthlete(migrateClient, ORG_A, ATHLETE_A2, 'Pain Athlete Two', COACH_A);
  await insertAthlete(migrateClient, ORG_B, ATHLETE_B, 'Other Gym Athlete', COACH_B);
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  db = await import('./db');
  nearMisses = await import('./shadowNearMisses');
  painReport = await import('./formulas/painReportAlert');
});

afterEach(async () => {
  await db.query('delete from pilot.safety_escalations');
  await db.query('delete from pilot.shadow_near_misses');
  await db.query('delete from pilot.shadow_events');
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
});

describe('a pain report written by an athlete is retrievable by their coach', () => {
  test('the whole round trip, through both reads the coach route makes', async () => {
    const outcome = await report({ value: 6, location: 'right wrist', painType: 'sharp' });
    expect(outcome).toEqual({ raised: true, severity: 'high' });

    // First read: which athletes have a report at all. The route runs each id
    // past access.ts before asking for any detail, so this half must work on
    // its own.
    const athleteIds = await painReport.listAthletesWithRecentPainReports(ORG_A);
    expect(athleteIds).toEqual([ATHLETE_A]);

    // Second read: the reports themselves, for the ids that survived access.
    const page = await painReport.listPainReportsForAthletes(ORG_A, athleteIds, { limit: 20 });
    expect(page.truncated).toBe(false);
    expect(page.reports).toHaveLength(1);

    const [only] = page.reports;
    expect(only.athleteId).toBe(ATHLETE_A);
    expect(only.athleteName).toBe('Pain Athlete One');
    expect(only.severity).toBe('high');
    expect(only.painScore).toBe(6);
    expect(only.location).toBe('right wrist');
    expect(only.painType).toBe('sharp');
    expect(only.observedAt).toBe('2026-08-26T18:30:00.000Z');
    expect(only.reporter).toBe('athlete');
    expect(only.recordedAt).not.toBeNull();
  });

  test('the second write lands too: the report reaches the coach observation feed', async () => {
    await report({ value: 8 });

    // alertCoachToPainReport writes twice on purpose -- the near miss is the
    // reviewable record, the event is what surfaces it in the feed the coach
    // workspace loads without being told to look. Asserting only the near miss
    // would leave half the contract unmeasured.
    const events = await db.query<{ event_name: string; entity_id: string; payload: Record<string, unknown> }>(
      `select event_name, entity_id, payload from pilot.shadow_events where organization_id = $1`,
      [ORG_A],
    );
    expect(events).toHaveLength(1);
    expect(events[0].event_name).toBe(painReport.PAIN_REPORT_PENDING_REVIEW_EVENT_NAME);
    expect(events[0].entity_id).toBe(ATHLETE_A);
    expect(events[0].payload).toMatchObject({
      athlete_id: ATHLETE_A,
      severity_1_10: 8,
      near_miss_severity: 'critical',
      reporter_role: 'athlete',
    });
  });

  test('a report at 4 or above escalates in the same transaction as the near miss', async () => {
    await report({ value: 7 });

    // flagNearMiss files the escalation inside its own transaction precisely so
    // a report severe enough to escalate cannot commit without one. Read it
    // back rather than trusting the comment.
    const escalations = await db.query<{ source_type: string; severity: string; athlete_id: string }>(
      `select source_type, severity, athlete_id from pilot.safety_escalations where organization_id = $1`,
      [ORG_A],
    );
    expect(escalations).toEqual([
      { source_type: 'near_miss', severity: 'critical', athlete_id: ATHLETE_A },
    ]);
  });
});

describe('the jsonb predicate that separates a pain report from any other near miss', () => {
  test('a hand-flagged near miss is not returned as a pain report', async () => {
    // This is the seam a mock cannot see. painReportAlert.ts puts `trigger`
    // into a metadata object, shadowNearMisses.ts serialises it with
    // JSON.stringify, and the coach read finds it again with
    // `metadata->>'trigger'`. If that predicate stopped discriminating, every
    // near miss in the gym would render on a coach's screen as a child
    // reporting pain -- so prove it excludes as well as includes.
    await nearMisses.flagNearMiss({
      organizationId: ORG_A,
      athleteId: ATHLETE_A2,
      description: 'Sparring intensity above the agreed plan',
      severity: 'high',
      detectedByAccountId: COACH_A,
      detectedByRole: 'coach',
    });
    await report({ value: 5, athleteId: ATHLETE_A });

    const athleteIds = await painReport.listAthletesWithRecentPainReports(ORG_A);
    expect(athleteIds).toEqual([ATHLETE_A]);

    // Ask for BOTH athletes explicitly, so the exclusion is the predicate's
    // doing and not a side effect of the first read having already dropped one.
    const page = await painReport.listPainReportsForAthletes(ORG_A, [ATHLETE_A, ATHLETE_A2], { limit: 20 });
    expect(page.reports.map((row) => row.athleteId)).toEqual([ATHLETE_A]);
  });

  test('a coach reporting on the athlete\'s behalf is labelled as the coach, not the child', async () => {
    await report({ value: 5, actorRole: 'coach' });

    const page = await painReport.listPainReportsForAthletes(ORG_A, [ATHLETE_A], { limit: 20 });
    expect(page.reports[0].reporter).toBe('coach');
  });
});

describe('the window, the ordering and the cap the coach panel depends on', () => {
  test('a report older than the alert window drops out of both reads', async () => {
    const outcome = await report({ value: 5 });
    expect(outcome.raised).toBe(true);

    await db.query(
      `update pilot.shadow_near_misses set created_at = now() - interval '30 days'
       where organization_id = $1`,
      [ORG_A],
    );

    expect(await painReport.listAthletesWithRecentPainReports(ORG_A)).toEqual([]);
    const page = await painReport.listPainReportsForAthletes(ORG_A, [ATHLETE_A], { limit: 20 });
    expect(page.reports).toEqual([]);

    // Widening the window brings the same row back, which is what proves the
    // interval arithmetic is doing the excluding rather than the row being
    // absent.
    const widened = await painReport.listPainReportsForAthletes(ORG_A, [ATHLETE_A], {
      limit: 20,
      windowDays: 90,
    });
    expect(widened.reports).toHaveLength(1);
    expect(await painReport.listAthletesWithRecentPainReports(ORG_A, 90)).toEqual([ATHLETE_A]);
  });

  test('severity outranks recency, so a critical report is never pushed off the end', async () => {
    await report({ value: 2, athleteId: ATHLETE_A });
    await report({ value: 9, athleteId: ATHLETE_A2 });

    const page = await painReport.listPainReportsForAthletes(ORG_A, [ATHLETE_A, ATHLETE_A2], { limit: 20 });
    expect(page.reports.map((row) => [row.severity, row.painScore])).toEqual([
      ['critical', 9],
      ['moderate', 2],
    ]);
  });

  test('a capped list says it is partial rather than reading as the whole set', async () => {
    await report({ value: 5, athleteId: ATHLETE_A });
    await report({ value: 6, athleteId: ATHLETE_A2 });

    const page = await painReport.listPainReportsForAthletes(ORG_A, [ATHLETE_A, ATHLETE_A2], { limit: 1 });
    expect(page.reports).toHaveLength(1);
    expect(page.truncated).toBe(true);

    const full = await painReport.listPainReportsForAthletes(ORG_A, [ATHLETE_A, ATHLETE_A2], { limit: 2 });
    expect(full.reports).toHaveLength(2);
    expect(full.truncated).toBe(false);
  });
});

describe('one gym only', () => {
  test('another gym\'s pain report is invisible, by id and by organization', async () => {
    await report({
      organizationId: ORG_B,
      athleteId: ATHLETE_B,
      actorAccountId: COACH_B,
      value: 9,
    });

    expect(await painReport.listAthletesWithRecentPainReports(ORG_A)).toEqual([]);

    // Naming the other gym's athlete id explicitly is the case that matters:
    // the organization predicate has to refuse it even when the caller asks
    // for it directly.
    const page = await painReport.listPainReportsForAthletes(ORG_A, [ATHLETE_B], { limit: 20 });
    expect(page.reports).toEqual([]);

    // And the report really was written -- so the empty results above are the
    // scope predicate working, not the write having failed.
    const theirs = await painReport.listPainReportsForAthletes(ORG_B, [ATHLETE_B], { limit: 20 });
    expect(theirs.reports.map((row) => row.athleteId)).toEqual([ATHLETE_B]);
  });
});

describe('what is not a pain report', () => {
  test('a non-pain observation writes nothing at all', async () => {
    const outcome = await painReport.alertCoachToPainReport({
      organizationId: ORG_A,
      athleteId: ATHLETE_A,
      kind: 'rpe',
      value: 9,
      dimensions: {},
      actorAccountId: COACH_A,
      actorRole: 'athlete',
      contextId: 'ctx-not-pain',
      observedAt: '2026-08-26T18:30:00.000Z',
    });

    expect(outcome).toEqual({ raised: false });
    const rows = await db.query<{ n: string }>(
      `select count(*)::text as n from pilot.shadow_near_misses where organization_id = $1`,
      [ORG_A],
    );
    expect(rows[0].n).toBe('0');
  });
});
