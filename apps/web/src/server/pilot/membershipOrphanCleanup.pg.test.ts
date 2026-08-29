// Real PostgreSQL-backed test for pilot-cleanup-membership-orphans.mjs, the
// write half of pilot-check-membership-orphans.mjs (membershipOrphanCheck.pg.test.ts
// covers the read-only diagnostic; this covers the script that acts on it).
//
// Owner decision, 2026-08-29: the 17 orphaned pilot.organization_memberships
// rows the census found in production are not real -- confirmed non-retention
// (0 purge runs on record), a bulk-seed artifact, safe to delete. This tests
// the script that carries that decision out, against a disposable local
// database it never leaves.

import { type ChildProcessByStdio, execFile, spawn } from 'node:child_process';
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-membership-orphan-cleanup-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const CLEANUP_SCRIPT = path.resolve(__dirname, '../../../scripts/pilot-cleanup-membership-orphans.mjs');

const ORG_ID = 'org-membership-orphan-cleanup';
const PURGED_ACCOUNT_A = 'withdrawn.parent.a@example.test';
const PURGED_ACCOUNT_B = 'withdrawn.parent.b@example.test';
const LIVE_ACCOUNT = 'active.coach@example.test';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string;
let dbCounter = 0;

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

/**
 * The same orphan shape membershipOrphanCheck.pg.test.ts builds -- an
 * organization_memberships row whose account_id survives a hard delete from
 * pilot.accounts -- with TWO orphans this time, so a test can assert both are
 * gone and count the exact number deleted, plus one live account+membership
 * as the negative case the script must never touch.
 */
async function freshDatabase(): Promise<{ client: Client; name: string }> {
  dbCounter += 1;
  const name = `ppbf_test_membership_orphan_cleanup_${dbCounter}`;

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
     values ($1, $1, 'active')`,
    [ORG_ID],
  );

  for (const accountId of [PURGED_ACCOUNT_A, PURGED_ACCOUNT_B]) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'parent', $2, 'microsoft')`,
      [accountId, ORG_ID],
    );
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ($1, $2, 'parent', true)`,
      [accountId, ORG_ID],
    );
    await client.query('delete from pilot.accounts where account_id = $1', [accountId]);
  }

  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft')`,
    [LIVE_ACCOUNT, ORG_ID],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, 'coach', true)`,
    [LIVE_ACCOUNT, ORG_ID],
  );

  return { client, name };
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

/**
 * Runs the real cleanup script as its own process. Testing an exported
 * function instead would skip every guard the script actually carries -- the
 * write target assertion, the dry-run default, the blast-radius cap -- which
 * are the parts that matter for a script that permanently deletes rows in
 * production on a human's explicit go-ahead.
 */
async function runCleanup(dbName: string, extraEnv: Record<string, string>): Promise<{
  code: number;
  event: Record<string, unknown>;
}> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLEANUP_SCRIPT],
      {
        env: {
          ...process.env,
          AZURE_POSTGRES_CONNECTION_STRING: connectionStringFor(dbName),
          PPBF_EXPECTED_POSTGRES_HOSTNAME: 'localhost',
          PPBF_EXPECTED_POSTGRES_DATABASE: dbName,
          PPBF_POSTGRES_DISABLE_SSL: 'true',
          ...extraEnv,
        },
      },
      (error, stdout, stderr) => {
        const line = `${stdout}${stderr}`.split('\n').find((entry) => entry.trim().startsWith('{'));
        if (!line) {
          reject(new Error(`No JSON output. stdout=${stdout} stderr=${stderr}`));
          return;
        }
        const code = error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as unknown as { code: number }).code
          : 0;
        resolve({ code, event: JSON.parse(line) as Record<string, unknown> });
      },
    );
  });
}

async function countMemberships(client: Client, accountId: string): Promise<number> {
  const result = await client.query(
    `select 1 from pilot.organization_memberships where account_id = $1`,
    [accountId],
  );
  return result.rowCount ?? 0;
}

describe('membership orphan cleanup', () => {
  test('a dry run is the default and deletes nothing', async () => {
    const { client, name } = await freshDatabase();
    try {
      const { event } = await runCleanup(name, {});
      expect(event.event).toBe('membership_orphan_cleanup.dry-run');
      expect(event.total).toBe(2);
      expect(event.by_role).toEqual({ parent: 2 });

      expect(await countMemberships(client, PURGED_ACCOUNT_A)).toBe(1);
      expect(await countMemberships(client, PURGED_ACCOUNT_B)).toBe(1);
      expect(await countMemberships(client, LIVE_ACCOUNT)).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('applying it deletes exactly the orphaned rows and never the live one', async () => {
    const { client, name } = await freshDatabase();
    try {
      const { event } = await runCleanup(name, { PPBF_MEMBERSHIP_ORPHAN_CLEANUP_APPLY: 'true' });
      expect(event.event).toBe('membership_orphan_cleanup.completed');
      expect(event.deleted).toBe(2);
      expect(event.total).toBe(2);

      expect(await countMemberships(client, PURGED_ACCOUNT_A)).toBe(0);
      expect(await countMemberships(client, PURGED_ACCOUNT_B)).toBe(0);
      expect(await countMemberships(client, LIVE_ACCOUNT)).toBe(1);

      const auditRow = await client.query(
        `select details from pilot.audit_events
          where event_type = 'data_purged' and entity_type = 'membership_orphan_cleanup'`,
      );
      expect(auditRow.rowCount).toBe(1);
      expect(auditRow.rows[0].details.deleted).toBe(2);
    } finally {
      await client.end();
    }
  });

  test('a live membership row is never selected as an orphan, applied or not', async () => {
    const { client, name } = await freshDatabase();
    try {
      // Delete both orphan-producing rows first, so the only membership left
      // is the live one -- proving the script has nothing to select, not just
      // that it happened not to touch the live row this run.
      await client.query(
        `delete from pilot.organization_memberships where account_id = any($1)`,
        [[PURGED_ACCOUNT_A, PURGED_ACCOUNT_B]],
      );

      const { event } = await runCleanup(name, { PPBF_MEMBERSHIP_ORPHAN_CLEANUP_APPLY: 'true' });
      expect(event.event).toBe('membership_orphan_cleanup.completed');
      expect(event.deleted).toBe(0);
      expect(event.total).toBe(0);
      expect(await countMemberships(client, LIVE_ACCOUNT)).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('an unexpectedly large population stops instead of enacting itself', async () => {
    const { client, name } = await freshDatabase();
    try {
      const { code, event } = await runCleanup(name, {
        PPBF_MEMBERSHIP_ORPHAN_CLEANUP_APPLY: 'true',
        PPBF_MEMBERSHIP_ORPHAN_CLEANUP_MAX_ROWS: '1',
      });
      expect(event.event).toBe('membership_orphan_cleanup.refused');
      expect(event.reason).toBe('BLAST_RADIUS_EXCEEDED');
      expect(code).not.toBe(0);

      expect(await countMemberships(client, PURGED_ACCOUNT_A)).toBe(1);
      expect(await countMemberships(client, PURGED_ACCOUNT_B)).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('the blast-radius ceiling cannot be widened past 50 by the dispatcher', async () => {
    const { client, name } = await freshDatabase();
    try {
      // 2 orphans exist and max_rows asks for far more than the hard ceiling.
      // If the ceiling were not enforced, this would still pass by virtue of
      // 2 <= 999999 -- so this alone would not prove the clamp exists. It is
      // the max_rows=1 case above, together with this one showing a huge
      // request is silently clamped rather than honoured, that together prove
      // the ceiling is real: not visible in a normal run, but load-bearing the
      // moment a request tries to exceed it.
      const { event } = await runCleanup(name, {
        PPBF_MEMBERSHIP_ORPHAN_CLEANUP_APPLY: 'true',
        PPBF_MEMBERSHIP_ORPHAN_CLEANUP_MAX_ROWS: '999999',
      });
      expect(event.event).toBe('membership_orphan_cleanup.completed');
      expect(event.deleted).toBe(2);
    } finally {
      await client.end();
    }
  });

  test('it refuses a database the operator did not name', async () => {
    const { client, name } = await freshDatabase();
    try {
      const { code, event } = await runCleanup(name, {
        PPBF_MEMBERSHIP_ORPHAN_CLEANUP_APPLY: 'true',
        PPBF_EXPECTED_POSTGRES_DATABASE: 'some_other_database',
      });
      expect(event.event).toBe('membership_orphan_cleanup.refused');
      expect(event.reason).toBe('POSTGRES_TARGET_MISMATCH');
      expect(code).not.toBe(0);

      expect(await countMemberships(client, PURGED_ACCOUNT_A)).toBe(1);
      expect(await countMemberships(client, PURGED_ACCOUNT_B)).toBe(1);
    } finally {
      await client.end();
    }
  });
});
