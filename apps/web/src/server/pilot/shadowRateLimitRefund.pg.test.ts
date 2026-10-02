// Real PostgreSQL-backed contract test for the review buckets: the receipt and
// its refund (consumeShadowRateLimit, refundShadowRateLimit) and the two
// allowances a review row draws on (consumeShadowReviewSlot).
//
// WHY THIS EXISTS. The human-review queue writes are bounded by their own
// buckets, `safety_review` and `safety_review_critical`
// (OD-2026-10-01-006). The limiter increments BEFORE the write it bounds, and that
// write can fail, so a slot whose row was never written is given back. Unless
// it is, three failed inserts spend an account's whole hour while persisting
// nothing, and the next real report that hour is suppressed as "exhausted"
// (OD-2026-09-30-006, selection 1: "Refund on failure").
//
// route.test.ts proves the refund is CALLED, with the receipt the limiter
// returned. It cannot prove the SQL moves the row it should, because there is
// no row there: the limiter is mocked. Everything below needs a database.
//
// THE RECEIPT. consumeShadowRateLimit returns which bucket row it incremented:
// organization, account, endpoint, window length, and the START OF THE WINDOW
// AS THE DATABASE CHOSE IT, read back from the row. refundShadowRateLimit
// decrements exactly that row. It does not ask the clock which window is
// current. A refund that did would, when it arrived after the hour had
// turned, decrement the NEW hour: a slot nobody had charged, in a window the
// failed write had nothing to do with.
//
// What is proved here:
//   1. The receipt names the row that was incremented, to the second.
//   2. Charge then refund leaves the count where it started.
//   3. The refund moves ONLY the row that matches on organization, account,
//      endpoint, window start and window length. The first four are each
//      varied alone, with a row beside the target that differs in that one
//      thing. Window length is not part of the row's key, so no row can sit
//      beside the target differing only in that; it has its own test, with a
//      receipt that names the wrong length.
//   4. THE HOUR BOUNDARY: a receipt for the previous hour decrements the
//      previous hour's row and leaves the current hour's alone, and the other
//      way round.
//   5. It never creates a row, never goes below zero, and reports whether it
//      moved anything.
//   6. THE DEFECT, END TO END: three charge-and-refund cycles leave a fourth
//      request allowed; and the control, that without refunds the limit is
//      still reached.
//   7. THE REVIEW SLOT: three rows an hour are admitted; a fourth attempt is
//      refused AND PUT BACK, so the stored count rests at three; a slot
//      refunded after that is one the next row can use.
//   8. TWO ALLOWANCES: critical request reviews and every other review row
//      are counted in separate bucket rows, and neither spends the other.
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
  consumeShadowRateLimit,
  consumeShadowReviewSlot,
  enforceShadowRateLimit,
  refundShadowRateLimit,
  resolveShadowRateLimit,
  ShadowRateLimitExceeded,
  type ShadowRateLimitReceipt,
  type ShadowReviewEvent,
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

type BucketRow = {
  organization_id: string;
  account_id: string;
  endpoint_key: string;
  window_seconds: number;
  window_epoch: number;
  request_count: number;
};

/** Every bucket row, so a test can assert what did NOT move as well as what did. */
async function buckets(client: Client): Promise<BucketRow[]> {
  const result = await client.query(
    `select organization_id, account_id, endpoint_key, window_seconds,
            extract(epoch from window_started_at)::bigint as window_epoch,
            request_count
       from pilot.shadow_rate_limit_buckets
      order by organization_id, account_id, endpoint_key, window_started_at`,
  );
  return result.rows.map((row) => ({ ...row, window_epoch: Number(row.window_epoch) }));
}

function consume(account = ACCOUNT, endpointKey = 'safety_review'): Promise<ShadowRateLimitReceipt> {
  return consumeShadowRateLimit({
    organizationId: ORG,
    accountId: account,
    endpointKey,
    limit: POLICY.limit,
    windowSeconds: POLICY.windowSeconds,
  });
}

/** A bucket row written directly, for the rows the limiter cannot be made to produce: another tenant, another hour. */
async function plant(client: Client, row: {
  organizationId: string;
  accountId: string;
  endpointKey: string;
  windowEpoch: number;
  windowSeconds: number;
  count: number;
}): Promise<void> {
  await client.query(
    `insert into pilot.shadow_rate_limit_buckets
       (organization_id, account_id, endpoint_key, window_started_at, window_seconds, request_count)
     values ($1, $2, $3, to_timestamp($4::bigint), $5, $6)`,
    [row.organizationId, row.accountId, row.endpointKey, row.windowEpoch, row.windowSeconds, row.count],
  );
}

const countOf = (rows: BucketRow[], match: Partial<BucketRow>): number | undefined => rows.find(
  (row) => (Object.keys(match) as Array<keyof BucketRow>).every((key) => row[key] === match[key]),
)?.request_count;

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

describe('the safety_review receipt and its refund, against real Postgres', () => {
  const withDatabase = async (name: string, body: (client: Client) => Promise<void>) => {
    const client = await freshDatabase(name);
    try {
      await body(client);
    } finally {
      activeClient = null;
      await client.end();
    }
  };

  test('the receipt names the row that was incremented, to the second, as the DATABASE chose it', async () => {
    await withDatabase('ppbf_test_rl_receipt', async (client) => {
      // This process's clock is set a year back for the two charges. A receipt
      // worked out here, instead of read back from the row, would name a
      // window a year ago.
      const realNow = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(realNow - 365 * 86_400_000);
      let first: ShadowRateLimitReceipt;
      let second: ShadowRateLimitReceipt;
      try {
        first = await consume();
        second = await consume();
      } finally {
        clock.mockRestore();
      }
      expect(Math.abs(first.windowStartedAtEpochSeconds * 1000 - realNow)).toBeLessThanOrEqual(2 * 3_600_000);

      const rows = await buckets(client);
      expect(rows).toHaveLength(1);
      expect(rows[0].request_count).toBe(2);
      expect(first).toEqual({
        organizationId: ORG,
        accountId: ACCOUNT,
        endpointKey: 'safety_review',
        windowSeconds: POLICY.windowSeconds,
        windowStartedAtEpochSeconds: rows[0].window_epoch,
      });
      expect(second).toEqual(first);
      // The window is an hour, aligned to the hour.
      expect(first.windowStartedAtEpochSeconds % POLICY.windowSeconds).toBe(0);
      expect(POLICY).toEqual({ endpointKey: 'safety_review', limit: 3, windowSeconds: 3_600 });
    });
  });

  test('the round trip: charge then refund leaves the count where it started', async () => {
    await withDatabase('ppbf_test_rl_refund_roundtrip', async (client) => {
      await consume();
      const receipt = await consume();
      expect((await buckets(client))[0].request_count).toBe(2);

      await expect(refundShadowRateLimit(receipt)).resolves.toBe(true);

      // Back to one: not zero, and not still two.
      expect((await buckets(client))[0].request_count).toBe(1);
    });
  });

  test('it moves only the row the receipt names: not the endpoint, account, ORGANIZATION or window beside it', async () => {
    await withDatabase('ppbf_test_rl_refund_isolation', async (client) => {
      await consume(ACCOUNT, 'safety_review');
      const receipt = await consume(ACCOUNT, 'safety_review');
      const window = receipt.windowStartedAtEpochSeconds;

      // Four neighbours, each differing from the charged row in ONE thing.
      await consume(ACCOUNT, 'chat');
      await consume(ACCOUNT, 'chat');                         // endpoint
      await consume(OTHER_ACCOUNT, 'safety_review');
      await consume(OTHER_ACCOUNT, 'safety_review');           // account
      // organization: written directly, because pilot.accounts ties an
      // account to one organization and going through the limiter would
      // change the account as well. The bucket table's two foreign keys are
      // independent, so this row is legal.
      await plant(client, { organizationId: OTHER_ORG, accountId: ACCOUNT, endpointKey: 'safety_review', windowEpoch: window, windowSeconds: POLICY.windowSeconds, count: 2 });
      // window: the hour before, same everything else.
      await plant(client, { organizationId: ORG, accountId: ACCOUNT, endpointKey: 'safety_review', windowEpoch: window - POLICY.windowSeconds, windowSeconds: POLICY.windowSeconds, count: 2 });

      await expect(refundShadowRateLimit(receipt)).resolves.toBe(true);

      const rows = await buckets(client);
      expect(rows).toHaveLength(5);
      // The one that was refunded.
      expect(countOf(rows, { organization_id: ORG, account_id: ACCOUNT, endpoint_key: 'safety_review', window_epoch: window })).toBe(1);
      // A different ENDPOINT for the same account: a failed review write must
      // not hand back a chat request.
      expect(countOf(rows, { organization_id: ORG, account_id: ACCOUNT, endpoint_key: 'chat' })).toBe(2);
      // A different ACCOUNT: one person's failed write must not restore
      // another's quota.
      expect(countOf(rows, { organization_id: ORG, account_id: OTHER_ACCOUNT, endpoint_key: 'safety_review' })).toBe(2);
      // A different TENANT: a tenant boundary, not a counting detail.
      expect(countOf(rows, { organization_id: OTHER_ORG, account_id: ACCOUNT, endpoint_key: 'safety_review' })).toBe(2);
      // A different WINDOW: the hour before is not the hour that was charged.
      expect(countOf(rows, { organization_id: ORG, account_id: ACCOUNT, endpoint_key: 'safety_review', window_epoch: window - POLICY.windowSeconds })).toBe(2);
    });
  });

  test('a receipt whose window LENGTH does not match the row moves nothing', async () => {
    await withDatabase('ppbf_test_rl_refund_window_length', async (client) => {
      const receipt = await consume();
      await consume();

      await expect(refundShadowRateLimit({ ...receipt, windowSeconds: 60 })).resolves.toBe(false);

      expect((await buckets(client))[0].request_count).toBe(2);
    });
  });

  test('THE HOUR BOUNDARY: a receipt for the previous hour decrements that hour\'s row, not the current one (the previous hour\'s row is planted; the clock is not moved)', async () => {
    await withDatabase('ppbf_test_rl_refund_hour_boundary', async (client) => {
      // "Now": the limiter charges the current hour.
      const current = await consume();
      await consume();
      const thisHour = current.windowStartedAtEpochSeconds;
      const lastHour = thisHour - POLICY.windowSeconds;

      // The hour before, as it stood when a write was charged there: count 3.
      // The receipt for that charge is what a request that began before the
      // hour turned is still holding when its insert finally fails.
      await plant(client, { organizationId: ORG, accountId: ACCOUNT, endpointKey: 'safety_review', windowEpoch: lastHour, windowSeconds: POLICY.windowSeconds, count: 3 });
      const heldAcrossTheBoundary: ShadowRateLimitReceipt = { ...current, windowStartedAtEpochSeconds: lastHour };

      await expect(refundShadowRateLimit(heldAcrossTheBoundary)).resolves.toBe(true);

      let rows = await buckets(client);
      expect(countOf(rows, { window_epoch: lastHour })).toBe(2);   // the hour that was charged
      expect(countOf(rows, { window_epoch: thisHour })).toBe(2);   // the current hour, untouched

      // And the other way round: a receipt for this hour leaves last hour alone.
      await expect(refundShadowRateLimit(current)).resolves.toBe(true);
      rows = await buckets(client);
      expect(countOf(rows, { window_epoch: lastHour })).toBe(2);
      expect(countOf(rows, { window_epoch: thisHour })).toBe(1);
    });
  });

  test('a receipt for a row that is gone moves nothing and creates nothing', async () => {
    await withDatabase('ppbf_test_rl_refund_no_insert', async (client) => {
      const receipt = await consume();
      const purged: ShadowRateLimitReceipt = { ...receipt, windowStartedAtEpochSeconds: receipt.windowStartedAtEpochSeconds - 3 * 86_400 };

      await expect(refundShadowRateLimit(purged)).resolves.toBe(false);

      // An upsert written by habit would insert a row here.
      const rows = await buckets(client);
      expect(rows).toHaveLength(1);
      expect(rows[0].request_count).toBe(1);
    });
  });

  test('it stops at zero by its own predicate, not by running into the check constraint, and says it moved nothing', async () => {
    await withDatabase('ppbf_test_rl_refund_clamp', async (client) => {
      const receipt = await consume();
      await expect(refundShadowRateLimit(receipt)).resolves.toBe(true);
      expect((await buckets(client))[0].request_count).toBe(0);

      // The same receipt presented again: nothing left to give back. Without
      // the statement's own "request_count > 0" the table's check constraint
      // would refuse the update, and that also comes back false with the
      // count at zero -- but as a caught database error, which is logged. So
      // the log is what tells the two apart.
      const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await expect(refundShadowRateLimit(receipt)).resolves.toBe(false);
        expect(logged).not.toHaveBeenCalled();
      } finally {
        logged.mockRestore();
      }
      expect((await buckets(client))[0].request_count).toBe(0);
    });
  });

  test('it never throws: a malformed receipt, and a database that refuses the statement, both come back false', async () => {
    await withDatabase('ppbf_test_rl_refund_never_throws', async (client) => {
      const receipt = await consume();

      for (const bad of [
        { ...receipt, organizationId: ' ' },
        { ...receipt, accountId: '' },
        { ...receipt, endpointKey: 'safety_review; drop table x' },
        { ...receipt, windowSeconds: 0 },
        { ...receipt, windowStartedAtEpochSeconds: Number.NaN },
        { ...receipt, windowStartedAtEpochSeconds: -1 },
      ]) {
        await expect(refundShadowRateLimit(bad)).resolves.toBe(false);
      }
      expect((await buckets(client))[0].request_count).toBe(1);

      // The table gone from under it.
      await client.query('alter table pilot.shadow_rate_limit_buckets rename to shadow_rate_limit_buckets_gone');
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await expect(refundShadowRateLimit(receipt)).resolves.toBe(false);
      } finally {
        quiet.mockRestore();
      }
    });
  });

  test('THE DEFECT: repeated failed writes do not spend the hour', async () => {
    await withDatabase('ppbf_test_rl_refund_defect', async (client) => {
      // Each cycle is one report whose human-review insert failed: the limiter
      // charged for it, the row did not land, the slot came back.
      for (let i = 0; i < POLICY.limit; i += 1) {
        const receipt = await consume();
        await refundShadowRateLimit(receipt);
      }
      expect((await buckets(client))[0].request_count).toBe(0);

      // The next real report. Without the refund the count here would already
      // be at the limit and this would throw.
      await expect(consume()).resolves.toEqual(expect.objectContaining({ endpointKey: 'safety_review' }));
    });
  });

  test('POSITIVE CONTROL: without refunds the fourth is refused, and the refusal has charged the row', async () => {
    await withDatabase('ppbf_test_rl_refund_control', async (client) => {
      // Without this, a refund that fired on every path -- or a limiter that
      // had stopped counting -- would leave every test above green while the
      // quota had ceased to exist.
      for (let i = 0; i < POLICY.limit; i += 1) {
        await consume();
      }
      await expect(consume()).rejects.toBeInstanceOf(ShadowRateLimitExceeded);
      // consumeShadowRateLimit itself leaves an over-limit attempt's
      // increment in place, as the limiter always has. Putting it back is
      // consumeShadowReviewSlot's job, proved below.
      expect((await buckets(client))[0].request_count).toBe(POLICY.limit + 1);
      // enforceShadowRateLimit is the same statement with the receipt dropped.
      await expect(enforceShadowRateLimit({ organizationId: ORG, accountId: OTHER_ACCOUNT, ...POLICY })).resolves.toBeUndefined();
    });
  });

  // ---- the review slot: consumeShadowReviewSlot ----
  const CRITICAL_REQUEST: ShadowReviewEvent = { kind: 'request_risk', critical: true };
  const OTHER_REQUEST: ShadowReviewEvent = { kind: 'request_risk', critical: false };
  const GENERATED_ANSWER: ShadowReviewEvent = { kind: 'response_safety', critical: true };
  const OPERATIONAL: ShadowReviewEvent = { kind: 'operational', critical: false };
  const slot = (event: ShadowReviewEvent, account = ACCOUNT) => consumeShadowReviewSlot({
    organizationId: ORG,
    accountId: account,
    event,
  });

  test('THE REVIEW SLOT: 1, 2 and 3 are admitted; the 4th is refused and put back; a failed admitted write refunds to 2; nothing else moves', async () => {
    await withDatabase('ppbf_test_rl_review_slot', async (client) => {
      // Neighbours that must not move: another account's row in the same
      // bucket, and this account's row for the hour before.
      await slot(OTHER_REQUEST, OTHER_ACCOUNT);
      const first = await slot(OTHER_REQUEST);
      const lastHour = first!.windowStartedAtEpochSeconds - POLICY.windowSeconds;
      await plant(client, { organizationId: ORG, accountId: ACCOUNT, endpointKey: 'safety_review', windowEpoch: lastHour, windowSeconds: POLICY.windowSeconds, count: 3 });
      const mine = { organization_id: ORG, account_id: ACCOUNT, endpoint_key: 'safety_review', window_epoch: first!.windowStartedAtEpochSeconds };
      const neighboursUnmoved = async () => {
        const rows = await buckets(client);
        expect(rows).toHaveLength(3);
        expect(countOf(rows, { account_id: OTHER_ACCOUNT })).toBe(1);
        expect(countOf(rows, { account_id: ACCOUNT, window_epoch: lastHour })).toBe(3);
      };

      await slot(OTHER_REQUEST);
      const third = await slot(OTHER_REQUEST);
      expect(countOf(await buckets(client), mine)).toBe(3);

      // The fourth: refused, and its own increment is not left behind.
      await expect(slot(OTHER_REQUEST)).rejects.toBeInstanceOf(ShadowRateLimitExceeded);
      expect(countOf(await buckets(client), mine)).toBe(3);
      // And again: refusals do not accumulate.
      await expect(slot(OTHER_REQUEST)).rejects.toBeInstanceOf(ShadowRateLimitExceeded);
      expect(countOf(await buckets(client), mine)).toBe(3);
      await neighboursUnmoved();

      // The third row's insert failed: its slot comes back.
      await expect(refundShadowRateLimit(third!)).resolves.toBe(true);
      expect(countOf(await buckets(client), mine)).toBe(2);

      // And is usable: the next row is admitted, and the one after is not.
      await expect(slot(OTHER_REQUEST)).resolves.toEqual(third);
      expect(countOf(await buckets(client), mine)).toBe(3);
      await expect(slot(OTHER_REQUEST)).rejects.toBeInstanceOf(ShadowRateLimitExceeded);
      expect(countOf(await buckets(client), mine)).toBe(3);
      await neighboursUnmoved();
    });
  });

  test('TWO ALLOWANCES: three critical request reviews do not spend the general allowance, and the fourth critical one is still refused', async () => {
    await withDatabase('ppbf_test_rl_review_critical', async (client) => {
      for (let i = 0; i < 3; i += 1) {
        await expect(slot(CRITICAL_REQUEST)).resolves.toEqual(expect.objectContaining({ endpointKey: 'safety_review_critical' }));
      }
      // Bounded, not unlimited.
      await expect(slot(CRITICAL_REQUEST)).rejects.toBeInstanceOf(ShadowRateLimitExceeded);

      // Every other kind of row still has its own three.
      await expect(slot(OTHER_REQUEST)).resolves.toEqual(expect.objectContaining({ endpointKey: 'safety_review' }));
      await expect(slot(GENERATED_ANSWER)).resolves.toEqual(expect.objectContaining({ endpointKey: 'safety_review' }));
      await expect(slot(OPERATIONAL)).resolves.toEqual(expect.objectContaining({ endpointKey: 'safety_review' }));

      const rows = await buckets(client);
      expect(rows).toHaveLength(2);
      expect(countOf(rows, { endpoint_key: 'safety_review_critical' })).toBe(3);
      expect(countOf(rows, { endpoint_key: 'safety_review' })).toBe(3);
    });
  });

  test('TWO ALLOWANCES: three routine rows of any kind spend the general allowance and leave the critical one whole', async () => {
    await withDatabase('ppbf_test_rl_review_general', async (client) => {
      // One of each kind that shares the general bucket, the generated answer
      // being one behind a CRITICAL request: it is still not a critical
      // request review.
      await slot(OTHER_REQUEST);
      await slot(GENERATED_ANSWER);
      await slot(OPERATIONAL);
      for (const event of [OTHER_REQUEST, GENERATED_ANSWER, OPERATIONAL]) {
        await expect(slot(event)).rejects.toBeInstanceOf(ShadowRateLimitExceeded);
      }

      // The emergency report that hour is still admitted, three times.
      for (let i = 0; i < 3; i += 1) {
        await expect(slot(CRITICAL_REQUEST)).resolves.toEqual(expect.objectContaining({ endpointKey: 'safety_review_critical' }));
      }

      const rows = await buckets(client);
      expect(rows).toHaveLength(2);
      expect(countOf(rows, { endpoint_key: 'safety_review' })).toBe(3);
      expect(countOf(rows, { endpoint_key: 'safety_review_critical' })).toBe(3);
    });
  });
});
