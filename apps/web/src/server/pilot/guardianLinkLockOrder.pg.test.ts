/**
 * The guardian_links lock order, on real PostgreSQL: the withdrawal sweep
 * (FOR UPDATE on every guardian of an athlete) and the consent readers (FOR
 * SHARE on the same rows) cannot deadlock, on an athlete with three guardians.
 *
 * Before guardianConsent.ts lockGuardianLinksForAthlete every locker relied on
 * the planner happening to return the rows in the same order. Now they all
 * lock ORDER BY parent_id, and this suite proves the order is what keeps them
 * apart:
 *
 *   - DETERMINISTIC. A third connection holds the MIDDLE guardian's row. The
 *     sweep starts, locks the first row and waits on the middle one; a reader
 *     starts and waits too; then the middle row is released. In the shared
 *     order the reader is queued behind the sweep and both finish. With the
 *     reader deliberately reversed it has already taken the LAST row when the
 *     middle one frees, so whichever of the two gets the middle row waits on
 *     the other: Postgres reports 40P01 every time. The reversed run is the
 *     proof that the test can fail; the shared-order run is the result.
 *   - STRESS. The shipped functions -- the sweep, both readers and a consent
 *     withdrawal -- run concurrently, many rounds, and none deadlocks. Nothing
 *     forces an interleaving here, so this is a smoke test; the deterministic
 *     rounds are the proof.
 *
 * Spins up the same disposable, local-only embedded Postgres the other
 * migration suites use. It NEVER connects to production or staging.
 */

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
const PG_DATABASE = 'ppbf_test_guardian_lock_order';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-guardian-lock-order-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-lock-order';
const COACH_ID = 'acct-lock-order-coach';
const ATHLETE_ID = 'ath-lock-order';
// Three guardians, so there is a first, a middle and a last row.
const PARENT_IDS = ['parent-lock-a', 'parent-lock-b', 'parent-lock-c'];
const MIDDLE_PARENT_ID = PARENT_IDS[1];
// A second athlete, after the first in the shared order, who shares the middle
// guardian -- the guardian the purge removes. Their links span both athletes,
// which is what makes the purge a multi-athlete locker.
const ATHLETE_2_ID = 'ath-lock-order-2';
const DEADLOCK = '40P01';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

type ConsentModule = typeof import('./guardianConsent');
type PublicationModule = typeof import('./publication');
type DbModule = typeof import('./db');
let consent: ConsentModule;
let publication: PublicationModule;
let db: DbModule;

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

async function connect(): Promise<Client> {
  const c = new Client({ connectionString: connectionStringFor(PG_DATABASE) });
  await c.connect();
  return c;
}

/** Resolves once `pid` is blocked on a lock; fails the test if it never is. */
async function waitUntilBlocked(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const row = await client.query(
      `select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'`,
      [pid],
    );
    if ((row.rowCount ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`backend ${pid} never blocked on a lock; the interleaving was not set up`);
}

type Locker = (tx: Client) => Promise<unknown>;

/*
 * One deterministic round: a holder takes the middle guardian's row on the
 * first athlete, `firstLock` starts and blocks, `secondLock` starts and
 * blocks, the holder commits. Returns the SQLSTATE each side ended with (null
 * = finished). Every connection is closed before returning, whatever happened.
 */
async function middleRowRound(firstLock: Locker, secondLock: Locker): Promise<{ first: string | null; second: string | null }> {
  const holder = await connect();
  const sweeper = await connect();
  const reader = await connect();
  try {
    await holder.query('begin');
    await holder.query(
      `select 1 from pilot.guardian_links
        where organization_id = $1 and parent_id = $2 and athlete_id = $3
        for update`,
      [ORG_ID, MIDDLE_PARENT_ID, ATHLETE_ID],
    );

    const settle = async (tx: Client, locker: Locker): Promise<string | null> => {
      try {
        await locker(tx);
        await tx.query('commit');
        return null;
      } catch (error) {
        await tx.query('rollback').catch(() => {});
        return (error as { code?: string }).code ?? String(error);
      }
    };

    // The first locker takes what it can and waits on the middle row.
    await sweeper.query('begin');
    const sweepDone = settle(sweeper, firstLock);
    await waitUntilBlocked(backendPidOf(sweeper));

    await reader.query('begin');
    const readerDone = settle(reader, secondLock);
    await waitUntilBlocked(backendPidOf(reader));

    await holder.query('commit');
    const [first, second] = await Promise.all([sweepDone, readerDone]);
    return { first, second };
  } finally {
    await Promise.all([holder.end(), sweeper.end(), reader.end()].map((p) => p.catch(() => {})));
  }
}

// pg's Client exposes the backend pid once connected; read it rather than
// issuing a query on a connection that is about to block.
function backendPidOf(c: Client): number {
  return (c as unknown as { processID: number }).processID;
}

const sweepInSharedOrder: Locker = (tx) => consent.lockGuardianLinksForAthlete(tx, ORG_ID, ATHLETE_ID, 'update');
const readInSharedOrder: Locker = (tx) => consent.lockGuardianLinksForAthlete(tx, ORG_ID, ATHLETE_ID, 'share');
// Test-only: the same read with the order flipped. The source scan exempts
// test files, which is the only reason this can exist.
const readInReversedOrder: Locker = (tx) => tx.query(
  `select parent_id from pilot.guardian_links
    where organization_id = $1 and athlete_id = $2
    order by parent_id desc
    for share`,
  [ORG_ID, ATHLETE_ID],
);

// Two athletes at once, as Film Study and tagged-clip playback read them.
// Passed out of order: the helper sorts.
const readTwoAthletesInOnePass: Locker = (tx) => consent.lockGuardianLinksForAthletes(
  tx, ORG_ID, [ATHLETE_2_ID, ATHLETE_ID], 'share',
);
// The other sanctioned shape: one athlete at a time, ascending athlete_id.
const readTwoAthletesAscending: Locker = async (tx) => {
  for (const athleteId of [ATHLETE_2_ID, ATHLETE_ID].sort()) {
    await consent.lockGuardianLinksForAthlete(tx, ORG_ID, athleteId, 'share');
  }
};
const purgeInSharedOrder: Locker = (tx) => consent.lockGuardianLinksForPurge(
  tx, [], [{ organization_id: ORG_ID, parent_id: MIDDLE_PARENT_ID }],
);
// Test-only: the purge taking the guardian's links in the order its loop
// used to reach them -- the second athlete's cascade before the first's.
const purgeInLoopOrder: Locker = (tx) => tx.query(
  `select 1 from pilot.guardian_links
    where organization_id = $1 and parent_id = $2
    order by athlete_id desc
    for update`,
  [ORG_ID, MIDDLE_PARENT_ID],
);

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
  // Detect a deadlock in 200 ms rather than the default second, so the
  // reversed rounds stay quick. New connections pick it up.
  await admin.query(`alter database ${PG_DATABASE} set deadlock_timeout = '200ms'`);
  await admin.end();

  client = await connect();

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
     values ($1, 'coach', $2, 'microsoft')`,
    [COACH_ID, ORG_ID],
  );
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Lock Order Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  // Inserted out of parent_id order, so the rows come back unsorted unless
  // the helper's ORDER BY sorts them; 'the shared order is parent_id order'
  // depends on this.
  for (const parentId of [PARENT_IDS[2], PARENT_IDS[0], PARENT_IDS[1]]) {
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, full_name) values ($1, $2, $2)`,
      [ORG_ID, parentId],
    );
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, $2, $3, 'guardian')`,
      [ORG_ID, parentId, ATHLETE_ID],
    );
  }

  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Lock Order Athlete Two', '2013-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_2_ID, COACH_ID],
  );
  await client.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, $2, $3, 'guardian')`,
    [ORG_ID, MIDDLE_PARENT_ID, ATHLETE_2_ID],
  );

  // Env before import: db.ts builds its pool on first use.
  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(PG_DATABASE);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  consent = await import('./guardianConsent');
  publication = await import('./publication');
  db = await import('./db');
});

afterAll(async () => {
  await db?.closePool?.();
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

beforeEach(async () => {
  await client.query('delete from pilot.waivers');
  for (const parentId of PARENT_IDS) {
    await client.query(
      `insert into pilot.waivers
         (organization_id, waiver_id, athlete_id, parent_id, waiver_type, signed_by_name,
          signed_by_role, signed_at, consent_version, status, covers_video)
       values ($1, gen_random_uuid(), $2, $3, 'photo_media', $3, 'parent', now(), 'v1', 'signed', true)`,
      [ORG_ID, ATHLETE_ID, parentId],
    );
  }
});

describe('guardian_links consent locks share one order and cannot deadlock', () => {
  test('the shared order is parent_id order', async () => {
    const tx = await connect();
    try {
      await tx.query('begin');
      expect(await consent.lockGuardianLinksForAthlete(tx, ORG_ID, ATHLETE_ID, 'share')).toEqual(PARENT_IDS);
      await tx.query('rollback');
    } finally {
      await tx.end();
    }
  });

  test('CONTROL: a reader in the REVERSED order deadlocks against the sweep, every round', async () => {
    // Without this the shared-order test below could pass because the
    // interleaving never produced a cycle at all.
    for (let round = 0; round < 5; round += 1) {
      const { first, second } = await middleRowRound(sweepInSharedOrder, readInReversedOrder);
      expect([first, second].filter((code) => code === DEADLOCK)).toHaveLength(1);
    }
  });

  test('the sweep and a reader in the shared order both finish, every round', async () => {
    for (let round = 0; round < 20; round += 1) {
      expect(await middleRowRound(sweepInSharedOrder, readInSharedOrder)).toEqual({ first: null, second: null });
    }
  });

  test('two sweeps in the shared order both finish (two guardians withdrawing at once)', async () => {
    for (let round = 0; round < 10; round += 1) {
      expect(await middleRowRound(sweepInSharedOrder, sweepInSharedOrder)).toEqual({ first: null, second: null });
    }
  });

  test('the shipped readers queue behind the sweep in the same interleaving', async () => {
    const readers: Locker[] = [
      (tx) => consent.checkGuardianMediaConsent(ORG_ID, ATHLETE_ID, tx),
      (tx) => consent.assertGuardianMediaConsentWithClient(tx, ORG_ID, ATHLETE_ID),
    ];
    for (const readerLock of readers) {
      for (let round = 0; round < 5; round += 1) {
        expect(await middleRowRound(sweepInSharedOrder, readerLock)).toEqual({ first: null, second: null });
      }
    }
  });

  /*
   * The retention purge deletes one guardian's links across several athletes.
   * The reader goes first here: it takes the first athlete's first row and
   * queues on the middle one, then the purge queues behind it. In the shared
   * order the purge is waiting on that same first-athlete row and holds
   * nothing the reader needs. In the old loop order the purge already holds
   * the SECOND athlete's row when the reader, granted the middle row, reaches
   * for it.
   */
  test('CONTROL: a purge in its old loop order deadlocks against a two-athlete reader, every round', async () => {
    for (let round = 0; round < 5; round += 1) {
      const { first, second } = await middleRowRound(readTwoAthletesInOnePass, purgeInLoopOrder);
      expect([first, second].filter((code) => code === DEADLOCK)).toHaveLength(1);
    }
  });

  test('the purge lock and a two-athlete reader in the shared order both finish, every round', async () => {
    for (const reader of [readTwoAthletesInOnePass, readTwoAthletesAscending]) {
      for (let round = 0; round < 10; round += 1) {
        expect(await middleRowRound(reader, purgeInSharedOrder)).toEqual({ first: null, second: null });
      }
    }
  });

  /*
   * The playback lane orders athletes with a plain JavaScript sort (UTF-16
   * code units). Postgres would order by the column's collation, which under a
   * locale such as en_US puts 'ath-a' before 'ath-B' -- the opposite of the
   * JavaScript sort. The helpers say COLLATE "C" so the two agree.
   */
  test('the shared order is byte order: mixed case sorts as a JavaScript sort does', async () => {
    const tx = await connect();
    try {
      await tx.query('begin');
      const athleteIds = ['ath-a', 'ath-B'];
      const parentIds = ['par-y', 'par-Z'];
      for (const athleteId of athleteIds) {
        await tx.query(
          `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
           values ($1, $2, $2, '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
          [ORG_ID, athleteId, COACH_ID],
        );
      }
      for (const parentId of parentIds) {
        await tx.query('insert into pilot.parents (organization_id, parent_id, full_name) values ($1, $2, $2)', [ORG_ID, parentId]);
        for (const athleteId of athleteIds) {
          await tx.query(
            `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
             values ($1, $2, $3, 'guardian')`,
            [ORG_ID, parentId, athleteId],
          );
        }
      }

      const jsOrder = athleteIds.flatMap((a) => parentIds.map((p) => `${a}/${p}`)).sort();
      expect(jsOrder).toEqual(['ath-B/par-Z', 'ath-B/par-y', 'ath-a/par-Z', 'ath-a/par-y']);

      const locked = await consent.lockGuardianLinksForAthletes(tx, ORG_ID, athleteIds, 'share');
      expect(locked.map((row) => `${row.athlete_id}/${row.parent_id}`)).toEqual(jsOrder);
      expect(await consent.lockGuardianLinksForAthlete(tx, ORG_ID, 'ath-B', 'share')).toEqual(['par-Z', 'par-y']);

      // The ids discriminate: a locale collation, where the server has one,
      // puts them the other way round. Without this the assertions above
      // could pass on a server whose default collation is already "C".
      const locale = await tx.query<{ collname: string }>(
        `select collname from pg_collation
          where collname in ('en-US-x-icu', 'und-x-icu', 'en_US.utf8', 'en_US.UTF-8', 'en_US')
          order by collname limit 1`,
      );
      if (locale.rows.length > 0) {
        const byLocale = await tx.query<{ athlete_id: string }>(
          `select athlete_id from unnest($1::text[]) as ids(athlete_id)
            order by athlete_id collate "${locale.rows[0].collname}"`,
          [athleteIds],
        );
        expect(byLocale.rows.map((row) => row.athlete_id)).toEqual(['ath-a', 'ath-B']);
      }
      await tx.query('rollback');
    } finally {
      await tx.end();
    }
  });

  test('STRESS: the shipped sweep, readers and a withdrawal, concurrently, never deadlock', async () => {
    // Writers must succeed; readers may refuse once a withdrawal lands (that
    // is the consent gate working), but nothing may end in a deadlock.
    const outcomes: Array<{ kind: 'writer' | 'reader'; code: string | null }> = [];
    const record = async (kind: 'writer' | 'reader', work: Promise<unknown>) => {
      try {
        await work;
        outcomes.push({ kind, code: null });
      } catch (error) {
        outcomes.push({
          kind,
          code: error instanceof consent.GuardianConsentMissingError
            ? 'consent-missing'
            : (error as { code?: string }).code ?? (error as Error).message,
        });
      }
    };

    for (let round = 0; round < 50; round += 1) {
      await Promise.all([
        record('writer', publication.suppressPublishedMediaForAthlete({
          organizationId: ORG_ID,
          athleteId: ATHLETE_ID,
          suppressedByAccountId: COACH_ID,
          reason: 'guardian_consent_withdrawn',
        })),
        record('reader', db.withTransaction((tx) => consent.checkGuardianMediaConsent(ORG_ID, ATHLETE_ID, tx))),
        record('reader', db.withTransaction(async (tx) => {
          await consent.checkGuardianMediaConsent(ORG_ID, ATHLETE_ID, tx);
          await consent.assertGuardianMediaConsentWithClient(tx, ORG_ID, ATHLETE_ID);
        })),
        record('writer', publication.suppressPublishedMediaForAthlete({
          organizationId: ORG_ID,
          athleteId: ATHLETE_ID,
          suppressedByAccountId: COACH_ID,
          reason: 'guardian_consent_withdrawn',
        })),
        record('writer', consent.withdrawMediaConsent({
          organizationId: ORG_ID,
          athleteId: ATHLETE_ID,
          parentId: PARENT_IDS[round % PARENT_IDS.length],
          signedByName: 'Stress Guardian',
          recordedByAccountId: COACH_ID,
        })),
      ]);
    }

    expect(outcomes).toHaveLength(250);
    expect(outcomes.filter((o) => o.code === DEADLOCK)).toEqual([]);
    expect(outcomes.filter((o) => o.kind === 'writer' && o.code !== null)).toEqual([]);
    // A reader may refuse once a withdrawal has landed, and for no other reason.
    expect(outcomes.filter((o) => o.kind === 'reader' && o.code !== null && o.code !== 'consent-missing')).toEqual([]);
  });
});
