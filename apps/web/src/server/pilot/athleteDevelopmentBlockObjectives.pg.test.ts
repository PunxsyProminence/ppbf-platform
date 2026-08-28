// Real PostgreSQL-backed contract test for the block-objectives migration
// (module 036, slice 2), AND for the real module behavior on top of it:
// './db' is mocked to route into the embedded server, so the functions
// exercised below are the actual production functions executing their actual
// SQL against actual rows.
//
// What needs proving that reading SQL cannot prove:
//   * the migration creates the table from nothing, and re-applying it is a
//     no-op -- including the DO block, which DROPS and RE-ADDS the domain
//     constraint on every run rather than guarding it, so "idempotent" here
//     is a stronger claim than `if not exists` and has to be shown;
//   * the domain vocabulary is exactly nine, with
//     'nutrition_body_composition' refused BY THE DATABASE -- the withheld
//     tenth, whose absence is a safeguarding decision and not an oversight;
//   * an objective cannot hang off a block in another organization, and
//     cannot outlive its block or its athlete (cascade through two levels);
//   * tenancy holds on every read this slice adds;
//   * a creator with no ACTIVE membership here is refused;
//   * the runner's readiness assertion refuses a database the migration
//     never reached, and does NOT encode the withheld domain (a deploy gate
//     that asserted a policy would block the release that reverses it).
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
  FULL_SPECTRUM_DOMAINS,
  addBlockObjective,
  getBlockObjective,
  listObjectivesForBlock,
  setBlockObjectiveStatus,
} from './athleteDevelopmentBlockObjectives';
import { ForbiddenError, ValidationError } from './errors';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-adb-objectives-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
// The parent must exist first: this table's composite FK points at it.
const PARENT_MIGRATION_FILE = 'pilot_slice_postgres_athlete_development_blocks_migration.sql';
const MIGRATION_FILE = 'pilot_slice_postgres_athlete_development_block_objectives_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-athlete-development-block-objectives-migration.mjs',
);

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-objectives';
const OTHER_ORG_ID = 'org-elsewhere';
const COACH_ID = 'acct-obj-coach';
const LAPSED_COACH_ID = 'acct-obj-lapsed';
const OTHER_COACH_ID = 'acct-obj-other-coach';
const ATHLETE_ID = 'ath-obj-1';
const OTHER_ATHLETE_ID = 'ath-obj-other';
const BLOCK_ID = 'block-obj-ours';
const OTHER_BLOCK_ID = 'block-obj-theirs';

const OBJECTIVE_TEXT = 'Jab off the back foot under pressure, not just off the front.';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let parentMigrationSql: string;
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

/** Base schema + the PARENT migration + a block in each of two gyms. The
 * objectives migration is deliberately NOT applied here, so each case
 * chooses whether to apply it and the runner's refusal case has a database
 * that is correctly set up in every respect except this one table. */
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
     values ($1, 'coach', $4, 'microsoft'),
            ($2, 'coach', $4, 'microsoft'),
            ($3, 'coach', $5, 'microsoft')
     on conflict do nothing`,
    [COACH_ID, LAPSED_COACH_ID, OTHER_COACH_ID, ORG_ID, OTHER_ORG_ID],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $4, 'coach', true),
            ($2, $4, 'coach', false),
            ($3, $5, 'coach', true)
     on conflict do nothing`,
    [COACH_ID, LAPSED_COACH_ID, OTHER_COACH_ID, ORG_ID, OTHER_ORG_ID],
  );
  for (const [org, athleteId, coachId] of [
    [ORG_ID, ATHLETE_ID, COACH_ID],
    [OTHER_ORG_ID, OTHER_ATHLETE_ID, OTHER_COACH_ID],
  ] as const) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Objectives Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [org, athleteId, coachId],
    );
  }

  await client.query(parentMigrationSql);
  for (const [org, blockId, athleteId, coachId] of [
    [ORG_ID, BLOCK_ID, ATHLETE_ID, COACH_ID],
    [OTHER_ORG_ID, OTHER_BLOCK_ID, OTHER_ATHLETE_ID, OTHER_COACH_ID],
  ] as const) {
    await client.query(
      `insert into pilot.athlete_development_blocks
         (organization_id, block_id, athlete_id, title, training_emphasis,
          starts_on, ends_on, created_by_account_id)
       values ($1, $2, $3, 'Fall strength block', 'Round-3 work rate',
               '2026-09-02'::date, '2026-10-14'::date, $4)`,
      [org, blockId, athleteId, coachId],
    );
  }
  return client;
}

async function migratedDatabase(name: string): Promise<Client> {
  const client = await freshDatabase(name);
  await client.query(migrationSql);
  activeClient = client;
  return client;
}

function insertObjective(
  client: Client,
  objectiveId: string,
  overrides: Record<string, string | null> = {},
) {
  return client.query(
    `insert into pilot.athlete_development_block_objectives
       (organization_id, objective_id, block_id, domain, objective, status, created_by_account_id)
     values ($1, $2, $3, $4, $5, coalesce($6, 'draft'), $7)`,
    [
      overrides.organization_id ?? ORG_ID,
      objectiveId,
      overrides.block_id ?? BLOCK_ID,
      overrides.domain ?? 'technical',
      overrides.objective ?? OBJECTIVE_TEXT,
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
  parentMigrationSql = await fs.readFile(path.join(INFRA_DIR, PARENT_MIGRATION_FILE), 'utf8');
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

describe('block objectives migration', () => {
  test('creates the table from nothing and accepts an objective', async () => {
    const client = await freshDatabase('adbo_fresh');
    try {
      const before = await client.query(
        `select to_regclass('pilot.athlete_development_block_objectives') as t`,
      );
      expect(before.rows[0].t).toBeNull();

      await client.query(migrationSql);
      await insertObjective(client, 'obj-1');

      const rows = await client.query(
        `select block_id, domain, objective, status, created_by_account_id
         from pilot.athlete_development_block_objectives where organization_id = $1`,
        [ORG_ID],
      );
      expect(rows.rows).toEqual([{
        block_id: BLOCK_ID,
        domain: 'technical',
        objective: OBJECTIVE_TEXT,
        status: 'draft',
        created_by_account_id: COACH_ID,
      }]);
    } finally {
      await client.end();
    }
  });

  test('re-applying is a no-op, even though the domain constraint is dropped and re-added', async () => {
    // The DO block reconciles rather than guards, so a second run genuinely
    // executes DROP CONSTRAINT + ADD CONSTRAINT against a table holding rows.
    // That is a stronger claim than `if not exists` and is worth proving:
    // the rows survive and the constraint still refuses what it refused.
    const client = await migratedDatabase('adbo_noop');
    try {
      await insertObjective(client, 'obj-keep');
      await client.query(migrationSql);

      const rows = await client.query(
        'select objective_id from pilot.athlete_development_block_objectives',
      );
      expect(rows.rows.map((r) => r.objective_id)).toEqual(['obj-keep']);

      await expect(insertObjective(client, 'obj-still-refused', { domain: 'nutrition_body_composition' }))
        .rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });

  test('the domain vocabulary is exactly the nine that ship', async () => {
    const client = await freshDatabase('adbo_domains');
    try {
      await client.query(migrationSql);

      for (const [index, domain] of [...FULL_SPECTRUM_DOMAINS].entries()) {
        await insertObjective(client, `obj-ok-${index}`, { domain });
      }

      const stored = await client.query<{ domain: string }>(
        'select distinct domain from pilot.athlete_development_block_objectives order by domain',
      );
      expect(stored.rows.map((r) => r.domain)).toEqual([...FULL_SPECTRUM_DOMAINS].sort());
    } finally {
      await client.end();
    }
  });

  test('nutrition / body composition is refused BY THE DATABASE, not only by the module', async () => {
    // The withheld tenth domain. This is a safeguarding decision -- filing a
    // minor's body-composition target as a queryable row waits on an owner
    // decision the privacy-tier registry makes possible and deliberately
    // does not make -- so it is enforced where a route that forgot to
    // validate still cannot get past it.
    const client = await freshDatabase('adbo_withheld');
    try {
      await client.query(migrationSql);

      await expect(insertObjective(client, 'obj-bodycomp', { domain: 'nutrition_body_composition' }))
        .rejects.toMatchObject({ code: '23514' });
      // Near spellings do not sneak it in either.
      for (const domain of ['nutrition', 'body_composition', 'weight_cut', 'weight_loss']) {
        await expect(insertObjective(client, `obj-${domain}`, { domain }))
          .rejects.toMatchObject({ code: '23514' });
      }
    } finally {
      await client.end();
    }
  });

  test('an invented domain, an invented status, and a blank objective are refused', async () => {
    const client = await freshDatabase('adbo_content');
    try {
      await client.query(migrationSql);

      await expect(insertObjective(client, 'obj-vibes', { domain: 'vibes' }))
        .rejects.toMatchObject({ code: '23514' });
      await expect(insertObjective(client, 'obj-caps', { domain: 'Technical' }))
        .rejects.toMatchObject({ code: '23514' });
      await expect(insertObjective(client, 'obj-archived', { status: 'archived' }))
        .rejects.toMatchObject({ code: '23514' });
      await expect(insertObjective(client, 'obj-blank', { objective: '' }))
        .rejects.toMatchObject({ code: '23514' });
      // Whitespace that is not a space -- the case btrim/1 lets through.
      await expect(insertObjective(client, 'obj-ws', { objective: '\t\n ' }))
        .rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });

  test('the table stores no computed progress, score or weighting', async () => {
    const client = await freshDatabase('adbo_columns');
    try {
      await client.query(migrationSql);
      const columns = await client.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'pilot' and table_name = 'athlete_development_block_objectives'
         order by column_name`,
      );
      const names = columns.rows.map((r) => r.column_name);
      expect(names).toEqual([
        'block_id', 'created_at', 'created_by_account_id', 'domain',
        'objective', 'objective_id', 'organization_id', 'status', 'updated_at',
      ]);
      for (const forbidden of [
        'progress', 'percent', 'score', 'rating', 'weight', 'attainment',
        'difficulty', 'readiness', 'compliance',
      ]) {
        expect(names.filter((n) => n.includes(forbidden))).toEqual([]);
      }
      // No athlete_id: the athlete arrives through the block, and a second
      // copy would be a second place for the answer to disagree.
      expect(names).not.toContain('athlete_id');
    } finally {
      await client.end();
    }
  });

  test('tenancy is composite: an objective cannot hang off another organization\'s block', async () => {
    const client = await freshDatabase('adbo_tenancy');
    try {
      await client.query(migrationSql);

      // Both directions. Each block id is real; the pair is not.
      await expect(insertObjective(client, 'obj-cross-a', { block_id: OTHER_BLOCK_ID }))
        .rejects.toMatchObject({ code: '23503' });
      await expect(insertObjective(client, 'obj-cross-b', {
        organization_id: OTHER_ORG_ID, block_id: BLOCK_ID, created_by_account_id: OTHER_COACH_ID,
      })).rejects.toMatchObject({ code: '23503' });

      // No orphan, and no anonymous author.
      await expect(insertObjective(client, 'obj-orphan', { block_id: 'block-nowhere' }))
        .rejects.toMatchObject({ code: '23503' });
      await expect(insertObjective(client, 'obj-ghost', { created_by_account_id: 'acct-ghost' }))
        .rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.end();
    }
  });

  test('an objective cannot outlive its block, or the athlete two levels up', async () => {
    const client = await freshDatabase('adbo_cascade');
    try {
      await client.query(migrationSql);
      await insertObjective(client, 'obj-cascade-block');

      await client.query(
        'delete from pilot.athlete_development_blocks where organization_id = $1 and block_id = $2',
        [ORG_ID, BLOCK_ID],
      );
      expect((await client.query('select objective_id from pilot.athlete_development_block_objectives')).rows)
        .toEqual([]);

      // And again through the athlete: athlete -> block -> objective, two
      // cascades deep, so deleting an athlete leaves nothing of their plan.
      await client.query(
        `insert into pilot.athlete_development_blocks
           (organization_id, block_id, athlete_id, title, training_emphasis, starts_on, ends_on, created_by_account_id)
         values ($1, 'block-again', $2, 'Winter block', 'Footwork', '2026-11-01'::date, '2026-12-15'::date, $3)`,
        [ORG_ID, ATHLETE_ID, COACH_ID],
      );
      await insertObjective(client, 'obj-cascade-athlete', { block_id: 'block-again' });

      await client.query('delete from pilot.athletes where organization_id = $1 and athlete_id = $2', [
        ORG_ID, ATHLETE_ID,
      ]);
      expect((await client.query('select objective_id from pilot.athlete_development_block_objectives')).rows)
        .toEqual([]);
    } finally {
      await client.end();
    }
  });
});

describe('the module writing and reading objectives', () => {
  test('a coach adds an objective, and their words come back exactly as written', async () => {
    const client = await migratedDatabase('adbo_mod_add');
    try {
      const created = await addBlockObjective({
        organizationId: ORG_ID,
        blockId: BLOCK_ID,
        domain: 'mental',
        objective: `  ${OBJECTIVE_TEXT}  `,
        createdByAccountId: COACH_ID,
      });
      expect(created).toMatchObject({
        organization_id: ORG_ID,
        block_id: BLOCK_ID,
        domain: 'mental',
        objective: OBJECTIVE_TEXT,
        status: 'draft',
        created_by_account_id: COACH_ID,
      });
    } finally {
      await client.end();
    }
  });

  test('the creator must hold an ACTIVE membership in the block\'s organization', async () => {
    const client = await migratedDatabase('adbo_mod_membership');
    try {
      for (const accountId of [OTHER_COACH_ID, LAPSED_COACH_ID]) {
        await expect(addBlockObjective({
          organizationId: ORG_ID,
          blockId: BLOCK_ID,
          domain: 'technical',
          objective: OBJECTIVE_TEXT,
          createdByAccountId: accountId,
        })).rejects.toBeInstanceOf(ForbiddenError);
      }
      expect((await client.query('select objective_id from pilot.athlete_development_block_objectives')).rows)
        .toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('another organization\'s block is a hidden not-found, and writes nothing', async () => {
    const client = await migratedDatabase('adbo_mod_block');
    try {
      await expect(addBlockObjective({
        organizationId: ORG_ID,
        blockId: OTHER_BLOCK_ID,
        domain: 'technical',
        objective: OBJECTIVE_TEXT,
        createdByAccountId: COACH_ID,
      })).resolves.toBeNull();
      await expect(addBlockObjective({
        organizationId: ORG_ID,
        blockId: 'block-never-existed',
        domain: 'technical',
        objective: OBJECTIVE_TEXT,
        createdByAccountId: COACH_ID,
      })).resolves.toBeNull();

      expect((await client.query('select objective_id from pilot.athlete_development_block_objectives')).rows)
        .toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('the withheld domain is refused before the database is touched, with a reason', async () => {
    const client = await migratedDatabase('adbo_mod_withheld');
    try {
      await expect(addBlockObjective({
        organizationId: ORG_ID,
        blockId: BLOCK_ID,
        domain: 'nutrition_body_composition' as never,
        objective: 'Cut to 132 by the October show.',
        createdByAccountId: COACH_ID,
      })).rejects.toThrow(/pending an owner decision/);

      await expect(addBlockObjective({
        organizationId: ORG_ID,
        blockId: BLOCK_ID,
        domain: 'technical',
        objective: '   ',
        createdByAccountId: COACH_ID,
      })).rejects.toBeInstanceOf(ValidationError);

      expect((await client.query('select objective_id from pilot.athlete_development_block_objectives')).rows)
        .toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('a block\'s objectives read back grouped by domain in Full Spectrum order', async () => {
    const client = await migratedDatabase('adbo_mod_list');
    try {
      // Inserted deliberately out of order.
      await insertObjective(client, 'obj-lifestyle', { domain: 'lifestyle_athlete_identity' });
      await insertObjective(client, 'obj-technical', { domain: 'technical' });
      await insertObjective(client, 'obj-conditioning', { domain: 'conditioning' });

      const listed = await listObjectivesForBlock(ORG_ID, BLOCK_ID);
      expect(listed.map((row) => row.domain)).toEqual([
        'technical', 'conditioning', 'lifestyle_athlete_identity',
      ]);
    } finally {
      await client.end();
    }
  });

  test('a human moves one objective without touching its block or its siblings', async () => {
    const client = await migratedDatabase('adbo_mod_lifecycle');
    try {
      await insertObjective(client, 'obj-a', { domain: 'technical' });
      await insertObjective(client, 'obj-b', { domain: 'mental' });

      expect((await setBlockObjectiveStatus(ORG_ID, 'obj-a', 'cancelled'))?.status).toBe('cancelled');
      await expect(setBlockObjectiveStatus(ORG_ID, 'obj-a', 'archived' as never))
        .rejects.toBeInstanceOf(ValidationError);

      // The sibling is untouched: nothing cascades a status sideways.
      expect((await getBlockObjective(ORG_ID, 'obj-b'))?.status).toBe('draft');
      // And the parent block is untouched: a cancelled objective inside a
      // running block is an honest state, not a contradiction to resolve.
      const block = await client.query(
        'select status from pilot.athlete_development_blocks where organization_id = $1 and block_id = $2',
        [ORG_ID, BLOCK_ID],
      );
      expect(block.rows).toEqual([{ status: 'draft' }]);
    } finally {
      await client.end();
    }
  });
});

describe('one gym cannot reach another gym through any read this slice adds', () => {
  test('every read path is organization-scoped', async () => {
    const client = await migratedDatabase('adbo_isolation');
    try {
      await insertObjective(client, 'obj-ours');
      await insertObjective(client, 'obj-theirs', {
        organization_id: OTHER_ORG_ID,
        block_id: OTHER_BLOCK_ID,
        created_by_account_id: OTHER_COACH_ID,
      });

      expect(await getBlockObjective(ORG_ID, 'obj-theirs')).toBeNull();
      expect(await getBlockObjective(OTHER_ORG_ID, 'obj-ours')).toBeNull();
      expect((await getBlockObjective(ORG_ID, 'obj-ours'))?.objective_id).toBe('obj-ours');

      // A block id alone is not a key into this table -- only the pair is.
      expect(await listObjectivesForBlock(ORG_ID, OTHER_BLOCK_ID)).toEqual([]);
      expect(await listObjectivesForBlock(OTHER_ORG_ID, BLOCK_ID)).toEqual([]);

      // The update cannot probe for, or touch, another gym's objective.
      expect(await setBlockObjectiveStatus(ORG_ID, 'obj-theirs', 'cancelled')).toBeNull();
      const theirs = await client.query(
        'select status from pilot.athlete_development_block_objectives where objective_id = $1',
        ['obj-theirs'],
      );
      expect(theirs.rows).toEqual([{ status: 'draft' }]);
    } finally {
      await client.end();
    }
  });
});

// The runner's OWN readiness assertion. Every case above applies
// `migrationSql` with a plain client.query, which proves the schema and
// proves nothing about the shipped READINESS_QUERY that gates a dispatch.
describe('block objectives runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    // Note what this database HAS: base schema, the parent blocks migration,
    // two gyms, two blocks. It is correct in every respect except this one
    // table, so the refusal below is specific rather than incidental.
    const client = await freshDatabase('adbo_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /ATHLETE_DEVELOPMENT_BLOCK_OBJECTIVES_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('adbo_rdy_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });

  test('the readiness gate does NOT encode the withheld domain', async () => {
    // A deploy gate that asserted 'nutrition_body_composition' is absent
    // would refuse every dispatch the day the owner reverses that decision --
    // turning a one-line vocabulary change into a blocked release. The
    // policy lives in the migration and in this suite, which change together;
    // the gate checks structure only.
    const runnerSource = await fs.readFile(MIGRATION_RUNNER_PATH, 'utf8');
    const readinessQuery = runnerSource.slice(
      runnerSource.indexOf('const READINESS_QUERY'),
      runnerSource.indexOf('function assertReadiness'),
    );
    expect(readinessQuery).toContain('domain_vocabulary_ready');
    expect(readinessQuery).not.toContain('nutrition_body_composition');
    expect(readinessQuery).not.toMatch(/not like/i);
  });
});
