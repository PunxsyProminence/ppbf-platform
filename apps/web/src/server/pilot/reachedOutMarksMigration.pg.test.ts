// Real PostgreSQL-backed test for the athlete-reached-out-marks migration
// (lane W4-6, SC-3a-1; OW27-33 B; Overwatch W4-6 Q4 A: who and when only, one
// current mark per athlete, a take-back keeps the row). The runner's exported
// applyMigrationTransaction (what its run() calls) is driven here, so the real
// migration and the readiness check run against a real Postgres.
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

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-reached-out-marks-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_athlete_reached_out_marks_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-athlete-reached-out-marks-migration.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-reachedout';
const OTHER_ORG_ID = 'org-reachedout-elsewhere';
const COACH_ID = 'acct-reachedout-coach';
const LEAVER_ID = 'acct-reachedout-leaver';
const T = 'pilot.athlete_reached_out_marks';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let databaseCount = 0;
let templateName: Promise<string> | null = null;

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

async function createDatabase(name: string, template?: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(template ? `create database ${name} template ${template}` : `create database ${name}`);
  await admin.end();
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

/**
 * The full schema, two gyms, two coach accounts, and two athletes in the first
 * gym and one in the other. `runRunner: false` leaves the table as the full
 * schema (the workflow's `all` list) built it; `preMigration` drops it.
 */
async function freshDatabase({ preMigration = false, runRunner = true } = {}): Promise<{ client: Client; name: string }> {
  databaseCount += 1;
  const name = `reachedout_${databaseCount}`;
  const client = await createDatabase(name);
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  for (const account of [COACH_ID, LEAVER_ID]) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, login_email)
       values ($1, 'coach', $2, 'microsoft', null, null) on conflict do nothing`,
      [account, ORG_ID],
    );
  }
  for (const [org, athlete] of [[ORG_ID, 'ada'], [ORG_ID, 'ben'], [OTHER_ORG_ID, 'ada']]) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag,
          coach_id, created_at, updated_at)
       values ($1, $2, $2, '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())`,
      [org, athlete, COACH_ID],
    );
  }
  if (preMigration) {
    await client.query(`drop table if exists ${T} cascade`);
  } else if (runRunner) {
    await applyMigrationTransaction(client, migrationSql);
  }
  return { client, name };
}

/** A copy of one migrated database, for the readiness drifts (much faster than a fresh schema each). */
async function migratedCopy(): Promise<Client> {
  if (!templateName) {
    templateName = freshDatabase().then(async ({ client, name }) => {
      await client.end();
      return name;
    });
  }
  const template = await templateName;
  databaseCount += 1;
  return createDatabase(`reachedout_${databaseCount}`, template);
}

async function mark(
  client: Client,
  athleteId: string,
  { org = ORG_ID, role = 'coach', account = COACH_ID }: { org?: string; role?: string; account?: string | null } = {},
) {
  await client.query(
    `insert into ${T} (organization_id, mark_id, athlete_id, marked_by_account_id, marked_by_role)
     values ($1, gen_random_uuid(), $2, $3, $4)`,
    [org, athleteId, account, role],
  );
}

async function takeBack(client: Client, athleteId: string, account: string | null = COACH_ID, kind: string | null = 'taken_back') {
  await client.query(
    `update ${T} set cleared_at = clock_timestamp(), cleared_by_account_id = $3, cleared_kind = $4
      where organization_id = $1 and athlete_id = $2 and cleared_at is null`,
    [ORG_ID, athleteId, account, kind],
  );
}

/** What SC-3a-2 does when the athlete came back and stopped again: end the stale mark, then mark anew, in one transaction. */
async function replace(client: Client, athleteId: string, account: string = COACH_ID) {
  await client.query('BEGIN');
  try {
    await takeBack(client, athleteId, account, 'replaced');
    await mark(client, athleteId, { account });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

// Each foreign key, re-added under its own name with one thing wrong.
const FOREIGN_KEYS = [
  {
    piece: 'organization_fk_ready', name: 'athlete_reached_out_marks_organization_id_fkey',
    right: 'foreign key (organization_id) references pilot.organizations(organization_id)', onDelete: 'cascade', wrongDelete: 'no action',
    wrongColumns: 'foreign key (athlete_id) references pilot.organizations(organization_id)',
    wrongTable: 'foreign key (organization_id) references pilot.accounts(account_id)',
    wrongTarget: ['create unique index zz_target on pilot.organizations (organization_name)',
      'foreign key (organization_id) references pilot.organizations(organization_name)'],
  },
  {
    piece: 'athlete_fk_ready', name: 'pilot_athlete_reached_out_marks_athlete_fk',
    right: 'foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id)', onDelete: 'cascade', wrongDelete: 'no action',
    wrongColumns: 'foreign key (athlete_id, organization_id) references pilot.athletes(organization_id, athlete_id)',
    wrongTable: 'foreign key (organization_id, athlete_id) references pilot.zz_pairs(organization_id, athlete_id)',
    wrongTarget: ['create unique index zz_target on pilot.athletes (organization_id, full_name)',
      'foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, full_name)'],
  },
  {
    piece: 'marked_by_fk_ready', name: 'pilot_athlete_reached_out_marks_marked_by_fk',
    right: 'foreign key (marked_by_account_id) references pilot.accounts(account_id)', onDelete: 'set null', wrongDelete: 'cascade',
    wrongColumns: 'foreign key (cleared_by_account_id) references pilot.accounts(account_id)',
    wrongTable: 'foreign key (marked_by_account_id) references pilot.organizations(organization_id)',
    wrongTarget: ['create unique index zz_target on pilot.accounts (login_email)',
      'foreign key (marked_by_account_id) references pilot.accounts(login_email)'],
  },
  {
    piece: 'cleared_by_fk_ready', name: 'pilot_athlete_reached_out_marks_cleared_by_fk',
    right: 'foreign key (cleared_by_account_id) references pilot.accounts(account_id)', onDelete: 'set null', wrongDelete: 'cascade',
    wrongColumns: 'foreign key (marked_by_account_id) references pilot.accounts(account_id)',
    wrongTable: 'foreign key (cleared_by_account_id) references pilot.organizations(organization_id)',
    wrongTarget: ['create unique index zz_target on pilot.accounts (login_email)',
      'foreign key (cleared_by_account_id) references pilot.accounts(login_email)'],
  },
];
const replaceKey = (name: string, definition: string) =>
  `alter table ${T} drop constraint ${name}, add constraint ${name} ${definition}`;
const FOREIGN_KEY_DRIFTS: Array<[string, string, string]> = FOREIGN_KEYS.flatMap((key) => [
  [key.piece, `${key.name}: on delete ${key.wrongDelete}`, replaceKey(key.name, `${key.right} on delete ${key.wrongDelete}`)],
  [key.piece, `${key.name}: on update cascade`, replaceKey(key.name, `${key.right} on delete ${key.onDelete} on update cascade`)],
  [key.piece, `${key.name}: deferrable`, replaceKey(key.name, `${key.right} on delete ${key.onDelete} deferrable`)],
  [key.piece, `${key.name}: not validated`, replaceKey(key.name, `${key.right} on delete ${key.onDelete} not valid`)],
  [key.piece, `${key.name}: from the wrong columns`, replaceKey(key.name, `${key.wrongColumns} on delete ${key.onDelete}`)],
  [key.piece, `${key.name}: to the wrong table`,
    `create table pilot.zz_pairs (organization_id text, athlete_id text, primary key (organization_id, athlete_id));
     ${replaceKey(key.name, `${key.wrongTable} on delete ${key.onDelete}`)}`],
  [key.piece, `${key.name}: to the wrong columns of the right table`,
    `${key.wrongTarget[0]}; ${replaceKey(key.name, `${key.wrongTarget[1]} on delete ${key.onDelete}`)}`],
]);

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

describe('athlete reached-out marks migration', () => {
  test('the full schema (the workflow\'s `all` list) carries the table on its own, and it passes readiness', async () => {
    const { client } = await freshDatabase({ runRunner: false });
    try {
      const { rows } = await client.query(`select to_regclass('${T}') is not null as present`);
      expect(rows[0].present).toBe(true);
      await expect(applyMigrationTransaction(client, 'select 1')).resolves.toBeUndefined();
    } finally {
      await client.end();
    }
  });

  test('creates the table from nothing, passes readiness, and a re-apply keeps the rows', async () => {
    const { client } = await freshDatabase({ preMigration: true });
    try {
      expect((await client.query(`select to_regclass('${T}') as t`)).rows[0].t).toBeNull();
      await applyMigrationTransaction(client, migrationSql);
      expect((await client.query(`select count(*)::int as n from ${T}`)).rows[0].n).toBe(0);
      await mark(client, 'ada');
      await applyMigrationTransaction(client, migrationSql);
      const { rows } = await client.query(`select organization_id, athlete_id, marked_by_account_id, marked_by_role from ${T}`);
      expect(rows).toEqual([{ organization_id: ORG_ID, athlete_id: 'ada', marked_by_account_id: COACH_ID, marked_by_role: 'coach' }]);
    } finally {
      await client.end();
    }
  });

  test('a refused readiness check rolls back everything the run did', async () => {
    const { client } = await freshDatabase();
    try {
      await client.query(`alter table ${T} add column note text`);
      await expect(applyMigrationTransaction(client, 'create table pilot.zz_reached_out_probe (x integer)'))
        .rejects.toThrow('ATHLETE_REACHED_OUT_MARKS_TABLE_NOT_READY: columns_ready');
      expect((await client.query(`select to_regclass('pilot.zz_reached_out_probe') is null as gone`)).rows[0].gone).toBe(true);
    } finally {
      await client.end();
    }
  });

  const INDEX = 'pilot.uq_athlete_reached_out_marks_current';
  const GUARD = 'trg_athlete_reached_out_marks_guard';
  const GUARD_FUNCTION = 'pilot.athlete_reached_out_marks_guard()';
  const replaceGuard = (when: string, each: string, fn: string) =>
    `drop trigger ${GUARD} on ${T}; create trigger ${GUARD} ${when} on ${T} ${each} execute function ${fn}`;
  // With no table, every piece that looks at the table fails with it.
  const NO_TABLE = [
    'table_ready', 'columns_ready', 'organization_id_ready', 'mark_id_ready', 'athlete_id_ready', 'marked_by_account_id_ready',
    'marked_by_role_ready', 'marked_at_ready', 'cleared_at_ready', 'cleared_by_account_id_ready', 'cleared_kind_ready', 'checks_ready',
    'primary_key_ready',
    'current_mark_index_ready', 'foreign_key_count_ready', 'organization_fk_ready', 'athlete_fk_ready', 'marked_by_fk_ready',
    'cleared_by_fk_ready', 'guard_ready',
  ];
  // Each condition of the readiness check, drifted on its own. The refusal must name exactly the
  // pieces listed (the piece, or the 4th entry when a drift trips more), so a readiness check that
  // stops looking at any one condition turns its row red.
  test.each<[string, string, string, string[]?]>([
    ['table_ready', 'no table at all', `drop table ${T} cascade`, NO_TABLE],
    ['columns_ready', 'an extra column (a note)', `alter table ${T} add column note text`],
    ['organization_id_ready', 'organization_id with a default', `alter table ${T} alter column organization_id set default 'org-x'`],
    ['mark_id_ready', 'mark_id as text', `alter table ${T} alter column mark_id type text`],
    ['mark_id_ready', 'mark_id with a default', `alter table ${T} alter column mark_id set default gen_random_uuid()`],
    ['athlete_id_ready', 'athlete_id a varchar', `alter table ${T} alter column athlete_id type varchar(200)`],
    ['marked_by_account_id_ready', 'marked_by_account_id not null (an account delete could not clear it)',
      `alter table ${T} alter column marked_by_account_id set not null`],
    ['marked_by_role_ready', 'marked_by_role with a default', `alter table ${T} alter column marked_by_role set default 'coach'`],
    ['marked_at_ready', 'marked_at with no default', `alter table ${T} alter column marked_at drop default`],
    ['marked_at_ready', 'marked_at nullable', `alter table ${T} alter column marked_at drop not null`],
    ['cleared_at_ready', 'cleared_at not null', `alter table ${T} alter column cleared_at set default now(), alter column cleared_at set not null`],
    ['cleared_by_account_id_ready', 'cleared_by_account_id with a default', `alter table ${T} alter column cleared_by_account_id set default 'x'`],
    ['cleared_kind_ready', 'cleared_kind with a default', `alter table ${T} alter column cleared_kind set default 'taken_back'`],
    ['cleared_kind_ready', 'cleared_kind as a varchar', `alter table ${T} alter column cleared_kind type varchar(20)`, ['cleared_kind_ready', 'checks_ready']],
    // Another collation leaves the CHECK's printed text as it was; only the column check sees it.
    ['cleared_kind_ready', 'cleared_kind under another collation', `alter table ${T} alter column cleared_kind type text collate "C"`],
    ['marked_by_role_ready', 'marked_by_role under another collation', `alter table ${T} alter column marked_by_role type text collate "C"`],
    ['checks_ready', 'a role list that is not the answered one',
      `alter table ${T} drop constraint pilot_athlete_reached_out_marks_role_check,
         add constraint pilot_athlete_reached_out_marks_role_check check (marked_by_role in ('coach', 'organization_admin', 'admin', 'parent'))`],
    ['checks_ready', 'the take-back rule loosened',
      `alter table ${T} drop constraint pilot_athlete_reached_out_marks_clear_check,
         add constraint pilot_athlete_reached_out_marks_clear_check check ((cleared_by_account_id is null or cleared_at is not null or marked_by_role = 'admin')
           and (cleared_at is null) = (cleared_kind is null))`],
    ['checks_ready', 'a third way for a mark to end',
      `alter table ${T} drop constraint pilot_athlete_reached_out_marks_cleared_kind_check,
         add constraint pilot_athlete_reached_out_marks_cleared_kind_check check (cleared_kind in ('taken_back', 'replaced', 'expired'))`],
    ['checks_ready', 'an ended mark that need not say how',
      `alter table ${T} drop constraint pilot_athlete_reached_out_marks_clear_check,
         add constraint pilot_athlete_reached_out_marks_clear_check check (cleared_by_account_id is null or cleared_at is not null)`],
    ['checks_ready', 'a CHECK not validated',
      `alter table ${T} drop constraint pilot_athlete_reached_out_marks_clear_check,
         add constraint pilot_athlete_reached_out_marks_clear_check check ((cleared_by_account_id is null or cleared_at is not null)
           and (cleared_at is null) = (cleared_kind is null)) not valid`],
    ['checks_ready', 'a fourth CHECK', `alter table ${T} add constraint zz_extra check (marked_by_role <> '')`],
    ['primary_key_ready', 'no primary key', `alter table ${T} drop constraint athlete_reached_out_marks_pkey`],
    ['primary_key_ready', 'the primary key deferrable (an upsert could not use it)',
      `alter table ${T} drop constraint athlete_reached_out_marks_pkey, add primary key (organization_id, mark_id) deferrable`],
    ['primary_key_ready', 'the primary key on other columns',
      `alter table ${T} drop constraint athlete_reached_out_marks_pkey, add primary key (organization_id, athlete_id, mark_id)`],
    ['primary_key_ready', 'the primary key reversed',
      `alter table ${T} drop constraint athlete_reached_out_marks_pkey, add primary key (mark_id, organization_id)`],
    ['current_mark_index_ready', 'no current-mark index', `drop index ${INDEX}`],
    ['current_mark_index_ready', 'the index over every mark, not only current ones',
      `drop index ${INDEX}; create unique index zz_all on ${T} (organization_id, athlete_id)`],
    ['current_mark_index_ready', 'the index under another condition',
      `drop index ${INDEX}; create unique index zz_cond on ${T} (organization_id, athlete_id) where cleared_at is null and marked_by_role = 'coach'`],
    ['current_mark_index_ready', 'the index columns reversed',
      `drop index ${INDEX}; create unique index zz_rev on ${T} (athlete_id, organization_id) where cleared_at is null`],
    ['current_mark_index_ready', 'the index under another collation',
      `drop index ${INDEX}; create unique index zz_coll on ${T} (organization_id, athlete_id collate "C") where cleared_at is null`],
    ['current_mark_index_ready', 'the index on an expression',
      `drop index ${INDEX}; create unique index zz_expr on ${T} (organization_id, lower(athlete_id)) where cleared_at is null`],
    ['current_mark_index_ready', 'a second unique index', `create unique index zz_second on ${T} (marked_by_account_id, athlete_id)`],
    ['current_mark_index_ready', 'the index not valid', `update pg_index set indisvalid = false where indexrelid = '${INDEX}'::regclass`],
    ['current_mark_index_ready', 'the index checked at commit, not at once',
      `update pg_index set indimmediate = false where indexrelid = '${INDEX}'::regclass`],
    // A unique constraint brings its own unique index, so the current-mark index is no longer the only one.
    ['no_unique_constraint_ready', 'a unique constraint', `alter table ${T} add constraint zz_unique unique (organization_id, marked_at)`,
      ['current_mark_index_ready', 'no_unique_constraint_ready']],
    ['no_unique_constraint_ready', 'an exclusion constraint', `alter table ${T} add constraint zz_excl exclude using btree (marked_by_role with =)`],
    ['foreign_key_count_ready', 'a fifth foreign key',
      `alter table ${T} add constraint zz_org_again foreign key (organization_id) references pilot.organizations(organization_id)`],
    ...FOREIGN_KEY_DRIFTS,
    ['guard_ready', 'no guard', `drop trigger ${GUARD} on ${T}`],
    ['guard_ready', 'the guard switched off', `alter table ${T} disable trigger ${GUARD}`],
    ['guard_ready', 'the guard on inserts only', replaceGuard('before insert', 'for each row', GUARD_FUNCTION)],
    ['guard_ready', 'the guard not on inserts', replaceGuard('before update or delete', 'for each row', GUARD_FUNCTION)],
    ['guard_ready', 'the guard after the write', replaceGuard('after insert or update or delete', 'for each row', GUARD_FUNCTION)],
    ['guard_ready', 'the guard once per statement', replaceGuard('before insert or update or delete', 'for each statement', GUARD_FUNCTION)],
    ['guard_ready', 'the guard on updates of one column only',
      replaceGuard('before insert or update of cleared_at or delete', 'for each row', GUARD_FUNCTION)],
    ['guard_ready', 'the guard with a WHEN', `drop trigger ${GUARD} on ${T};
       create trigger ${GUARD} before insert or update or delete on ${T} for each row when (false) execute function ${GUARD_FUNCTION}`],
    ['no_other_trigger_ready', 'a second trigger on the table',
      `create function pilot.zz_after() returns trigger language plpgsql as $$ begin return null; end $$;
       create trigger zz_after after insert on ${T} for each row execute function pilot.zz_after()`],
    ['no_rule_ready', 'a rule on the table', `create rule zz_drop_updates as on update to ${T} do instead nothing`],
    ['guard_ready', 'the guard calling another function',
      `create function pilot.zz_let_through() returns trigger language plpgsql as $$ begin return coalesce(new, old); end $$;
       ${replaceGuard('before insert or update or delete', 'for each row', 'pilot.zz_let_through()')}`],
  ])('readiness refuses %s: %s', async (piece, _label, alteration, pieces = [piece]) => {
    const client = await migratedCopy();
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).resolves.toBeUndefined();
      await client.query(alteration);
      await expect(applyMigrationTransaction(client, 'select 1'))
        .rejects.toThrow(new RegExp(`^ATHLETE_REACHED_OUT_MARKS_TABLE_NOT_READY: ${pieces.join(', ')}$`));
    } finally {
      await client.end();
    }
  });

  test('only the three staff roles may hold a mark', async () => {
    const { client } = await freshDatabase();
    try {
      for (const role of ['athlete', 'parent', 'board', 'volunteer', 'staff', 'platform_owner', '']) {
        await expect(mark(client, 'ada', { role })).rejects.toMatchObject({ code: '23514' });
      }
      await mark(client, 'ada', { role: 'coach' });
      await mark(client, 'ben', { role: 'organization_admin' });
      await takeBack(client, 'ada');
      await mark(client, 'ada', { role: 'admin' });
      expect((await client.query(`select count(*)::int as n from ${T}`)).rows[0].n).toBe(3);
    } finally {
      await client.end();
    }
  });

  test('one current mark per athlete; a take-back keeps its row, and only a take-back names who took it back', async () => {
    const { client } = await freshDatabase();
    try {
      await mark(client, 'ada');
      await expect(mark(client, 'ada')).rejects.toMatchObject({ code: '23505', constraint: 'uq_athlete_reached_out_marks_current' });
      // The current-mark index is what an "insert unless already marked" leans on.
      const again = await client.query(
        `insert into ${T} (organization_id, mark_id, athlete_id, marked_by_account_id, marked_by_role)
         values ($1, gen_random_uuid(), 'ada', $2, 'coach')
         on conflict (organization_id, athlete_id) where cleared_at is null do nothing`,
        [ORG_ID, COACH_ID],
      );
      expect(again.rowCount).toBe(0);
      await expect(client.query(`update ${T} set cleared_by_account_id = $1 where athlete_id = 'ada'`, [COACH_ID]))
        .rejects.toMatchObject({ code: '23514', constraint: 'pilot_athlete_reached_out_marks_append_only' });
      await takeBack(client, 'ada', LEAVER_ID);
      await mark(client, 'ada');
      await takeBack(client, 'ada');
      await mark(client, 'ada', { account: LEAVER_ID });
      await mark(client, 'ben');
      const { rows } = await client.query(
        `select athlete_id, marked_by_account_id, cleared_by_account_id, cleared_at is not null as cleared
           from ${T} order by athlete_id, marked_at`,
      );
      expect(rows).toEqual([
        { athlete_id: 'ada', marked_by_account_id: COACH_ID, cleared_by_account_id: LEAVER_ID, cleared: true },
        { athlete_id: 'ada', marked_by_account_id: COACH_ID, cleared_by_account_id: COACH_ID, cleared: true },
        { athlete_id: 'ada', marked_by_account_id: LEAVER_ID, cleared_by_account_id: null, cleared: false },
        { athlete_id: 'ben', marked_by_account_id: COACH_ID, cleared_by_account_id: null, cleared: false },
      ]);
    } finally {
      await client.end();
    }
  });

  // Codex's P1 on #2176: the athlete came back and then stopped again. The old mark is for the
  // earlier absence; while it stays current, the index refuses the new absence's mark.
  test('a mark for an earlier absence is replaced: ended as \'replaced\', naming who, and the new mark is current, in one transaction', async () => {
    const { client } = await freshDatabase();
    try {
      await mark(client, 'ada', { account: LEAVER_ID });
      // The problem: a second mark is refused while the stale one is current.
      await expect(mark(client, 'ada')).rejects.toMatchObject({ code: '23505', constraint: 'uq_athlete_reached_out_marks_current' });
      // The order is fixed: the new mark cannot go in first, and a refused replacement leaves the old mark as it was.
      await client.query('BEGIN');
      await expect(mark(client, 'ada')).rejects.toMatchObject({ code: '23505', constraint: 'uq_athlete_reached_out_marks_current' });
      await client.query('ROLLBACK');
      await replace(client, 'ada');
      // A second return and stop: replaced again; the earlier ends keep their kind.
      await replace(client, 'ada', LEAVER_ID);
      // A take-back is still a take-back.
      await takeBack(client, 'ada');
      const { rows } = await client.query(
        `select marked_by_account_id, cleared_by_account_id, cleared_kind, cleared_at is not null as ended,
                cleared_at is null or cleared_at >= marked_at as in_order
           from ${T} where athlete_id = 'ada' order by marked_at`,
      );
      expect(rows).toEqual([
        { marked_by_account_id: LEAVER_ID, cleared_by_account_id: COACH_ID, cleared_kind: 'replaced', ended: true, in_order: true },
        { marked_by_account_id: COACH_ID, cleared_by_account_id: LEAVER_ID, cleared_kind: 'replaced', ended: true, in_order: true },
        { marked_by_account_id: LEAVER_ID, cleared_by_account_id: COACH_ID, cleared_kind: 'taken_back', ended: true, in_order: true },
      ]);
      // Each replacement's new mark is made after (or as) the old one ended: the database's own times.
      const { rows: gaps } = await client.query(
        `select bool_and(next_marked_at >= cleared_at) as new_after_old from (
           select cleared_at, lead(marked_at) over (order by marked_at) as next_marked_at from ${T} where athlete_id = 'ada'
         ) x where cleared_at is not null and next_marked_at is not null`,
      );
      expect(gaps).toEqual([{ new_after_old: true }]);
    } finally {
      await client.end();
    }
  });

  test('an account\'s delete (as the purge deletes a guardian\'s account) clears its id from every mark and take-back, and keeps the marks', async () => {
    const { client } = await freshDatabase();
    try {
      await mark(client, 'ada', { account: LEAVER_ID });
      await takeBack(client, 'ada', LEAVER_ID);
      await mark(client, 'ada', { account: LEAVER_ID });
      await mark(client, 'ben');
      await takeBack(client, 'ben', LEAVER_ID);
      await client.query('delete from pilot.accounts where account_id = $1', [LEAVER_ID]);
      const { rows } = await client.query(
        `select athlete_id, marked_by_account_id, marked_by_role, marked_at is not null as has_time,
                cleared_by_account_id, cleared_at is not null as cleared, cleared_kind
           from ${T} order by athlete_id, marked_at`,
      );
      expect(rows).toEqual([
        { athlete_id: 'ada', marked_by_account_id: null, marked_by_role: 'coach', has_time: true, cleared_by_account_id: null, cleared: true,
          cleared_kind: 'taken_back' },
        { athlete_id: 'ada', marked_by_account_id: null, marked_by_role: 'coach', has_time: true, cleared_by_account_id: null, cleared: false,
          cleared_kind: null },
        { athlete_id: 'ben', marked_by_account_id: COACH_ID, marked_by_role: 'coach', has_time: true, cleared_by_account_id: null, cleared: true,
          cleared_kind: 'taken_back' },
      ]);
      expect(JSON.stringify((await client.query(`select * from ${T}`)).rows)).not.toContain(LEAVER_ID);
    } finally {
      await client.end();
    }
  });

  test('the guard: a mark names who made it, starts current, and takes the database\'s time', async () => {
    const { client } = await freshDatabase();
    try {
      await expect(mark(client, 'ada', { account: null }))
        .rejects.toMatchObject({ code: '23514', constraint: 'pilot_athlete_reached_out_marks_names_who' });
      await expect(client.query(
        `insert into ${T} (organization_id, mark_id, athlete_id, marked_by_account_id, marked_by_role, cleared_at, cleared_by_account_id)
         values ($1, gen_random_uuid(), 'ada', $2, 'coach', now(), $2)`,
        [ORG_ID, COACH_ID],
      )).rejects.toMatchObject({ code: '23514', constraint: 'pilot_athlete_reached_out_marks_starts_current' });
      await expect(client.query(
        `insert into ${T} (organization_id, mark_id, athlete_id, marked_by_account_id, marked_by_role, cleared_kind)
         values ($1, gen_random_uuid(), 'ada', $2, 'coach', 'replaced')`,
        [ORG_ID, COACH_ID],
      )).rejects.toMatchObject({ code: '23514', constraint: 'pilot_athlete_reached_out_marks_starts_current' });
      await client.query(
        `insert into ${T} (organization_id, mark_id, athlete_id, marked_by_account_id, marked_by_role, marked_at)
         values ($1, gen_random_uuid(), 'ada', $2, 'coach', '2000-01-01T00:00:00Z')`,
        [ORG_ID, COACH_ID],
      );
      const { rows } = await client.query(`select marked_at > now() - interval '1 minute' as now_ish from ${T}`);
      expect(rows).toEqual([{ now_ish: true }]);
    } finally {
      await client.end();
    }
  });

  test('the guard: a take-back is once, names who, takes the database\'s time, and nothing undoes or deletes it', async () => {
    const { client } = await freshDatabase();
    const refused = { code: '23514', constraint: 'pilot_athlete_reached_out_marks_append_only' };
    try {
      await mark(client, 'ada');
      await expect(client.query(`update ${T} set cleared_at = now() where athlete_id = 'ada'`)).rejects.toMatchObject(refused);
      await expect(client.query(`update ${T} set marked_by_role = 'admin' where athlete_id = 'ada'`)).rejects.toMatchObject(refused);
      await expect(client.query(`update ${T} set marked_by_account_id = $1 where athlete_id = 'ada'`, [LEAVER_ID]))
        .rejects.toMatchObject(refused);
      await expect(client.query(`update ${T} set athlete_id = 'ben' where athlete_id = 'ada'`)).rejects.toMatchObject(refused);
      // Only an account's delete (the foreign key's own SET NULL, deeper than 1) may clear a name.
      await expect(client.query(`update ${T} set marked_by_account_id = null where athlete_id = 'ada'`)).rejects.toMatchObject(refused);
      // An end that does not say how it ended, or says it in another word, is refused.
      await expect(client.query(`update ${T} set cleared_at = now(), cleared_by_account_id = $1 where athlete_id = 'ada'`, [COACH_ID]))
        .rejects.toMatchObject(refused);
      await expect(client.query(
        `update ${T} set cleared_at = now(), cleared_by_account_id = $1, cleared_kind = 'phoned, no answer' where athlete_id = 'ada'`,
        [COACH_ID],
      )).rejects.toMatchObject({ code: '23514', constraint: 'pilot_athlete_reached_out_marks_cleared_kind_check' });
      // A kind with no end is refused too: only an ended mark says how.
      await expect(client.query(`update ${T} set cleared_kind = 'taken_back' where athlete_id = 'ada'`)).rejects.toMatchObject(refused);
      await client.query(
        `update ${T} set cleared_at = '2000-01-01T00:00:00Z', cleared_by_account_id = $1, cleared_kind = 'taken_back' where athlete_id = 'ada'`,
        [COACH_ID],
      );
      const taken = await client.query(`select cleared_at >= marked_at as after_mark, cleared_at > now() - interval '1 minute' as now_ish from ${T}`);
      expect(taken.rows).toEqual([{ after_mark: true, now_ish: true }]);
      await expect(client.query(`update ${T} set cleared_at = null, cleared_by_account_id = null where athlete_id = 'ada'`))
        .rejects.toMatchObject(refused);
      await expect(client.query(`update ${T} set cleared_by_account_id = $1 where athlete_id = 'ada'`, [LEAVER_ID]))
        .rejects.toMatchObject(refused);
      await expect(client.query(`update ${T} set cleared_by_account_id = null where athlete_id = 'ada'`)).rejects.toMatchObject(refused);
      // Nothing relabels an end: a take-back does not become a replacement afterwards, or lose its kind.
      await expect(client.query(`update ${T} set cleared_kind = 'replaced' where athlete_id = 'ada'`)).rejects.toMatchObject(refused);
      await expect(client.query(`update ${T} set cleared_kind = null where athlete_id = 'ada'`)).rejects.toMatchObject(refused);
      await expect(client.query(`delete from ${T} where athlete_id = 'ada'`))
        .rejects.toMatchObject({ code: '23514', constraint: 'pilot_athlete_reached_out_marks_no_delete' });
      expect((await client.query(`select count(*)::int as n from ${T} where cleared_at is not null`)).rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('the guard holds against a write from inside another table\'s trigger: no delete, no name cleared while its account lives', async () => {
    const { client } = await freshDatabase();
    try {
      await mark(client, 'ada');
      await client.query(`create table pilot.zz_poke (action text)`);
      await client.query(`create function pilot.zz_poke() returns trigger language plpgsql as $$
        begin
          if new.action = 'clear name' then update ${T} set marked_by_account_id = null; end if;
          if new.action = 'delete' then delete from ${T}; end if;
          return new;
        end $$`);
      await client.query(`create trigger zz_poke after insert on pilot.zz_poke for each row execute function pilot.zz_poke()`);
      await expect(client.query(`insert into pilot.zz_poke values ('clear name')`))
        .rejects.toMatchObject({ code: '23514', constraint: 'pilot_athlete_reached_out_marks_append_only' });
      await expect(client.query(`insert into pilot.zz_poke values ('delete')`))
        .rejects.toMatchObject({ code: '23514', constraint: 'pilot_athlete_reached_out_marks_no_delete' });
      const { rows } = await client.query(`select marked_by_account_id from ${T}`);
      expect(rows).toEqual([{ marked_by_account_id: COACH_ID }]);
    } finally {
      await client.end();
    }
  });

  // (A gym cannot be deleted while it has athletes, pilot.athletes' own foreign key, so a mark,
  // which needs an athlete, goes with its athlete first; the gym cascade is the backstop.)
  test('a mark names an existing athlete of its own gym and a real account; deleting the athlete takes its marks', async () => {
    const { client } = await freshDatabase();
    try {
      await expect(mark(client, 'nobody')).rejects.toMatchObject({ code: '23503', constraint: 'pilot_athlete_reached_out_marks_athlete_fk' });
      // 'ben' is an athlete of the first gym only: under the other gym, refused.
      await expect(mark(client, 'ben', { org: OTHER_ORG_ID }))
        .rejects.toMatchObject({ code: '23503', constraint: 'pilot_athlete_reached_out_marks_athlete_fk' });
      await expect(mark(client, 'ada', { org: 'org-nowhere' })).rejects.toMatchObject({ code: '23503' });
      // An account column cannot hold a sentence: it must name an account.
      await expect(mark(client, 'ada', { account: 'reached out by phone, said they are busy' }))
        .rejects.toMatchObject({ code: '23503', constraint: 'pilot_athlete_reached_out_marks_marked_by_fk' });
      await mark(client, 'ada');
      await expect(takeBack(client, 'ada', 'not an account'))
        .rejects.toMatchObject({ code: '23503', constraint: 'pilot_athlete_reached_out_marks_cleared_by_fk' });
      await takeBack(client, 'ada');
      await mark(client, 'ada');
      await mark(client, 'ben');
      await mark(client, 'ada', { org: OTHER_ORG_ID });
      await client.query(`delete from pilot.athletes where organization_id = $1 and athlete_id = 'ben'`, [ORG_ID]);
      // The other gym's athlete of the same id goes; this gym's 'ada' and her two marks stay.
      await client.query(`delete from pilot.athletes where organization_id = $1 and athlete_id = 'ada'`, [OTHER_ORG_ID]);
      const { rows } = await client.query(`select organization_id, athlete_id from ${T} order by 1, 2`);
      expect(rows).toEqual([{ organization_id: ORG_ID, athlete_id: 'ada' }, { organization_id: ORG_ID, athlete_id: 'ada' }]);
    } finally {
      await client.end();
    }
  });

  test('the runner gives up after its lock timeout instead of queueing writes behind a busy accounts table', async () => {
    const { client, name } = await freshDatabase({ preMigration: true });
    const holder = new Client({ connectionString: connectionStringFor(name) });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('lock table pilot.accounts in row exclusive mode');
      const started = Date.now();
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toMatchObject({ code: '55P03' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
      expect((await client.query(`select to_regclass('${T}') is null as absent`)).rows[0].absent).toBe(true);
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      await holder.end();
      await client.end();
    }
  });
});
