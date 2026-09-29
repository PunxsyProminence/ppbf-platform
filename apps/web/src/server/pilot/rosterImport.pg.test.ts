// Real PostgreSQL-backed contract test for the roster import's coach rule
// (Jason, 2026-09-29, "3B", OD-2026-09-29-002 item 9d): every athlete row
// must name an ACTIVE COACH account of the IMPORTING gym, for an admin
// importer and a coach importer alike. Anything else cannot be added.
//
// WHY THIS SUITE EXISTS. rosterImport.test.ts proves the rule against a
// mocked query() that answers whatever the test tells it to. The rule's
// substance is the SQL predicate in planRosterImport -- this gym, role coach,
// active -- and a mock cannot execute SQL: dropping `organization_id = $1`
// or `active_flag = true` from that query leaves every unit test green. Here
// each rejected row is a real account that fails exactly one part of the
// predicate (inactive; not a coach; another gym; does not exist), so each
// part is proven by a row that would come back if it were gone.
//
// './db' is mocked to route into the embedded server, so planRosterImport and
// applyRosterImport below are the production code running their own SQL.
//
// THE WHOLE SCHEMA, built once into a template database and cloned per test.
// pilot.athletes' production shape comes from seven files and
// pilot.accounts' from nine (see scripts/lib/full-schema.mjs for why a
// hand-picked subset tests a database that has never existed). It matters
// most for the "nothing else written" and "what Postgres says" tests below:
// both are claims about production's schema, including any trigger or
// constraint a later migration adds.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

// Routes rosterImport.ts's (and entities.ts's) queries into whichever
// embedded database the current test opened. Declared before the import so
// jest's mock hoisting sees it.
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
}));

import { insertAthleteIfAbsent } from './entities';
import {
  applyRosterImport,
  assignBlankCoachTo,
  parseRosterCsv,
  planRosterImport,
  type RosterImportPlan,
} from './rosterImport';

jest.setTimeout(300_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-roster-import-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEMPLATE_DB = 'roster_import_template';

/** The importing gym. */
const ORG_A = 'org-roster-a';
/** Another gym, with its own active coach. */
const ORG_B = 'org-roster-b';

/** Org A, role coach, active: the only Coach value an org A row may carry. */
const ACTIVE_COACH_A = 'acct-roster-coach-a';
/** Org A, role coach, active: a second coach, used as the coach IMPORTER in
 * one test so a row naming ACTIVE_COACH_A is a colleague, not the importer. */
const SECOND_ACTIVE_COACH_A = 'acct-roster-coach-a2';
/** Org A, role coach, NOT active. Fails only `active_flag = true`. */
const INACTIVE_COACH_A = 'acct-roster-coach-a-inactive';
/** Org A, role organization_admin, active. Fails only `role = 'coach'`. */
const ADMIN_A = 'acct-roster-admin-a';
/** Org B, role coach, active. Fails only `organization_id = $1`. */
const ACTIVE_COACH_B = 'acct-roster-coach-b';
/** No such account anywhere. */
const UNKNOWN_ACCOUNT = 'acct-roster-nobody';

const NOT_ACTIVE_HERE = (id: string) => `Coach "${id}" is not an active coach in this gym.`;
const NEEDS_A_COACH = 'Needs a coach. Put the account id of an active coach in this gym in the Coach column.';

/**
 * The file an operator would paste: every athlete row valid in every respect
 * except, for five of them, the Coach cell. The header is the short form a
 * hand-typed roster uses ("Coach"), so the column goes through parseRosterCsv's
 * alias table exactly as it would from the route.
 */
const ROSTER_CSV = [
  'Athlete ID,Full name,Date of birth,Weight class,Coach',
  `RI-ACTIVE,Row Active,2012-03-14,fly,${ACTIVE_COACH_A}`,
  `RI-INACTIVE,Row Inactive,2012-03-14,fly,${INACTIVE_COACH_A}`,
  `RI-ADMIN,Row Admin,2012-03-14,fly,${ADMIN_A}`,
  `RI-OTHER-GYM,Row Other Gym,2012-03-14,fly,${ACTIVE_COACH_B}`,
  `RI-UNKNOWN,Row Unknown,2012-03-14,fly,${UNKNOWN_ACCOUNT}`,
  'RI-BLANK,Row Blank,2012-03-14,fly,',
].join('\n');

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;

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

async function insertAccount(
  client: Client,
  accountId: string,
  role: string,
  organizationId: string,
  activeFlag: boolean,
): Promise<void> {
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag)
     values ($1, $2, $3, 'microsoft', $4)`,
    [accountId, role, organizationId, activeFlag],
  );
}

/** Full schema plus the seed every test starts from, applied once. */
async function buildTemplate(): Promise<void> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEMPLATE_DB}`);
  await admin.query(`create database ${TEMPLATE_DB}`);
  await admin.end();

  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  const applyFullSchema = helper.applyFullSchema as (
    client: Client,
    opts?: { infraDir?: string },
  ) => Promise<unknown>;

  const client = new Client({ connectionString: connectionStringFor(TEMPLATE_DB) });
  await client.connect();
  try {
    await applyFullSchema(client, { infraDir: INFRA_DIR });

    for (const organizationId of [ORG_A, ORG_B]) {
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status)
         values ($1, $1, 'active')`,
        [organizationId],
      );
    }
    await insertAccount(client, ACTIVE_COACH_A, 'coach', ORG_A, true);
    await insertAccount(client, SECOND_ACTIVE_COACH_A, 'coach', ORG_A, true);
    await insertAccount(client, INACTIVE_COACH_A, 'coach', ORG_A, false);
    await insertAccount(client, ADMIN_A, 'organization_admin', ORG_A, true);
    await insertAccount(client, ACTIVE_COACH_B, 'coach', ORG_B, true);
  } finally {
    // A template cannot be copied while anything is connected to it.
    await client.end();
  }
}

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name} template ${TEMPLATE_DB}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** Row count and a content digest of one table, optionally filtered. */
async function tableState(client: Client, qualified: string, where = 'true'): Promise<string> {
  const { rows } = await client.query<{ n: string; digest: string }>(
    `select count(*)::text as n,
            md5(coalesce(string_agg(t::text, E'\\n' order by t::text), '')) as digest
       from ${qualified} t
      where ${where}`,
  );
  return `${rows[0].n}:${rows[0].digest}`;
}

/**
 * Every user table in the database, by count AND content digest -- so an
 * update, not only an insert or delete, shows up as a difference.
 */
async function snapshot(client: Client): Promise<Map<string, string>> {
  const { rows: tables } = await client.query<{ table_schema: string; table_name: string }>(
    `select table_schema, table_name from information_schema.tables
      where table_type = 'BASE TABLE'
        and table_schema not in ('pg_catalog', 'information_schema')
      order by table_schema, table_name`,
  );
  const state = new Map<string, string>();
  for (const { table_schema: schema, table_name: name } of tables) {
    state.set(`${schema}.${name}`, await tableState(client, `${quoteIdent(schema)}.${quoteIdent(name)}`));
  }
  return state;
}

function changedTables(before: Map<string, string>, after: Map<string, string>): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => before.get(name) !== after.get(name)).sort();
}

function outcomes(plan: RosterImportPlan) {
  return plan.rows.map(({ athlete_id, outcome, reason }) => ({ athlete_id, outcome, reason }));
}

/** What an ADMIN importer's preview must say for ROSTER_CSV. */
const ADMIN_EXPECTED = [
  { athlete_id: 'RI-ACTIVE', outcome: 'create', reason: '' },
  { athlete_id: 'RI-INACTIVE', outcome: 'reject', reason: NOT_ACTIVE_HERE(INACTIVE_COACH_A) },
  { athlete_id: 'RI-ADMIN', outcome: 'reject', reason: NOT_ACTIVE_HERE(ADMIN_A) },
  { athlete_id: 'RI-OTHER-GYM', outcome: 'reject', reason: NOT_ACTIVE_HERE(ACTIVE_COACH_B) },
  { athlete_id: 'RI-UNKNOWN', outcome: 'reject', reason: NOT_ACTIVE_HERE(UNKNOWN_ACCOUNT) },
  { athlete_id: 'RI-BLANK', outcome: 'reject', reason: NEEDS_A_COACH },
];

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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  await buildTemplate();
}, 600_000);

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
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

afterEach(() => {
  activeClient = null;
});

describe('an admin importer (real database)', () => {
  /**
   * (b) Only the row naming an active coach of THIS gym is planned. Each of
   * the other four named accounts fails exactly one part of the predicate,
   * and the blank one is the admin-specific "Needs a coach." -- an admin
   * importer is never silently made the coach.
   */
  test('only the row naming an active coach of this gym is planned create', async () => {
    const client = await freshDatabase('roster_admin_plan');
    activeClient = client;
    try {
      const parsed = parseRosterCsv(ROSTER_CSV);
      expect(parsed.fatal).toBe('');

      const before = await snapshot(client);
      const plan = await planRosterImport(ORG_A, parsed.rows);
      const after = await snapshot(client);

      expect(outcomes(plan)).toEqual(ADMIN_EXPECTED);
      expect(plan.counts).toEqual({ create: 1, skip_exists: 0, reject: 5 });
      // The preview is a dry run: planning wrote nothing anywhere.
      expect(changedTables(before, after)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  /**
   * (d) Apply the plan from (b): exactly one new pilot.athletes row, coached
   * by org A's active coach, and no other table -- nor any other athletes row
   * -- changed by count or content.
   *
   * applyRosterImport is the module the route calls; the route's own audit
   * event (writePilotAuditEvent) is written by the route after this returns
   * and is outside what this test drives.
   */
  test('applying that plan writes exactly one athlete, coached by the active coach, and nothing else', async () => {
    const client = await freshDatabase('roster_admin_apply');
    activeClient = client;
    try {
      const parsed = parseRosterCsv(ROSTER_CSV);
      const plan = await planRosterImport(ORG_A, parsed.rows);
      expect(outcomes(plan)).toEqual(ADMIN_EXPECTED);

      const before = await snapshot(client);
      const result = await applyRosterImport(ORG_A, parsed.rows, plan, ADMIN_A);
      const after = await snapshot(client);

      // Negative control for the snapshot itself: "only pilot.athletes
      // changed" means nothing if the snapshot saw only a few tables.
      expect(before.size).toBeGreaterThan(100);
      expect([...before.keys()]).toEqual(expect.arrayContaining(['pilot.accounts', 'pilot.club_members']));

      expect(outcomes(result)).toEqual(ADMIN_EXPECTED);
      expect(result.counts).toEqual({ create: 1, skip_exists: 0, reject: 5 });

      // Only pilot.athletes changed...
      expect(changedTables(before, after)).toEqual(['pilot.athletes']);
      // ...and only by the one new row: every other athletes row is
      // byte-for-byte what it was.
      await expect(
        tableState(client, 'pilot.athletes', `not (organization_id = '${ORG_A}' and athlete_id = 'RI-ACTIVE')`),
      ).resolves.toBe(before.get('pilot.athletes'));

      const { rows: created } = await client.query<{
        organization_id: string;
        athlete_id: string;
        coach_id: string;
      }>(
        `select organization_id, athlete_id, coach_id from pilot.athletes
          where athlete_id like 'RI-%' order by athlete_id`,
      );
      expect(created).toEqual([{ organization_id: ORG_A, athlete_id: 'RI-ACTIVE', coach_id: ACTIVE_COACH_A }]);
    } finally {
      await client.end();
    }
  });
});

describe('a coach importer (real database)', () => {
  /**
   * (c) The route hands a coach importer's rows through assignBlankCoachTo
   * before planning. The blank Coach cell becomes the importing coach and is
   * planned create; every other row is judged exactly as for an admin.
   */
  test('a blank Coach cell becomes the importing coach and is planned create', async () => {
    const client = await freshDatabase('roster_coach_plan');
    activeClient = client;
    try {
      const rows = assignBlankCoachTo(parseRosterCsv(ROSTER_CSV).rows, ACTIVE_COACH_A);
      expect(rows.find((row) => row.athlete_id === 'RI-BLANK')?.coach_account_id).toBe(ACTIVE_COACH_A);

      const plan = await planRosterImport(ORG_A, rows);

      expect(outcomes(plan)).toEqual([
        ...ADMIN_EXPECTED.slice(0, 5),
        { athlete_id: 'RI-BLANK', outcome: 'create', reason: '' },
      ]);
      expect(plan.counts).toEqual({ create: 2, skip_exists: 0, reject: 4 });
    } finally {
      await client.end();
    }
  });

  /**
   * "3B" itself: a coach may assign a row to ANY active coach of the same
   * gym, not only to themselves. Here the importer is a second active coach
   * of org A, so the RI-ACTIVE row names a colleague -- and is still planned
   * create -- while the blank row becomes the importer.
   */
  test("a row naming a colleague who is an active coach in the same gym is planned create", async () => {
    const client = await freshDatabase('roster_coach_colleague');
    activeClient = client;
    try {
      const rows = assignBlankCoachTo(parseRosterCsv(ROSTER_CSV).rows, SECOND_ACTIVE_COACH_A);
      expect(rows.find((row) => row.athlete_id === 'RI-BLANK')?.coach_account_id).toBe(SECOND_ACTIVE_COACH_A);
      expect(rows.find((row) => row.athlete_id === 'RI-ACTIVE')?.coach_account_id).toBe(ACTIVE_COACH_A);

      const plan = await planRosterImport(ORG_A, rows);

      expect(outcomes(plan)).toEqual([
        ...ADMIN_EXPECTED.slice(0, 5),
        { athlete_id: 'RI-BLANK', outcome: 'create', reason: '' },
      ]);
    } finally {
      await client.end();
    }
  });
});

describe('what the preview rejection prevents (real database)', () => {
  /**
   * (e) The database refuses an athlete whose coach_id is '' -- through the
   * very insert applyRosterImport uses (insertAthleteIfAbsent). The refusal is
   * the base schema's foreign key pilot_athletes_coach_fk
   * (infra/azure/pilot_slice_postgres.sql); `not null` alone would have let
   * '' through.
   *
   * The second half shows what a gym would have seen without the preview
   * check: a plan that marks the blank-coach row `create` turns that raw
   * database error into the row's reason after Add.
   */
  test("an athlete insert with coach_id '' is refused by the foreign key", async () => {
    const client = await freshDatabase('roster_blank_coach_fk');
    activeClient = client;
    try {
      const now = new Date().toISOString();
      const insert = insertAthleteIfAbsent(ORG_A, {
        athlete_id: 'RI-FK-PROBE',
        full_name: 'FK Probe',
        dob: '2012-03-14',
        weight_class: 'fly',
        gym_status: 'training',
        emergency_contact: '',
        active_flag: true,
        coach_id: '',
        created_at: now,
        updated_at: now,
      });

      await expect(insert).rejects.toMatchObject({
        code: '23503',
        constraint: 'pilot_athletes_coach_fk',
        message: 'insert or update on table "athletes" violates foreign key constraint "pilot_athletes_coach_fk"',
        detail: 'Key (coach_id)=() is not present in table "accounts".',
      });

      const forged: RosterImportPlan = {
        rows: [{ line: 1, athlete_id: 'RI-BLANK', full_name: 'Row Blank', outcome: 'create', reason: '' }],
        counts: { create: 1, skip_exists: 0, reject: 0 },
      };
      const blankRow = parseRosterCsv(ROSTER_CSV).rows.filter((row) => row.athlete_id === 'RI-BLANK');
      const result = await applyRosterImport(ORG_A, blankRow, forged, ADMIN_A);

      expect(outcomes(result)).toEqual([
        {
          athlete_id: 'RI-BLANK',
          outcome: 'reject',
          reason: 'insert or update on table "athletes" violates foreign key constraint "pilot_athletes_coach_fk"',
        },
      ]);

      const { rows } = await client.query(`select 1 from pilot.athletes where athlete_id like 'RI-%'`);
      expect(rows).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
