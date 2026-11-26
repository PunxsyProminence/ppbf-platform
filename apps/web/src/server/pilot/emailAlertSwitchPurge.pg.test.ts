/**
 * A purged athlete's login loses its email alert switch rows, address
 * included, on real PostgreSQL, through the retention purge
 * (scripts/pilot-cleanup-deleted-data.mjs, run as its own process).
 *
 * Purge A (Overwatch's answer A on #2168; GO for EM-2b on #2159): the purge
 * deletes pilot.email_alert_switches for the athlete login in its athlete-login
 * branch, beside the SHADOW corrections delete, before any address can be
 * written (EM-2b-1). An athlete's login is retired by the purge, not deleted,
 * so the account and membership keys' cascades never fire for it, and an
 * athlete 18 or over's row holds the address they typed and the one they
 * confirmed. Every gym's row of that login goes, as its corrections do: the
 * login itself is retired. A live athlete's row, another gym's athlete with
 * the same athlete id, a guardian's, a staff member's, and the row of a purged
 * child's old login that is now a coach's all stay. A database without the
 * table purges as before.
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
const PG_DATABASE = 'ppbf_test_email_alert_switch_purge';
// A second database, built the same way, with the table dropped.
const PG_DATABASE_NO_TABLE = 'ppbf_test_email_alert_switch_purge_no_table';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-email-alert-switch-purge-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const CLEANUP_SCRIPT = path.resolve(__dirname, '../../../scripts/pilot-cleanup-deleted-data.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-alert-switch-purge';
const OTHER_ORG_ID = 'org-alert-switch-purge-elsewhere';
const COACH_ID = 'acct-alert-purge-coach';
const OTHER_COACH_ID = 'acct-alert-purge-coach-elsewhere';

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

async function switchRowsOf(db: Db, accountId: string): Promise<number> {
  const rows = await db.client.query('select 1 from pilot.email_alert_switches where account_id = $1', [accountId]);
  return rows.rowCount ?? 0;
}

/** Every switch row except the purged logins', whole, in a fixed order. */
async function otherSwitchRows(db: Db, purgedLogins: readonly string[]): Promise<unknown[]> {
  const rows = await db.client.query(
    'select * from pilot.email_alert_switches where account_id <> all($1::text[]) order by organization_id, account_id',
    [purgedLogins],
  );
  return rows.rows;
}

/** Every switch row, whole, in a fixed order. */
async function allSwitchRows(db: Db): Promise<unknown[]> {
  return (await db.client.query('select * from pilot.email_alert_switches order by organization_id, account_id')).rows;
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
  typedAddress: string;
  confirmedAddress: string;
}

const PEOPLE: Seeded = {
  athleteLogin: 'acct-alert-ath',
  coachNowLogin: 'acct-alert-coach-now',
  parentNowLogin: 'acct-alert-parent-now',
  liveAtPurgeLogin: 'acct-alert-live-at-purge',
  liveAthleteLogin: 'acct-alert-live',
  elsewhereLogin: 'acct-alert-elsewhere',
  guardian: 'acct-alert-guardian',
  typedAddress: 'typed@example.test',
  confirmedAddress: 'confirmed@example.test',
};

/*
 * An adult athlete deleted three years ago (past the two-year window) whose
 * own login has a switch in this gym holding a typed address with its code
 * and a confirmed one, and a second switch in another gym it is a member of;
 * a second purged athlete whose login has since become a coach's, and a third
 * whose login has become a guardian's (each unlinked by the purge, but that
 * adult's now, so the rows stay); a fourth whose own login is still live when
 * the purge runs (it retires that login, so its row, holding only a typed
 * address, goes); a live athlete; an
 * athlete in another gym with the SAME athlete id, who is another child; a
 * live guardian of the purged child; and a staff member's own switch. With
 * `withTable` false the table is gone and no switch row is written.
 */
async function seed(db: Db, withTable: boolean): Promise<Seeded> {
  const purged = 'ath-alert-gone';
  const purgedStaffNow = 'ath-alert-staff-now';
  const purgedParentNow = 'ath-alert-parent-now';
  const purgedLiveLogin = 'ath-alert-live-login';
  const live = 'ath-alert-live';
  const people = PEOPLE;
  const q = (sql: string, params: unknown[]) => db.client.query(sql, params);

  for (const [organizationId, athleteId, coachId] of [
    [ORG_ID, purged, COACH_ID], [ORG_ID, purgedStaffNow, COACH_ID], [ORG_ID, purgedParentNow, COACH_ID],
    [ORG_ID, purgedLiveLogin, COACH_ID], [ORG_ID, live, COACH_ID],
    [OTHER_ORG_ID, purged, OTHER_COACH_ID],
  ]) {
    await q(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Alert Athlete', '2000-03-14', 'fly', 'active', 'contact', true, $3, now(), now())`,
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
    // A coach in the other gym: its switch there is a staff one, with no address (reviewers A and B).
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
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name) values ($1, $2, $3, 'Alert Guardian')`,
    [ORG_ID, `par-${people.guardian}`, people.guardian],
  );
  await q(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, $2, $3, 'parent')`,
    [ORG_ID, `par-${people.guardian}`, purged],
  );

  if (withTable) {
    // The purged login: on, a confirmed address, and a new address typed with
    // its code pending (EM-2b default 5 keeps the confirmed one meanwhile).
    await q(
      `insert into pilot.email_alert_switches
         (organization_id, account_id, user_type, switched_on, switched_on_at,
          pending_address, pending_code_hash, pending_code_expires_at, pending_code_attempts,
          confirmed_address, confirmed_at)
       values ($1, $2, 'adult_athlete', true, now(), $3, 'code-hash', now() + interval '15 minutes', 1, $4, now())`,
      [ORG_ID, people.athleteLogin, people.typedAddress, people.confirmedAddress],
    );
    // The same login's switch in the other gym, where it is a coach: on, a
    // staff switch, no address at all. A delete narrowed to rows with an
    // address, or to adult athletes' rows, leaves it (reviewer B).
    await q(
      `insert into pilot.email_alert_switches (organization_id, account_id, user_type, switched_on, switched_on_at)
       values ($1, $2, 'staff', true, now())`,
      [OTHER_ORG_ID, people.athleteLogin],
    );
    // The login still live at the purge: off, an address typed and never
    // confirmed (reviewer B), its code pending.
    await q(
      `insert into pilot.email_alert_switches
         (organization_id, account_id, user_type, pending_address, pending_code_hash, pending_code_expires_at)
       values ($1, $2, 'adult_athlete', 'typed-live@example.test', 'code-hash', now() + interval '15 minutes')`,
      [ORG_ID, people.liveAtPurgeLogin],
    );
    for (const [organizationId, accountId, address] of [
      [ORG_ID, people.liveAthleteLogin, 'live@example.test'],
      [OTHER_ORG_ID, people.elsewhereLogin, 'elsewhere@example.test'],
    ]) {
      await q(
        `insert into pilot.email_alert_switches
           (organization_id, account_id, user_type, switched_on, switched_on_at, confirmed_address, confirmed_at)
         values ($1, $2, 'adult_athlete', true, now(), $3, now())`,
        [organizationId, accountId, address],
      );
    }
    // User type 'staff' is OW27-10's word for a coach or admin.
    for (const [accountId, userType] of [
      [people.guardian, 'parent'], [people.coachNowLogin, 'staff'], [people.parentNowLogin, 'parent'], [COACH_ID, 'staff'],
    ]) {
      await q(
        `insert into pilot.email_alert_switches (organization_id, account_id, user_type, switched_on, switched_on_at)
         values ($1, $2, $3, true, now())`,
        [ORG_ID, accountId, userType],
      );
    }
  }

  await q(
    `update pilot.athletes set deleted_at = now() - interval '3 years'
      where organization_id = $1 and athlete_id = any($2::text[])`,
    [ORG_ID, [purged, purgedStaffNow, purgedParentNow, purgedLiveLogin]],
  );
  return people;
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

describe('the retention purge and the email alert switches', () => {
  test("deletes a purged athlete login's switch rows, addresses included, in every gym, and no one else's", async () => {
    const db = await freshDatabase(PG_DATABASE);
    const people = await seed(db, true);
    // CONTROL: the purged login's two rows are there, with both addresses.
    expect(await switchRowsOf(db, people.athleteLogin)).toBe(2);
    expect(await switchRowsOf(db, people.liveAtPurgeLogin)).toBe(1);
    const purgedLogins = [people.athleteLogin, people.liveAtPurgeLogin];
    const othersBefore = await otherSwitchRows(db, purgedLogins);
    expect(othersBefore).toHaveLength(6);
    const everyRowBefore = await allSwitchRows(db);

    // The dry run counts them and deletes nothing.
    const dry = await purge(db, false);
    expect(dry.event).toBe('retention.cleanup.dry-run');
    expect(dry.would_delete_athletes).toBe(4);
    expect(dry.would_delete_email_alert_switches).toBe(3);
    // Row for row, the dry run left every switch as it was (reviewer B).
    expect(await allSwitchRows(db)).toEqual(everyRowBefore);
    const kept = await db.client.query(
      `select pending_address, confirmed_address from pilot.email_alert_switches
        where organization_id = $1 and account_id = $2`,
      [ORG_ID, people.athleteLogin],
    );
    expect(kept.rows).toEqual([{ pending_address: people.typedAddress, confirmed_address: people.confirmedAddress }]);
    expect(await retiredLogin(db, people.athleteLogin)).toEqual({ athlete_id: 'ath-alert-gone', deleted: true });

    // APPLY: the completion log and the audit row both carry the count.
    const applied = await purge(db, true);
    expect(applied.event).toBe('retention.cleanup.completed');
    expect(applied.athletes).toBe(4);
    expect(applied.email_alert_switches_deleted).toBe(3);
    const audit = await lastAuditDetails(db);
    expect(audit.athletes_deleted).toBe(4);
    expect(audit.email_alert_switches_deleted).toBe(3);

    // The login survives the purge, retired; its switches, in both gyms, do not.
    expect(await retiredLogin(db, people.athleteLogin)).toEqual({ athlete_id: null, deleted: true });
    expect(await switchRowsOf(db, people.athleteLogin)).toBe(0);
    // The login still live when its child was purged is retired, and its row goes (reviewers A and B).
    expect(await retiredLogin(db, people.liveAtPurgeLogin)).toEqual({ athlete_id: null, deleted: true });
    expect(await switchRowsOf(db, people.liveAtPurgeLogin)).toBe(0);
    // No row anywhere still holds either of the athlete's addresses.
    const addresses = await db.client.query(
      `select 1 from pilot.email_alert_switches
        where pending_address = any($1::text[]) or confirmed_address = any($1::text[])`,
      [[people.typedAddress, people.confirmedAddress, 'typed-live@example.test']],
    );
    expect(addresses.rowCount).toBe(0);

    // Every other row is exactly as it was: the live athlete's, the other
    // gym's child with the same athlete id, the guardian's, the staff
    // member's, and the old logins that are a coach's and a guardian's now,
    // which the purge did unlink but did not retire (reviewer A).
    expect(await otherSwitchRows(db, purgedLogins)).toEqual(othersBefore);
    expect(await retiredLogin(db, people.coachNowLogin)).toEqual({ athlete_id: null, deleted: false });
    expect(await retiredLogin(db, people.parentNowLogin)).toEqual({ athlete_id: null, deleted: false });
    for (const accountId of [
      people.liveAthleteLogin, people.elsewhereLogin, people.guardian, people.coachNowLogin, people.parentNowLogin, COACH_ID,
    ]) {
      expect(await switchRowsOf(db, accountId)).toBe(1);
    }
  });

  test('a database without the table purges as before and reports none', async () => {
    const db = await freshDatabase(PG_DATABASE_NO_TABLE);
    await db.client.query('drop table pilot.email_alert_switches');
    const people = await seed(db, false);

    const dry = await purge(db, false);
    expect(dry.would_delete_athletes).toBe(4);
    expect(dry.would_delete_email_alert_switches).toBe(0);

    const applied = await purge(db, true);
    expect(applied.event).toBe('retention.cleanup.completed');
    expect(applied.athletes).toBe(4);
    expect(applied.email_alert_switches_deleted).toBe(0);
    expect((await lastAuditDetails(db)).email_alert_switches_deleted).toBe(0);
    expect(await retiredLogin(db, people.athleteLogin)).toEqual({ athlete_id: null, deleted: true });
  });
});
