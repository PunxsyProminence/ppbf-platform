// Real PostgreSQL-backed test for the email alert queue (lane W4-1, EM-3b-1;
// plan on #2159, sections 4 and 5): queueing, the sweep's checkpoint, lease
// recovery and claims. The module's own SQL runs against an embedded Postgres
// with the full schema, EM-1a's, EM-5a's and EM-3a's tables included.
//
// It NEVER connects to production or staging: an embedded server on a free
// local port, in a throwaway data directory.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client, Pool } from 'pg';

let activeClient: Client | null = null;
let activePool: Pool | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    const target = activePool ?? activeClient;
    if (!target) throw new Error('test bug: no active embedded client');
    const result = await target.query(text, params);
    return result.rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    const target = activePool ?? activeClient;
    if (!target) throw new Error('test bug: no active embedded client');
    const result = await target.query(text, params);
    return result.rows[0] ?? null;
  }),
  withTransaction: jest.fn(async () => {
    throw new Error('test bug: the sender opens no transaction');
  }),
  // The embedded server is on loopback, but production's is not; the PIN rule
  // is tested as production applies it.
  isLoopbackPostgresConnectionString: () => false,
}));

import {
  claimDueEmailAlertSends,
  enqueueEmailAlertSends,
  recoverExpiredEmailAlertLeases,
  sweepEmailAlertSource,
  type EmailAlertCandidate,
} from './emailAlertQueue';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-email-alert-queue-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-emailsender';
const ADMIN_ID = 'acct-emailsender-admin';
const COACH_ID = 'acct-emailsender-coach';
const PARENT_ID = 'acct-emailsender-parent';
const ADULT_ID = 'acct-emailsender-adult';
const ADULT_ATHLETE = 'ath-emailsender-adult';
const COACH_ADDRESS = 'coach@example.com';
const PARENT_ADDRESS = 'parent@example.com';
const ADULT_ADDRESS = 'adult@example.com';

const EVENT_1 = '00000000-0000-4000-8000-000000000001';
const EVENT_2 = '00000000-0000-4000-8000-000000000002';
const EVENT_3 = '00000000-0000-4000-8000-000000000003';

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
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not determine a free port')));
      }
    });
  });
}

/**
 * The full schema and one gym: an admin (switched off), a coach and a parent
 * (switched on, each with a sign-in address) and an adult athlete (switched on,
 * with a confirmed address). Each account is a member of the gym.
 */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [ORG_ID],
  );
  const people: Array<[string, string, string | null]> = [
    [ADMIN_ID, 'organization_admin', null],
    [COACH_ID, 'coach', COACH_ADDRESS],
    [PARENT_ID, 'parent', PARENT_ADDRESS],
  ];
  for (const [accountId, role, login] of people) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, login_email)
       values ($1, $2, $3, 'magic_link', null, $4)`,
      [accountId, role, ORG_ID, login],
    );
  }
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Email Athlete', '2000-03-14', '100', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ADULT_ATHLETE, COACH_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, login_email)
     values ($1, 'athlete', $2, 'ppbf_local', $3, null)`,
    [ADULT_ID, ORG_ID, ADULT_ATHLETE],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     select account_id, organization_id, role, true from pilot.accounts where organization_id = $1`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.email_alert_switches
       (organization_id, account_id, user_type, switched_on, switched_on_at, switched_off_at, confirmed_address, confirmed_at)
     values ($1, $2, 'staff', false, null, now(), null, null),
            ($1, $3, 'staff', true, now(), null, null, null),
            ($1, $4, 'parent', true, now(), null, null, null),
            ($1, $5, 'adult_athlete', true, now(), null, $6, now())`,
    [ORG_ID, ADMIN_ID, COACH_ID, PARENT_ID, ADULT_ID, ADULT_ADDRESS],
  );
  return client;
}

function candidate(accountId: string, userType: EmailAlertCandidate['userType'], eventKind: string, eventId: string) {
  return { organizationId: ORG_ID, accountId, userType, eventKind, eventId };
}

async function sendRows(client: Client) {
  const { rows } = await client.query(
    `select account_id, event_kind, event_id, status, tries, skip_reason, last_status_code, last_error_code,
            finished_at is not null as finished
       from pilot.email_alert_sends order by send_id`,
  );
  return rows;
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

afterEach(async () => {
  activeClient = null;
  if (activePool) await activePool.end();
  activePool = null;
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

describe('email alert queue', () => {
  test('queues only people switched on under that user type whose gym has the event ticked; a second pass adds nothing', async () => {
    const client = await freshDatabase('emailsender_enqueue');
    activeClient = client;
    try {
      await client.query(
        `insert into pilot.organization_email_alert_events (organization_id, user_type, event_kind, ticked)
         values ($1, 'staff', 'gym_notice', false)`,
        [ORG_ID],
      );
      const candidates = [
        candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1),
        candidate(ADMIN_ID, 'staff', 'safety_escalation', EVENT_1), // switched off
        candidate(COACH_ID, 'staff', 'gym_notice', EVENT_2), // gym unticked it for staff
        candidate(PARENT_ID, 'parent', 'family_note', EVENT_3),
        candidate(PARENT_ID, 'parent', 'safety_escalation', EVENT_1), // not on the parent list
        candidate(PARENT_ID, 'staff', 'parent_reply', EVENT_2), // switch set under another user type
        candidate(COACH_ID, 'staff', 'parent_reply', 'not-a-uuid'),
      ];
      expect(await enqueueEmailAlertSends(candidates)).toBe(2);
      expect(await enqueueEmailAlertSends(candidates)).toBe(0);
      expect((await sendRows(client)).map((row) => [row.account_id, row.event_kind, row.status])).toEqual([
        [COACH_ID, 'safety_escalation', 'queued'],
        [PARENT_ID, 'family_note', 'queued'],
      ]);
    } finally {
      await client.end();
    }
  });

  test("a source's first sweep only sets its checkpoint; later sweeps read from it less ten minutes, and it only moves forward", async () => {
    const client = await freshDatabase('emailsender_sweep');
    activeClient = client;
    try {
      const reads: Array<[Date, Date]> = [];
      const source = {
        checkpointKey: 'safety_escalation',
        candidates: async (from: Date, to: Date) => {
          reads.push([from, to]);
          return [candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)];
        },
      };
      expect(await sweepEmailAlertSource(source)).toBe(0);
      expect(reads).toEqual([]);
      const first = (await client.query('select swept_to from pilot.email_alert_checkpoints')).rows[0].swept_to as Date;

      expect(await sweepEmailAlertSource(source)).toBe(1);
      expect(reads).toHaveLength(1);
      expect(first.getTime() - reads[0][0].getTime()).toBe(10 * 60 * 1000);
      const second = (await client.query('select swept_to from pilot.email_alert_checkpoints')).rows[0].swept_to as Date;
      expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime());

      const ahead = new Date(second.getTime() + 60 * 60 * 1000);
      await client.query('update pilot.email_alert_checkpoints set swept_to = $1', [ahead]);
      expect(await sweepEmailAlertSource(source)).toBe(0); // the overlap re-read finds the same event: no second row
      const kept = (await client.query('select swept_to from pilot.email_alert_checkpoints')).rows[0].swept_to as Date;
      expect(kept.getTime()).toBe(ahead.getTime());
    } finally {
      await client.end();
    }
  });

  test('a send whose lease ran out goes back to the queue, or fails if it was on its fifth try', async () => {
    const client = await freshDatabase('emailsender_lease');
    activeClient = client;
    try {
      await client.query(
        `insert into pilot.email_alert_sends
           (organization_id, account_id, user_type, event_kind, event_id, status, tries, lease_token, lease_expires_at)
         values ($1, $2, 'staff', 'safety_escalation', $3, 'sending', 2, gen_random_uuid(), now() - interval '1 minute'),
                ($1, $2, 'staff', 'safety_escalation', $4, 'sending', 5, gen_random_uuid(), now() - interval '1 minute'),
                ($1, $2, 'staff', 'safety_escalation', $5, 'sending', 1, gen_random_uuid(), now() + interval '1 minute')`,
        [ORG_ID, COACH_ID, EVENT_1, EVENT_2, EVENT_3],
      );
      expect(await recoverExpiredEmailAlertLeases()).toBe(2);
      expect((await sendRows(client)).map((row) => [row.event_id, row.status, row.last_error_code])).toEqual([
        [EVENT_1, 'queued', 'LEASE_EXPIRED'],
        [EVENT_2, 'failed', 'LEASE_EXPIRED'],
        [EVENT_3, 'sending', null],
      ]);
    } finally {
      await client.end();
    }
  });

  test('a send is not claimed before its next try is due', async () => {
    const client = await freshDatabase('emailsender_not_due');
    activeClient = client;
    try {
      await enqueueEmailAlertSends([candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)]);
      await client.query(`update pilot.email_alert_sends set next_try_at = clock_timestamp() + interval '1 minute'`);
      expect(await claimDueEmailAlertSends(10)).toEqual([]);
      await client.query(`update pilot.email_alert_sends set next_try_at = clock_timestamp()`);
      expect(await claimDueEmailAlertSends(10)).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  test('a claim passes over a send another replica holds, without waiting for it', async () => {
    const client = await freshDatabase('emailsender_skip_locked');
    activeClient = client;
    const other = new Client({ connectionString: connectionStringFor('emailsender_skip_locked') });
    await other.connect();
    try {
      await enqueueEmailAlertSends([
        candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1),
        candidate(PARENT_ID, 'parent', 'family_note', EVENT_2),
      ]);
      // The other replica is part-way through claiming the coach's send.
      await other.query('begin');
      await other.query(`select 1 from pilot.email_alert_sends where account_id = $1 for update`, [COACH_ID]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const claimed = await Promise.race([
        claimDueEmailAlertSends(10),
        new Promise<'waited'>((resolve) => { timer = setTimeout(() => resolve('waited'), 5_000); }),
      ]);
      clearTimeout(timer);
      expect(claimed).not.toBe('waited');
      expect((claimed as Array<{ account_id: string }>).map((row) => row.account_id)).toEqual([PARENT_ID]);
      await other.query('rollback');
    } finally {
      await other.end();
      await client.end();
    }
  });

  test('two claims at once, on separate connections, never take the same send', async () => {
    const client = await freshDatabase('emailsender_claim');
    activeClient = client;
    try {
      await enqueueEmailAlertSends([
        candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1),
        candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_2),
        candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_3),
        candidate(PARENT_ID, 'parent', 'family_note', EVENT_1),
      ]);
      activePool = new Pool({ connectionString: connectionStringFor('emailsender_claim'), max: 4 });
      const claims = await Promise.all([claimDueEmailAlertSends(3), claimDueEmailAlertSends(3)]);
      const ids = claims.flat().map((row) => row.send_id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(4);
      expect(await claimDueEmailAlertSends(10)).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
