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

import {
  createDevelopmentBlock,
  getDevelopmentBlock,
  listDevelopmentBlocks,
  listDevelopmentBlocksForAthlete,
  setDevelopmentBlockStatus,
} from './athleteDevelopmentBlocks';
import { ForbiddenError, ValidationError } from './errors';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-athlete-dev-blocks-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_athlete_development_blocks_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-athlete-development-blocks-migration.mjs',
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

/** A migrated database, with `activeClient` pointed at it so the mocked
 * './db' routes the module's real SQL here. */
async function migratedDatabase(name: string): Promise<Client> {
  const client = await freshDatabase(name);
  await client.query(migrationSql);
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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

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
    const client = await freshDatabase('adb_fresh');
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
    const client = await freshDatabase('adb_noop');
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
    const client = await freshDatabase('adb_columns');
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
    const client = await freshDatabase('adb_dates');
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
    const client = await freshDatabase('adb_status');
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
    const client = await freshDatabase('adb_content');
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
    const client = await freshDatabase('adb_tenancy');
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
    const client = await freshDatabase('adb_cascade');
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
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        title: '  Fall strength block  ',
        trainingEmphasis: EMPHASIS,
        startsOn: '2026-09-02',
        endsOn: '2026-10-14',
        createdByAccountId: COACH_ID,
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
        created_by_account_id: COACH_ID,
      });
    } finally {
      await client.end();
    }
  });

  test('the creator must hold an ACTIVE membership in the block\'s organization', async () => {
    const client = await migratedDatabase('adb_mod_membership');
    try {
      // A coach of another gym.
      await expect(createDevelopmentBlock({
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        title: 'Borrowed authority',
        trainingEmphasis: EMPHASIS,
        startsOn: '2026-09-02',
        endsOn: '2026-10-14',
        createdByAccountId: OTHER_COACH_ID,
      })).rejects.toBeInstanceOf(ForbiddenError);

      // A former coach of THIS gym: the account still exists and its home
      // organization still reads as this one. The membership is what changed.
      await expect(createDevelopmentBlock({
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        title: 'Lapsed authority',
        trainingEmphasis: EMPHASIS,
        startsOn: '2026-09-02',
        endsOn: '2026-10-14',
        createdByAccountId: LAPSED_COACH_ID,
      })).rejects.toBeInstanceOf(ForbiddenError);

      const written = await client.query('select block_id from pilot.athlete_development_blocks');
      expect(written.rows).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('a coach whose home organization is elsewhere may still author here, if their membership is active', async () => {
    // The multi-org case pilot.accounts.organization_id answers wrongly.
    // auth.ts asks the membership table for the same reason.
    const client = await migratedDatabase('adb_mod_visiting');
    try {
      const home = await client.query(
        'select organization_id from pilot.accounts where account_id = $1',
        [VISITING_COACH_ID],
      );
      expect(home.rows).toEqual([{ organization_id: OTHER_ORG_ID }]);

      const created = await createDevelopmentBlock({
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        title: 'Visiting coach block',
        trainingEmphasis: EMPHASIS,
        startsOn: '2026-09-02',
        endsOn: '2026-10-14',
        createdByAccountId: VISITING_COACH_ID,
      });
      expect(created?.created_by_account_id).toBe(VISITING_COACH_ID);
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
        organizationId: ORG_ID,
        athleteId: OTHER_ATHLETE_ID,
        title: 'Someone else\'s athlete',
        trainingEmphasis: EMPHASIS,
        startsOn: '2026-09-02',
        endsOn: '2026-10-14',
        createdByAccountId: COACH_ID,
      })).resolves.toBeNull();

      await expect(createDevelopmentBlock({
        organizationId: ORG_ID,
        athleteId: 'ath-never-existed',
        title: 'Nobody at all',
        trainingEmphasis: EMPHASIS,
        startsOn: '2026-09-02',
        endsOn: '2026-10-14',
        createdByAccountId: COACH_ID,
      })).resolves.toBeNull();

      const written = await client.query('select block_id from pilot.athlete_development_blocks');
      expect(written.rows).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('an unsound block is refused before it reaches the database', async () => {
    const client = await migratedDatabase('adb_mod_shape');
    try {
      const base = {
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        title: 'Backwards block',
        trainingEmphasis: EMPHASIS,
        startsOn: '2026-10-14',
        endsOn: '2026-09-02',
        createdByAccountId: COACH_ID,
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
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        title: 'Fall strength block',
        trainingEmphasis: EMPHASIS,
        startsOn: '2026-09-02',
        endsOn: '2026-10-14',
        createdByAccountId: COACH_ID,
      });
      const blockId = created!.block_id;

      expect((await setDevelopmentBlockStatus(ORG_ID, blockId, 'active'))?.status).toBe('active');
      expect((await setDevelopmentBlockStatus(ORG_ID, blockId, 'completed'))?.status).toBe('completed');

      await expect(setDevelopmentBlockStatus(ORG_ID, blockId, 'archived' as never))
        .rejects.toBeInstanceOf(ValidationError);

      // Nothing in this module advances a block on its own: a window that has
      // elapsed is not a block that was completed, and only a coach can say
      // which happened.
      const unchanged = await getDevelopmentBlock(ORG_ID, blockId);
      expect(unchanged?.status).toBe('completed');
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
      expect(await getDevelopmentBlock(ORG_ID, 'block-theirs')).toBeNull();
      expect(await getDevelopmentBlock(OTHER_ORG_ID, 'block-ours')).toBeNull();
      expect((await getDevelopmentBlock(ORG_ID, 'block-ours'))?.block_id).toBe('block-ours');

      // listDevelopmentBlocks: one gym's listing contains only its own.
      expect((await listDevelopmentBlocks(ORG_ID)).map((row) => row.block_id)).toEqual(['block-ours']);
      expect((await listDevelopmentBlocks(OTHER_ORG_ID)).map((row) => row.block_id)).toEqual(['block-theirs']);

      // listDevelopmentBlocksForAthlete: an athlete id alone is not a key
      // into this table -- only the (organization, athlete) pair is.
      expect(await listDevelopmentBlocksForAthlete(ORG_ID, OTHER_ATHLETE_ID)).toEqual([]);
      expect(await listDevelopmentBlocksForAthlete(OTHER_ORG_ID, ATHLETE_ID)).toEqual([]);
      expect((await listDevelopmentBlocksForAthlete(ORG_ID, ATHLETE_ID)).map((row) => row.block_id))
        .toEqual(['block-ours']);

      // setDevelopmentBlockStatus: the update cannot be used to probe for,
      // or to touch, another gym's block.
      expect(await setDevelopmentBlockStatus(ORG_ID, 'block-theirs', 'cancelled')).toBeNull();
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

      expect((await listDevelopmentBlocksForAthlete(ORG_ID, ATHLETE_ID)).map((row) => row.block_id))
        .toEqual(['block-fall', 'block-spring']);
      expect((await listDevelopmentBlocksForAthlete(ORG_ID, SECOND_ATHLETE_ID)).map((row) => row.block_id))
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
    const client = await freshDatabase('adb_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /ATHLETE_DEVELOPMENT_BLOCKS_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('adb_rdy_ok');
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
