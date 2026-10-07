/**
 * The shadow-deidentify-keys migration, driven through its real runner on a
 * real PostgreSQL built the way production is built (base schema plus every
 * migration before it, in deploy order).
 *
 * What it proves: the account and athlete keys the purge's token update
 * would trip over are gone from the de-identified tables; the six composite
 * evidence keys are deferrable, so one transaction can re-key every table and
 * commit; the stamp and deadline columns and the stamp checks exist; a second
 * run changes nothing; the readiness query is honest with pilot on the
 * search_path; and -- the ordering guarantee -- with the migration applied
 * and NO de-identifying code anywhere, the purge as deployed today (a plain
 * delete of the account or the athlete, which is all either purge path does
 * for these tables) still leaves zero rows that name the person, exactly as
 * the dropped cascades did; a purge that re-keys the rows to tokens first
 * keeps them (a tokened row no longer names anyone), a row held for Q7
 * (subject_deleted_at set) is spared with the messages and evidence under
 * it, and a table the purge forgot fails safe (deleted, never kept with the
 * name on it). Owner rulings: Jason 2026-10-06 (de-identify, keep ML data),
 * Q5, 2026-10-07 Q7.
 *
 * Spins up the same disposable, local-only embedded Postgres the other
 * migration suites use. It NEVER connects to production or staging.
 */

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
const PG_DATABASE = 'ppbf_test_shadow_deidentify_keys';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-shadow-deidentify-keys-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-shadow-deidentify-keys-migration.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_shadow_deidentify_keys_migration.sql';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

type Runner = {
  READINESS_QUERY: string;
  READY: Readiness;
  applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
};

const ORG = 'org-deid-keys';
const COACH = 'acct-deid-keys-coach';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let runner: Runner;
let migrationSql: string;
let laterMigrations: string[];
let dataDeletion: typeof import('./dataDeletion');
let closePool: (() => Promise<void>) | undefined;

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

interface Readiness {
  account_keys_left: number;
  athlete_keys_left: number;
  deferrable_keys: number;
  purge_columns: number;
  stamp_checks: number;
  cascade_triggers: number;
}

async function readiness(): Promise<Readiness> {
  return (await client.query<Readiness>(runner.READINESS_QUERY)).rows[0];
}

/** Every foreign key on a table, as Postgres prints it. */
async function foreignKeysOf(table: string): Promise<string[]> {
  const rows = await client.query<{ def: string }>(
    `select pg_get_constraintdef(oid) as def from pg_constraint
      where contype = 'f' and conrelid = to_regclass($1) order by 1`,
    [`pilot.${table}`],
  );
  return rows.rows.map((row) => row.def);
}

interface Person {
  athleteId: string;
  athleteLogin: string;
  guardian: string;
  conversationId: string;
  messageId: string;
  bundleId: string;
  guardianConversationId: string;
  decisionId: string;
}

let seq = 0;

/**
 * One child and one guardian, with a row in every table whose cascade the
 * migration drops, keyed to them the way the app keys them: the guardian's
 * own conversation, message, evidence bundle, learning event, effectiveness
 * row, review-queue entry and deletion request (the seven account keys); the
 * child's conversation (with a message and an evidence bundle about them),
 * a coach's decision with its outcome, a recommendation and a film-study
 * proposal (the five athlete keys).
 */
async function seedPerson(options: { deleted?: boolean } = {}): Promise<Person> {
  seq += 1;
  const athleteId = `ath-deid-keys-${seq}`;
  const athleteLogin = `acct-deid-keys-athlete-${seq}`;
  const guardian = `acct-deid-keys-guardian-${seq}`;
  const parentId = `par-deid-keys-${seq}`;
  const deletedAthlete = options.deleted ? "now() - interval '3 years'" : 'null';
  const deletedGuardian = options.deleted ? "now() - interval '18 months'" : 'null';
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
     values ($1, $2, 'Keys Athlete', '2013-05-06', 'fly', 'active', 'contact', true, $3, now(), now(), ${deletedAthlete})`,
    [ORG, athleteId, COACH],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, athlete_id, auth_provider, active_flag, deleted_at)
     values ($1, 'athlete', $2, $3, 'ppbf_local', ${deletedAthlete} is null, ${deletedAthlete})`,
    [athleteLogin, ORG, athleteId],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag, deleted_at, login_email)
     values ($1, 'parent', $2, 'ppbf_local', ${deletedGuardian} is null, ${deletedGuardian}, $3)`,
    [guardian, ORG, `${guardian}@example.test`],
  );
  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name, phone, email, created_at, updated_at)
     values ($1, $2, $3, 'Keys Guardian', '555-0100', $4, now(), now())`,
    [ORG, parentId, guardian, `${guardian}@example.test`],
  );
  await client.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete) values ($1, $2, $3, 'parent')`,
    [ORG, parentId, athleteId],
  );

  const conversationId = (await client.query<{ id: string }>('select gen_random_uuid()::text as id')).rows[0].id;
  const guardianConversationId = (await client.query<{ id: string }>('select gen_random_uuid()::text as id')).rows[0].id;
  const messageId = (await client.query<{ id: string }>('select gen_random_uuid()::text as id')).rows[0].id;
  const bundleId = (await client.query<{ id: string }>('select gen_random_uuid()::text as id')).rows[0].id;
  const evidenceId = (await client.query<{ id: string }>('select gen_random_uuid()::text as id')).rows[0].id;

  // The child's conversation, with the evidence SHADOW cited in it.
  await client.query(
    `insert into pilot.shadow_chat_sessions (conversation_id, organization_id, account_id, athlete_id) values ($1, $2, $3, $4)`,
    [conversationId, ORG, athleteLogin, athleteId],
  );
  await client.query(
    `insert into pilot.shadow_chat_messages (message_id, conversation_id, organization_id, account_id, role, content) values ($1, $2, $3, $4, 'assistant', 'reply')`,
    [messageId, conversationId, ORG, athleteLogin],
  );
  await client.query(
    `insert into pilot.shadow_evidence_bundles (bundle_id, organization_id, account_id, subject_id, query_sha256, availability, item_count)
     values ($1, $2, $3, $4, repeat('a', 64), 'available', 1)`,
    [bundleId, ORG, athleteLogin, athleteId],
  );
  await client.query(
    `insert into pilot.shadow_evidence_items (evidence_id, bundle_id, organization_id, account_id, source_id, document_id, chunk_id, ordinal, excerpt_sha256, library_organization_id)
     values ($1, $2, $3, $4, 'src-keys', 'doc-keys', 'chunk-keys', 1, repeat('b', 64), $3)`,
    [evidenceId, bundleId, ORG, athleteLogin],
  );
  await client.query(
    `insert into pilot.shadow_evidence_claims (claim_id, organization_id, account_id, conversation_id, assistant_message_id, bundle_id, claim_status)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, 'supported')`,
    [ORG, athleteLogin, conversationId, messageId, bundleId],
  );
  await client.query(
    `insert into pilot.shadow_message_citations (assistant_message_id, evidence_id, bundle_id, organization_id, account_id, ordinal) values ($1, $2, $3, $4, $5, 1)`,
    [messageId, evidenceId, bundleId, ORG, athleteLogin],
  );
  // The coach's records about the child.
  const decision = await client.query<{ decision_id: string }>(
    `insert into pilot.shadow_decisions (organization_id, athlete_id, decision_text, expected_outcome, decided_by_account_id, decided_by_role)
     values ($1, $2, 'rest the lead hand', 'pain gone in a week', $3, 'coach') returning decision_id`,
    [ORG, athleteId, COACH],
  );
  await client.query(
    `insert into pilot.shadow_decision_outcomes (organization_id, decision_id, match_state, evaluated_by_account_id) values ($1, $2, 'match', $3)`,
    [ORG, decision.rows[0].decision_id, COACH],
  );
  await client.query(
    `insert into pilot.shadow_recommendations (organization_id, athlete_id, recommendation_text, expected_outcome, created_by_account_id, expires_at)
     values ($1, $2, 'more footwork', 'balance', $3, now() + interval '30 days')`,
    [ORG, athleteId, COACH],
  );
  await client.query(
    `insert into pilot.shadow_film_study_proposals (proposal_id, organization_id, athlete_id, video_session_id, observation_text, evidence_id, model_deployment, frames_analyzed, origin)
     values (gen_random_uuid(), $1, $2, 'vs-keys', 'drops the right hand', 'ev-keys', 'test', 3, 'model_proposed')`,
    [ORG, athleteId],
  );
  // The guardian's own SHADOW rows.
  await client.query(
    `insert into pilot.shadow_chat_sessions (conversation_id, organization_id, account_id) values ($1, $2, $3)`,
    [guardianConversationId, ORG, guardian],
  );
  await client.query(
    `insert into pilot.shadow_chat_messages (message_id, conversation_id, organization_id, account_id, role, content) values (gen_random_uuid(), $1, $2, $3, 'user', 'is my son safe to spar')`,
    [guardianConversationId, ORG, guardian],
  );
  await client.query(
    `insert into pilot.shadow_evidence_bundles (bundle_id, organization_id, account_id, query_sha256, availability, item_count)
     values (gen_random_uuid(), $1, $2, repeat('c', 64), 'unavailable', 0)`,
    [ORG, guardian],
  );
  const feedback = await client.query<{ feedback_id: string }>(
    `insert into pilot.shadow_feedback (organization_id, account_id, role, helpful) values ($1, $2, 'parent', true) returning feedback_id`,
    [ORG, guardian],
  );
  await client.query(
    `insert into pilot.shadow_learning_events (organization_id, account_id, role, feedback_id, message_id, outcome_signal)
     values ($1, $2, 'parent', $3, 'msg-keys', 'helpful')`,
    [ORG, guardian, feedback.rows[0].feedback_id],
  );
  await client.query(
    `insert into pilot.shadow_recommendation_effectiveness (organization_id, account_id, recommendation_type, outcome) values ($1, $2, 'rest', 'improved')`,
    [ORG, guardian],
  );
  await client.query(
    `insert into pilot.shadow_human_review_queue (review_id, organization_id, conversation_id, account_id, category, severity, summary)
     values (gen_random_uuid(), $1, $2, $3, 'safeguarding', 'high', 'a parent asked about bruising')`,
    [ORG, guardianConversationId, guardian],
  );
  await client.query(
    `insert into pilot.shadow_data_deletion_requests (request_id, organization_id, account_id) values (gen_random_uuid(), $1, $2)`,
    [ORG, guardian],
  );
  return {
    athleteId,
    athleteLogin,
    guardian,
    conversationId,
    messageId,
    bundleId,
    guardianConversationId,
    decisionId: decision.rows[0].decision_id,
  };
}

interface IdentifiedRows {
  byAccount: number;
  byAthlete: number;
}

/**
 * Rows still carrying the person's keys, across every table whose cascade
 * the migration drops plus the rows that cascade from those (messages from a
 * session, outcomes from a decision, items/claims/citations from a bundle or
 * message). A purge that leaves any of these behind has kept identified data.
 */
async function identifiedRows(person: Pick<Person, 'guardian' | 'athleteId'>): Promise<IdentifiedRows> {
  const row = (await client.query<{ by_account: string; by_athlete: string }>(
    `select
       (select count(*) from pilot.shadow_chat_sessions where account_id = $1)
       + (select count(*) from pilot.shadow_chat_messages where account_id = $1)
       + (select count(*) from pilot.shadow_evidence_bundles where account_id = $1)
       + (select count(*) from pilot.shadow_evidence_items where account_id = $1)
       + (select count(*) from pilot.shadow_evidence_claims where account_id = $1)
       + (select count(*) from pilot.shadow_message_citations where account_id = $1)
       + (select count(*) from pilot.shadow_learning_events where account_id = $1)
       + (select count(*) from pilot.shadow_recommendation_effectiveness where account_id = $1)
       + (select count(*) from pilot.shadow_human_review_queue where account_id = $1)
       + (select count(*) from pilot.shadow_data_deletion_requests where account_id = $1) as by_account,
       (select count(*) from pilot.shadow_chat_sessions where organization_id = $2 and athlete_id = $3)
       + (select count(*) from pilot.shadow_chat_messages m join pilot.shadow_chat_sessions s using (conversation_id)
           where s.organization_id = $2 and s.athlete_id = $3)
       + (select count(*) from pilot.shadow_evidence_bundles where organization_id = $2 and subject_id = $3)
       + (select count(*) from pilot.shadow_evidence_items i join pilot.shadow_evidence_bundles b using (bundle_id)
           where b.organization_id = $2 and b.subject_id = $3)
       + (select count(*) from pilot.shadow_decisions where organization_id = $2 and athlete_id = $3)
       + (select count(*) from pilot.shadow_decision_outcomes o join pilot.shadow_decisions d using (decision_id)
           where d.organization_id = $2 and d.athlete_id = $3)
       + (select count(*) from pilot.shadow_recommendations where organization_id = $2 and athlete_id = $3)
       + (select count(*) from pilot.shadow_film_study_proposals where organization_id = $2 and athlete_id = $3) as by_athlete`,
    [person.guardian, ORG, person.athleteId],
  )).rows[0];
  return { byAccount: Number(row.by_account), byAthlete: Number(row.by_athlete) };
}

// Everything seedPerson writes for one person: 7 rows keyed to the guardian
// (session, message, bundle, learning event, effectiveness, review entry,
// deletion request -- one in each of the seven tables), 8 rows keyed to the
// child (session, its message, bundle, its item, decision, its outcome,
// recommendation, proposal).
const SEEDED: IdentifiedRows = { byAccount: 7, byAthlete: 8 };

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
  await admin.query(`drop database if exists ${PG_DATABASE}`);
  await admin.query(`create database ${PG_DATABASE}`);
  await admin.end();

  client = new Client({ connectionString: connectionStringFor(PG_DATABASE) });
  await client.connect();

  // Production's schema up to, but not including, this migration: the base
  // file and every earlier migration in the workflow's deploy order. Any
  // migration the workflow runs AFTER this one is applied once this one has
  // been, so the purge code below runs on the schema production runs.
  const { BASE_SCHEMA_FILE, listMigrationFiles } = (await nativeDynamicImport(
    pathToFileURL(FULL_SCHEMA_HELPER_PATH).href,
  )) as { BASE_SCHEMA_FILE: string; listMigrationFiles: () => Promise<string[]> };
  const files = await listMigrationFiles();
  const position = files.indexOf(MIGRATION_FILE);
  expect(position).toBeGreaterThan(0);
  laterMigrations = files.slice(position + 1);
  await client.query(await fs.readFile(path.join(INFRA_DIR, BASE_SCHEMA_FILE), 'utf8'));
  for (const file of files.slice(0, position)) {
    await client.query('begin');
    await client.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
    await client.query('commit');
  }

  runner = (await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href)) as unknown as Runner;
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  await client.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [ORG]);
  await client.query(`insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, 'coach', $2, 'microsoft')`, [COACH, ORG]);
  await client.query(`insert into pilot.shadow_library_sources (source_id, organization_id, title, source_type, authority_tier, rights_status) values ('src-keys', $1, 'Source', 'book', 1, 'ppbf_owned')`, [ORG]);
  await client.query(`insert into pilot.shadow_library_documents (document_id, source_id, organization_id, document_name) values ('doc-keys', 'src-keys', $1, 'Doc')`, [ORG]);
  await client.query(`insert into pilot.shadow_library_chunks (chunk_id, document_id, source_id, organization_id, ordinal, text_content) values ('chunk-keys', 'doc-keys', 'src-keys', $1, 1, 'text')`, [ORG]);

  // Env before import: db.ts builds its pool on first use.
  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(PG_DATABASE);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  dataDeletion = await import('./dataDeletion');
  ({ closePool } = await import('./db'));
});

afterAll(async () => {
  await closePool?.();
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
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe('shadow-deidentify-keys migration', () => {
  test('before: the keys the purge would trip over exist, and the readiness query still sees them with pilot on the search_path', async () => {
    const before = await readiness();
    expect(before).toEqual({ account_keys_left: 7, athlete_keys_left: 5, deferrable_keys: 0, purge_columns: 0, stamp_checks: 0, cascade_triggers: 0 });
    // None of the six evidence keys is deferrable yet: they exist under
    // Postgres's own names, all immediate.
    const immediate = await client.query<{ n: string }>(
      `select count(*) as n from pg_constraint
        where contype = 'f' and condeferrable
          and conrelid in (to_regclass('pilot.shadow_evidence_items'), to_regclass('pilot.shadow_evidence_claims'), to_regclass('pilot.shadow_message_citations'))`,
    );
    expect(Number(immediate.rows[0].n)).toBe(0);

    // The hazard is real on this server: with pilot on the search_path the
    // printed definition loses its `pilot.` prefix, so a query that matched
    // that text would count 0 keys here and the runner would PASS with every
    // cascade still in place.
    await client.query('set search_path to pilot, public');
    try {
      const printed = await client.query<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint
          where contype = 'f' and conrelid = to_regclass('pilot.shadow_chat_messages') and confrelid = to_regclass('pilot.accounts')`,
      );
      expect(printed.rows.map((row) => row.def)).toEqual(['FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE']);
      expect(await readiness()).toEqual(before);
    } finally {
      await client.query('reset search_path');
    }
  });

  test('the runner applies it, the readiness query passes, and a second run changes nothing', async () => {
    await runner.applyMigrationTransaction(client, migrationSql);
    const after = await readiness();
    expect(after).toEqual(runner.READY);
    const keys = {
      items: await foreignKeysOf('shadow_evidence_items'),
      claims: await foreignKeysOf('shadow_evidence_claims'),
      citations: await foreignKeysOf('shadow_message_citations'),
      sessions: await foreignKeysOf('shadow_chat_sessions'),
    };
    // Same columns and delete actions as before, now deferrable.
    expect(keys.items).toContain(
      'FOREIGN KEY (bundle_id, organization_id, account_id) REFERENCES pilot.shadow_evidence_bundles(bundle_id, organization_id, account_id) ON DELETE CASCADE DEFERRABLE',
    );
    expect(keys.claims).toContain(
      'FOREIGN KEY (assistant_message_id, organization_id, account_id) REFERENCES pilot.shadow_chat_messages(message_id, organization_id, account_id) ON DELETE CASCADE DEFERRABLE',
    );
    expect(keys.claims).toContain(
      'FOREIGN KEY (bundle_id, organization_id, account_id) REFERENCES pilot.shadow_evidence_bundles(bundle_id, organization_id, account_id) DEFERRABLE',
    );
    expect(keys.citations).toHaveLength(3);
    // The organization key and the conversation key stay; only account and athlete went.
    expect(keys.sessions).toEqual(['FOREIGN KEY (organization_id) REFERENCES pilot.organizations(organization_id) ON DELETE CASCADE']);
    // Staff keys stay.
    expect(await foreignKeysOf('shadow_decisions')).toEqual(expect.arrayContaining([
      expect.stringContaining('FOREIGN KEY (decided_by_account_id) REFERENCES pilot.accounts(account_id)'),
    ]));

    await runner.applyMigrationTransaction(client, migrationSql);
    expect(await readiness()).toEqual(after);
    expect(await foreignKeysOf('shadow_evidence_items')).toEqual(keys.items);

    // With pilot on the search_path the answer is the same.
    await client.query('set search_path to pilot, public');
    try {
      expect(await readiness()).toEqual(after);
    } finally {
      await client.query('reset search_path');
    }

    // The schema production runs: whatever the workflow applies after this.
    for (const file of laterMigrations) {
      await client.query('begin');
      await client.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
      await client.query('commit');
    }
  });

  test('ORDERING: with the migration applied and no de-identifying code, deleting the account or the athlete still takes every row that named them', async () => {
    const person = await seedPerson();
    expect(await identifiedRows(person)).toEqual(SEEDED);

    // What both purge paths do today for these tables, and nothing more.
    await client.query('delete from pilot.accounts where account_id = $1', [person.guardian]);
    expect((await identifiedRows(person)).byAccount).toBe(0);
    await client.query('delete from pilot.athletes where organization_id = $1 and athlete_id = $2', [ORG, person.athleteId]);
    expect(await identifiedRows(person)).toEqual({ byAccount: 0, byAthlete: 0 });
    // The child's message and the bundle's item followed their session and bundle.
    expect((await client.query('select 1 from pilot.shadow_chat_messages where message_id = $1', [person.messageId])).rowCount).toBe(0);
    expect((await client.query('select 1 from pilot.shadow_evidence_items where bundle_id = $1', [person.bundleId])).rowCount).toBe(0);
    expect((await client.query('select 1 from pilot.shadow_decision_outcomes where decision_id = $1', [person.decisionId])).rowCount).toBe(0);
    // The coach, who deleted nothing of their own, keeps their account.
    expect((await client.query('select 1 from pilot.accounts where account_id = $1', [COACH])).rowCount).toBe(1);
  });

  test('ORDERING: the function-path purge in this tree (the same deletes as the job), on the migrated schema, leaves none of these rows naming a purged guardian or child', async () => {
    const person = await seedPerson({ deleted: true });
    expect(await identifiedRows(person)).toEqual(SEEDED);
    await dataDeletion.purgeExpiredDeletedData();
    expect(await identifiedRows(person)).toEqual({ byAccount: 0, byAthlete: 0 });
    // PRE-EXISTING GAP, unchanged by this migration and pinned so it is not
    // mistaken for covered: shadow_feedback has never had an account key and
    // neither purge path touches it, so the guardian's feedback row (their
    // email, their own comment) survives. PR C tokens it.
    expect((await client.query('select 1 from pilot.shadow_feedback where account_id = $1', [person.guardian])).rowCount).toBe(1);
    expect((await client.query('select 1 from pilot.accounts where account_id = $1', [person.guardian])).rowCount).toBe(0);
    expect((await client.query('select 1 from pilot.athletes where organization_id = $1 and athlete_id = $2', [ORG, person.athleteId])).rowCount).toBe(0);
  });

  test('a purge that re-keys first keeps the rows; a Q7 hold is spared with what hangs under it; a table the purge forgot fails safe', async () => {
    const person = await seedPerson({ deleted: true });

    // NEGATIVE CONTROL: re-keying one table alone, with the keys checked at
    // once, is refused -- the children still name the old key.
    await expect(
      client.query('update pilot.shadow_evidence_bundles set account_id = $1 where bundle_id = $2', ['anon_probe', person.bundleId]),
    ).rejects.toMatchObject({ code: '23503' });
    // NEGATIVE CONTROL: the stamp without the token, and the token without
    // the stamp, are refused; a login that merely starts with anon_ is neither.
    await expect(
      client.query('update pilot.shadow_chat_sessions set deidentified_at = now() where conversation_id = $1', [person.guardianConversationId]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      client.query(`update pilot.shadow_human_review_queue set account_id = 'anon_22222222-2222-4222-8222-222222222222' where account_id = $1`, [person.guardian]),
    ).rejects.toMatchObject({ code: '23514' });
    await client.query(
      `insert into pilot.shadow_human_review_queue (review_id, organization_id, account_id, category, severity, summary)
       values (gen_random_uuid(), $1, 'anon_smith@example.test', 'safeguarding', 'high', 'a login that starts with anon_')`,
      [ORG],
    );

    // The purge's shape, with no switch to set: re-key every table in one
    // transaction with the keys checked at commit (token and stamp in ONE
    // update, a check is never deferrable), hold what Q7 holds with the
    // person's deleted_at, forget one table on purpose, delete the person.
    const token = 'anon_00000000-0000-4000-8000-000000000000';
    const guardianToken = 'anon_11111111-1111-4111-8111-111111111111';
    await client.query('begin');
    await client.query('set constraints all deferred');
    for (const table of ['shadow_chat_messages', 'shadow_evidence_bundles', 'shadow_evidence_items', 'shadow_evidence_claims', 'shadow_message_citations']) {
      await client.query(`update pilot.${table} set account_id = $1 where organization_id = $2 and account_id = $3`, [token, ORG, person.athleteLogin]);
    }
    await client.query(
      `update pilot.shadow_chat_sessions
          set account_id = $1, athlete_id = $1, deidentified_at = now(),
              subject_deleted_at = (select deleted_at from pilot.athletes where organization_id = $2 and athlete_id = $3)
        where conversation_id = $4`,
      [token, ORG, person.athleteId, person.conversationId],
    );
    await client.query(`update pilot.shadow_evidence_bundles set subject_id = $1 where bundle_id = $2`, [token, person.bundleId]);
    for (const table of ['shadow_decisions', 'shadow_recommendations', 'shadow_film_study_proposals']) {
      await client.query(`update pilot.${table} set athlete_id = $1 where organization_id = $2 and athlete_id = $3`, [token, ORG, person.athleteId]);
    }
    // The guardian: the flagged conversation and its review entry are held
    // (Q7) with their message; the bundle, effectiveness row and deletion
    // request are tokened; the learning event is FORGOTTEN on purpose.
    await client.query(
      `update pilot.shadow_chat_sessions set subject_deleted_at = (select deleted_at from pilot.accounts where account_id = $1) where conversation_id = $2`,
      [person.guardian, person.guardianConversationId],
    );
    await client.query(
      `update pilot.shadow_human_review_queue set subject_deleted_at = (select deleted_at from pilot.accounts where account_id = $1) where account_id = $1`,
      [person.guardian],
    );
    for (const table of ['shadow_evidence_bundles', 'shadow_recommendation_effectiveness', 'shadow_data_deletion_requests']) {
      await client.query(`update pilot.${table} set account_id = $1 where organization_id = $2 and account_id = $3`, [guardianToken, ORG, person.guardian]);
    }
    await client.query('delete from pilot.accounts where account_id = $1', [person.guardian]);
    await client.query('delete from pilot.athletes where organization_id = $1 and athlete_id = $2', [ORG, person.athleteId]);
    await client.query('commit');

    // The tokened rows outlived the person.
    const kept = await client.query<{ n: string }>(
      `select (select count(*) from pilot.shadow_chat_sessions where account_id = $1 and athlete_id = $1 and deidentified_at is not null and subject_deleted_at is not null)
            + (select count(*) from pilot.shadow_chat_messages where account_id = $1)
            + (select count(*) from pilot.shadow_evidence_bundles where account_id = $1 and subject_id = $1)
            + (select count(*) from pilot.shadow_evidence_items where account_id = $1)
            + (select count(*) from pilot.shadow_evidence_claims where account_id = $1)
            + (select count(*) from pilot.shadow_message_citations where account_id = $1)
            + (select count(*) from pilot.shadow_decisions where athlete_id = $1)
            + (select count(*) from pilot.shadow_decision_outcomes o join pilot.shadow_decisions d using (decision_id) where d.athlete_id = $1)
            + (select count(*) from pilot.shadow_recommendations where athlete_id = $1)
            + (select count(*) from pilot.shadow_film_study_proposals where athlete_id = $1) as n`,
      [token],
    );
    expect(Number(kept.rows[0].n)).toBe(10);
    expect(Number((await client.query<{ n: string }>(
      `select (select count(*) from pilot.shadow_evidence_bundles where account_id = $1)
            + (select count(*) from pilot.shadow_recommendation_effectiveness where account_id = $1)
            + (select count(*) from pilot.shadow_data_deletion_requests where account_id = $1) as n`,
      [guardianToken],
    )).rows[0].n)).toBe(3);
    // Held, on purpose: the flagged conversation, its message and the review
    // entry, each carrying the deadline's start (the guardian was deleted
    // 18 months ago; the account row that said so is gone now).
    expect(await identifiedRows(person)).toEqual({ byAccount: 3, byAthlete: 0 });
    expect((await client.query(
      `select 1 from pilot.shadow_chat_sessions s
        where s.conversation_id = $1 and s.account_id = $2 and s.deidentified_at is null
          and s.subject_deleted_at between now() - interval '18 months' - interval '1 minute'
                                      and now() - interval '18 months' + interval '1 minute'`,
      [person.guardianConversationId, person.guardian],
    )).rowCount).toBe(1);
    expect((await client.query(
      'select 1 from pilot.shadow_human_review_queue where account_id = $1 and deidentified_at is null and subject_deleted_at is not null',
      [person.guardian],
    )).rowCount).toBe(1);
    // FAIL SAFE: the forgotten table's row was deleted, not kept with the name on it.
    expect((await client.query('select 1 from pilot.shadow_learning_events where account_id = any($1::text[])', [[person.guardian, guardianToken]])).rowCount).toBe(0);
    // The real login that merely starts with anon_ was neither refused nor touched.
    expect((await client.query(`select 1 from pilot.shadow_human_review_queue where account_id = 'anon_smith@example.test' and deidentified_at is null`)).rowCount).toBe(1);

    // Nothing was switched: the next plain delete cascades as before.
    const another = await seedPerson();
    await client.query('delete from pilot.accounts where account_id = $1', [another.guardian]);
    await client.query('delete from pilot.athletes where organization_id = $1 and athlete_id = $2', [ORG, another.athleteId]);
    expect(await identifiedRows(another)).toEqual({ byAccount: 0, byAthlete: 0 });
  });
});
