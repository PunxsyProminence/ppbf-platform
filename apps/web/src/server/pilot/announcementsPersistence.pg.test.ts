// Real PostgreSQL-backed test for announcements.ts.
//
// pilot.announcements only just became migration-owned (#111 removed the
// request-path DDL that used to create it), and the schema-ownership test
// that guards against the DDL's return is textual. This suite proves the
// module's real INSERT/SELECT against base schema + announcements migration,
// per the post-#89 real-SQL policy (audit finding F2) — including the limit
// clamp, which is interpolated rather than bound and deserves execution.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-announce-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_announcements';

const ORG_A = 'org-ann-a';
const ORG_B = 'org-ann-b';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let announcements: typeof import('./announcements');

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
  // Like the volunteer-program runner, the announcements runner opens the
  // transaction itself; the SQL file carries no boundaries of its own.
  await migrateClient.query(
    await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_announcements_migration.sql'), 'utf8'),
  );
  for (const orgId of [ORG_A, ORG_B]) {
    await migrateClient.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [orgId],
    );
  }
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  announcements = await import('./announcements');
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

describe('announcements.ts against the real schema', () => {
  test('createAnnouncement persists and listAnnouncements returns newest first', async () => {
    const first = await announcements.createAnnouncement({
      organizationId: ORG_A,
      message: 'Gym closed Friday for ring maintenance.',
      authorName: 'Coach A',
      authorRole: 'coach',
    });
    expect(first.announcement_id).toMatch(/^[0-9a-f-]{36}$/);

    // A later row must sort before the first; created_at has now() default
    // resolution finer than this test's two inserts on most systems, but the
    // module orders by created_at desc, so force distinct timestamps.
    await new Promise((resolve) => setTimeout(resolve, 25));
    await announcements.createAnnouncement({
      organizationId: ORG_A,
      message: 'New heavy bags arrive Monday.',
      authorName: 'Board Secretary',
      authorRole: 'board-secretary',
    });

    const listed = await announcements.listAnnouncements(ORG_A);
    expect(listed.map((a) => a.message)).toEqual([
      'New heavy bags arrive Monday.',
      'Gym closed Friday for ring maintenance.',
    ]);
  });

  test('reads are organization-scoped', async () => {
    expect(await announcements.listAnnouncements(ORG_B)).toEqual([]);
  });

  test('the limit clamp holds at the SQL level', async () => {
    for (let i = 0; i < 30; i += 1) {
      await announcements.createAnnouncement({
        organizationId: ORG_B,
        message: `Notice ${i}`,
        authorName: 'Admin',
        authorRole: 'admin',
      });
    }
    // Requests above the clamp return at most 25; nonsense values fall back
    // to the default of 8.
    expect((await announcements.listAnnouncements(ORG_B, 1000)).length).toBe(25);
    expect((await announcements.listAnnouncements(ORG_B, Number.NaN)).length).toBe(8);
    expect((await announcements.listAnnouncements(ORG_B, 1)).length).toBe(1);
  });
});
