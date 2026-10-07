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
//   7. (S2b) Sending a session to a TV: only the caller's own live, shown run; one session per TV;
//      another coach's live session on the TV is refused; a TV in another gym is a 404.
//   8. (S2b) The TV read: a revoked or disconnected TV gets nothing; a TV in another organization
//      gets nothing; the serialized body never carries a field outside the allowlist -- in
//      particular the coach's notes (what_to_say and friends), seeded on every block here so a leak
//      would show; nothing on the TV once the run has ended or been switched off.
//   9. (S2b) Re-pairing revokes the row the TV's previous key named.
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
  GYM_TV_BLOCK_FIELDS,
  GYM_TV_SESSION_FIELDS,
  GymTvError,
  PAIR_CODE_MINT_LIMIT,
  disconnectGymTv,
  listGymTvs,
  mintGymTvPairCode,
  readGymTvSession,
  redeemGymTvPairCode,
  resolveGymTvByDeviceKey,
  sendRunToGymTv,
  takeRunOffGymTv,
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
  // show_on_wall: the TV read and the in-use check read it (S2b).
  'pilot_slice_postgres_session_run_show_on_wall_migration.sql',
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
  await client.query('delete from pilot.drill_library');
});

async function readTv(tvId: string) {
  const r = await client.query(
    `select * from pilot.gym_tvs where tv_id = $1`,
    [tvId],
  );
  return r.rows[0];
}

// Every seeded block carries the coach's four notes, each a distinct marker string, so a leak of
// any of them into the TV payload is caught by the serialized-body assertions below.
const COACH_NOTE_MARKERS = ['SAY-MARKER', 'EXPLAIN-MARKER', 'WATCH-MARKER', 'FIX-MARKER'] as const;

async function seedLiveRun(
  org: string,
  coach: string,
  runId: string,
  options: { showOnWall?: boolean; blocks?: number } = {},
): Promise<void> {
  const showOnWall = options.showOnWall ?? false;
  const blockCount = options.blocks ?? 1;
  await client.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, name, category, target_behavior, purpose,
        standard_setup, execution, what_good_looks_like, what_bad_looks_like)
     values ($1,$2,$2,$3,'defence','slip','p','s','e','g','b')
     on conflict do nothing`,
    [org, `drl-${runId}`, `Drill for ${runId}`],
  );
  await client.query(
    `insert into pilot.session_scripts (organization_id, script_id, lineage_id, version, name, total_minutes, created_by_account_id)
     values ($1,$2,$2,1,$3,$4,$5)`,
    [org, `scr-${runId}`, `Script ${runId}`, blockCount * 10, coach],
  );
  for (let i = 1; i <= blockCount; i += 1) {
    await client.query(
      `insert into pilot.session_script_blocks
         (organization_id, block_id, script_id, block_order, start_offset_min, end_offset_min, block_label,
          what_to_say, what_to_explain, what_to_watch, what_to_fix, block_kind, drill_id, scale_level)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'drill_round',$12,'B')`,
      [
        org,
        i === 1 ? `blk-${runId}` : `blk-${runId}-${i}`,
        `scr-${runId}`,
        i,
        (i - 1) * 10,
        i * 10,
        `Block ${i} of ${runId}`,
        ...COACH_NOTE_MARKERS,
        `drl-${runId}`,
      ],
    );
  }
  await client.query(
    `insert into pilot.session_script_runs
       (organization_id, run_id, script_id, script_version, delivered_by_account_id, delivered_on,
        run_state, started_at, current_block_id, paused_seconds, show_on_wall)
     values ($1,$2,$3,1,$4,current_date,'in_progress',now(),$5,0,$6)`,
    [org, runId, `scr-${runId}`, coach, `blk-${runId}`, showOnWall],
  );
}

async function settleRun(runId: string): Promise<void> {
  // The same shape finishSessionScriptRun writes: settled, off the TV, cursor cleared.
  await client.query(
    `update pilot.session_script_runs
        set run_state = 'completed', ended_at = now(), current_block_id = null, show_on_wall = false
      where run_id = $1`,
    [runId],
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

  // disconnectGymTv also clears the code, so the test above cannot tell whether redeem looks at
  // revoked_at at all (mutant M2 survived it). Here revoked_at is set with the code left in place,
  // so revoked_at is the only thing standing between the code and a key. The state is synthetic on
  // purpose: no current code path leaves a code on a disconnected row.
  it('revoked_at alone refuses the code, even while the code is still stored', async () => {
    const minted = await mintGymTvPairCode(ORG_A, COACH_A, 'Gym main');
    await client.query(`update pilot.gym_tvs set revoked_at = now() where tv_id = $1`, [minted.tv_id]);
    const before = await readTv(minted.tv_id);
    expect(before.pair_code_hash).toBe(hashToken(minted.code));
    expect(before.revoked_at).not.toBeNull();

    expect(await redeemGymTvPairCode(minted.code)).toBeNull();

    const after = await readTv(minted.tv_id);
    expect(after.device_key_hash).toBeNull();
    expect(after.paired_at).toBeNull();
    expect(after.pair_code_hash).toBe(hashToken(minted.code));
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

describe('sending a session to a TV (S2b, coach side)', () => {
  it("sends the caller's own live, shown run; the pointer and set_by are written together", async () => {
    const { minted } = await pairedTv();
    await seedLiveRun(ORG_A, COACH_A, 'run-1', { showOnWall: true });
    const tv = await sendRunToGymTv(ORG_A, COACH_A, minted.tv_id, 'run-1');
    expect(tv.current_run_id).toBe('run-1');
    expect(tv.current_run_set_by_account_id).toBe(COACH_A);
    expect(tv.status).toBe('paired');
    const row = await readTv(minted.tv_id);
    expect(row.current_run_id).toBe('run-1');
    expect(row.current_run_set_by_account_id).toBe(COACH_A);
    // Re-sending the same run is a no-op success.
    expect((await sendRunToGymTv(ORG_A, COACH_A, minted.tv_id, 'run-1')).current_run_id).toBe('run-1');
  });

  it("another coach's run is the same 404 as a missing one, and nothing is written", async () => {
    const { minted } = await pairedTv();
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ('acct-tv-coach-a2','coach',$1,'microsoft') on conflict do nothing`,
      [ORG_A],
    );
    await seedLiveRun(ORG_A, 'acct-tv-coach-a2', 'run-other', { showOnWall: true });
    await expect(sendRunToGymTv(ORG_A, COACH_A, minted.tv_id, 'run-other')).rejects.toMatchObject({ status: 404, code: 'SESSION_RUN_NOT_FOUND' });
    await expect(sendRunToGymTv(ORG_A, COACH_A, minted.tv_id, 'run-missing')).rejects.toMatchObject({ status: 404, code: 'SESSION_RUN_NOT_FOUND' });
    expect((await readTv(minted.tv_id)).current_run_id).toBeNull();
  });

  it('a run that is not live, or not switched on with Show on TV, is refused', async () => {
    const { minted } = await pairedTv();
    await seedLiveRun(ORG_A, COACH_A, 'run-off', { showOnWall: false });
    await expect(sendRunToGymTv(ORG_A, COACH_A, minted.tv_id, 'run-off')).rejects.toMatchObject({ status: 409, code: 'SESSION_RUN_NOT_ON_TV' });
    await settleRun('run-off');
    await expect(sendRunToGymTv(ORG_A, COACH_A, minted.tv_id, 'run-off')).rejects.toMatchObject({ status: 409, code: 'SESSION_RUN_NOT_LIVE' });
    expect((await readTv(minted.tv_id)).current_run_id).toBeNull();
  });

  it('a pending or disconnected TV is refused, and a TV in another organization is a 404', async () => {
    await seedLiveRun(ORG_A, COACH_A, 'run-1', { showOnWall: true });
    const pending = await mintGymTvPairCode(ORG_A, COACH_A, 'Pending');
    await expect(sendRunToGymTv(ORG_A, COACH_A, pending.tv_id, 'run-1')).rejects.toMatchObject({ status: 409, code: 'TV_NOT_PAIRED' });
    const { minted } = await pairedTv();
    await disconnectGymTv(ORG_A, minted.tv_id);
    await expect(sendRunToGymTv(ORG_A, COACH_A, minted.tv_id, 'run-1')).rejects.toMatchObject({ status: 409, code: 'TV_NOT_PAIRED' });
    const other = await pairedTv(ORG_B, COACH_B, 'Other gym');
    await expect(sendRunToGymTv(ORG_A, COACH_A, other.minted.tv_id, 'run-1')).rejects.toMatchObject({ status: 404, code: 'TV_NOT_FOUND' });
    expect((await readTv(other.minted.tv_id)).current_run_id).toBeNull();
  });

  it("one session per TV: a TV showing another coach's live session is TV_IN_USE until that run ends or is switched off", async () => {
    const { minted } = await pairedTv();
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ('acct-tv-coach-a2','coach',$1,'microsoft') on conflict do nothing`,
      [ORG_A],
    );
    await seedLiveRun(ORG_A, COACH_A, 'run-a', { showOnWall: true });
    await seedLiveRun(ORG_A, 'acct-tv-coach-a2', 'run-a2', { showOnWall: true });
    await sendRunToGymTv(ORG_A, COACH_A, minted.tv_id, 'run-a');

    await expect(sendRunToGymTv(ORG_A, 'acct-tv-coach-a2', minted.tv_id, 'run-a2')).rejects.toMatchObject({ status: 409, code: 'TV_IN_USE' });
    await expect(takeRunOffGymTv(ORG_A, 'acct-tv-coach-a2', minted.tv_id)).rejects.toMatchObject({ status: 409, code: 'TV_IN_USE' });
    expect((await readTv(minted.tv_id)).current_run_id).toBe('run-a');

    // Coach A switches it off the TV: the TV is free, and the stale pointer is replaced.
    await client.query(`update pilot.session_script_runs set show_on_wall = false where run_id = 'run-a'`);
    const taken = await sendRunToGymTv(ORG_A, 'acct-tv-coach-a2', minted.tv_id, 'run-a2');
    expect(taken.current_run_id).toBe('run-a2');
    expect(taken.current_run_set_by_account_id).toBe('acct-tv-coach-a2');

    // And once that run ends, anyone on staff may clear the leftover pointer.
    await settleRun('run-a2');
    const cleared = await takeRunOffGymTv(ORG_A, COACH_A, minted.tv_id);
    expect(cleared.current_run_id).toBeNull();
    expect(cleared.current_run_set_by_account_id).toBeNull();
  });

  it('two coaches sending to the same TV at once: exactly one wins (row lock)', async () => {
    const { minted } = await pairedTv();
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ('acct-tv-coach-a2','coach',$1,'microsoft') on conflict do nothing`,
      [ORG_A],
    );
    await seedLiveRun(ORG_A, COACH_A, 'run-a', { showOnWall: true });
    await seedLiveRun(ORG_A, 'acct-tv-coach-a2', 'run-a2', { showOnWall: true });
    const results = await Promise.allSettled([
      sendRunToGymTv(ORG_A, COACH_A, minted.tv_id, 'run-a'),
      sendRunToGymTv(ORG_A, 'acct-tv-coach-a2', minted.tv_id, 'run-a2'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ status: 409, code: 'TV_IN_USE' });
  });

  it('the owner takes their session off; clearing an empty TV is a no-op; set_by never outlives the run', async () => {
    const { minted } = await pairedTv();
    await seedLiveRun(ORG_A, COACH_A, 'run-1', { showOnWall: true });
    await sendRunToGymTv(ORG_A, COACH_A, minted.tv_id, 'run-1');
    const off = await takeRunOffGymTv(ORG_A, COACH_A, minted.tv_id);
    expect(off.current_run_id).toBeNull();
    expect(off.current_run_set_by_account_id).toBeNull();
    const row = await readTv(minted.tv_id);
    expect(row.current_run_id).toBeNull();
    expect(row.current_run_set_by_account_id).toBeNull();
    expect((await takeRunOffGymTv(ORG_A, COACH_A, minted.tv_id)).current_run_id).toBeNull();
    await expect(takeRunOffGymTv(ORG_B, COACH_B, minted.tv_id)).rejects.toMatchObject({ status: 404 });
  });

  it('the Paired TVs list reports a run only while it is live and shown', async () => {
    const { minted } = await pairedTv();
    await seedLiveRun(ORG_A, COACH_A, 'run-1', { showOnWall: true });
    await sendRunToGymTv(ORG_A, COACH_A, minted.tv_id, 'run-1');
    expect((await listGymTvs(ORG_A))[0]).toMatchObject({ current_run_id: 'run-1', current_run_set_by_account_id: COACH_A });
    await settleRun('run-1');
    expect((await listGymTvs(ORG_A))[0]).toMatchObject({ current_run_id: null, current_run_set_by_account_id: null });
  });
});

describe('the TV read (S2b, TV side)', () => {
  it('a paired TV with nothing sent to it gets the empty shape, and its name only', async () => {
    const { redeemed } = await pairedTv();
    await seedLiveRun(ORG_A, COACH_A, 'run-1', { showOnWall: true });
    expect(await readGymTvSession(redeemed.device_key)).toEqual({ tv: { tv_name: 'Gym main' }, session: null });
  });

  it('a live, shown session on the TV: exactly the allowlisted fields, and nothing of the coach or anyone else', async () => {
    const { minted, redeemed } = await pairedTv();
    await seedLiveRun(ORG_A, COACH_A, 'run-1', { showOnWall: true, blocks: 3 });
    await client.query(
      `update pilot.session_script_runs set started_at = now() - interval '12 minutes', current_block_id = 'blk-run-1-2' where run_id = 'run-1'`,
    );
    await sendRunToGymTv(ORG_A, COACH_A, minted.tv_id, 'run-1');

    const read = await readGymTvSession(redeemed.device_key);
    expect(read).not.toBeNull();
    expect(Object.keys(read!).sort()).toEqual(['session', 'tv']);
    expect(Object.keys(read!.tv)).toEqual(['tv_name']);
    const session = read!.session!;
    // SPELLED OUT, not read from the module's own constant: a field added to the constant and the
    // projection together must still fail here (reviewer B). The constant is then checked against
    // this list, so the two cannot drift apart silently either.
    const SESSION_FIELDS = [
      'blocks', 'current_block', 'elapsed_seconds', 'is_paused', 'next_block', 'run_id',
      'script_name', 'server_time', 'started_at', 'total_minutes',
    ];
    const BLOCK_FIELDS = [
      'block_id', 'block_kind', 'block_label', 'block_order', 'drill_name', 'end_offset_min',
      'scale_level', 'start_offset_min',
    ];
    expect([...GYM_TV_SESSION_FIELDS].sort()).toEqual(SESSION_FIELDS);
    expect([...GYM_TV_BLOCK_FIELDS].sort()).toEqual(BLOCK_FIELDS);
    expect(Object.keys(session).sort()).toEqual(SESSION_FIELDS);
    expect(session.blocks).toHaveLength(3);
    for (const block of session.blocks) {
      expect(Object.keys(block).sort()).toEqual(BLOCK_FIELDS);
    }
    expect(Object.keys(session.current_block!).sort()).toEqual([...BLOCK_FIELDS, 'seconds_to_scheduled_end'].sort());
    expect(Object.keys(session.next_block!).sort()).toEqual(BLOCK_FIELDS);

    expect(session).toMatchObject({
      run_id: 'run-1',
      script_name: 'Script run-1',
      total_minutes: 30,
      is_paused: false,
      current_block: { block_id: 'blk-run-1-2', block_order: 2, block_kind: 'drill_round', drill_name: 'Drill for run-1', scale_level: 'B', start_offset_min: 10, end_offset_min: 20 },
      next_block: { block_id: 'blk-run-1-3', block_order: 3 },
    });
    // 12 minutes in, block 2 ends at 20: about 8 minutes to its scheduled end, off the database
    // clock. The window is wide because the seed and the read are separate statements on a loaded
    // machine.
    expect(session.elapsed_seconds).toBeGreaterThanOrEqual(720);
    expect(session.elapsed_seconds).toBeLessThan(750);
    expect(session.current_block!.seconds_to_scheduled_end).toBe(20 * 60 - session.elapsed_seconds);
    expect(new Date(session.server_time).getTime()).toBeGreaterThan(new Date(session.started_at).getTime());

    // THE WHOLE SERIALIZED BODY: no coach note, no note of any kind, no account, no athlete, no
    // hash, no organization (name or id), no key, no TV id.
    const serialized = JSON.stringify(read);
    for (const marker of COACH_NOTE_MARKERS) expect(serialized).not.toContain(marker);
    for (const forbidden of [
      'what_to', 'note', 'account', 'athlete', 'coach', 'delivered_by', 'hash', 'organization',
      ORG_A, COACH_A, redeemed.device_key, minted.tv_id,
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('the clock is frozen while paused', async () => {
    const { minted, redeemed } = await pairedTv();
    await seedLiveRun(ORG_A, COACH_A, 'run-1', { showOnWall: true });
    await client.query(
      `update pilot.session_script_runs
          set started_at = now() - interval '10 minutes', paused_at = now() - interval '4 minutes', paused_seconds = 60
        where run_id = 'run-1'`,
    );
    await sendRunToGymTv(ORG_A, COACH_A, minted.tv_id, 'run-1');
    const session = (await readGymTvSession(redeemed.device_key))!.session!;
    expect(session.is_paused).toBe(true);
    // 10 minutes gross, frozen 4 minutes ago, 1 minute already banked: 5 minutes.
    expect(session.elapsed_seconds).toBe(300);
    expect(session.current_block!.seconds_to_scheduled_end).toBe(300);
  });

  it('nothing once the run has ended or been switched off the TV, though the pointer remains', async () => {
    const { minted, redeemed } = await pairedTv();
    await seedLiveRun(ORG_A, COACH_A, 'run-1', { showOnWall: true });
    await sendRunToGymTv(ORG_A, COACH_A, minted.tv_id, 'run-1');
    expect((await readGymTvSession(redeemed.device_key))!.session).not.toBeNull();

    await client.query(`update pilot.session_script_runs set show_on_wall = false where run_id = 'run-1'`);
    expect((await readGymTvSession(redeemed.device_key))!.session).toBeNull();

    await client.query(`update pilot.session_script_runs set show_on_wall = true where run_id = 'run-1'`);
    await settleRun('run-1');
    expect((await readGymTvSession(redeemed.device_key))!.session).toBeNull();
    expect((await readTv(minted.tv_id)).current_run_id).toBe('run-1');
  });

  it('a disconnected TV, a revoked key and an unknown key all get null -- not the empty shape, nothing', async () => {
    const { minted, redeemed } = await pairedTv();
    await seedLiveRun(ORG_A, COACH_A, 'run-1', { showOnWall: true });
    await sendRunToGymTv(ORG_A, COACH_A, minted.tv_id, 'run-1');
    expect((await readGymTvSession(redeemed.device_key))!.session!.run_id).toBe('run-1');

    await disconnectGymTv(ORG_A, minted.tv_id);
    expect(await readGymTvSession(redeemed.device_key)).toBeNull();
    expect(await readGymTvSession('not-a-key')).toBeNull();
    expect(await readGymTvSession('')).toBeNull();

    // revoked_at alone, with the key still in place (synthetic: Disconnect also clears the session;
    // the table itself refuses a revoked row that still points at a run,
    // pilot_gym_tvs_run_only_when_paired), so revoked_at is the only thing standing between the
    // key and the TV's name.
    const again = await pairedTv(ORG_A, COACH_A, 'Again');
    await client.query(`update pilot.gym_tvs set revoked_at = now() where tv_id = $1`, [again.minted.tv_id]);
    expect((await readTv(again.minted.tv_id)).device_key_hash).not.toBeNull();
    expect(await readGymTvSession(again.redeemed.device_key)).toBeNull();
  });

  it("a TV in another organization gets nothing of this gym's session, and cannot be pointed at it", async () => {
    const { minted } = await pairedTv();
    const other = await pairedTv(ORG_B, COACH_B, 'Other gym');
    await seedLiveRun(ORG_A, COACH_A, 'run-1', { showOnWall: true });
    await sendRunToGymTv(ORG_A, COACH_A, minted.tv_id, 'run-1');
    expect(await readGymTvSession(other.redeemed.device_key)).toEqual({ tv: { tv_name: 'Other gym' }, session: null });
    await expect(
      client.query(`update pilot.gym_tvs set current_run_id = 'run-1' where tv_id = $1`, [other.minted.tv_id]),
    ).rejects.toThrow(/pilot_gym_tvs_current_run_fk/);
    expect(await readGymTvSession(other.redeemed.device_key)).toEqual({ tv: { tv_name: 'Other gym' }, session: null });
  });

  it('the read touches last_seen_at', async () => {
    const { minted, redeemed } = await pairedTv();
    await client.query(`update pilot.gym_tvs set last_seen_at = now() - interval '1 day' where tv_id = $1`, [minted.tv_id]);
    const before = (await readTv(minted.tv_id)).last_seen_at as Date;
    await readGymTvSession(redeemed.device_key);
    const after = (await readTv(minted.tv_id)).last_seen_at as Date;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });
});

describe('re-pairing (S2b)', () => {
  it("revokes the row the TV's previous key named, clears the session on it, and the old key is refused", async () => {
    const first = await pairedTv(ORG_A, COACH_A, 'Gym main');
    await seedLiveRun(ORG_A, COACH_A, 'run-1', { showOnWall: true });
    await sendRunToGymTv(ORG_A, COACH_A, first.minted.tv_id, 'run-1');

    const minted = await mintGymTvPairCode(ORG_A, COACH_A, 'Gym main (renamed)');
    const second = await redeemGymTvPairCode(minted.code, first.redeemed.device_key);
    expect(second).not.toBeNull();
    expect(second!.tv_id).not.toBe(first.minted.tv_id);

    const old = await readTv(first.minted.tv_id);
    expect(old.revoked_at).not.toBeNull();
    expect(old.current_run_id).toBeNull();
    expect(old.current_run_set_by_account_id).toBeNull();
    expect(await resolveGymTvByDeviceKey(first.redeemed.device_key)).toBeNull();
    expect(await resolveGymTvByDeviceKey(second!.device_key)).toMatchObject({ tv_id: second!.tv_id, tv_name: 'Gym main (renamed)' });
    expect((await readTv(second!.tv_id)).revoked_at).toBeNull();
  });

  it('an unknown, already-revoked or absent previous key revokes nothing and pairing still succeeds', async () => {
    const bystander = await pairedTv(ORG_A, COACH_A, 'Bystander');
    const a = await mintGymTvPairCode(ORG_A, COACH_A, 'A');
    expect(await redeemGymTvPairCode(a.code, 'not-a-key')).not.toBeNull();
    const b = await mintGymTvPairCode(ORG_A, COACH_A, 'B');
    expect(await redeemGymTvPairCode(b.code, null)).not.toBeNull();
    expect((await readTv(bystander.minted.tv_id)).revoked_at).toBeNull();
    expect(await resolveGymTvByDeviceKey(bystander.redeemed.device_key)).not.toBeNull();
  });

  it('a wrong code revokes nothing, even with a valid previous key presented', async () => {
    const first = await pairedTv(ORG_A, COACH_A, 'Gym main');
    expect(await redeemGymTvPairCode('AAAAAA', first.redeemed.device_key)).toBeNull();
    expect((await readTv(first.minted.tv_id)).revoked_at).toBeNull();
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
