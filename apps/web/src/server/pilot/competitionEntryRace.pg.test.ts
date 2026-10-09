/**
 * The competition-entry race, against real PostgreSQL (Codex CX-1).
 *
 * Entering a child in an external competition, or adding them to a wrestling
 * league season roster, runs two safety gates that read state other writers
 * change: an active training hold covering contact, and the guardian's travel
 * waiver (competitionSafetyGates.ts). Both gates refuse. Neither refusal is
 * worth anything if a hold placed, or a travel consent withdrawn, can commit
 * between the gate's read and the entry's insert -- the child is then entered
 * on a "yes" that was already a "no" by the time the row landed, and every
 * per-component test still passes because each half is correct on its own.
 *
 * The property this suite pins, in both directions:
 *
 *   - A hold or withdrawal already in flight when an entry starts BLOCKS the
 *     entry: the entry waits for it and then refuses.
 *   - An entry already in flight when a hold or withdrawal starts makes the
 *     writer WAIT until the entry has committed. The writer is never able to
 *     commit while the entry is between its checks and its insert.
 *
 * The interleaving is driven deterministically through the SHIPPED route
 * handlers and the SHIPPED writers (placeTrainingHold, upsertWaiver). The
 * test pauses one side at a real point inside its transaction by holding an
 * EXCLUSIVE table lock on the table that side writes next, and observes the
 * other side either finishing (the race is open) or waiting on a lock (the
 * race is closed) before releasing it.
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

import { NextRequest } from 'next/server';
import { Client } from 'pg';

jest.setTimeout(180_000);

// The routes resolve the caller from a session cookie; this suite is about the
// database interleaving, not sign-in, so the principal is supplied directly.
jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const PG_DATABASE = 'ppbf_test_competition_entry_race';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-competition-entry-race-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-entry-race';
const ADMIN_ID = 'acct-entry-race-admin';
const ATHLETE_ID = 'ath-entry-race';
const COMPETITION_ID = 'comp-entry-race';
const SEASON_ID = 'season-entry-race';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

type EntriesRoute = typeof import('../../../app/api/pilot/operations/external-competition/entries/route');
type RosterRoute = typeof import('../../../app/api/pilot/operations/wrestling-league/roster/route');
let entriesRoute: EntriesRoute;
let rosterRoute: RosterRoute;
let holds: typeof import('./trainingHolds');
let intake: typeof import('./intake');
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

type EventKind = 'external_competition' | 'wrestling_league_season';

/** POSTs through the shipped route handler and settles to the HTTP status. */
async function enter(kind: EventKind): Promise<number> {
  if (kind === 'external_competition') {
    const response = await entriesRoute.POST(
      new NextRequest('http://localhost/api/pilot/operations/external-competition/entries', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ competition_id: COMPETITION_ID, athlete_id: ATHLETE_ID }),
      }),
    );
    return response.status;
  }
  const response = await rosterRoute.POST(
    new NextRequest('http://localhost/api/pilot/operations/wrestling-league/roster', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ season_id: SEASON_ID, athlete_id: ATHLETE_ID }),
    }),
  );
  return response.status;
}

const ENTRY_TABLE: Record<EventKind, string> = {
  external_competition: 'pilot.external_competition_entries',
  wrestling_league_season: 'pilot.wrestling_league_roster_entries',
};

async function entryRows(kind: EventKind): Promise<number> {
  const result = await client.query(`select 1 from ${ENTRY_TABLE[kind]} where athlete_id = $1`, [ATHLETE_ID]);
  return result.rowCount ?? 0;
}

function placeHold(): Promise<unknown> {
  return holds.placeTrainingHold({
    organizationId: ORG_ID,
    athleteId: ATHLETE_ID,
    scope: 'contact_only',
    reasonCategory: 'medical',
    reasonText: 'Concussion protocol.',
    athleteExplanation: 'No contact until the doctor clears you.',
    liftConditionText: 'Written clearance on file.',
    placedByAccountId: ADMIN_ID,
    placedByRole: 'organization_admin',
  });
}

/** The shipped travel-waiver writer, pooled path (no caller transaction). */
function writeTravelWaiver(status: 'signed' | 'withdrawn'): Promise<unknown> {
  return intake.upsertWaiver({
    organizationId: ORG_ID,
    athleteId: ATHLETE_ID,
    waiverType: 'travel',
    signedByName: 'Race Guardian',
    signedByRole: 'guardian',
    signedAt: new Date().toISOString(),
    consentVersion: 'v1',
    status,
    recordedByAccountId: ADMIN_ID,
  });
}

/**
 * Holds an EXCLUSIVE lock on `table` on a connection of its own, which pauses
 * any transaction at the moment it next writes to that table -- a real pause
 * point inside the shipped code, not a simulated one. Reads are not blocked
 * (EXCLUSIVE admits ACCESS SHARE).
 */
async function pauseWritesTo(table: string): Promise<{ pid: number; release: () => Promise<void> }> {
  const holder = new Client({ connectionString: connectionStringFor(PG_DATABASE) });
  await holder.connect();
  await holder.query('begin');
  await holder.query(`lock table ${table} in exclusive mode`);
  const pid = (await holder.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0].pid;
  let released = false;
  return {
    pid,
    release: async () => {
      if (released) return;
      released = true;
      await holder.query('commit');
      await holder.end();
    },
  };
}

/**
 * Resolves once at least `count` backends (other than ours and the holder)
 * wait on a lock. Gives up after a bounded wait so a case whose other side
 * already finished does not leave this polling past the suite's teardown.
 */
async function lockWaiters(count: number, holderPid: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await client.query(
      `select 1 from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid() and pid <> $1
          and wait_event_type = 'Lock'`,
      [holderPid],
    );
    if ((result.rowCount ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${count} lock waiter(s)`);
}

/**
 * Settles to which happened first: the writer finishing (settled either way),
 * or the expected lock wait appearing. A wait that never appears is reported
 * as such rather than counted for either side.
 */
function firstOf<A extends string, B extends string>(
  finished: [A, Promise<unknown>],
  waiting: [B, Promise<unknown>],
): Promise<A | B | 'neither'> {
  return Promise.race([
    finished[1].then(() => finished[0], () => finished[0]),
    waiting[1].then(() => waiting[0], () => 'neither' as const),
  ]);
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
     values ($1, 'organization_admin', $2, 'microsoft') on conflict do nothing`,
    [ADMIN_ID, ORG_ID],
  );
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Race Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, ADMIN_ID],
  );
  await client.query(
    `insert into pilot.external_competitions (organization_id, competition_id, competition_name, competition_date, created_by_account_id)
     values ($1, $2, 'County Open', '2026-11-01', $3)`,
    [ORG_ID, COMPETITION_ID, ADMIN_ID],
  );
  await client.query(
    `insert into pilot.wrestling_league_seasons (organization_id, season_id, season_name, starts_on, created_by_account_id)
     values ($1, $2, 'Winter', '2026-11-01', $3)`,
    [ORG_ID, SEASON_ID, ADMIN_ID],
  );

  // Env before import: db.ts builds its pool on first use.
  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(PG_DATABASE);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  const http = await import('@/src/server/pilot/http');
  (http.requirePrincipal as jest.Mock).mockResolvedValue({
    accountId: ADMIN_ID,
    role: 'organization_admin',
    organizationId: ORG_ID,
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
  });
  entriesRoute = await import('../../../app/api/pilot/operations/external-competition/entries/route');
  rosterRoute = await import('../../../app/api/pilot/operations/wrestling-league/roster/route');
  holds = await import('./trainingHolds');
  intake = await import('./intake');
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

beforeEach(async () => {
  await client.query('delete from pilot.external_competition_entries');
  await client.query('delete from pilot.wrestling_league_roster_entries');
  await client.query('delete from pilot.safety_escalations where athlete_id = $1', [ATHLETE_ID]).catch(() => undefined);
  await client.query('delete from pilot.training_holds');
  await client.query('delete from pilot.waivers');
  // Every case starts from a child the gates would clear.
  await writeTravelWaiver('signed');
});

describe.each<EventKind>(['external_competition', 'wrestling_league_season'])('%s entry', (kind) => {
  test('CONTROL: a cleared child with nothing in flight is entered', async () => {
    // Without this every refusal below could be a refusal for free.
    expect(await enter(kind)).toBe(200);
    expect(await entryRows(kind)).toBe(1);
  });

  test('an entry in flight makes a hold placement wait until the entry has committed', async () => {
    const paused = await pauseWritesTo(ENTRY_TABLE[kind]);
    let holding: Promise<unknown> = Promise.resolve();
    let entering: Promise<number> = Promise.resolve(0);
    let first: 'hold committed' | 'hold waiting' | 'neither' = 'hold committed';
    try {
      // The entry clears its gates and stops at its insert.
      entering = enter(kind);
      await lockWaiters(1, paused.pid);

      // A hold arrives now. Either it commits while the entry is still
      // between its checks and its insert (the race), or it waits for the
      // entry (closed). Observe which BEFORE releasing anything.
      holding = placeHold();
      first = await firstOf(['hold committed', holding], ['hold waiting', lockWaiters(2, paused.pid)]);
    } finally {
      await paused.release();
    }
    const entryStatus = await entering;
    await holding.catch(() => undefined);

    expect(first).toBe('hold waiting');
    expect(entryStatus).toBe(200);
    // The hold still lands -- after the entry, which is the ordering a coach
    // can see and act on (withdraw the entry), not one the gate missed.
    const active = await client.query(`select 1 from pilot.training_holds where athlete_id = $1 and status = 'active'`, [ATHLETE_ID]);
    expect(active.rowCount).toBe(1);
  });

  test('an entry in flight makes a travel-consent withdrawal wait until the entry has committed', async () => {
    const paused = await pauseWritesTo(ENTRY_TABLE[kind]);
    let withdrawing: Promise<unknown> = Promise.resolve();
    let entering: Promise<number> = Promise.resolve(0);
    let first: 'withdrawal committed' | 'withdrawal waiting' | 'neither' = 'withdrawal committed';
    try {
      entering = enter(kind);
      await lockWaiters(1, paused.pid);

      withdrawing = writeTravelWaiver('withdrawn');
      first = await firstOf(['withdrawal committed', withdrawing], ['withdrawal waiting', lockWaiters(2, paused.pid)]);
    } finally {
      await paused.release();
    }
    const entryStatus = await entering;
    await withdrawing.catch(() => undefined);

    expect(first).toBe('withdrawal waiting');
    expect(entryStatus).toBe(200);
  });

  test('a hold in flight when the entry starts blocks the entry', async () => {
    // placeTrainingHold inserts the hold and then files its escalation;
    // pausing the escalation write holds the hold transaction open, uncommitted.
    const paused = await pauseWritesTo('pilot.safety_escalations');
    let holding: Promise<unknown> = Promise.resolve();
    let entering: Promise<number> = Promise.resolve(0);
    let first: 'entry finished' | 'entry waiting' | 'neither' = 'entry finished';
    try {
      holding = placeHold();
      await lockWaiters(1, paused.pid);

      entering = enter(kind);
      first = await firstOf(['entry finished', entering], ['entry waiting', lockWaiters(2, paused.pid)]);
    } finally {
      await paused.release();
    }
    await holding;
    const entryStatus = await entering;

    expect(first).toBe('entry waiting');
    expect(entryStatus).toBe(403);
    expect(await entryRows(kind)).toBe(0);
  });

  test('a travel-consent withdrawal in flight when the entry starts blocks the entry', async () => {
    const paused = await pauseWritesTo('pilot.waivers');
    let withdrawing: Promise<unknown> = Promise.resolve();
    let entering: Promise<number> = Promise.resolve(0);
    let first: 'entry finished' | 'entry waiting' | 'neither' = 'entry finished';
    try {
      withdrawing = writeTravelWaiver('withdrawn');
      await lockWaiters(1, paused.pid);

      entering = enter(kind);
      first = await firstOf(['entry finished', entering], ['entry waiting', lockWaiters(2, paused.pid)]);
    } finally {
      await paused.release();
    }
    await withdrawing;
    const entryStatus = await entering;

    expect(first).toBe('entry waiting');
    expect(entryStatus).toBe(409);
    expect(await entryRows(kind)).toBe(0);
  });
});

// RE-ENTRY (owner ruling 2026-10-05): a withdrawn competition entry can be
// entered again, and re-entry re-runs every safety gate. Driven through the
// shipped POST and PATCH so the gates and the lock are the real ones.
describe('external competition re-entry after withdrawal', () => {
  async function withdraw(): Promise<number> {
    const entry = await client.query<{ entry_id: string }>(
      `select entry_id from pilot.external_competition_entries where athlete_id = $1`,
      [ATHLETE_ID],
    );
    const response = await entriesRoute.PATCH(
      new NextRequest('http://localhost/api/pilot/operations/external-competition/entries', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entry_id: entry.rows[0].entry_id, status: 'withdrawn' }),
      }),
    );
    return response.status;
  }

  async function entryState(): Promise<Array<{ status: string; result: string | null; lesson_note: string }>> {
    const result = await client.query<{ status: string; result: string | null; lesson_note: string }>(
      `select status, result, lesson_note from pilot.external_competition_entries where athlete_id = $1`,
      [ATHLETE_ID],
    );
    return result.rows;
  }

  test('a withdrawn athlete with every gate clear is entered again on the same row, result cleared', async () => {
    expect(await enter('external_competition')).toBe(200);
    // A result recorded before the withdrawal must not ride into the new entry.
    await client.query(
      `update pilot.external_competition_entries set result = 'lost', lesson_note = 'Kept my hands low.' where athlete_id = $1`,
      [ATHLETE_ID],
    );
    expect(await withdraw()).toBe(200);

    expect(await enter('external_competition')).toBe(200);
    expect(await entryState()).toEqual([{ status: 'entered', result: null, lesson_note: '' }]);
  });

  test('an athlete still entered cannot be entered twice', async () => {
    expect(await enter('external_competition')).toBe(200);
    expect(await enter('external_competition')).toBe(409);
    expect(await entryRows('external_competition')).toBe(1);
  });

  test('re-entry is refused while a contact hold is active', async () => {
    expect(await enter('external_competition')).toBe(200);
    expect(await withdraw()).toBe(200);
    await placeHold();

    expect(await enter('external_competition')).toBe(403);
    expect(await entryState()).toEqual([{ status: 'withdrawn', result: null, lesson_note: '' }]);
  });

  test('re-entry is refused once travel consent is withdrawn', async () => {
    expect(await enter('external_competition')).toBe(200);
    expect(await withdraw()).toBe(200);
    await writeTravelWaiver('withdrawn');

    expect(await enter('external_competition')).toBe(409);
    expect(await entryState()).toEqual([{ status: 'withdrawn', result: null, lesson_note: '' }]);
  });
});
