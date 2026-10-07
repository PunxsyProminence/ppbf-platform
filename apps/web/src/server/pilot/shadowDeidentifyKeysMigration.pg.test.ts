/**
 * The shadow-deidentify-keys migration, driven through its real runner on a
 * real PostgreSQL built the way production is built (base schema plus every
 * migration before it, in deploy order).
 *
 * What it proves: the account and athlete keys the purge's token update
 * would trip over are gone from the de-identified tables; the six composite
 * evidence keys are deferrable, so one transaction can re-key every table and
 * commit; deidentified_at exists; a second run changes nothing; and the
 * runner refuses nothing it should accept. Owner rulings: Jason 2026-10-06
 * (de-identify, keep ML data), Q5, 2026-10-07 Q7.
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
  applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
};

const ORG = 'org-deid-keys';
const COACH = 'acct-deid-keys-coach';
const ATHLETE = 'ath-deid-keys';
const LOGIN = 'acct-deid-keys-athlete';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let runner: Runner;
let migrationSql: string;

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
  stamp_columns: number;
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
  // file and every earlier migration in the workflow's deploy order.
  const { BASE_SCHEMA_FILE, listMigrationFiles } = (await nativeDynamicImport(
    pathToFileURL(FULL_SCHEMA_HELPER_PATH).href,
  )) as { BASE_SCHEMA_FILE: string; listMigrationFiles: () => Promise<string[]> };
  const files = await listMigrationFiles();
  const position = files.indexOf(MIGRATION_FILE);
  expect(position).toBeGreaterThan(0);
  await client.query(await fs.readFile(path.join(INFRA_DIR, BASE_SCHEMA_FILE), 'utf8'));
  for (const file of files.slice(0, position)) {
    await client.query('begin');
    await client.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
    await client.query('commit');
  }

  runner = (await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href)) as unknown as Runner;
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
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
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe('shadow-deidentify-keys migration', () => {
  test('before: the keys the purge would trip over exist, and none is deferrable', async () => {
    const before = await readiness();
    expect(before.account_keys_left).toBe(7);
    expect(before.athlete_keys_left).toBe(5);
    expect(before.deferrable_keys).toBe(0);
    expect(before.stamp_columns).toBe(0);
  });

  test('the runner applies it, the readiness query passes, and a second run changes nothing', async () => {
    await runner.applyMigrationTransaction(client, migrationSql);
    const after = await readiness();
    expect(after).toEqual({ account_keys_left: 0, athlete_keys_left: 0, deferrable_keys: 6, stamp_columns: 2 });
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
  });

  test('one deferred transaction re-keys every evidence table to a token, and the person\'s rows outlive the person', async () => {
    await client.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [ORG]);
    await client.query(`insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, 'coach', $2, 'microsoft')`, [COACH, ORG]);
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Keys Athlete', '2013-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [ORG, ATHLETE, COACH],
    );
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, auth_provider) values ($1, 'athlete', $2, $3, 'ppbf_local')`,
      [LOGIN, ORG, ATHLETE],
    );
    await client.query(`insert into pilot.shadow_library_sources (source_id, organization_id, title, source_type, authority_tier, rights_status) values ('src-keys', $1, 'Source', 'book', 1, 'ppbf_owned')`, [ORG]);
    await client.query(`insert into pilot.shadow_library_documents (document_id, source_id, organization_id, document_name) values ('doc-keys', 'src-keys', $1, 'Doc')`, [ORG]);
    await client.query(`insert into pilot.shadow_library_chunks (chunk_id, document_id, source_id, organization_id, ordinal, text_content) values ('chunk-keys', 'doc-keys', 'src-keys', $1, 1, 'text')`, [ORG]);
    const conversationId = '11111111-1111-4111-8111-111111111111';
    const messageId = '22222222-2222-4222-8222-222222222222';
    const bundleId = '33333333-3333-4333-8333-333333333333';
    const evidenceId = '44444444-4444-4444-8444-444444444444';
    await client.query(`insert into pilot.shadow_chat_sessions (conversation_id, organization_id, account_id, athlete_id) values ($1, $2, $3, $4)`, [conversationId, ORG, LOGIN, ATHLETE]);
    await client.query(
      `insert into pilot.shadow_chat_messages (message_id, conversation_id, organization_id, account_id, role, content) values ($1, $2, $3, $4, 'assistant', 'reply')`,
      [messageId, conversationId, ORG, LOGIN],
    );
    await client.query(
      `insert into pilot.shadow_evidence_bundles (bundle_id, organization_id, account_id, subject_id, query_sha256, availability, item_count)
       values ($1, $2, $3, $4, repeat('a', 64), 'available', 1)`,
      [bundleId, ORG, LOGIN, ATHLETE],
    );
    await client.query(
      `insert into pilot.shadow_evidence_items (evidence_id, bundle_id, organization_id, account_id, source_id, document_id, chunk_id, ordinal, excerpt_sha256, library_organization_id)
       values ($1, $2, $3, $4, 'src-keys', 'doc-keys', 'chunk-keys', 1, repeat('b', 64), $3)`,
      [evidenceId, bundleId, ORG, LOGIN],
    );
    await client.query(
      `insert into pilot.shadow_evidence_claims (claim_id, organization_id, account_id, conversation_id, assistant_message_id, bundle_id, claim_status)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, 'supported')`,
      [ORG, LOGIN, conversationId, messageId, bundleId],
    );
    await client.query(
      `insert into pilot.shadow_message_citations (assistant_message_id, evidence_id, bundle_id, organization_id, account_id, ordinal) values ($1, $2, $3, $4, $5, 1)`,
      [messageId, evidenceId, bundleId, ORG, LOGIN],
    );

    // NEGATIVE CONTROL: re-keying one table alone, with the keys checked at
    // once, is refused -- the children still name the old key.
    await expect(
      client.query('update pilot.shadow_evidence_bundles set account_id = $1 where bundle_id = $2', ['anon_probe', bundleId]),
    ).rejects.toMatchObject({ code: '23503' });

    // The purge's shape: every table in one transaction, keys checked at commit.
    const token = 'anon_00000000-0000-4000-8000-000000000000';
    await client.query('begin');
    await client.query('set constraints all deferred');
    for (const table of ['shadow_chat_sessions', 'shadow_chat_messages', 'shadow_evidence_bundles', 'shadow_evidence_items', 'shadow_evidence_claims', 'shadow_message_citations']) {
      await client.query(`update pilot.${table} set account_id = $1 where organization_id = $2 and account_id = $3`, [token, ORG, LOGIN]);
    }
    await client.query(`update pilot.shadow_chat_sessions set athlete_id = $1, deidentified_at = now() where conversation_id = $2`, [token, conversationId]);
    await client.query(`update pilot.shadow_evidence_bundles set subject_id = $1 where bundle_id = $2`, [token, bundleId]);
    await client.query('commit');
    const rekeyed = await client.query<{ n: number }>(
      `select (select count(*) from pilot.shadow_chat_sessions where account_id = $1 and athlete_id = $1 and deidentified_at is not null)
            + (select count(*) from pilot.shadow_chat_messages where account_id = $1)
            + (select count(*) from pilot.shadow_evidence_bundles where account_id = $1 and subject_id = $1)
            + (select count(*) from pilot.shadow_evidence_items where account_id = $1)
            + (select count(*) from pilot.shadow_evidence_claims where account_id = $1)
            + (select count(*) from pilot.shadow_message_citations where account_id = $1) as n`,
      [token],
    );
    expect(Number(rekeyed.rows[0].n)).toBe(6);

    // The person goes; the de-identified rows stay (no cascade left to take them).
    await client.query('delete from pilot.accounts where account_id = $1', [LOGIN]);
    await client.query('delete from pilot.athletes where organization_id = $1 and athlete_id = $2', [ORG, ATHLETE]);
    expect((await client.query('select 1 from pilot.shadow_chat_sessions where conversation_id = $1', [conversationId])).rowCount).toBe(1);
    expect((await client.query('select 1 from pilot.shadow_evidence_bundles where bundle_id = $1', [bundleId])).rowCount).toBe(1);

    // A review-queue row can name a token, and carries the stamp.
    await client.query(
      `insert into pilot.shadow_human_review_queue (review_id, organization_id, conversation_id, account_id, category, severity, summary, deidentified_at)
       values (gen_random_uuid(), $1, $2, $3, 'safeguarding', 'high', '', now())`,
      [ORG, conversationId, token],
    );
    expect((await client.query('select 1 from pilot.shadow_human_review_queue where account_id = $1', [token])).rowCount).toBe(1);
  });
});
