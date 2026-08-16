// Real PostgreSQL-backed contract test for the payment-ledger migration
// (the tables docs/PAYMENT_SERVICE_SLOT.md reserved by name; owner decision
// 2026-08-15: ledger tables land first).
//
// What needs proving that reading SQL cannot prove: the migration creates
// all three tables from nothing; re-applying it is a no-op that leaves rows
// untouched; the lane and status vocabularies are enforced by the database;
// one account per (organization, lane) is a primary-key fact so a gym can
// never have two giving accounts and an ambiguous destination; and the
// bookkeeping checks hold (a revocation timestamp only on a disconnected
// account, a cancellation timestamp only on a canceled subscription).
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging, and
// nothing here touches a payment processor -- these are empty mirror tables.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-payments-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_payments_migration.sql';

const ORG_ID = 'org-payments';
const ADMIN_ID = 'acct-payments-admin';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let baseSchemaSql: string;

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

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft') on conflict do nothing`,
    [ADMIN_ID, ORG_ID],
  );
  return client;
}

function insertAccount(client: Client, lane: string, overrides: Record<string, string> = {}) {
  return client.query(
    `insert into pilot.payment_accounts
       (organization_id, lane, stripe_account_id, status, connected_by_account_id)
     values ($1, $2, $3, $4, $5)`,
    [
      ORG_ID,
      lane,
      overrides.stripe_account_id ?? 'acct_test_1',
      overrides.status ?? 'connected',
      ADMIN_ID,
    ],
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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
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

describe('payments migration', () => {
  test('creates all three tables from nothing and accepts a valid mirror chain', async () => {
    const client = await freshDatabase('payments_fresh');
    try {
      await client.query(migrationSql);
      await insertAccount(client, 'giving');
      await client.query(
        `insert into pilot.payment_transactions
           (organization_id, transaction_id, lane, stripe_account_id, amount_cents, status, occurred_at)
         values ($1, 'pi_test_1', 'giving', 'acct_test_1', 2500, 'succeeded', now())`,
        [ORG_ID],
      );
      await client.query(
        `insert into pilot.payment_subscriptions
           (organization_id, subscription_id, lane, stripe_account_id, amount_cents, billing_interval, status, started_at)
         values ($1, 'sub_test_1', 'giving', 'acct_test_1', 1000, 'month', 'active', now())`,
        [ORG_ID],
      );

      const transactions = await client.query(
        `select lane, amount_cents::int as amount_cents, status
         from pilot.payment_transactions where organization_id = $1`,
        [ORG_ID],
      );
      expect(transactions.rows).toEqual([{ lane: 'giving', amount_cents: 2500, status: 'succeeded' }]);
    } finally {
      await client.end();
    }
  });

  test('re-applying over an existing install is a no-op that leaves rows untouched', async () => {
    const client = await freshDatabase('payments_noop');
    try {
      await client.query(migrationSql);
      await insertAccount(client, 'giving');
      await client.query(migrationSql);

      const rows = await client.query(
        'select lane from pilot.payment_accounts where organization_id = $1',
        [ORG_ID],
      );
      expect(rows.rows.map((row) => row.lane)).toEqual(['giving']);
    } finally {
      await client.end();
    }
  });

  test('the lane and status vocabularies are enforced by the database', async () => {
    const client = await freshDatabase('payments_vocab');
    try {
      await client.query(migrationSql);

      // 'general' is not a lane: which book a payment belongs to must be one
      // of the two real books.
      await expect(insertAccount(client, 'general'))
        .rejects.toMatchObject({ code: '23514' });
      await expect(insertAccount(client, 'giving', { status: 'pending' }))
        .rejects.toMatchObject({ code: '23514' });
      await insertAccount(client, 'giving');
      await expect(client.query(
        `insert into pilot.payment_transactions
           (organization_id, transaction_id, lane, stripe_account_id, amount_cents, status, occurred_at)
         values ($1, 'pi_bad', 'giving', 'acct_test_1', -100, 'succeeded', now())`,
        [ORG_ID],
      )).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });

  test('one account per lane is a primary-key fact, and the bookkeeping checks hold', async () => {
    const client = await freshDatabase('payments_shape');
    try {
      await client.query(migrationSql);
      await insertAccount(client, 'giving');

      // A second giving account would make the settlement destination
      // ambiguous; the primary key refuses it.
      await expect(insertAccount(client, 'giving', { stripe_account_id: 'acct_test_2' }))
        .rejects.toMatchObject({ code: '23505' });
      // The other lane is its own row.
      await insertAccount(client, 'program', { stripe_account_id: 'acct_test_2' });

      // revoked_at on a connected account is a bookkeeping error.
      await expect(client.query(
        `update pilot.payment_accounts set revoked_at = now()
         where organization_id = $1 and lane = 'giving'`,
        [ORG_ID],
      )).rejects.toMatchObject({ code: '23514' });

      // canceled_at on an active subscription is the same error, one table over.
      await client.query(
        `insert into pilot.payment_subscriptions
           (organization_id, subscription_id, lane, stripe_account_id, amount_cents, billing_interval, status, started_at)
         values ($1, 'sub_test_1', 'giving', 'acct_test_1', 1000, 'month', 'active', now())`,
        [ORG_ID],
      );
      await expect(client.query(
        `update pilot.payment_subscriptions set canceled_at = now()
         where organization_id = $1 and subscription_id = 'sub_test_1'`,
        [ORG_ID],
      )).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });
});
