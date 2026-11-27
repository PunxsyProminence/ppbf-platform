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
  PPBF_WEB_PUSH_VAPID_PRIVATE_KEY: vapid.getPrivateKey().toString('base64url'),
  PPBF_WEB_PUSH_SUBJECT: 'https://www.example.test/contact',
};
const NO_KEYS = {};

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

  test('an athlete under 18 cannot turn push on, and a row left from before is removed at their next read', async () => {
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

  test('one person per browser: someone else turning it on in this gym or another gym takes it over', async () => {
    const client = await freshDatabase('pushstore_move');
    const b = browser();
    await savePushBrowser(parent, b, ENV);
    await savePushBrowser(coach, b, ENV);
    expect((await rows(client)).map((row) => row.account_id)).toEqual([COACH]);
    // Across gyms (reviewer B on #2231): a shared family phone stops getting the first person's pop-ups.
    await savePushBrowser(otherParentElsewhere, b, ENV);
    expect((await rows(client)).map((row) => [row.organization_id, row.account_id])).toEqual([[OTHER_ORG, OTHER_PARENT]]);
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
    ['create', COACH, { push_browser: 'on', user_type: 'staff', moved_from_another_person: 1, oldest_dropped: 0 }],
    ['update', COACH, { push_browser: 'off' }],
  ]);
  const text = JSON.stringify(audit);
  for (const secret of [b.endpoint, 'audited', b.keys.p256dh, b.keys.auth]) expect(text).not.toContain(secret);
});
