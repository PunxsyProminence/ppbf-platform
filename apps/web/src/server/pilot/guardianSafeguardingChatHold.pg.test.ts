/**
 * A guardian with a safeguarding-flagged SHADOW chat is held two years after
 * deletion, not purged at one, on real PostgreSQL, through the retention
 * script.
 *
 * Jason 2026-10-07 (Q7): "2 years after deletion (Recommended)". A guardian's
 * account is purged a year after deletion, and their
 * pilot.shadow_human_review_queue rows went with it (the account key's
 * cascade, or the shadow_rows_follow_account trigger once
 * shadow-deidentify-keys is applied: nothing writes subject_deleted_at). The
 * script now leaves a guardian with any review-queue row until deleted_at +
 * 2 years. At two years they are purged like anyone else; the de-identifying
 * sweep the ruling also names is not built.
 *
 * Spins up the same disposable, local-only embedded Postgres the other
 * migration suites use. It NEVER connects to production or staging.
 */

import { type ChildProcessByStdio, execFile, spawn } from 'node:child_process';
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
const PG_DATABASE = 'ppbf_test_guardian_safeguarding_hold';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-guardian-safeguarding-hold-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const CLEANUP_SCRIPT = path.resolve(__dirname, '../../../scripts/pilot-cleanup-deleted-data.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-safeguarding-hold';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

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

interface PurgeEvent {
  event?: string;
  accounts?: number;
  would_delete_accounts?: number;
  guardians_held_for_safeguarding_chats?: number;
  blocked_by?: Record<string, number>;
}

/**
 * Runs scripts/pilot-cleanup-deleted-data.mjs. 'dry' is its dry run, which
 * rolls everything back; 'apply' is the APPLY dispatch; 'nightly' is the
 * scheduled inquiries-only mode, which never touches people's records.
 */
async function purge(mode: boolean | 'nightly'): Promise<PurgeEvent> {
  const apply = mode === true;
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      [CLEANUP_SCRIPT],
      {
        env: {
          ...process.env,
          AZURE_POSTGRES_CONNECTION_STRING: connectionStringFor(PG_DATABASE),
          PPBF_EXPECTED_POSTGRES_HOSTNAME: 'localhost',
          PPBF_EXPECTED_POSTGRES_DATABASE: PG_DATABASE,
          PPBF_POSTGRES_DISABLE_SSL: 'true',
          ...(apply ? { PPBF_RETENTION_APPLY: 'true' } : {}),
          ...(mode === 'nightly' ? { PPBF_RETENTION_APPLY_INQUIRIES: 'true' } : {}),
        },
      },
      (error, stdout, stderr) => (error ? reject(new Error(`${stdout}${stderr}`)) : resolve(`${stdout}${stderr}`)),
    );
  });
  const line = output.split('\n').find((entry) => entry.trim().startsWith('{'));
  const event = JSON.parse(line ?? '{}') as PurgeEvent;
  // A purge that was refused proves nothing below.
  expect(event.blocked_by ?? {}).toEqual({});
  return event;
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
  const { applyFullSchema } = (await nativeDynamicImport(
    pathToFileURL(FULL_SCHEMA_HELPER_PATH).href,
  )) as { applyFullSchema: (c: Client) => Promise<void> };
  await applyFullSchema(client);

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
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

let seq = 0;

async function guardian(label: string, deletedAgo: string, flagged: boolean): Promise<{ account: string; conversation: string | null }> {
  seq += 1;
  const account = `acct-hold-${label}-${seq}`;
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag, deleted_at)
     values ($1, 'parent', $2, 'ppbf_local', false, now() - $3::interval)`,
    [account, ORG_ID, deletedAgo],
  );
  if (!flagged) return { account, conversation: null };
  const conversation = (await client.query(
    `insert into pilot.shadow_chat_sessions (conversation_id, organization_id, account_id, title)
     values (gen_random_uuid(), $1, $2, 'Flagged conversation') returning conversation_id`,
    [ORG_ID, account],
  )).rows[0].conversation_id as string;
  await client.query(
    `insert into pilot.shadow_human_review_queue
       (review_id, organization_id, conversation_id, account_id, category, severity, summary, status)
     values (gen_random_uuid(), $1, $2, $3, 'safeguarding', 'high', 'A child may be at risk', 'resolved')`,
    [ORG_ID, conversation, account],
  );
  return { account, conversation };
}

async function present(account: string, conversation: string | null) {
  const count = async (sql: string, params: unknown[]) => (await client.query(sql, params)).rowCount ?? 0;
  return {
    account: await count('select 1 from pilot.accounts where account_id = $1', [account]),
    reviews: await count('select 1 from pilot.shadow_human_review_queue where account_id = $1', [account]),
    conversation: conversation
      ? await count('select 1 from pilot.shadow_chat_sessions where conversation_id = $1', [conversation])
      : 0,
  };
}

test('a flagged guardian deleted 13 months ago is held; 25 months ago, or unflagged, is purged', async () => {
  const held = await guardian('flagged-13mo', '13 months', true);
  const unflagged = await guardian('unflagged-13mo', '13 months', false);
  const past = await guardian('flagged-25mo', '25 months', true);
  // Not yet due by any window: the control that the one-year line still binds.
  const recent = await guardian('flagged-6mo', '6 months', true);

  expect(await present(held.account, held.conversation)).toEqual({ account: 1, reviews: 1, conversation: 1 });
  expect(await present(past.account, past.conversation)).toEqual({ account: 1, reviews: 1, conversation: 1 });

  // The dry run: two due (the unflagged one and the one past two years), one
  // held and reported, nothing deleted.
  const dry = await purge(false);
  expect(dry.event).toBe('retention.cleanup.dry-run');
  expect(dry.would_delete_accounts).toBe(2);
  expect(dry.guardians_held_for_safeguarding_chats).toBe(1);
  expect(await present(unflagged.account, null)).toEqual({ account: 1, reviews: 0, conversation: 0 });
  expect(await present(past.account, past.conversation)).toEqual({ account: 1, reviews: 1, conversation: 1 });

  // The nightly run, the one that actually runs every night: it reports the
  // hold too, and removes nobody.
  const nightly = await purge('nightly');
  expect(nightly.guardians_held_for_safeguarding_chats).toBe(1);
  expect(await present(held.account, held.conversation)).toEqual({ account: 1, reviews: 1, conversation: 1 });
  expect(await present(unflagged.account, null)).toEqual({ account: 1, reviews: 0, conversation: 0 });

  const applied = await purge(true);
  expect(applied.accounts).toBe(2);
  expect(applied.guardians_held_for_safeguarding_chats).toBe(1);

  // Held: the account, the review entry and the conversation it points at.
  expect(await present(held.account, held.conversation)).toEqual({ account: 1, reviews: 1, conversation: 1 });
  // Past two years: purged, review entry and conversation with it.
  expect(await present(past.account, past.conversation)).toEqual({ account: 0, reviews: 0, conversation: 0 });
  // Unflagged: purged at one year, as before.
  expect(await present(unflagged.account, null)).toEqual({ account: 0, reviews: 0, conversation: 0 });
  // Not due at all.
  expect(await present(recent.account, recent.conversation)).toEqual({ account: 1, reviews: 1, conversation: 1 });

  // The audit row records the hold.
  const audit = await client.query(
    `select details from pilot.audit_events
      where entity_type = 'retention_cleanup' order by created_at desc limit 1`,
  );
  expect(audit.rows[0].details).toEqual(expect.objectContaining({
    accounts_deleted: 2,
    guardians_held_for_safeguarding_chats: 1,
  }));

  // A year on, the held guardian is past two years and goes like anyone else.
  await client.query(
    `update pilot.accounts set deleted_at = now() - interval '25 months' where account_id = $1`,
    [held.account],
  );
  const later = await purge(true);
  expect(later.accounts).toBe(1);
  expect(later.guardians_held_for_safeguarding_chats).toBe(0);
  expect(await present(held.account, held.conversation)).toEqual({ account: 0, reviews: 0, conversation: 0 });
});
