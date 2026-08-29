import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { Client } from 'pg';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module. Building it through Function keeps a real dynamic import
   in the emitted code, honored under --experimental-vm-modules. Same
   convention as membershipAccountFk.pg.test.ts. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-membership-orphan-check-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const CHECK_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/pilot-check-membership-orphans.mjs');

const ORG_ID = 'org-membership-orphan-check';
const PURGED_ACCOUNT = 'withdrawn.parent@example.test';
const LIVE_ACCOUNT = 'active.coach@example.test';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
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

/**
 * The exact shape membershipAccountFk.pg.test.ts proves the retention purge
 * leaves behind: an organization_memberships row whose account_id survives
 * a hard `delete from pilot.accounts`, because that table has never had a
 * foreign key on this column and the purge script has no statement that
 * touches it. Built the same way here, plus one live account+membership as
 * the negative case this check must not flag.
 */
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
     values ($1, $1, 'active')`,
    [ORG_ID],
  );

  // The purged parent: account + membership, then the account is
  // hard-deleted the way pilot-cleanup-deleted-data.mjs does it, leaving
  // the membership row orphaned.
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'parent', $2, 'microsoft')`,
    [PURGED_ACCOUNT, ORG_ID],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, 'parent', true)`,
    [PURGED_ACCOUNT, ORG_ID],
  );
  await client.query('delete from pilot.accounts where account_id = $1', [PURGED_ACCOUNT]);

  // The negative case: a live account with a matching membership row.
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

  return client;
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

describe('membership orphan check', () => {
  it('reports exactly the orphaned row, never the live one, and never a raw account_id', async () => {
    const client = await freshDatabase('ppbf_test_membership_orphan_check');
    try {
      const checkModule = await nativeDynamicImport(CHECK_SCRIPT_PATH) as {
        checkMembershipOrphans: (client: Client) => Promise<{
          total: number;
          rows: Array<{ organization_id: string; role: string; account_id: string }>;
          truncated: boolean;
          purgeHistory: { purge_runs: number; accounts_ever_purged: number };
        }>;
        maskAccountId: (accountId: string) => string;
      };

      const result = await checkModule.checkMembershipOrphans(client);

      expect(result.total).toBe(1);
      expect(result.truncated).toBe(false);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].organization_id).toBe(ORG_ID);
      expect(result.rows[0].role).toBe('parent');
      // The live account's row must never appear as an orphan.
      expect(result.rows.every((row) => row.account_id !== LIVE_ACCOUNT)).toBe(true);

      // The mask never reveals the local part beyond its first character,
      // and never returns the input unchanged.
      const masked = checkModule.maskAccountId(result.rows[0].account_id);
      expect(masked).not.toBe(PURGED_ACCOUNT);
      expect(masked.startsWith('w')).toBe(true);
      expect(masked).toContain('@example.test');
      expect(masked).not.toContain('withdrawn.parent');
    } finally {
      await client.end();
    }
  });

  it('reports clean when every membership row resolves to a live account', async () => {
    const client = await freshDatabase('ppbf_test_membership_orphan_check');
    try {
      // Delete the orphan-producing membership row too, so nothing is
      // orphaned in this database.
      await client.query(
        `delete from pilot.organization_memberships where account_id = $1`,
        [PURGED_ACCOUNT],
      );

      const checkModule = await nativeDynamicImport(CHECK_SCRIPT_PATH) as {
        checkMembershipOrphans: (client: Client) => Promise<{ total: number }>;
      };
      const result = await checkModule.checkMembershipOrphans(client);
      expect(result.total).toBe(0);
    } finally {
      await client.end();
    }
  });
});
