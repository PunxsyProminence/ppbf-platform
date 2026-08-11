// Real PostgreSQL-backed test for the idempotent assistant append (audit B1).
//
// The background job path appends its answer to the conversation BEFORE the
// job is marked complete. A worker that dies between those two writes leaves
// an appended answer on an uncompleted job: the lease expires, the job is
// re-claimed, and the executor appends the SAME answer a second time. The user
// reads it twice, from two paid model calls.
//
// The audit suggested completing before appending, but that only swaps which
// side loses -- complete-then-crash leaves the user with no answer at all.
// Keying the message id on the job removes the race instead of moving it.
//
// This CANNOT be proven with a mock: the guarantee is `on conflict
// (message_id) do nothing` against a real primary key. A stubbed client would
// simply return whatever it was told to.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-append-idem-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_append_idem';

const ORG_ID = 'org-append';
const ACCOUNT_ID = 'acct-append-coach';
const CONVERSATION_ID = '00000000-0000-4000-8000-00000000a001';
const JOB_ID = '7339777f-97cc-4c64-aa87-56ea042d06ac';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let conversations: typeof import('./shadowConversations');
let db: typeof import('./db');

const actor = {
  accountId: ACCOUNT_ID,
  organizationId: ORG_ID,
  role: 'coach' as const,
  athleteId: null,
};

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

function appendInput(overrides: Record<string, unknown> = {}) {
  return {
    actor,
    conversationId: CONVERSATION_ID,
    content: 'Work the jab from a settled stance before adding the cross.',
    topic: 'technique',
    sessionType: 'heavy_bag' as const,
    responseState: 'ok' as const,
    idempotencyKey: JOB_ID,
    ...overrides,
  };
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
  // evidence_tier and handoff live in the shadow-runtime increment, not the
  // base schema, and the append writes both.
  await migrateClient.query(
    await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_shadow_runtime_migration.sql'), 'utf8'),
  );
  // filter_reasons is a later increment again, and the append writes it too.
  // Every increment the write path touches has to be loaded here or the insert
  // fails on a column the production schema has -- which is the whole point of
  // building this suite's database from the committed SQL rather than a fixture.
  await migrateClient.query(
    await fs.readFile(
      path.join(INFRA_DIR, 'pilot_slice_postgres_shadow_filter_reason_migration.sql'),
      'utf8',
    ),
  );
  await migrateClient.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  await migrateClient.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [ACCOUNT_ID, ORG_ID],
  );
  await migrateClient.query(
    `insert into pilot.shadow_chat_sessions (conversation_id, organization_id, account_id, title)
     values ($1, $2, $3, 'Background answer')`,
    [CONVERSATION_ID, ORG_ID, ACCOUNT_ID],
  );
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  db = await import('./db');
  conversations = await import('./shadowConversations');
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

async function messageCount(): Promise<number> {
  const row = await db.queryOne<{ n: number }>(
    `select count(*)::int as n from pilot.shadow_chat_messages
     where conversation_id = $1 and role = 'assistant'`,
    [CONVERSATION_ID],
  );
  return row?.n ?? 0;
}

describe('idempotent assistant append against the real schema', () => {
  test('a re-claimed job does not append its answer twice', async () => {
    const first = await conversations.appendAssistantMessage(appendInput());
    // Exactly what a lease-expiry re-claim replays: same job, same answer.
    const second = await conversations.appendAssistantMessage(appendInput());

    expect(second).toBe(first);
    expect(await messageCount()).toBe(1);
  });

  test('the retained row is the FIRST one, not silently overwritten', async () => {
    // `do nothing` means the original content stands. A re-run that produced
    // different prose must not rewrite what the user already read.
    await conversations.appendAssistantMessage(appendInput({ content: 'A completely different answer.' }));

    const row = await db.queryOne<{ content: string }>(
      `select content from pilot.shadow_chat_messages where conversation_id = $1 and role = 'assistant'`,
      [CONVERSATION_ID],
    );
    expect(row?.content).toContain('Work the jab');
    expect(await messageCount()).toBe(1);
  });

  test('a different job appends its own message', async () => {
    // The guard must key on the job, not suppress every append to the
    // conversation -- a second background answer is a legitimate second row.
    await conversations.appendAssistantMessage(appendInput({
      idempotencyKey: 'a9f1c0de-0000-4000-8000-00000000b002',
      content: 'A later answer in the same conversation.',
    }));

    expect(await messageCount()).toBe(2);
  });

  test('without a key every append is a distinct row, as the sync path needs', async () => {
    // The synchronous chat path has no job to key on and legitimately appends
    // one row per turn. Idempotency must be opt-in.
    await conversations.appendAssistantMessage(appendInput({ idempotencyKey: undefined }));
    await conversations.appendAssistantMessage(appendInput({ idempotencyKey: undefined }));

    expect(await messageCount()).toBe(4);
  });

  test('the derived id is a valid v5 UUID, so it survives id validation', async () => {
    const { isUuid } = await import('./http');
    const row = await db.queryOne<{ message_id: string }>(
      `select message_id from pilot.shadow_chat_messages
       where conversation_id = $1 and content like 'Work the jab%'`,
      [CONVERSATION_ID],
    );
    expect(row?.message_id).toBeDefined();
    expect(isUuid(row!.message_id)).toBe(true);
  });
});
