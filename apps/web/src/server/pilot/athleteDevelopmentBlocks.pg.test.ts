// Real PostgreSQL-backed contract test for the athlete-development-blocks
// foundation migration (module 036), AND for the real module behavior on top
// of it: './db' is mocked to route into the embedded server (the pattern
// programs.pg.test.ts and programMemberships.pg.test.ts already use), so the
// functions exercised below are the actual production functions executing
// their actual SQL against actual rows.
//
// What needs proving that reading SQL cannot prove:
//   * the migration creates the table from nothing, and re-applying it is a
//     no-op that leaves rows untouched;
//   * ends_on >= starts_on, the four-state lifecycle, and the non-blank
//     title/emphasis rules are DATABASE facts, refused with a constraint
//     violation rather than by a caller remembering to check;
//   * a block cannot name an athlete in another organization -- not "should
//     not", cannot -- and cannot outlive the athlete it names;
//   * a creator with no ACTIVE membership in the block's organization is
//     refused, while a coach whose HOME organization is elsewhere but who
//     holds an active membership here is allowed. pilot.accounts.
//     organization_id is the wrong question and this proves the module does
//     not ask it;
//   * every read path this slice adds is organization-scoped, so one gym
//     cannot reach another gym's block through any of them;
//   * every read is ATHLETE-scoped on top of that (owner decision 2026-08-28:
//     "Admin, Coach, Athlete, Guardian"), which only a real database can show
//     -- the rule lives in assertActorCanAccessAthlete's SQL, and the four
//     arms it implements are four different queries against four different
//     tables (athletes.coach_id, coach_coverage, accounts.athlete_id,
//     guardian_links). A mocked db can be asked whether the helper was
//     called; only a real row can answer whether an unassigned coach in the
//     same gym comes back empty;
//   * the runner's own readiness assertion refuses a database the migration
//     never reached (#488: the assertion that can never fail is the quiet,
//     worse half of the assertion that can never pass).
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

import type { ActorIdentity } from './access';
import {
  DEVELOPMENT_BLOCK_WRITE_ROLES,
  createDevelopmentBlock,
  getDevelopmentBlock,
  listDevelopmentBlocks,
  listDevelopmentBlocksForAthlete,
  setDevelopmentBlockStatus,
  updateDevelopmentBlock,
} from './athleteDevelopmentBlocks';
import type { PilotRole } from './contracts';
import { ForbiddenError, ValidationError } from './errors';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-athlete-dev-blocks-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_athlete_development_blocks_migration.sql';

/* This suite used to hand-pick the migrations that widen THIS table -- the
   foundation, then external-competition, wrestling-league and the
   competition-target widening -- and applied them in `all`-loop order. That
   list is gone, and with it the reason it existed.

   The reason it existed was real: the module reads and writes the whole row
   through one shared FIELDS constant, so a database built from the foundation
   alone is one the module cannot run against, and the suite would fail on
   `column ... does not exist` for reasons unrelated to what it asserts. The
   list solved that by naming each widening, at the cost of a line every future
   widening has to remember to add.

   applyFullSchema solves it without the list, and the objection recorded here
   against using it -- that this suite also needs a PRE-migration state its
   runner-readiness cases watch the table get created from, which applying
   every migration cannot produce -- turned out to have a better answer than a
   hand-built schema: build the full schema, then drop this slice's two tables
   back off. freshDatabase's `preMigration` does exactly that, and every
   migration-contract case here runs on it.

   The reads also need it. Since access.ts became the gate every read passes
   through, this suite exercises access.ts's own SQL as well as the module's,
   against tables no hand-picked list named. */
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-athlete-development-blocks-migration.mjs',
);
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-blocks';
const OTHER_ORG_ID = 'org-elsewhere';
const ADMIN_ID = 'acct-blocks-admin';
const OTHER_ADMIN_ID = 'acct-blocks-other-admin';
// Coach of record for both athletes in ORG_ID.
const COACH_ID = 'acct-blocks-coach';
// Home organization here, membership deactivated: still an account, no
// longer a writer.
const LAPSED_COACH_ID = 'acct-blocks-lapsed';
// Home organization elsewhere, ACTIVE membership here. The multi-org case
// pilot.accounts.organization_id gets wrong. Reaches ATHLETE_ID through a
// live coverage grant rather than through coach_id -- the second arm of
// assertCoachAssignedToAthlete.
const VISITING_COACH_ID = 'acct-blocks-visiting';
// ACTIVE coach membership here, coach of record for nobody, no coverage.
// The account that shows what "athlete-scoped" costs: a real coach of this
// gym who cannot reach this athlete.
const UNASSIGNED_COACH_ID = 'acct-blocks-unassigned';
// Home organization elsewhere, membership only there.
const OTHER_COACH_ID = 'acct-blocks-other-coach';
// Active memberships HERE, in roles that may not author (owner decision
// 2026-08-28: "Admin and coaches"). These are the accounts the pre-decision
// floor would have let through.
const ATHLETE_ACCOUNT_ID = 'acct-blocks-athlete';
const SECOND_ATHLETE_ACCOUNT_ID = 'acct-blocks-athlete-2';
const PARENT_ACCOUNT_ID = 'acct-blocks-parent';
// A parent of this gym with a pilot.parents row and NO guardian_link to
// ATHLETE_ID. Without this account, every guardian assertion below would
// also pass for an implementation that let any parent read any athlete.
const UNLINKED_PARENT_ACCOUNT_ID = 'acct-blocks-parent-unlinked';
const VOLUNTEER_ACCOUNT_ID = 'acct-blocks-volunteer';
const PARENT_ROW_ID = 'parent-blocks-1';
const UNLINKED_PARENT_ROW_ID = 'parent-blocks-2';
const ATHLETE_ID = 'ath-blocks-1';
const SECOND_ATHLETE_ID = 'ath-blocks-2';
const OTHER_ATHLETE_ID = 'ath-blocks-other';

/* THE ACTORS, one per standing the read rule distinguishes.

   Every read in this module now takes an ActorIdentity and resolves it
   through assertActorCanAccessAthlete, so the suite's job is to hold one
   actor for each arm of that function AND one near-miss for each: an admin
   of the wrong gym, a coach of the right gym with no assignment, an athlete
   who is not this athlete, a parent with no link. An assertion that only
   ever ran the passing arm would stay green for an implementation that
   authorized everybody. */
function actorFor(
  accountId: string,
  role: PilotRole,
  organizationId: string = ORG_ID,
  athleteId: string | null = null,
): ActorIdentity {
  return { accountId, role, organizationId, athleteId };
}

const ADMIN = actorFor(ADMIN_ID, 'organization_admin');
const OTHER_ADMIN = actorFor(OTHER_ADMIN_ID, 'organization_admin', OTHER_ORG_ID);
const COACH = actorFor(COACH_ID, 'coach');
const LAPSED_COACH = actorFor(LAPSED_COACH_ID, 'coach');
const VISITING_COACH = actorFor(VISITING_COACH_ID, 'coach');
const UNASSIGNED_COACH = actorFor(UNASSIGNED_COACH_ID, 'coach');
const ATHLETE = actorFor(ATHLETE_ACCOUNT_ID, 'athlete', ORG_ID, ATHLETE_ID);
const SECOND_ATHLETE = actorFor(SECOND_ATHLETE_ACCOUNT_ID, 'athlete', ORG_ID, SECOND_ATHLETE_ID);
const GUARDIAN = actorFor(PARENT_ACCOUNT_ID, 'parent');
const UNLINKED_GUARDIAN = actorFor(UNLINKED_PARENT_ACCOUNT_ID, 'parent');
const VOLUNTEER = actorFor(VOLUNTEER_ACCOUNT_ID, 'volunteer');
// Neither of these two is an organization member at all; they are the roles
// assertActorCanAccessAthlete refuses unconditionally, and they carry
// ORG_ID so a failure means the refusal is missing rather than the org.
const PLATFORM_OWNER = actorFor('acct-blocks-owner', 'platform_owner');
const BOARD = actorFor('acct-blocks-board', 'board');

const EMPHASIS = 'Rebuild round-3 work rate; heavier legs, less volume on the bag.';

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
 * Two gyms, eleven accounts across every standing the read and write rules
 * distinguish, two athletes here and one elsewhere, a guardian link, and a
 * live coverage grant.
 *
 * THE WHOLE SCHEMA, not the base file alone. This suite drives feature code
 * that calls access.ts, and access.ts reads pilot.athletes.deleted_at -- a
 * column belonging to the data-retention migration, which a hand-picked
 * MIGRATION_FILE list would never have named. A suite that picks its own
 * migrations is not testing a smaller production; it is testing a database
 * that has never existed anywhere. See scripts/lib/full-schema.mjs, and #706
 * for the fourteen suites that learned this at once.
 *
 * `preMigration` then drops THIS slice's two tables back off, for the
 * migration-contract cases below that have to watch the table get created
 * from nothing. Objectives first: it holds the composite FK into blocks.
 */
async function freshDatabase(
  name: string,
  { preMigration = false }: { preMigration?: boolean } = {},
): Promise<Client> {
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
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id)
     values ($1,  'organization_admin', $12, 'microsoft', null),
            ($2,  'coach',              $12, 'microsoft', null),
            ($3,  'coach',              $12, 'microsoft', null),
            ($4,  'coach',              $13, 'microsoft', null),
            ($5,  'coach',              $12, 'microsoft', null),
            ($6,  'coach',              $13, 'microsoft', null),
            ($7,  'athlete',            $12, 'microsoft', $14),
            ($8,  'athlete',            $12, 'microsoft', $15),
            ($9,  'parent',             $12, 'microsoft', null),
            ($10, 'parent',             $12, 'microsoft', null),
            ($11, 'volunteer',          $12, 'microsoft', null),
            ($16, 'organization_admin', $13, 'microsoft', null)
     on conflict do nothing`,
    [ADMIN_ID, COACH_ID, LAPSED_COACH_ID, VISITING_COACH_ID, UNASSIGNED_COACH_ID, OTHER_COACH_ID,
     ATHLETE_ACCOUNT_ID, SECOND_ATHLETE_ACCOUNT_ID, PARENT_ACCOUNT_ID, UNLINKED_PARENT_ACCOUNT_ID,
     VOLUNTEER_ACCOUNT_ID, ORG_ID, OTHER_ORG_ID, ATHLETE_ID, SECOND_ATHLETE_ID, OTHER_ADMIN_ID],
  );

  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1,  $13, 'organization_admin', true),
            ($2,  $13, 'coach',              true),
            ($3,  $13, 'coach',              false),
            ($4,  $13, 'coach',              true),
            ($4,  $14, 'coach',              true),
            ($5,  $13, 'coach',              true),
            ($6,  $14, 'coach',              true),
            ($7,  $13, 'athlete',            true),
            ($8,  $13, 'athlete',            true),
            ($9,  $13, 'parent',             true),
            ($10, $13, 'parent',             true),
            ($11, $13, 'volunteer',          true),
            ($12, $14, 'organization_admin', true)
     on conflict do nothing`,
    [ADMIN_ID, COACH_ID, LAPSED_COACH_ID, VISITING_COACH_ID, UNASSIGNED_COACH_ID, OTHER_COACH_ID,
     ATHLETE_ACCOUNT_ID, SECOND_ATHLETE_ACCOUNT_ID, PARENT_ACCOUNT_ID, UNLINKED_PARENT_ACCOUNT_ID,
     VOLUNTEER_ACCOUNT_ID, OTHER_ADMIN_ID, ORG_ID, OTHER_ORG_ID],
  );

  for (const [org, athleteId, coachId] of [
    [ORG_ID, ATHLETE_ID, COACH_ID],
    [ORG_ID, SECOND_ATHLETE_ID, COACH_ID],
    [OTHER_ORG_ID, OTHER_ATHLETE_ID, OTHER_COACH_ID],
  ] as const) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Blocks Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [org, athleteId, coachId],
    );
  }

  // The guardian arm: one parent row LINKED to ATHLETE_ID, and one parent
  // row of the same gym linked to nobody.
  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
     values ($1, $2, $3, 'Linked Guardian'), ($1, $4, $5, 'Unlinked Guardian')
     on conflict do nothing`,
    [ORG_ID, PARENT_ROW_ID, PARENT_ACCOUNT_ID, UNLINKED_PARENT_ROW_ID, UNLINKED_PARENT_ACCOUNT_ID],
  );
  await client.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, $2, $3, 'parent') on conflict do nothing`,
    [ORG_ID, PARENT_ROW_ID, ATHLETE_ID],
  );

  // The coverage arm: the visiting coach is coach of record for nobody here,
  // and holds a live grant on ATHLETE_ID only. SECOND_ATHLETE_ID is
  // deliberately left out, so "covered" cannot be read as "in the gym".
  await client.query(
    `insert into pilot.coach_coverage
       (organization_id, athlete_id, covering_coach_id, granted_by_account_id, starts_at, expires_at)
     values ($1, $2, $3, $4, now() - interval '1 hour', now() + interval '8 hours')`,
    [ORG_ID, ATHLETE_ID, VISITING_COACH_ID, ADMIN_ID],
  );

  if (preMigration) {
    await client.query('drop table if exists pilot.athlete_development_block_objectives cascade');
    await client.query('drop table if exists pilot.athlete_development_blocks cascade');
  }

  return client;
}

/** A migrated database -- the full schema, this slice's tables included --
 * with `activeClient` pointed at it so the mocked './db' routes the module's
 * real SQL (and access.ts's) here. */
async function migratedDatabase(name: string): Promise<Client> {
  const client = await freshDatabase(name);
  activeClient = client;
  return client;
}

function insertBlock(
  client: Client,
  blockId: string,
  overrides: Record<string, string | null> = {},
) {
  return client.query(
    `insert into pilot.athlete_development_blocks
       (organization_id, block_id, athlete_id, title, training_emphasis,
        starts_on, ends_on, status, created_by_account_id)
     values ($1, $2, $3, $4, $5, $6::date, $7::date,
             coalesce($8, 'draft'), $9)`,
    [
      overrides.organization_id ?? ORG_ID,
      blockId,
      'athlete_id' in overrides ? overrides.athlete_id : ATHLETE_ID,
      overrides.title ?? 'Fall strength block',
      overrides.training_emphasis ?? EMPHASIS,
      overrides.starts_on ?? '2026-09-02',
      overrides.ends_on ?? '2026-10-14',
      overrides.status ?? null,
      overrides.created_by_account_id ?? COACH_ID,
    ],
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
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;
});

afterEach(() => {
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

describe('athlete development blocks migration', () => {
  test('creates the table from nothing and accepts a coach-authored block', async () => {
    const client = await freshDatabase('adb_fresh', { preMigration: true });
    try {
      // The table is NOT in the base schema, so this is a real creation
      // rather than a re-declaration of something already present.
      const before = await client.query(
        `select to_regclass('pilot.athlete_development_blocks') as table_name`,
      );
      expect(before.rows[0].table_name).toBeNull();

      await client.query(migrationSql);
      await insertBlock(client, 'block-1');

      const rows = await client.query(
        `select athlete_id, title, training_emphasis, starts_on::text as starts_on,
                ends_on::text as ends_on, status, created_by_account_id
         from pilot.athlete_development_blocks where organization_id = $1`,
        [ORG_ID],
      );
      expect(rows.rows).toEqual([{
        athlete_id: ATHLETE_ID,
        title: 'Fall strength block',
        // Stored verbatim. Nothing parsed it, classified it, or scored it.
        training_emphasis: EMPHASIS,
        starts_on: '2026-09-02',
        ends_on: '2026-10-14',
        status: 'draft',
        created_by_account_id: COACH_ID,
      }]);
    } finally {
      await client.end();
    }
  });

  test('re-applying over an existing install is a no-op that leaves rows untouched', async () => {
    const client = await freshDatabase('adb_noop', { preMigration: true });
    try {
      await client.query(migrationSql);
      await insertBlock(client, 'block-keep');
      await client.query(migrationSql);

      const rows = await client.query(
        'select block_id from pilot.athlete_development_blocks where organization_id = $1',
        [ORG_ID],
      );
      expect(rows.rows.map((row) => row.block_id)).toEqual(['block-keep']);
    } finally {
      await client.end();
    }
  });

  test('the table stores no computed training-science column', async () => {
    // Section 6 of the brief, asserted rather than promised in a comment: if
    // a later change adds a readiness/load/fatigue/risk/compliance column to
    // this table, this fails and says which one.
    const client = await freshDatabase('adb_columns', { preMigration: true });
    try {
      await client.query(migrationSql);
      const columns = await client.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'pilot' and table_name = 'athlete_development_blocks'
         order by column_name`,
      );
      const names = columns.rows.map((row) => row.column_name);
      expect(names).toEqual([
        'athlete_id', 'block_id', 'created_at', 'created_by_account_id',
        'ends_on', 'organization_id', 'starts_on', 'status', 'title',
        'training_emphasis', 'updated_at',
      ]);
      for (const forbidden of [
        'readiness', 'physical_score', 'mental_score', 'load', 'fatigue',
        'injury_risk', 'compliance', 'adherence', 'taper', 'progression', 'score',
      ]) {
        expect(names.filter((name) => name.includes(forbidden))).toEqual([]);
      }
    } finally {
      await client.end();
    }
  });

  test('a window that ends before it begins is refused by the database', async () => {
    const client = await freshDatabase('adb_dates', { preMigration: true });
    try {
      await client.query(migrationSql);

      await expect(
        insertBlock(client, 'block-backwards', { starts_on: '2026-10-14', ends_on: '2026-09-02' }),
      ).rejects.toMatchObject({ code: '23514' });

      // One day off is still refused -- the boundary is not approximate.
      await expect(
        insertBlock(client, 'block-one-day-short', { starts_on: '2026-09-03', ends_on: '2026-09-02' }),
      ).rejects.toMatchObject({ code: '23514' });

      // A single-day block is legal: ends_on may EQUAL starts_on.
      await insertBlock(client, 'block-one-day', { starts_on: '2026-09-02', ends_on: '2026-09-02' });

      // Neither date is optional. A plan with no stated end is not a block.
      await expect(
        client.query(
          `insert into pilot.athlete_development_blocks
             (organization_id, block_id, athlete_id, title, training_emphasis, starts_on, created_by_account_id)
           values ($1, 'block-open-ended', $2, 'Open ended', $3, '2026-09-02'::date, $4)`,
          [ORG_ID, ATHLETE_ID, EMPHASIS, COACH_ID],
        ),
      ).rejects.toMatchObject({ code: '23502' });
    } finally {
      await client.end();
    }
  });

  test('the lifecycle vocabulary is a database fact, and draft is the default', async () => {
    const client = await freshDatabase('adb_status', { preMigration: true });
    try {
      await client.query(migrationSql);

      for (const status of ['draft', 'active', 'completed', 'cancelled']) {
        await insertBlock(client, `block-${status}`, { status });
      }

      // Neighbouring vocabularies from other tables in this schema are not
      // this table's, and neither is an invented one.
      for (const status of ['archived', 'superseded', 'retired', 'in_progress', 'planned', 'ACTIVE', '']) {
        await expect(insertBlock(client, `block-bad-${status || 'blank'}`, { status }))
          .rejects.toMatchObject({ code: '23514' });
      }

      const defaulted = await client.query(
        `select status from pilot.athlete_development_blocks where block_id = 'block-draft'`,
      );
      expect(defaulted.rows).toEqual([{ status: 'draft' }]);
    } finally {
      await client.end();
    }
  });

  test('a block with no title or no stated emphasis is refused', async () => {
    const client = await freshDatabase('adb_content', { preMigration: true });
    try {
      await client.query(migrationSql);

      await expect(insertBlock(client, 'block-untitled', { title: '   ' }))
        .rejects.toMatchObject({ code: '23514' });
      await expect(insertBlock(client, 'block-no-emphasis', { training_emphasis: '' }))
        .rejects.toMatchObject({ code: '23514' });

      // Whitespace that is not a space. `length(btrim(x)) > 0` -- the
      // one-argument spelling used elsewhere in this directory -- trims
      // SPACES ONLY and accepted both of these, while every JavaScript
      // caller's .trim() calls them empty. These two cases are why the
      // constraints name their character set explicitly.
      await expect(insertBlock(client, 'block-ws-emphasis', { training_emphasis: '\t\n ' }))
        .rejects.toMatchObject({ code: '23514' });
      await expect(insertBlock(client, 'block-ws-title', { title: '\r\n\t' }))
        .rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });

  test('tenancy is composite: a block cannot name an athlete in another organization', async () => {
    const client = await freshDatabase('adb_tenancy', { preMigration: true });
    try {
      await client.query(migrationSql);

      // Both directions. The athlete id is real; the pair is not.
      await expect(
        insertBlock(client, 'block-cross-a', { organization_id: OTHER_ORG_ID, athlete_id: ATHLETE_ID }),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        insertBlock(client, 'block-cross-b', { athlete_id: OTHER_ATHLETE_ID }),
      ).rejects.toMatchObject({ code: '23503' });

      // No orphan: an athlete id that exists nowhere is refused too.
      await expect(insertBlock(client, 'block-orphan', { athlete_id: 'ath-does-not-exist' }))
        .rejects.toMatchObject({ code: '23503' });

      // And athlete_id is not optional -- a block always belongs to someone.
      await expect(insertBlock(client, 'block-nobody', { athlete_id: null }))
        .rejects.toMatchObject({ code: '23502' });

      // A creator account that does not exist is refused: provenance is a
      // foreign key, not a free-text signature.
      await expect(insertBlock(client, 'block-ghost-author', { created_by_account_id: 'acct-ghost' }))
        .rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.end();
    }
  });

  test('a block cannot outlive the athlete it names', async () => {
    const client = await freshDatabase('adb_cascade', { preMigration: true });
    try {
      await client.query(migrationSql);
      await insertBlock(client, 'block-cascade');

      await client.query('delete from pilot.athletes where organization_id = $1 and athlete_id = $2', [
        ORG_ID, ATHLETE_ID,
      ]);

      const remaining = await client.query(
        'select block_id from pilot.athlete_development_blocks',
      );
      expect(remaining.rows).toEqual([]);
    } finally {
      await client.end();
    }
  });
});

describe('the module writing and reading blocks', () => {
  test('a coach records a block, and their words come back exactly as written', async () => {
    const client = await migratedDatabase('adb_mod_create');
    try {
      const created = await createDevelopmentBlock({
        actor: COACH,
        athleteId: ATHLETE_ID,
        title: '  Fall strength block  ',
        trainingEmphasis: EMPHASIS,
        startsOn: '2026-09-02',
        endsOn: '2026-10-14',
      });

      expect(created).toMatchObject({
        organization_id: ORG_ID,
        athlete_id: ATHLETE_ID,
        title: 'Fall strength block',
        training_emphasis: EMPHASIS,
        // A calendar day, handed back as the day the coach typed rather than
        // as an instant re-interpreted in the server's timezone.
        starts_on: '2026-09-02',
        ends_on: '2026-10-14',
        status: 'draft',
        // Provenance comes from the actor, not from a caller-supplied field.
        // There is no longer a createdByAccountId parameter to disagree with
        // the identity that was authorized.
        created_by_account_id: COACH_ID,
      });
    } finally {
      await client.end();
    }
  });

  test('the creator must hold an ACTIVE membership in the block\'s organization', async () => {
    const client = await migratedDatabase('adb_mod_membership');
    try {
      // A coach of another gym, presenting ORG_ID. The actor's own
      // organizationId is what every statement uses, so this is the shape a
      // confused-deputy route would produce.
      await expect(createDevelopmentBlock({
        actor: actorFor(OTHER_COACH_ID, 'coach', ORG_ID),
        athleteId: ATHLETE_ID,
        title: 'Borrowed authority',
        trainingEmphasis: EMPHASIS,
        startsOn: '2026-09-02',
        endsOn: '2026-10-14',
      })).rejects.toBeInstanceOf(ForbiddenError);

      // A former coach of THIS gym: the account still exists and its home
      // organization still reads as this one. The membership is what changed.
      await expect(createDevelopmentBlock({
        actor: LAPSED_COACH,
        athleteId: ATHLETE_ID,
        title: 'Lapsed authority',
        trainingEmphasis: EMPHASIS,
        startsOn: '2026-09-02',
        endsOn: '2026-10-14',
      })).rejects.toBeInstanceOf(ForbiddenError);

      const written = await client.query('select block_id from pilot.athlete_development_blocks');
      expect(written.rows).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('only admins and coaches may author (owner decision, 2026-08-28)', async () => {
    // The decision, enforced. Each account below holds an ACTIVE membership
    // in THIS organization -- the pre-decision floor accepted all three, and
    // an athlete filing their own development block is exactly what a block
    // is not. An athlete's own goals live in pilot.goals.
    //
    // The athlete actor here is the athlete the block would be ABOUT, so
    // this cannot be passing for the athlete-scoping reason: they can read
    // this athlete's record. The refusal has to come from the write rule.
    const client = await migratedDatabase('adb_write_roles');
    try {
      for (const actor of [ATHLETE, GUARDIAN, VOLUNTEER]) {
        await expect(createDevelopmentBlock({
          actor,
          athleteId: ATHLETE_ID,
          title: 'Not theirs to write',
          trainingEmphasis: EMPHASIS,
          startsOn: '2026-09-02',
          endsOn: '2026-10-14',
        })).rejects.toBeInstanceOf(ForbiddenError);
      }
      expect((await client.query('select block_id from pilot.athlete_development_blocks')).rows)
        .toEqual([]);

      // And the two roles that may, both writing successfully.
      for (const [index, actor] of [COACH, ADMIN].entries()) {
        const created = await createDevelopmentBlock({
          actor,
          athleteId: ATHLETE_ID,
          title: `Block ${index}`,
          trainingEmphasis: EMPHASIS,
          startsOn: '2026-09-02',
          endsOn: '2026-10-14',
        });
        expect(created?.created_by_account_id).toBe(actor.accountId);
      }
    } finally {
      await client.end();
    }
  });

  test('the write vocabulary is exactly admins and coaches', () => {
    // Pinned so widening it is a deliberate edit rather than a drift, and so
    // platform_owner staying out stays visible -- it is out on purpose, the
    // same way COMPETITION_WRITE_ROLES and LEAGUE_WRITE_ROLES leave it out.
    expect([...DEVELOPMENT_BLOCK_WRITE_ROLES]).toEqual(['coach', 'organization_admin', 'admin']);
  });

  test('a coach whose home organization is elsewhere may still author here, if their membership is active', async () => {
    // The multi-org case pilot.accounts.organization_id answers wrongly.
    // auth.ts asks the membership table for the same reason.
    //
    // This coach is coach of record for nobody here: they reach ATHLETE_ID
    // through a live coverage grant, which is how a substitute legitimately
    // works. Both halves have to hold -- the membership makes them a writer,
    // the coverage makes this athlete reachable.
    const client = await migratedDatabase('adb_mod_visiting');
    try {
      const home = await client.query(
        'select organization_id from pilot.accounts where account_id = $1',
        [VISITING_COACH_ID],
      );
      expect(home.rows).toEqual([{ organization_id: OTHER_ORG_ID }]);

      const created = await createDevelopmentBlock({
        actor: VISITING_COACH,
        athleteId: ATHLETE_ID,
        title: 'Visiting coach block',
        trainingEmphasis: EMPHASIS,
        startsOn: '2026-09-02',
        endsOn: '2026-10-14',
      });
      expect(created?.created_by_account_id).toBe(VISITING_COACH_ID);

      // Coverage is per athlete, not a roster pass: the same coach cannot
      // author for the athlete they were not granted.
      await expect(createDevelopmentBlock({
        actor: VISITING_COACH,
        athleteId: SECOND_ATHLETE_ID,
        title: 'Beyond the grant',
        trainingEmphasis: EMPHASIS,
        startsOn: '2026-09-02',
        endsOn: '2026-10-14',
      })).resolves.toBeNull();
    } finally {
      await client.end();
    }
  });

  test('an athlete in another organization is a hidden not-found, and writes nothing', async () => {
    const client = await migratedDatabase('adb_mod_athlete');
    try {
      // Null rather than a distinguishable error: a caller cannot use this
      // path to learn that the athlete id is real somewhere else.
      await expect(createDevelopmentBlock({
        actor: COACH,
        athleteId: OTHER_ATHLETE_ID,
        title: 'Someone else\'s athlete',
        trainingEmphasis: EMPHASIS,
        startsOn: '2026-09-02',
        endsOn: '2026-10-14',
      })).resolves.toBeNull();

      await expect(createDevelopmentBlock({
        actor: COACH,
        athleteId: 'ath-never-existed',
        title: 'Nobody at all',
        trainingEmphasis: EMPHASIS,
        startsOn: '2026-09-02',
        endsOn: '2026-10-14',
      })).resolves.toBeNull();

      const written = await client.query('select block_id from pilot.athlete_development_blocks');
      expect(written.rows).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('a coach of this gym who is not this athlete\'s coach cannot author for them', async () => {
    /* THE COST OF THE READ DECISION, stated as a test rather than left for a
       route to discover.

       Before reads became athlete-scoped, ANY active-membership coach of the
       gym could author a block for ANY athlete in it. They no longer can:
       createDevelopmentBlock resolves the athlete through the same
       chokepoint the reads use, so a coach reaches their own athletes and
       anyone they are actively covering, and nobody else.

       This is not an extra rule bolted onto the write. It is what keeps the
       write coherent: getDevelopmentBlock is athlete-scoped, and
       createDevelopmentBlock returns its result, so an author who could not
       read would have written a row and been handed null for it. */
    const client = await migratedDatabase('adb_mod_unassigned');
    try {
      await expect(createDevelopmentBlock({
        actor: UNASSIGNED_COACH,
        athleteId: ATHLETE_ID,
        title: 'Not my athlete',
        trainingEmphasis: EMPHASIS,
        startsOn: '2026-09-02',
        endsOn: '2026-10-14',
      })).resolves.toBeNull();

      // Nothing was written: the refusal precedes the insert rather than
      // rolling one back.
      expect((await client.query('select block_id from pilot.athlete_development_blocks')).rows)
        .toEqual([]);

      // And the control: this coach IS a writer here. Give them an athlete
      // and the same call succeeds, so the null above means "not yours"
      // rather than "not a coach".
      await client.query(
        'update pilot.athletes set coach_id = $1 where organization_id = $2 and athlete_id = $3',
        [UNASSIGNED_COACH_ID, ORG_ID, SECOND_ATHLETE_ID],
      );
      const created = await createDevelopmentBlock({
        actor: UNASSIGNED_COACH,
        athleteId: SECOND_ATHLETE_ID,
        title: 'Now my athlete',
        trainingEmphasis: EMPHASIS,
        startsOn: '2026-09-02',
        endsOn: '2026-10-14',
      });
      expect(created?.athlete_id).toBe(SECOND_ATHLETE_ID);
    } finally {
      await client.end();
    }
  });

  test('an unsound block is refused before it reaches the database', async () => {
    const client = await migratedDatabase('adb_mod_shape');
    try {
      const base = {
        actor: COACH,
        athleteId: ATHLETE_ID,
        title: 'Backwards block',
        trainingEmphasis: EMPHASIS,
        startsOn: '2026-10-14',
        endsOn: '2026-09-02',
      };
      await expect(createDevelopmentBlock(base)).rejects.toBeInstanceOf(ValidationError);
      await expect(createDevelopmentBlock({ ...base, startsOn: '2026-09-02', endsOn: '2026-02-30' }))
        .rejects.toBeInstanceOf(ValidationError);
      await expect(createDevelopmentBlock({
        ...base, startsOn: '2026-09-02', endsOn: '2026-10-14', trainingEmphasis: '  ',
      })).rejects.toBeInstanceOf(ValidationError);

      const written = await client.query('select block_id from pilot.athlete_development_blocks');
      expect(written.rows).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('a human moves a block through its lifecycle, and an invented state is refused', async () => {
    const client = await migratedDatabase('adb_mod_lifecycle');
    try {
      const created = await createDevelopmentBlock({
        actor: COACH,
        athleteId: ATHLETE_ID,
        title: 'Fall strength block',
        trainingEmphasis: EMPHASIS,
        startsOn: '2026-09-02',
        endsOn: '2026-10-14',
      });
      const blockId = created!.block_id;

      expect((await setDevelopmentBlockStatus(COACH, blockId, 'active'))?.status).toBe('active');
      expect((await setDevelopmentBlockStatus(COACH, blockId, 'completed'))?.status).toBe('completed');

      await expect(setDevelopmentBlockStatus(COACH, blockId, 'archived' as never))
        .rejects.toBeInstanceOf(ValidationError);

      // Nothing in this module advances a block on its own: a window that has
      // elapsed is not a block that was completed, and only a coach can say
      // which happened.
      const unchanged = await getDevelopmentBlock(COACH, blockId);
      expect(unchanged?.status).toBe('completed');
    } finally {
      await client.end();
    }
  });

  test('reading a block does not confer moving it', async () => {
    /* The hole the read decision opened, closed. An athlete and their
       guardian can now READ this block; marking it 'completed' is a coach's
       judgment about whether the work was done, and this table exists
       precisely because the platform refuses to compute that. So the status
       setter carries the same write gate the author does. */
    const client = await migratedDatabase('adb_mod_status_gate');
    try {
      const created = await createDevelopmentBlock({
        actor: COACH,
        athleteId: ATHLETE_ID,
        title: 'Fall strength block',
        trainingEmphasis: EMPHASIS,
        startsOn: '2026-09-02',
        endsOn: '2026-10-14',
      });
      const blockId = created!.block_id;

      // Each of these can read the block -- proven on the line above the
      // refusal, so a failure cannot be dismissed as "they could not see it".
      for (const actor of [ATHLETE, GUARDIAN]) {
        expect((await getDevelopmentBlock(actor, blockId))?.block_id).toBe(blockId);
        await expect(setDevelopmentBlockStatus(actor, blockId, 'completed'))
          .rejects.toBeInstanceOf(ForbiddenError);
      }

      const untouched = await client.query(
        'select status from pilot.athlete_development_blocks where block_id = $1',
        [blockId],
      );
      expect(untouched.rows).toEqual([{ status: 'draft' }]);
    } finally {
      await client.end();
    }
  });
});

describe('reads reach exactly the people who can already reach the athlete', () => {
  /* THE OWNER DECISION OF 2026-08-28 -- "Admin, Coach, Athlete, Guardian" --
     as behavior rather than as a role list.

     Each case pairs the arm that must PASS with the near-miss that must
     FAIL, because an implementation that authorized everybody would satisfy
     every passing assertion on its own. All four reads are exercised for
     each actor: a rule enforced in three of four functions is not enforced.

     Nothing here is a fifth role. The module writes no role list of its own;
     it calls assertActorCanAccessAthlete, and these are that function's own
     four arms observed through this table. */

  async function seeded(name: string): Promise<Client> {
    const client = await migratedDatabase(name);
    await insertBlock(client, 'block-mine');
    await insertBlock(client, 'block-theirs-same-gym', { athlete_id: SECOND_ATHLETE_ID });
    return client;
  }

  test('an organization admin reads the whole gym, and nothing outside it', async () => {
    const client = await seeded('adb_read_admin');
    try {
      expect((await getDevelopmentBlock(ADMIN, 'block-mine'))?.block_id).toBe('block-mine');
      expect((await listDevelopmentBlocks(ADMIN)).map((row) => row.block_id).sort())
        .toEqual(['block-mine', 'block-theirs-same-gym']);
      expect((await listDevelopmentBlocksForAthlete(ADMIN, SECOND_ATHLETE_ID)).map((r) => r.block_id))
        .toEqual(['block-theirs-same-gym']);

      // The near-miss: an admin of the OTHER gym, who is an admin in the
      // same sense and reaches none of this.
      expect(await getDevelopmentBlock(OTHER_ADMIN, 'block-mine')).toBeNull();
      expect(await listDevelopmentBlocks(OTHER_ADMIN)).toEqual([]);
      expect(await listDevelopmentBlocksForAthlete(OTHER_ADMIN, ATHLETE_ID)).toEqual([]);
      expect(await setDevelopmentBlockStatus(OTHER_ADMIN, 'block-mine', 'cancelled')).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('a coach reads their own athletes and whoever they are covering, and no one else', async () => {
    const client = await seeded('adb_read_coach');
    try {
      // Coach of record for both athletes here.
      expect((await listDevelopmentBlocks(COACH)).map((row) => row.block_id).sort())
        .toEqual(['block-mine', 'block-theirs-same-gym']);

      // The covering coach reaches the granted athlete and only them --
      // the same gym, the same active membership, one athlete.
      expect((await getDevelopmentBlock(VISITING_COACH, 'block-mine'))?.block_id).toBe('block-mine');
      expect(await getDevelopmentBlock(VISITING_COACH, 'block-theirs-same-gym')).toBeNull();
      expect((await listDevelopmentBlocks(VISITING_COACH)).map((row) => row.block_id))
        .toEqual(['block-mine']);

      // The near-miss: a coach of this gym, active membership, assigned to
      // nobody and covering nobody.
      expect(await getDevelopmentBlock(UNASSIGNED_COACH, 'block-mine')).toBeNull();
      expect(await listDevelopmentBlocks(UNASSIGNED_COACH)).toEqual([]);
      expect(await listDevelopmentBlocksForAthlete(UNASSIGNED_COACH, ATHLETE_ID)).toEqual([]);
      // A writer here by role, and still not for this athlete: the status
      // setter answers null rather than moving a block they cannot read.
      expect(await setDevelopmentBlockStatus(UNASSIGNED_COACH, 'block-mine', 'cancelled')).toBeNull();

      // An expired grant stops working with no cleanup job: this is the
      // whole reason coverage is checked against now() at read time.
      await client.query(
        `update pilot.coach_coverage set starts_at = now() - interval '2 days',
                expires_at = now() - interval '1 day'
         where covering_coach_id = $1`,
        [VISITING_COACH_ID],
      );
      expect(await getDevelopmentBlock(VISITING_COACH, 'block-mine')).toBeNull();
      expect(await listDevelopmentBlocks(VISITING_COACH)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('an athlete reads their own blocks and not another athlete\'s', async () => {
    const client = await seeded('adb_read_athlete');
    try {
      expect((await getDevelopmentBlock(ATHLETE, 'block-mine'))?.block_id).toBe('block-mine');
      expect((await listDevelopmentBlocks(ATHLETE)).map((row) => row.block_id)).toEqual(['block-mine']);
      expect((await listDevelopmentBlocksForAthlete(ATHLETE, ATHLETE_ID)).map((r) => r.block_id))
        .toEqual(['block-mine']);

      // The near-miss: the other athlete of the same gym, same role, same
      // membership -- reading only their own.
      expect(await getDevelopmentBlock(SECOND_ATHLETE, 'block-mine')).toBeNull();
      expect((await listDevelopmentBlocks(SECOND_ATHLETE)).map((row) => row.block_id))
        .toEqual(['block-theirs-same-gym']);
      expect(await listDevelopmentBlocksForAthlete(ATHLETE, SECOND_ATHLETE_ID)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('a linked guardian reads their child\'s blocks; an unlinked parent of the same gym reads none', async () => {
    const client = await seeded('adb_read_guardian');
    try {
      expect((await getDevelopmentBlock(GUARDIAN, 'block-mine'))?.block_id).toBe('block-mine');
      expect((await listDevelopmentBlocks(GUARDIAN)).map((row) => row.block_id)).toEqual(['block-mine']);
      // Linked to ATHLETE_ID only, so the gym's other athlete is not theirs.
      expect(await getDevelopmentBlock(GUARDIAN, 'block-theirs-same-gym')).toBeNull();

      // The near-miss: a parent account of this gym with a real pilot.parents
      // row and no guardian_link. Without this, every assertion above would
      // hold for an implementation that let any parent read any athlete.
      expect(await getDevelopmentBlock(UNLINKED_GUARDIAN, 'block-mine')).toBeNull();
      expect(await listDevelopmentBlocks(UNLINKED_GUARDIAN)).toEqual([]);
      expect(await listDevelopmentBlocksForAthlete(UNLINKED_GUARDIAN, ATHLETE_ID)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('platform_owner and board are refused, as they are everywhere else', async () => {
    // Not a rule this module invented: assertActorCanAccessAthlete refuses
    // both unconditionally, and this proves the block reads inherited that
    // rather than quietly widening it. The board reads organization-level
    // aggregates; a named minor's training plan is not one.
    const client = await seeded('adb_read_refused');
    try {
      for (const actor of [PLATFORM_OWNER, BOARD]) {
        expect(await getDevelopmentBlock(actor, 'block-mine')).toBeNull();
        expect(await listDevelopmentBlocks(actor)).toEqual([]);
        expect(await listDevelopmentBlocksForAthlete(actor, ATHLETE_ID)).toEqual([]);
      }
    } finally {
      await client.end();
    }
  });

  test('a soft-deleted athlete drops out of the staff and guardian reads -- and NOT out of their own', async () => {
    /* The #706 / #690 shape, inherited rather than re-implemented: deletion
       writes deleted_at and the authorization queries require a live row.
       This suite would have had no way to notice either half if it had
       hand-picked its migrations -- athletes.deleted_at belongs to a
       migration it never names.

       THE SECOND HALF IS A FINDING, NOT A DESIGN. Three of
       assertActorCanAccessAthlete's four arms ask the database and so
       inherit the filter. The athlete arm does not ask it at all -- it
       compares actor.athleteId to the requested id in memory and returns --
       so a withdrawn athlete keeps reading their own blocks. That is
       access.ts's behavior for all 92 of its callers, not something this
       slice introduced, and softDeletedAthleteAccess.pg.test.ts covers the
       admin, coach and guardian arms and not this one.

       It is asserted here rather than fixed here for two reasons. Fixing it
       means changing the chokepoint every athlete-facing surface calls,
       inside a PR about development blocks. And whether a withdrawn athlete
       keeps reading their OWN record is an owner decision with a real
       argument on each side (retention says no, data portability says yes),
       not a defect with one obvious repair. Recorded as an open question on
       module 036; if the answer is "no", the fix is one predicate in
       access.ts and this test flips to the refusal. */
    const client = await seeded('adb_read_deleted');
    try {
      for (const actor of [ADMIN, COACH, ATHLETE, GUARDIAN]) {
        expect((await getDevelopmentBlock(actor, 'block-mine'))?.block_id).toBe('block-mine');
      }

      await client.query(
        'update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2',
        [ORG_ID, ATHLETE_ID],
      );

      for (const actor of [ADMIN, COACH, GUARDIAN]) {
        expect(await getDevelopmentBlock(actor, 'block-mine')).toBeNull();
        expect(await listDevelopmentBlocksForAthlete(actor, ATHLETE_ID)).toEqual([]);
        expect((await listDevelopmentBlocks(actor)).map((row) => row.block_id))
          .not.toContain('block-mine');
      }

      // The gap, stated as behavior so it cannot be forgotten or misread as
      // covered. If access.ts's athlete arm gains the deleted_at predicate,
      // this assertion fails and points at the decision that changed.
      expect((await getDevelopmentBlock(ATHLETE, 'block-mine'))?.block_id).toBe('block-mine');
      expect((await listDevelopmentBlocks(ATHLETE)).map((row) => row.block_id))
        .toEqual(['block-mine']);

      // The row itself is untouched: this is an access rule, not a delete.
      const stored = await client.query(
        'select block_id from pilot.athlete_development_blocks where block_id = $1',
        ['block-mine'],
      );
      expect(stored.rows).toEqual([{ block_id: 'block-mine' }]);
    } finally {
      await client.end();
    }
  });
});

describe('one gym cannot reach another gym through any read this slice adds', () => {
  test('every read path is organization-scoped', async () => {
    const client = await migratedDatabase('adb_isolation');
    try {
      // A real block in each gym, inserted directly so the reads below are
      // the only thing under test.
      await insertBlock(client, 'block-ours');
      await insertBlock(client, 'block-theirs', {
        organization_id: OTHER_ORG_ID,
        athlete_id: OTHER_ATHLETE_ID,
        created_by_account_id: OTHER_COACH_ID,
      });

      // getDevelopmentBlock: the other gym's block id is a real id, and
      // reads as absent from here.
      expect(await getDevelopmentBlock(ADMIN, 'block-theirs')).toBeNull();
      expect(await getDevelopmentBlock(OTHER_ADMIN, 'block-ours')).toBeNull();
      expect((await getDevelopmentBlock(ADMIN, 'block-ours'))?.block_id).toBe('block-ours');

      // listDevelopmentBlocks: one gym's listing contains only its own.
      expect((await listDevelopmentBlocks(ADMIN)).map((row) => row.block_id)).toEqual(['block-ours']);
      expect((await listDevelopmentBlocks(OTHER_ADMIN)).map((row) => row.block_id)).toEqual(['block-theirs']);

      // listDevelopmentBlocksForAthlete: an athlete id alone is not a key
      // into this table -- only the (organization, athlete) pair is.
      expect(await listDevelopmentBlocksForAthlete(ADMIN, OTHER_ATHLETE_ID)).toEqual([]);
      expect(await listDevelopmentBlocksForAthlete(OTHER_ADMIN, ATHLETE_ID)).toEqual([]);
      expect((await listDevelopmentBlocksForAthlete(ADMIN, ATHLETE_ID)).map((row) => row.block_id))
        .toEqual(['block-ours']);

      // setDevelopmentBlockStatus: the update cannot be used to probe for,
      // or to touch, another gym's block.
      expect(await setDevelopmentBlockStatus(ADMIN, 'block-theirs', 'cancelled')).toBeNull();
      const theirs = await client.query(
        'select status from pilot.athlete_development_blocks where block_id = $1',
        ['block-theirs'],
      );
      expect(theirs.rows).toEqual([{ status: 'draft' }]);
    } finally {
      await client.end();
    }
  });

  test('an athlete\'s own history is theirs alone, newest window first', async () => {
    const client = await migratedDatabase('adb_athlete_history');
    try {
      await insertBlock(client, 'block-spring', { starts_on: '2026-03-01', ends_on: '2026-04-12' });
      await insertBlock(client, 'block-fall', { starts_on: '2026-09-02', ends_on: '2026-10-14' });
      await insertBlock(client, 'block-other-athlete', { athlete_id: SECOND_ATHLETE_ID });

      expect((await listDevelopmentBlocksForAthlete(ADMIN, ATHLETE_ID)).map((row) => row.block_id))
        .toEqual(['block-fall', 'block-spring']);
      expect((await listDevelopmentBlocksForAthlete(ADMIN, SECOND_ATHLETE_ID)).map((row) => row.block_id))
        .toEqual(['block-other-athlete']);
    } finally {
      await client.end();
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// Every case above applies `migrationSql` with a plain `client.query`, which
// proves the schema and proves nothing about
// scripts/pilot-apply-athlete-development-blocks-migration.mjs's
// READINESS_QUERY -- the assertion that gates the dispatch, and the code
// whose first real execution would otherwise be against a live environment at
// the most expensive possible moment. #488 is what that costs: an assertion
// that could not pass on ANY database, found only by a staging dispatch it
// then blocked. The inverse -- an assertion that can never FAIL -- is quieter
// and worse, so the refusal case comes first.
//
// The query is never restated here. `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so this
// cannot stay green while the runner rots.
describe('athlete development blocks runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('adb_rdy_no', { preMigration: true });
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /ATHLETE_DEVELOPMENT_BLOCKS_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('adb_rdy_ok', { preMigration: true });
    try {
      await applyMigrationTransaction(client, migrationSql);
      // The `all` chain re-runs every migration on every dispatch (#489), so
      // the second pass has to survive its own first pass.
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });
});


/*
 * CORRECTING A BLOCK.
 *
 * updateDevelopmentBlock arrived with the coach API (the foundation shipped
 * with status changes only), and it is the one write here that reads the row
 * before writing it. Three properties need real rows to prove:
 *
 *   - the window is validated against the MERGED row, so moving only one end
 *     past the other is refused. A patch-only check cannot see that, and it is
 *     the edit most likely to be attempted.
 *   - a patch omitting a field leaves it alone rather than blanking it -- the
 *     failure a whole-row write has by construction, and the database's own
 *     NOT NULL / CHECK constraints are what a blanking bug would collide with.
 *   - the organization is part of the key, so a block in another gym is not
 *     found and cannot be probed for.
 */
describe('the module correcting a block (real database)', () => {
  async function seed(client: Client) {
    const created = await createDevelopmentBlock({
      actor: COACH,
      athleteId: ATHLETE_ID,
      title: 'Fall strength block',
      trainingEmphasis: EMPHASIS,
      startsOn: '2026-09-02',
      endsOn: '2026-10-14',
    });
    if (!created) throw new Error('test bug: seed block was not created');
    void client;
    return created;
  }

  test('a partial patch changes only what it names', async () => {
    const client = await migratedDatabase('adb_upd_partial');
    try {
      const created = await seed(client);

      const updated = await updateDevelopmentBlock(COACH, created.block_id, {
        endsOn: '2026-11-04',
      });

      expect(updated).toMatchObject({
        block_id: created.block_id,
        title: 'Fall strength block',
        training_emphasis: EMPHASIS,
        starts_on: '2026-09-02',
        ends_on: '2026-11-04',
        status: 'draft',
      });
    } finally {
      await client.end();
    }
  });

  test('the window is validated against the merged row, not the patch', async () => {
    // Moving ONLY the start past an untouched end. Nothing in the patch is
    // wrong on its own; the row it would produce is.
    const client = await migratedDatabase('adb_upd_window');
    try {
      const created = await seed(client);

      await expect(updateDevelopmentBlock(COACH, created.block_id, { startsOn: '2026-12-01' }))
        .rejects.toBeInstanceOf(ValidationError);

      // And the stored row is untouched.
      const after = await getDevelopmentBlock(COACH, created.block_id);
      expect(after).toMatchObject({ starts_on: '2026-09-02', ends_on: '2026-10-14' });
    } finally {
      await client.end();
    }
  });

  test('an emphasis cannot be blanked, by patch or by whitespace', async () => {
    const client = await migratedDatabase('adb_upd_blank');
    try {
      const created = await seed(client);

      await expect(updateDevelopmentBlock(COACH, created.block_id, { trainingEmphasis: '   ' }))
        .rejects.toBeInstanceOf(ValidationError);
      await expect(updateDevelopmentBlock(COACH, created.block_id, { title: '\t\n' }))
        .rejects.toBeInstanceOf(ValidationError);

      const after = await getDevelopmentBlock(COACH, created.block_id);
      expect(after?.training_emphasis).toBe(EMPHASIS);
      expect(after?.title).toBe('Fall strength block');
    } finally {
      await client.end();
    }
  });

  test('the creator and the athlete survive every correction', async () => {
    // Attribution is a fact about the past, and a block does not change which
    // child it is about. Neither is reachable through this function's input
    // type; this proves the row agrees.
    const client = await migratedDatabase('adb_upd_attribution');
    try {
      const created = await seed(client);

      await updateDevelopmentBlock(COACH, created.block_id, {
        title: 'Renamed',
        trainingEmphasis: 'Different emphasis entirely.',
        startsOn: '2026-09-10',
        endsOn: '2026-11-20',
        status: 'active',
      });

      const after = await getDevelopmentBlock(COACH, created.block_id);
      expect(after).toMatchObject({
        created_by_account_id: COACH_ID,
        athlete_id: ATHLETE_ID,
        organization_id: ORG_ID,
        title: 'Renamed',
        status: 'active',
      });
      // created_at comes back as a driver Date (FIELDS casts only the two
      // calendar dates to text), so this compares the instant rather than the
      // object -- toBe would be an identity check that can never hold.
      expect(String(after?.created_at)).toBe(String(created.created_at));
    } finally {
      await client.end();
    }
  });

  test('a block in another organization is not found, and is not written', async () => {
    const client = await migratedDatabase('adb_upd_tenancy');
    try {
      const created = await seed(client);

      expect(await updateDevelopmentBlock(OTHER_ADMIN, created.block_id, { title: 'Reached across' }))
        .toBeNull();

      const after = await getDevelopmentBlock(COACH, created.block_id);
      expect(after?.title).toBe('Fall strength block');
    } finally {
      await client.end();
    }
  });

  test('a block id that does not exist is not found either -- the two are indistinguishable', async () => {
    const client = await migratedDatabase('adb_upd_missing');
    try {
      expect(await updateDevelopmentBlock(COACH, 'blk-never-existed', { title: 'T' })).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('an empty patch is a no-op that still returns the row', async () => {
    const client = await migratedDatabase('adb_upd_empty');
    try {
      const created = await seed(client);

      const updated = await updateDevelopmentBlock(COACH, created.block_id, {});

      expect(updated).toMatchObject({
        title: 'Fall strength block',
        training_emphasis: EMPHASIS,
        starts_on: '2026-09-02',
        ends_on: '2026-10-14',
        status: 'draft',
      });
    } finally {
      await client.end();
    }
  });

  test('nothing advances a status on its own, however long ago the window closed', async () => {
    // "The window has elapsed" and "the plan was carried out" are different
    // claims, and only a coach makes the second one.
    const client = await migratedDatabase('adb_upd_no_auto');
    try {
      const created = await createDevelopmentBlock({
        actor: COACH,
        athleteId: ATHLETE_ID,
        title: 'Long finished',
        trainingEmphasis: EMPHASIS,
        startsOn: '2020-01-01',
        endsOn: '2020-02-01',
        status: 'active',
      });

      const reread = await getDevelopmentBlock(COACH, created!.block_id);
      expect(reread?.status).toBe('active');

      const touched = await updateDevelopmentBlock(COACH, created!.block_id, { title: 'Long finished, renamed' });
      expect(touched?.status).toBe('active');
    } finally {
      await client.end();
    }
  });

  test('correcting a block is authoring it, so a reader cannot do it', async () => {
    /* NEW WITH THE READ DECISION. When this function arrived, its only
       caller was a route that had already refused everyone but a coach and
       an admin, so an ungated module function was survivable. It is not
       survivable now: an athlete and their guardian can READ a block, and an
       ungated corrector would let them rewrite the coach's stated emphasis
       -- the one field this whole table exists to preserve verbatim.

       Each refusal is preceded by the read that proves the actor could see
       the row, so a failure cannot be dismissed as "they never had access". */
    const client = await migratedDatabase('adb_upd_write_gate');
    try {
      const created = await seed(client);

      for (const actor of [ATHLETE, GUARDIAN]) {
        expect((await getDevelopmentBlock(actor, created.block_id))?.block_id).toBe(created.block_id);
        await expect(updateDevelopmentBlock(actor, created.block_id, { title: 'Mine now' }))
          .rejects.toBeInstanceOf(ForbiddenError);
      }

      // A coach of this gym who is not this athlete's coach is a writer by
      // role and still not for this block: null, not Forbidden, and not a
      // write.
      expect(await updateDevelopmentBlock(UNASSIGNED_COACH, created.block_id, { title: 'Not mine' }))
        .toBeNull();

      const after = await getDevelopmentBlock(COACH, created.block_id);
      expect(after?.title).toBe('Fall strength block');
      expect(after?.training_emphasis).toBe(EMPHASIS);
    } finally {
      await client.end();
    }
  });
});
