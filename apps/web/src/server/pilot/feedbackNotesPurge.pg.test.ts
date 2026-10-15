// Real PostgreSQL proof that the retention purge (scripts/pilot-cleanup-
// deleted-data.mjs, run as its own process) de-identifies a purged person's
// own SHADOW feedback notes (#1600 gap B): in pilot.shadow_feedback,
// pilot.shadow_library_review_flags and the learning loop's research rows,
// their login becomes a per-person token of their own (never the chat
// audit's) and their typed words go; the rating, outcome and topic stay (Jason 2026-10-06, "delete any
// thing that personally Identifys the person but we keep data that [makes]
// the Ai and ML better"). Another person's and another gym's rows stay; an
// athlete whose purge is rolled back keeps theirs, uncounted.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-feedback-notes-purge-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const CLEANUP_SCRIPT = path.resolve(__dirname, '../../../scripts/pilot-cleanup-deleted-data.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_feedback_notes_purge';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-fb-1';
const OTHER_ORG = 'org-fb-2';
const ATHLETE_A = 'ath-fb-a'; // purged: deleted three years ago
const ATHLETE_B = 'ath-fb-b'; // live
const ATHLETE_D = 'ath-fb-d'; // past retention, but its purge is refused (a video, no storage)
const COACH = 'acct-fb-coach';
const OTHER_ADMIN = 'acct-fb-admin-2';

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

const NOTE_A = 'NOTE-A-7731 my coach yelled at me';
const NOTE_G = 'NOTE-G-4419 my son came home upset';
const NOTE_B = 'NOTE-B-2208 too many rounds';
const NOTE_X = 'NOTE-X-9001 other gym';
const NOTE_A_ELSEWHERE = 'NOTE-AE-3131 at the other gym';
const LOGIN_A = 'acct-fb-athlete-a';
const LOGIN_B = 'acct-fb-athlete-b';
const GUARDIAN = 'acct-fb-guardian';
const OTHER_GYM_LOGIN = 'acct-fb-other';

async function feedback(organizationId: string, accountId: string, role: string, comment: string) {
  await db.query(
    `insert into pilot.shadow_feedback (organization_id, account_id, role, helpful, rating, comment, outcome_signal)
     values ($1, $2, $3, false, 2, $4, 'negative')`,
    [organizationId, accountId, role, comment],
  );
}

async function reviewFlag(organizationId: string, accountId: string, topic: string, note: string) {
  await db.query(
    `insert into pilot.shadow_library_review_flags (organization_id, account_id, topic, session_type, outcome_signal, user_note)
     values ($1, $2, $3, 'chat', 'negative', $4)`,
    [organizationId, accountId, topic, note],
  );
}

/** A research row as processLearningSignal files it (shadowLearningLoop.ts). */
async function learningRow(organizationId: string, accountId: string, role: string, topic: string, note: string) {
  await db.query(
    `insert into pilot.shadow_research_requirements
       (organization_id, source_event_name, source_entity_type, source_entity_id, research_requirement,
        knowledge_gap, evidence_label, source_status, source_confidence_tier, source_verification_state,
        created_by_account_id, created_by_role, metadata)
     values ($1, 'shadow_learning_negative_outcome', 'shadow_learning_event', $2,
             'Strengthen SHADOW guidance for topic ''' || $3 || ''' after outcome ''negative''.',
             $4, 'Learning loop escalation (negative)', 'weak', 'LIMITED', 'unverified', $5, $6,
             jsonb_build_object('sessionType', 'chat', 'outcome', 'negative', 'topic', $3::text, 'note', $4::text))`,
    [organizationId, `msg-${accountId}-${topic}`, topic, note, accountId, role],
  );
}

const textAnywhere = async (needle: string) =>
  Number((await db.query(
    `select (select count(*) from pilot.shadow_feedback where comment like '%' || $1 || '%')
          + (select count(*) from pilot.shadow_library_review_flags where user_note like '%' || $1 || '%')
          + (select count(*) from pilot.shadow_research_requirements
              where knowledge_gap like '%' || $1 || '%' or metadata::text like '%' || $1 || '%') as n`,
    [needle],
  )).rows[0].n);

const loginAnywhere = async (accountId: string) =>
  Number((await db.query(
    `select (select count(*) from pilot.shadow_feedback where account_id = $1)
          + (select count(*) from pilot.shadow_library_review_flags where account_id = $1)
          + (select count(*) from pilot.shadow_research_requirements where created_by_account_id = $1) as n`,
    [accountId],
  )).rows[0].n);

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
  for (const [accountId, role, organizationId, athleteId] of [
    [COACH, 'coach', ORG, null],
    [LOGIN_A, 'athlete', ORG, ATHLETE_A],
    [LOGIN_B, 'athlete', ORG, ATHLETE_B],
    [GUARDIAN, 'parent', ORG, null],
    [OTHER_ADMIN, 'organization_admin', OTHER_ORG, null],
    [OTHER_GYM_LOGIN, 'athlete', OTHER_ORG, null],
  ]) {
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, auth_provider)
       values ($1, $2, $3, $4, 'microsoft')`,
      [accountId, role, organizationId, athleteId],
    );
  }
  await db.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
     values
       ($1, $2, 'Rosa Ortiz', '2012-04-03', 'youth-60', 'active', 'Guardian', false, $4, now(), now(), now() - interval '3 years'),
       ($1, $3, 'Sam Rivera', '2011-02-09', 'youth-65', 'active', 'Guardian', true, $4, now(), now(), null)`,
    [ORG, ATHLETE_A, ATHLETE_B, COACH],
  );
  // A guardian deleted three years ago: past the account window, nothing flagged.
  await db.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name, phone, email)
     values ($1, 'par-fb-g', $2, 'Gale Ortiz', '555-0100', 'g@example.test')`,
    [ORG, GUARDIAN],
  );
  await db.query(`update pilot.accounts set deleted_at = now() - interval '3 years' where account_id = $1`, [GUARDIAN]);

  await feedback(ORG, LOGIN_A, 'athlete', NOTE_A);
  await feedback(ORG, GUARDIAN, 'parent', NOTE_G);
  await feedback(ORG, LOGIN_B, 'athlete', NOTE_B);
  await feedback(OTHER_ORG, OTHER_GYM_LOGIN, 'athlete', NOTE_X);
  await reviewFlag(ORG, LOGIN_A, 'jab', NOTE_A);
  await reviewFlag(ORG, GUARDIAN, 'weight-cut', NOTE_G);
  await reviewFlag(ORG, LOGIN_B, 'hook', NOTE_B);
  await reviewFlag(OTHER_ORG, OTHER_GYM_LOGIN, 'jab', NOTE_X);
  await learningRow(ORG, LOGIN_A, 'athlete', 'jab', NOTE_A);
  await learningRow(ORG, GUARDIAN, 'parent', 'weight-cut', NOTE_G);
  await learningRow(ORG, LOGIN_B, 'athlete', 'hook', NOTE_B);
  await learningRow(OTHER_ORG, OTHER_GYM_LOGIN, 'athlete', 'jab', NOTE_X);
  // A's login is also active in the other gym: its feedback there is that
  // gym's, not this purge's.
  await feedback(OTHER_ORG, LOGIN_A, 'athlete', NOTE_A_ELSEWHERE);
  await reviewFlag(OTHER_ORG, LOGIN_A, 'uppercut', NOTE_A_ELSEWHERE);
  await learningRow(OTHER_ORG, LOGIN_A, 'athlete', 'uppercut', NOTE_A_ELSEWHERE);
  // A flag the library-change proposal re-pointed at B, still holding A's
  // note (shadowLearningLoop.ts queueLibraryEntryChangeForHumanReview, before
  // its fix): A's words go with A, the flag keeps naming B.
  await reviewFlag(ORG, LOGIN_B, 'body-shot', NOTE_A);
  // A research row A's login filed that is not the learning loop's: untouched.
  await db.query(
    `insert into pilot.shadow_research_requirements
       (organization_id, source_event_name, source_entity_type, source_entity_id, research_requirement,
        knowledge_gap, source_status, source_confidence_tier, source_verification_state,
        created_by_account_id, created_by_role)
     values ($1, 'manual', 'manual', 'manual-a', 'MANUAL-ROW', 'NOTE-MANUAL-6060', 'weak', 'LIMITED', 'unverified', $2, 'athlete')`,
    [ORG, LOGIN_A],
  );
  // A learning row from before metadata carried a topic: the loop's sentence
  // for no note falls back to 'general', as the loop's own does.
  await db.query(
    `insert into pilot.shadow_research_requirements
       (organization_id, source_event_name, source_entity_type, source_entity_id, research_requirement,
        knowledge_gap, source_status, source_confidence_tier, source_verification_state,
        created_by_account_id, created_by_role, metadata)
     values ($1, 'shadow_learning_negative_outcome', 'shadow_learning_event', 'legacy-a', 'LEGACY-ROW',
             'NOTE-LEGACY-7070', 'weak', 'LIMITED', 'unverified', $2, 'athlete',
             jsonb_build_object('note', 'NOTE-LEGACY-7070'))`,
    [ORG, LOGIN_A],
  );
  // A turn of A's and of the guardian's in the chat log, so the tokens the chat
  // audit gives them can be compared with the ones on their feedback.
  await db.query(
    `insert into pilot.shadow_chat_audit (organization_id, user_id, user_role, athlete_id, user_message, shadow_response)
     values ($1, $2, 'athlete', $3, 'how do I slip a jab', 'Move your head off the line.'),
            ($1, $4, 'parent', null, 'when is practice', 'Tuesdays at six.')`,
    [ORG, LOGIN_A, ATHLETE_A, GUARDIAN],
  );
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

describe("the retention purge and a purged person's own feedback notes", () => {
  test('a dry run counts what it would de-identify and changes nothing', async () => {
    const dry = await runCleanupScript({ PPBF_RETENTION_APPLY: 'false' });
    expect(dry.event).toBe('retention.cleanup.dry-run');
    expect(dry.blocked_by ?? {}).toEqual({});
    expect(dry.would_deidentify_shadow_feedback).toBe(2);
    expect(dry.would_clear_shadow_review_flag_notes).toBe(3);
    expect(dry.would_deidentify_shadow_learning_research_rows).toBe(3);
    expect(await textAnywhere(NOTE_A)).toBe(4);
    for (const note of [NOTE_G, NOTE_B, NOTE_X]) expect(await textAnywhere(note)).toBe(3);
    expect(await loginAnywhere(LOGIN_A)).toBe(8);
  });

  test("the purge empties the athlete's and the guardian's notes and drops their logins", async () => {
    const event = await runCleanupScript({ PPBF_RETENTION_APPLY: 'true' });
    expect(event.event).toBe('retention.cleanup.completed');
    expect(event.blocked_by ?? {}).toEqual({});
    expect(event.athletes).toBe(1);
    expect(event.accounts).toBe(1);
    expect(event.shadow_feedback_deidentified).toBe(2);
    expect(event.shadow_review_flag_notes_cleared).toBe(3);
    expect(event.shadow_learning_research_rows_deidentified).toBe(3);
    for (const note of [NOTE_A, NOTE_G, 'NOTE-LEGACY-7070']) expect(await textAnywhere(note)).toBe(0);
    expect(await loginAnywhere(GUARDIAN)).toBe(0);
    // Only A's row that is not the learning loop's, and A's three rows in the
    // other gym, keep A's login.
    expect(await loginAnywhere(LOGIN_A)).toBe(4);
    const manual = await db.query(
      `select created_by_account_id, knowledge_gap from pilot.shadow_research_requirements where source_entity_id = 'manual-a'`,
    );
    expect(manual.rows).toEqual([{ created_by_account_id: LOGIN_A, knowledge_gap: 'NOTE-MANUAL-6060' }]);
  });

  test("a flag re-pointed at another account loses the purged person's note and keeps naming that account", async () => {
    const flag = await db.query(
      `select account_id, user_note from pilot.shadow_library_review_flags where organization_id = $1 and topic = 'body-shot'`,
      [ORG],
    );
    expect(flag.rows).toEqual([{ account_id: LOGIN_B, user_note: null }]);
  });

  test("a legacy learning row with no topic gets the loop's 'general' sentence", async () => {
    const legacy = await db.query(
      `select knowledge_gap, metadata from pilot.shadow_research_requirements where source_entity_id = 'legacy-a'`,
    );
    expect(legacy.rows).toEqual([{
      knowledge_gap: "Recent response on 'general' was judged insufficient and requires evidence reinforcement.",
      metadata: {},
    }]);
  });

  test("the signal stays: rating, outcome, topic and counts, under each person's own token, never the chat audit's", async () => {
    const audit = await db.query(
      `select user_role, user_id from pilot.shadow_chat_audit where organization_id = $1 order by user_role`,
      [ORG],
    );
    const chatTokens = audit.rows.map((row) => row.user_id as string);
    expect(chatTokens).toHaveLength(2);
    for (const token of chatTokens) expect(token).toMatch(/^anon_/);

    const rows = await db.query(
      `select account_id, helpful, rating, outcome_signal, comment from pilot.shadow_feedback
        where organization_id = $1 and role in ('athlete', 'parent') and account_id like 'anon_%' order by role`,
      [ORG],
    );
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(row).toMatchObject({ helpful: false, rating: 2, outcome_signal: 'negative', comment: null });
    }
    const feedbackTokens = rows.rows.map((row) => row.account_id as string);
    for (const token of feedbackTokens) expect(token).toMatch(/^anon_/);
    // One token per person, and never the one the chat audit gave them (F-088:
    // a retired login's untouched rows join feedback back to the login).
    expect(new Set(feedbackTokens).size).toBe(2);
    for (const token of feedbackTokens) expect(chatTokens).not.toContain(token);
    const tokenA = (await db.query(
      `select account_id from pilot.shadow_feedback where organization_id = $1 and role = 'athlete' and account_id like 'anon_%'`,
      [ORG],
    )).rows[0].account_id as string;

    const learning = await db.query(
      `select created_by_account_id, knowledge_gap, metadata from pilot.shadow_research_requirements
        where organization_id = $1 and metadata->>'topic' = 'jab'`,
      [ORG],
    );
    expect(learning.rows).toEqual([{
      created_by_account_id: tokenA,
      knowledge_gap: "Recent response on 'jab' was judged insufficient and requires evidence reinforcement.",
      metadata: { sessionType: 'chat', outcome: 'negative', topic: 'jab' },
    }]);

    const flags = await db.query(
      `select topic, account_id, user_note, flag_count, outcome_signal from pilot.shadow_library_review_flags
        where organization_id = $1 and topic in ('jab', 'weight-cut') order by topic`,
      [ORG],
    );
    expect(flags.rows).toEqual([
      { topic: 'jab', account_id: null, user_note: null, flag_count: 1, outcome_signal: 'negative' },
      { topic: 'weight-cut', account_id: null, user_note: null, flag_count: 1, outcome_signal: 'negative' },
    ]);
  });

  test("the same login's feedback in another gym is that gym's, and untouched", async () => {
    expect(await textAnywhere(NOTE_A_ELSEWHERE)).toBe(3);
    const elsewhere = await db.query(
      `select (select count(*) from pilot.shadow_feedback where organization_id = $1 and account_id = $2)
            + (select count(*) from pilot.shadow_library_review_flags where organization_id = $1 and account_id = $2)
            + (select count(*) from pilot.shadow_research_requirements where organization_id = $1 and created_by_account_id = $2) as n`,
      [OTHER_ORG, LOGIN_A],
    );
    expect(Number(elsewhere.rows[0].n)).toBe(3);
  });

  test("another person's and another gym's notes are untouched", async () => {
    for (const note of [NOTE_B, NOTE_X]) expect(await textAnywhere(note)).toBe(3);
    expect(await loginAnywhere(LOGIN_B)).toBe(4);
    expect(await loginAnywhere(OTHER_GYM_LOGIN)).toBe(3);
  });

  test('the data_purged audit row carries the counts and no login or note', async () => {
    const audit = await db.query(
      `select details from pilot.audit_events where event_type = 'data_purged' order by created_at desc limit 1`,
    );
    expect(audit.rows[0].details).toMatchObject({
      shadow_feedback_deidentified: 2,
      shadow_review_flag_notes_cleared: 3,
      shadow_learning_research_rows_deidentified: 3,
    });
    const text = JSON.stringify(audit.rows[0].details);
    for (const secret of [LOGIN_A, GUARDIAN, 'NOTE-']) expect(text).not.toContain(secret);
  });

  test('an athlete whose purge is refused keeps their notes, and the run counts none', async () => {
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, auth_provider)
       values ('acct-fb-athlete-d', 'athlete', $1, $2, 'microsoft')`,
      [ORG, ATHLETE_D],
    );
    await db.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
       values ($1, $2, 'Lee Moss', '2012-09-09', 'youth-55', 'active', 'Guardian', false, $3, now(), now(), now() - interval '3 years')`,
      [ORG, ATHLETE_D, COACH],
    );
    await feedback(ORG, 'acct-fb-athlete-d', 'athlete', 'NOTE-D-5150');
    // A video and no storage: the athlete's savepoint is rolled back.
    await db.query(
      `insert into pilot.video_sessions
         (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, blob_path,
          file_name, file_size_bytes, mime_type)
       values ('vid-fb-d', $1, $2, $3, 'clip', 'org-fb-1/vid-fb-d.mp4', 'clip.mp4', 5, 'video/mp4')`,
      [ORG, COACH, ATHLETE_D],
    );

    const event = await runCleanupScript({ PPBF_RETENTION_APPLY: 'true' });
    expect(event.blocked_by).toEqual({ STORAGE_CREDENTIAL_MISSING: 1 });
    expect(event.shadow_feedback_deidentified).toBe(0);
    expect(await textAnywhere('NOTE-D-5150')).toBe(1);
    expect(await loginAnywhere('acct-fb-athlete-d')).toBe(1);
  });
});
