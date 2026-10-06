/**
 * A purged person's SHADOW memory corrections go with them, on real
 * PostgreSQL, through both retention purge paths.
 *
 * pilot.shadow_chat_memory_corrections.corrected_value is the person's own
 * typed words ("SHADOW has this wrong about me"), possibly a child's. An
 * athlete's login outlives the athlete purge (it is retired, not deleted), so
 * the account foreign key's cascade never fired for it and the rows stayed.
 * Deletion means the person's data goes (deletion scope B).
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
const PG_DATABASE = 'ppbf_test_shadow_correction_purge';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-shadow-correction-purge-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const CLEANUP_SCRIPT = path.resolve(__dirname, '../../../scripts/pilot-cleanup-deleted-data.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-correction-purge';
const COACH_ID = 'acct-correction-purge-coach';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

let dataDeletion: typeof import('./dataDeletion');
let closePool: () => Promise<void>;

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

type PurgePath = 'script' | 'dataDeletion';

async function purgeAuditRows(): Promise<Array<{ details: { shadow_memory_corrections_deleted?: number } }>> {
  const rows = await client.query<{ details: { shadow_memory_corrections_deleted?: number } }>(
    `select details from pilot.audit_events
      where event_type = 'data_purged' and entity_type = 'retention_cleanup'
      order by created_at`,
  );
  return rows.rows;
}

/**
 * Runs one purge path and returns the count it reports for corrections. The
 * script's dry run (apply false) reports what it would delete and must roll
 * everything back.
 */
async function purge(via: PurgePath, apply = true): Promise<number> {
  if (via === 'dataDeletion') {
    // Exactly one new audit row, read as that row: never an earlier run's.
    const before = (await purgeAuditRows()).length;
    await dataDeletion.purgeExpiredDeletedData();
    const after = await purgeAuditRows();
    expect(after).toHaveLength(before + 1);
    return after[after.length - 1].details.shadow_memory_corrections_deleted ?? -1;
  }
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
        },
      },
      (error, stdout, stderr) => (error ? reject(new Error(`${stdout}${stderr}`)) : resolve(`${stdout}${stderr}`)),
    );
  });
  const line = output.split('\n').find((entry) => entry.trim().startsWith('{'));
  const event = JSON.parse(line ?? '{}') as {
    blocked_by?: Record<string, number>;
    shadow_memory_corrections_deleted?: number;
    would_delete_shadow_memory_corrections?: number;
  };
  // A purge that was refused proves nothing below.
  expect(event.blocked_by ?? {}).toEqual({});
  return (apply ? event.shadow_memory_corrections_deleted : event.would_delete_shadow_memory_corrections) ?? -1;
}

let seq = 0;

interface Seeded {
  athleteLogin: string;
  coachNowLogin: string;
  guardian: string;
  liveAthleteLogin: string;
}

async function addCorrections(accountId: string, values: Array<string | null>): Promise<void> {
  for (const value of values) {
    await client.query(
      `insert into pilot.shadow_chat_memory_corrections
         (correction_id, organization_id, account_id, fact_key, corrected_value, action)
       values (gen_random_uuid(), $1, $2, 'favorite_punch', $3, $4)`,
      [ORG_ID, accountId, value, value === null ? 'forget' : 'replace'],
    );
  }
}

async function correctionsOf(accountId: string): Promise<number> {
  const rows = await client.query(
    'select 1 from pilot.shadow_chat_memory_corrections where account_id = $1',
    [accountId],
  );
  return rows.rowCount ?? 0;
}

/*
 * An athlete deleted three years ago (past the two-year window) whose own
 * login holds corrections; a second purged athlete whose login has since
 * become a coach's (the purge unlinks it but it is that adult's now, so their
 * corrections stay); a guardian deleted eighteen months ago (past the
 * one-year window); and a live athlete who is not due, as a control.
 */
async function seed(): Promise<Seeded> {
  seq += 1;
  const purged = `ath-corr-gone-${seq}`;
  const purgedStaffNow = `ath-corr-staff-now-${seq}`;
  const live = `ath-corr-live-${seq}`;
  const athleteLogin = `acct-corr-ath-${seq}`;
  const coachNowLogin = `acct-corr-coach-now-${seq}`;
  const guardian = `acct-corr-guardian-${seq}`;
  const liveAthleteLogin = `acct-corr-live-${seq}`;

  for (const athleteId of [purged, purgedStaffNow, live]) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Correction Athlete', '2013-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [ORG_ID, athleteId, COACH_ID],
    );
  }
  for (const [accountId, role, athleteId, deleted] of [
    [athleteLogin, 'athlete', purged, "now() - interval '3 years'"],
    [coachNowLogin, 'coach', purgedStaffNow, 'null'],
    [guardian, 'parent', null, "now() - interval '18 months'"],
    [liveAthleteLogin, 'athlete', live, 'null'],
  ] as const) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, auth_provider, active_flag, deleted_at)
       values ($1, $2, $3, $4, 'ppbf_local', ${deleted} is null, ${deleted})`,
      [accountId, role, ORG_ID, athleteId],
    );
  }
  await addCorrections(athleteLogin, ["I'm 12 and my left hook is my best punch", null]);
  await addCorrections(coachNowLogin, ['jab']);
  await addCorrections(guardian, ['my son trains Tuesdays', null]);
  await addCorrections(liveAthleteLogin, ['uppercut']);
  await client.query(
    `update pilot.athletes set deleted_at = now() - interval '3 years'
      where organization_id = $1 and athlete_id = any($2::text[])`,
    [ORG_ID, [purged, purgedStaffNow]],
  );
  return { athleteLogin, coachNowLogin, guardian, liveAthleteLogin };
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
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG_ID],
  );

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

describe.each<PurgePath>(['script', 'dataDeletion'])('the %s purge', (via) => {
  test("deletes a purged athlete's and a purged guardian's SHADOW memory corrections, and no one else's", async () => {
    const people = await seed();
    // CONTROL: every correction is there before the purge.
    expect(await correctionsOf(people.athleteLogin)).toBe(2);
    expect(await correctionsOf(people.guardian)).toBe(2);

    if (via === 'script') {
      // The dry run counts them and deletes nothing.
      expect(await purge(via, false)).toBe(4);
      expect(await correctionsOf(people.athleteLogin)).toBe(2);
      expect(await correctionsOf(people.guardian)).toBe(2);
    }

    const reported = await purge(via);

    // The retired athlete login survives the purge; its corrections must not.
    const login = await client.query('select deleted_at, athlete_id from pilot.accounts where account_id = $1', [people.athleteLogin]);
    expect(login.rows[0]).toEqual(expect.objectContaining({ athlete_id: null }));
    expect(login.rows[0].deleted_at).not.toBeNull();
    expect(await correctionsOf(people.athleteLogin)).toBe(0);
    expect(await correctionsOf(people.guardian)).toBe(0);
    // The adult who now holds the athlete's old login, and a live athlete, keep theirs.
    expect(await correctionsOf(people.coachNowLogin)).toBe(1);
    expect(await correctionsOf(people.liveAthleteLogin)).toBe(1);
    expect(reported).toBe(4);

    // No row anywhere still holds the child's words.
    const words = await client.query(
      `select 1 from pilot.shadow_chat_memory_corrections where corrected_value like '%left hook%'`,
    );
    expect(words.rowCount).toBe(0);
  });
});
