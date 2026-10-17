// Real PostgreSQL test for gymSetupStatus.ts (lane L31 P5, issue #1469): every
// count the Gym Setup checklist reads runs against the schema production runs,
// counts only this gym's records, and lands on the line it names. Spins up the
// disposable local embedded Postgres the other suites use; never production.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-gym-setup-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const ORG = 'org-setup';
const OTHER_ORG = 'org-setup-other';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
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
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function emptyDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

/** The whole schema in the `all` order, which includes this migration (run before any gym exists). */
async function freshDatabase(name: string): Promise<Client> {
  const client = await emptyDatabase(name);
  await applyFullSchema(client, { infraDir: INFRA_DIR });
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

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
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

describe('Gym Setup counts against the real schema', () => {
  test('each line counts this gym only, and the counts land where they say', async () => {
    const client = await freshDatabase('gymsetup_counts');
    const saved = { url: process.env.AZURE_POSTGRES_CONNECTION_STRING, ssl: process.env.PPBF_POSTGRES_DISABLE_SSL };
    try {
      for (const org of [ORG, OTHER_ORG]) {
        await client.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [org]);
      }
      // One coach here (and one in the other gym, which must not count).
      for (const [account, org] of [['coach-here', ORG], ['coach-there', OTHER_ORG]] as const) {
        await client.query(
          `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag) values ($1, 'coach', $2, 'microsoft', true)`,
          [account, org],
        );
        await client.query(
          `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, 'coach', true)`,
          [account, org],
        );
      }
      // Two athletes here: a minor with no guardian, and an adult.
      const minorDob = new Date(Date.now() - 12 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      for (const [athlete, dob] of [['ath-minor', minorDob], ['ath-adult', '1990-01-01']] as const) {
        await client.query(
          `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
             emergency_contact, active_flag, coach_id, created_at, updated_at)
           values ($1, $2, $2, $3, 'fly', 'active', 'contact', true, 'coach-here', now(), now())`,
          [ORG, athlete, dob],
        );
      }
      // The minor's sign-in is waiting on a code; the adult has set a PIN.
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, pin_hash, active_flag)
         values ('acct-minor', 'athlete', $1, 'ppbf_local', 'ath-minor', null, false),
                ('acct-adult', 'athlete', $1, 'ppbf_local', 'ath-adult', 'hash', true)`,
        [ORG],
      );
      // An upcoming class and a cancelled one; a paired TV and a revoked one.
      await client.query(
        `insert into pilot.scheduler_classes (organization_id, class_id, title, start_at, end_at, location, capacity,
           scheduled_by_account_id, coach_account_id, status)
         values ($1, 'c-open', 'Open', now() + interval '1 day', now() + interval '1 day 1 hour', 'Floor', 10, 'coach-here', 'coach-here', 'open'),
                ($1, 'c-off', 'Off', now() + interval '2 days', now() + interval '2 days 1 hour', 'Floor', 10, 'coach-here', 'coach-here', 'cancelled')`,
        [ORG],
      );
      await client.query(
        `insert into pilot.gym_tvs (organization_id, tv_id, tv_name, device_key_hash, paired_at, revoked_at)
         values ($1, 'tv-1', 'Floor TV', 'key-1', now(), null), ($1, 'tv-2', 'Old TV', 'key-2', now(), now())`,
        [ORG],
      );

      process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor('gymsetup_counts');
      process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
      const { readGymSetupStatus } = await import('./gymSetupStatus');
      const lines = Object.fromEntries((await readGymSetupStatus(ORG)).map((line) => [line.key, line]));

      expect(lines.coaches).toMatchObject({ state: 'done', detail: '1 active coach.' });
      expect(lines.athletes).toMatchObject({ state: 'done', detail: '2 active athletes.' });
      expect(lines['athlete-sign-in']).toMatchObject({
        state: 'to_do',
        detail: '1 athlete has set a PIN; 1 is still waiting to redeem an activation code.',
      });
      expect(lines.guardians).toMatchObject({ state: 'to_do', detail: '1 athlete under 18 has no guardian on file.' });
      expect(lines.waivers).toMatchObject({ state: 'to_do', detail: '2 active athletes are missing at least one tracked waiver or consent.' });
      expect(lines.class).toMatchObject({ state: 'done', detail: '1 upcoming class.' });
      expect(lines.tv).toMatchObject({ state: 'done', detail: '1 TV is paired.' });
      for (const line of Object.values(lines)) expect(line.state).not.toBe('unavailable');

      // The other gym has a coach and nothing else.
      const other = Object.fromEntries((await readGymSetupStatus(OTHER_ORG)).map((line) => [line.key, line]));
      expect(other.coaches.detail).toBe('1 active coach.');
      expect(other.athletes.state).toBe('to_do');
      expect(other.class.state).toBe('to_do');
    } finally {
      const { closePool } = await import('./db');
      await closePool();
      for (const [name, value] of [['AZURE_POSTGRES_CONNECTION_STRING', saved.url], ['PPBF_POSTGRES_DISABLE_SSL', saved.ssl]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await client.end();
    }
  });
});
