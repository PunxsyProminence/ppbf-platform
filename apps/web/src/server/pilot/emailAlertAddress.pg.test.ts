// Real PostgreSQL-backed test for the adult athlete's alert address and its
// code (lane W4-1, EM-2b-2; emailAlertSwitches.ts requestEmailAlertAddressCode
// and confirmEmailAlertAddress). OW27-38 B: an adult athlete types an address
// beside their switch; it is used only after they enter a code the app emails
// to it. OW27-02 C: an athlete under 18 or with no date of birth never stores
// or confirms one. "Default N" is item N of the defaults Overwatch GO'd on
// EM-2b (#2159 comment 7189871985); 4, 6 and 10 matter most, and each has a
// test here. The code email's wording is emailAlertCode.test.ts's; the switch
// itself is emailAlertSwitches.pg.test.ts's.
//
// './db' is mocked to route into an embedded server (the
// emailAlertSwitches.pg.test.ts pattern; withTransaction runs a real
// BEGIN/COMMIT/ROLLBACK), so the module's real SQL and audit.ts's run against
// real rows. The mailer is injected: nothing reaches Graph. The address limit
// runs on rateLimit.ts's in-memory half (PPBF_DURABLE_RATE_LIMIT is unset
// here), so every test uses addresses no other test uses.
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
// Set only by the race tests: each withTransaction then takes its own
// connection from a real pool, so two requests can really run at once.
let activePool: Pool | null = null;
// Set by the sign-in address test: every statement the module sends, in order.
let recorded: string[] | null = null;

function record(text: string) {
  recorded?.push(text.replace(/\s+/g, ' ').trim());
}

// Set by the age re-check test: run once, right after the first transaction
// that writes a switch row commits (between the commit and the send).
let afterWrite: (() => Promise<void>) | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    const target = activePool ?? activeClient;
    if (!target) throw new Error('test bug: no active embedded client');
    record(text);
    const result = await target.query(text, params);
    return result.rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    const target = activePool ?? activeClient;
    if (!target) throw new Error('test bug: no active embedded client');
    record(text);
    const result = await target.query(text, params);
    return result.rows[0] ?? null;
  }),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    const pooled = activePool ? await activePool.connect() : null;
    const client = pooled ?? activeClient;
    if (!client) throw new Error('test bug: no active embedded client');
    try {
      await client.query('BEGIN');
      let wrote = false;
      try {
        const result = await fn({
          query: (text: string, values: unknown[]) => {
            record(text);
            if (/insert into pilot\.email_alert_switches/.test(text)) wrote = true;
            return client.query(text, values);
          },
        });
        await client.query('COMMIT');
        const hook = wrote ? afterWrite : null;
        if (hook) {
          afterWrite = null;
          await hook();
        }
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    } finally {
      pooled?.release();
    }
  }),
}));

// The route test below signs each person in as their session would.
jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});
// The route's own mailer: no route test here may reach a send.
jest.mock('./emailAlertCode', () => ({
  emailAlertCodeMailer: jest.fn(() => async () => {
    throw new Error('test bug: the route reached the code email');
  }),
}));

import { NextRequest } from 'next/server';

import * as addressRoute from '@/app/api/pilot/email-alerts/me/address/route';

import type { PilotRole } from './contracts';
import {
  confirmEmailAlertAddress,
  EMAIL_ALERT_CODE_LIFETIME_MS,
  emailAlertCodeHash,
  emailAlertCodeLimitError,
  readEmailAlertSwitch,
  requestEmailAlertAddressCode,
  setEmailAlertSwitch,
  type EmailAlertCodeMailer,
} from './emailAlertSwitches';
import { MailSendError } from './graphMailer';
import { jsonError, requirePrincipal } from './http';
import { getRateLimitStatus } from './rateLimit';
import { hashToken } from './security';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-email-alert-address-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_email_alert_switches_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-email-alert-switches-migration.mjs',
);
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-emailaddr';
const OTHER_ORG_ID = 'org-emailaddr-elsewhere';
const COACH_ID = 'acct-emailaddr-coach';
const PARENT_ID = 'acct-emailaddr-parent';
const ADULT_ID = 'acct-emailaddr-adult';
const ADULT2_ID = 'acct-emailaddr-adult2';
const MINOR_ID = 'acct-emailaddr-minor';
const GONE_ID = 'acct-emailaddr-gone';
const BIRTHDAY_ID = 'acct-emailaddr-birthday';

const ADULT_ATHLETE = 'ath-emailaddr-adult';
const ADULT2_ATHLETE = 'ath-emailaddr-adult2';
const MINOR_ATHLETE = 'ath-emailaddr-minor';
const GONE_ATHLETE = 'ath-emailaddr-gone';
const BIRTHDAY_ATHLETE = 'ath-emailaddr-birthday';
/** A record with no login of its own, for A5. */
const KID_ATHLETE = 'ath-emailaddr-kid';

/** The coach's sign-in address: default 6 sends a code to it. */
const COACH_LOGIN = 'coach.login@example.test';

// A fixed "now" well after the adults' 18th birthdays, on the birthday athlete's.
const NOW = new Date('2026-11-25T17:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const LIFETIME = EMAIL_ALERT_CODE_LIFETIME_MS;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
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

/** The full schema, one gym, and one account of each kind in it. */
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
  // Staff and parents first: an athlete row names its coach (pilot_athletes_coach_fk).
  const people: Array<[string, string, string, string | null]> = [
    [COACH_ID, 'coach', 'magic_link', COACH_LOGIN],
    [PARENT_ID, 'parent', 'magic_link', null],
  ];
  for (const [accountId, role, provider, login] of people) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, login_email)
       values ($1, $2, $3, $4, null, $5)`,
      [accountId, role, ORG_ID, provider, login],
    );
  }
  // pilot.athletes.dob is NOT NULL in the schema, so "no date of birth" cannot
  // be stored; emailAlertSwitches.test.ts covers a null date in code.
  const athletes: Array<[string | null, string, string, boolean]> = [
    [ADULT_ID, ADULT_ATHLETE, '2000-03-14', false],
    [ADULT2_ID, ADULT2_ATHLETE, '1999-07-01', false],
    [MINOR_ID, MINOR_ATHLETE, '2012-06-01', false],
    [GONE_ID, GONE_ATHLETE, '1995-01-01', true],
    // Turns 18 on 2026-11-25, the gym's day of NOW.
    [BIRTHDAY_ID, BIRTHDAY_ATHLETE, '2008-11-25', false],
    [null, KID_ATHLETE, '2013-02-02', false],
  ];
  for (const [accountId, athleteId, dob, deleted] of athletes) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
       values ($1, $2, 'Email Athlete', $3::date, '100', 'active', 'contact', true, $5, now(), now(),
               case when $4 then now() end)`,
      [ORG_ID, athleteId, dob, deleted, COACH_ID],
    );
    if (accountId) {
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, login_email)
         values ($1, 'athlete', $2, 'ppbf_local', $3, null)`,
        [accountId, ORG_ID, athleteId],
      );
    }
  }
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     select account_id, organization_id, role, true from pilot.accounts where organization_id = $1`,
    [ORG_ID],
  );
  await applyMigrationTransaction(client, migrationSql);
  return client;
}

const SUBJECTS: Record<string, { accountId: string; role: PilotRole; athleteId: string | null }> = {
  coach: { accountId: COACH_ID, role: 'coach', athleteId: null },
  parent: { accountId: PARENT_ID, role: 'parent', athleteId: null },
  adult: { accountId: ADULT_ID, role: 'athlete', athleteId: ADULT_ATHLETE },
  adult2: { accountId: ADULT2_ID, role: 'athlete', athleteId: ADULT2_ATHLETE },
  minor: { accountId: MINOR_ID, role: 'athlete', athleteId: MINOR_ATHLETE },
  gone: { accountId: GONE_ID, role: 'athlete', athleteId: GONE_ATHLETE },
  birthday: { accountId: BIRTHDAY_ID, role: 'athlete', athleteId: BIRTHDAY_ATHLETE },
};

function subject(key: keyof typeof SUBJECTS) {
  return { organizationId: ORG_ID, ...SUBJECTS[key] };
}

// Every address is used by one test only: the address limit is process memory.
let addressCount = 0;
function newAddress(label: string): string {
  addressCount += 1;
  return `${label}.${addressCount}@example.test`;
}

interface Sent { organizationId: string; to: string; code: string }

function mailbox() {
  const sent: Sent[] = [];
  const send = jest.fn<Promise<void>, [Sent]>(async (message) => {
    sent.push(message);
  });
  return { sent, send: send as jest.Mock<Promise<void>, [Sent]> & EmailAlertCodeMailer };
}

function post(key: keyof typeof SUBJECTS, address: string, send: EmailAlertCodeMailer, now: Date = NOW) {
  return requestEmailAlertAddressCode({ ...subject(key), address }, send, now);
}

function put(key: keyof typeof SUBJECTS, code: string, now: Date = NOW) {
  return confirmEmailAlertAddress({ ...subject(key), code }, now);
}

function wrong(code: string): string {
  return String((Number(code) + 1) % 1_000_000).padStart(6, '0');
}

async function addressRow(client: Client, accountId = ADULT_ID) {
  const { rows } = await client.query(
    `select user_type, switched_on, pending_address, pending_code_hash, pending_code_expires_at,
            pending_code_attempts, confirmed_address, confirmed_at is not null as has_confirmed_at
       from pilot.email_alert_switches where organization_id = $1 and account_id = $2`,
    [ORG_ID, accountId],
  );
  return rows[0] ?? null;
}

async function switchCount(client: Client): Promise<number> {
  const { rows } = await client.query('select count(*)::int as n from pilot.email_alert_switches');
  return rows[0].n;
}

async function auditDetails(client: Client) {
  const { rows } = await client.query(
    `select details from pilot.audit_events where entity_type = 'email_alert_switch' order by audit_id`,
  );
  return rows.map((row) => row.details as Record<string, unknown>);
}

/** No audit row holds any of these, and nothing is mirrored to SHADOW. */
async function expectNoneHeld(client: Client, secrets: string[]) {
  const { rows } = await client.query(
    `select coalesce(json_agg(json_build_object(
              'actor', a.actor_account_id, 'entity', a.entity_id, 'details', a.details)), '[]') as audit
       from pilot.audit_events a`,
  );
  const held = JSON.stringify(rows[0].audit);
  expect(held).toContain('address_action');
  for (const secret of secrets) expect(held).not.toContain(secret);
  expect(held).not.toContain('@');
  const mirrored = await client.query(`select count(*)::int as n from pilot.shadow_events where entity_type = 'email_alert_switch'`);
  expect(mirrored.rows[0].n).toBe(0);
}

const LIMIT_ANSWER = { status: 429, body: { error: emailAlertCodeLimitError().message, code: 'EMAIL_ALERT_CODE_LIMIT' } };

/** What the route answers for an error: status, body and every header. */
async function answerOf(error: unknown) {
  const response = jsonError(error);
  return { status: response.status, body: await response.json(), headers: [...response.headers.entries()] };
}

/** Every limit's answer is this one, status, body and headers alike (default 4). */
async function limitAnswer(attempt: Promise<unknown>) {
  const error = await attempt.then(() => null, (thrown: unknown) => thrown);
  const answer = await answerOf(error);
  expect(answer).toMatchObject(LIMIT_ANSWER);
  expect(answer).toEqual(await answerOf(emailAlertCodeLimitError()));
  return answer;
}

/** Every console line a step writes, as one string. */
async function consoleDuring(step: () => Promise<unknown>): Promise<string> {
  const spies = (['error', 'warn', 'log', 'info'] as const).map((level) => jest.spyOn(console, level).mockImplementation(() => {}));
  try {
    await step().catch(() => undefined);
    return JSON.stringify(spies.map((spy) => spy.mock.calls));
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Holds the office's statements open on a second connection until `waiters`
 * requests are waiting on a lock, runs `after`, then commits.
 */
async function whileHeld<T>(
  client: Client,
  before: Array<[string, unknown[]]>,
  steps: Array<() => Promise<T>>,
  { waiters = steps.length, after = [] as Array<[string, unknown[]]> } = {},
) {
  const office = await activePool!.connect();
  try {
    await office.query('BEGIN');
    for (const [sql, values] of before) await office.query(sql, values);
    let settled = 0;
    const results = steps.map((step) => {
      const result = step();
      result.then(() => { settled += 1; }, () => { settled += 1; });
      return result;
    });
    let waited = false;
    for (let i = 0; i < 400 && settled === 0; i += 1) {
      const { rows } = await client.query(
        `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
      );
      if (rows[0].n >= waiters) {
        waited = true;
        break;
      }
      await sleep(25);
    }
    // The requests really were held by the office's rows, not finished before them.
    expect(waited).toBe(true);
    for (const [sql, values] of after) await office.query(sql, values);
    await office.query('COMMIT');
    return await Promise.allSettled(results);
  } finally {
    office.release(true);
  }
}

beforeAll(async () => {
  delete process.env.PPBF_DURABLE_RATE_LIMIT;
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

  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (client: Client, sql: string) => Promise<void>;
});

afterEach(async () => {
  activeClient = null;
  recorded = null;
  afterWrite = null;
  if (activePool) await activePool.end().catch(() => {});
  activePool = null;
  jest.restoreAllMocks();
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

describe('the adult athlete\'s alert address on a real database', () => {
  test('send, confirm, then a separate switch-on: the code is bound to the address typed, and confirming never switches on (default 10)', async () => {
    const client = await freshDatabase('emailaddr_flow');
    activeClient = client;
    try {
      const address = newAddress('adult.person');
      const mail = mailbox();
      await expect(post('adult', `  ${address.toUpperCase()} `, mail.send)).resolves.toEqual({
        offered: true, user_type: 'adult_athlete', switched_on: false, address_confirmed: false, code_pending: true,
      });
      expect(mail.sent).toEqual([{ organizationId: ORG_ID, to: address, code: expect.stringMatching(/^\d{6}$/) }]);
      const { code } = mail.sent[0];
      expect(await addressRow(client)).toMatchObject({
        user_type: 'adult_athlete', switched_on: false, pending_address: address, confirmed_address: null,
        pending_code_hash: emailAlertCodeHash(ORG_ID, ADULT_ID, address, code), pending_code_attempts: 0,
      });
      // Default 9: GET says a code can be entered, and never says where it went.
      await expect(readEmailAlertSwitch(subject('adult'), NOW)).resolves.toEqual({
        offered: true, user_type: 'adult_athlete', switched_on: false, address_confirmed: false, code_pending: true,
      });

      await expect(put('adult', code, at(60_000))).resolves.toEqual({
        offered: true, user_type: 'adult_athlete', switched_on: false, address_confirmed: true, code_pending: false,
      });
      expect(await addressRow(client)).toMatchObject({
        switched_on: false, confirmed_address: address, has_confirmed_at: true,
        pending_address: null, pending_code_hash: null, pending_code_expires_at: null, pending_code_attempts: 0,
      });
      // On is its own press (OD-2026-11-19-019).
      await expect(setEmailAlertSwitch({ ...subject('adult'), switchedOn: true }, NOW)).resolves.toEqual({
        offered: true, user_type: 'adult_athlete', switched_on: true, address_confirmed: true, code_pending: false,
      });
      expect(await auditDetails(client)).toEqual([
        { user_type: 'adult_athlete', address_action: 'code_sent' },
        { user_type: 'adult_athlete', address_action: 'confirmed', replaced_confirmed: false, switched_on: false },
        { user_type: 'adult_athlete', switched_on: true, previous_switched_on: false },
      ]);
      await expectNoneHeld(client, [code]);
    } finally {
      await client.end();
    }
  });

  test('a switch save while a code is pending answers code_pending: true, and the code still confirms after it', async () => {
    const client = await freshDatabase('emailaddr_save_pending');
    activeClient = client;
    try {
      const mail = mailbox();
      const address = newAddress('pending');
      await post('adult', address, mail.send);
      // PUT /me's answer must not hide a code that can still be entered.
      await expect(setEmailAlertSwitch({ ...subject('adult'), switchedOn: false }, NOW)).resolves.toEqual({
        offered: true, user_type: 'adult_athlete', switched_on: false, address_confirmed: false, code_pending: true,
      });
      expect(await addressRow(client)).toMatchObject({
        pending_address: address, pending_code_hash: emailAlertCodeHash(ORG_ID, ADULT_ID, address, mail.sent[0].code),
      });
      await expect(put('adult', mail.sent[0].code)).resolves.toMatchObject({ address_confirmed: true, code_pending: false });
      // On with a confirmed address while a second code waits: still pending.
      const second = mailbox();
      await post('adult', newAddress('pending'), second.send, at(60_000));
      await expect(setEmailAlertSwitch({ ...subject('adult'), switchedOn: true }, at(60_000))).resolves.toEqual({
        offered: true, user_type: 'adult_athlete', switched_on: true, address_confirmed: true, code_pending: true,
      });
      await expect(put('adult', second.sent[0].code, at(60_000))).resolves.toEqual({
        offered: true, user_type: 'adult_athlete', switched_on: true, address_confirmed: true, code_pending: false,
      });
    } finally {
      await client.end();
    }
  });

  test('a code works once', async () => {
    const client = await freshDatabase('emailaddr_once');
    activeClient = client;
    try {
      const mail = mailbox();
      await post('adult', newAddress('once'), mail.send);
      await put('adult', mail.sent[0].code);
      const confirmed = await addressRow(client);
      await expect(put('adult', mail.sent[0].code)).rejects.toMatchObject({ status: 409, code: 'EMAIL_ALERT_CODE_EXPIRED' });
      expect(await addressRow(client)).toEqual(confirmed);
      expect(await auditDetails(client)).toHaveLength(2);
    } finally {
      await client.end();
    }
  });

  test('the 15-minute boundary: stored as sent plus 15 minutes; a millisecond before, it works; at 15 minutes it is refused and the address cleared (default 11)', async () => {
    const client = await freshDatabase('emailaddr_expiry');
    activeClient = client;
    try {
      const first = mailbox();
      await post('adult', newAddress('early'), first.send);
      expect((await addressRow(client)).pending_code_expires_at.getTime()).toBe(NOW.getTime() + 15 * 60 * 1000);
      await expect(put('adult', first.sent[0].code, at(LIFETIME - 1))).resolves.toMatchObject({ address_confirmed: true });

      const late = newAddress('late');
      const second = mailbox();
      const sentAt = at(LIFETIME + 1);
      await post('adult', late, second.send, sentAt);
      const lateNow = new Date(sentAt.getTime() + LIFETIME);
      // GET no longer offers the field (GO condition 3), and writes nothing.
      await expect(readEmailAlertSwitch(subject('adult'), lateNow)).resolves.toMatchObject({ code_pending: false });
      await expect(put('adult', second.sent[0].code, lateNow)).rejects.toMatchObject({ status: 409, code: 'EMAIL_ALERT_CODE_EXPIRED' });
      // The confirmed address stays; the expired one is gone.
      expect(await addressRow(client)).toMatchObject({
        confirmed_address: first.sent[0].to, pending_address: null, pending_code_hash: null, pending_code_expires_at: null,
      });
      expect((await auditDetails(client)).map((row) => row.address_action)).toEqual(['code_sent', 'confirmed', 'code_sent', 'expired_cleared']);
    } finally {
      await client.end();
    }
  });

  test('an expired code is cleared by the next POST even when a limit refuses it (default 11)', async () => {
    const client = await freshDatabase('emailaddr_expiry_post');
    activeClient = client;
    try {
      const mail = mailbox();
      for (let i = 0; i < 5; i += 1) await post('adult', newAddress('day'), mail.send, at(i * LIFETIME));
      await limitAnswer(post('adult', newAddress('day'), mail.send, at(5 * LIFETIME)));
      expect(await addressRow(client)).toMatchObject({ pending_address: null, pending_code_hash: null });
      expect((await auditDetails(client)).map((row) => row.address_action).slice(-1)).toEqual(['expired_cleared']);
    } finally {
      await client.end();
    }
  });

  test('default 3: five tries a code; at the cap even the right code is refused until a new code is sent', async () => {
    const client = await freshDatabase('emailaddr_tries');
    activeClient = client;
    try {
      const mail = mailbox();
      await post('adult', newAddress('tries'), mail.send);
      const { code } = mail.sent[0];
      for (let tries = 1; tries <= 5; tries += 1) {
        await expect(put('adult', wrong(code))).rejects.toMatchObject({ status: 409, code: 'EMAIL_ALERT_CODE_WRONG' });
        expect((await addressRow(client)).pending_code_attempts).toBe(tries);
      }
      await expect(readEmailAlertSwitch(subject('adult'), NOW)).resolves.toMatchObject({ code_pending: false });
      await expect(put('adult', code)).rejects.toMatchObject({ status: 409, code: 'EMAIL_ALERT_CODE_TRIES_USED' });
      await expect(put('adult', wrong(code))).rejects.toMatchObject({ status: 409, code: 'EMAIL_ALERT_CODE_TRIES_USED' });
      expect(await addressRow(client)).toMatchObject({ pending_code_attempts: 5, confirmed_address: null });

      const fresh = mailbox();
      await post('adult', newAddress('tries'), fresh.send, at(60_000));
      expect((await addressRow(client)).pending_code_attempts).toBe(0);
      await expect(put('adult', fresh.sent[0].code, at(60_000))).resolves.toMatchObject({ address_confirmed: true });
      const actions = (await auditDetails(client)).map((row) => row.address_action);
      expect(actions).toEqual(['code_sent', 'code_wrong', 'code_wrong', 'code_wrong', 'code_wrong', 'code_wrong', 'code_sent', 'confirmed']);
      expect((await auditDetails(client)).filter((row) => row.address_action === 'code_wrong').map((row) => row.tries)).toEqual([1, 2, 3, 4, 5]);
      await expectNoneHeld(client, [code, fresh.sent[0].code]);
    } finally {
      await client.end();
    }
  });

  test('default 5: a new address leaves the confirmed one in use, switched on, until its own code is entered; a newer POST voids the older code', async () => {
    const client = await freshDatabase('emailaddr_replace');
    activeClient = client;
    try {
      const firstMail = mailbox();
      const first = newAddress('first');
      await post('adult', first, firstMail.send);
      await put('adult', firstMail.sent[0].code);
      await setEmailAlertSwitch({ ...subject('adult'), switchedOn: true }, NOW);

      const second = mailbox();
      await expect(post('adult', newAddress('second'), second.send, at(1_000))).resolves.toEqual({
        offered: true, user_type: 'adult_athlete', switched_on: true, address_confirmed: true, code_pending: true,
      });
      expect(await addressRow(client)).toMatchObject({ switched_on: true, confirmed_address: first });

      const third = mailbox();
      const thirdAddress = newAddress('third');
      await post('adult', thirdAddress, third.send, at(62_000));
      // The second code was for the second address: void now.
      if (second.sent[0].code !== third.sent[0].code) {
        await expect(put('adult', second.sent[0].code, at(63_000))).rejects.toMatchObject({ status: 409, code: 'EMAIL_ALERT_CODE_WRONG' });
      }
      expect(await addressRow(client)).toMatchObject({ switched_on: true, confirmed_address: first, pending_address: thirdAddress });
      await expect(put('adult', third.sent[0].code, at(64_000))).resolves.toEqual({
        offered: true, user_type: 'adult_athlete', switched_on: true, address_confirmed: true, code_pending: false,
      });
      expect(await addressRow(client)).toMatchObject({ switched_on: true, confirmed_address: thirdAddress, pending_address: null });
      expect((await auditDetails(client)).filter((row) => row.address_action === 'confirmed').map((row) => row.replaced_confirmed))
        .toEqual([false, true]);
    } finally {
      await client.end();
    }
  });

  test('default 4(b): one person, one code email a minute, read from the row; the same 429 as every limit', async () => {
    const client = await freshDatabase('emailaddr_minute');
    activeClient = client;
    try {
      const mail = mailbox();
      await post('adult', newAddress('minute'), mail.send);
      const before = await addressRow(client);
      await limitAnswer(post('adult', newAddress('minute'), mail.send, at(59_999)));
      expect(mail.sent).toHaveLength(1);
      expect(await addressRow(client)).toEqual(before);
      await expect(post('adult', newAddress('minute'), mail.send, at(60_000))).resolves.toMatchObject({ code_pending: true });
      expect(mail.sent).toHaveLength(2);
      expect((await auditDetails(client)).map((row) => row.address_action)).toEqual(['code_sent', 'code_sent']);
    } finally {
      await client.end();
    }
  });

  test('default 4(a): the address\'s own budget, keyed by its hash, holds across people; the same 429 as every limit', async () => {
    const client = await freshDatabase('emailaddr_address_key');
    activeClient = client;
    try {
      const shared = newAddress('shared');
      const mail = mailbox();
      // The limiter's clock is held still, so the second request falls inside
      // the first one's backoff however slowly this machine runs.
      const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now());
      await post('adult', shared, mail.send);
      expect(getRateLimitStatus(`email_alert_code_address:${hashToken(shared)}`)).toMatchObject({ count: 1, isCurrentlyLimited: true });
      // Another adult athlete, the same address as typed differently: refused, nothing written or sent.
      await limitAnswer(post('adult2', ` ${shared.toUpperCase()}`, mail.send));
      clock.mockRestore();
      expect(mail.sent).toHaveLength(1);
      expect(await addressRow(client, ADULT2_ID)).toBeNull();
      // One bucket, named by the normalized address's hash and never the address
      // (the refused request is not counted: rateLimit.ts reserveAttempts).
      expect(getRateLimitStatus(`email_alert_code_address:${hashToken(shared)}`).count).toBe(1);
      expect(getRateLimitStatus(`email_alert_code_address:${shared}`).count).toBe(0);
      // A different address for the same second person is not held by it.
      await expect(post('adult2', newAddress('other'), mail.send)).resolves.toMatchObject({ code_pending: true });
    } finally {
      await client.end();
    }
  });

  test('default 4(c): one person, five code emails a day in a gym, counted from the audit rows; the same 429 as every limit', async () => {
    const client = await freshDatabase('emailaddr_day');
    activeClient = client;
    try {
      const mail = mailbox();
      for (let i = 0; i < 5; i += 1) await post('adult', newAddress('day'), mail.send, at(i * 61_000));
      const sixth = at(5 * 61_000);
      await limitAnswer(post('adult', newAddress('day'), mail.send, sixth));
      // Still inside the day by a second: still refused.
      await client.query(`update pilot.audit_events set created_at = $1::timestamptz - interval '24 hours' + interval '1 second'`, [sixth]);
      await limitAnswer(post('adult', newAddress('day'), mail.send, sixth));
      expect(mail.sent).toHaveLength(5);
      // A full day back: no longer counted.
      await client.query(`update pilot.audit_events set created_at = $1::timestamptz - interval '24 hours'`, [sixth]);
      await expect(post('adult', newAddress('day'), mail.send, sixth)).resolves.toMatchObject({ code_pending: true });
      expect(mail.sent).toHaveLength(6);
    } finally {
      await client.end();
    }
  });

  test('default 6: an address that is another account\'s sign-in address gets the same answer, by the same statements, with nothing said in a log', async () => {
    const run = async (name: string, address: string) => {
      const client = await freshDatabase(name);
      activeClient = client;
      try {
        const mail = mailbox();
        recorded = [];
        let answer: unknown;
        const logs = await consoleDuring(async () => {
          answer = await post('adult', address, mail.send);
        });
        const statements = recorded;
        recorded = null;
        expect(mail.sent.map((sent) => sent.to)).toEqual([address]);
        return { answer, statements, logs, row: await addressRow(client) };
      } finally {
        await client.end();
      }
    };
    const signIn = await run('emailaddr_signin_a', COACH_LOGIN);
    const nobody = await run('emailaddr_signin_b', newAddress('nobody'));
    expect(signIn.answer).toEqual({
      offered: true, user_type: 'adult_athlete', switched_on: false, address_confirmed: false, code_pending: true,
    });
    expect(nobody.answer).toEqual(signIn.answer);
    expect(signIn.statements.length).toBeGreaterThan(5);
    expect(nobody.statements).toEqual(signIn.statements);
    expect(signIn.statements.join('\n')).not.toMatch(/login_email/);
    expect(signIn.row).toMatchObject({ pending_address: COACH_LOGIN });
    expect(signIn.logs).toBe('[[],[],[],[]]');
    expect(nobody.logs).toBe('[[],[],[],[]]');
  });

  test.each([
    ['an athlete under 18', 'minor', null],
    ['an athlete whose record is deleted', 'gone', null],
    ['an athlete whose account is unlinked from the record', 'adult', `update pilot.accounts set athlete_id = null where account_id = '${ADULT_ID}'`],
    ['a session pointing at another athlete\'s record', 'adult', `update pilot.accounts set athlete_id = '${KID_ATHLETE}' where account_id = '${ADULT_ID}'`],
  ] as const)('%s: POST and PUT are 403 with no row, no audit, no email and nothing reserved', async (_label, key, change) => {
    const client = await freshDatabase('emailaddr_minor');
    activeClient = client;
    try {
      if (change) {
        if (change.includes(KID_ATHLETE)) await client.query(`update pilot.athletes set dob = '2000-01-01' where athlete_id = '${KID_ATHLETE}'`);
        await client.query(change);
      }
      const address = newAddress('refused');
      const mail = mailbox();
      await expect(post(key, address, mail.send)).rejects.toMatchObject({ status: 403 });
      await expect(put(key, '123456')).rejects.toMatchObject({ status: 403 });
      expect(mail.send).not.toHaveBeenCalled();
      expect(await switchCount(client)).toBe(0);
      expect(await auditDetails(client)).toEqual([]);
      expect(getRateLimitStatus(`email_alert_code_address:${hashToken(address)}`).count).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('a date of birth corrected to under 18 between POST and PUT: 403, and the typed address cleared', async () => {
    const client = await freshDatabase('emailaddr_dob_between');
    activeClient = client;
    try {
      const mail = mailbox();
      await post('adult', newAddress('between'), mail.send);
      await client.query(`update pilot.athletes set dob = '2012-01-01' where athlete_id = $1`, [ADULT_ATHLETE]);
      await expect(put('adult', mail.sent[0].code)).rejects.toMatchObject({ status: 403 });
      expect(await addressRow(client)).toMatchObject({ pending_address: null, pending_code_hash: null, confirmed_address: null });
      expect((await auditDetails(client)).map((row) => row.reason ?? row.address_action)).toEqual(['code_sent', 'no_longer_offered']);
      await expect(readEmailAlertSwitch(subject('adult'), NOW)).resolves.toEqual({ offered: false });
    } finally {
      await client.end();
    }
  });

  test('an athlete who turns 18 today may; the day before they may not', async () => {
    const client = await freshDatabase('emailaddr_birthday');
    activeClient = client;
    try {
      const mail = mailbox();
      await expect(post('birthday', newAddress('birthday'), mail.send, at(-24 * 60 * 60 * 1000))).rejects.toMatchObject({ status: 403 });
      expect(await switchCount(client)).toBe(0);
      await expect(post('birthday', newAddress('birthday'), mail.send)).resolves.toMatchObject({ code_pending: true });
      await expect(put('birthday', mail.sent[0].code)).resolves.toMatchObject({ address_confirmed: true });
    } finally {
      await client.end();
    }
  });

  test('default 12: in a gym not active, POST and PUT are refused and the typed address is kept', async () => {
    const client = await freshDatabase('emailaddr_gym');
    activeClient = client;
    try {
      const mail = mailbox();
      await post('adult', newAddress('gym'), mail.send);
      const before = await addressRow(client);
      await client.query(`update pilot.organizations set status = 'suspended' where organization_id = $1`, [ORG_ID]);
      await expect(put('adult', mail.sent[0].code)).rejects.toMatchObject({ status: 403 });
      await expect(post('adult', newAddress('gym'), mail.send, at(61_000))).rejects.toMatchObject({ status: 403 });
      expect(mail.sent).toHaveLength(1);
      expect(await addressRow(client)).toEqual(before);
      expect(await auditDetails(client)).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  test('A5: a parent account linked to a record under 18 is offered nothing, and its switch is retired; linked to an adult, it keeps its switch', async () => {
    const client = await freshDatabase('emailaddr_a5');
    activeClient = client;
    try {
      await setEmailAlertSwitch({ ...subject('parent'), switchedOn: true }, NOW);
      await client.query('update pilot.accounts set athlete_id = $2 where account_id = $1', [PARENT_ID, KID_ATHLETE]);
      await expect(readEmailAlertSwitch(subject('parent'), NOW)).resolves.toEqual({ offered: false });
      expect(await addressRow(client, PARENT_ID)).toMatchObject({ user_type: 'parent', switched_on: false });
      await expect(setEmailAlertSwitch({ ...subject('parent'), switchedOn: true }, NOW)).rejects.toMatchObject({ status: 403 });
      expect((await auditDetails(client)).map((row) => row.reason ?? null)).toEqual([null, 'no_longer_offered']);

      // The same record, corrected to 18 or over: offered again, from off.
      await client.query(`update pilot.athletes set dob = '2000-01-01' where athlete_id = $1`, [KID_ATHLETE]);
      await expect(readEmailAlertSwitch(subject('parent'), NOW)).resolves.toEqual({ offered: true, user_type: 'parent', switched_on: false });
      await expect(setEmailAlertSwitch({ ...subject('parent'), switchedOn: true }, NOW)).resolves.toMatchObject({ switched_on: true });
      // Deleted: retired again.
      await client.query('update pilot.athletes set deleted_at = now() where athlete_id = $1', [KID_ATHLETE]);
      await expect(readEmailAlertSwitch(subject('parent'), NOW)).resolves.toEqual({ offered: false });
      expect(await addressRow(client, PARENT_ID)).toMatchObject({ switched_on: false });
    } finally {
      await client.end();
    }
  });

  test('A5: the record a parent account is linked to is read, never locked: a save does not wait on it, and the next read after a correction retires', async () => {
    const client = await freshDatabase('emailaddr_a5_race');
    activeClient = client;
    activePool = new Pool({ connectionString: connectionStringFor('emailaddr_a5_race'), max: 4 });
    const office = await activePool.connect();
    try {
      await client.query(`update pilot.athletes set dob = '2000-01-01' where athlete_id = $1`, [KID_ATHLETE]);
      await client.query('update pilot.accounts set athlete_id = $2 where account_id = $1', [PARENT_ID, KID_ATHLETE]);
      // The office's correction is held open: the save does not wait for it.
      await office.query('BEGIN');
      await office.query(`update pilot.athletes set dob = '2013-02-02' where athlete_id = $1`, [KID_ATHLETE]);
      await expect(setEmailAlertSwitch({ ...subject('parent'), switchedOn: true }, NOW)).resolves.toMatchObject({ switched_on: true });
      await office.query('COMMIT');
      // The sender re-reads the record before every send; the next own read retires.
      await expect(readEmailAlertSwitch(subject('parent'), NOW)).resolves.toEqual({ offered: false });
      expect(await addressRow(client, PARENT_ID)).toMatchObject({ switched_on: false });
      expect((await auditDetails(client)).map((row) => row.reason ?? null)).toEqual([null, 'no_longer_offered']);
    } finally {
      office.release(true);
      await client.end();
    }
  });

  test('A5: a parent account retired by the guardian trigger (account first, then the children FOR UPDATE) while its save waits: no deadlock, 403', async () => {
    const client = await freshDatabase('emailaddr_a5_guardian');
    activeClient = client;
    activePool = new Pool({ connectionString: connectionStringFor('emailaddr_a5_guardian'), max: 4 });
    try {
      await client.query(`update pilot.athletes set dob = '2000-01-01' where athlete_id = $1`, [KID_ATHLETE]);
      await client.query('update pilot.accounts set athlete_id = $2 where account_id = $1', [PARENT_ID, KID_ATHLETE]);
      await client.query(
        `insert into pilot.parents (organization_id, parent_id, account_id, full_name) values ($1, 'par-emailaddr', $2, 'Email Parent')`,
        [ORG_ID, PARENT_ID],
      );
      await client.query(
        `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
         values ($1, 'par-emailaddr', $2, 'parent')`,
        [ORG_ID, KID_ATHLETE],
      );
      // The office holds the guardian's account; the save waits on it; then the
      // office deletes it, and pilot.cascade_parent_deletion locks the child FOR UPDATE.
      const [result] = await whileHeld(client,
        [['update pilot.accounts set updated_at = now() where account_id = $1', [PARENT_ID]]],
        [() => setEmailAlertSwitch({ ...subject('parent'), switchedOn: true }, NOW)],
        { after: [['update pilot.accounts set deleted_at = now() where account_id = $1', [PARENT_ID]]] });
      expect(result).toMatchObject({ status: 'rejected', reason: { status: 403 } });
      expect(await switchCount(client)).toBe(0);
      const kid = await client.query('select deleted_at is not null as deleted from pilot.athletes where athlete_id = $1', [KID_ATHLETE]);
      expect(kid.rows[0].deleted).toBe(true);
    } finally {
      await client.end();
    }
  });

  test('A5: a link made while a save waits on the account is read under that lock: linked to a record under 18, 403 and nothing written', async () => {
    const client = await freshDatabase('emailaddr_a5_link_race');
    activeClient = client;
    activePool = new Pool({ connectionString: connectionStringFor('emailaddr_a5_link_race'), max: 4 });
    try {
      const [result] = await whileHeld(client,
        [['update pilot.accounts set athlete_id = $2 where account_id = $1', [PARENT_ID, KID_ATHLETE]]],
        [() => setEmailAlertSwitch({ ...subject('parent'), switchedOn: true }, NOW)]);
      expect(result).toMatchObject({ status: 'rejected', reason: { status: 403 } });
      expect(await switchCount(client)).toBe(0);
      expect(await auditDetails(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  // The 'deleted' case is the one that catches a read not pinned to this gym:
  // with the gym clause dropped two rows come back, and the 'under 18' case can
  // still pass when this gym's row happens to come first (reviewer B's re-read).
  test.each([
    ['under 18', `update pilot.athletes set dob = '2012-01-01' where organization_id = '${ORG_ID}' and athlete_id = '${ADULT_ATHLETE}'`],
    ['deleted', `update pilot.athletes set deleted_at = now() where organization_id = '${ORG_ID}' and athlete_id = '${ADULT_ATHLETE}'`],
  ] as const)('A5: a parent account linked to a record that is %s in this gym, with another gym\'s adult under the same athlete id: offered nothing, and a save is 403 with nothing written', async (_label, change) => {
    const client = await freshDatabase('emailaddr_a5_other_gym');
    activeClient = client;
    try {
      await client.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [OTHER_ORG_ID]);
      await client.query(
        `insert into pilot.athletes
           (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
            emergency_contact, active_flag, coach_id, created_at, updated_at)
         values ($1, $2, 'Other Athlete', '1990-01-01', '100', 'active', 'contact', true, $3, now(), now())`,
        [OTHER_ORG_ID, ADULT_ATHLETE, COACH_ID],
      );
      // One login per record in a gym: the athlete's own login lets go of it first.
      await client.query('update pilot.accounts set athlete_id = null where account_id = $1', [ADULT_ID]);
      await client.query('update pilot.accounts set athlete_id = $2 where account_id = $1', [PARENT_ID, ADULT_ATHLETE]);
      await client.query(change);
      await expect(readEmailAlertSwitch(subject('parent'), NOW)).resolves.toEqual({ offered: false });
      await expect(setEmailAlertSwitch({ ...subject('parent'), switchedOn: true }, NOW)).rejects.toMatchObject({ status: 403 });
      expect(await switchCount(client)).toBe(0);
      expect(await auditDetails(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test.each([
    ['under 18', `update pilot.athletes set dob = '2012-01-01' where organization_id = '${ORG_ID}' and athlete_id = '${ADULT_ATHLETE}'`],
    ['deleted', `update pilot.athletes set deleted_at = now() where organization_id = '${ORG_ID}' and athlete_id = '${ADULT_ATHLETE}'`],
  ] as const)('the linked record is this gym\'s: with this gym\'s %s and another gym\'s adult under the same athlete id, POST is 403', async (_label, change) => {
    const client = await freshDatabase('emailaddr_other_gym');
    activeClient = client;
    try {
      await client.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [OTHER_ORG_ID]);
      await client.query(
        `insert into pilot.athletes
           (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
            emergency_contact, active_flag, coach_id, created_at, updated_at)
         values ($1, $2, 'Other Athlete', '1990-01-01', '100', 'active', 'contact', true, $3, now(), now())`,
        [OTHER_ORG_ID, ADULT_ATHLETE, COACH_ID],
      );
      await client.query(change);
      const mail = mailbox();
      await expect(readEmailAlertSwitch(subject('adult'), NOW)).resolves.toEqual({ offered: false });
      await expect(post('adult', newAddress('elsewhere'), mail.send)).rejects.toMatchObject({ status: 403 });
      expect(mail.send).not.toHaveBeenCalled();
      expect(await switchCount(client)).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('default 13: a send that fails voids its own code and answers 503, with no address or code in the error or a log line', async () => {
    const client = await freshDatabase('emailaddr_send_fails');
    activeClient = client;
    try {
      const address = newAddress('fails');
      let code = '';
      const failing: EmailAlertCodeMailer = async (message) => {
        code = message.code;
        throw new MailSendError('GRAPH_SEND_FAILED', 503);
      };
      let failure: unknown;
      const logs = await consoleDuring(async () => {
        failure = await post('adult', address, failing).catch((error: unknown) => error);
      });
      expect(code).toMatch(/^\d{6}$/);
      const answer = await answerOf(failure);
      expect(answer).toMatchObject({ status: 503, body: { code: 'EMAIL_ALERT_CODE_NOT_SENT' } });
      for (const said of [JSON.stringify(answer), logs, (failure as Error).message, JSON.stringify(failure)]) {
        expect(said).not.toContain(address);
        expect(said).not.toContain(code);
      }
      expect(logs).toContain('GRAPH_SEND_FAILED');
      expect(await addressRow(client)).toMatchObject({ pending_address: null, pending_code_hash: null, pending_code_expires_at: null });
      expect(await auditDetails(client)).toEqual([
        { user_type: 'adult_athlete', address_action: 'code_sent' },
        { user_type: 'adult_athlete', address_action: 'code_voided', reason: 'send_failed' },
      ]);
      await expect(readEmailAlertSwitch(subject('adult'), NOW)).resolves.toMatchObject({ code_pending: false });
      await expectNoneHeld(client, [code]);
    } finally {
      await client.end();
    }
  });

  test('default 13: a send that fails after a newer code went out never voids the newer one', async () => {
    const client = await freshDatabase('emailaddr_send_fails_late');
    activeClient = client;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let failFirst: (error: Error) => void = () => {};
      let firstCalled = false;
      const slow: EmailAlertCodeMailer = () => new Promise<void>((_resolve, reject) => {
        firstCalled = true;
        failFirst = reject;
      });
      const first = post('adult', newAddress('slow'), slow);
      for (let i = 0; i < 200 && !firstCalled; i += 1) await sleep(5);
      expect(firstCalled).toBe(true);

      const newer = mailbox();
      const newerAddress = newAddress('newer');
      await post('adult', newerAddress, newer.send, at(61_000));
      failFirst(new MailSendError('GRAPH_SEND_FAILED', 503));
      await expect(first).rejects.toMatchObject({ status: 503 });

      expect(await addressRow(client)).toMatchObject({
        pending_address: newerAddress,
        pending_code_hash: emailAlertCodeHash(ORG_ID, ADULT_ID, newerAddress, newer.sent[0].code),
      });
      await expect(put('adult', newer.sent[0].code, at(62_000))).resolves.toMatchObject({ address_confirmed: true });
      expect((await auditDetails(client)).map((row) => row.address_action)).toEqual(['code_sent', 'code_sent', 'confirmed']);
    } finally {
      await client.end();
    }
  });

  test('default 4(a) after the person\'s own limits: an athlete held by their own minute spends nothing of another address\'s budget', async () => {
    const client = await freshDatabase('emailaddr_victim');
    activeClient = client;
    try {
      const victim = newAddress('victim');
      const mail = mailbox();
      await post('adult2', newAddress('own'), mail.send);
      for (let i = 1; i <= 6; i += 1) await limitAnswer(post('adult2', victim, mail.send, at(i * 1_000)));
      expect(getRateLimitStatus(`email_alert_code_address:${hashToken(victim)}`).count).toBe(0);
      await expect(post('adult', victim, mail.send)).resolves.toMatchObject({ code_pending: true });
      expect(mail.sent.map((sent) => sent.to)).toEqual([expect.stringMatching(/^own\./), victim]);
    } finally {
      await client.end();
    }
  });

  test('default 4(c) is per person: one adult at five a day leaves another adult in the same gym free', async () => {
    const client = await freshDatabase('emailaddr_day_each');
    activeClient = client;
    try {
      const mail = mailbox();
      for (let i = 0; i < 5; i += 1) await post('adult', newAddress('day'), mail.send, at(i * 61_000));
      await limitAnswer(post('adult', newAddress('day'), mail.send, at(5 * 61_000)));
      await expect(post('adult2', newAddress('day'), mail.send, at(5 * 61_000))).resolves.toMatchObject({ code_pending: true });
      expect(mail.sent).toHaveLength(6);
    } finally {
      await client.end();
    }
  });

  test('L1: a minor\'s answer does not depend on what they typed; an adult\'s malformed address or code gets the worded 400', async () => {
    const client = await freshDatabase('emailaddr_minor_words');
    activeClient = client;
    try {
      const mail = mailbox();
      const plain = await answerOf(await post('minor', newAddress('minor'), mail.send).catch((error: unknown) => error));
      expect(plain.status).toBe(403);
      for (const attempt of [
        post('minor', 'not an address', mail.send),
        post('minor', '', mail.send),
        put('minor', '12'),
        put('minor', 'abcdef'),
      ]) {
        expect(await answerOf(await attempt.catch((error: unknown) => error))).toEqual(plain);
      }
      await expect(post('adult', 'not an address', mail.send)).rejects.toMatchObject({ status: 400, message: 'Enter a valid email address' });
      await expect(put('adult', '12')).rejects.toMatchObject({ status: 400, message: 'Enter the six-digit code from the email' });
      expect(mail.send).not.toHaveBeenCalled();
      expect(await switchCount(client)).toBe(0);
      expect(await auditDetails(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('L1 at the route (Codex on EM-2b-2): a minor, an athlete whose record is deleted, and a session naming no record or another record get the one plain 403 for any query or body; an adult gets the route\'s 400s', async () => {
    const client = await freshDatabase('emailaddr_route_minor');
    activeClient = client;
    try {
      const url = 'http://localhost/api/pilot/email-alerts/me/address';
      const call = async (method: 'POST' | 'PUT', sent: unknown, query = '') => {
        const request = new NextRequest(`${url}${query}`, { method, body: typeof sent === 'string' ? sent : JSON.stringify(sent) });
        const response = await (method === 'POST' ? addressRoute.POST(request) : addressRoute.PUT(request));
        return { bodyUsed: request.bodyUsed, status: response.status, headers: [...response.headers.entries()], body: await response.json() };
      };
      const shapes = (field: 'address' | 'code', good: string, bad: string): Array<[unknown, string]> => [
        [{ [field]: good }, ''],
        [{ [field]: good }, '?account_id=acct-other'],
        ['', ''],
        ['{"', ''],
        [[{ [field]: good }], ''],
        [{}, ''],
        [{ [field]: good, account_id: 'acct-other' }, ''],
        [{ [field]: 12345 }, ''],
        [{ [field]: bad }, ''],
      ];
      const requests: Array<['POST' | 'PUT', unknown, string]> = [
        ...shapes('address', newAddress('route'), 'not an address').map(([sent, query]) => ['POST', sent, query] as ['POST', unknown, string]),
        ...shapes('code', '012345', '12').map(([sent, query]) => ['PUT', sent, query] as ['PUT', unknown, string]),
      ];
      const people = [
        { accountId: MINOR_ID, athleteId: MINOR_ATHLETE },
        { accountId: GONE_ID, athleteId: GONE_ATHLETE },
        { accountId: ADULT_ID, athleteId: null },
        { accountId: MINOR_ID, athleteId: ADULT_ATHLETE },
      ];
      let plain: Awaited<ReturnType<typeof call>> | null = null;
      for (const person of people) {
        (requirePrincipal as jest.Mock).mockResolvedValue({
          ...person, role: 'athlete', organizationId: ORG_ID, sessionToken: 'session', authProvider: 'ppbf_local',
        });
        for (const [method, sent, query] of requests) {
          const answer = await call(method, sent, query);
          plain ??= answer;
          expect({ person, method, sent, query, answer }).toEqual({ person, method, sent, query, answer: plain });
        }
      }
      expect(plain).toMatchObject({ bodyUsed: false, status: 403, body: { error: 'Forbidden: email alerts are not offered to this account' } });

      // An adult: the adult check passes, and the route's own 400s say nothing about email.
      (requirePrincipal as jest.Mock).mockResolvedValue({
        accountId: ADULT_ID, athleteId: ADULT_ATHLETE, role: 'athlete', organizationId: ORG_ID, sessionToken: 'session', authProvider: 'ppbf_local',
      });
      for (const [method, sent, query] of requests.filter(([, sent, query]) => query || typeof sent === 'string' || Array.isArray(sent)
        || Object.keys(sent as object).length !== 1 || typeof Object.values(sent as object)[0] !== 'string')) {
        const answer = await call(method, sent, query);
        expect({ method, sent, query, status: answer.status }).toEqual({ method, sent, query, status: 400 });
        expect(answer.body.error).not.toMatch(/email|address|code|six/i);
      }
      await expect(call('POST', { address: 'not an address' })).resolves.toMatchObject({ status: 400, body: { error: 'Enter a valid email address' } });
      await expect(call('PUT', { code: '12' })).resolves.toMatchObject({ status: 400, body: { error: 'Enter the six-digit code from the email' } });
      expect(await switchCount(client)).toBe(0);
      expect(await auditDetails(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('the age check before sending cannot be answered: 503, nothing sent, and the code voided, so no code stands pending without its email', async () => {
    const client = await freshDatabase('emailaddr_age_check_fails');
    activeClient = client;
    try {
      const mail = mailbox();
      // The read behind the check fails (the athletes table briefly gone), then comes back.
      afterWrite = async () => {
        await client.query('alter table pilot.athletes rename to athletes_away');
      };
      const answer = post('adult', newAddress('blip'), mail.send);
      await expect(answer).rejects.toMatchObject({ status: 503 });
      await client.query('alter table pilot.athletes_away rename to athletes');
      expect(mail.send).not.toHaveBeenCalled();
      expect(await addressRow(client)).toMatchObject({ pending_address: null, pending_code_hash: null });
      expect(await auditDetails(client)).toEqual([
        { user_type: 'adult_athlete', address_action: 'code_sent' },
        { user_type: 'adult_athlete', address_action: 'code_voided', reason: 'send_failed' },
      ]);
    } finally {
      await client.end();
    }
  });

  test('a date of birth corrected after the code is stored but before it is sent: 403, nothing sent, the code voided', async () => {
    const client = await freshDatabase('emailaddr_dob_before_send');
    activeClient = client;
    try {
      const mail = mailbox();
      afterWrite = async () => {
        await client.query(`update pilot.athletes set dob = '2012-01-01' where athlete_id = $1`, [ADULT_ATHLETE]);
      };
      await expect(post('adult', newAddress('late'), mail.send)).rejects.toMatchObject({ status: 403 });
      expect(afterWrite).toBeNull();
      expect(mail.send).not.toHaveBeenCalled();
      expect(await addressRow(client)).toMatchObject({ pending_address: null, pending_code_hash: null, confirmed_address: null });
      expect(await auditDetails(client)).toEqual([
        { user_type: 'adult_athlete', address_action: 'code_sent' },
        { user_type: 'adult_athlete', address_action: 'code_voided', reason: 'no_longer_offered' },
      ]);
    } finally {
      await client.end();
    }
  });

  describe('races, with the office or another request holding rows on a second connection', () => {
    test('two POSTs at once for one person, to two addresses: one email, one 429', async () => {
      const client = await freshDatabase('emailaddr_two_posts');
      activeClient = client;
      activePool = new Pool({ connectionString: connectionStringFor('emailaddr_two_posts'), max: 6 });
      try {
        const mail = mailbox();
        const results = await whileHeld(client,
          [['update pilot.accounts set updated_at = now() where account_id = $1', [ADULT_ID]]],
          [() => post('adult', newAddress('race'), mail.send), () => post('adult', newAddress('race'), mail.send)]);
        expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
        const refused = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
        await limitAnswer(Promise.reject(refused.reason));
        expect(mail.sent).toHaveLength(1);
        expect(await addressRow(client)).toMatchObject({ pending_address: mail.sent[0].to });
        expect((await auditDetails(client)).map((row) => row.address_action)).toEqual(['code_sent']);
      } finally {
        await client.end();
      }
    });

    test('two PUTs at once with the right code: one confirms, the other finds no code', async () => {
      const client = await freshDatabase('emailaddr_two_puts');
      activeClient = client;
      activePool = new Pool({ connectionString: connectionStringFor('emailaddr_two_puts'), max: 6 });
      try {
        const mail = mailbox();
        await post('adult', newAddress('twice'), mail.send);
        const { code } = mail.sent[0];
        const results = await whileHeld(client,
          [['update pilot.accounts set updated_at = now() where account_id = $1', [ADULT_ID]]],
          [() => put('adult', code), () => put('adult', code)]);
        expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
        expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { status: 409, code: 'EMAIL_ALERT_CODE_EXPIRED' } });
        expect((await auditDetails(client)).map((row) => row.address_action)).toEqual(['code_sent', 'confirmed']);
      } finally {
        await client.end();
      }
    });

    test('eight wrong PUTs at once never pass the cap: five tries counted, the rest refused as used', async () => {
      const client = await freshDatabase('emailaddr_wrong_puts');
      activeClient = client;
      activePool = new Pool({ connectionString: connectionStringFor('emailaddr_wrong_puts'), max: 12 });
      try {
        const mail = mailbox();
        await post('adult', newAddress('burst'), mail.send);
        const { code } = mail.sent[0];
        const results = await whileHeld(client,
          [['update pilot.accounts set updated_at = now() where account_id = $1', [ADULT_ID]]],
          Array.from({ length: 8 }, () => () => put('adult', wrong(code))));
        const codes = results.map((result) => (result.status === 'rejected' ? (result.reason as { code?: string }).code : 'passed'));
        expect(codes.filter((c) => c === 'EMAIL_ALERT_CODE_WRONG')).toHaveLength(5);
        expect(codes.filter((c) => c === 'EMAIL_ALERT_CODE_TRIES_USED')).toHaveLength(3);
        expect((await addressRow(client)).pending_code_attempts).toBe(5);
        await expect(put('adult', code)).rejects.toMatchObject({ code: 'EMAIL_ALERT_CODE_TRIES_USED' });
      } finally {
        await client.end();
      }
    });

    test('a PUT with the right code while the office corrects the date of birth to under 18: 403, and the typed address cleared', async () => {
      const client = await freshDatabase('emailaddr_put_dob');
      activeClient = client;
      activePool = new Pool({ connectionString: connectionStringFor('emailaddr_put_dob'), max: 4 });
      try {
        const mail = mailbox();
        await post('adult', newAddress('dob'), mail.send);
        const [result] = await whileHeld(client,
          [[`update pilot.athletes set dob = '2012-01-01' where athlete_id = $1`, [ADULT_ATHLETE]]],
          [() => put('adult', mail.sent[0].code)]);
        expect(result).toMatchObject({ status: 'rejected', reason: { status: 403 } });
        expect(await addressRow(client)).toMatchObject({ pending_address: null, confirmed_address: null });
        expect((await auditDetails(client)).map((row) => row.reason ?? row.address_action)).toEqual(['code_sent', 'no_longer_offered']);
      } finally {
        await client.end();
      }
    });

    test('a PUT with the right code while the login is switched off: 403, nothing confirmed, the typed address kept (paused, T-3 A)', async () => {
      const client = await freshDatabase('emailaddr_put_login');
      activeClient = client;
      activePool = new Pool({ connectionString: connectionStringFor('emailaddr_put_login'), max: 4 });
      try {
        const mail = mailbox();
        await post('adult', newAddress('login'), mail.send);
        const before = await addressRow(client);
        const [result] = await whileHeld(client,
          [['update pilot.accounts set active_flag = false where account_id = $1', [ADULT_ID]]],
          [() => put('adult', mail.sent[0].code)]);
        expect(result).toMatchObject({ status: 'rejected', reason: { status: 403 } });
        expect(await addressRow(client)).toEqual(before);
        expect(await auditDetails(client)).toHaveLength(1);
      } finally {
        await client.end();
      }
    });

    test('a PUT with the right code while the office deletes the athlete in deleteAthleteRecord\'s order: no deadlock, 403, the address cleared', async () => {
      const client = await freshDatabase('emailaddr_put_delete');
      activeClient = client;
      activePool = new Pool({ connectionString: connectionStringFor('emailaddr_put_delete'), max: 4 });
      try {
        const mail = mailbox();
        await post('adult', newAddress('delete'), mail.send);
        const [result] = await whileHeld(client,
          [
            ['select 1 from pilot.athletes where athlete_id = $1 and organization_id = $2 for update', [ADULT_ATHLETE, ORG_ID]],
            ['update pilot.athletes set deleted_at = now() where athlete_id = $1 and organization_id = $2', [ADULT_ATHLETE, ORG_ID]],
          ],
          [() => put('adult', mail.sent[0].code)],
          { after: [[`update pilot.accounts set deleted_at = now(), active_flag = false where account_id = $1`, [ADULT_ID]]] });
        expect(result).toMatchObject({ status: 'rejected', reason: { status: 403 } });
        expect(await addressRow(client)).toMatchObject({ pending_address: null, confirmed_address: null });
        expect((await auditDetails(client)).map((row) => row.reason ?? row.address_action)).toEqual(['code_sent', 'no_longer_offered']);
      } finally {
        await client.end();
      }
    });

    test('default 13 under the lock: a failed send\'s void waits on a newer code held on the row, then leaves it', async () => {
      const client = await freshDatabase('emailaddr_void_lock');
      activeClient = client;
      activePool = new Pool({ connectionString: connectionStringFor('emailaddr_void_lock'), max: 4 });
      jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        let failFirst: (error: Error) => void = () => {};
        let firstCalled = false;
        const first = post('adult', newAddress('slow'), () => new Promise<void>((_resolve, reject) => {
          firstCalled = true;
          failFirst = reject;
        }));
        for (let i = 0; i < 400 && !firstCalled; i += 1) await sleep(5);
        expect(firstCalled).toBe(true);
        const newer = newAddress('newer');
        const newerHash = emailAlertCodeHash(ORG_ID, ADULT_ID, newer, '000000');
        const [result] = await whileHeld(client,
          [['update pilot.email_alert_switches set pending_address = $2, pending_code_hash = $3 where account_id = $1', [ADULT_ID, newer, newerHash]]],
          [() => {
            failFirst(new MailSendError('GRAPH_SEND_FAILED', 503));
            return first;
          }]);
        expect(result).toMatchObject({ status: 'rejected', reason: { status: 503 } });
        expect(await addressRow(client)).toMatchObject({ pending_address: newer, pending_code_hash: newerHash });
        expect((await auditDetails(client)).map((row) => row.address_action)).toEqual(['code_sent']);
      } finally {
        await client.end();
      }
    });
  });
});
