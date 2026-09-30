// Real PostgreSQL-backed contract test for refundShadowRateLimit.
//
// WHY THIS EXISTS. refundShadowRateLimit was added so the `safety_review`
// quota counts human-review rows actually written rather than writes
// attempted. enforceShadowRateLimit increments BEFORE the write it bounds, and
// that write's failure is swallowed so the athlete still gets an answer -- so
// without a refund, three failed inserts consumed an account's whole hour
// while persisting nothing, and the next genuine report that hour was
// suppressed as exhausted.
//
// Its unit coverage in route.test.ts proves the refund is CALLED when the
// queue write fails. It cannot prove the SQL decrements the row it should,
// because there is no row -- the limiter is mocked there. Everything below
// needs a real database:
//
// 1. The round trip: enforce then refund leaves the count exactly where it
//    started. This is the whole contract in one assertion.
// 2. The refund moves ONLY the matching (organization, account, endpoint,
//    window) row. A statement missing a WHERE term would pass test 1 and
//    quietly drain a different account's quota, or every endpoint's at once.
//    THE ORGANIZATION HALF OF THIS WAS ADDED AFTER A MUTATION PROOF, because
//    the first version of this file used one tenant throughout and therefore
//    could not see the organization predicate removed. That mutant survived;
//    the row written directly into a second tenant is what kills it now.
// 3. It never CREATES a row. An upsert written by habit would insert a
//    -1-shaped row for an account that had no bucket, and the table's
//    `request_count >= 0` check would then reject it at a random later moment.
// 4. It clamps at zero rather than violating that check.
// 5. THE DEFECT, END TO END. Three enforce+refund cycles must leave a fourth
//    request allowed. Before the refund existed this is precisely where a real
//    report got suppressed, and it is the only test here that would have
//    failed against the shipped code.
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
}));

import {
  enforceShadowRateLimit,
  refundShadowRateLimit,
  resolveShadowRateLimit,
  ShadowRateLimitExceeded,
} from './shadowRateLimit';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-rl-refund-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const ORG = 'org-rl-refund';
const OTHER_ORG = 'org-rl-refund-other';
const ACCOUNT = 'acct-rl-refund';
const OTHER_ACCOUNT = 'acct-rl-refund-other';

// The policy the route actually uses. Read rather than hardcoded, so a change
// to the owner's number (OD-2026-09-30-005: 3 per hour) moves this test with
// it instead of leaving it asserting a number nothing uses.
const POLICY = resolveShadowRateLimit('safety_review');

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

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);

  for (const organization of [ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organization],
    );
  }
  for (const account of [ACCOUNT, OTHER_ACCOUNT]) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'athlete', $2, 'microsoft') on conflict do nothing`,
      [account, ORG],
    );
  }

  activeClient = client;
  return client;
}

/** Every bucket row, so a test can assert what did NOT move as well as what did. */
async function buckets(client: Client): Promise<Array<{
  organization_id: string;
  account_id: string;
  endpoint_key: string;
  request_count: number;
}>> {
  const result = await client.query(
    `select organization_id, account_id, endpoint_key, request_count
       from pilot.shadow_rate_limit_buckets
      order by organization_id, account_id, endpoint_key`,
  );
  return result.rows;
}

function refund(account = ACCOUNT, endpointKey = 'safety_review') {
  return refundShadowRateLimit({
    organizationId: ORG,
    accountId: account,
    endpointKey,
    limit: POLICY.limit,
    windowSeconds: POLICY.windowSeconds,
  });
}

function enforce(account = ACCOUNT, endpointKey = 'safety_review') {
  return enforceShadowRateLimit({
    organizationId: ORG,
    accountId: account,
    endpointKey,
    limit: POLICY.limit,
    windowSeconds: POLICY.windowSeconds,
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
});

describe('refundShadowRateLimit against real Postgres', () => {
  test('the round trip: enforce then refund leaves the count where it started', async () => {
    const client = await freshDatabase('ppbf_test_rl_refund_roundtrip');
    try {
      await enforce();
      await enforce();
      expect((await buckets(client))[0].request_count).toBe(2);

      await refund();

      // Back to one, not to zero and not still two. The quota now measures
      // work that persisted rather than work that was attempted.
      expect((await buckets(client))[0].request_count).toBe(1);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('it moves only the matching row -- not the endpoint, account or ORGANIZATION beside it', async () => {
    const client = await freshDatabase('ppbf_test_rl_refund_isolation');
    try {
      await enforce(ACCOUNT, 'safety_review');
      await enforce(ACCOUNT, 'safety_review');
      await enforce(ACCOUNT, 'chat');
      await enforce(OTHER_ACCOUNT, 'safety_review');
      await enforce(OTHER_ACCOUNT, 'safety_review');

      // A row in a DIFFERENT TENANT carrying the same account and endpoint, in
      // the same window. Written directly because it is the only way to vary
      // organization_id ALONE: pilot.accounts keys an account to one
      // organization, so going through enforce() would change the account too
      // and the account_id predicate would catch the mutant instead -- which
      // is exactly how the first version of this test passed while the
      // organization term was removable. The bucket table's two foreign keys
      // are independent, so this row is legal.
      await client.query(
        `insert into pilot.shadow_rate_limit_buckets
           (organization_id, account_id, endpoint_key, window_started_at, window_seconds, request_count)
         values ($1, $2, 'safety_review',
                 to_timestamp(floor(extract(epoch from clock_timestamp()) / $3) * $3), $3, 2)`,
        [OTHER_ORG, ACCOUNT, POLICY.windowSeconds],
      );

      await refund(ACCOUNT, 'safety_review');

      const rows = await buckets(client);
      const find = (o: string, a: string, e: string) => rows.find(
        (r) => r.organization_id === o && r.account_id === a && r.endpoint_key === e,
      );

      // The one that was refunded.
      expect(find(ORG, ACCOUNT, 'safety_review')?.request_count).toBe(1);
      // A DIFFERENT ENDPOINT for the same account. A statement that dropped
      // the endpoint_key term would pass the round-trip test above and then
      // quietly refund a chat request every time a review row failed.
      expect(find(ORG, ACCOUNT, 'chat')?.request_count).toBe(1);
      // A DIFFERENT ACCOUNT on the same endpoint. Dropping the account term
      // would let one athlete's failed write restore another's quota.
      expect(find(ORG, OTHER_ACCOUNT, 'safety_review')?.request_count).toBe(2);
      // A DIFFERENT TENANT. Dropping the organization term would let one gym's
      // failed write refund another gym's quota, which is a tenant boundary,
      // not a counting bug.
      expect(find(OTHER_ORG, ACCOUNT, 'safety_review')?.request_count).toBe(2);
      expect(rows).toHaveLength(4);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('it never creates a row for an account that has no bucket', async () => {
    const client = await freshDatabase('ppbf_test_rl_refund_no_insert');
    try {
      await refund();

      // An upsert written by habit would insert here, and the table's
      // `request_count >= 0` check would reject the row at some unrelated
      // later moment rather than at the mistake.
      expect(await buckets(client)).toHaveLength(0);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('it clamps at zero instead of violating the check constraint', async () => {
    const client = await freshDatabase('ppbf_test_rl_refund_clamp');
    try {
      await enforce();
      await refund();
      expect((await buckets(client))[0].request_count).toBe(0);

      // A second refund with nothing left to give back. It must be a no-op,
      // not a constraint violation and not a negative count.
      await expect(refund()).resolves.toBeUndefined();
      expect((await buckets(client))[0].request_count).toBe(0);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('THE DEFECT: repeated failed writes do not exhaust the hour', async () => {
    const client = await freshDatabase('ppbf_test_rl_refund_defect');
    try {
      // Each cycle is one urgent report whose human-review insert failed: the
      // limiter charged for it, the write did not land, the slot came back.
      for (let i = 0; i < POLICY.limit; i += 1) {
        await enforce();
        await refund();
      }
      expect((await buckets(client))[0].request_count).toBe(0);

      // The next genuine report. Before the refund existed the count here was
      // already at the limit and this threw -- suppressing a real report
      // because earlier ones had failed to persist.
      await expect(enforce()).resolves.toBeUndefined();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('POSITIVE CONTROL: without refunds the limit is still reached', async () => {
    const client = await freshDatabase('ppbf_test_rl_refund_control');
    try {
      // Without this, a refund that fired on every path -- or a limiter that
      // had quietly stopped counting -- would leave every test above green
      // while the quota had ceased to exist.
      for (let i = 0; i < POLICY.limit; i += 1) {
        await enforce();
      }
      await expect(enforce()).rejects.toBeInstanceOf(ShadowRateLimitExceeded);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});
