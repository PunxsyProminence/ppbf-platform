// Real PostgreSQL-backed test for the web push store (lane W5-WP, WP-1b;
// OW27-18 A, OW27-17 B; plan, answers and GO on #2228). The store's own
// functions run against an embedded Postgres built from every migration in
// infra/azure, the web-push migration (WP-1a) included.
//
// It NEVER connects to production or staging: an embedded server on a free
// local port, in a throwaway data directory.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client, Pool } from 'pg';

let activeClient: Client | null = null;
// Set only by the race test: each withTransaction then takes its own
// connection, so two saves really run at once.
let activePool: Pool | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    const target = activePool ?? activeClient;
    if (!target) throw new Error('test bug: no active embedded client');
    return (await target.query(text, params)).rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    const target = activePool ?? activeClient;
    if (!target) throw new Error('test bug: no active embedded client');
    return (await target.query(text, params)).rows[0] ?? null;
  }),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    const pooled = activePool ? await activePool.connect() : null;
    const client = pooled ?? activeClient;
    if (!client) throw new Error('test bug: no active embedded client');
    try {
      await client.query('BEGIN');
      try {
        const result = await fn({ query: (text: string, values: unknown[]) => client.query(text, values) });
        await client.query('COMMIT');
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

import type { PilotRole } from './contracts';
import {
  isPushOnHere,
  PUSH_BROWSERS_PER_PERSON,
  readPushOffer,
  removePushBrowser,
  savePushBrowser,
  type PushSubject,
} from './pushSubscriptions';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-push-store-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-pushstore';
const OTHER_ORG = 'org-pushstore-2';
const COACH = 'acct-pushstore-coach';
const PARENT = 'acct-pushstore-parent';
const OTHER_PARENT = 'acct-pushstore-parent-2';
const ADULT = 'acct-pushstore-adult';
const MINOR = 'acct-pushstore-minor';
const VOLUNTEER = 'acct-pushstore-volunteer';

const vapid = createECDH('prime256v1');
vapid.generateKeys();
const ENV = {
  PPBF_WEB_PUSH_VAPID_PUBLIC_KEY: vapid.getPublicKey().toString('base64url'),
  // Padded to 32 bytes, as web-push's own generateVAPIDKeys pads it (its src/vapid-helper.js).
  PPBF_WEB_PUSH_VAPID_PRIVATE_KEY: Buffer.from(vapid.getPrivateKey().toString('hex').padStart(64, '0'), 'hex').toString('base64url'),
  PPBF_WEB_PUSH_SUBJECT: 'https://www.example.test/contact',
};
const NO_KEYS = {};

/** Waits until `count` sessions of this database are waiting on a lock. */
async function waitForLockWaiters(client: Client, count: number): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    const { rows: waiting } = await client.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (waiting[0].n >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`test bug: ${count} lock waiters never appeared`);
}

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

function subject(accountId: string, role: PilotRole, athleteId: string | null = null, organizationId = ORG): PushSubject {
  return { organizationId, accountId, role, athleteId };
}
const coach = subject(COACH, 'coach');
const parent = subject(PARENT, 'parent');
const otherParentElsewhere = subject(OTHER_PARENT, 'parent', null, OTHER_ORG);
const adult = subject(ADULT, 'athlete', 'ath-pushstore-adult');
const minor = subject(MINOR, 'athlete', 'ath-pushstore-minor');

function browser(endpoint = 'https://push.example.test/send/one') {
  return {
    endpoint,
    keys: { p256dh: createECDH('prime256v1').generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
}

/** The full schema, two gyms, people of each kind; every account a member of the first gym, one parent of the second only. */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  for (const org of [ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [org],
    );
  }
  for (const [accountId, role, org] of [
    [COACH, 'coach', ORG], [PARENT, 'parent', ORG], [VOLUNTEER, 'volunteer', ORG], [OTHER_PARENT, 'parent', OTHER_ORG],
  ]) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, login_email)
       values ($1, $2, $3, 'magic_link', null, null)`,
      [accountId, role, org],
    );
  }
  for (const [accountId, athleteId, dob] of [[ADULT, 'ath-pushstore-adult', '2000-03-14'], [MINOR, 'ath-pushstore-minor', '2012-06-01']]) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Push Athlete', $3::date, '100', 'active', 'contact', true, $4, now(), now())`,
      [ORG, athleteId, dob, COACH],
    );
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, login_email)
       values ($1, 'athlete', $2, 'ppbf_local', $3, null)`,
      [accountId, ORG, athleteId],
    );
  }
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     select account_id, organization_id, role, true from pilot.accounts`,
  );
  activeClient = client;
  return client;
}

async function rows(client: Client) {
  const { rows: found } = await client.query<{ organization_id: string; account_id: string; endpoint: string; user_type: string }>(
    'select organization_id, account_id, endpoint, user_type from pilot.push_subscriptions order by organization_id, account_id, endpoint',
  );
  return found;
}

beforeAll(async () => {
  PG_PORT = await findFreePort();
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  await activePool?.end();
  activePool = null;
  await activeClient?.end();
  activeClient = null;
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

describe('who is offered push (OW27-18 A: the people the email switch is offered to)', () => {
  test.each([
    ['a coach', coach],
    ['a parent', parent],
    ['an athlete 18 or over', adult],
  ])('%s is offered push, with the public key, once the keys are set', async (_label, who) => {
    await freshDatabase('pushstore_offer');
    expect(await readPushOffer(who, ENV)).toEqual({ offered: true, public_key: ENV.PPBF_WEB_PUSH_VAPID_PUBLIC_KEY });
  });

  test('an athlete under 18 is not offered push', async () => {
    await freshDatabase('pushstore_minor');
    expect(await readPushOffer(minor, ENV)).toEqual({ offered: false });
  });

  test('with the keys unset nobody is offered push, and nobody can turn it on (fail closed)', async () => {
    await freshDatabase('pushstore_nokeys');
    expect(await readPushOffer(parent, NO_KEYS)).toEqual({ offered: false });
    await expect(savePushBrowser(parent, browser(), NO_KEYS)).rejects.toMatchObject({ status: 403 });
    await expect(isPushOnHere(parent, { endpoint: browser().endpoint }, NO_KEYS)).rejects.toMatchObject({ status: 403 });
  });

  test('an athlete under 18 cannot turn push on; a row left from before survives a check and is removed at their next offer read', async () => {
    const client = await freshDatabase('pushstore_minor_save');
    await expect(savePushBrowser(minor, browser(), ENV)).rejects.toMatchObject({ status: 403 });
    expect(await rows(client)).toEqual([]);
    // A row saved while they were counted as 18 or over (a date of birth corrected since).
    const b = browser();
    await client.query(
      `insert into pilot.push_subscriptions (organization_id, account_id, user_type, endpoint, key_p256dh, key_auth)
       values ($1, $2, 'adult_athlete', $3, $4, $5)`,
      [ORG, MINOR, b.endpoint, b.keys.p256dh, b.keys.auth],
    );
    // A check (POST) is read only (reviewers E and F on #2236): refused, nothing removed, nothing audited.
    await expect(isPushOnHere(minor, { endpoint: b.endpoint }, ENV)).rejects.toMatchObject({ status: 403 });
    expect(await rows(client)).toHaveLength(1);
    expect((await client.query(`select 1 from pilot.audit_events where entity_type = 'push_browser'`)).rowCount).toBe(0);
    expect(await readPushOffer(minor, ENV)).toEqual({ offered: false });
    expect(await rows(client)).toEqual([]);
    const audit = await client.query(`select details from pilot.audit_events where entity_type = 'push_browser'`);
    expect(audit.rows.map((row) => row.details)).toEqual([{ push_browsers: 'all_off', reason: 'not_offered', count: 1 }]);
  });
});

describe('turning push on and off for a browser', () => {
  test('a save stores the browser under the caller\'s user type, padding dropped; a check says on; a removal turns it off', async () => {
    const client = await freshDatabase('pushstore_save');
    const b = browser();
    expect(await savePushBrowser(parent, { endpoint: b.endpoint, keys: { p256dh: `${b.keys.p256dh}=`, auth: `${b.keys.auth}==` } }, ENV))
      .toEqual({ on: true });
    const { rows: stored } = await client.query('select user_type, key_p256dh, key_auth, device_key_hash from pilot.push_subscriptions');
    expect(stored).toEqual([{ user_type: 'parent', key_p256dh: b.keys.p256dh, key_auth: b.keys.auth, device_key_hash: null }]);
    expect(await isPushOnHere(parent, { endpoint: b.endpoint }, ENV)).toEqual({ on: true });
    expect(await isPushOnHere(parent, { endpoint: 'https://push.example.test/send/other' }, ENV)).toEqual({ on: false });
    expect(await removePushBrowser(parent, { endpoint: b.endpoint })).toEqual({ on: false });
    expect(await rows(client)).toEqual([]);
  });

  test('saving the same browser again keeps one row', async () => {
    const client = await freshDatabase('pushstore_again');
    const b = browser();
    await savePushBrowser(parent, b, ENV);
    await savePushBrowser(parent, b, ENV);
    expect(await rows(client)).toHaveLength(1);
  });

  test('a browser saved under another user type (the person\'s role changed) is not on here; saving it again puts it under the new one (Codex on #2236)', async () => {
    const client = await freshDatabase('pushstore_user_type');
    const b = browser('https://push.example.test/send/role');
    await savePushBrowser(coach, b, ENV);
    // Saved while this account was a parent, say: the sender skips it for a coach.
    await client.query(`update pilot.push_subscriptions set user_type = 'parent' where account_id = $1`, [COACH]);
    expect(await isPushOnHere(coach, { endpoint: b.endpoint }, ENV)).toEqual({ on: false });
    await savePushBrowser(coach, b, ENV);
    expect(await isPushOnHere(coach, { endpoint: b.endpoint }, ENV)).toEqual({ on: true });
    expect((await rows(client)).map((row) => [row.account_id, row.user_type])).toEqual([[COACH, 'staff']]);
  });

  test('one person per browser: someone else turning it on in this gym or another gym takes it over', async () => {
    const client = await freshDatabase('pushstore_move');
    const b = browser();
    await savePushBrowser(parent, b, ENV);
    await savePushBrowser(coach, b, ENV);
    expect((await rows(client)).map((row) => row.account_id)).toEqual([COACH]);
    // Across gyms (reviewer B on #2231): a shared family phone stops getting the first person's pop-ups.
    await savePushBrowser(otherParentElsewhere, b, ENV);
    expect((await rows(client)).map((row) => [row.organization_id, row.account_id])).toEqual([[OTHER_ORG, OTHER_PARENT]]);
    // The gym that lost the row has its own audit row, naming nobody from the other gym (reviewers E and F on #2236).
    const { rows: lost } = await client.query(
      `select organization_id, actor_account_id, actor_role, entity_id, details from pilot.audit_events
        where entity_type = 'push_browser' and actor_account_id is null order by created_at, audit_id`,
    );
    expect(lost).toEqual([
      { organization_id: ORG, actor_account_id: null, actor_role: null, entity_id: PARENT,
        details: { push_browser: 'off', reason: 'turned_on_by_another_person' } },
      { organization_id: ORG, actor_account_id: null, actor_role: null, entity_id: COACH,
        details: { push_browser: 'off', reason: 'turned_on_by_another_person' } },
    ]);
    expect(JSON.stringify(lost)).not.toContain(OTHER_PARENT);
  });

  test('one person in two gyms keeps the browser in each', async () => {
    const client = await freshDatabase('pushstore_two_gyms');
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, 'parent', true)`,
      [PARENT, OTHER_ORG],
    );
    const b = browser();
    await savePushBrowser(parent, b, ENV);
    await savePushBrowser({ ...parent, organizationId: OTHER_ORG }, b, ENV);
    expect((await rows(client)).map((row) => row.organization_id)).toEqual([ORG, OTHER_ORG]);
  });

  test(`at most ${PUSH_BROWSERS_PER_PERSON} browsers per person per gym: one more drops the one saved longest ago`, async () => {
    const client = await freshDatabase('pushstore_cap');
    for (let index = 0; index <= PUSH_BROWSERS_PER_PERSON; index += 1) {
      await savePushBrowser(parent, browser(`https://push.example.test/send/${String(index).padStart(2, '0')}`), ENV);
    }
    const kept = (await rows(client)).map((row) => row.endpoint);
    expect(kept).toHaveLength(PUSH_BROWSERS_PER_PERSON);
    expect(kept).not.toContain('https://push.example.test/send/00');
  });

  test('a removal touches only the caller\'s own row in this gym', async () => {
    const client = await freshDatabase('pushstore_remove_own');
    const mine = browser('https://push.example.test/send/mine');
    const theirs = browser('https://push.example.test/send/theirs');
    await savePushBrowser(parent, mine, ENV);
    await savePushBrowser(coach, theirs, ENV);
    await removePushBrowser(parent, { endpoint: theirs.endpoint });
    expect((await rows(client)).map((row) => row.account_id).sort()).toEqual([COACH, PARENT]);
  });

  test('a save after the caller\'s membership of the gym is gone is refused like anyone not offered', async () => {
    const client = await freshDatabase('pushstore_no_member');
    await client.query('delete from pilot.organization_memberships where account_id = $1', [PARENT]);
    await expect(savePushBrowser(parent, browser(), ENV)).rejects.toMatchObject({ status: 403 });
    expect(await rows(client)).toEqual([]);
  });

  test('two first saves of one browser by two people, at once, leave exactly one row (the endpoint lock)', async () => {
    const client = await freshDatabase('pushstore_race');
    activePool = new Pool({ connectionString: connectionStringFor('pushstore_race'), max: 4 });
    const b = browser('https://push.example.test/send/race');
    await Promise.all([savePushBrowser(parent, b, ENV), savePushBrowser(otherParentElsewhere, b, ENV)]);
    expect(await rows(client)).toHaveLength(1);
  });
});

describe('a save decides again under its own locks (reviewers E and F on #2236)', () => {
  test('a date of birth corrected to under 18 while an adult athlete\'s save waits: refused, nothing written', async () => {
    const client = await freshDatabase('pushstore_dob_race');
    activePool = new Pool({ connectionString: connectionStringFor('pushstore_dob_race'), max: 4 });
    const b = browser('https://push.example.test/send/dob');
    const holder = new Client({ connectionString: connectionStringFor('pushstore_dob_race') });
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query(`select pg_advisory_xact_lock(hashtext('push_browser:' || $1))`, [b.endpoint]);
      // Past the first check (still 18 or over), now waiting on the endpoint lock.
      const save = savePushBrowser(adult, b, ENV).then(() => 'saved', (error: { status?: number }) => error.status);
      await waitForLockWaiters(client, 1);
      await client.query(`update pilot.athletes set dob = '2012-01-01' where athlete_id = 'ath-pushstore-adult'`);
      await holder.query('commit');
      expect(await save).toBe(403);
    } finally {
      await holder.end();
    }
    expect(await rows(client)).toEqual([]);
    expect((await client.query(`select 1 from pilot.audit_events where entity_type = 'push_browser'`)).rowCount).toBe(0);
  });

  test.each([
    ['the gym is suspended', `update pilot.organizations set status = 'suspended' where organization_id = '${ORG}'`],
    ['the person\'s sign-in to the gym is switched off', `update pilot.organization_memberships set active_flag = false where account_id = '${PARENT}'`],
    ['the login is switched off', `update pilot.accounts set active_flag = false where account_id = '${PARENT}'`],
    ['the membership\'s role has no push', `update pilot.organization_memberships set role = 'volunteer' where account_id = '${PARENT}'`],
    // Reviewer F, second pass: a role of another user type, not only a role with none.
    ['the membership\'s role is now of another user type', `update pilot.organization_memberships set role = 'coach' where account_id = '${PARENT}'`],
    // Reviewers E and F, second pass: active_flag can be set back to true while deleted_at stays (deletedAccountSignIn.ts).
    ['the login is deleted though still marked active', `update pilot.accounts set deleted_at = now(), active_flag = true where account_id = '${PARENT}'`],
  ])('a switch-on is refused when %s, and nothing is written', async (_label, change) => {
    const client = await freshDatabase('pushstore_under_lock');
    await client.query(change);
    await expect(savePushBrowser(parent, browser(), ENV)).rejects.toMatchObject({ status: 403 });
    expect(await rows(client)).toEqual([]);
  });

  test(`two saves of new browsers by one person at the cap, at once, still leave ${PUSH_BROWSERS_PER_PERSON}`, async () => {
    const client = await freshDatabase('pushstore_cap_race');
    for (let index = 0; index < PUSH_BROWSERS_PER_PERSON; index += 1) {
      await savePushBrowser(parent, browser(`https://push.example.test/send/${String(index).padStart(2, '0')}`), ENV);
    }
    activePool = new Pool({ connectionString: connectionStringFor('pushstore_cap_race'), max: 4 });
    const holder = new Client({ connectionString: connectionStringFor('pushstore_cap_race') });
    await holder.connect();
    try {
      // Both saves reach the oldest row together unless one person's saves queue on the account lock.
      await holder.query('begin');
      await holder.query(`select 1 from pilot.push_subscriptions where endpoint = 'https://push.example.test/send/00' for update`);
      const saves = Promise.all(['a', 'b'].map((tag) => savePushBrowser(parent, browser(`https://push.example.test/send/new-${tag}`), ENV)));
      await waitForLockWaiters(client, 2);
      await holder.query('commit');
      await saves;
    } finally {
      await holder.end();
    }
    expect(await rows(client)).toHaveLength(PUSH_BROWSERS_PER_PERSON);
  });

  test('a membership deleted while a save waits on its key is refused like anyone not offered (the 23503 catch)', async () => {
    const client = await freshDatabase('pushstore_fk_race');
    activePool = new Pool({ connectionString: connectionStringFor('pushstore_fk_race'), max: 4 });
    const holder = new Client({ connectionString: connectionStringFor('pushstore_fk_race') });
    await holder.connect();
    try {
      // A writer taking neither the account nor the gym row (none does today):
      // the save's checks still see the membership, and its insert waits on the key.
      await holder.query('begin');
      await holder.query('delete from pilot.organization_memberships where account_id = $1 and organization_id = $2', [PARENT, ORG]);
      const save = savePushBrowser(parent, browser(), ENV).then(() => 'saved', (error: { status?: number }) => error.status);
      await waitForLockWaiters(client, 1);
      await holder.query('commit');
      expect(await save).toBe(403);
    } finally {
      await holder.end();
    }
    expect(await rows(client)).toEqual([]);
  });

  test('two people at the cap, each taking the other\'s oldest browser at once: one is saved, the other gets 409 and nothing', async () => {
    const client = await freshDatabase('pushstore_swap');
    for (let index = 0; index < PUSH_BROWSERS_PER_PERSON; index += 1) {
      await savePushBrowser(parent, browser(`https://push.example.test/send/p-${String(index).padStart(2, '0')}`), ENV);
      await savePushBrowser(coach, browser(`https://push.example.test/send/c-${String(index).padStart(2, '0')}`), ENV);
    }
    activePool = new Pool({ connectionString: connectionStringFor('pushstore_swap'), max: 4 });
    const holder = new Client({ connectionString: connectionStringFor('pushstore_swap') });
    await holder.connect();
    let outcomes: unknown[];
    try {
      // Reviewer E's staging: both inserts wait on the membership keys, after each save has taken the other's row.
      await holder.query('begin');
      await holder.query('select 1 from pilot.organization_memberships where account_id = any($1) for update', [[PARENT, COACH]]);
      const saves = [
        savePushBrowser(parent, browser('https://push.example.test/send/c-00'), ENV),
        savePushBrowser(coach, browser('https://push.example.test/send/p-00'), ENV),
      ].map((save) => save.then(() => 'saved', (error: { status?: number }) => error.status));
      await waitForLockWaiters(client, 2);
      await holder.query('commit');
      outcomes = await Promise.all(saves);
    } finally {
      await holder.end();
    }
    expect([...outcomes].sort()).toEqual([409, 'saved'].sort());
    // The refused save wrote nothing: the saved person is at the cap, and the
    // refused one lost only the browser the saved one took.
    const { rows: counts } = await client.query<{ n: number }>(
      'select count(*)::int as n from pilot.push_subscriptions group by account_id order by 1',
    );
    expect(counts.map((row) => row.n)).toEqual([PUSH_BROWSERS_PER_PERSON - 1, PUSH_BROWSERS_PER_PERSON]);
    expect((await client.query(`select 1 from pilot.audit_events where entity_type = 'push_browser'
      and details->>'reason' = 'turned_on_by_another_person'`)).rowCount).toBe(1);
  });
});

describe('a removal of browsers decides again under the save\'s locks (Codex on #2236)', () => {
  test('a date of birth corrected to 18 or over while an offer read waits to remove the browsers: they stay', async () => {
    const client = await freshDatabase('pushstore_drop_race');
    activePool = new Pool({ connectionString: connectionStringFor('pushstore_drop_race'), max: 4 });
    const b = browser('https://push.example.test/send/drop');
    await savePushBrowser(adult, b, ENV);
    // A date of birth wrongly entered as under 18 since.
    await client.query(`update pilot.athletes set dob = '2012-01-01' where athlete_id = 'ath-pushstore-adult'`);
    const holder = new Client({ connectionString: connectionStringFor('pushstore_drop_race') });
    await holder.connect();
    try {
      await holder.query('begin');
      // The correction, made and not yet committed: it holds the athlete row.
      await holder.query(`update pilot.athletes set dob = '2000-03-14' where athlete_id = 'ath-pushstore-adult'`);
      // The offer read still sees under 18, and goes to remove the browsers: it waits on the athlete row.
      const offer = readPushOffer(adult, ENV);
      await waitForLockWaiters(client, 1);
      await holder.query('commit');
      expect(await offer).toEqual({ offered: false });
    } finally {
      await holder.end();
    }
    // Asked again under the lock, they are 18 or over: the browser stays, and nothing says it went.
    expect(await rows(client)).toEqual([{ organization_id: ORG, account_id: ADULT, endpoint: b.endpoint, user_type: 'adult_athlete' }]);
    const audit = await client.query(`select details from pilot.audit_events where entity_type = 'push_browser'`);
    expect(audit.rows.map((row) => row.details.push_browsers ?? row.details.push_browser)).toEqual(['on']);
    // Still under 18 under the lock: removed, as before.
    await client.query(`update pilot.athletes set dob = '2012-01-01' where athlete_id = 'ath-pushstore-adult'`);
    expect(await readPushOffer(adult, ENV)).toEqual({ offered: false });
    expect(await rows(client)).toEqual([]);
  });
});

test('no audit row carries an endpoint or a key; each save, move and removal is audited', async () => {
  const client = await freshDatabase('pushstore_audit');
  const b = browser('https://push.example.test/send/audited');
  await savePushBrowser(parent, b, ENV);
  await savePushBrowser(parent, b, ENV);
  await savePushBrowser(coach, b, ENV);
  await removePushBrowser(coach, { endpoint: b.endpoint });
  const { rows: audit } = await client.query(
    `select event_type, actor_account_id, details from pilot.audit_events where entity_type = 'push_browser' order by created_at, audit_id`,
  );
  expect(audit.map((row) => [row.event_type, row.actor_account_id, row.details])).toEqual([
    ['create', PARENT, { push_browser: 'on', user_type: 'parent', moved_from_another_person: 0, oldest_dropped: 0 }],
    ['update', PARENT, { push_browser: 'saved_again', user_type: 'parent', moved_from_another_person: 0, oldest_dropped: 0 }],
    ['update', null, { push_browser: 'off', reason: 'turned_on_by_another_person' }],
    ['create', COACH, { push_browser: 'on', user_type: 'staff', moved_from_another_person: 1, oldest_dropped: 0 }],
    ['update', COACH, { push_browser: 'off' }],
  ]);
  const text = JSON.stringify(audit);
  for (const secret of [b.endpoint, 'audited', b.keys.p256dh, b.keys.auth]) expect(text).not.toContain(secret);
});
