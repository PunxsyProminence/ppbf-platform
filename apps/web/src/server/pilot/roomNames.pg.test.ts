// Real PostgreSQL-backed test for roomNames.ts on top of the
// organization-room-names migration (lane W4-9, RN-1b; OW27-11, OW27-40 A;
// Overwatch's Q-A to Q-C on #2212). './db' is mocked to route into the
// embedded server (the stoppedComingPolicy.pg.test.ts pattern; withTransaction
// runs a real BEGIN/COMMIT/ROLLBACK), so the module's real SQL and audit.ts's
// run against real rows.
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

import { Client } from 'pg';

let activeClient: Client | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows[0] ?? null;
  }),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const client = activeClient;
    await client.query('BEGIN');
    try {
      const result = await fn({ query: (text: string, values: unknown[]) => client.query(text, values) });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }),
}));

import { readRoomNames, setRoomName } from './roomNames';
import { normalizeRoomName, ROOM_NAME_DEFAULTS, ROOM_NAME_KEYS } from '@/src/shared/roomNames';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-room-names-module-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-roomnamesmod';
const OTHER_ORG_ID = 'org-roomnamesmod-elsewhere';
const ADMIN_ID = 'acct-roomnamesmod-admin';
const OTHER_ADMIN_ID = 'acct-roomnamesmod-other-admin';

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

/** The full schema (which carries the migration through the workflow's `all` list), two gyms, a gym admin in each. */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, login_email)
     values ($1, 'organization_admin', $2, 'microsoft', null, null),
            ($3, 'organization_admin', $4, 'microsoft', null, null)
     on conflict do nothing`,
    [ADMIN_ID, ORG_ID, OTHER_ADMIN_ID, OTHER_ORG_ID],
  );
  return client;
}

async function storedRows(client: Client, org = ORG_ID) {
  const { rows } = await client.query(
    'select name_key, display_name, set_by_account_id from pilot.organization_room_names where organization_id = $1 order by name_key',
    [org],
  );
  return rows;
}

async function auditRows(client: Client) {
  const { rows } = await client.query(
    `select event_type, actor_account_id, actor_role, organization_id, entity_id, details
       from pilot.audit_events where entity_type = 'organization_room_name' order by created_at, audit_id`,
  );
  return rows;
}

function set(nameKey: unknown, displayName: unknown, { org = ORG_ID, actor = ADMIN_ID, role = 'organization_admin' } = {}) {
  return setRoomName({
    organizationId: org,
    actorAccountId: actor,
    actorRole: role as never,
    nameKey,
    displayName,
  });
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

afterEach(() => {
  activeClient = null;
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

describe('roomNames.ts against the real table', () => {
  test('a gym with no rows reads every name on the list at its default', async () => {
    activeClient = await freshDatabase('roomnamesmod_defaults');
    try {
      const names = await readRoomNames(ORG_ID);
      expect(Object.keys(names)).toEqual([...ROOM_NAME_KEYS]);
      for (const key of ROOM_NAME_KEYS) expect(names[key]).toEqual({ name: ROOM_NAME_DEFAULTS[key], is_default: true });
    } finally {
      await activeClient.end();
    }
  });

  test('the gym admin renames, renames again and puts the default back; each change is one row and one audit entry', async () => {
    activeClient = await freshDatabase('roomnamesmod_set');
    const client = activeClient;
    try {
      const first = await set('place:front-desk', '  Lobby  ');
      expect(first['place:front-desk']).toEqual({ name: 'Lobby', is_default: false });
      expect(first['place:floor']).toEqual({ name: 'The Floor', is_default: true });
      expect(await storedRows(client)).toEqual([{ name_key: 'place:front-desk', display_name: 'Lobby', set_by_account_id: ADMIN_ID }]);

      await set('place:front-desk', 'Reception');
      expect((await readRoomNames(ORG_ID))['place:front-desk']).toEqual({ name: 'Reception', is_default: false });

      // "Use the default": null, and a blank name, both delete the row.
      const reset = await set('place:front-desk', null);
      expect(reset['place:front-desk']).toEqual({ name: 'Front Desk', is_default: true });
      expect(await storedRows(client)).toEqual([]);
      await set('card:my-corner', 'My Space');
      await set('card:my-corner', '   ');
      expect(await storedRows(client)).toEqual([]);

      const audit = await auditRows(client);
      expect(audit.map((row) => row.details)).toEqual([
        { name_key: 'place:front-desk', display_name: 'Lobby', previous_display_name: null },
        { name_key: 'place:front-desk', display_name: 'Reception', previous_display_name: 'Lobby' },
        { name_key: 'place:front-desk', display_name: null, previous_display_name: 'Reception' },
        { name_key: 'card:my-corner', display_name: 'My Space', previous_display_name: null },
        { name_key: 'card:my-corner', display_name: null, previous_display_name: 'My Space' },
      ]);
      for (const row of audit) {
        expect(row).toMatchObject({ event_type: 'update', actor_account_id: ADMIN_ID, actor_role: 'organization_admin', organization_id: ORG_ID });
      }
      expect(audit[0].entity_id).toBe(`${ORG_ID}:place:front-desk`);
    } finally {
      await client.end();
    }
  });

  test('stores the NFC spelling of a name', async () => {
    activeClient = await freshDatabase('roomnamesmod_nfc');
    try {
      await set('place:locker', 'Cafe\u0301 Corner');
      expect((await storedRows(activeClient))[0].display_name).toBe('Caf\u00e9 Corner');
    } finally {
      await activeClient.end();
    }
  });

  // Every other role is pinned in roomNames.test.ts, before any database is touched.
  test('a coach cannot rename, and nothing is written or audited', async () => {
    activeClient = await freshDatabase('roomnamesmod_role_coach');
    try {
      await expect(set('place:front-desk', 'Lobby', { role: 'coach' })).rejects.toMatchObject({ status: 403 });
      expect(await storedRows(activeClient)).toEqual([]);
      expect(await auditRows(activeClient)).toEqual([]);
    } finally {
      await activeClient.end();
    }
  });

  test('a key off the list, or a name that breaks Q-C, is refused with 400 and nothing is written', async () => {
    activeClient = await freshDatabase('roomnamesmod_refused');
    try {
      for (const key of ['place:lobby', 'room:gym', 'card:your-corner', 'door:/profile', 7, null]) {
        await expect(set(key, 'Lobby')).rejects.toMatchObject({ status: 400 });
      }
      for (const name of ['x'.repeat(41), 'Front\nDesk', 'A\u0085B', 'A\u2028B', 42, ['Lobby']]) {
        await expect(set('place:front-desk', name)).rejects.toMatchObject({ status: 400 });
      }
      expect(await storedRows(activeClient)).toEqual([]);
      expect(await auditRows(activeClient)).toEqual([]);
    } finally {
      await activeClient.end();
    }
  });

  test('Q-B A: a name another room in the same list shows is refused (409), case and spaces aside; another list may share it', async () => {
    activeClient = await freshDatabase('roomnamesmod_duplicates');
    const client = activeClient;
    try {
      // Another Room Map room's default.
      await expect(set('place:front-desk', '  the FLOOR ')).rejects.toMatchObject({ status: 409, code: 'ROOM_NAME_TAKEN' });
      // Another card's default.
      await expect(set('card:my-corner', 'coach entry')).rejects.toMatchObject({ status: 409 });
      // Q-G A: the two forms of one card may share a name.
      await set('card:coach-entry', 'Your entry');
      await set('card:who-they-train-with', 'Training partners');
      await set('card:who-you-train-with', 'Training partners');
      // The 7 rooms are a list of their own: "The Floor" is free there, as "Clinic" is in both lists by default.
      await set('room:office', 'The Floor');
      expect(ROOM_NAME_DEFAULTS['room:clinic']).toBe(ROOM_NAME_DEFAULTS['place:clinic']);

      // Free once its holder is renamed; and the holder may not then take the default back.
      await set('place:floor', 'The Ring');
      await set('place:front-desk', 'The Floor');
      await expect(set('place:floor', null)).rejects.toMatchObject({ status: 409 });
      // A name the gym gave, not only a default, is held too.
      await expect(set('place:locker', 'the ring')).rejects.toMatchObject({ status: 409 });
      // Setting a room to its own current name is not a clash.
      await set('place:front-desk', 'The Floor');

      expect(await storedRows(client)).toEqual([
        { name_key: 'card:coach-entry', display_name: 'Your entry', set_by_account_id: ADMIN_ID },
        { name_key: 'card:who-they-train-with', display_name: 'Training partners', set_by_account_id: ADMIN_ID },
        { name_key: 'card:who-you-train-with', display_name: 'Training partners', set_by_account_id: ADMIN_ID },
        { name_key: 'place:floor', display_name: 'The Ring', set_by_account_id: ADMIN_ID },
        { name_key: 'place:front-desk', display_name: 'The Floor', set_by_account_id: ADMIN_ID },
        { name_key: 'room:office', display_name: 'The Floor', set_by_account_id: ADMIN_ID },
      ]);
      // Refused changes left no audit entry: seven accepted changes, seven entries.
      expect(await auditRows(client)).toHaveLength(7);
    } finally {
      await client.end();
    }
  });

  test('each gym has its own names: one gym\'s rename never shows in, or blocks, another', async () => {
    activeClient = await freshDatabase('roomnamesmod_gyms');
    try {
      await set('place:front-desk', 'Lobby');
      await set('place:floor', 'Lobby', { org: OTHER_ORG_ID, actor: OTHER_ADMIN_ID }).catch((error) => {
        throw new Error(`the other gym was blocked by this gym's name: ${String(error)}`);
      });
      expect((await readRoomNames(OTHER_ORG_ID))['place:front-desk']).toEqual({ name: 'Front Desk', is_default: true });
      expect((await readRoomNames(OTHER_ORG_ID))['place:floor']).toEqual({ name: 'Lobby', is_default: false });
      expect((await readRoomNames(ORG_ID))['place:floor']).toEqual({ name: 'The Floor', is_default: true });
    } finally {
      await activeClient.end();
    }
  });

  test('a stored row whose key has left the list is ignored by the read and by the duplicate rule', async () => {
    activeClient = await freshDatabase('roomnamesmod_stale');
    try {
      await activeClient.query(
        `insert into pilot.organization_room_names (organization_id, name_key, display_name) values ($1, 'place:old-gym', 'Lobby')`,
        [ORG_ID],
      );
      expect(Object.keys(await readRoomNames(ORG_ID))).not.toContain('place:old-gym');
      await expect(set('place:front-desk', 'Lobby')).resolves.toMatchObject({ 'place:front-desk': { name: 'Lobby', is_default: false } });
    } finally {
      await activeClient.end();
    }
  });

  test('the name rule and the table agree: every name normalizeRoomName keeps, the table takes; every name it refuses, the table refuses too', async () => {
    activeClient = await freshDatabase('roomnamesmod_parity');
    const client = activeClient;
    try {
      const samples = [
        'Lobby', 'x'.repeat(40), 'x'.repeat(41), '\u00e9'.repeat(40), '\u00e9'.repeat(41),
        '\ud83e\udd4a'.repeat(40), '\ud83e\udd4a'.repeat(41), 'Changing\u00a0Room',
        'Front\nDesk', 'Front\tDesk', 'A\u0007B', 'A\u007fB', 'A\u0085B', 'A\u009fB', 'A\u2028B', 'A\u2029B',
      ];
      let n = 0;
      for (const sample of samples) {
        const result = normalizeRoomName(sample);
        const key = ROOM_NAME_KEYS[n % ROOM_NAME_KEYS.length];
        n += 1;
        const insert = client.query(
          `insert into pilot.organization_room_names (organization_id, name_key, display_name) values ($1, $2, $3)
           on conflict (organization_id, name_key) do update set display_name = excluded.display_name`,
          [ORG_ID, key, sample],
        );
        if (result.ok) {
          expect(result.name).toBe(sample);
          await expect(insert).resolves.toBeDefined();
        } else {
          await expect(insert).rejects.toMatchObject({ code: '23514' });
        }
      }
      // An untrimmed name is never stored as typed: the module trims it, and the table refuses the raw form.
      for (const raw of [' Lobby', 'Lobby ', '\u00a0Lobby', 'Lobby\u3000', '\ufeffLobby', '\tLobby', 'Lobby\n']) {
        expect(normalizeRoomName(raw)).toEqual({ ok: true, name: 'Lobby' });
        await expect(client.query(
          `insert into pilot.organization_room_names (organization_id, name_key, display_name) values ($1, 'place:workshop', $2)`,
          [ORG_ID, raw],
        )).rejects.toMatchObject({ code: '23514' });
      }
    } finally {
      await client.end();
    }
  });

  test('two saves at once cannot both pass Q-B: the second waits on the gym row, then sees the first and is refused', async () => {
    activeClient = await freshDatabase('roomnamesmod_concurrent');
    const client = activeClient;
    const other = new Client({ connectionString: connectionStringFor('roomnamesmod_concurrent') });
    await other.connect();
    try {
      // Another admin's save, mid-transaction, holding the gym row as setRoomName does.
      await other.query('BEGIN');
      await other.query('select 1 from pilot.organizations where organization_id = $1 for no key update', [ORG_ID]);
      const pending = set('place:window', 'ring');
      // Give the second save time to reach the lock; it must wait there, not read past it.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await other.query(
        `insert into pilot.organization_room_names (organization_id, name_key, display_name, set_by_account_id)
         values ($1, 'place:locker', 'Ring', $2)`,
        [ORG_ID, ADMIN_ID],
      );
      await other.query('COMMIT');
      await expect(pending).rejects.toMatchObject({ status: 409 });
      expect(await storedRows(client)).toEqual([{ name_key: 'place:locker', display_name: 'Ring', set_by_account_id: ADMIN_ID }]);
    } finally {
      await other.query('ROLLBACK').catch(() => {});
      await other.end();
      await client.end();
    }
  });

  test('for every code point, the table refuses a name exactly when the name rule would trim or refuse it', async () => {
    activeClient = await freshDatabase('roomnamesmod_codepoints');
    const client = activeClient;
    try {
      // The CHECK as Postgres holds it, evaluated over every code point but NUL
      // and the surrogates, at the start, at the end and in the middle of a name.
      const { rows: [{ def }] } = await client.query(
        `select pg_get_constraintdef(oid) as def from pg_constraint
          where conname = 'pilot_org_room_names_display_name_check'`,
      );
      const expression = String(def).replace(/^CHECK \(/, '').replace(/\)$/, '');
      const refusedBy = async (build: string) => {
        const { rows: [{ cps }] } = await client.query(
          `select coalesce(array_agg(c.cp order by c.cp), '{}') as cps
             from (select g as cp from generate_series(1, 1114111) g where g < 55296 or g > 57343) c,
                  lateral (select ${build} as display_name) v
            where not (${expression})`,
        );
        return (cps as number[]).map(Number);
      };
      const ruleRefuses = (wrap: (ch: string) => string) => {
        const out: number[] = [];
        for (let cp = 1; cp <= 0x10ffff; cp += 1) {
          if (cp >= 0xd800 && cp <= 0xdfff) continue;
          const raw = wrap(String.fromCodePoint(cp));
          const result = normalizeRoomName(raw);
          // Refused, or stored only after trimming: either way the raw form must not reach the table.
          if (!result.ok || result.name !== raw.normalize('NFC')) out.push(cp);
        }
        return out;
      };
      expect(await refusedBy(`chr(c.cp) || 'x'`)).toEqual(ruleRefuses((ch) => `${ch}x`));
      expect(await refusedBy(`'x' || chr(c.cp)`)).toEqual(ruleRefuses((ch) => `x${ch}`));
      expect(await refusedBy(`'x' || chr(c.cp) || 'x'`)).toEqual(ruleRefuses((ch) => `x${ch}x`));
    } finally {
      await client.end();
    }
  });
});
