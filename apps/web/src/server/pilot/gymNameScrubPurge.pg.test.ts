// Real PostgreSQL proof that the retention purge (scripts/pilot-cleanup-
// deleted-data.mjs, run as its own process) takes a purged person's names out
// of every OTHER kept AI chat note in their gym (F-090). Jason 2026-10-07,
// OD-2026-10-06-027 ruling 1 ("Gym-wide (Recommended)"): "their name is
// removed from every kept AI chat note in the gym, not only the notes filed
// under them"; Overwatch 2026-10-16: that reaches (a) other people's SHADOW
// chats, (b) notes typed against a SHADOW answer (feedback comments, Library
// review-flag notes, the research rows the learning loop and the question
// filer write) and (c) safeguarding review summaries. A live child's name, and
// another gym's notes, stay.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-gym-name-scrub-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const CLEANUP_SCRIPT = path.resolve(__dirname, '../../../scripts/pilot-cleanup-deleted-data.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_gym_name_scrub';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-gn-1';
const OTHER_ORG = 'org-gn-2';
const ATHLETE_A = 'ath-gn-a'; // purged: Rosa Ortiz, deleted three years ago
const ATHLETE_B = 'ath-gn-b'; // live: Sam Rivera
const COACH = 'acct-gn-coach';
const LOGIN_A = 'acct-gn-athlete-a';
const LOGIN_B = 'acct-gn-athlete-b';
const GUARDIAN = 'acct-gn-guardian'; // purged: Maria de la Cruz, deleted 13 months ago, nothing flagged
const PARENT_B = 'acct-gn-parent-b'; // live: Sam's parent
const OTHER_COACH = 'acct-gn-coach-2';

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

/** Every kept note in one gym, as one text per table, for reading names out of. */
async function notesIn(organizationId: string): Promise<Record<string, string[]>> {
  const read = async (sql: string) => (await db.query<{ t: string }>(sql, [organizationId])).rows.map((row) => row.t).sort();
  return {
    messages: await read(`select content as t from pilot.shadow_chat_messages where organization_id = $1`),
    titles: await read(`select title as t from pilot.shadow_chat_sessions where organization_id = $1`),
    feedback: await read(`select comment as t from pilot.shadow_feedback where organization_id = $1 and comment is not null`),
    flags: await read(`select user_note as t from pilot.shadow_library_review_flags where organization_id = $1 and user_note is not null`),
    research: await read(
      `select concat_ws(' | ', research_requirement, knowledge_gap, metadata->>'note', metadata->>'question',
                        metadata->>'closing_note') as t
         from pilot.shadow_research_requirements where organization_id = $1`,
    ),
    keys: await read(
      `select source_entity_id as t from pilot.shadow_research_requirements
        where organization_id = $1 and source_entity_type = 'shadow_question'`,
    ),
    reviews: await read(`select summary as t from pilot.shadow_human_review_queue where organization_id = $1`),
  };
}

/** Another person's notes in a gym that name Rosa (the purged child), Maria de la Cruz (the purged guardian) and Sam (live). */
async function seedNotes(organizationId: string, staff: string, parent: string | null, samAthleteId: string) {
  const conversation = (await db.query<{ id: string }>('select gen_random_uuid()::text as id')).rows[0].id;
  await db.query(
    `insert into pilot.shadow_chat_sessions (conversation_id, organization_id, account_id, title)
     values ($1, $2, $3, 'Pair Rosa with Sam')`,
    [conversation, organizationId, staff],
  );
  await db.query(
    `insert into pilot.shadow_chat_messages (message_id, conversation_id, organization_id, account_id, role, content, created_at)
     values (gen_random_uuid(), $1, $2, $3, 'user', 'Should Rosa spar Sam?', now() - interval '3 minutes'),
            (gen_random_uuid(), $1, $2, $3, 'assistant', 'Rosa Ortiz and Sam can drill together.', now() - interval '2 minutes'),
            (gen_random_uuid(), $1, $2, $3, 'user', 'Talked to Maria de la Cruz today about a lot of drills, de facto the plan.', now() - interval '1 minute')`,
    [conversation, organizationId, staff],
  );
  await db.query(
    `insert into pilot.shadow_feedback (organization_id, account_id, role, helpful, comment, outcome_signal)
     values ($1, $2, 'coach', false, 'Rosa needs a simpler answer', 'thumbs_down')`,
    [organizationId, staff],
  );
  await db.query(
    `insert into pilot.shadow_library_review_flags (organization_id, account_id, topic, session_type, outcome_signal, user_note)
     values ($1, $2, 'sparring', 'chat', 'negative', 'Rosa Ortiz was given the wrong round count')`,
    [organizationId, staff],
  );
  await db.query(
    `insert into pilot.shadow_research_requirements
       (organization_id, source_event_name, source_entity_type, source_entity_id, research_requirement,
        knowledge_gap, evidence_label, source_status, source_confidence_tier, source_verification_state,
        created_by_account_id, created_by_role, metadata)
     values ($1, 'shadow_learning_negative_outcome', 'shadow_learning_event', 'loop-' || $1,
             'Strengthen SHADOW guidance for topic ''sparring'' after outcome ''negative''.',
             'Rosa asked about cutting weight', 'Learning loop escalation (negative)', 'weak', 'LIMITED', 'unverified',
             $2, 'coach', jsonb_build_object('topic', 'sparring', 'note', 'Rosa asked about cutting weight'))`,
    [organizationId, staff],
  );
  if (parent) {
    // A live parent's unanswered question about their own child that names the purged one.
    await db.query(
      `insert into pilot.shadow_research_requirements
         (organization_id, source_event_name, source_entity_type, source_entity_id, research_requirement,
          knowledge_gap, source_status, source_confidence_tier, source_verification_state,
          created_by_account_id, created_by_role, metadata)
       values ($1, 'shadow_unanswered_question', 'shadow_asker_question', 'acct:' || $2 || ':q1',
               'Can my son Sam keep training with Rosa?', 'No verified Library evidence matched this question in SHADOW.',
               'weak', 'LIMITED', 'unverified', $2, 'parent', jsonb_build_object('asker_athlete_id', $3::text))`,
      [organizationId, parent, samAthleteId],
    );
  }
  await db.query(
    `insert into pilot.shadow_human_review_queue (review_id, organization_id, conversation_id, account_id, category, severity, summary)
     values (gen_random_uuid(), $1, $2, $3, 'safeguarding', 'moderate', 'Coach note: Rosa seemed upset after Sam''s session')`,
    [organizationId, conversation, staff],
  );
}

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
    [PARENT_B, 'parent', ORG, null],
    [OTHER_COACH, 'coach', OTHER_ORG, null],
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
  await db.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name, phone, email)
     values ($1, 'par-gn-g', $2, 'Maria de la Cruz', '555-0100', 'g@example.test')`,
    [ORG, GUARDIAN],
  );
  await db.query(`update pilot.accounts set deleted_at = now() - interval '13 months' where account_id = $1`, [GUARDIAN]);

  await seedNotes(ORG, COACH, PARENT_B, ATHLETE_B);
  // A's login email: its local part is a name, its domain is not.
  await db.query(`update pilot.accounts set login_email = 'rosa.ortiz@comcast.net' where account_id = $1`, [LOGIN_A]);
  // A living guardian linked to A: their name is theirs, and stays in the gym's notes.
  await db.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name, phone, email)
     values ($1, 'par-gn-lena', null, 'Lena Moss', '555-0101', 'lena@example.test')`,
    [ORG],
  );
  await db.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, 'par-gn-lena', $2, 'parent')`,
    [ORG, ATHLETE_A],
  );
  const coachConversation = (await db.query<{ id: string }>(
    `select conversation_id::text as id from pilot.shadow_chat_sessions where organization_id = $1 and account_id = $2`,
    [ORG, COACH],
  )).rows[0].id;
  await db.query(
    `insert into pilot.shadow_chat_messages (message_id, conversation_id, organization_id, account_id, role, content)
     values (gen_random_uuid(), $1, $2, $3, 'user', 'Lena called; comcast.net is down, net weight is 60.')`,
    [coachConversation, ORG, COACH],
  );
  // A staff question filed as research: its key is its own lower-cased text (researchQuestionKey).
  await db.query(
    `insert into pilot.shadow_research_requirements
       (organization_id, source_event_name, source_entity_type, source_entity_id, research_requirement,
        knowledge_gap, source_status, source_confidence_tier, source_verification_state,
        created_by_account_id, created_by_role)
     values ($1, 'shadow_unanswered_question', 'shadow_question', 'how should rosa cut weight?',
             'How should Rosa cut weight?', 'No verified Library evidence matched this question in SHADOW.',
             'weak', 'LIMITED', 'unverified', $2, 'coach')`,
    [ORG, COACH],
  );
  // A Library question (shadowLibrary.ts): the words in knowledge_gap and metadata.question; a staff closing note.
  await db.query(
    `insert into pilot.shadow_research_requirements
       (organization_id, source_event_name, source_entity_type, source_entity_id, research_requirement,
        knowledge_gap, source_status, source_confidence_tier, source_verification_state,
        created_by_account_id, created_by_role, metadata)
     values ($1, 'shadow_library_question', 'shadow_library_claim', 'claim-gn-1', 'Find evidence for this claim.',
             'Is Rosa ready to spar?', 'weak', 'LIMITED', 'unverified', $2, 'coach',
             jsonb_build_object('question', 'Is Rosa ready to spar?', 'closing_note', 'Closed: Rosa moved away'))`,
    [ORG, COACH],
  );
  // A's own question to SHADOW: it goes with A (F-054), so it is deleted, not scrubbed or counted.
  await db.query(
    `insert into pilot.shadow_research_requirements
       (organization_id, source_event_name, source_entity_type, source_entity_id, research_requirement,
        knowledge_gap, source_status, source_confidence_tier, source_verification_state,
        created_by_account_id, created_by_role, metadata)
     values ($1, 'shadow_unanswered_question', 'shadow_asker_question', 'acct:' || $2 || ':a1',
             'Will Rosa be allowed to compete?', 'No verified Library evidence matched this question in SHADOW.',
             'weak', 'LIMITED', 'unverified', $2, 'athlete', jsonb_build_object('asker_athlete_id', $3::text))`,
    [ORG, LOGIN_A, ATHLETE_A],
  );
  await seedNotes(OTHER_ORG, OTHER_COACH, null, 'ath-elsewhere');
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

// Rows changed, summed over the two purged people: the coach's chat holds two
// messages naming Rosa (the child's purge) and one naming Maria de la Cruz (the guardian's; its "of" stays),
// its title names Rosa; one feedback comment, one flag note, one review summary;
// four research rows (the learning loop's, the live parent's question, a
// staff question and a Library question). A's own question is deleted, not
// counted; the message naming a living guardian and an email domain is not
// changed, not counted.
const EXPECTED = { messages: 3, titles: 1, feedback: 1, flags: 1, research: 4, reviews: 1 };

describe("the retention purge and other people's notes that name a purged person", () => {
  test('a dry run counts what it would scrub and changes nothing', async () => {
    const before = await notesIn(ORG);
    const dry = await runCleanupScript({ PPBF_RETENTION_APPLY: 'false' });
    expect(dry.event).toBe('retention.cleanup.dry-run');
    expect(dry.blocked_by ?? {}).toEqual({});
    expect(dry).toMatchObject({
      would_scrub_shadow_chat_messages_names: EXPECTED.messages,
      would_scrub_shadow_chat_titles_names: EXPECTED.titles,
      would_scrub_shadow_feedback_comments_names: EXPECTED.feedback,
      would_scrub_shadow_review_flag_notes_names: EXPECTED.flags,
      would_scrub_shadow_research_rows_names: EXPECTED.research,
      would_scrub_shadow_review_summaries_names: EXPECTED.reviews,
    });
    expect(await notesIn(ORG)).toEqual(before);
  });

  test("after the purge no kept note in the gym names the purged child or guardian; the live child's name stays", async () => {
    const event = await runCleanupScript({ PPBF_RETENTION_APPLY: 'true' });
    expect(event.event).toBe('retention.cleanup.completed');
    expect(event.blocked_by ?? {}).toEqual({});
    expect(event.athletes).toBe(1);
    expect(event.accounts).toBe(1);
    expect(event).toMatchObject({
      shadow_chat_messages_names_scrubbed: EXPECTED.messages,
      shadow_chat_titles_names_scrubbed: EXPECTED.titles,
      shadow_feedback_comments_names_scrubbed: EXPECTED.feedback,
      shadow_review_flag_notes_names_scrubbed: EXPECTED.flags,
      shadow_research_rows_names_scrubbed: EXPECTED.research,
      shadow_review_summaries_names_scrubbed: EXPECTED.reviews,
    });
    const after = await notesIn(ORG);
    const keys = after.keys;
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^purged-\d+$/);
    expect({ ...after, keys: [] }).toEqual({
      keys: [],
      messages: [
        'Should [name] spar Sam?',
        'Talked to [name] today about a lot of drills, de facto the plan.',
        '[name] and Sam can drill together.',
        'Lena called; comcast.net is down, net weight is 60.',
      ].sort(),
      titles: ['Pair [name] with Sam'],
      feedback: ['[name] needs a simpler answer'],
      flags: ['[name] was given the wrong round count'],
      research: [
        'Can my son Sam keep training with [name]? | No verified Library evidence matched this question in SHADOW.',
        "Strengthen SHADOW guidance for topic 'sparring' after outcome 'negative'. | [name] asked about cutting weight | [name] asked about cutting weight",
        'How should [name] cut weight? | No verified Library evidence matched this question in SHADOW.',
        'Find evidence for this claim. | Is [name] ready to spar? | Is [name] ready to spar? | Closed: [name] moved away',
      ].sort(),
      reviews: ["Coach note: [name] seemed upset after Sam's session"],
    });
  });

  test("the notes keep their authors: the scrub changes text, never whose note it is", async () => {
    const authors = await db.query(
      `select (select count(*) from pilot.shadow_chat_messages where organization_id = $1 and account_id = $2)
            + (select count(*) from pilot.shadow_chat_sessions where organization_id = $1 and account_id = $2)
            + (select count(*) from pilot.shadow_feedback where organization_id = $1 and account_id = $2)
            + (select count(*) from pilot.shadow_library_review_flags where organization_id = $1 and account_id = $2)
            + (select count(*) from pilot.shadow_human_review_queue where organization_id = $1 and account_id = $2) as n`,
      [ORG, COACH],
    );
    expect(Number(authors.rows[0].n)).toBe(8);
    const question = await db.query(
      `select created_by_account_id, metadata->>'asker_athlete_id' as asker from pilot.shadow_research_requirements
        where organization_id = $1 and source_entity_type = 'shadow_asker_question'`,
      [ORG],
    );
    expect(question.rows).toEqual([{ created_by_account_id: PARENT_B, asker: ATHLETE_B }]);
  });

  test("another gym's notes naming the same first names are untouched", async () => {
    const elsewhere = await notesIn(OTHER_ORG);
    expect(elsewhere.titles).toEqual(['Pair Rosa with Sam']);
    expect(elsewhere.messages).toContain('Rosa Ortiz and Sam can drill together.');
    expect(elsewhere.messages).toContain('Talked to Maria de la Cruz today about a lot of drills, de facto the plan.');
    expect(elsewhere.feedback).toEqual(['Rosa needs a simpler answer']);
    expect(elsewhere.flags).toEqual(['Rosa Ortiz was given the wrong round count']);
    expect(elsewhere.reviews).toEqual(["Coach note: Rosa seemed upset after Sam's session"]);
  });

  test('the data_purged audit row carries the counts and no name', async () => {
    const audit = await db.query(
      `select details from pilot.audit_events where event_type = 'data_purged' order by created_at desc limit 1`,
    );
    expect(audit.rows[0].details).toMatchObject({
      shadow_chat_messages_names_scrubbed: EXPECTED.messages,
      shadow_research_rows_names_scrubbed: EXPECTED.research,
    });
    const text = JSON.stringify(audit.rows[0].details);
    for (const secret of ['Rosa', 'Ortiz', 'Maria', 'Cruz']) expect(text).not.toContain(secret);
  });
});
