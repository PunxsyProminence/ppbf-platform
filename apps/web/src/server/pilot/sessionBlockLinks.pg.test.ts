// Real PostgreSQL-backed contract test for the session-block-link migration,
// AND for the real module behavior on top of it: './db' is mocked to route
// into the embedded server, so the functions exercised below are the actual
// production functions executing their actual SQL against actual rows.
//
// THE SCHEMA IS BUILT BY applyFullSchema, NOT BY A HAND-PICKED LIST, and that
// is a deliberate change from the two suites this lane wrote before it. This
// module reads across four tables it does not own -- session_script_runs
// (including run_state, which a LATER migration adds), session_scripts (which
// itself depends on drill_library) and athlete_development_blocks -- and
// naming that chain by hand is precisely the failure scripts/lib/full-schema.mjs
// documents: a suite hand-picking migrations is not testing a smaller
// production, it is testing a database that has never existed. This lane
// already paid for that lesson once, on #771, when widening a shared module
// broke a foundation suite that built its database from one file.
//
// The runner-readiness REFUSAL case is the one thing applyFullSchema cannot
// give, since it applies this migration too -- so that single test uses a
// base-schema-only database, where the assertion has nothing to find.
//
// What needs proving that reading SQL cannot prove:
//   * the link table is created, the PAIR is the identity, and linking twice
//     is a no-op rather than a duplicate row or an error;
//   * a link cannot join a session in one gym to a block in another -- not
//     "should not", cannot;
//   * A LINK DOES NOT BLOCK THE RETENTION PURGE. dataDeletion.ts hard-deletes
//     pilot.athletes and relies entirely on cascades; a NO ACTION foreign key
//     here would roll that transaction back and leave a soft-deleted minor's
//     record past its retention date. This is the single most important case
//     in the file and it is asserted against the real purge behaviour, not
//     against a comment;
//   * listBlocksForRun FILTERS to the caller's permitted athletes, so a
//     gym-level session record cannot be used to enumerate which children
//     have development plans;
//   * nothing counts, scores or derives adherence.
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
  linkSessionToBlock,
  listBlocksForRun,
  listSelectableRuns,
  listSessionsForBlock,
  unlinkSessionFromBlock,
} from './sessionBlockLinks';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-session-block-link-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const MIGRATION_FILE = 'pilot_slice_postgres_session_block_link_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-session-block-link-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs module. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script passes).
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-link';
const OTHER_ORG_ID = 'org-elsewhere';
const COACH_ID = 'acct-link-coach';
const OTHER_COACH_ID = 'acct-link-other-coach';
const ATHLETE_ID = 'ath-link-1';
const SECOND_ATHLETE_ID = 'ath-link-2';
const OTHER_ATHLETE_ID = 'ath-link-other';

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
 * The schema production actually runs, plus two gyms, two coaches, three
 * athletes, a script in each gym and a delivered run of each.
 *
 * The OTHER gym's fixtures exist so every isolation assertion has something
 * real to fail against: a test that proves a cross-gym link is refused proves
 * nothing if the other gym has no run and no block to reach for.
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
       values ($1, $2, 'Link Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [org, athleteId, coachId],
    );
  }

  /* Every gym needs its own 'boxing' row before a script can name that
     discipline: session-scripts-discipline-fk points pilot.session_scripts at
     pilot.disciplines, and `discipline` defaults to 'boxing'. Nothing in this
     slice touches that constraint -- it is simply what production requires,
     and it is visible here only because applyFullSchema builds the schema
     production actually runs rather than the three files this suite would
     have picked. */
  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.disciplines
         (organization_id, discipline, display_name, lane, exposure_model)
       values ($1, 'boxing', 'Boxing', 'striking', 'head_impact')
       on conflict do nothing`,
      [org],
    );
  }

  for (const [org, scriptId] of [[ORG_ID, 'scr-1'], [OTHER_ORG_ID, 'scr-other']] as const) {
    await client.query(
      `insert into pilot.session_scripts
         (organization_id, script_id, lineage_id, version, name, created_by_account_id)
       values ($1, $2, $2, 1, 'Tuesday Technical', $3)
       on conflict do nothing`,
      [org, scriptId, org === ORG_ID ? COACH_ID : OTHER_COACH_ID],
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

  activeClient = client;
  return client;
}

function insertBlock(
  client: Client,
  blockId: string,
  overrides: Record<string, string> = {},
) {
  return client.query(
    `insert into pilot.athlete_development_blocks
       (organization_id, block_id, athlete_id, title, training_emphasis,
        starts_on, ends_on, status, created_by_account_id)
     values ($1, $2, $3, $4, $5, '2026-08-01'::date, '2026-09-30'::date, 'active', $6)`,
    [
      overrides.organization_id ?? ORG_ID,
      blockId,
      overrides.athlete_id ?? ATHLETE_ID,
      overrides.title ?? 'Late summer block',
      overrides.training_emphasis ?? 'Round-three work rate.',
      overrides.created_by_account_id
        ?? (overrides.organization_id === OTHER_ORG_ID ? OTHER_COACH_ID : COACH_ID),
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

describe('the session block link migration itself', () => {
  test('the pair is the identity: the same session cannot be linked to the same block twice', async () => {
    const client = await seededDatabase('sbl_pair');
    try {
      await insertBlock(client, 'blk-1');
      await client.query(
        `insert into pilot.session_run_development_block_links
           (organization_id, run_id, block_id, linked_by_account_id)
         values ($1, 'run-1', 'blk-1', $2)`,
        [ORG_ID, COACH_ID],
      );

      await expect(client.query(
        `insert into pilot.session_run_development_block_links
           (organization_id, run_id, block_id, linked_by_account_id)
         values ($1, 'run-1', 'blk-1', $2)`,
        [ORG_ID, COACH_ID],
      )).rejects.toMatchObject({ code: '23505' });

      // There is no surrogate link_id, so there is no way to spell the
      // duplicate that the key exists to refuse.
      const columns = await client.query(
        `select column_name from information_schema.columns
         where table_schema = 'pilot' and table_name = 'session_run_development_block_links'`,
      );
      const names = columns.rows.map((row) => row.column_name);
      expect(names).not.toContain('link_id');
      expect(names.sort()).toEqual([
        'block_id', 'created_at', 'linked_by_account_id', 'organization_id', 'run_id',
      ]);
    } finally {
      await client.end();
    }
  });

  test('many-to-many in both directions, which is the point of a link table', async () => {
    const client = await seededDatabase('sbl_many');
    try {
      // Two athletes' blocks, both moved by ONE group session -- the case the
      // build order names: "Do not require every group session to be
      // exclusively owned by one block."
      await insertBlock(client, 'blk-a', { athlete_id: ATHLETE_ID });
      await insertBlock(client, 'blk-b', { athlete_id: SECOND_ATHLETE_ID });
      // And one block worked across two sessions.
      for (const [runId, blockId] of [
        ['run-1', 'blk-a'], ['run-1', 'blk-b'], ['run-2', 'blk-a'],
      ] as const) {
        await client.query(
          `insert into pilot.session_run_development_block_links
             (organization_id, run_id, block_id, linked_by_account_id)
           values ($1, $2, $3, $4)`,
          [ORG_ID, runId, blockId, COACH_ID],
        );
      }

      const perRun = await client.query(
        `select count(*)::int as n from pilot.session_run_development_block_links
         where organization_id = $1 and run_id = 'run-1'`,
        [ORG_ID],
      );
      expect(perRun.rows[0].n).toBe(2);

      const perBlock = await client.query(
        `select count(*)::int as n from pilot.session_run_development_block_links
         where organization_id = $1 and block_id = 'blk-a'`,
        [ORG_ID],
      );
      expect(perBlock.rows[0].n).toBe(2);
    } finally {
      await client.end();
    }
  });

  test('a link cannot join a session in one gym to a block in another', async () => {
    const client = await seededDatabase('sbl_tenancy');
    try {
      await insertBlock(client, 'blk-here');
      await insertBlock(client, 'blk-there', {
        organization_id: OTHER_ORG_ID, athlete_id: OTHER_ATHLETE_ID,
      });

      // This gym's run, the other gym's block.
      await expect(client.query(
        `insert into pilot.session_run_development_block_links
           (organization_id, run_id, block_id, linked_by_account_id)
         values ($1, 'run-1', 'blk-there', $2)`,
        [ORG_ID, COACH_ID],
      )).rejects.toMatchObject({ code: '23503' });

      // This gym's block, the other gym's run.
      await expect(client.query(
        `insert into pilot.session_run_development_block_links
           (organization_id, run_id, block_id, linked_by_account_id)
         values ($1, 'run-other', 'blk-here', $2)`,
        [ORG_ID, COACH_ID],
      )).rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.end();
    }
  });

  /* THE MOST IMPORTANT TEST IN THIS FILE.
     dataDeletion.ts's purgeExpiredDeletedData issues a bare
     `delete from pilot.athletes where deleted_at < now() - interval '2 years'`
     inside one transaction and relies ENTIRELY on cascades to carry the
     children. A NO ACTION or RESTRICT foreign key on this link table would
     make that delete fail, roll the whole transaction back, and leave a
     soft-deleted minor's record in the database past the retention period it
     was scheduled for -- a retention failure caused by a link table, found two
     years after the migration shipped.

     Asserted against the real delete rather than against the comment. */
  test('a link does not stop the retention purge from deleting an athlete', async () => {
    const client = await seededDatabase('sbl_purge');
    try {
      await insertBlock(client, 'blk-purge');
      await client.query(
        `insert into pilot.session_run_development_block_links
           (organization_id, run_id, block_id, linked_by_account_id)
         values ($1, 'run-1', 'blk-purge', $2)`,
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

      // The block went with the athlete, and the link went with the block.
      const blocks = await client.query(
        `select count(*)::int as n from pilot.athlete_development_blocks where block_id = 'blk-purge'`,
      );
      expect(blocks.rows[0].n).toBe(0);
      const links = await client.query(
        `select count(*)::int as n from pilot.session_run_development_block_links`,
      );
      expect(links.rows[0].n).toBe(0);

      // And the SESSION survives: a delivered class is a gym record, not the
      // athlete's, and deleting a child does not unmake it.
      const runs = await client.query(
        `select count(*)::int as n from pilot.session_script_runs where run_id = 'run-1'`,
      );
      expect(runs.rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('deleting a session takes its links and leaves the blocks alone', async () => {
    const client = await seededDatabase('sbl_run_delete');
    try {
      await insertBlock(client, 'blk-keep');
      await client.query(
        `insert into pilot.session_run_development_block_links
           (organization_id, run_id, block_id, linked_by_account_id)
         values ($1, 'run-1', 'blk-keep', $2)`,
        [ORG_ID, COACH_ID],
      );

      await client.query(
        `delete from pilot.session_script_runs where organization_id = $1 and run_id = 'run-1'`,
        [ORG_ID],
      );

      const links = await client.query(
        `select count(*)::int as n from pilot.session_run_development_block_links`,
      );
      expect(links.rows[0].n).toBe(0);
      // The plan is not a casualty of the session record going.
      const blocks = await client.query(
        `select count(*)::int as n from pilot.athlete_development_blocks where block_id = 'blk-keep'`,
      );
      expect(blocks.rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('the table stores no count, score or adherence column', async () => {
    const client = await seededDatabase('sbl_columns');
    try {
      const columns = await client.query(
        `select column_name from information_schema.columns
         where table_schema = 'pilot' and table_name = 'session_run_development_block_links'`,
      );
      const names = columns.rows.map((row) => row.column_name);
      for (const forbidden of [
        'session_count', 'sessions_delivered', 'coverage', 'adherence', 'compliance',
        'progress', 'percent', 'completion', 'score', 'weight', 'rank', 'position',
      ]) {
        expect(names).not.toContain(forbidden);
      }
      // Guards the guard.
      expect(names).toContain('linked_by_account_id');
    } finally {
      await client.end();
    }
  });
});

describe('the module linking sessions to blocks (real database)', () => {
  test('a coach links a session to a block, and linking twice is a no-op', async () => {
    const client = await seededDatabase('sbl_mod_link');
    try {
      await insertBlock(client, 'blk-1');

      const first = await linkSessionToBlock({
        organizationId: ORG_ID, runId: 'run-1', blockId: 'blk-1', linkedByAccountId: COACH_ID,
      });
      expect(first).toMatchObject({ created: true });
      expect(first?.link.linked_by_account_id).toBe(COACH_ID);

      // A double-click asks for a state that is already true. It returns the
      // EXISTING link, so linked_by_account_id still names whoever said it
      // first rather than whoever clicked most recently.
      const second = await linkSessionToBlock({
        organizationId: ORG_ID, runId: 'run-1', blockId: 'blk-1', linkedByAccountId: OTHER_COACH_ID,
      });
      expect(second).toMatchObject({ created: false });
      expect(second?.link.linked_by_account_id).toBe(COACH_ID);

      const rows = await client.query(
        `select count(*)::int as n from pilot.session_run_development_block_links`,
      );
      expect(rows.rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('a run or block in another organization is a hidden not-found, and writes nothing', async () => {
    const client = await seededDatabase('sbl_mod_tenancy');
    try {
      await insertBlock(client, 'blk-here');
      await insertBlock(client, 'blk-there', {
        organization_id: OTHER_ORG_ID, athlete_id: OTHER_ATHLETE_ID,
      });

      // Each returns null, and null is also what a never-existed id returns --
      // so neither can be used to discover that the other gym's row exists.
      expect(await linkSessionToBlock({
        organizationId: ORG_ID, runId: 'run-other', blockId: 'blk-here', linkedByAccountId: COACH_ID,
      })).toBeNull();
      expect(await linkSessionToBlock({
        organizationId: ORG_ID, runId: 'run-1', blockId: 'blk-there', linkedByAccountId: COACH_ID,
      })).toBeNull();
      expect(await linkSessionToBlock({
        organizationId: ORG_ID, runId: 'run-never', blockId: 'blk-here', linkedByAccountId: COACH_ID,
      })).toBeNull();

      const rows = await client.query(
        `select count(*)::int as n from pilot.session_run_development_block_links`,
      );
      expect(rows.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test("the sessions a block was worked in come back with the run's own account of itself", async () => {
    const client = await seededDatabase('sbl_mod_sessions');
    try {
      await insertBlock(client, 'blk-1');
      await client.query(
        `update pilot.session_script_runs
         set deviation_note = 'Cut the last round short.',
             what_worked = 'Slipping off the jab held up under pressure.',
             what_did_not = 'Body work faded in round three.',
             athletes_present = 9,
             blocks_completed = 4
         where organization_id = $1 and run_id = 'run-1'`,
        [ORG_ID],
      );
      await linkSessionToBlock({
        organizationId: ORG_ID, runId: 'run-1', blockId: 'blk-1', linkedByAccountId: COACH_ID,
      });
      await linkSessionToBlock({
        organizationId: ORG_ID, runId: 'run-2', blockId: 'blk-1', linkedByAccountId: COACH_ID,
      });

      const sessions = await listSessionsForBlock(ORG_ID, 'blk-1');
      // Most recently DELIVERED first -- the coach's calendar order, not the
      // order somebody happened to click the links in.
      expect(sessions.map((row) => row.run_id)).toEqual(['run-2', 'run-1']);

      const older = sessions[1];
      expect(older).toMatchObject({
        script_name: 'Tuesday Technical',
        delivered_on: '2026-08-10',
        athletes_present: 9,
        blocks_completed: 4,
        deviation_note: 'Cut the last round short.',
        what_worked: 'Slipping off the jab held up under pressure.',
        what_did_not: 'Body work faded in round three.',
      });
      // What the run recorded, carried through verbatim rather than
      // summarised, scored or turned into a percentage.
      expect(Object.keys(older)).not.toContain('adherence');
      expect(Object.keys(older)).not.toContain('coverage');
    } finally {
      await client.end();
    }
  });

  test('unlinking removes the statement and leaves both records standing', async () => {
    const client = await seededDatabase('sbl_mod_unlink');
    try {
      await insertBlock(client, 'blk-1');
      await linkSessionToBlock({
        organizationId: ORG_ID, runId: 'run-1', blockId: 'blk-1', linkedByAccountId: COACH_ID,
      });

      expect(await unlinkSessionFromBlock(ORG_ID, 'run-1', 'blk-1')).toBe(true);
      // Removing something that is not there is false, not an error -- and a
      // link in another gym reads exactly the same way.
      expect(await unlinkSessionFromBlock(ORG_ID, 'run-1', 'blk-1')).toBe(false);
      expect(await unlinkSessionFromBlock(OTHER_ORG_ID, 'run-1', 'blk-1')).toBe(false);

      const runs = await client.query(`select count(*)::int as n from pilot.session_script_runs`);
      expect(runs.rows[0].n).toBe(3);
      const blocks = await client.query(
        `select count(*)::int as n from pilot.athlete_development_blocks`,
      );
      expect(blocks.rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('the picker offers settled runs in this gym only, and never one still being delivered', async () => {
    const client = await seededDatabase('sbl_mod_picker');
    try {
      /* started_at and ended_at come with the state, because
         pilot_ssrun_state_times refuses a half-expressed one: a settled run
         has both, a live run has a start and no end. Writing the state alone
         is exactly the crashed-writer row that constraint exists to make
         unrepresentable, so the fixture has to be a shape production could
         actually hold. */
      await client.query(
        `update pilot.session_script_runs
         set run_state = 'completed',
             started_at = '2026-08-10T18:00:00Z',
             ended_at = '2026-08-10T19:30:00Z'
         where organization_id = $1 and run_id = 'run-1'`,
        [ORG_ID],
      );
      // A session still in the room. Linking one would be a claim about work
      // that has not finished happening.
      // A live run also needs a cursor: pilot_ssrun_cursor_matches_state
      // refuses an in-progress run that is nowhere in its own script, and a
      // settled one that is still somewhere. So the fixture gets a real
      // script block to point at.
      await client.query(
        `insert into pilot.session_script_blocks
           (organization_id, block_id, script_id, block_order, start_offset_min,
            end_offset_min, block_label, what_to_say)
         values ($1, 'ssb-1', 'scr-1', 1, 0, 10, 'Warm-up', 'Round the room, jab only.')
         on conflict do nothing`,
        [ORG_ID],
      );
      await client.query(
        `update pilot.session_script_runs
         set run_state = 'in_progress',
             started_at = '2026-08-17T18:00:00Z',
             current_block_id = 'ssb-1'
         where organization_id = $1 and run_id = 'run-2'`,
        [ORG_ID],
      );

      const runs = await listSelectableRuns(ORG_ID);
      expect(runs.map((row) => row.run_id)).toEqual(['run-1']);
      expect(runs[0]).toMatchObject({ script_name: 'Tuesday Technical', delivered_on: '2026-08-10' });

      // The other gym's run is not offered here, and this gym's is not offered
      // there.
      const theirs = await listSelectableRuns(OTHER_ORG_ID);
      expect(theirs.map((row) => row.run_id)).toEqual(['run-other']);
    } finally {
      await client.end();
    }
  });
});

describe('a session cannot be used to enumerate which children have plans', () => {
  test('listBlocksForRun returns only blocks for athletes the caller may reach', async () => {
    const client = await seededDatabase('sbl_filter');
    try {
      await insertBlock(client, 'blk-mine', { athlete_id: ATHLETE_ID });
      await insertBlock(client, 'blk-not-mine', { athlete_id: SECOND_ATHLETE_ID });
      for (const blockId of ['blk-mine', 'blk-not-mine']) {
        await linkSessionToBlock({
          organizationId: ORG_ID, runId: 'run-1', blockId, linkedByAccountId: COACH_ID,
        });
      }

      // A caller who reaches ONE of the two athletes sees one block. The
      // session is a gym-level record naming no athlete, so without this
      // filter it would report which children in the room have plans.
      const partial = await listBlocksForRun(ORG_ID, 'run-1', [ATHLETE_ID]);
      expect(partial.map((row) => row.block_id)).toEqual(['blk-mine']);

      // A caller who reaches both sees both -- so the filter is doing the
      // work, and the first result is not just an empty read.
      const full = await listBlocksForRun(ORG_ID, 'run-1', [ATHLETE_ID, SECOND_ATHLETE_ID]);
      expect(full.map((row) => row.block_id).sort()).toEqual(['blk-mine', 'blk-not-mine']);

      // And a caller who reaches nobody sees nothing.
      expect(await listBlocksForRun(ORG_ID, 'run-1', [])).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('the filter is not satisfied by naming an athlete in another gym', async () => {
    const client = await seededDatabase('sbl_filter_cross');
    try {
      await insertBlock(client, 'blk-mine', { athlete_id: ATHLETE_ID });
      await linkSessionToBlock({
        organizationId: ORG_ID, runId: 'run-1', blockId: 'blk-mine', linkedByAccountId: COACH_ID,
      });

      // Organization scope and athlete scope are separate gates and both are
      // applied: the other gym's athlete id buys nothing here.
      expect(await listBlocksForRun(ORG_ID, 'run-1', [OTHER_ATHLETE_ID])).toEqual([]);
      expect(await listBlocksForRun(OTHER_ORG_ID, 'run-1', [ATHLETE_ID])).toEqual([]);
    } finally {
      await client.end();
    }
  });
});

// READINESS_QUERY -- the assertion that gates the dispatch. #488 is what it
// costs to find one at a staging dispatch: an assertion that could not pass on
// ANY database. The inverse -- one that can never FAIL -- is quieter and
// worse, so the refusal case comes first.
//
// The query is never restated here. applyMigrationTransaction is imported out
// of the shipped runner and executes the shipped READINESS_QUERY, so this
// cannot stay green while the runner rots.
describe('session block link runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    // The one case applyFullSchema cannot build, because it applies this
    // migration too. A base-schema-only database is the honest pre-state.
    const client = await emptyDatabase('sbl_rdy_no');
    try {
      await client.query(baseSchemaSql);
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /SESSION_BLOCK_LINK_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await seededDatabase('sbl_rdy_ok');
    try {
      // applyFullSchema already applied it once; the `all` chain re-runs every
      // migration on every dispatch (#489), so it has to survive its own
      // first pass -- twice more here.
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });

  test('the readiness gate refuses a table whose foreign keys do not cascade', async () => {
    /* Not decoration. If either key shipped as NO ACTION this table would
       silently block the retention purge, and the failure would surface two
       years later as rows that should have been deleted. So the runner checks
       confdeltype and this proves the check bites: the table is rebuilt with
       NO ACTION keys and the gate must refuse it. */
    const client = await seededDatabase('sbl_rdy_cascade');
    try {
      await client.query('drop table pilot.session_run_development_block_links');
      await client.query(
        `create table pilot.session_run_development_block_links (
           organization_id      text not null references pilot.organizations(organization_id),
           run_id               text not null,
           block_id             text not null,
           linked_by_account_id text not null references pilot.accounts(account_id),
           created_at           timestamptz not null default now(),
           primary key (organization_id, run_id, block_id),
           constraint pilot_session_run_block_links_run_fk
             foreign key (organization_id, run_id)
             references pilot.session_script_runs(organization_id, run_id),
           constraint pilot_session_run_block_links_block_fk
             foreign key (organization_id, block_id)
             references pilot.athlete_development_blocks(organization_id, block_id)
         )`,
      );
      await client.query(
        `create index if not exists idx_session_run_block_links_by_block
           on pilot.session_run_development_block_links(organization_id, block_id, created_at desc)`,
      );

      // The migration is idempotent, so `create table if not exists` leaves
      // this wrong table in place -- which is exactly the state the gate has
      // to catch.
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow(
        /SESSION_BLOCK_LINK_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });
});
