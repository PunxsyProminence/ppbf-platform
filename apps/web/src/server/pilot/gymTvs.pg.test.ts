// Real PostgreSQL-backed suite for gym TV pairing: pilot_slice_postgres_gym_tvs_migration.sql and
// the write path in gymTvs.ts.
//
// LEADS WITH A NEGATIVE CONTROL in beforeAll: before the migration, pilot.gym_tvs does not exist.
// The migration is applied THROUGH ITS OWN RUNNER, so the readiness gate is exercised too.
//
// What needs proving here, none of which a unit test or a reading of the SQL can establish:
//   1. Only hashes are stored: the plain code and the plain key never land in the table.
//   2. A code redeems exactly once, within its life, and a wrong, expired, used or disconnected
//      code all come back as the same null.
//   3. A disconnected TV's key no longer resolves, and Disconnect clears the session on it.
//   4. The checks hold: code without expiry, run on an unpaired or disconnected TV, empty name.
//   5. Deleting a session run clears current_run_id on the TV (and only that column: PG15
//      SET NULL (column) on a composite key).
//   6. The mint budget is counted in the database; the list never carries a hash and is scoped to
//      the organization.
//
// Spins up the same disposable, local-only embedded Postgres the other migration suites use. It
// NEVER connects to production or staging.
import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import {
  GymTvError,
  PAIR_CODE_MINT_LIMIT,
  disconnectGymTv,
  listGymTvs,
  mintGymTvPairCode,
  redeemGymTvPairCode,
  resolveGymTvByDeviceKey,
} from './gymTvs';
import { hashToken } from './security';

jest.setTimeout(180_000);

let activeClient: Client | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows[0] ?? null;
  }),
  // Each transaction gets its OWN connection from a small pool, so two module calls started with
  // Promise.all really do run as two concurrent transactions against the row locks under test.
  // A single shared client would serialize them and prove nothing about the race.
  withTransaction: jest.fn(async (fn: (c: Client) => Promise<unknown>) => {
    const tx = await acquireTxClient();
    try {
      await tx.query('begin');
      try {
        const out = await fn(tx);
        await tx.query('commit');
        return out;
      } catch (error) {
        await tx.query('rollback');
        throw error;
      }
    } finally {
      releaseTxClient(tx);
    }
  }),
}));

const TX_POOL_SIZE = 8;
const txIdle: Client[] = [];
const txAll: Client[] = [];
const txWaiters: Array<(c: Client) => void> = [];
async function acquireTxClient(): Promise<Client> {
  const idle = txIdle.pop();
  if (idle) return idle;
  if (txAll.length < TX_POOL_SIZE) {
    const c = new Client({ connectionString: connectionStringFor('ppbf_test_gym_tvs') });
    await c.connect();
    txAll.push(c);
    return c;
  }
  return new Promise<Client>((resolve) => txWaiters.push(resolve));
}
function releaseTxClient(c: Client): void {
  const waiter = txWaiters.shift();
  if (waiter) waiter(c);
  else txIdle.push(c);
}

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-gym-tvs-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const PREREQUISITES = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_drill_library_v3_migration.sql',
  'pilot_slice_postgres_session_scripts_migration.sql',
  'pilot_slice_postgres_session_run_state_migration.sql',
];
const MIGRATION_FILE = 'pilot_slice_postgres_gym_tvs_migration.sql';
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-gym-tvs-migration.mjs');

const ORG_A = 'org-tv-a';
const ORG_B = 'org-tv-b';
const COACH_A = 'acct-tv-coach-a';
const COACH_B = 'acct-tv-coach-b';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigration: (client: Client, sql: string) => Promise<void>;
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
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
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

  const prerequisiteSql = await Promise.all(
    PREREQUISITES.map((file) => fs.readFile(path.join(INFRA_DIR, file), 'utf8')),
  );
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
  const runner = await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href);
  applyMigration = runner.applyMigrationTransaction as (c: Client, sql: string) => Promise<void>;

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query('drop database if exists ppbf_test_gym_tvs');
  await admin.query('create database ppbf_test_gym_tvs');
  await admin.end();

  client = new Client({ connectionString: connectionStringFor('ppbf_test_gym_tvs') });
  await client.connect();
  for (const sql of prerequisiteSql) {
    await client.query(sql);
  }

  // NEGATIVE CONTROL: no table before the migration.
  await expect(client.query('select 1 from pilot.gym_tvs')).rejects.toThrow(/gym_tvs/);

  await applyMigration(client, migrationSql);
  // Idempotent: a second application passes its own gate.
  await applyMigration(client, migrationSql);

  for (const [org, coach] of [[ORG_A, COACH_A], [ORG_B, COACH_B]]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1,$1,'active') on conflict do nothing`,
      [org],
    );
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1,'coach',$2,'microsoft') on conflict do nothing`,
      [coach, org],
    );
  }

  activeClient = client;
});

afterAll(async () => {
  activeClient = null;
  await Promise.all(txAll.map((c) => c.end()));
  if (client) await client.end();
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(safetyTimer);
      resolve();
    };
    const safetyTimer = setTimeout(finish, 10_000);
    serverProcess.once('exit', finish);
    serverProcess.kill('SIGTERM');
  });
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.query('delete from pilot.gym_tvs');
  await client.query('delete from pilot.session_script_runs');
  await client.query('delete from pilot.session_script_blocks');
  await client.query('delete from pilot.session_scripts');
});

async function readTv(tvId: string) {
  const r = await client.query(
    `select * from pilot.gym_tvs where tv_id = $1`,
    [tvId],
  );
  return r.rows[0];
}

async function seedLiveRun(org: string, coach: string, runId: string): Promise<void> {
  await client.query(
    `insert into pilot.session_scripts (organization_id, script_id, lineage_id, version, name, created_by_account_id)
     values ($1,$2,$2,1,$2,$3)`,
    [org, `scr-${runId}`, coach],
  );
  await client.query(
    `insert into pilot.session_script_blocks
       (organization_id, block_id, script_id, block_order, start_offset_min, end_offset_min, block_label, what_to_say)
     values ($1,$2,$3,1,0,10,'block 1','cue')`,
    [org, `blk-${runId}`, `scr-${runId}`],
  );
  await client.query(
    `insert into pilot.session_script_runs
       (organization_id, run_id, script_id, script_version, delivered_by_account_id, delivered_on,
        run_state, started_at, current_block_id, paused_seconds)
     values ($1,$2,$3,1,$4,current_date,'in_progress',now(),$5,0)`,
    [org, runId, `scr-${runId}`, coach, `blk-${runId}`],
  );
}

async function pairedTv(org = ORG_A, coach = COACH_A, name = 'Gym main') {
  const minted = await mintGymTvPairCode(org, coach, name);
  const redeemed = await redeemGymTvPairCode(minted.code);
  if (!redeemed) throw new Error('test bug: pairing failed');
  return { minted, redeemed };
}

describe('minting a code', () => {
  it('stores only the hash of the code, with its expiry, and no key yet', async () => {
    const minted = await mintGymTvPairCode(ORG_A, COACH_A, '  House  ');
    expect(minted.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(minted.tv_name).toBe('House');
    const row = await readTv(minted.tv_id);
    expect(row.pair_code_hash).toBe(hashToken(minted.code));
    expect(row.pair_code_hash).not.toBe(minted.code);
    expect(row.pair_code_expires_at).not.toBeNull();
    expect(row.device_key_hash).toBeNull();
    expect(row.paired_at).toBeNull();
    expect(row.created_by_account_id).toBe(COACH_A);
    // Nowhere in the row is the plain code.
    expect(JSON.stringify(row)).not.toContain(minted.code);
  });

  it('refuses an empty or over-long name, and a non-string', async () => {
    await expect(mintGymTvPairCode(ORG_A, COACH_A, '   ')).rejects.toMatchObject({ status: 400, code: 'TV_NAME_LENGTH' });
    await expect(mintGymTvPairCode(ORG_A, COACH_A, 'x'.repeat(61))).rejects.toMatchObject({ status: 400 });
    await expect(mintGymTvPairCode(ORG_A, COACH_A, 42)).rejects.toMatchObject({ status: 400, code: 'TV_NAME_REQUIRED' });
    expect((await client.query('select count(*)::int as n from pilot.gym_tvs')).rows[0].n).toBe(0);
  });

  it('budgets codes per coach in the database', async () => {
    for (let i = 0; i < PAIR_CODE_MINT_LIMIT; i += 1) {
      await mintGymTvPairCode(ORG_A, COACH_A, `TV ${i}`);
    }
    await expect(mintGymTvPairCode(ORG_A, COACH_A, 'one more')).rejects.toMatchObject({
      status: 429,
      code: 'TV_PAIR_CODE_RATE_LIMITED',
    });
    // Another coach's budget is their own -- in the same gym, not only in another one.
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ('acct-tv-coach-a2','coach',$1,'microsoft') on conflict do nothing`,
      [ORG_A],
    );
    await expect(mintGymTvPairCode(ORG_A, 'acct-tv-coach-a2', 'A2 TV')).resolves.toBeDefined();
    await expect(mintGymTvPairCode(ORG_B, COACH_B, 'B TV')).resolves.toBeDefined();
  });

  it('the budget holds under parallel requests (advisory lock): exactly the limit succeed', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: PAIR_CODE_MINT_LIMIT + 3 }, (_, i) => mintGymTvPairCode(ORG_A, COACH_A, `P ${i}`)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(PAIR_CODE_MINT_LIMIT);
    const stored = await client.query('select count(*)::int as n from pilot.gym_tvs where created_by_account_id = $1', [COACH_A]);
    expect(stored.rows[0].n).toBe(PAIR_CODE_MINT_LIMIT);
  });

  it('the error type carries status and code for jsonError', async () => {
    try {
      await mintGymTvPairCode(ORG_A, COACH_A, '');
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(GymTvError);
    }
  });
});

describe('redeeming a code', () => {
  it('issues a key, stores only its hash, clears the code, and marks paired', async () => {
    const { minted, redeemed } = await pairedTv();
    expect(redeemed.organization_id).toBe(ORG_A);
    expect(redeemed.tv_id).toBe(minted.tv_id);
    expect(redeemed.tv_name).toBe('Gym main');
    expect(redeemed.device_key).toMatch(/^[0-9a-f]{64}$/);
    const row = await readTv(minted.tv_id);
    expect(row.device_key_hash).toBe(hashToken(redeemed.device_key));
    expect(row.pair_code_hash).toBeNull();
    expect(row.pair_code_expires_at).toBeNull();
    expect(row.paired_at).not.toBeNull();
    expect(row.last_seen_at).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(redeemed.device_key);
    expect(JSON.stringify(row)).not.toContain(minted.code);
  });

  it('accepts the code with spaces, dashes and lower case, as a remote might send it', async () => {
    const minted = await mintGymTvPairCode(ORG_A, COACH_A, 'Gym main');
    const typed = `${minted.code.slice(0, 3).toLowerCase()}-${minted.code.slice(3)} `;
    expect(await redeemGymTvPairCode(typed)).not.toBeNull();
  });

  it('is single use: the second redemption of the same code is null', async () => {
    const { minted } = await pairedTv();
    expect(await redeemGymTvPairCode(minted.code)).toBeNull();
  });

  it('two TVs typing the same code at once: exactly one is paired (row lock + re-check)', async () => {
    const minted = await mintGymTvPairCode(ORG_A, COACH_A, 'Gym main');
    const [first, second] = await Promise.all([
      redeemGymTvPairCode(minted.code),
      redeemGymTvPairCode(minted.code),
    ]);
    const winners = [first, second].filter((r) => r !== null);
    expect(winners.length).toBe(1);
    const row = await readTv(minted.tv_id);
    expect(row.device_key_hash).toBe(hashToken(winners[0]!.device_key));
  });

  it('a wrong code, a malformed code and an unknown code are all null', async () => {
    await mintGymTvPairCode(ORG_A, COACH_A, 'Gym main');
    expect(await redeemGymTvPairCode('AAAAAA')).toBeNull();
    expect(await redeemGymTvPairCode('ABC')).toBeNull();
    expect(await redeemGymTvPairCode('')).toBeNull();
    expect((await client.query('select count(*)::int as n from pilot.gym_tvs where device_key_hash is not null')).rows[0].n).toBe(0);
  });

  it('an expired code is null', async () => {
    const minted = await mintGymTvPairCode(ORG_A, COACH_A, 'Gym main');
    await client.query(
      `update pilot.gym_tvs set pair_code_expires_at = now() - interval '1 second' where tv_id = $1`,
      [minted.tv_id],
    );
    expect(await redeemGymTvPairCode(minted.code)).toBeNull();
  });

  it('a code for a TV disconnected before it was typed is null', async () => {
    const minted = await mintGymTvPairCode(ORG_A, COACH_A, 'Gym main');
    await disconnectGymTv(ORG_A, minted.tv_id);
    expect(await redeemGymTvPairCode(minted.code)).toBeNull();
  });
});

describe('resolving a TV by its key', () => {
  it('finds the paired TV and touches last_seen_at', async () => {
    const { minted, redeemed } = await pairedTv();
    await client.query(`update pilot.gym_tvs set last_seen_at = now() - interval '1 day' where tv_id = $1`, [minted.tv_id]);
    const before = (await readTv(minted.tv_id)).last_seen_at as Date;
    const tv = await resolveGymTvByDeviceKey(redeemed.device_key);
    expect(tv).toMatchObject({ organization_id: ORG_A, tv_id: minted.tv_id, tv_name: 'Gym main', current_run_id: null });
    expect(JSON.stringify(tv)).not.toContain('hash');
    const after = (await readTv(minted.tv_id)).last_seen_at as Date;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('an unknown key, an empty key and a disconnected TV all resolve to null', async () => {
    const { minted, redeemed } = await pairedTv();
    expect(await resolveGymTvByDeviceKey('not-a-key')).toBeNull();
    expect(await resolveGymTvByDeviceKey('')).toBeNull();
    await disconnectGymTv(ORG_A, minted.tv_id);
    expect(await resolveGymTvByDeviceKey(redeemed.device_key)).toBeNull();
  });

  it('two paired TVs cannot share a key hash (unique index)', async () => {
    const a = await pairedTv(ORG_A, COACH_A, 'A');
    const b = await pairedTv(ORG_A, COACH_A, 'B');
    const aHash = (await readTv(a.minted.tv_id)).device_key_hash;
    await expect(
      client.query(`update pilot.gym_tvs set device_key_hash = $1 where tv_id = $2`, [aHash, b.minted.tv_id]),
    ).rejects.toThrow(/pilot_gym_tvs_device_key_uidx/);
  });
});

describe('disconnect and the Paired TVs list', () => {
  it('disconnect marks the row, clears the session on it, keeps the row, and is idempotent', async () => {
    const { minted } = await pairedTv();
    await seedLiveRun(ORG_A, COACH_A, 'run-1');
    await client.query(
      `update pilot.gym_tvs set current_run_id = 'run-1', current_run_set_by_account_id = $2 where tv_id = $1`,
      [minted.tv_id, COACH_A],
    );
    const first = await disconnectGymTv(ORG_A, minted.tv_id);
    expect(first.status).toBe('disconnected');
    expect(first.current_run_id).toBeNull();
    const row = await readTv(minted.tv_id);
    expect(row.revoked_at).not.toBeNull();
    expect(row.current_run_id).toBeNull();
    const second = await disconnectGymTv(ORG_A, minted.tv_id);
    expect(second.revoked_at).toEqual(first.revoked_at);
  });

  it('a TV in another organization is a 404, and stays connected', async () => {
    const { minted, redeemed } = await pairedTv();
    await expect(disconnectGymTv(ORG_B, minted.tv_id)).rejects.toMatchObject({ status: 404, code: 'TV_NOT_FOUND' });
    expect(await resolveGymTvByDeviceKey(redeemed.device_key)).not.toBeNull();
  });

  it('the list is per organization, carries status, and never a hash', async () => {
    await pairedTv(ORG_A, COACH_A, 'Gym main');
    const pending = await mintGymTvPairCode(ORG_A, COACH_A, 'House');
    const expired = await mintGymTvPairCode(ORG_A, COACH_A, 'Old');
    await client.query(`update pilot.gym_tvs set pair_code_expires_at = now() - interval '1 second' where tv_id = $1`, [expired.tv_id]);
    const gone = await pairedTv(ORG_A, COACH_A, 'Gone');
    await disconnectGymTv(ORG_A, gone.minted.tv_id);
    await pairedTv(ORG_B, COACH_B, 'Other gym');

    const list = await listGymTvs(ORG_A);
    expect(list.map((t) => [t.tv_name, t.status]).sort()).toEqual([
      ['Gone', 'disconnected'],
      ['Gym main', 'paired'],
      ['House', 'pending'],
      ['Old', 'expired'],
    ]);
    expect(list.find((t) => t.tv_name === 'House')?.pair_code_expires_at).not.toBeNull();
    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain('hash');
    expect(serialized).not.toContain(pending.code);
    expect(serialized).not.toContain('Other gym');
    // Disconnected rows sort last.
    expect(list[list.length - 1].tv_name).toBe('Gone');
  });
});

describe('the checks and the run FK', () => {
  it('a code must carry its expiry, and a paired row holds no code', async () => {
    await expect(
      client.query(
        `insert into pilot.gym_tvs (organization_id, tv_id, tv_name, pair_code_hash) values ($1,'tv-x','x','h')`,
        [ORG_A],
      ),
    ).rejects.toThrow(/pilot_gym_tvs_code_with_expiry/);
    const { minted } = await pairedTv();
    await expect(
      client.query(
        `update pilot.gym_tvs set pair_code_hash = 'h', pair_code_expires_at = now() + interval '5 minutes' where tv_id = $1`,
        [minted.tv_id],
      ),
    ).rejects.toThrow(/pilot_gym_tvs_paired_xor_pending/);
  });

  it('a session cannot be sent to an unpaired or a disconnected TV', async () => {
    await seedLiveRun(ORG_A, COACH_A, 'run-1');
    const pending = await mintGymTvPairCode(ORG_A, COACH_A, 'Pending');
    await expect(
      client.query(`update pilot.gym_tvs set current_run_id = 'run-1' where tv_id = $1`, [pending.tv_id]),
    ).rejects.toThrow(/pilot_gym_tvs_run_only_when_paired/);
    const { minted } = await pairedTv();
    await disconnectGymTv(ORG_A, minted.tv_id);
    await expect(
      client.query(`update pilot.gym_tvs set current_run_id = 'run-1' where tv_id = $1`, [minted.tv_id]),
    ).rejects.toThrow(/pilot_gym_tvs_run_only_when_paired/);
  });

  it("a TV cannot point at another organization's run, and deleting the run clears only current_run_id", async () => {
    const { minted } = await pairedTv();
    await seedLiveRun(ORG_B, COACH_B, 'run-b');
    await expect(
      client.query(`update pilot.gym_tvs set current_run_id = 'run-b' where tv_id = $1`, [minted.tv_id]),
    ).rejects.toThrow(/pilot_gym_tvs_current_run_fk/);

    await seedLiveRun(ORG_A, COACH_A, 'run-a');
    await client.query(
      `update pilot.gym_tvs set current_run_id = 'run-a', current_run_set_by_account_id = $2 where tv_id = $1`,
      [minted.tv_id, COACH_A],
    );
    await client.query(`delete from pilot.session_script_runs where run_id = 'run-a'`);
    const row = await readTv(minted.tv_id);
    expect(row.current_run_id).toBeNull();
    expect(row.organization_id).toBe(ORG_A);
    expect(row.device_key_hash).not.toBeNull();
  });

  it('an empty name is refused by the table too', async () => {
    await expect(
      client.query(`insert into pilot.gym_tvs (organization_id, tv_id, tv_name) values ($1,'tv-x','   ')`, [ORG_A]),
    ).rejects.toThrow(/pilot_gym_tvs_name_present/);
  });

  it('purging the coach who paired a TV leaves the TV paired', async () => {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ('acct-tv-temp','coach',$1,'microsoft')`,
      [ORG_A],
    );
    const { minted, redeemed } = await pairedTv(ORG_A, 'acct-tv-temp', 'Temp');
    await client.query(`delete from pilot.accounts where account_id = 'acct-tv-temp'`);
    const row = await readTv(minted.tv_id);
    expect(row.created_by_account_id).toBeNull();
    expect(await resolveGymTvByDeviceKey(redeemed.device_key)).not.toBeNull();
  });
});

describe("the runner's readiness gate", () => {
  it('refuses a database without the device-key unique index, and rolls back', async () => {
    await expect(
      applyMigration(client, `${migrationSql}\ndrop index pilot.pilot_gym_tvs_device_key_uidx;`),
    ).rejects.toThrow(/GYM_TVS_NOT_READY/);
    const idx = await client.query(
      `select 1 from pg_indexes where schemaname = 'pilot' and indexname = 'pilot_gym_tvs_device_key_uidx'`,
    );
    expect(idx.rows.length).toBe(1);
  });

  it('refuses a database without the run-only-when-paired check', async () => {
    await expect(
      applyMigration(
        client,
        `${migrationSql}\nalter table pilot.gym_tvs drop constraint pilot_gym_tvs_run_only_when_paired;`,
      ),
    ).rejects.toThrow(/GYM_TVS_NOT_READY/);
    const c = await client.query(
      `select 1 from pg_constraint where conname = 'pilot_gym_tvs_run_only_when_paired'`,
    );
    expect(c.rows.length).toBe(1);
  });
});
