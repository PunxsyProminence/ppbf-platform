// Real PostgreSQL-backed test for the shadow-learning-effects migration (lane
// L46 PR A). pilot.shadow_feedback gains learning_effects_done, the list of a
// feedback event's effects that must not happen twice, and the backfill reads
// what the database already records about each feedback.
//
// What needs a real database to prove:
//   * the column arrives NOT NULL and empty from nothing, and a re-apply
//     changes nothing (no duplicate marks);
//   * the backfill marks 'complete' exactly where a human_reviewed learning
//     event exists, and 'library_flag' exactly where a logged action says this
//     feedback's flag or proposal write succeeded -- and a non-array
//     actions_taken does not break it;
//   * the CHECK admits the three effect names and refuses anything else;
//   * the runner refuses a database it never reached, the column without its
//     check, and a same-named check that admits more values.
//
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-shadow-learning-effects-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_shadow_learning_effects_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-shadow-learning-effects-migration.mjs',
);
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-effects';
const ACCOUNT_ID = 'acct-effects-athlete';

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

/** Full production schema with this migration's column and check removed. */
async function preMigrationDatabase(name: string): Promise<Client> {
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
     values ($1, $1, 'active')`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'athlete', $2, 'microsoft')`,
    [ACCOUNT_ID, ORG_ID],
  );
  await client.query(
    'alter table pilot.shadow_feedback drop constraint if exists shadow_feedback_learning_effects_done_check',
  );
  await client.query('alter table pilot.shadow_feedback drop column if exists learning_effects_done');
  return client;
}

async function insertFeedback(
  client: Client,
  correlationId: string,
  { outcome, reviewed }: { outcome: 'thumbs_up' | 'thumbs_down'; reviewed: boolean },
): Promise<number> {
  const { rows } = await client.query<{ feedback_id: string }>(
    `insert into pilot.shadow_feedback
       (organization_id, account_id, role, helpful, outcome_signal, correlation_type,
        correlation_id, verification_state, human_review_required)
     values ($1, $2, 'athlete', $3, $4, 'shadow_message', $5, $6, $7)
     returning feedback_id`,
    [
      ORG_ID,
      ACCOUNT_ID,
      outcome === 'thumbs_up',
      outcome,
      correlationId,
      reviewed ? 'human_reviewed' : 'durable_client',
      !reviewed,
    ],
  );
  return Number(rows[0].feedback_id);
}

async function insertLearningEvent(
  client: Client,
  feedbackId: number,
  verificationState: 'durable_client' | 'human_reviewed',
  actionsTaken: unknown,
): Promise<void> {
  await client.query(
    `insert into pilot.shadow_learning_events
       (organization_id, account_id, role, feedback_id, message_id, topic,
        session_type, outcome_signal, verification_state, actions_taken)
     values ($1, $2, 'athlete', $3, $4, 'footwork', 'quick_round', 'thumbs_down', $5, $6::jsonb)`,
    [ORG_ID, ACCOUNT_ID, feedbackId, `msg-${feedbackId}`, verificationState, JSON.stringify(actionsTaken)],
  );
}

async function effectsOf(client: Client, feedbackId: number): Promise<string[]> {
  const { rows } = await client.query<{ learning_effects_done: string[] }>(
    'select learning_effects_done from pilot.shadow_feedback where feedback_id = $1',
    [feedbackId],
  );
  return [...rows[0].learning_effects_done].sort();
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

describe('shadow-learning-effects migration', () => {
  test('backfills only what the learning log proves, and a re-apply adds nothing', async () => {
    const client = await preMigrationDatabase('effects_backfill');
    try {
      // Approved under the old rule: a human_reviewed event exists.
      const approved = await insertFeedback(client, 'm-approved', { outcome: 'thumbs_up', reviewed: true });
      await insertLearningEvent(client, approved, 'human_reviewed', ['Effectiveness recorded: improved (1)']);
      // Pending thumbs-down whose client flag was written.
      const pendingFlagged = await insertFeedback(client, 'm-pending-flagged', { outcome: 'thumbs_down', reviewed: false });
      await insertLearningEvent(client, pendingFlagged, 'durable_client', [
        'Effectiveness recorded: degraded (0.1)',
        'Client feedback queued for human review; no learning was promoted',
      ]);
      // Pending thumbs-down whose flag write FAILED: the log says so, no mark.
      const pendingFlagFailed = await insertFeedback(client, 'm-pending-failed', { outcome: 'thumbs_down', reviewed: false });
      await insertLearningEvent(client, pendingFlagFailed, 'durable_client', [
        'Client feedback review queue unavailable',
      ]);
      // Approved negative: approval flag and a Library proposal recorded.
      const approvedNegative = await insertFeedback(client, 'm-approved-negative', { outcome: 'thumbs_down', reviewed: true });
      await insertLearningEvent(client, approvedNegative, 'durable_client', ['Client feedback review queue unavailable']);
      await insertLearningEvent(client, approvedNegative, 'human_reviewed', [
        'Library entry flagged for review (topic: footwork)',
      ]);
      const approvedProposal = await insertFeedback(client, 'm-approved-proposal', { outcome: 'thumbs_up', reviewed: true });
      await insertLearningEvent(client, approvedProposal, 'human_reviewed', [
        "Library 'promote' proposal queued for human review",
      ]);
      // Pending praise: metrics only, no flag.
      const pendingPraise = await insertFeedback(client, 'm-pending-praise', { outcome: 'thumbs_up', reviewed: false });
      await insertLearningEvent(client, pendingPraise, 'durable_client', [
        'Client feedback recorded in metrics; no Library flag for thumbs_up',
      ]);
      // No learning event at all, and one with a non-array actions_taken.
      const noEvent = await insertFeedback(client, 'm-no-event', { outcome: 'thumbs_down', reviewed: false });
      const oddActions = await insertFeedback(client, 'm-odd', { outcome: 'thumbs_down', reviewed: false });
      await insertLearningEvent(client, oddActions, 'durable_client', {
        note: 'Client feedback queued for human review; no learning was promoted',
      });

      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      expect(await effectsOf(client, approved)).toEqual(['complete']);
      expect(await effectsOf(client, pendingFlagged)).toEqual(['library_flag']);
      expect(await effectsOf(client, pendingFlagFailed)).toEqual([]);
      expect(await effectsOf(client, approvedNegative)).toEqual(['complete', 'library_flag']);
      expect(await effectsOf(client, approvedProposal)).toEqual(['complete', 'library_flag']);
      expect(await effectsOf(client, pendingPraise)).toEqual([]);
      expect(await effectsOf(client, noEvent)).toEqual([]);
      expect(await effectsOf(client, oddActions)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('a new feedback row starts with no effects, and the check admits only the three names', async () => {
    const client = await preMigrationDatabase('effects_check');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const fresh = await insertFeedback(client, 'm-fresh', { outcome: 'thumbs_up', reviewed: false });
      expect(await effectsOf(client, fresh)).toEqual([]);

      await client.query(
        `update pilot.shadow_feedback
            set learning_effects_done = array['library_flag', 'facts', 'complete']
          where feedback_id = $1`,
        [fresh],
      );
      expect(await effectsOf(client, fresh)).toEqual(['complete', 'facts', 'library_flag']);

      await expect(client.query(
        `update pilot.shadow_feedback set learning_effects_done = array['metrics'] where feedback_id = $1`,
        [fresh],
      )).rejects.toThrow(/shadow_feedback_learning_effects_done_check/);
      await expect(client.query(
        'update pilot.shadow_feedback set learning_effects_done = null where feedback_id = $1',
        [fresh],
      )).rejects.toThrow(/null value/);
    } finally {
      await client.end();
    }
  });

  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await preMigrationDatabase('effects_not_ready');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(/SHADOW_LEARNING_EFFECTS_NOT_READY/);
    } finally {
      await client.end();
    }
  });

  test('the real runner REFUSES the column without its check, and a same-named check that admits more', async () => {
    const client = await preMigrationDatabase('effects_half');
    try {
      await client.query(
        "alter table pilot.shadow_feedback add column learning_effects_done text[] not null default '{}'::text[]",
      );
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(/SHADOW_LEARNING_EFFECTS_NOT_READY/);

      await client.query(
        `alter table pilot.shadow_feedback add constraint shadow_feedback_learning_effects_done_check
           check (learning_effects_done <@ array['library_flag', 'facts', 'complete', 'metrics']::text[])`,
      );
      // The migration leaves a same-named check alone, so the runner must
      // catch the widened one itself.
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow(/SHADOW_LEARNING_EFFECTS_NOT_READY/);
    } finally {
      await client.end();
    }
  });
});
