// Real PostgreSQL-backed test for the email alert sender (lane W4-1, EM-3b;
// plan on #2159, sections 4 and 5). The module's own SQL runs against an
// embedded Postgres with the full schema, EM-1a's, EM-5a's and EM-3a's tables
// included; Graph is replaced by a recorder, so nothing is mailed.
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
  type EmailAlertCandidate,
} from './emailAlertQueue';
import {
  deliverEmailAlertSend,
  runEmailAlertSweep,
  type EmailAlertSenderDependencies,
} from './emailAlertSender';
import { MailSendError, type OutboundMessage } from './graphMailer';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-email-alert-sender-pg-test-${Date.now()}`);
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
const NOW = new Date('2026-11-25T17:00:00Z');

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

/** Records every message; can be told to throw. */
function recorder(fail?: () => Error) {
  const sent: OutboundMessage[] = [];
  const dependencies: EmailAlertSenderDependencies = {
    prepareSend: async () => async (message) => {
      if (fail) throw fail();
      sent.push(message);
    },
    gymName: async () => 'GYM',
    now: () => NOW,
    clockMs: () => Date.now(),
  };
  return { sent, dependencies };
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

describe('email alert sender', () => {
  test('a due send goes once, to the sign-in address, saying only "open the app"; the row holds no address', async () => {
    const client = await freshDatabase('emailsender_send');
    activeClient = client;
    try {
      await enqueueEmailAlertSends([candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)]);
      const { sent, dependencies } = recorder();
      expect(await runEmailAlertSweep(dependencies, [])).toEqual({
        queued: 0, recovered: 0, sent: 1, skipped: 0, retried: 0, failed: 0, lost: 0,
      });
      expect(sent).toEqual([{ to: COACH_ADDRESS, subject: 'GYM: open the app', body: 'open the app' }]);
      expect(await runEmailAlertSweep(dependencies, [])).toEqual({
        queued: 0, recovered: 0, sent: 0, skipped: 0, retried: 0, failed: 0, lost: 0,
      });
      expect(sent).toHaveLength(1);
      const rows = await sendRows(client);
      expect(rows).toMatchObject([{ status: 'sent', tries: 1, finished: true, last_error_code: null }]);
      // Here the account id is not an address, so the recipient's address must
      // appear nowhere in the row (an account id that is an address is EM-3a's
      // stated case).
      const everything = await client.query('select * from pilot.email_alert_sends');
      expect(JSON.stringify(everything.rows)).not.toContain(COACH_ADDRESS);
      expect(JSON.stringify(everything.rows)).not.toContain('@');
    } finally {
      await client.end();
    }
  });

  test('an adult athlete gets it at the address they confirmed', async () => {
    const client = await freshDatabase('emailsender_adult');
    activeClient = client;
    try {
      await enqueueEmailAlertSends([candidate(ADULT_ID, 'adult_athlete', 'coach_message', EVENT_1)]);
      const { sent, dependencies } = recorder();
      await runEmailAlertSweep(dependencies, []);
      expect(sent.map((message) => message.to)).toEqual([ADULT_ADDRESS]);
    } finally {
      await client.end();
    }
  });

  test.each([
    ['switched off since', 'switched_off', 'coach', `update pilot.email_alert_switches set switched_on = false where account_id = '${COACH_ID}'`],
    ['an account switched off', 'sign_in_off', 'coach', `update pilot.accounts set active_flag = false where account_id = '${COACH_ID}'`],
    ['an account marked deleted', 'sign_in_off', 'coach', `update pilot.accounts set deleted_at = now() where account_id = '${COACH_ID}'`],
    ['a membership switched off', 'sign_in_off', 'coach', `update pilot.organization_memberships set active_flag = false where account_id = '${COACH_ID}'`],
    ['a gym suspended', 'sign_in_off', 'coach', `update pilot.organizations set status = 'suspended' where organization_id = '${ORG_ID}'`],
    [
      'an account moved to another gym (its old membership left on)',
      'sign_in_off',
      'coach',
      `insert into pilot.organizations (organization_id, organization_name, status) values ('org-emailsender-new', 'org-emailsender-new', 'active');
       update pilot.accounts set organization_id = 'org-emailsender-new' where account_id = '${COACH_ID}'`,
    ],
    ['a coach account on a PIN', 'sign_in_off', 'coach', `update pilot.accounts set auth_provider = 'ppbf_local' where account_id = '${COACH_ID}'`],
    [
      'a membership raised past what the home sign-in proves',
      'sign_in_off',
      'coach',
      `update pilot.organization_memberships set role = 'organization_admin' where account_id = '${COACH_ID}'`,
    ],
    [
      'a coach account linked to an athlete record under 18',
      'not_offered',
      'coach',
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
                                   emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ('${ORG_ID}', 'ath-emailsender-minor', 'Email Minor', '2012-06-01', '100', 'active', 'contact', true,
               '${COACH_ID}', now(), now());
       update pilot.accounts set athlete_id = 'ath-emailsender-minor' where account_id = '${COACH_ID}'`,
    ],
    ['a coach made a volunteer in this gym', 'not_offered', 'coach', `update pilot.organization_memberships set role = 'volunteer' where account_id = '${COACH_ID}'`],
    ['the gym unticked the event', 'gym_unticked', 'coach', `insert into pilot.organization_email_alert_events (organization_id, user_type, event_kind, ticked) values ('${ORG_ID}', 'staff', 'safety_escalation', false)`],
    ['no sign-in address', 'no_address', 'coach', `update pilot.accounts set login_email = null where account_id = '${COACH_ID}'`],
    [
      'a switch saved since under another user type',
      'not_offered',
      'coach',
      `update pilot.email_alert_switches set user_type = 'parent' where account_id = '${COACH_ID}'`,
    ],
    ['an athlete whose date of birth now says under 18', 'not_offered', 'adult', `update pilot.athletes set dob = '2012-06-01' where athlete_id = '${ADULT_ATHLETE}'`],
    ['an athlete record deleted', 'not_offered', 'adult', `update pilot.athletes set deleted_at = now() where athlete_id = '${ADULT_ATHLETE}'`],
  ])('%s: nothing is sent and the send is skipped as %s', async (_label, reason, who, change) => {
    const client = await freshDatabase('emailsender_skip');
    activeClient = client;
    try {
      await enqueueEmailAlertSends([
        who === 'adult'
          ? candidate(ADULT_ID, 'adult_athlete', 'coach_message', EVENT_1)
          : candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1),
      ]);
      await client.query(change);
      const { sent, dependencies } = recorder();
      expect((await runEmailAlertSweep(dependencies, [])).skipped).toBe(1);
      expect(sent).toEqual([]);
      expect(await sendRows(client)).toMatchObject([{ status: 'skipped', skip_reason: reason, finished: true }]);
    } finally {
      await client.end();
    }
  });

  test('a 5xx is retried after 1, 5, 15 and 60 minutes, keeping its codes; the fifth failure is final', async () => {
    const client = await freshDatabase('emailsender_retry');
    activeClient = client;
    try {
      await enqueueEmailAlertSends([candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)]);
      const { dependencies } = recorder(() => new MailSendError('GRAPH_SEND_FAILED', 503, 'ServiceUnavailable'));
      const waits: number[] = [];
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const result = await runEmailAlertSweep(dependencies, []);
        const { rows } = await client.query(
          `select status, tries, last_status_code, last_error_code,
                  round(extract(epoch from (next_try_at - clock_timestamp())) / 60) as wait_minutes
             from pilot.email_alert_sends`,
        );
        if (attempt < 5) {
          expect(result.retried).toBe(1);
          expect(rows[0]).toMatchObject({ status: 'queued', tries: attempt, last_status_code: 503, last_error_code: 'ServiceUnavailable' });
          waits.push(Number(rows[0].wait_minutes));
          await client.query('update pilot.email_alert_sends set next_try_at = clock_timestamp()');
        } else {
          expect(result.failed).toBe(1);
          expect(rows[0]).toMatchObject({ status: 'failed', tries: 5, last_status_code: 503 });
        }
      }
      expect(waits).toEqual([1, 5, 15, 60]);
    } finally {
      await client.end();
    }
  });

  test.each([
    ['a 403 is final at once', new MailSendError('GRAPH_SEND_FAILED', 403, 'ErrorAccessDenied'), 'failed', 'ErrorAccessDenied'],
    ['a malformed address is final at once', new MailSendError('RECIPIENT_MALFORMED'), 'failed', 'RECIPIENT_MALFORMED'],
    ['a 429 is retried', new MailSendError('GRAPH_SEND_FAILED', 429), 'queued', 'GRAPH_SEND_FAILED'],
    ['a call that never completed is retried', new MailSendError('NO_ACCESS_TOKEN'), 'queued', 'NO_ACCESS_TOKEN'],
    ['any other error is retried', new Error('socket hang up'), 'queued', 'SEND_ERROR'],
  ])('%s', async (_label, error, status, code) => {
    const client = await freshDatabase('emailsender_final');
    activeClient = client;
    try {
      await enqueueEmailAlertSends([candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)]);
      const { dependencies } = recorder(() => error);
      await runEmailAlertSweep(dependencies, []);
      expect(await sendRows(client)).toMatchObject([{ status, tries: 1, last_error_code: code }]);
    } finally {
      await client.end();
    }
  });

  test('a claim that lost its lease sends nothing and writes nothing', async () => {
    const client = await freshDatabase('emailsender_lease_guard');
    activeClient = client;
    try {
      await enqueueEmailAlertSends([candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)]);
      const [claimed] = await claimDueEmailAlertSends(1);
      // Another replica recovered the lease and claimed the row again.
      await client.query('update pilot.email_alert_sends set lease_token = gen_random_uuid()');
      const { sent, dependencies } = recorder();
      expect(await deliverEmailAlertSend(claimed, dependencies)).toBe('lost');
      expect(sent).toEqual([]);
      expect(await sendRows(client)).toMatchObject([{ status: 'sending', finished: false }]);
    } finally {
      await client.end();
    }
  });

  test('an outcome is not recorded if the lease was taken back during the send', async () => {
    const client = await freshDatabase('emailsender_lease_mid');
    activeClient = client;
    try {
      await enqueueEmailAlertSends([candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)]);
      const [claimed] = await claimDueEmailAlertSends(1);
      const { dependencies } = recorder();
      const slow = {
        ...dependencies,
        prepareSend: async () => {
          const send = await dependencies.prepareSend();
          return async (message: OutboundMessage) => {
            await send(message);
            await client.query('update pilot.email_alert_sends set lease_token = gen_random_uuid()');
          };
        },
      };
      expect(await deliverEmailAlertSend(claimed, slow)).toBe('lost');
      expect(await sendRows(client)).toMatchObject([{ status: 'sending', finished: false }]);
    } finally {
      await client.end();
    }
  });

  test('a token fetch that outlives the lease sends nothing', async () => {
    const client = await freshDatabase('emailsender_slow_token');
    activeClient = client;
    try {
      await enqueueEmailAlertSends([candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)]);
      const [claimed] = await claimDueEmailAlertSends(1);
      const { sent, dependencies } = recorder();
      const slowToken = {
        ...dependencies,
        prepareSend: async () => {
          // While the token is fetched, the lease runs out and another replica takes the row.
          await client.query(`update pilot.email_alert_sends set lease_expires_at = clock_timestamp() - interval '1 second'`);
          await recoverExpiredEmailAlertLeases();
          await claimDueEmailAlertSends(1);
          return dependencies.prepareSend();
        },
      };
      expect(await deliverEmailAlertSend(claimed, slowToken)).toBe('lost');
      expect(sent).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test.each([
    ['3 minutes 50 seconds', 'lost', 0],
    ['4 minutes 10 seconds', 'sent', 1],
  ])('with %s of the lease left, the send is %s (it needs four minutes)', async (left, outcome, sends) => {
    const client = await freshDatabase('emailsender_lease_margin');
    activeClient = client;
    try {
      await enqueueEmailAlertSends([candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)]);
      const [claimed] = await claimDueEmailAlertSends(1);
      await client.query(`update pilot.email_alert_sends set lease_expires_at = clock_timestamp() + $1::interval`, [left]);
      const { sent, dependencies } = recorder();
      expect(await deliverEmailAlertSend(claimed, dependencies)).toBe(outcome);
      expect(sent).toHaveLength(sends);
    } finally {
      await client.end();
    }
  });

  test('the tick stops claiming at its send limit and at its time budget', async () => {
    const client = await freshDatabase('emailsender_limits');
    activeClient = client;
    try {
      await enqueueEmailAlertSends([
        candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1),
        candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_2),
        candidate(PARENT_ID, 'parent', 'family_note', EVENT_1),
      ]);
      const { sent, dependencies } = recorder();
      expect((await runEmailAlertSweep(dependencies, [], { budgetMs: 60_000, sendsPerTick: 2 })).sent).toBe(2);
      // A clock that moves 15 seconds a read: the budget of 20 seconds allows one claim.
      let clock = 0;
      const ticking = { ...dependencies, clockMs: () => { const now = clock; clock += 15_000; return now; } };
      await client.query('update pilot.email_alert_sends set next_try_at = clock_timestamp()');
      expect((await runEmailAlertSweep(ticking, [], { budgetMs: 20_000, sendsPerTick: 20 })).sent).toBe(1);
      expect(sent).toHaveLength(3);
    } finally {
      await client.end();
    }
  });

  test('a claim with too little lease left sends nothing', async () => {
    const client = await freshDatabase('emailsender_lease_short');
    activeClient = client;
    try {
      await enqueueEmailAlertSends([candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)]);
      const [claimed] = await claimDueEmailAlertSends(1);
      // Four minutes of the five are needed: the token, then a Graph call cut off at 30 seconds.
      await client.query(`update pilot.email_alert_sends set lease_expires_at = clock_timestamp() + interval '3 minutes'`);
      const { sent, dependencies } = recorder();
      expect(await deliverEmailAlertSend(claimed, dependencies)).toBe('lost');
      expect(sent).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('one send that fails is logged and the tick sends the next', async () => {
    const client = await freshDatabase('emailsender_row_error');
    activeClient = client;
    try {
      await enqueueEmailAlertSends([
        candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1),
        candidate(PARENT_ID, 'parent', 'family_note', EVENT_2),
      ]);
      const { sent, dependencies } = recorder();
      let calls = 0;
      const flaky = {
        ...dependencies,
        gymName: async () => {
          calls += 1;
          if (calls === 1) throw new Error('profile read failed');
          return 'GYM';
        },
      };
      const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        expect((await runEmailAlertSweep(flaky, [])).sent).toBe(1);
        expect(errors).toHaveBeenCalledWith('Email alert send failed', { errorClass: 'Error' });
      } finally {
        errors.mockRestore();
      }
      expect(sent).toHaveLength(1);
      expect((await sendRows(client)).map((row) => row.status).sort()).toEqual(['sending', 'sent']);
    } finally {
      await client.end();
    }
  });
});
