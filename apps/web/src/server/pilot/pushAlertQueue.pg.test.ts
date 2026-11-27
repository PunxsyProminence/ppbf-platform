// Real PostgreSQL-backed test for the web push queue (lane W5-WP, WP-2b-1;
// plan and GO on #2228): queueing, the sweep's own checkpoint, a restored
// notice offered again, lease recovery and claims. The module's own SQL runs
// against an embedded Postgres with the full schema, the web-push migration
// (WP-1a) and the email alert tables (lane W4-1) included. It follows the
// email queue's suite (emailAlertQueue.pg.test.ts).
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
    throw new Error('test bug: the queue opens no transaction');
  }),
}));

import type { EmailAlertCandidate } from './emailAlertQueue';
import {
  claimDuePushAlertSends,
  enqueuePushAlertSends,
  recoverExpiredPushAlertLeases,
  sweepPushAlertSource,
} from './pushAlertQueue';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-push-alert-queue-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-pushqueue';
const OTHER_ORG_ID = 'org-pushqueue-elsewhere';
const ADMIN_ID = 'acct-pushqueue-admin';
const COACH_ID = 'acct-pushqueue-coach';
const PARENT_ID = 'acct-pushqueue-parent';
const ADULT_ID = 'acct-pushqueue-adult';
const NO_BROWSER_ID = 'acct-pushqueue-no-browser';
const SWITCH_OFF_ID = 'acct-pushqueue-switch-off';
const ROLE_CHANGED_ID = 'acct-pushqueue-role-changed';
const ELSEWHERE_ID = 'acct-pushqueue-elsewhere';
const ADULT_ATHLETE = 'ath-pushqueue-adult';
// The shapes pilot.push_subscriptions takes (WP-1a).
const P256DH = `B${'A'.repeat(86)}`;
const AUTH = 'A'.repeat(22);

const EVENT_1 = '00000000-0000-4000-8000-000000000001';
const EVENT_2 = '00000000-0000-4000-8000-000000000002';
const EVENT_3 = '00000000-0000-4000-8000-000000000003';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let endpointCount = 0;

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

async function addBrowser(client: Client, organizationId: string, accountId: string, userType: string): Promise<void> {
  endpointCount += 1;
  await client.query(
    `insert into pilot.push_subscriptions (organization_id, account_id, user_type, endpoint, key_p256dh, key_auth)
     values ($1, $2, $3, $4, $5, $6)`,
    [organizationId, accountId, userType, `https://push.example.test/send/browser-${endpointCount}`, P256DH, AUTH],
  );
}

/**
 * The full schema and two gyms. In this gym, each with the email switch on
 * under their user type: an organization admin (a staff browser), a coach (two
 * staff browsers), a parent (a parent browser), an adult athlete (an adult
 * athlete browser, a confirmed address) and a coach with no browser. A second
 * coach has a staff browser on and the email switch off. A third coach, a
 * parent until lately, is switched on as staff but has a browser saved as a
 * parent's (a browser keeps the user type it was saved under until it is
 * saved again: pushSubscriptions.ts). In the other gym a coach whose only
 * browser is there, who is also a member here, switched on here.
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
  for (const organizationId of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [organizationId],
    );
  }
  const people: Array<[string, string, string]> = [
    [ADMIN_ID, 'organization_admin', ORG_ID],
    [COACH_ID, 'coach', ORG_ID],
    [PARENT_ID, 'parent', ORG_ID],
    [NO_BROWSER_ID, 'coach', ORG_ID],
    [SWITCH_OFF_ID, 'coach', ORG_ID],
    [ROLE_CHANGED_ID, 'coach', ORG_ID],
    [ELSEWHERE_ID, 'coach', OTHER_ORG_ID],
  ];
  for (const [accountId, role, organizationId] of people) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id)
       values ($1, $2, $3, 'magic_link', null)`,
      [accountId, role, organizationId],
    );
  }
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Push Athlete', '2000-03-14', '100', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ADULT_ATHLETE, COACH_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id)
     values ($1, 'athlete', $2, 'ppbf_local', $3)`,
    [ADULT_ID, ORG_ID, ADULT_ATHLETE],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     select account_id, organization_id, role, true from pilot.accounts`,
  );
  // The coach from the other gym is a member here too, with no browser here.
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, 'coach', true)`,
    [ELSEWHERE_ID, ORG_ID],
  );
  // Until Jason answers QA the queue also needs the email switch on: the
  // switched-off coach has a browser on and gets nothing.
  await client.query(
    `insert into pilot.email_alert_switches
       (organization_id, account_id, user_type, switched_on, switched_on_at, switched_off_at, confirmed_address, confirmed_at)
     values ($1, $2, 'staff', true, now(), null, null, null),
            ($1, $3, 'staff', true, now(), null, null, null),
            ($1, $4, 'parent', true, now(), null, null, null),
            ($1, $5, 'adult_athlete', true, now(), null, 'adult@example.test', now()),
            ($1, $6, 'staff', true, now(), null, null, null),
            ($1, $7, 'staff', false, null, now(), null, null),
            ($1, $8, 'staff', true, now(), null, null, null),
            ($1, $9, 'staff', true, now(), null, null, null)`,
    [ORG_ID, ADMIN_ID, COACH_ID, PARENT_ID, ADULT_ID, NO_BROWSER_ID, SWITCH_OFF_ID, ELSEWHERE_ID, ROLE_CHANGED_ID],
  );
  await addBrowser(client, ORG_ID, ADMIN_ID, 'staff');
  await addBrowser(client, ORG_ID, COACH_ID, 'staff');
  await addBrowser(client, ORG_ID, COACH_ID, 'staff');
  await addBrowser(client, ORG_ID, SWITCH_OFF_ID, 'staff');
  await addBrowser(client, ORG_ID, ROLE_CHANGED_ID, 'parent');
  await addBrowser(client, ORG_ID, PARENT_ID, 'parent');
  await addBrowser(client, ORG_ID, ADULT_ID, 'adult_athlete');
  await addBrowser(client, OTHER_ORG_ID, ELSEWHERE_ID, 'staff');
  return client;
}

function candidate(accountId: string, userType: EmailAlertCandidate['userType'], eventKind: string, eventId: string) {
  return { organizationId: ORG_ID, accountId, userType, eventKind, eventId };
}

async function sendRows(client: Client) {
  const { rows } = await client.query(
    `select account_id, event_kind, event_id, status, tries, skip_reason, last_status_code, last_error_code,
            finished_at is not null as finished
       from pilot.push_alert_sends order by send_id`,
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

describe('web push queue', () => {
  test('queues only people with a browser on in that gym under that user type, switched on, whose gym has the event ticked for their user type; a second pass adds nothing', async () => {
    const client = await freshDatabase('pushqueue_enqueue');
    activeClient = client;
    try {
      await client.query(
        `insert into pilot.organization_email_alert_events (organization_id, user_type, event_kind, ticked)
         values ($1, 'staff', 'gym_notice', false)`,
        [ORG_ID],
      );
      const candidates = [
        candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1), // two browsers: one row
        candidate(ADMIN_ID, 'staff', 'safety_escalation', EVENT_1),
        candidate(NO_BROWSER_ID, 'staff', 'safety_escalation', EVENT_1), // no browser
        candidate(ELSEWHERE_ID, 'staff', 'safety_escalation', EVENT_1), // a browser only in another gym
        candidate(COACH_ID, 'staff', 'gym_notice', EVENT_2), // gym unticked it for staff
        candidate(PARENT_ID, 'parent', 'gym_notice', EVENT_2), // still ticked for parents
        candidate(PARENT_ID, 'parent', 'family_note', EVENT_3),
        candidate(PARENT_ID, 'parent', 'safety_escalation', EVENT_1), // not on the parent list
        candidate(PARENT_ID, 'staff', 'parent_reply', EVENT_2), // browser and switch under another user type
        candidate(ROLE_CHANGED_ID, 'staff', 'safety_escalation', EVENT_1), // switch on as staff, browser saved as a parent's
        candidate(ADULT_ID, 'adult_athlete', 'coach_message', EVENT_2),
        candidate(COACH_ID, 'staff', 'parent_reply', 'not-a-uuid'),
      ];
      expect(await enqueuePushAlertSends(candidates)).toBe(5);
      expect(await enqueuePushAlertSends(candidates)).toBe(0);
      // `select distinct` gives no order, so the rows are compared sorted.
      const written = (await sendRows(client))
        .map((row) => [row.account_id, row.event_kind, row.status, row.tries].join(' '))
        .sort();
      expect(written).toEqual([
        `${ADMIN_ID} safety_escalation queued 0`,
        `${ADULT_ID} coach_message queued 0`,
        `${COACH_ID} safety_escalation queued 0`,
        `${PARENT_ID} family_note queued 0`,
        `${PARENT_ID} gym_notice queued 0`,
      ]);
      // Push writes nothing to the email send log.
      expect((await client.query('select 1 from pilot.email_alert_sends')).rowCount).toBe(0);
    } finally {
      await client.end();
    }
  });

  // QA PENDING (QK A on #2228, 7225179535: "fail closed until Jason answers
  // QA ... Pin the join with a test labelled 'QA pending' so the change is one
  // visible step"). Until Jason answers QA (does the email switch also decide
  // push?), a browser on is not enough: the email switch must be on too. If he
  // picks QA A, the switch join leaves pushAlertQueue.ts and this test changes
  // to expect the switched-off coach queued.
  test('QA pending: a browser on with the email switch off gets nothing; the same person switched on is queued', async () => {
    const client = await freshDatabase('pushqueue_qa_pending');
    activeClient = client;
    try {
      const pushFor = [candidate(SWITCH_OFF_ID, 'staff', 'safety_escalation', EVENT_1)];
      expect(await enqueuePushAlertSends(pushFor)).toBe(0);
      expect(await sendRows(client)).toEqual([]);
      // CONTROL: the switch on, nothing else changed, and the same push is queued.
      await client.query(
        `update pilot.email_alert_switches set switched_on = true, switched_on_at = now(), switched_off_at = null
          where organization_id = $1 and account_id = $2`,
        [ORG_ID, SWITCH_OFF_ID],
      );
      expect(await enqueuePushAlertSends(pushFor)).toBe(1);
      expect((await sendRows(client)).map((row) => [row.account_id, row.event_kind, row.status]))
        .toEqual([[SWITCH_OFF_ID, 'safety_escalation', 'queued']]);
    } finally {
      await client.end();
    }
  });

  test("a source's first push sweep only sets push's checkpoint; later sweeps read from it less ten minutes; it only moves forward, apart from the email's", async () => {
    const client = await freshDatabase('pushqueue_sweep');
    activeClient = client;
    try {
      // The email sweep has read this source already: push starts on its own.
      await client.query(
        `insert into pilot.email_alert_checkpoints (event_kind, swept_to) values ('safety_escalation', now() - interval '1 day')`,
      );
      const reads: Array<[Date, Date]> = [];
      const source = {
        checkpointKey: 'safety_escalation',
        candidates: async (from: Date, to: Date) => {
          reads.push([from, to]);
          return [candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)];
        },
      };
      expect(await sweepPushAlertSource(source)).toBe(0);
      expect(reads).toEqual([]);
      const first = (await client.query('select swept_to from pilot.push_alert_checkpoints')).rows[0].swept_to as Date;

      expect(await sweepPushAlertSource(source)).toBe(1);
      expect(reads).toHaveLength(1);
      expect(first.getTime() - reads[0][0].getTime()).toBe(10 * 60 * 1000);
      const second = (await client.query('select swept_to from pilot.push_alert_checkpoints')).rows[0].swept_to as Date;
      expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime());

      const ahead = new Date(second.getTime() + 60 * 60 * 1000);
      await client.query('update pilot.push_alert_checkpoints set swept_to = $1', [ahead]);
      expect(await sweepPushAlertSource(source)).toBe(0); // the overlap re-read finds the same event: no second row
      const kept = (await client.query('select swept_to from pilot.push_alert_checkpoints')).rows[0].swept_to as Date;
      expect(kept.getTime()).toBe(ahead.getTime());
      // The email's checkpoint is where the email sweep left it.
      const email = await client.query(
        `select swept_to < now() - interval '23 hours' as untouched from pilot.email_alert_checkpoints`,
      );
      expect(email.rows).toEqual([{ untouched: true }]);
    } finally {
      await client.end();
    }
  });

  test('a restored notice is offered again only to whoever certainly has not had it', async () => {
    const client = await freshDatabase('pushqueue_restore');
    activeClient = client;
    try {
      const notice = async (active: boolean, updatedMinutesAgo: number): Promise<string> => {
        const { rows } = await client.query(
          `insert into pilot.announcements
             (organization_id, announcement_id, message, author_name, author_role, placement, kind, active,
              created_at, updated_at)
           values ($1, gen_random_uuid(), 'Notice', 'Office', 'organization_admin', 'everywhere', 'notice', $2,
                   now() - interval '2 hours', now() - make_interval(mins => $3))
           returning announcement_id::text as id`,
          [ORG_ID, active, updatedMinutesAgo],
        );
        return rows[0].id as string;
      };
      // Restored a minute ago; each send became due ten minutes ago.
      const restored = await notice(true, 1);
      const restoredAfterSending = await notice(true, 1);
      // Restored before the sends became due: nothing new since.
      const unchanged = await notice(true, 30);
      // Retired again.
      const retired = await notice(false, 1);
      const row = async (accountId: string, eventId: string, status: string, extra: Record<string, unknown> = {}) => {
        const finished = ['sent', 'skipped', 'failed'].includes(status);
        await client.query(
          `insert into pilot.push_alert_sends
             (organization_id, account_id, user_type, event_kind, event_id, status, tries, next_try_at,
              skip_reason, last_status_code, last_error_code, finished_at)
           values ($1, $2, $3, $4, $5, $6, $7, now() - interval '10 minutes', $8, $9, $10,
                   case when $11 then now() - interval '10 minutes' end)`,
          [ORG_ID, accountId, extra.userType ?? 'staff', extra.kind ?? 'gym_notice', eventId, status, extra.tries ?? 1,
            status === 'skipped' ? 'not_offered' : null, extra.statusCode ?? null, extra.errorCode ?? null, finished],
        );
      };
      // Offered again: skipped before any push service was asked; failed on its only try.
      await row(COACH_ID, restored, 'skipped');
      await row(ADMIN_ID, restored, 'failed', { tries: 1, statusCode: 410 });
      // Not offered again: a skip after an earlier try reached a push service,
      // a failure after retries, a sent row, an unchanged and a retired notice.
      await row(PARENT_ID, restored, 'skipped', { userType: 'parent', statusCode: 503 });
      await row(ADULT_ID, restored, 'failed', { userType: 'adult_athlete', tries: 2, statusCode: 503 });
      await row(COACH_ID, restoredAfterSending, 'sent');
      await row(COACH_ID, unchanged, 'skipped');
      await row(COACH_ID, retired, 'skipped');
      // Not a notice, though its id is a restored notice's: never offered again.
      await row(COACH_ID, restored, 'skipped', { kind: 'safety_escalation' });
      const before = await sendRows(client);

      const named = [
        candidate(COACH_ID, 'staff', 'gym_notice', restored),
        candidate(ADMIN_ID, 'staff', 'gym_notice', restored),
        candidate(PARENT_ID, 'parent', 'gym_notice', restored),
        candidate(ADULT_ID, 'adult_athlete', 'gym_notice', restored),
        candidate(COACH_ID, 'staff', 'gym_notice', restoredAfterSending),
        candidate(COACH_ID, 'staff', 'gym_notice', unchanged),
        candidate(COACH_ID, 'staff', 'gym_notice', retired),
        candidate(COACH_ID, 'staff', 'safety_escalation', restored),
      ];
      expect(await enqueuePushAlertSends(named)).toBe(2);
      const after = await sendRows(client);
      const changed = after.filter((current, index) => JSON.stringify(current) !== JSON.stringify(before[index]));
      expect(changed.map((current) => [current.account_id, current.event_id, current.status, current.tries, current.finished]))
        .toEqual([
          [COACH_ID, restored, 'queued', 0, false],
          [ADMIN_ID, restored, 'queued', 1, false],
        ]);
      // Named again, nothing more changes.
      expect(await enqueuePushAlertSends(named)).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('a push whose lease ran out goes back to the queue, or fails if it was on its fifth try', async () => {
    const client = await freshDatabase('pushqueue_lease');
    activeClient = client;
    try {
      await client.query(
        `insert into pilot.push_alert_sends
           (organization_id, account_id, user_type, event_kind, event_id, status, tries, lease_token, lease_expires_at)
         values ($1, $2, 'staff', 'safety_escalation', $3, 'sending', 2, gen_random_uuid(), now() - interval '1 minute'),
                ($1, $2, 'staff', 'safety_escalation', $4, 'sending', 5, gen_random_uuid(), now() - interval '1 minute'),
                ($1, $2, 'staff', 'safety_escalation', $5, 'sending', 1, gen_random_uuid(), now() + interval '1 minute')`,
        [ORG_ID, COACH_ID, EVENT_1, EVENT_2, EVENT_3],
      );
      expect(await recoverExpiredPushAlertLeases()).toBe(2);
      expect((await sendRows(client)).map((row) => [row.event_id, row.status, row.last_error_code, row.finished])).toEqual([
        [EVENT_1, 'queued', 'LEASE_EXPIRED', false],
        [EVENT_2, 'failed', 'LEASE_EXPIRED', true],
        [EVENT_3, 'sending', null, false],
      ]);
    } finally {
      await client.end();
    }
  });

  test('a push is not claimed before its next try is due; a claim counts a try and takes a lease', async () => {
    const client = await freshDatabase('pushqueue_not_due');
    activeClient = client;
    try {
      await enqueuePushAlertSends([candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)]);
      await client.query(`update pilot.push_alert_sends set next_try_at = clock_timestamp() + interval '1 minute'`);
      expect(await claimDuePushAlertSends(10)).toEqual([]);
      await client.query(`update pilot.push_alert_sends set next_try_at = clock_timestamp()`);
      const claimed = await claimDuePushAlertSends(10);
      expect(claimed.map((row) => [row.account_id, row.user_type, row.event_kind, row.event_id, row.tries]))
        .toEqual([[COACH_ID, 'staff', 'safety_escalation', EVENT_1, 1]]);
      const lease = await client.query(
        `select status, lease_token::text = $1 as same_token,
                lease_expires_at between clock_timestamp() + interval '290 seconds' and clock_timestamp() + interval '300 seconds' as five_minutes
           from pilot.push_alert_sends`,
        [claimed[0].lease_token],
      );
      expect(lease.rows).toEqual([{ status: 'sending', same_token: true, five_minutes: true }]);
    } finally {
      await client.end();
    }
  });

  test('a claim passes over a push another replica holds, without waiting for it', async () => {
    const client = await freshDatabase('pushqueue_skip_locked');
    activeClient = client;
    const other = new Client({ connectionString: connectionStringFor('pushqueue_skip_locked') });
    await other.connect();
    try {
      await enqueuePushAlertSends([
        candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1),
        candidate(PARENT_ID, 'parent', 'family_note', EVENT_2),
      ]);
      // The other replica is part-way through claiming the coach's push.
      await other.query('begin');
      await other.query(`select 1 from pilot.push_alert_sends where account_id = $1 for update`, [COACH_ID]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const claimed = await Promise.race([
        claimDuePushAlertSends(10),
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

  test('two claims at once, on separate connections, never take the same push', async () => {
    const client = await freshDatabase('pushqueue_claim');
    activeClient = client;
    try {
      await enqueuePushAlertSends([
        candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1),
        candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_2),
        candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_3),
        candidate(PARENT_ID, 'parent', 'family_note', EVENT_1),
      ]);
      activePool = new Pool({ connectionString: connectionStringFor('pushqueue_claim'), max: 4 });
      const claims = await Promise.all([claimDuePushAlertSends(3), claimDuePushAlertSends(3)]);
      const ids = claims.flat().map((row) => row.send_id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(4);
      expect(await claimDuePushAlertSends(10)).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
