// Real PostgreSQL-backed contract test for the session-objective-link
// migration, AND for the real module behavior on top of it: './db' is mocked
// to route into the embedded server, so the functions exercised below are the
// actual production functions executing their actual SQL against actual rows.
//
// The schema is built by applyFullSchema, for the reason its own header
// gives and the reason sessionBlockLinks.pg.test.ts records: this module
// reads across four tables it does not own, two of which belong to a lane
// that landed hours ago. The runner-readiness REFUSAL case is the one thing
// applyFullSchema cannot give, since it applies this migration too, so that
// single test uses a base-schema-only database.
//
// What needs proving that reading SQL cannot prove:
//   * AN OBJECTIVE LINK CANNOT EXIST WITHOUT ITS BLOCK LINK. This is the
//     invariant the whole migration is shaped around, and it is held by a
//     composite foreign key rather than by a query habit -- so it is asserted
//     with raw SQL that bypasses the module entirely;
//   * an objective link cannot claim an objective that belongs to a DIFFERENT
//     block, even when both the objective and the block link exist;
//   * the pair is the identity, so a session cannot address one objective
//     twice;
//   * A LINK DOES NOT BLOCK THE RETENTION PURGE. The cascade chain is now
//     four deep -- athlete -> block -> objective -> this row, and athlete ->
//     block -> block link -> this row -- and dataDeletion.ts relies entirely
//     on cascades. Asserted against the purge's exact statement;
//   * unlinking removes only the statement;
//   * nothing counts, weights or derives coverage, and no read returns a
//     per-domain tally.
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

import {
  linkSessionToObjective,
  listObjectiveLinksForBlock,
  listObjectivesForSessionBlock,
  listSessionsForObjective,
  unlinkSessionFromObjective,
} from './sessionObjectiveLinks';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-session-objective-link-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const MIGRATION_FILE = 'pilot_slice_postgres_session_objective_link_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-session-objective-link-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs module. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script passes).
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-obj';
const OTHER_ORG_ID = 'org-elsewhere';
const COACH_ID = 'acct-obj-coach';
const OTHER_COACH_ID = 'acct-obj-other-coach';
const ATHLETE_ID = 'ath-obj-1';
const SECOND_ATHLETE_ID = 'ath-obj-2';
const OTHER_ATHLETE_ID = 'ath-obj-other';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let baseSchemaSql: string;
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

async function emptyDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

/**
 * The schema production runs, two gyms, two coaches, three athletes, a script
 * and two delivered runs per gym, TWO blocks in this gym (one per athlete)
 * and one objective in each.
 *
 * Two blocks matter: the invariant under test is "an objective link implies
 * the block link for THAT objective's block", and a fixture with one block
 * cannot tell that apart from "implies any block link at all".
 */
async function seededDatabase(name: string): Promise<Client> {
  const client = await emptyDatabase(name);
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
    await client.query(
      `insert into pilot.disciplines
         (organization_id, discipline, display_name, lane, exposure_model)
       values ($1, 'boxing', 'Boxing', 'striking', 'head_impact')
       on conflict do nothing`,
      [org],
    );
  }

  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $3, 'microsoft'), ($2, 'coach', $4, 'microsoft')
     on conflict do nothing`,
    [COACH_ID, OTHER_COACH_ID, ORG_ID, OTHER_ORG_ID],
  );

  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $3, 'coach', true), ($2, $4, 'coach', true)
     on conflict do nothing`,
    [COACH_ID, OTHER_COACH_ID, ORG_ID, OTHER_ORG_ID],
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
       values ($1, $2, 'Objective Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [org, athleteId, coachId],
    );
  }

  for (const [org, scriptId, coachId] of [
    [ORG_ID, 'scr-1', COACH_ID], [OTHER_ORG_ID, 'scr-other', OTHER_COACH_ID],
  ] as const) {
    await client.query(
      `insert into pilot.session_scripts
         (organization_id, script_id, lineage_id, version, name, created_by_account_id)
       values ($1, $2, $2, 1, 'Tuesday Technical', $3)
       on conflict do nothing`,
      [org, scriptId, coachId],
    );
  }

  await client.query(
    `insert into pilot.session_script_runs
       (organization_id, run_id, script_id, script_version, delivered_by_account_id, delivered_on)
     values ($1, 'run-1', 'scr-1', 1, $3, '2026-08-10'),
            ($1, 'run-2', 'scr-1', 1, $3, '2026-08-17'),
            ($2, 'run-other', 'scr-other', 1, $4, '2026-08-12')
     on conflict do nothing`,
    [ORG_ID, OTHER_ORG_ID, COACH_ID, OTHER_COACH_ID],
  );

  // Two blocks in this gym, one per athlete, plus one in the other gym.
  for (const [org, blockId, athleteId, coachId] of [
    [ORG_ID, 'blk-a', ATHLETE_ID, COACH_ID],
    [ORG_ID, 'blk-b', SECOND_ATHLETE_ID, COACH_ID],
    [OTHER_ORG_ID, 'blk-other', OTHER_ATHLETE_ID, OTHER_COACH_ID],
  ] as const) {
    await client.query(
      `insert into pilot.athlete_development_blocks
         (organization_id, block_id, athlete_id, title, training_emphasis,
          starts_on, ends_on, status, created_by_account_id)
       values ($1, $2, $3, 'Late summer block', 'Round-three work rate.',
               '2026-08-01'::date, '2026-09-30'::date, 'active', $4)
       on conflict do nothing`,
      [org, blockId, athleteId, coachId],
    );
  }

  for (const [org, objectiveId, blockId, domain, text, coachId] of [
    [ORG_ID, 'obj-a', 'blk-a', 'technical', 'Stop drifting to the ropes.', COACH_ID],
    [ORG_ID, 'obj-b', 'blk-b', 'mental', 'Settle after taking a clean shot.', COACH_ID],
    [OTHER_ORG_ID, 'obj-other', 'blk-other', 'technical', 'Elsewhere.', OTHER_COACH_ID],
  ] as const) {
    await client.query(
      `insert into pilot.athlete_development_block_objectives
         (organization_id, objective_id, block_id, domain, objective, status, created_by_account_id)
       values ($1, $2, $3, $4, $5, 'active', $6)
       on conflict do nothing`,
      [org, objectiveId, blockId, domain, text, coachId],
    );
  }

  activeClient = client;
  return client;
}

/** The block link the objective link depends on. Raw SQL, so the tests can
 *  create the precondition without going through the module that consumes it. */
function linkBlock(client: Client, runId: string, blockId: string, org = ORG_ID) {
  return client.query(
    `insert into pilot.session_run_development_block_links
       (organization_id, run_id, block_id, linked_by_account_id)
     values ($1, $2, $3, $4) on conflict do nothing`,
    [org, runId, blockId, org === ORG_ID ? COACH_ID : OTHER_COACH_ID],
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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as typeof applyMigrationTransaction;

  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = helper.applyFullSchema as typeof applyFullSchema;
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

describe('the invariant this migration exists to hold', () => {
  /* THE CENTRAL CASE. An objective lives inside exactly one block, so a
     session cannot have addressed the objective unless it supported that
     block. Asserted with RAW SQL rather than through the module, because the
     claim is that the DATABASE refuses it -- a module-level check would prove
     only that the module checks. */
  test('an objective link cannot exist without the block link, at the database level', async () => {
    const client = await seededDatabase('sol_requires_block_link');
    try {
      await expect(client.query(
        `insert into pilot.session_run_block_objective_links
           (organization_id, run_id, objective_id, block_id, linked_by_account_id)
         values ($1, 'run-1', 'obj-a', 'blk-a', $2)`,
        [ORG_ID, COACH_ID],
      )).rejects.toMatchObject({ code: '23503' });

      // With the block link in place the same row is accepted, so the refusal
      // above is about the missing link and not about something else.
      await linkBlock(client, 'run-1', 'blk-a');
      await client.query(
        `insert into pilot.session_run_block_objective_links
           (organization_id, run_id, objective_id, block_id, linked_by_account_id)
         values ($1, 'run-1', 'obj-a', 'blk-a', $2)`,
        [ORG_ID, COACH_ID],
      );
      const rows = await client.query(
        `select count(*)::int as n from pilot.session_run_block_objective_links`,
      );
      expect(rows.rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('the block link must be for THIS objective\'s block, not just any block', async () => {
    const client = await seededDatabase('sol_right_block');
    try {
      // The session supports the OTHER athlete's block. obj-a belongs to
      // blk-a, so it is still not addressable by this session.
      await linkBlock(client, 'run-1', 'blk-b');

      await expect(client.query(
        `insert into pilot.session_run_block_objective_links
           (organization_id, run_id, objective_id, block_id, linked_by_account_id)
         values ($1, 'run-1', 'obj-a', 'blk-a', $2)`,
        [ORG_ID, COACH_ID],
      )).rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.end();
    }
  });

  test('an objective cannot be filed under a block it does not belong to', async () => {
    const client = await seededDatabase('sol_wrong_parent');
    try {
      // Both block links exist, so the block-link key is satisfiable...
      await linkBlock(client, 'run-1', 'blk-a');
      await linkBlock(client, 'run-1', 'blk-b');

      // ...but obj-a's parent is blk-a, so claiming it under blk-b is refused
      // by the objective key. This is what the unique index on
      // (organization_id, objective_id, block_id) buys: block_id cannot drift
      // from the objective's own parent.
      await expect(client.query(
        `insert into pilot.session_run_block_objective_links
           (organization_id, run_id, objective_id, block_id, linked_by_account_id)
         values ($1, 'run-1', 'obj-a', 'blk-b', $2)`,
        [ORG_ID, COACH_ID],
      )).rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.end();
    }
  });

  test('the pair is the identity: one session cannot address one objective twice', async () => {
    const client = await seededDatabase('sol_pair');
    try {
      await linkBlock(client, 'run-1', 'blk-a');
      const insert = () => client.query(
        `insert into pilot.session_run_block_objective_links
           (organization_id, run_id, objective_id, block_id, linked_by_account_id)
         values ($1, 'run-1', 'obj-a', 'blk-a', $2)`,
        [ORG_ID, COACH_ID],
      );
      await insert();
      await expect(insert()).rejects.toMatchObject({ code: '23505' });

      const columns = await client.query(
        `select column_name from information_schema.columns
         where table_schema = 'pilot' and table_name = 'session_run_block_objective_links'`,
      );
      const names = columns.rows.map((row) => row.column_name).sort();
      // No surrogate id, so the duplicate cannot be spelled.
      expect(names).toEqual([
        'block_id', 'created_at', 'linked_by_account_id', 'objective_id',
        'organization_id', 'run_id',
      ]);
    } finally {
      await client.end();
    }
  });

  test('a link cannot cross gyms in any direction', async () => {
    const client = await seededDatabase('sol_tenancy');
    try {
      await linkBlock(client, 'run-1', 'blk-a');
      await linkBlock(client, 'run-other', 'blk-other', OTHER_ORG_ID);

      // This gym's run and block, the other gym's objective.
      await expect(client.query(
        `insert into pilot.session_run_block_objective_links
           (organization_id, run_id, objective_id, block_id, linked_by_account_id)
         values ($1, 'run-1', 'obj-other', 'blk-a', $2)`,
        [ORG_ID, COACH_ID],
      )).rejects.toMatchObject({ code: '23503' });

      // The other gym's run, filed under this gym.
      await expect(client.query(
        `insert into pilot.session_run_block_objective_links
           (organization_id, run_id, objective_id, block_id, linked_by_account_id)
         values ($1, 'run-other', 'obj-a', 'blk-a', $2)`,
        [ORG_ID, COACH_ID],
      )).rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.end();
    }
  });

  test('the table stores no count, weight, coverage or contribution column', async () => {
    const client = await seededDatabase('sol_columns');
    try {
      const columns = await client.query(
        `select column_name from information_schema.columns
         where table_schema = 'pilot' and table_name = 'session_run_block_objective_links'`,
      );
      const names = columns.rows.map((row) => row.column_name);
      for (const forbidden of [
        'weight', 'effort', 'contribution', 'minutes', 'coverage', 'adherence',
        'progress', 'percent', 'completion', 'score', 'rank', 'status',
      ]) {
        expect(names).not.toContain(forbidden);
      }
      // 'status' in particular: this row records that a session addressed an
      // objective. The objective's lifecycle belongs to the objective.
      expect(names).toContain('linked_by_account_id');
    } finally {
      await client.end();
    }
  });
});

describe('deletion', () => {
  /* The cascade chain is four deep now -- athlete -> block -> objective ->
     this row, and athlete -> block -> block link -> this row. Both parents go
     in the same statement. dataDeletion.ts's purge is a bare delete that
     relies entirely on cascades, so a NO ACTION key on either side would roll
     the whole transaction back and leave a soft-deleted minor's record past
     its retention date. */
  test('an objective link does not stop the retention purge', async () => {
    const client = await seededDatabase('sol_purge');
    try {
      await linkBlock(client, 'run-1', 'blk-a');
      await client.query(
        `insert into pilot.session_run_block_objective_links
           (organization_id, run_id, objective_id, block_id, linked_by_account_id)
         values ($1, 'run-1', 'obj-a', 'blk-a', $2)`,
        [ORG_ID, COACH_ID],
      );
      await client.query(
        `update pilot.athletes set deleted_at = now() - interval '3 years'
         where organization_id = $1 and athlete_id = $2`,
        [ORG_ID, ATHLETE_ID],
      );

      // The exact statement the purge runs.
      const purged = await client.query(
        `delete from pilot.athletes
         where deleted_at is not null
           and deleted_at < (now() - interval '2 years')
         returning athlete_id`,
      );
      expect(purged.rows.map((row) => row.athlete_id)).toEqual([ATHLETE_ID]);

      /* Counted per table with the number spelled out, because the shape of
         this assertion is the point: the purge takes ONE child's records and
         leaves the gym's. The other athlete's block and objective survive --
         a cascade that took them too would be a far worse bug than one that
         took too few, and a clever expression over the table names hid that
         distinction the first time this was written. */
      for (const [table, remaining, why] of [
        ['athlete_development_blocks', 2, "the other child's block and the other gym's"],
        ['athlete_development_block_objectives', 2, "the other child's objective and the other gym's"],
        ['session_run_development_block_links', 0, 'the only block link was to the purged block'],
        ['session_run_block_objective_links', 0, 'and the objective link went with it'],
      ] as const) {
        const rows = await client.query(`select count(*)::int as n from pilot.${table}`);
        expect([table, rows.rows[0].n, why]).toEqual([table, remaining, why]);
      }

      // The SESSION survives: a delivered class is a gym record, not the
      // child's, and deleting a child does not unmake it.
      const runs = await client.query(
        `select count(*)::int as n from pilot.session_script_runs where run_id = 'run-1'`,
      );
      expect(runs.rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('removing the block link removes the objective links it implied', async () => {
    const client = await seededDatabase('sol_unlink_block');
    try {
      await linkBlock(client, 'run-1', 'blk-a');
      await client.query(
        `insert into pilot.session_run_block_objective_links
           (organization_id, run_id, objective_id, block_id, linked_by_account_id)
         values ($1, 'run-1', 'obj-a', 'blk-a', $2)`,
        [ORG_ID, COACH_ID],
      );

      /* A coach who says "this class did not serve that plan after all" has
         also said it did not serve that plan's objectives. Leaving the
         objective link behind would keep a claim whose precondition the coach
         just withdrew -- and the foreign key makes it unrepresentable rather
         than merely tidied up afterwards. */
      await client.query(
        `delete from pilot.session_run_development_block_links
         where organization_id = $1 and run_id = 'run-1' and block_id = 'blk-a'`,
        [ORG_ID],
      );

      const links = await client.query(
        `select count(*)::int as n from pilot.session_run_block_objective_links`,
      );
      expect(links.rows[0].n).toBe(0);
      // The objective itself is untouched: the plan still says what it says.
      const objectives = await client.query(
        `select count(*)::int as n from pilot.athlete_development_block_objectives
         where objective_id = 'obj-a'`,
      );
      expect(objectives.rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });
});

describe('the module (real database)', () => {
  test('a coach marks an objective, and marking it twice is a no-op', async () => {
    const client = await seededDatabase('sol_mod_link');
    try {
      await linkBlock(client, 'run-1', 'blk-a');

      const first = await linkSessionToObjective({
        organizationId: ORG_ID, runId: 'run-1', objectiveId: 'obj-a',
        linkedByAccountId: COACH_ID,
      });
      expect(first).toMatchObject({ created: true });
      // block_id is the OBJECTIVE's own, established by the module rather than
      // supplied by the caller -- there is no parameter for it.
      expect(first?.link.block_id).toBe('blk-a');

      const second = await linkSessionToObjective({
        organizationId: ORG_ID, runId: 'run-1', objectiveId: 'obj-a',
        linkedByAccountId: OTHER_COACH_ID,
      });
      expect(second).toMatchObject({ created: false });
      // Still whoever said it first.
      expect(second?.link.linked_by_account_id).toBe(COACH_ID);
    } finally {
      await client.end();
    }
  });

  test('without the block link the module returns null and writes nothing', async () => {
    const client = await seededDatabase('sol_mod_precondition');
    try {
      expect(await linkSessionToObjective({
        organizationId: ORG_ID, runId: 'run-1', objectiveId: 'obj-a',
        linkedByAccountId: COACH_ID,
      })).toBeNull();

      // A block link for a DIFFERENT block does not satisfy it either.
      await linkBlock(client, 'run-1', 'blk-b');
      expect(await linkSessionToObjective({
        organizationId: ORG_ID, runId: 'run-1', objectiveId: 'obj-a',
        linkedByAccountId: COACH_ID,
      })).toBeNull();

      const rows = await client.query(
        `select count(*)::int as n from pilot.session_run_block_objective_links`,
      );
      expect(rows.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('an objective in another gym, and one that never existed, read the same', async () => {
    const client = await seededDatabase('sol_mod_hidden');
    try {
      await linkBlock(client, 'run-1', 'blk-a');

      expect(await linkSessionToObjective({
        organizationId: ORG_ID, runId: 'run-1', objectiveId: 'obj-other',
        linkedByAccountId: COACH_ID,
      })).toBeNull();
      expect(await linkSessionToObjective({
        organizationId: ORG_ID, runId: 'run-1', objectiveId: 'obj-never',
        linkedByAccountId: COACH_ID,
      })).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('the reads return the objective\'s own words and the run\'s own account', async () => {
    const client = await seededDatabase('sol_mod_reads');
    try {
      await client.query(
        `update pilot.session_script_runs
         set what_worked = 'She stopped backing straight up.',
             deviation_note = 'Cut the last round short.'
         where organization_id = $1 and run_id = 'run-1'`,
        [ORG_ID],
      );
      await linkBlock(client, 'run-1', 'blk-a');
      await linkBlock(client, 'run-2', 'blk-a');
      await linkSessionToObjective({
        organizationId: ORG_ID, runId: 'run-1', objectiveId: 'obj-a', linkedByAccountId: COACH_ID,
      });
      await linkSessionToObjective({
        organizationId: ORG_ID, runId: 'run-2', objectiveId: 'obj-a', linkedByAccountId: COACH_ID,
      });

      const forSession = await listObjectivesForSessionBlock(ORG_ID, 'run-1', 'blk-a');
      expect(forSession).toHaveLength(1);
      expect(forSession[0]).toMatchObject({
        objective_id: 'obj-a',
        domain: 'technical',
        objective: 'Stop drifting to the ropes.',
        status: 'active',
      });

      const sessions = await listSessionsForObjective(ORG_ID, 'obj-a');
      // Most recently DELIVERED first, the coach's calendar order.
      expect(sessions.map((row) => row.run_id)).toEqual(['run-2', 'run-1']);
      expect(sessions[1]).toMatchObject({
        script_name: 'Tuesday Technical',
        delivered_on: '2026-08-10',
        what_worked: 'She stopped backing straight up.',
        deviation_note: 'Cut the last round short.',
      });

      const forBlock = await listObjectiveLinksForBlock(ORG_ID, 'blk-a');
      expect(forBlock).toHaveLength(2);
      // Rows, not a tally. Nothing here returns "obj-a: 2".
      for (const row of forBlock) {
        expect(Object.keys(row)).not.toContain('session_count');
        expect(Object.keys(row)).not.toContain('coverage');
      }
    } finally {
      await client.end();
    }
  });

  test('one block\'s objectives do not leak into another block\'s read', async () => {
    const client = await seededDatabase('sol_mod_scope');
    try {
      // ONE session serving TWO athletes' blocks -- the ordinary group class.
      await linkBlock(client, 'run-1', 'blk-a');
      await linkBlock(client, 'run-1', 'blk-b');
      await linkSessionToObjective({
        organizationId: ORG_ID, runId: 'run-1', objectiveId: 'obj-a', linkedByAccountId: COACH_ID,
      });
      await linkSessionToObjective({
        organizationId: ORG_ID, runId: 'run-1', objectiveId: 'obj-b', linkedByAccountId: COACH_ID,
      });

      /* Both objectives hang off the same run, and they belong to two
         different children. The read is per BLOCK for exactly this reason: a
         run-wide answer would hand back the other child's objective to
         whoever could open either block. */
      const a = await listObjectivesForSessionBlock(ORG_ID, 'run-1', 'blk-a');
      expect(a.map((row) => row.objective_id)).toEqual(['obj-a']);
      const b = await listObjectivesForSessionBlock(ORG_ID, 'run-1', 'blk-b');
      expect(b.map((row) => row.objective_id)).toEqual(['obj-b']);

      expect(await listObjectivesForSessionBlock(OTHER_ORG_ID, 'run-1', 'blk-a')).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('unlinking removes the statement and leaves everything else standing', async () => {
    const client = await seededDatabase('sol_mod_unlink');
    try {
      await linkBlock(client, 'run-1', 'blk-a');
      await linkSessionToObjective({
        organizationId: ORG_ID, runId: 'run-1', objectiveId: 'obj-a', linkedByAccountId: COACH_ID,
      });

      expect(await unlinkSessionFromObjective(ORG_ID, 'run-1', 'obj-a', 'blk-a')).toBe(true);
      // Removing what is not there is false, not an error -- and another
      // gym's link reads the same way.
      expect(await unlinkSessionFromObjective(ORG_ID, 'run-1', 'obj-a', 'blk-a')).toBe(false);
      expect(await unlinkSessionFromObjective(OTHER_ORG_ID, 'run-1', 'obj-a', 'blk-a')).toBe(false);

      // The block link, the objective and the session all survive.
      for (const [table, expected] of [
        ['session_run_development_block_links', 1],
        ['athlete_development_block_objectives', 3],
        ['session_script_runs', 3],
      ] as const) {
        const rows = await client.query(`select count(*)::int as n from pilot.${table}`);
        expect([table, rows.rows[0].n]).toEqual([table, expected]);
      }
    } finally {
      await client.end();
    }
  });

  /* THE BLOCK THE CALLER CLEARED IS THE BLOCK THE DELETE IS SCOPED TO.
     
     This shipped without the block predicate. The route required block_id and
     authorized it through getDevelopmentBlock, then deleted on
     (organization_id, run_id, objective_id) alone -- so authorization proved
     about one block was spent on whichever block the objective actually
     belonged to. The fixture below is the exact shape that made it reachable:
     obj-a and obj-b hang off the same run and belong to TWO DIFFERENT
     CHILDREN, and run ids come from a deliberately un-gated picker.

     Whole-gym roster visibility is not athlete-record authorization, so a
     coach cleared for blk-a must not be able to remove a statement about
     blk-b's child by naming blk-a at the door. */
  test('a block the caller cleared cannot be spent on another block\'s objective', async () => {
    const client = await seededDatabase('sol_mod_unlink_block_scope');
    try {
      await linkBlock(client, 'run-1', 'blk-a');
      await linkBlock(client, 'run-1', 'blk-b');
      await linkSessionToObjective({
        organizationId: ORG_ID, runId: 'run-1', objectiveId: 'obj-b', linkedByAccountId: COACH_ID,
      });

      // blk-a is the block the caller cleared. obj-b is the other child's.
      expect(await unlinkSessionFromObjective(ORG_ID, 'run-1', 'obj-b', 'blk-a')).toBe(false);

      // And it is still there -- the refusal is a refusal, not a silent pass.
      const survived = await client.query(
        `select count(*)::int as n from pilot.session_run_block_objective_links
         where organization_id = $1 and run_id = $2 and objective_id = $3`,
        [ORG_ID, 'run-1', 'obj-b'],
      );
      expect(survived.rows[0].n).toBe(1);

      // Naming the objective's own block removes it, so the predicate is
      // scoping the delete rather than breaking it.
      expect(await unlinkSessionFromObjective(ORG_ID, 'run-1', 'obj-b', 'blk-b')).toBe(true);
    } finally {
      await client.end();
    }
  });
});

// READINESS_QUERY -- the assertion that gates the dispatch, executed from the
// shipped runner so this cannot stay green while the runner rots.
describe('session objective link runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await emptyDatabase('sol_rdy_no');
    try {
      await client.query(baseSchemaSql);
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /SESSION_OBJECTIVE_LINK_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await seededDatabase('sol_rdy_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });

  test('the readiness gate refuses a table whose foreign keys do not cascade', async () => {
    /* If either key shipped as NO ACTION this table would silently block the
       retention purge, and the failure would surface years later as rows that
       should have been deleted. The runner checks confdeltype; this proves
       the check bites. */
    const client = await seededDatabase('sol_rdy_cascade');
    try {
      await client.query('drop table pilot.session_run_block_objective_links');
      await client.query(
        `create table pilot.session_run_block_objective_links (
           organization_id      text not null references pilot.organizations(organization_id),
           run_id               text not null,
           objective_id         text not null,
           block_id             text not null,
           linked_by_account_id text not null references pilot.accounts(account_id),
           created_at           timestamptz not null default now(),
           primary key (organization_id, run_id, objective_id),
           constraint pilot_session_run_objective_links_objective_fk
             foreign key (organization_id, objective_id, block_id)
             references pilot.athlete_development_block_objectives(organization_id, objective_id, block_id),
           constraint pilot_session_run_objective_links_block_link_fk
             foreign key (organization_id, run_id, block_id)
             references pilot.session_run_development_block_links(organization_id, run_id, block_id)
         )`,
      );
      await client.query(
        `create index if not exists idx_session_run_objective_links_by_objective
           on pilot.session_run_block_objective_links(organization_id, objective_id, created_at desc)`,
      );
      await client.query(
        `create index if not exists idx_session_run_objective_links_by_block
           on pilot.session_run_block_objective_links(organization_id, block_id, run_id)`,
      );

      // The migration is idempotent, so `create table if not exists` leaves
      // this wrong table in place -- exactly the state the gate must catch.
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow(
        /SESSION_OBJECTIVE_LINK_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the readiness gate refuses a database missing the objective unique index', async () => {
    /* Without uq_adb_objectives_org_objective_block the objective foreign key
       cannot exist, so the invariant is unenforced -- a state the gate has to
       refuse rather than shrug at. */
    const client = await seededDatabase('sol_rdy_index');
    try {
      await client.query('drop table pilot.session_run_block_objective_links');
      await client.query('drop index pilot.uq_adb_objectives_org_objective_block');
      const readiness = await client.query(
        `select exists (
           select 1 from pg_indexes
           where schemaname = 'pilot' and indexname = 'uq_adb_objectives_org_objective_block'
         ) as present`,
      );
      expect(readiness.rows[0].present).toBe(false);

      // Re-applying rebuilds both, so this also proves the migration repairs
      // the state rather than only creating it once.
      await applyMigrationTransaction(client, migrationSql);
      const after = await client.query(
        `select exists (
           select 1 from pg_indexes
           where schemaname = 'pilot' and indexname = 'uq_adb_objectives_org_objective_block'
         ) as present`,
      );
      expect(after.rows[0].present).toBe(true);
    } finally {
      await client.end();
    }
  });
});
