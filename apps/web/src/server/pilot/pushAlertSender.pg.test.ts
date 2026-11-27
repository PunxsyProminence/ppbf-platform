// Real PostgreSQL-backed test for the web push sender (lane W5-WP, WP-2b-2b;
// plan and GO on #2228, section 4). The module's own SQL runs against an
// embedded Postgres with the full schema, the web-push tables (WP-1a) and the
// email alert tables (lane W4-1) included. The push service is replaced by a
// recorder that answers each browser as told, so nothing is posted; web-push
// 3.6.7 itself builds every request. It follows emailAlertSender.pg.test.ts.
//
// It NEVER connects to production or staging: an embedded server on a free
// local port, in a throwaway data directory.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client, Pool } from 'pg';
import type { PushRequestDetails } from 'web-push';

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

import type { EmailAlertCandidate } from './emailAlertQueue';
import { claimDuePushAlertSends, enqueuePushAlertSends } from './pushAlertQueue';
import {
  deliverPushAlertSend,
  PUSH_PAYLOAD,
  PUSH_TOPIC,
  PUSH_TTL_SECONDS,
  pushVapidDetails,
  runPushAlertSweep,
  type PushAlertSenderDependencies,
} from './pushAlertSender';
import { PushPostError } from './pushTransport';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-push-alert-sender-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-pushsender';
const OTHER_ORG_ID = 'org-pushsender-two';
const COACH_ID = 'acct-pushsender-coach';
const PARENT_ID = 'acct-pushsender-parent';
const ADULT_ID = 'acct-pushsender-adult';
const ADULT_ATHLETE = 'ath-pushsender-adult';
const EVENT_1 = '00000000-0000-4000-8000-000000000001';
const EVENT_2 = '00000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-11-27T17:00:00Z');

const b64url = (bytes: Buffer) => bytes.toString('base64url');

/** A VAPID key pair made for this run only, as the push settings hold one. */
function pushSettings(): Record<string, string> {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    PPBF_WEB_PUSH_VAPID_PUBLIC_KEY: b64url(ecdh.getPublicKey()),
    PPBF_WEB_PUSH_VAPID_PRIVATE_KEY: b64url(Buffer.from(ecdh.getPrivateKey('hex').padStart(64, '0'), 'hex')),
    PPBF_WEB_PUSH_SUBJECT: 'mailto:push@example.test',
  };
}
const SETTINGS = pushSettings();

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let browserCount = 0;

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

/** A browser as a real PushSubscription gives it: a P-256 public key and a 16-byte auth secret. */
async function addBrowser(client: Client, accountId: string, userType: string): Promise<string> {
  browserCount += 1;
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const endpoint = `https://push.example.test/send/browser-${browserCount}`;
  await client.query(
    `insert into pilot.push_subscriptions (organization_id, account_id, user_type, endpoint, key_p256dh, key_auth)
     values ($1, $2, $3, $4, $5, $6)`,
    [ORG_ID, accountId, userType, endpoint, b64url(ecdh.getPublicKey()), b64url(crypto.randomBytes(16))],
  );
  return endpoint;
}

/**
 * The full schema and one gym: a coach, a parent and an adult athlete, each a
 * member, each with the email switch on (the athlete with a confirmed address)
 * and one browser on.
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
  for (const [accountId, role] of [[COACH_ID, 'coach'], [PARENT_ID, 'parent']]) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, login_email)
       values ($1, $2, $3, 'magic_link', null, null)`,
      [accountId, role, ORG_ID],
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
     values ($1, $2, 'staff', true, now(), null, null, null),
            ($1, $3, 'parent', true, now(), null, null, null),
            ($1, $4, 'adult_athlete', true, now(), null, 'adult@example.test', now())`,
    [ORG_ID, COACH_ID, PARENT_ID, ADULT_ID],
  );
  await addBrowser(client, COACH_ID, 'staff');
  await addBrowser(client, PARENT_ID, 'parent');
  await addBrowser(client, ADULT_ID, 'adult_athlete');
  return client;
}

function candidate(accountId: string, userType: EmailAlertCandidate['userType'], eventKind: string, eventId: string) {
  return { organizationId: ORG_ID, accountId, userType, eventKind, eventId };
}

type Answer = number | Error | ((details: PushRequestDetails) => Promise<number>);

/** Records every built request and answers each browser as told (201 unless named). */
function recorder(answers: Record<string, Answer> = {}, fallback: Answer = 201) {
  const posted: PushRequestDetails[] = [];
  const dependencies: PushAlertSenderDependencies = {
    env: SETTINGS,
    post: async (details) => {
      posted.push(details);
      const answer = answers[details.endpoint] ?? fallback;
      if (typeof answer === 'function') return answer(details);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    now: () => NOW,
    clockMs: () => Date.now(),
    // These pushes name no real event; whether a person can still read one is
    // emailAlertEvents.ts's rule, tested in emailAlertEvents.pg.test.ts.
    stillReads: async () => true,
  };
  return { posted, dependencies };
}

async function sendRows(client: Client) {
  const { rows } = await client.query(
    `select account_id, event_kind, event_id, status, tries, skip_reason, last_status_code, last_error_code,
            finished_at is not null as finished
       from pilot.push_alert_sends order by send_id`,
  );
  return rows;
}

async function browsersOf(client: Client, accountId: string): Promise<string[]> {
  const { rows } = await client.query(
    'select endpoint from pilot.push_subscriptions where account_id = $1 order by subscription_id',
    [accountId],
  );
  return rows.map((row) => row.endpoint as string);
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

describe('web push sender', () => {
  test('a due push goes to each of the person\'s browsers once, built by web-push: encrypted, VAPID-signed, one Topic; the row says sent', async () => {
    const client = await freshDatabase('pushsender_sent');
    activeClient = client;
    try {
      const second = await addBrowser(client, COACH_ID, 'staff');
      const [first] = await browsersOf(client, COACH_ID);
      await enqueuePushAlertSends([candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)]);
      const { posted, dependencies } = recorder();
      expect(await runPushAlertSweep(dependencies, [])).toMatchObject({ sent: 1, skipped: 0, failed: 0, lost: 0 });
      expect(posted.map((details) => details.endpoint)).toEqual([first, second]);
      for (const details of posted) {
        expect(details.method).toBe('POST');
        expect(details.headers).toMatchObject({
          TTL: PUSH_TTL_SECONDS,
          Topic: PUSH_TOPIC,
          Urgency: 'normal',
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
        });
        expect(String(details.headers.Authorization)).toMatch(
          new RegExp(`^vapid t=[A-Za-z0-9_.-]+, k=${SETTINGS.PPBF_WEB_PUSH_VAPID_PUBLIC_KEY}$`),
        );
        // Encrypted to the browser's key: the payload's words are not in the body.
        expect(details.body?.length).toBeGreaterThan(PUSH_PAYLOAD.length);
        expect(details.body?.includes(Buffer.from(PUSH_PAYLOAD))).toBe(false);
      }
      expect(await sendRows(client)).toMatchObject([
        { status: 'sent', tries: 1, last_status_code: null, last_error_code: null, finished: true },
      ]);
      // Two encryptions of the same payload never match (a fresh key each).
      expect(posted[0].body?.equals(posted[1].body as Buffer)).toBe(false);
    } finally {
      await client.end();
    }
  });

  test.each([
    ['unset', {}],
    ['a public key that is not the private key\'s', { ...SETTINGS, PPBF_WEB_PUSH_VAPID_PUBLIC_KEY: pushSettings().PPBF_WEB_PUSH_VAPID_PUBLIC_KEY }],
    ['a subject that is not a URL', { ...SETTINGS, PPBF_WEB_PUSH_SUBJECT: 'push team' }],
  ])('push settings %s: a tick does nothing at all', async (_label, env) => {
    const client = await freshDatabase('pushsender_no_keys');
    activeClient = client;
    try {
      await enqueuePushAlertSends([candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)]);
      const reads: unknown[] = [];
      const source = { checkpointKey: 'safety_escalation', candidates: async () => { reads.push(1); return []; } };
      const { posted, dependencies } = recorder();
      expect(await runPushAlertSweep({ ...dependencies, env }, [source])).toEqual({
        queued: 0, recovered: 0, sent: 0, skipped: 0, retried: 0, failed: 0, lost: 0,
      });
      expect(posted).toEqual([]);
      expect(reads).toEqual([]);
      expect((await client.query('select 1 from pilot.push_alert_checkpoints')).rowCount).toBe(0);
      expect(await sendRows(client)).toMatchObject([{ status: 'queued', tries: 0 }]);
    } finally {
      await client.end();
    }
  });

  test.each([
    ['the email switch off since (QA pending)', 'switched_off', 'coach', `update pilot.email_alert_switches set switched_on = false where account_id = '${COACH_ID}'`],
    ['an account switched off', 'sign_in_off', 'coach', `update pilot.accounts set active_flag = false where account_id = '${COACH_ID}'`],
    ['an account marked deleted', 'sign_in_off', 'coach', `update pilot.accounts set deleted_at = now() where account_id = '${COACH_ID}'`],
    ['a membership switched off', 'sign_in_off', 'coach', `update pilot.organization_memberships set active_flag = false where account_id = '${COACH_ID}'`],
    ['a gym suspended', 'sign_in_off', 'coach', `update pilot.organizations set status = 'suspended' where organization_id = '${ORG_ID}'`],
    [
      'an account moved to another gym (its old membership left on)',
      'sign_in_off',
      'coach',
      `insert into pilot.organizations (organization_id, organization_name, status) values ('org-pushsender-new', 'org-pushsender-new', 'active');
       update pilot.accounts set organization_id = 'org-pushsender-new' where account_id = '${COACH_ID}'`,
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
       values ('${ORG_ID}', 'ath-pushsender-minor', 'Push Minor', '2012-06-01', '100', 'active', 'contact', true,
               '${COACH_ID}', now(), now());
       update pilot.accounts set athlete_id = 'ath-pushsender-minor' where account_id = '${COACH_ID}'`,
    ],
    ['a coach made a volunteer in this gym', 'not_offered', 'coach', `update pilot.organization_memberships set role = 'volunteer' where account_id = '${COACH_ID}'`],
    ['an email switch saved since under another user type', 'not_offered', 'coach', `update pilot.email_alert_switches set user_type = 'parent' where account_id = '${COACH_ID}'`],
    ['the gym unticked the event', 'gym_unticked', 'coach', `insert into pilot.organization_email_alert_events (organization_id, user_type, event_kind, ticked) values ('${ORG_ID}', 'staff', 'safety_escalation', false)`],
    ['no browser left', 'no_subscription', 'coach', `delete from pilot.push_subscriptions where account_id = '${COACH_ID}'`],
    ['a browser saved since under another user type', 'no_subscription', 'coach', `update pilot.push_subscriptions set user_type = 'parent' where account_id = '${COACH_ID}'`],
    ['an athlete whose date of birth now says under 18', 'not_offered', 'adult', `update pilot.athletes set dob = '2012-06-01' where athlete_id = '${ADULT_ATHLETE}'`],
    ['an athlete record deleted', 'not_offered', 'adult', `update pilot.athletes set deleted_at = now() where athlete_id = '${ADULT_ATHLETE}'`],
  ])('%s: nothing is posted and the push is skipped as %s, keeping the codes an earlier try left', async (_label, reason, who, change) => {
    const client = await freshDatabase('pushsender_skip');
    activeClient = client;
    try {
      await enqueuePushAlertSends([
        who === 'adult'
          ? candidate(ADULT_ID, 'adult_athlete', 'coach_message', EVENT_1)
          : candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1),
      ]);
      // An earlier try reached a push service and was told to come back.
      await client.query(`update pilot.push_alert_sends set last_status_code = 503, last_error_code = 'PUSH_TRY_AGAIN'`);
      await client.query(change);
      const { posted, dependencies } = recorder();
      expect((await runPushAlertSweep(dependencies, [])).skipped).toBe(1);
      expect(posted).toEqual([]);
      expect(await sendRows(client)).toMatchObject([
        { status: 'skipped', skip_reason: reason, finished: true, last_status_code: 503, last_error_code: 'PUSH_TRY_AGAIN' },
      ]);
    } finally {
      await client.end();
    }
  });

  test('a person no longer reading the event is skipped as not_offered', async () => {
    const client = await freshDatabase('pushsender_not_reading');
    activeClient = client;
    try {
      await enqueuePushAlertSends([candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)]);
      const { posted, dependencies } = recorder();
      expect((await runPushAlertSweep({ ...dependencies, stillReads: async () => false }, [])).skipped).toBe(1);
      expect(posted).toEqual([]);
      expect(await sendRows(client)).toMatchObject([{ status: 'skipped', skip_reason: 'not_offered' }]);
    } finally {
      await client.end();
    }
  });

  test('a browser that is gone (404 or 410) is deleted; one that took it makes the push sent', async () => {
    const client = await freshDatabase('pushsender_gone_one');
    activeClient = client;
    try {
      const second = await addBrowser(client, COACH_ID, 'staff');
      const third = await addBrowser(client, COACH_ID, 'staff');
      const [first] = await browsersOf(client, COACH_ID);
      await enqueuePushAlertSends([candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)]);
      const { dependencies } = recorder({ [first]: 410, [second]: 404 });
      expect((await runPushAlertSweep(dependencies, [])).sent).toBe(1);
      expect(await browsersOf(client, COACH_ID)).toEqual([third]);
      // Nobody else's browser was touched.
      expect(await browsersOf(client, PARENT_ID)).toHaveLength(1);
      expect(await sendRows(client)).toMatchObject([{ status: 'sent', last_status_code: null, last_error_code: null }]);
    } finally {
      await client.end();
    }
  });

  test('every browser gone: they are deleted, in every gym they are this person\'s, audited in each; the push fails on its first try, with the code', async () => {
    const client = await freshDatabase('pushsender_gone_all');
    activeClient = client;
    try {
      const [endpoint] = await browsersOf(client, COACH_ID);
      // The same browser is the coach's in a second gym too.
      await client.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [OTHER_ORG_ID]);
      await client.query(
        `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, 'coach', true)`,
        [COACH_ID, OTHER_ORG_ID],
      );
      await client.query(
        `insert into pilot.push_subscriptions (organization_id, account_id, user_type, endpoint, key_p256dh, key_auth)
         select $1, account_id, user_type, endpoint, key_p256dh, key_auth from pilot.push_subscriptions where endpoint = $2`,
        [OTHER_ORG_ID, endpoint],
      );
      await enqueuePushAlertSends([candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)]);
      const { dependencies } = recorder({}, 410);
      expect((await runPushAlertSweep(dependencies, [])).failed).toBe(1);
      expect(await browsersOf(client, COACH_ID)).toEqual([]);
      const audit = await client.query(
        `select organization_id, actor_account_id, entity_id, details from pilot.audit_events
          where entity_type = 'push_browser' order by organization_id`,
      );
      expect(audit.rows).toEqual([
        { organization_id: ORG_ID, actor_account_id: null, entity_id: COACH_ID, details: { push_browser: 'off', reason: 'gone', count: 1 } },
        { organization_id: OTHER_ORG_ID, actor_account_id: null, entity_id: COACH_ID, details: { push_browser: 'off', reason: 'gone', count: 1 } },
      ]);
      // No audit row names the endpoint.
      expect(JSON.stringify(audit.rows)).not.toContain('push.example.test');
      expect(await sendRows(client)).toMatchObject([
        { status: 'failed', tries: 1, last_status_code: 410, last_error_code: 'PUSH_GONE', finished: true },
      ]);
    } finally {
      await client.end();
    }
  });

  test('a browser moved to someone else during the send is not deleted as gone', async () => {
    const client = await freshDatabase('pushsender_gone_moved');
    activeClient = client;
    try {
      const [endpoint] = await browsersOf(client, COACH_ID);
      await enqueuePushAlertSends([candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)]);
      const { dependencies } = recorder({
        [endpoint]: async () => {
          // The parent turned push on in this browser while the push was out.
          await client.query(
            `update pilot.push_subscriptions set account_id = $1, user_type = 'parent' where endpoint = $2`,
            [PARENT_ID, endpoint],
          );
          return 410;
        },
      });
      expect((await runPushAlertSweep(dependencies, [])).failed).toBe(1);
      expect(await browsersOf(client, PARENT_ID)).toContain(endpoint);
    } finally {
      await client.end();
    }
  });

  test.each([
    ['this gym', 'ORG'],
    ['the other gym', 'OTHER'],
  ])('a gone browser saved again in %s while the push was out keeps that row; the rows as read go (Codex on #2253)', async (_label, which) => {
    const client = await freshDatabase('pushsender_gone_saved_again');
    activeClient = client;
    try {
      const [endpoint] = await browsersOf(client, COACH_ID);
      // The same browser is the coach's in a second gym too.
      await client.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [OTHER_ORG_ID]);
      await client.query(
        `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, 'coach', true)`,
        [COACH_ID, OTHER_ORG_ID],
      );
      await client.query(
        `insert into pilot.push_subscriptions (organization_id, account_id, user_type, endpoint, key_p256dh, key_auth)
         select $1, account_id, user_type, endpoint, key_p256dh, key_auth from pilot.push_subscriptions where endpoint = $2`,
        [OTHER_ORG_ID, endpoint],
      );
      const savedAgain = which === 'ORG' ? ORG_ID : OTHER_ORG_ID;
      const kept = which === 'ORG' ? OTHER_ORG_ID : ORG_ID;
      await enqueuePushAlertSends([candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)]);
      const { dependencies } = recorder({
        [endpoint]: async () => {
          // The coach's browser saved its subscription again, new keys, while the old one was refused.
          await client.query(
            `update pilot.push_subscriptions set key_auth = $1, saved_at = clock_timestamp()
              where endpoint = $2 and organization_id = $3`,
            [b64url(crypto.randomBytes(16)), endpoint, savedAgain],
          );
          return 410;
        },
      });
      expect((await runPushAlertSweep(dependencies, [])).failed).toBe(1);
      const { rows: left } = await client.query('select organization_id from pilot.push_subscriptions where account_id = $1', [COACH_ID]);
      expect(left).toEqual([{ organization_id: savedAgain }]);
      const audit = await client.query(
        `select organization_id, details from pilot.audit_events where entity_type = 'push_browser'`,
      );
      expect(audit.rows).toEqual([{ organization_id: kept, details: { push_browser: 'off', reason: 'gone', count: 1 } }]);
    } finally {
      await client.end();
    }
  });

  test('a browser the person has in another gym is not posted to', async () => {
    const client = await freshDatabase('pushsender_other_gym');
    activeClient = client;
    try {
      await client.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [OTHER_ORG_ID]);
      await client.query(
        `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, 'coach', true)`,
        [COACH_ID, OTHER_ORG_ID],
      );
      await client.query(
        `insert into pilot.push_subscriptions (organization_id, account_id, user_type, endpoint, key_p256dh, key_auth)
         select $1, account_id, user_type, 'https://push.example.test/send/other-gym', key_p256dh, key_auth
           from pilot.push_subscriptions where account_id = $2`,
        [OTHER_ORG_ID, COACH_ID],
      );
      const [here] = await browsersOf(client, COACH_ID);
      await enqueuePushAlertSends([candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)]);
      const { posted, dependencies } = recorder();
      expect((await runPushAlertSweep(dependencies, [])).sent).toBe(1);
      expect(posted.map((details) => details.endpoint)).toEqual([here]);
    } finally {
      await client.end();
    }
  });

  test('at most 10 browsers are posted to, all at once', async () => {
    const client = await freshDatabase('pushsender_ten');
    activeClient = client;
    try {
      // Past the store's cap of 10, written straight to the table.
      for (let count = 0; count < 11; count += 1) await addBrowser(client, COACH_ID, 'staff');
      await enqueuePushAlertSends([candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)]);
      let started = 0;
      let gaveUp = 0;
      const { posted, dependencies } = recorder({}, async () => {
        started += 1;
        // Answers only once every post has started: posted one after another,
        // the first would give up waiting (reviewer J, round 2: without the
        // count below, the tenth's 201 alone made the row sent).
        const deadline = Date.now() + 5_000;
        while (started < 10) {
          if (Date.now() > deadline) {
            gaveUp += 1;
            throw new Error('posted one after another');
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return 201;
      });
      expect((await runPushAlertSweep(dependencies, [])).sent).toBe(1);
      expect(posted).toHaveLength(10);
      expect(gaveUp).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('a 503 is tried again after 1, 5, 15 and 60 minutes, keeping its codes; the fifth is final', async () => {
    const client = await freshDatabase('pushsender_retry');
    activeClient = client;
    try {
      await enqueuePushAlertSends([candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)]);
      const { dependencies } = recorder({}, 503);
      const waits: number[] = [];
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const result = await runPushAlertSweep(dependencies, []);
        const { rows } = await client.query(
          `select status, tries, last_status_code, last_error_code,
                  round(extract(epoch from (next_try_at - clock_timestamp())) / 60) as wait_minutes
             from pilot.push_alert_sends`,
        );
        if (attempt < 5) {
          expect(result.retried).toBe(1);
          expect(rows[0]).toMatchObject({ status: 'queued', tries: attempt, last_status_code: 503, last_error_code: 'PUSH_TRY_AGAIN' });
          waits.push(Number(rows[0].wait_minutes));
          await client.query('update pilot.push_alert_sends set next_try_at = clock_timestamp()');
        } else {
          expect(result.failed).toBe(1);
          expect(rows[0]).toMatchObject({ status: 'failed', tries: 5, last_status_code: 503, last_error_code: 'PUSH_TRY_AGAIN' });
        }
      }
      expect(waits).toEqual([1, 5, 15, 60]);
    } finally {
      await client.end();
    }
  });

  test.each([
    ['a 403 is final at once', 403, 'failed', 403, 'PUSH_REFUSED'],
    ['a 413 is final at once', 413, 'failed', 413, 'PUSH_REFUSED'],
    ['a 429 is tried again', 429, 'queued', 429, 'PUSH_TRY_AGAIN'],
    ['a time-out is tried again', new PushPostError('PUSH_TIMEOUT'), 'queued', null, 'PUSH_TIMEOUT'],
    ['a network error is tried again', new Error('socket hang up'), 'queued', null, 'PUSH_NETWORK_ERROR'],
    ['a host that is not public is final at once', new PushPostError('PUSH_HOST_NOT_PUBLIC'), 'failed', null, 'PUSH_HOST_NOT_PUBLIC'],
    ['a status outside 100-599 is tried again', new PushPostError('PUSH_BAD_STATUS'), 'queued', null, 'PUSH_BAD_STATUS'],
  ] as const)('%s', async (_label, answer, status, code, error) => {
    const client = await freshDatabase('pushsender_answer');
    activeClient = client;
    try {
      await enqueuePushAlertSends([candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)]);
      const { dependencies } = recorder({}, answer);
      await runPushAlertSweep(dependencies, []);
      expect(await sendRows(client)).toMatchObject([{ status, tries: 1, last_status_code: code, last_error_code: error }]);
      expect(await browsersOf(client, COACH_ID)).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  test('one browser refusing and another worth trying again: the push goes back to the queue', async () => {
    const client = await freshDatabase('pushsender_mixed');
    activeClient = client;
    try {
      const second = await addBrowser(client, COACH_ID, 'staff');
      const [first] = await browsersOf(client, COACH_ID);
      await enqueuePushAlertSends([candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)]);
      const { dependencies } = recorder({ [first]: 503, [second]: 403 });
      expect((await runPushAlertSweep(dependencies, [])).retried).toBe(1);
      expect(await sendRows(client)).toMatchObject([{ status: 'queued', last_status_code: 503, last_error_code: 'PUSH_TRY_AGAIN' }]);
    } finally {
      await client.end();
    }
  });

  test('a claim with too little lease left posts nothing', async () => {
    const client = await freshDatabase('pushsender_lease_short');
    activeClient = client;
    try {
      await enqueuePushAlertSends([candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)]);
      const [claimed] = await claimDuePushAlertSends(1);
      await client.query(`update pilot.push_alert_sends set lease_expires_at = clock_timestamp() + interval '3 minutes'`);
      const { posted, dependencies } = recorder();
      const vapid = pushVapidDetails(SETTINGS);
      if (!vapid) throw new Error('test bug: the settings are not valid');
      expect(await deliverPushAlertSend(claimed, vapid, dependencies)).toBe('lost');
      expect(posted).toEqual([]);
      expect(await sendRows(client)).toMatchObject([{ status: 'sending', finished: false }]);
    } finally {
      await client.end();
    }
  });

  test('an outcome is not recorded if the lease was taken back during the send', async () => {
    const client = await freshDatabase('pushsender_lease_taken');
    activeClient = client;
    try {
      await enqueuePushAlertSends([candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1)]);
      const [claimed] = await claimDuePushAlertSends(1);
      const { dependencies } = recorder({}, async () => {
        await client.query('update pilot.push_alert_sends set lease_token = gen_random_uuid()');
        return 201;
      });
      const vapid = pushVapidDetails(SETTINGS);
      if (!vapid) throw new Error('test bug: the settings are not valid');
      expect(await deliverPushAlertSend(claimed, vapid, dependencies)).toBe('lost');
      expect(await sendRows(client)).toMatchObject([{ status: 'sending', finished: false }]);
    } finally {
      await client.end();
    }
  });

  test('a tick sweeps a source into the queue and sends what it queued; it stops at its send limit', async () => {
    const client = await freshDatabase('pushsender_tick');
    activeClient = client;
    try {
      const source = {
        checkpointKey: 'safety_escalation',
        candidates: async () => [
          candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1),
          candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_2),
        ],
      };
      const { posted, dependencies } = recorder();
      // The first sweep only sets push's checkpoint.
      expect(await runPushAlertSweep(dependencies, [source])).toMatchObject({ queued: 0, sent: 0 });
      expect(await runPushAlertSweep(dependencies, [source], { budgetMs: 20_000, sendsPerTick: 1 })).toMatchObject({ queued: 2, sent: 1 });
      expect(posted).toHaveLength(1);
      expect((await sendRows(client)).map((row) => row.status).sort()).toEqual(['queued', 'sent']);
    } finally {
      await client.end();
    }
  });

  test('one push that fails is logged by class only, and the tick sends the next', async () => {
    const client = await freshDatabase('pushsender_row_error');
    activeClient = client;
    try {
      await enqueuePushAlertSends([
        candidate(COACH_ID, 'staff', 'safety_escalation', EVENT_1),
        candidate(PARENT_ID, 'parent', 'family_note', EVENT_2),
      ]);
      const { posted, dependencies } = recorder();
      let calls = 0;
      const flaky = {
        ...dependencies,
        stillReads: async () => {
          calls += 1;
          if (calls === 1) throw new Error('read failed');
          return true;
        },
      };
      const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        expect((await runPushAlertSweep(flaky, [])).sent).toBe(1);
        expect(errors).toHaveBeenCalledWith('Push alert send failed', { errorClass: 'Error' });
      } finally {
        errors.mockRestore();
      }
      expect(posted).toHaveLength(1);
      expect((await sendRows(client)).map((row) => row.status).sort()).toEqual(['sending', 'sent']);
    } finally {
      await client.end();
    }
  });
});
