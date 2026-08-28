// Real PostgreSQL-backed contract test for the athlete development block ->
// competition/event target migration (module 036, Open Question 2 answered (a)).
//
// WHAT NEEDS REAL ROWS HERE. Everything this migration adds is a database
// rule, and every one of them is invisible to a unit test:
//
//   * the two composite foreign keys -- a block cannot target an event in
//     another gym. Not "should not": cannot. That is provable only against a
//     database that will actually refuse the insert.
//   * the single-target check -- a block may name a competition OR a wrestling
//     event OR neither, never both.
//   * idempotency -- the `all` chain re-runs every migration on every dispatch
//     (#489), so this has to survive its own second pass, including the
//     constraint adds, which have no `if not exists` shorthand and are guarded
//     by catalogue lookups instead.
//   * the runner's readiness gate failing on a database this migration never
//     reached. A widening migration makes that easy to get wrong: asserting
//     the TABLE exists would pass on every database that has the foundation,
//     which is all of them, and the gate would be decoration.
//
// The pre-state is built by hand from this migration's own DEPENDS ON line
// rather than by applyFullSchema, which applies every migration including this
// one and therefore cannot build a database that lacks it.
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

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-adb-competition-target-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_athlete_development_block_competition_target_migration.sql';

/* This migration's own DEPENDS ON line, made executable: the table it widens
   and the two tables it points at. Applied on top of the base schema to build
   the PRE-state -- a database that has the foundation and both competition
   surfaces but has never seen this widening. That pre-state is the only place
   the runner's readiness gate can be shown to fail, which is the property
   migrationReadinessGates.pg.test.ts holds runners to.

   Hand-picked deliberately and narrowly, unlike a feature suite: applyFullSchema
   applies EVERY migration including this one, so it cannot build a database
   this migration has not reached. */
const PREREQUISITE_FILES = [
  'pilot_slice_postgres_external_competition_migration.sql',
  'pilot_slice_postgres_wrestling_league_migration.sql',
  'pilot_slice_postgres_athlete_development_blocks_migration.sql',
] as const;
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-athlete-development-block-competition-target-migration.mjs',
);

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
const COACH_ID = 'acct-blocks-coach';
// Home organization here, membership deactivated: still an account, no
// longer a writer.
const LAPSED_COACH_ID = 'acct-blocks-lapsed';
// Home organization elsewhere, ACTIVE membership here. The multi-org case
// pilot.accounts.organization_id gets wrong.
const VISITING_COACH_ID = 'acct-blocks-visiting';
// Home organization elsewhere, membership only there.
const OTHER_COACH_ID = 'acct-blocks-other-coach';
const ATHLETE_ID = 'ath-blocks-1';
const SECOND_ATHLETE_ID = 'ath-blocks-2';
const OTHER_ATHLETE_ID = 'ath-blocks-other';

const EMPHASIS = 'Rebuild round-3 work rate; heavier legs, less volume on the bag.';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let baseSchemaSql: string;
let prerequisiteSql: string[];

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
 * Two gyms, five accounts with four different standings, and an athlete in
 * each gym. The membership rows are the point: every provenance assertion
 * below distinguishes an active membership from a deactivated one and from
 * the account's denormalized home organization.
 */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  for (const sql of prerequisiteSql) {
    await client.query(sql);
  }

  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }

  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $5, 'microsoft'),
            ($2, 'coach', $5, 'microsoft'),
            ($3, 'coach', $5, 'microsoft'),
            ($4, 'coach', $6, 'microsoft'),
            ($7, 'coach', $6, 'microsoft')
     on conflict do nothing`,
    [ADMIN_ID, COACH_ID, LAPSED_COACH_ID, VISITING_COACH_ID, ORG_ID, OTHER_ORG_ID, OTHER_COACH_ID],
  );

  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $5, 'organization_admin', true),
            ($2, $5, 'coach', true),
            ($3, $5, 'coach', false),
            ($4, $5, 'coach', true),
            ($4, $6, 'coach', true),
            ($7, $6, 'coach', true)
     on conflict do nothing`,
    [ADMIN_ID, COACH_ID, LAPSED_COACH_ID, VISITING_COACH_ID, ORG_ID, OTHER_ORG_ID, OTHER_COACH_ID],
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

  return client;
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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  prerequisiteSql = await Promise.all(
    PREREQUISITE_FILES.map((file) => fs.readFile(path.join(INFRA_DIR, file), 'utf8')),
  );
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;
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


const COMPETITION_ID = 'comp-target-1';
const OTHER_ORG_COMPETITION_ID = 'comp-elsewhere-1';
const SEASON_ID = 'season-target-1';
const EVENT_ID = 'evt-target-1';
const BLOCK_ID = 'blk-target-1';

/** A competition in the given organization. Skeletal, exactly as the table is. */
async function insertCompetition(
  client: Client,
  organizationId: string,
  competitionId: string,
  overrides: Record<string, string> = {},
) {
  await client.query(
    `insert into pilot.external_competitions
       (organization_id, competition_id, competition_name, competition_date,
        location, sanctioning_body, status, created_by_account_id)
     values ($1, $2, $3, $4::date, $5, $6, $7, $8)
     on conflict do nothing`,
    [
      organizationId,
      competitionId,
      overrides.competition_name ?? 'Keystone Open',
      overrides.competition_date ?? '2026-11-14',
      overrides.location ?? 'Altoona, PA',
      overrides.sanctioning_body ?? 'USA Boxing',
      overrides.status ?? 'planned',
      overrides.created_by_account_id ?? ADMIN_ID,
    ],
  );
}

async function insertWrestlingEvent(client: Client, organizationId: string, eventId: string) {
  await client.query(
    `insert into pilot.wrestling_league_seasons
       (organization_id, season_id, season_name, starts_on, ends_on, status, created_by_account_id)
     values ($1, $2, 'Winter Season', '2026-11-01'::date, '2027-02-01'::date, 'planned', $3)
     on conflict do nothing`,
    [organizationId, SEASON_ID, ADMIN_ID],
  );
  await client.query(
    `insert into pilot.wrestling_league_events
       (organization_id, event_id, season_id, event_name, event_date, location, status, created_by_account_id)
     values ($1, $2, $3, 'Punxsutawney Duals', '2026-12-06'::date, 'Punxsutawney, PA', 'planned', $4)
     on conflict do nothing`,
    [organizationId, eventId, SEASON_ID, ADMIN_ID],
  );
}

/** A block with no target, which is the ordinary shape. The foundation suite's
 *  own insertBlock is deliberately not carried over: this suite asserts the
 *  widening, not the foundation's column rules. */
async function insertBlock(
  client: Client,
  organizationId = ORG_ID,
  athleteId = ATHLETE_ID,
  blockId = BLOCK_ID,
) {
  await client.query(
    `insert into pilot.athlete_development_blocks
       (organization_id, block_id, athlete_id, title, training_emphasis,
        starts_on, ends_on, status, created_by_account_id)
     values ($1, $2, $3, 'Autumn block', $4,
             '2026-09-01'::date, '2026-11-10'::date, 'draft', $5)
     on conflict do nothing`,
    [organizationId, blockId, athleteId, EMPHASIS, COACH_ID],
  );
}

describe('the competition target migration itself', () => {
  test('adds both columns, both foreign keys, the check and both indexes', async () => {
    const client = await freshDatabase('adbct_fresh');
    try {
      await client.query(migrationSql);

      const columns = await client.query(
        `select column_name, is_nullable from information_schema.columns
         where table_schema = 'pilot' and table_name = 'athlete_development_blocks'
           and column_name in ('target_competition_id', 'target_wrestling_event_id')
         order by column_name`,
      );
      expect(columns.rows).toEqual([
        { column_name: 'target_competition_id', is_nullable: 'YES' },
        { column_name: 'target_wrestling_event_id', is_nullable: 'YES' },
      ]);

      const constraints = await client.query(
        `select conname from pg_constraint
         where conrelid = 'pilot.athlete_development_blocks'::regclass
           and conname like 'pilot_athlete_development_blocks_%target%'
         order by conname`,
      );
      expect(constraints.rows.map((row) => row.conname)).toEqual([
        'pilot_athlete_development_blocks_single_target_check',
        'pilot_athlete_development_blocks_target_competition_fk',
        'pilot_athlete_development_blocks_target_wrestling_event_fk',
      ]);

      const indexes = await client.query(
        `select indexname from pg_indexes
         where schemaname = 'pilot' and indexname like '%by_target%' order by indexname`,
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        'idx_athlete_development_blocks_by_target_competition',
        'idx_athlete_development_blocks_by_target_wrestling_event',
      ]);
    } finally {
      await client.end();
    }
  });

  test('a second pass is a no-op, constraint adds included', async () => {
    // The `all` chain re-runs every migration on every dispatch, so this has
    // to survive its own first pass. The constraint adds are the risk: there
    // is no `add constraint if not exists`, so they are guarded by hand.
    const client = await freshDatabase('adbct_noop');
    try {
      await client.query(migrationSql);
      await client.query(migrationSql);
      await client.query(migrationSql);

      const constraints = await client.query(
        `select count(*)::int as n from pg_constraint
         where conrelid = 'pilot.athlete_development_blocks'::regclass
           and conname like 'pilot_athlete_development_blocks_%target%'`,
      );
      expect(constraints.rows[0].n).toBe(3);
    } finally {
      await client.end();
    }
  });

  test('the foundation table survives the widening unchanged', async () => {
    // A widening that quietly dropped a constraint off the table it alters
    // would still pass every assertion about the columns it added.
    const client = await freshDatabase('adbct_foundation_intact');
    try {
      await client.query(migrationSql);

      const kept = await client.query(
        `select conname from pg_constraint
         where conrelid = 'pilot.athlete_development_blocks'::regclass
           and conname in (
             'pilot_athlete_development_blocks_status_check',
             'pilot_athlete_development_blocks_interval_check',
             'pilot_athlete_development_blocks_athlete_fk'
           )
         order by conname`,
      );
      expect(kept.rows.map((row) => row.conname)).toEqual([
        'pilot_athlete_development_blocks_athlete_fk',
        'pilot_athlete_development_blocks_interval_check',
        'pilot_athlete_development_blocks_status_check',
      ]);
    } finally {
      await client.end();
    }
  });
});

describe('what the database refuses (real rows)', () => {
  test('a block may name a competition, a wrestling event, or neither', async () => {
    const client = await freshDatabase('adbct_valid');
    try {
      await client.query(migrationSql);
      await insertCompetition(client, ORG_ID, COMPETITION_ID);
      await insertWrestlingEvent(client, ORG_ID, EVENT_ID);

      await insertBlock(client, ORG_ID, ATHLETE_ID, 'blk-none');
      await insertBlock(client, ORG_ID, ATHLETE_ID, 'blk-comp');
      await insertBlock(client, ORG_ID, ATHLETE_ID, 'blk-evt');

      await client.query(
        `update pilot.athlete_development_blocks set target_competition_id = $1
         where organization_id = $2 and block_id = 'blk-comp'`,
        [COMPETITION_ID, ORG_ID],
      );
      await client.query(
        `update pilot.athlete_development_blocks set target_wrestling_event_id = $1
         where organization_id = $2 and block_id = 'blk-evt'`,
        [EVENT_ID, ORG_ID],
      );

      const rows = await client.query(
        `select block_id, target_competition_id, target_wrestling_event_id
         from pilot.athlete_development_blocks where organization_id = $1 order by block_id`,
        [ORG_ID],
      );
      expect(rows.rows).toEqual([
        { block_id: 'blk-comp', target_competition_id: COMPETITION_ID, target_wrestling_event_id: null },
        { block_id: 'blk-evt', target_competition_id: null, target_wrestling_event_id: EVENT_ID },
        { block_id: 'blk-none', target_competition_id: null, target_wrestling_event_id: null },
      ]);
    } finally {
      await client.end();
    }
  });

  test('a block cannot name both at once', async () => {
    const client = await freshDatabase('adbct_both');
    try {
      await client.query(migrationSql);
      await insertCompetition(client, ORG_ID, COMPETITION_ID);
      await insertWrestlingEvent(client, ORG_ID, EVENT_ID);
      await insertBlock(client);

      await expect(client.query(
        `update pilot.athlete_development_blocks
         set target_competition_id = $1, target_wrestling_event_id = $2
         where organization_id = $3 and block_id = $4`,
        [COMPETITION_ID, EVENT_ID, ORG_ID, BLOCK_ID],
      )).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });

  test('a block cannot target a competition in another organization', async () => {
    // The composite FK is the whole point: the competition id is real, and
    // the PAIR is not.
    const client = await freshDatabase('adbct_cross_org_comp');
    try {
      await client.query(migrationSql);
      await insertCompetition(client, OTHER_ORG_ID, OTHER_ORG_COMPETITION_ID);
      await insertBlock(client);

      await expect(client.query(
        `update pilot.athlete_development_blocks set target_competition_id = $1
         where organization_id = $2 and block_id = $3`,
        [OTHER_ORG_COMPETITION_ID, ORG_ID, BLOCK_ID],
      )).rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.end();
    }
  });

  test('a block cannot target a wrestling event in another organization', async () => {
    const client = await freshDatabase('adbct_cross_org_evt');
    try {
      await client.query(migrationSql);
      await insertWrestlingEvent(client, OTHER_ORG_ID, 'evt-elsewhere-1');
      await insertBlock(client);

      await expect(client.query(
        `update pilot.athlete_development_blocks set target_wrestling_event_id = $1
         where organization_id = $2 and block_id = $3`,
        ['evt-elsewhere-1', ORG_ID, BLOCK_ID],
      )).rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.end();
    }
  });

  test('a block cannot target an event that does not exist at all', async () => {
    const client = await freshDatabase('adbct_orphan');
    try {
      await client.query(migrationSql);
      await insertBlock(client);

      await expect(client.query(
        `update pilot.athlete_development_blocks set target_competition_id = 'comp-never-existed'
         where organization_id = $1 and block_id = $2`,
        [ORG_ID, BLOCK_ID],
      )).rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.end();
    }
  });

  test('a targeted competition cannot be deleted out from under the plan', async () => {
    /* ON DELETE is deliberately the default rather than cascade or set null:
       cascade would delete a coach's whole multi-week plan because somebody
       removed a fixture, and set null would silently erase what it was aiming
       at. Neither competition module ships a delete path today, so this
       restricts nothing that exists -- it makes the question loud for whoever
       adds one. */
    const client = await freshDatabase('adbct_delete_guard');
    try {
      await client.query(migrationSql);
      await insertCompetition(client, ORG_ID, COMPETITION_ID);
      await insertBlock(client);
      await client.query(
        `update pilot.athlete_development_blocks set target_competition_id = $1
         where organization_id = $2 and block_id = $3`,
        [COMPETITION_ID, ORG_ID, BLOCK_ID],
      );

      await expect(client.query(
        `delete from pilot.external_competitions where organization_id = $1 and competition_id = $2`,
        [ORG_ID, COMPETITION_ID],
      )).rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.end();
    }
  });

  test('a cancelled competition keeps its blocks pointed at it', async () => {
    // Cancellation is a STATUS, and the coach was still preparing for it.
    const client = await freshDatabase('adbct_cancelled');
    try {
      await client.query(migrationSql);
      await insertCompetition(client, ORG_ID, COMPETITION_ID);
      await insertBlock(client);
      await client.query(
        `update pilot.athlete_development_blocks set target_competition_id = $1
         where organization_id = $2 and block_id = $3`,
        [COMPETITION_ID, ORG_ID, BLOCK_ID],
      );

      await client.query(
        `update pilot.external_competitions set status = 'cancelled'
         where organization_id = $1 and competition_id = $2`,
        [ORG_ID, COMPETITION_ID],
      );

      const row = await client.query(
        `select b.target_competition_id, c.status
         from pilot.athlete_development_blocks b
         join pilot.external_competitions c
           on c.organization_id = b.organization_id and c.competition_id = b.target_competition_id
         where b.organization_id = $1 and b.block_id = $2`,
        [ORG_ID, BLOCK_ID],
      );
      expect(row.rows[0]).toEqual({ target_competition_id: COMPETITION_ID, status: 'cancelled' });
    } finally {
      await client.end();
    }
  });

  test('a targeted block still cascades away with its athlete', async () => {
    /* The block's own athlete FK is ON DELETE CASCADE, and the new
       restrict-by-default target FKs must not obstruct it -- a restrict on one
       column can block a delete that another column's cascade was meant to
       carry out.

       This asserts the cascade that ACTUALLY exists on this table. An earlier
       draft asserted that deleting the organization cascaded everything away;
       measured, it does not, and never did: pilot.accounts.organization_id has
       no ON DELETE clause, so it refuses the organization delete before
       anything here is reached. That is a fact about the base schema, not
       about this migration, and asserting it would have been a test of a
       database that has never existed. */
    const client = await freshDatabase('adbct_athlete_cascade');
    try {
      await client.query(migrationSql);
      await insertCompetition(client, ORG_ID, COMPETITION_ID);
      await insertBlock(client);
      await client.query(
        `update pilot.athlete_development_blocks set target_competition_id = $1
         where organization_id = $2 and block_id = $3`,
        [COMPETITION_ID, ORG_ID, BLOCK_ID],
      );

      await client.query(
        'delete from pilot.athletes where organization_id = $1 and athlete_id = $2',
        [ORG_ID, ATHLETE_ID],
      );

      const blocks = await client.query(
        'select count(*)::int as n from pilot.athlete_development_blocks where organization_id = $1',
        [ORG_ID],
      );
      expect(blocks.rows[0].n).toBe(0);

      // And the competition it pointed at is untouched: a plan going away
      // does not take the gym's fixture with it.
      const competitions = await client.query(
        'select count(*)::int as n from pilot.external_competitions where organization_id = $1',
        [ORG_ID],
      );
      expect(competitions.rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });
});

/* The runner's readiness gate. Ordered refusal-first for the same reason the
   foundation suite gives: an assertion that can never FAIL is quieter and
   worse than one that can never pass. The query is never restated here --
   applyMigrationTransaction is imported out of the shipped runner and executes
   the shipped READINESS_QUERY, so this cannot stay green while the runner
   rots. */
describe('competition target runner readiness assertion', () => {
  test('the real runner REFUSES a database where this widening never ran', async () => {
    // The pre-state HAS the foundation table. A gate that merely checked the
    // table existed would pass here, which is the mistake this catches.
    const client = await freshDatabase('adbct_rdy_no');
    try {
      const tableExists = await client.query(
        "select to_regclass('pilot.athlete_development_blocks') is not null as ready",
      );
      expect(tableExists.rows[0].ready).toBe(true);

      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /ATHLETE_DEVELOPMENT_BLOCK_COMPETITION_TARGET_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('adbct_rdy_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });
});
