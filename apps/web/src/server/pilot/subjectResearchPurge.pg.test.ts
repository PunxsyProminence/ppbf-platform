// Real PostgreSQL proof that the retention purge (scripts/pilot-cleanup-
// deleted-data.mjs, run as its own process) deletes the SHADOW research
// requirements ABOUT a purged athlete, and their submissions (F-079): a row
// naming the athlete in subject_id, metadata.subject_id or metadata.athlete_id,
// whoever filed it. Rows about another child, rows naming no child, another
// gym's rows and a child still inside retention stay; an athlete whose purge
// is rolled back keeps theirs, uncounted.
//
// Spins up the disposable local-only embedded Postgres the other suites use.
// It NEVER connects to production or staging.

import { type ChildProcessByStdio, execFile, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-subject-research-purge-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const CLEANUP_SCRIPT = path.resolve(__dirname, '../../../scripts/pilot-cleanup-deleted-data.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_subject_research_purge';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-sr-1';
const OTHER_ORG = 'org-sr-2';
const ATHLETE_A = 'ath-sr-a'; // purged: deleted three years ago
const ATHLETE_B = 'ath-sr-b'; // live
const ATHLETE_C = 'ath-sr-c'; // deleted, still inside retention
const ATHLETE_D = 'ath-sr-d'; // past retention, but its purge is refused (a video, no storage)
const ADMIN = 'acct-sr-admin';
const COACH = 'acct-sr-coach';
const OTHER_ADMIN = 'acct-sr-admin-2';
const SOURCE = 'src-sr-1';
const OTHER_SOURCE = 'src-sr-2';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
        return;
      }
      server.close(() => reject(new Error('Could not determine a free port')));
    });
  });
}

function runCleanupScript(extraEnv: Record<string, string>) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
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
          PPBF_RETENTION_STORAGE_ACCOUNT_URL: '',
          ...extraEnv,
        },
      },
      (_error, stdout, stderr) => {
        const line = `${stdout}${stderr}`.split('\n').find((entry) => entry.trim().startsWith('{'));
        if (!line) {
          reject(new Error(`No JSON output. stdout=${stdout} stderr=${stderr}`));
          return;
        }
        resolve(JSON.parse(line) as Record<string, unknown>);
      },
    );
  });
}

/** Files one research requirement straight into the table, as each writer
 *  stores it; `marker` is unique text to find the row by. */
async function insertRequirement(
  organizationId: string,
  marker: string,
  subjectId: string | null,
  metadata: Record<string, unknown>,
  createdBy = COACH,
): Promise<number> {
  const result = await db.query(
    `insert into pilot.shadow_research_requirements
       (organization_id, source_event_name, source_entity_type, source_entity_id, research_requirement,
        knowledge_gap, evidence_label, source_status, source_confidence_tier, source_verification_state,
        created_by_account_id, created_by_role, metadata, subject_id)
     values ($1, 'SHADOW_INTAKE_CASE_REJECTED', 'intake_case', $2, $2, 'gap', null, 'weak', 'LIMITED', 'unverified',
             $3, 'coach', $4::jsonb, $5)
     returning research_requirement_id`,
    [organizationId, marker, createdBy, JSON.stringify(metadata), subjectId],
  );
  return Number(result.rows[0].research_requirement_id);
}

async function insertSubmission(organizationId: string, requirementId: number, sourceId: string, by: string) {
  await db.query(
    `insert into pilot.shadow_research_submissions
       (organization_id, submission_id, research_requirement_id, source_id, submitted_by_account_id)
     values ($1, $2, $3, $4, $5)`,
    [organizationId, `sub-${requirementId}`, requirementId, sourceId, by],
  );
}

const requirementCount = async (marker: string) =>
  Number((await db.query(
    'select count(*)::int as n from pilot.shadow_research_requirements where research_requirement = $1',
    [marker],
  )).rows[0].n);

const submissionCount = async (marker: string) =>
  Number((await db.query(
    `select count(*)::int as n from pilot.shadow_research_submissions s
       join pilot.shadow_research_requirements r on r.research_requirement_id = s.research_requirement_id
      where r.research_requirement = $1`,
    [marker],
  )).rows[0].n);

const allSubmissions = async () =>
  Number((await db.query('select count(*)::int as n from pilot.shadow_research_submissions')).rows[0].n);

// About A, each by one field only, so each field is proven on its own.
const ABOUT_A = ['SUBJ-COLUMN-A', 'META-SUBJECT-A', 'META-ATHLETE-A'];
// Rows that must survive A's purge.
const KEPT = ['OTHER-CHILD-B', 'GYM-WIDE-NO-CHILD', 'RECENT-DELETE-C', 'OTHER-GYM-SAME-ID', 'NEAR-MISS-ID'];

beforeAll(async () => {
  PG_PORT = await freePort();

  serverProcess = spawn(
    process.execPath,
    [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ) as ChildProcessByStdio<null, Readable, Readable>;
  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => {
    stderrOutput += String(chunk);
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
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  db = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await db.connect();
  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  await (helper.applyFullSchema as (client: Client, opts?: { infraDir?: string }) => Promise<unknown>)(db, {
    infraDir: INFRA_DIR,
  });

  await db.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, 'Punxsy Prominence', 'active'), ($2, 'Other Gym', 'active')`,
    [ORG, OTHER_ORG],
  );
  for (const [accountId, role, organizationId] of [
    [ADMIN, 'organization_admin', ORG],
    [COACH, 'coach', ORG],
    [OTHER_ADMIN, 'organization_admin', OTHER_ORG],
  ]) {
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'microsoft')`,
      [accountId, role, organizationId],
    );
  }
  await db.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
     values
       ($1, $3, 'Rosa Ortiz', '2012-04-03', 'youth-60', 'active', 'Guardian', false, $7, now(), now(), now() - interval '3 years'),
       ($1, $4, 'Sam Rivera', '2011-02-09', 'youth-65', 'active', 'Guardian', true, $7, now(), now(), null),
       ($1, $5, 'Dee Park', '2013-06-01', 'youth-55', 'active', 'Guardian', false, $7, now(), now(), now() - interval '30 days'),
       ($1, $6, 'Lee Moss', '2012-09-09', 'youth-55', 'active', 'Guardian', false, $7, now(), now(), null),
       ($2, $3, 'Another Child', '2012-01-01', 'youth-60', 'active', 'Guardian', true, $8, now(), now(), null)`,
    [ORG, OTHER_ORG, ATHLETE_A, ATHLETE_B, ATHLETE_C, ATHLETE_D, COACH, OTHER_ADMIN],
  );
  await db.query(
    `insert into pilot.shadow_library_sources (source_id, organization_id, title, source_type, authority_tier)
     values ($1, $2, 'RPE reliability in adolescent athletes', 'peer_reviewed', 1),
            ($3, $4, 'RPE reliability in adolescent athletes', 'peer_reviewed', 1)`,
    [SOURCE, ORG, OTHER_SOURCE, OTHER_ORG],
  );

  // About A, one field each: the subject_id column (intake review, staff
  // filing); metadata.subject_id, padded the way the readers trim it (the
  // Library claim gap); metadata.athlete_id alone (a legacy intake row).
  const subjectColumn = await insertRequirement(ORG, 'SUBJ-COLUMN-A', ATHLETE_A, { notes: 'Rosa: cut too fast' });
  const metaSubject = await insertRequirement(ORG, 'META-SUBJECT-A', null, { subject_id: `  ${ATHLETE_A} ` });
  const metaAthlete = await insertRequirement(ORG, 'META-ATHLETE-A', null, { athlete_id: ATHLETE_A }, ADMIN);
  for (const id of [subjectColumn, metaSubject, metaAthlete]) await insertSubmission(ORG, id, SOURCE, ADMIN);

  // Must stay: another child; the gym's own research naming no child; a child
  // deleted but inside retention; the same athlete id in another gym; an id
  // that only starts with A's.
  const otherChild = await insertRequirement(ORG, 'OTHER-CHILD-B', ATHLETE_B, { athlete_id: ATHLETE_B });
  const gymWide = await insertRequirement(ORG, 'GYM-WIDE-NO-CHILD', null, { capability_key: 'jab' });
  const recent = await insertRequirement(ORG, 'RECENT-DELETE-C', ATHLETE_C, {});
  const otherGym = await insertRequirement(OTHER_ORG, 'OTHER-GYM-SAME-ID', ATHLETE_A, { athlete_id: ATHLETE_A }, OTHER_ADMIN);
  const nearMiss = await insertRequirement(ORG, 'NEAR-MISS-ID', `${ATHLETE_A}-2`, {});
  for (const id of [otherChild, gymWide, recent, nearMiss]) await insertSubmission(ORG, id, SOURCE, ADMIN);
  await insertSubmission(OTHER_ORG, otherGym, OTHER_SOURCE, OTHER_ADMIN);
});

afterAll(async () => {
  await db?.end().catch(() => {});

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

describe('the retention purge and the research rows about a purged athlete', () => {
  test('a dry run counts the rows about the athlete and their submissions, and deletes nothing', async () => {
    const dry = await runCleanupScript({ PPBF_RETENTION_APPLY: 'false' });
    expect(dry.event).toBe('retention.cleanup.dry-run');
    expect(dry.blocked_by ?? {}).toEqual({});
    expect(dry.would_delete_subject_research_requirements).toBe(3);
    expect(dry.would_delete_subject_research_submissions).toBe(3);
    for (const marker of [...ABOUT_A, ...KEPT]) expect(await requirementCount(marker)).toBe(1);
    expect(await allSubmissions()).toBe(8);
  });

  test('the purge deletes every row naming the athlete, by any of the three fields, with its submissions', async () => {
    const event = await runCleanupScript({ PPBF_RETENTION_APPLY: 'true' });
    expect(event.event).toBe('retention.cleanup.completed');
    expect(event.blocked_by ?? {}).toEqual({});
    expect(event.athletes).toBe(1);
    expect(event.subject_research_requirements_deleted).toBe(3);
    expect(event.subject_research_submissions_deleted).toBe(3);

    for (const marker of ABOUT_A) {
      expect(await requirementCount(marker)).toBe(0);
    }
    expect(await allSubmissions()).toBe(5);
  });

  test('another child, the gym-wide row, a child inside retention, another gym and a near-miss id all stay, with their submissions', async () => {
    for (const marker of KEPT) {
      expect(await requirementCount(marker)).toBe(1);
      expect(await submissionCount(marker)).toBe(1);
    }
  });

  test('the data_purged audit row carries both counts and no athlete id', async () => {
    const audit = await db.query(
      `select details from pilot.audit_events where event_type = 'data_purged' order by created_at desc limit 1`,
    );
    expect(audit.rows[0].details).toMatchObject({
      athletes_deleted: 1,
      subject_research_requirements_deleted: 3,
      subject_research_submissions_deleted: 3,
    });
    expect(JSON.stringify(audit.rows[0].details)).not.toContain(ATHLETE_A);
  });

  test('an athlete whose purge is refused keeps their research rows, and the run counts none', async () => {
    const aboutD = await insertRequirement(ORG, 'SUBJ-COLUMN-D', ATHLETE_D, {});
    await insertSubmission(ORG, aboutD, SOURCE, ADMIN);
    // A video and no storage: the athlete's savepoint is rolled back
    // (STORAGE_CREDENTIAL_MISSING), the research delete with it.
    await db.query(
      `insert into pilot.video_sessions
         (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, blob_path,
          file_name, file_size_bytes, mime_type)
       values ('vid-sr-d', $1, $2, $3, 'clip', 'org-sr-1/vid-sr-d.mp4', 'clip.mp4', 5, 'video/mp4')`,
      [ORG, COACH, ATHLETE_D],
    );
    await db.query(
      `update pilot.athletes set deleted_at = now() - interval '3 years' where organization_id = $1 and athlete_id = $2`,
      [ORG, ATHLETE_D],
    );

    const event = await runCleanupScript({ PPBF_RETENTION_APPLY: 'true' });
    expect(event.blocked_by).toEqual({ STORAGE_CREDENTIAL_MISSING: 1 });
    expect(event.athletes).toBe(0);
    expect(event.subject_research_requirements_deleted).toBe(0);
    expect(event.subject_research_submissions_deleted).toBe(0);
    expect(await requirementCount('SUBJ-COLUMN-D')).toBe(1);
    expect(await submissionCount('SUBJ-COLUMN-D')).toBe(1);
  });
});
