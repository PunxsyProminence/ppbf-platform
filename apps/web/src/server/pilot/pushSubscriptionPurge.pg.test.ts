/**
 * A purged athlete's login loses its web push browser rows (endpoint, public
 * key and auth secret), on real PostgreSQL, through the retention purge
 * (scripts/pilot-cleanup-deleted-data.mjs, run as its own process).
 *
 * QG A and QH A on #2228 (lane W5-WP, WP-2b-1): the purge deletes
 * pilot.push_subscriptions for the athlete login in its athlete-login branch,
 * beside the email alert switches (EM-2b-1, whose suite this one follows). An
 * athlete's login is retired by the purge, not deleted, so the account and
 * membership keys' cascades never fire for it. Every gym's row of that login
 * goes: the login itself is retired. Its push send rows stay, as the email
 * send log's do. A live athlete's rows, another gym's athlete with the same
 * athlete id, a guardian's, a staff member's, and the rows of a purged child's
 * old login that is now a coach's or a guardian's all stay. A database without
 * the table purges as before.
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
const PG_DATABASE = 'ppbf_test_push_browser_purge';
// A second database, built the same way, with the table dropped.
const PG_DATABASE_NO_TABLE = 'ppbf_test_push_browser_purge_no_table';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-push-browser-purge-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const CLEANUP_SCRIPT = path.resolve(__dirname, '../../../scripts/pilot-cleanup-deleted-data.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-push-purge';
const OTHER_ORG_ID = 'org-push-purge-elsewhere';
const COACH_ID = 'acct-push-purge-coach';
const OTHER_COACH_ID = 'acct-push-purge-coach-elsewhere';
// The shapes pilot.push_subscriptions takes (WP-1a): a 65-byte public key and a 16-byte auth secret, base64url.
const P256DH = `B${'A'.repeat(86)}`;
const AUTH = 'A'.repeat(22);

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
const clients: Client[] = [];

/** One database and its connection: the purge runs against `name`. */
interface Db {
  name: string;
  client: Client;
}

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

type PurgeEvent = Record<string, unknown> & { blocked_by?: Record<string, number>; event?: string };

/**
 * Runs the purge and returns its one JSON line. Without apply it is the dry
 * run, which reports what it would delete and rolls everything back. Storage
 * is switched off: no case here has a file.
 */
async function purge(db: Db, apply: boolean): Promise<PurgeEvent> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      [CLEANUP_SCRIPT],
      {
        env: {
          ...process.env,
          AZURE_POSTGRES_CONNECTION_STRING: connectionStringFor(db.name),
          PPBF_EXPECTED_POSTGRES_HOSTNAME: 'localhost',
          PPBF_EXPECTED_POSTGRES_DATABASE: db.name,
          PPBF_POSTGRES_DISABLE_SSL: 'true',
          PPBF_RETENTION_STORAGE_ACCOUNT_URL: '',
          PPBF_RETENTION_APPLY_INQUIRIES: '',
          PPBF_RETENTION_APPLY: apply ? 'true' : '',
        },
      },
      (error, stdout, stderr) => (error ? reject(new Error(`${stdout}${stderr}`)) : resolve(`${stdout}${stderr}`)),
    );
  });
  const line = output.split('\n').find((entry) => entry.trim().startsWith('{'));
  const event = JSON.parse(line ?? '{}') as PurgeEvent;
  // A purge that was refused proves nothing below.
  expect(event.blocked_by ?? {}).toEqual({});
  return event;
}

/** The details of the newest purge audit row. */
async function lastAuditDetails(db: Db): Promise<Record<string, unknown>> {
  const rows = await db.client.query(
    `select details from pilot.audit_events
      where event_type = 'data_purged' and entity_type = 'retention_cleanup'
      order by audit_id desc limit 1`,
  );
  const details = rows.rows[0]?.details;
  return (typeof details === 'string' ? JSON.parse(details) : details) as Record<string, unknown>;
}

async function browserRowsOf(db: Db, accountId: string): Promise<number> {
  const rows = await db.client.query('select 1 from pilot.push_subscriptions where account_id = $1', [accountId]);
  return rows.rowCount ?? 0;
}

/** Every browser row except the purged logins', whole, in a fixed order. */
async function otherBrowserRows(db: Db, purgedLogins: readonly string[]): Promise<unknown[]> {
  const rows = await db.client.query(
    'select * from pilot.push_subscriptions where account_id <> all($1::text[]) order by organization_id, account_id',
    [purgedLogins],
  );
  return rows.rows;
}

/** Every browser row, whole, in a fixed order. */
async function allBrowserRows(db: Db): Promise<unknown[]> {
  return (await db.client.query('select * from pilot.push_subscriptions order by subscription_id')).rows;
}

async function retiredLogin(db: Db, accountId: string): Promise<{ athlete_id: string | null; deleted: boolean }> {
  const rows = await db.client.query(
    'select athlete_id, deleted_at is not null as deleted from pilot.accounts where account_id = $1',
    [accountId],
  );
  return rows.rows[0];
}

async function addMembership(db: Db, accountId: string, organizationId: string, role: string): Promise<void> {
  await db.client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, $3, true) on conflict do nothing`,
    [accountId, organizationId, role],
  );
}

/** A database with the full schema, two gyms and a coach in each. */
async function freshDatabase(name: string): Promise<Db> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  clients.push(client);
  const { applyFullSchema } = (await nativeDynamicImport(
    pathToFileURL(FULL_SCHEMA_HELPER_PATH).href,
  )) as { applyFullSchema: (c: Client) => Promise<void> };
  await applyFullSchema(client);

  const db = { name, client };
  for (const [organizationId, coachId] of [[ORG_ID, COACH_ID], [OTHER_ORG_ID, OTHER_COACH_ID]]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
      [coachId, organizationId],
    );
    await addMembership(db, coachId, organizationId, 'coach');
  }
  return db;
}

interface Seeded {
  athleteLogin: string;
  coachNowLogin: string;
  parentNowLogin: string;
  liveAtPurgeLogin: string;
  liveAthleteLogin: string;
  elsewhereLogin: string;
  guardian: string;
}

const PEOPLE: Seeded = {
  athleteLogin: 'acct-push-ath',
  coachNowLogin: 'acct-push-coach-now',
  parentNowLogin: 'acct-push-parent-now',
  liveAtPurgeLogin: 'acct-push-live-at-purge',
  liveAthleteLogin: 'acct-push-live',
  elsewhereLogin: 'acct-push-elsewhere',
  guardian: 'acct-push-guardian',
};

let endpointCount = 0;
async function addBrowser(db: Db, organizationId: string, accountId: string, userType: string): Promise<string> {
  endpointCount += 1;
  const endpoint = `https://push.example.test/send/browser-${endpointCount}`;
  await db.client.query(
    `insert into pilot.push_subscriptions (organization_id, account_id, user_type, endpoint, key_p256dh, key_auth)
     values ($1, $2, $3, $4, $5, $6)`,
    [organizationId, accountId, userType, endpoint, P256DH, AUTH],
  );
  return endpoint;
}

/*
 * As the email switch purge suite's people (emailAlertSwitchPurge.pg.test.ts):
 * an adult athlete deleted three years ago (past the two-year window) whose
 * own login has two browsers on in this gym and one in another gym it coaches
 * in; a second purged athlete whose login has since become a coach's, and a
 * third whose login has become a guardian's (each unlinked by the purge, but
 * that adult's now, so the rows stay); a fourth whose own login is still live
 * when the purge runs (it retires that login, so its row goes); a live
 * athlete; an athlete in another gym with the SAME athlete id, who is another
 * child; a live guardian of the purged child; and a staff member. The purged
 * login also has a push send row, which stays. With `withTable` false the
 * table is gone and no browser row is written.
 */
async function seed(db: Db, withTable: boolean): Promise<{ people: Seeded; purgedEndpoints: string[] }> {
  const purged = 'ath-push-gone';
  const purgedStaffNow = 'ath-push-staff-now';
  const purgedParentNow = 'ath-push-parent-now';
  const purgedLiveLogin = 'ath-push-live-login';
  const live = 'ath-push-live';
  const people = PEOPLE;
  const q = (sql: string, params: unknown[]) => db.client.query(sql, params);

  for (const [organizationId, athleteId, coachId] of [
    [ORG_ID, purged, COACH_ID], [ORG_ID, purgedStaffNow, COACH_ID], [ORG_ID, purgedParentNow, COACH_ID],
    [ORG_ID, purgedLiveLogin, COACH_ID], [ORG_ID, live, COACH_ID],
    [OTHER_ORG_ID, purged, OTHER_COACH_ID],
  ]) {
    await q(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Push Athlete', '2000-03-14', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [organizationId, athleteId, coachId],
    );
  }
  for (const [accountId, role, organizationId, athleteId, deleted] of [
    [people.athleteLogin, 'athlete', ORG_ID, purged, "now() - interval '3 years'"],
    [people.coachNowLogin, 'coach', ORG_ID, purgedStaffNow, 'null'],
    [people.parentNowLogin, 'parent', ORG_ID, purgedParentNow, 'null'],
    [people.liveAtPurgeLogin, 'athlete', ORG_ID, purgedLiveLogin, 'null'],
    [people.liveAthleteLogin, 'athlete', ORG_ID, live, 'null'],
    [people.elsewhereLogin, 'athlete', OTHER_ORG_ID, purged, 'null'],
    [people.guardian, 'parent', ORG_ID, null, 'null'],
  ] as const) {
    await q(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, auth_provider, active_flag, deleted_at)
       values ($1, $2, $3, $4, 'ppbf_local', ${deleted} is null, ${deleted})`,
      [accountId, role, organizationId, athleteId],
    );
  }
  for (const [accountId, organizationId, role] of [
    [people.athleteLogin, ORG_ID, 'athlete'],
    // A coach in the other gym: its browser there is a staff one.
    [people.athleteLogin, OTHER_ORG_ID, 'coach'],
    [people.coachNowLogin, ORG_ID, 'coach'],
    [people.parentNowLogin, ORG_ID, 'parent'],
    [people.liveAtPurgeLogin, ORG_ID, 'athlete'],
    [people.liveAthleteLogin, ORG_ID, 'athlete'],
    [people.elsewhereLogin, OTHER_ORG_ID, 'athlete'],
    [people.guardian, ORG_ID, 'parent'],
  ]) {
    await addMembership(db, accountId, organizationId, role);
  }
  await q(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name) values ($1, $2, $3, 'Push Guardian')`,
    [ORG_ID, `par-${people.guardian}`, people.guardian],
  );
  await q(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, $2, $3, 'parent')`,
    [ORG_ID, `par-${people.guardian}`, purged],
  );
  // A send row the purged login was queued, in the gym where it was an athlete.
  await q(
    `insert into pilot.push_alert_sends (organization_id, account_id, user_type, event_kind, event_id, status, finished_at)
     values ($1, $2, 'adult_athlete', 'coach_message', '00000000-0000-4000-8000-000000000001', 'sent', now())`,
    [ORG_ID, people.athleteLogin],
  );

  const purgedEndpoints: string[] = [];
  if (withTable) {
    // The purged login: two browsers in this gym, one in the other gym, where
    // it is a coach (a staff browser). A delete narrowed to one gym, or to
    // adult athletes' rows, leaves one.
    purgedEndpoints.push(await addBrowser(db, ORG_ID, people.athleteLogin, 'adult_athlete'));
    purgedEndpoints.push(await addBrowser(db, ORG_ID, people.athleteLogin, 'adult_athlete'));
    purgedEndpoints.push(await addBrowser(db, OTHER_ORG_ID, people.athleteLogin, 'staff'));
    // The login still live at the purge.
    purgedEndpoints.push(await addBrowser(db, ORG_ID, people.liveAtPurgeLogin, 'adult_athlete'));
    await addBrowser(db, ORG_ID, people.liveAthleteLogin, 'adult_athlete');
    await addBrowser(db, OTHER_ORG_ID, people.elsewhereLogin, 'adult_athlete');
    // User type 'staff' is OW27-10's word for a coach or admin.
    for (const [accountId, userType] of [
      [people.guardian, 'parent'], [people.coachNowLogin, 'staff'], [people.parentNowLogin, 'parent'], [COACH_ID, 'staff'],
    ]) {
      await addBrowser(db, ORG_ID, accountId, userType);
    }
  }

  await q(
    `update pilot.athletes set deleted_at = now() - interval '3 years'
      where organization_id = $1 and athlete_id = any($2::text[])`,
    [ORG_ID, [purged, purgedStaffNow, purgedParentNow, purgedLiveLogin]],
  );
  return { people, purgedEndpoints };
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
});

afterAll(async () => {
  for (const client of clients) await client.end().catch(() => {});
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

describe('the retention purge and the web push browsers', () => {
  test("deletes a purged athlete login's browser rows in every gym, keys included, and no one else's; its send rows stay", async () => {
    const db = await freshDatabase(PG_DATABASE);
    const { people, purgedEndpoints } = await seed(db, true);
    // CONTROL: the purged logins' rows are there.
    expect(await browserRowsOf(db, people.athleteLogin)).toBe(3);
    expect(await browserRowsOf(db, people.liveAtPurgeLogin)).toBe(1);
    const purgedLogins = [people.athleteLogin, people.liveAtPurgeLogin];
    const othersBefore = await otherBrowserRows(db, purgedLogins);
    expect(othersBefore).toHaveLength(6);
    const everyRowBefore = await allBrowserRows(db);

    // The dry run counts them and deletes nothing.
    const dry = await purge(db, false);
    expect(dry.event).toBe('retention.cleanup.dry-run');
    expect(dry.would_delete_athletes).toBe(4);
    expect(dry.would_delete_push_browsers).toBe(4);
    // Row for row, the dry run left every browser as it was.
    expect(await allBrowserRows(db)).toEqual(everyRowBefore);
    expect(await retiredLogin(db, people.athleteLogin)).toEqual({ athlete_id: 'ath-push-gone', deleted: true });

    // APPLY: the completion log and the audit row both carry the count.
    const applied = await purge(db, true);
    expect(applied.event).toBe('retention.cleanup.completed');
    expect(applied.athletes).toBe(4);
    expect(applied.push_browsers_deleted).toBe(4);
    const audit = await lastAuditDetails(db);
    expect(audit.athletes_deleted).toBe(4);
    expect(audit.push_browsers_deleted).toBe(4);

    // The login survives the purge, retired; its browsers, in both gyms, do not.
    expect(await retiredLogin(db, people.athleteLogin)).toEqual({ athlete_id: null, deleted: true });
    expect(await browserRowsOf(db, people.athleteLogin)).toBe(0);
    // The login still live when its child was purged is retired, and its row goes.
    expect(await retiredLogin(db, people.liveAtPurgeLogin)).toEqual({ athlete_id: null, deleted: true });
    expect(await browserRowsOf(db, people.liveAtPurgeLogin)).toBe(0);
    // No row anywhere still holds one of their browsers' endpoints.
    const left = await db.client.query('select 1 from pilot.push_subscriptions where endpoint = any($1::text[])', [purgedEndpoints]);
    expect(left.rowCount).toBe(0);
    // The purged login's send row stays (the web-push migration's header).
    const sends = await db.client.query('select status from pilot.push_alert_sends where account_id = $1', [people.athleteLogin]);
    expect(sends.rows).toEqual([{ status: 'sent' }]);

    // Every other row is exactly as it was: the live athlete's, the other
    // gym's child with the same athlete id, the guardian's, the staff
    // member's, and the old logins that are a coach's and a guardian's now,
    // which the purge did unlink but did not retire.
    expect(await otherBrowserRows(db, purgedLogins)).toEqual(othersBefore);
    expect(await retiredLogin(db, people.coachNowLogin)).toEqual({ athlete_id: null, deleted: false });
    expect(await retiredLogin(db, people.parentNowLogin)).toEqual({ athlete_id: null, deleted: false });
    for (const accountId of [
      people.liveAthleteLogin, people.elsewhereLogin, people.guardian, people.coachNowLogin, people.parentNowLogin, COACH_ID,
    ]) {
      expect(await browserRowsOf(db, accountId)).toBe(1);
    }
  });

  test('a database without the table purges as before and reports none', async () => {
    const db = await freshDatabase(PG_DATABASE_NO_TABLE);
    await db.client.query('drop table pilot.push_subscriptions');
    const { people } = await seed(db, false);

    const dry = await purge(db, false);
    expect(dry.would_delete_athletes).toBe(4);
    expect(dry.would_delete_push_browsers).toBe(0);

    const applied = await purge(db, true);
    expect(applied.event).toBe('retention.cleanup.completed');
    expect(applied.athletes).toBe(4);
    expect(applied.push_browsers_deleted).toBe(0);
    expect((await lastAuditDetails(db)).push_browsers_deleted).toBe(0);
    expect(await retiredLogin(db, people.athleteLogin)).toEqual({ athlete_id: null, deleted: true });
  });
});
