// Real PostgreSQL-backed test for the organization-room-names migration (lane
// W4-9, RN-1a; OW27-11 and OW27-40 A: a gym renames its rooms and a few card
// headings; Overwatch's answer Q-C on #2212: 1 to 40 characters, trimmed, no
// line breaks or control characters). The runner is driven through its real
// entrypoint, so its readiness check runs against a real Postgres here.
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

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-room-names-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_organization_room_names_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-organization-room-names-migration.mjs',
);
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-roomnames';
const OTHER_ORG_ID = 'org-roomnames-elsewhere';
const ADMIN_ID = 'acct-roomnames-admin';
const T = 'pilot.organization_room_names';

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

/**
 * The full schema, two gyms and a gym admin in the first. `runRunner: false`
 * leaves the table exactly as the full schema (the workflow's `all` list)
 * built it, so a test can see what that list alone produces.
 */
async function freshDatabase(name: string, { preMigration = false, runRunner = true } = {}): Promise<Client> {
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
     values ($1, 'organization_admin', $2, 'microsoft', null, null)
     on conflict do nothing`,
    [ADMIN_ID, ORG_ID],
  );

  if (preMigration) {
    await client.query(`drop table if exists ${T} cascade`);
  } else if (runRunner) {
    // Idempotent: a no-op once the workflow's `all` list carries it.
    await applyMigrationTransaction(client, migrationSql);
  }
  return client;
}

function insertName(client: Client, key: string, name: string | null, org = ORG_ID) {
  return client.query(
    `insert into ${T} (organization_id, name_key, display_name, set_by_account_id) values ($1, $2, $3, $4)`,
    [org, key, name, org === ORG_ID ? ADMIN_ID : null],
  );
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

  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (client: Client, sql: string) => Promise<void>;
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

describe('organization room names migration', () => {
  test('the full schema (the workflow\'s `all` list) carries the table on its own, and it passes readiness', async () => {
    const client = await freshDatabase('roomnames_all', { runRunner: false });
    try {
      const { rows } = await client.query(`select to_regclass('${T}') is not null as present`);
      expect(rows[0].present).toBe(true);
      await expect(applyMigrationTransaction(client, 'select 1')).resolves.toBeUndefined();
    } finally {
      await client.end();
    }
  });

  test('creates the table from nothing, passes the runner readiness check, and a re-apply keeps the rows', async () => {
    const client = await freshDatabase('roomnames_fresh', { preMigration: true });
    try {
      const before = await client.query(`select to_regclass('${T}') as t`);
      expect(before.rows[0].t).toBeNull();

      await applyMigrationTransaction(client, migrationSql);
      // No row is written by the migration: every gym starts on the defaults.
      expect((await client.query(`select count(*)::int as n from ${T}`)).rows[0].n).toBe(0);
      await insertName(client, 'place:front-desk', 'Lobby');
      await applyMigrationTransaction(client, migrationSql);

      const { rows } = await client.query(`select organization_id, name_key, display_name from ${T}`);
      expect(rows).toEqual([{ organization_id: ORG_ID, name_key: 'place:front-desk', display_name: 'Lobby' }]);
    } finally {
      await client.end();
    }
  });

  test('a refused readiness check rolls back everything the run did', async () => {
    const client = await freshDatabase('roomnames_rollback');
    try {
      await client.query(
        `alter table ${T}
           drop constraint pilot_org_room_names_display_name_check,
           add constraint pilot_org_room_names_display_name_check check (char_length(display_name) between 1 and 60)`,
      );
      await expect(applyMigrationTransaction(client, 'create table pilot.zz_room_names_probe (x integer)'))
        .rejects.toThrow('ORGANIZATION_ROOM_NAMES_TABLE_NOT_READY: display_name_check_ready');
      const { rows } = await client.query(`select to_regclass('pilot.zz_room_names_probe') is null as gone`);
      expect(rows[0].gone).toBe(true);
    } finally {
      await client.end();
    }
  });

  // Each piece of the readiness check, refused on its own and named in the error.
  const ORG_FK = 'organization_room_names_organization_id_fkey';
  const SETTER_FK = 'organization_room_names_set_by_account_id_fkey';
  const TRIM_CLASS = String.raw` \t\n\v\f\r   -     　﻿`;
  // The shipped display-name CHECK, with its length and its control-character
  // clause as parameters, so a drift case changes one thing only.
  const displayCheck = (maxLength: number, { controls = true } = {}) =>
    `char_length(display_name) between 1 and ${maxLength}
       and display_name !~ '^[${TRIM_CLASS}]'
       and display_name !~ '[${TRIM_CLASS}]$'`
    + (controls ? String.raw` and display_name !~ '[\u0001-\u001f\u007f-\u009f  ]'` : '');
  test.each([
    ['key_check_ready', 'a key CHECK that lets capitals in',
      `alter table ${T} drop constraint pilot_org_room_names_key_check,
         add constraint pilot_org_room_names_key_check check (name_key ~ '^(place|room|card):[a-zA-Z]+(-[a-zA-Z]+)*$')`],
    ['key_check_ready', 'the key CHECK not validated',
      `alter table ${T} drop constraint pilot_org_room_names_key_check,
         add constraint pilot_org_room_names_key_check check (name_key ~ '^(place|room|card):[a-z]+(-[a-z]+)*$') not valid`],
    ['display_name_check_ready', 'a display-name CHECK allowing 60 characters',
      `alter table ${T} drop constraint pilot_org_room_names_display_name_check,
         add constraint pilot_org_room_names_display_name_check check (${displayCheck(60)})`],
    ['display_name_check_ready', 'a display-name CHECK that lets control characters in',
      `alter table ${T} drop constraint pilot_org_room_names_display_name_check,
         add constraint pilot_org_room_names_display_name_check check (${displayCheck(40, { controls: false })})`],
    ['display_name_check_ready', 'a display-name CHECK that trims only the ASCII space',
      `alter table ${T} drop constraint pilot_org_room_names_display_name_check,
         add constraint pilot_org_room_names_display_name_check check (
           display_name = btrim(display_name) and char_length(display_name) between 1 and 40
           and display_name !~ '[[:cntrl:]]')`],
    ['display_name_check_ready', 'the display-name CHECK not validated',
      `alter table ${T} drop constraint pilot_org_room_names_display_name_check,
         add constraint pilot_org_room_names_display_name_check check (${displayCheck(40)}) not valid`],
    ['table_kind_ready', 'the table unlogged', `alter table ${T} set unlogged`],
    ['check_count_ready', 'a third CHECK', `alter table ${T} add constraint zz_extra_check check (display_name <> 'x')`],
    ['columns_ready', 'an extra column', `alter table ${T} add column note text`],
    ['organization_id_ready', 'organization_id with a default', `alter table ${T} alter column organization_id set default 'org-x'`],
    ['name_key_ready', 'name_key a varchar', `alter table ${T} alter column name_key type varchar(80)`],
    ['name_key_ready', 'name_key with a default', `alter table ${T} alter column name_key set default 'place:floor'`],
    ['display_name_ready', 'display_name nullable', `alter table ${T} alter column display_name drop not null`],
    ['display_name_ready', 'display_name with a default', `alter table ${T} alter column display_name set default 'Room'`],
    ['set_by_account_id_ready', 'set_by_account_id not null', `alter table ${T} alter column set_by_account_id set not null`],
    ['set_by_account_id_ready', 'set_by_account_id a varchar', `alter table ${T} alter column set_by_account_id type varchar(200)`],
    ['set_at_ready', 'set_at nullable', `alter table ${T} alter column set_at drop not null`],
    ['set_at_ready', 'set_at with no default', `alter table ${T} alter column set_at drop default`],
    ['set_at_ready', 'set_at as text', `alter table ${T} alter column set_at type text using set_at::text`],
    ['primary_key_ready', 'no primary key', `alter table ${T} drop constraint organization_room_names_pkey cascade`],
    ['primary_key_ready', 'the primary key in the other order',
      `alter table ${T} drop constraint organization_room_names_pkey,
         add constraint organization_room_names_pkey primary key (name_key, organization_id)`],
    ['primary_key_ready', 'the primary key on organization_id alone',
      `alter table ${T} drop constraint organization_room_names_pkey,
         add constraint organization_room_names_pkey primary key (organization_id)`],
    ['primary_key_ready', 'the primary key deferrable',
      `alter table ${T} drop constraint organization_room_names_pkey,
         add constraint organization_room_names_pkey primary key (organization_id, name_key) deferrable`],
    ['no_other_unique_ready', 'an extra unique constraint',
      `alter table ${T} add constraint zz_unique_name unique (organization_id, display_name)`],
    ['no_other_unique_ready', 'a unique index', `create unique index zz_unique_name_index on ${T} (organization_id, display_name)`],
    ['foreign_key_count_ready', 'a third foreign key',
      `alter table ${T} add constraint zz_org_again foreign key (organization_id)
         references pilot.organizations(organization_id) on delete restrict`],
    ['organization_fk_ready', 'the gym foreign key cascading on update',
      `alter table ${T} drop constraint ${ORG_FK},
         add constraint ${ORG_FK} foreign key (organization_id)
           references pilot.organizations(organization_id) on delete cascade on update cascade`],
    ['organization_fk_ready', 'the gym foreign key deferrable',
      `alter table ${T} drop constraint ${ORG_FK},
         add constraint ${ORG_FK} foreign key (organization_id)
           references pilot.organizations(organization_id) on delete cascade deferrable`],
    ['organization_fk_ready', 'the gym foreign key with no action on delete',
      `alter table ${T} drop constraint ${ORG_FK},
         add constraint ${ORG_FK} foreign key (organization_id)
           references pilot.organizations(organization_id)`],
    ['organization_fk_ready', 'the gym foreign key pointing at pilot.accounts',
      `alter table ${T} drop constraint ${ORG_FK},
         add constraint ${ORG_FK} foreign key (organization_id)
           references pilot.accounts(account_id) on delete cascade`],
    ['organization_fk_ready', 'the gym foreign key on name_key',
      `alter table ${T} drop constraint ${ORG_FK},
         add constraint ${ORG_FK} foreign key (name_key)
           references pilot.organizations(organization_id) on delete cascade`],
    ['organization_fk_ready', 'the gym foreign key not validated',
      `alter table ${T} drop constraint ${ORG_FK},
         add constraint ${ORG_FK} foreign key (organization_id)
           references pilot.organizations(organization_id) on delete cascade not valid`],
    ['set_by_fk_ready', 'the setter foreign key cascading on update',
      `alter table ${T} drop constraint ${SETTER_FK},
         add constraint ${SETTER_FK} foreign key (set_by_account_id)
           references pilot.accounts(account_id) on delete set null on update cascade`],
    ['set_by_fk_ready', 'the setter foreign key cascading on delete',
      `alter table ${T} drop constraint ${SETTER_FK},
         add constraint ${SETTER_FK} foreign key (set_by_account_id)
           references pilot.accounts(account_id) on delete cascade`],
    ['set_by_fk_ready', 'the setter foreign key deferrable',
      `alter table ${T} drop constraint ${SETTER_FK},
         add constraint ${SETTER_FK} foreign key (set_by_account_id)
           references pilot.accounts(account_id) on delete set null deferrable`],
    ['set_by_fk_ready', 'the setter foreign key pointing at pilot.organizations',
      `alter table ${T} drop constraint ${SETTER_FK},
         add constraint ${SETTER_FK} foreign key (set_by_account_id)
           references pilot.organizations(organization_id) on delete set null`],
    ['set_by_fk_ready', 'the setter foreign key not validated',
      `alter table ${T} drop constraint ${SETTER_FK},
         add constraint ${SETTER_FK} foreign key (set_by_account_id)
           references pilot.accounts(account_id) on delete set null not valid`],
  ])('readiness refuses %s: %s', async (piece, _label, alteration) => {
    const client = await freshDatabase(`roomnames_r${Math.random().toString(36).slice(2, 10)}`);
    try {
      await client.query(alteration);
      const refusal = applyMigrationTransaction(client, 'select 1');
      await expect(refusal).rejects.toThrow('ORGANIZATION_ROOM_NAMES_TABLE_NOT_READY');
      await expect(refusal).rejects.toThrow(piece);
    } finally {
      await client.end();
    }
  });

  test('the database refuses a name that is blank, untrimmed, over 40 characters or carries a control character or line break, and takes 1 to 40', async () => {
    const client = await freshDatabase('roomnames_names');
    try {
      const refused = [
        '', ' ', 'Lobby ', ' Lobby', 'x'.repeat(41),
        // Untrimmed by JavaScript's trim() set, not only the ASCII space.
        ' Lobby', 'Lobby ', 'Lobby　', '﻿Lobby', '\tLobby', 'Lobby\n',
        // Control characters and line breaks anywhere: C0, DEL, C1, U+2028, U+2029.
        'Front\nDesk', 'Front\tDesk', 'Front\rDesk', 'Lobby\u0007x', 'Front\u000bDesk', 'Front\u007fDesk',
        'Front\u0085Desk', 'Front\u009fDesk', 'Front Desk', 'Front Desk',
      ];
      for (const name of refused) {
        await expect(insertName(client, 'place:front-desk', name)).rejects.toMatchObject({ code: '23514' });
      }
      await expect(insertName(client, 'place:front-desk', null)).rejects.toMatchObject({ code: '23502' });

      // Counted in characters, not bytes: 40 accented letters fit.
      const taken: Array<[string, string]> = [
        ['place:front-desk', 'L'],
        ['place:family-room', 'x'.repeat(40)],
        ['place:coach-office', 'Coach\'s Corner'],
        ['place:window', 'é'.repeat(40)],
        ['card:who-they-train-with', 'Their training partners'],
        // Inside a name, a space of any kind is the gym's to choose.
        ['place:locker', 'Changing Room'],
      ];
      for (const [key, name] of taken) {
        await insertName(client, key, name);
      }
      const { rows } = await client.query(`select name_key, display_name from ${T} order by name_key`);
      expect(rows).toEqual(
        [...taken].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name_key, display_name]) => ({ name_key, display_name })),
      );
    } finally {
      await client.end();
    }
  });

  test('the database refuses a key that is not place:, room: or card: and lower-case words joined by hyphens', async () => {
    const client = await freshDatabase('roomnames_keys_shape');
    try {
      const refused = [
        'lobby', 'place:', 'place:Front-desk', 'place:front_desk', 'place:-front', 'place:front-',
        'card:who--they', 'Place:front-desk', 'door:/profile', 'place:front desk', 'place:front-desk ',
        // Both anchors: nothing before the prefix, nothing after the last word.
        'xplace:front-desk', ' place:front-desk', 'place:front-desk\n',
      ];
      for (const key of refused) {
        await expect(insertName(client, key, 'Lobby')).rejects.toMatchObject({ code: '23514' });
      }
      for (const key of ['place:front-desk', 'room:office', 'card:your-profile', 'card:who-they-train-with']) {
        await insertName(client, key, 'A name');
      }
      expect((await client.query(`select count(*)::int as n from ${T}`)).rows[0].n).toBe(4);
    } finally {
      await client.end();
    }
  });

  test('one row per gym per name; another gym may use the same key; a gym that does not exist is refused; a removed admin leaves the name with no setter; a removed gym takes its rows', async () => {
    const client = await freshDatabase('roomnames_rows');
    try {
      await insertName(client, 'place:front-desk', 'Lobby');
      await expect(insertName(client, 'place:front-desk', 'Entrance')).rejects.toMatchObject({ code: '23505' });
      await insertName(client, 'place:floor', 'The Ring');
      await insertName(client, 'place:front-desk', 'Reception', OTHER_ORG_ID);
      await expect(insertName(client, 'place:front-desk', 'Lobby', 'org-nowhere')).rejects.toMatchObject({ code: '23503' });

      await client.query('delete from pilot.accounts where account_id = $1', [ADMIN_ID]);
      const mine = await client.query(
        `select name_key, display_name, set_by_account_id from ${T} where organization_id = $1 order by name_key`,
        [ORG_ID],
      );
      expect(mine.rows).toEqual([
        { name_key: 'place:floor', display_name: 'The Ring', set_by_account_id: null },
        { name_key: 'place:front-desk', display_name: 'Lobby', set_by_account_id: null },
      ]);

      await client.query('delete from pilot.organizations where organization_id = $1', [OTHER_ORG_ID]);
      const after = await client.query(`select distinct organization_id from ${T}`);
      expect(after.rows).toEqual([{ organization_id: ORG_ID }]);
    } finally {
      await client.end();
    }
  });

  test('the runner gives up after its lock timeout instead of queueing writes behind a busy accounts table', async () => {
    const client = await freshDatabase('roomnames_lock', { preMigration: true });
    const holder = new Client({ connectionString: connectionStringFor('roomnames_lock') });
    await holder.connect();
    try {
      // A write in progress on pilot.accounts: the table's foreign key would wait for it.
      await holder.query('BEGIN');
      await holder.query('lock table pilot.accounts in row exclusive mode');
      const started = Date.now();
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toMatchObject({ code: '55P03' });
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(9_000);
      expect(waited).toBeLessThan(30_000);
      const { rows } = await client.query(`select to_regclass('${T}') is null as absent`);
      expect(rows[0].absent).toBe(true);
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      await holder.end();
      await client.end();
    }
  });
});
