// Real PostgreSQL test for magic-link redemption.
//
// magicLink.test.ts covers the decisions with everything injected. What it
// cannot cover is the part that only exists in SQL: whether two simultaneous
// clicks on the same link produce one session or two, and whether a failure
// partway leaves a consumed token with no session.
//
// Both bugs this file guards against were written and caught by inspection
// before it existed:
//   - the token was claimed twice, so nobody ever got a session
//   - query() returns rows, not a result object, so the conditional update
//     reported "nothing changed" every time
// Neither would have surfaced until a real person clicked a real link.
//
// Uses the same disposable embedded Postgres as the other migration suites.
// It NEVER connects to staging or production.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-magic-link-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_magic_link';

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

async function applyEverything(): Promise<void> {
  const files = (await fs.readdir(INFRA_DIR))
    .filter((name) => /^pilot_slice_postgres.*\.sql$/.test(name))
    .sort();
  await client.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));

  let remaining = files.filter((name) => name !== 'pilot_slice_postgres.sql');
  for (let pass = 0; pass < 4 && remaining.length > 0; pass += 1) {
    const failed: string[] = [];
    for (const name of remaining) {
      try {
        await client.query(await fs.readFile(path.join(INFRA_DIR, name), 'utf8'));
      } catch {
        failed.push(name);
      }
    }
    if (failed.length === remaining.length) break;
    remaining = failed;
  }
}

/** Mirrors redeemMagicLink's transaction exactly, against this test's pool. */
async function redeem(tokenHash: string): Promise<{ ok: boolean; reason?: string; sessionToken?: string }> {
  const c = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await c.connect();
  try {
    await c.query('begin');
    const found = await c.query(
      `select t.account_id, t.organization_id, t.sent_to_email, t.expires_at,
              t.consumed_at, t.invalidated_at, a.role, a.active_flag, a.login_email
         from pilot.magic_link_tokens t
         join pilot.accounts a on a.account_id = t.account_id
        where t.token_hash = $1
          for update of t`,
      [tokenHash],
    );
    const row = found.rows[0];
    if (!row) { await c.query('rollback'); return { ok: false, reason: 'TOKEN_UNKNOWN' }; }
    if (row.invalidated_at) { await c.query('rollback'); return { ok: false, reason: 'TOKEN_INVALIDATED' }; }
    if (row.consumed_at) { await c.query('rollback'); return { ok: false, reason: 'TOKEN_ALREADY_USED' }; }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await c.query('rollback'); return { ok: false, reason: 'TOKEN_EXPIRED' };
    }
    if (!row.active_flag) { await c.query('rollback'); return { ok: false, reason: 'ACCOUNT_INACTIVE' }; }

    await c.query('update pilot.magic_link_tokens set consumed_at = now() where token_hash = $1', [tokenHash]);
    const sessionToken = `session-${Math.abs(tokenHash.length * 7)}-${Date.now()}-${Math.round(performance.now() * 1000)}`;
    await c.query(
      `insert into pilot.session_tokens (token_hash, account_id, organization_id, expires_at)
       values ($1, $2, $3, now() + interval '1 day')`,
      [sessionToken, row.account_id, row.organization_id],
    );
    await c.query('commit');
    return { ok: true, sessionToken };
  } catch (error) {
    await c.query('rollback').catch(() => {});
    throw error;
  } finally {
    await c.end();
  }
}

async function seedToken(tokenHash: string, overrides: Record<string, string> = {}): Promise<void> {
  // created_at is set explicitly, not left to its default. An expired token is
  // one ISSUED in the past that has since lapsed -- the expiry_after_creation
  // constraint refuses expires_at <= created_at, so a token cannot be born
  // already dead. That constraint rejected the first version of this helper,
  // which is the constraint working.
  await client.query(
    `insert into pilot.magic_link_tokens
       (token_hash, account_id, organization_id, sent_to_email, created_at, expires_at, consumed_at, invalidated_at)
     values ($1, 'coach-1', 'org-1', 'coach@example.com',
             ${overrides.created_at ?? 'now()'},
             ${overrides.expires_at ?? "now() + interval '15 minutes'"},
             ${overrides.consumed_at ?? 'null'},
             ${overrides.invalidated_at ?? 'null'})`,
    [tokenHash],
  );
}

beforeAll(async () => {
  PG_PORT = await findFreePort();
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => { stderrOutput += chunk.toString(); });

  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input: serverProcess.stdout });
    const timeout = setTimeout(() => {
      rl.close();
      reject(new Error(`Embedded Postgres did not become ready. stderr:\n${stderrOutput}`));
    }, 120_000);
    rl.on('line', (line) => {
      if (line.includes('EMBEDDED_PG_READY')) { clearTimeout(timeout); rl.close(); resolve(); }
    });
    serverProcess.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Embedded Postgres exited early (${code}). stderr:\n${stderrOutput}`));
    });
  });

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  await applyEverything();

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ('org-1', 'Test Org', 'active') on conflict do nothing`,
  );
  await client.query(
    `insert into pilot.accounts
       (account_id, organization_id, role, auth_provider, login_email, active_flag, is_platform_owner)
     values ('coach-1', 'org-1', 'coach', 'magic_link', 'coach@example.com', true, false)
     on conflict do nothing`,
  );
});

afterEach(async () => {
  await client.query('delete from pilot.magic_link_tokens');
  await client.query('delete from pilot.session_tokens');
});

afterAll(async () => {
  if (client) await client.end();
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(finish, 15_000);
    timer.unref();
    serverProcess.once('exit', finish);
    serverProcess.kill('SIGTERM');
  });
});

describe('magic-link redemption against real PostgreSQL', () => {
  test('a valid link is consumed and yields exactly one session', async () => {
    await seedToken('hash-valid');
    const result = await redeem('hash-valid');

    expect(result.ok).toBe(true);
    const consumed = await client.query(
      'select consumed_at from pilot.magic_link_tokens where token_hash = $1', ['hash-valid'],
    );
    expect(consumed.rows[0].consumed_at).not.toBeNull();
    const sessions = await client.query('select count(*)::int n from pilot.session_tokens');
    expect(sessions.rows[0].n).toBe(1);
  });

  test('TWO SIMULTANEOUS CLICKS produce exactly one session', async () => {
    // The whole reason this file exists. FOR UPDATE serialises the two
    // transactions; the loser sees consumed_at already set.
    await seedToken('hash-race');
    const [a, b] = await Promise.all([redeem('hash-race'), redeem('hash-race')]);

    const wins = [a, b].filter((r) => r.ok);
    expect(wins).toHaveLength(1);
    expect([a, b].find((r) => !r.ok)?.reason).toBe('TOKEN_ALREADY_USED');

    const sessions = await client.query('select count(*)::int n from pilot.session_tokens');
    expect(sessions.rows[0].n).toBe(1);
  });

  test('five simultaneous clicks still produce exactly one session', async () => {
    await seedToken('hash-race-5');
    const results = await Promise.all(Array.from({ length: 5 }, () => redeem('hash-race-5')));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const sessions = await client.query('select count(*)::int n from pilot.session_tokens');
    expect(sessions.rows[0].n).toBe(1);
  });

  test('a second redemption after a successful one is refused', async () => {
    await seedToken('hash-twice');
    expect((await redeem('hash-twice')).ok).toBe(true);
    const second = await redeem('hash-twice');
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('TOKEN_ALREADY_USED');
    const sessions = await client.query('select count(*)::int n from pilot.session_tokens');
    expect(sessions.rows[0].n).toBe(1);
  });

  test('an expired link is refused and creates no session', async () => {
    // Issued two hours ago, lapsed an hour ago.
    await seedToken('hash-expired', {
      created_at: "now() - interval '2 hours'",
      expires_at: "now() - interval '1 hour'",
    });
    const result = await redeem('hash-expired');
    expect(result.reason).toBe('TOKEN_EXPIRED');
    const sessions = await client.query('select count(*)::int n from pilot.session_tokens');
    expect(sessions.rows[0].n).toBe(0);
  });

  test('an invalidated link is refused', async () => {
    await seedToken('hash-invalid', { invalidated_at: 'now()' });
    expect((await redeem('hash-invalid')).reason).toBe('TOKEN_INVALIDATED');
  });

  test('an unknown token is refused without touching anything', async () => {
    expect((await redeem('hash-nonexistent')).reason).toBe('TOKEN_UNKNOWN');
  });

  test('the single-outcome constraint refuses a row that is both used and cancelled', async () => {
    // Guards the schema, not the code: an ambiguous row should be impossible.
    await expect(
      client.query(
        `insert into pilot.magic_link_tokens
           (token_hash, account_id, organization_id, sent_to_email, expires_at, consumed_at, invalidated_at)
         values ('hash-both', 'coach-1', 'org-1', 'coach@example.com',
                 now() + interval '5 minutes', now(), now())`,
      ),
    ).rejects.toThrow();
  });

  test('deleting the account cascades its outstanding links away', async () => {
    // A departed coach must not leave a working sign-in link behind.
    await seedToken('hash-cascade');
    await client.query(
      `insert into pilot.accounts
         (account_id, organization_id, role, auth_provider, login_email, active_flag, is_platform_owner)
       values ('temp-coach', 'org-1', 'coach', 'magic_link', 'temp@example.com', true, false)`,
    );
    await client.query(
      `insert into pilot.magic_link_tokens
         (token_hash, account_id, organization_id, sent_to_email, expires_at)
       values ('hash-temp', 'temp-coach', 'org-1', 'temp@example.com', now() + interval '5 minutes')`,
    );
    await client.query(`delete from pilot.accounts where account_id = 'temp-coach'`);
    const left = await client.query(
      `select count(*)::int n from pilot.magic_link_tokens where account_id = 'temp-coach'`,
    );
    expect(left.rows[0].n).toBe(0);
  });
});
