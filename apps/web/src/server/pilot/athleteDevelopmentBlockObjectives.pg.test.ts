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
//   * the domain vocabulary is exactly the ten Full Spectrum domains --
//     nutrition_body_composition shipped withheld and was admitted by owner
//     decision 2026-08-28, and the cases that guarded the withholding now
//     guard what that decision did NOT change;
//   * an objective cannot hang off a block in another organization, and
//     cannot outlive its block or its athlete (cascade through two levels);
//   * tenancy holds on every read this slice adds, AND athlete scoping does
//     on top of it: objectives carry no athlete_id, so every read resolves
//     its parent through getDevelopmentBlock and inherits that block's
//     access answer. Only a real database can show that the inheritance is
//     real rather than intended -- an unassigned coach of the same gym has
//     to come back empty through the objective, not just through the block;
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

import type { ActorIdentity } from './access';
import {
  FULL_SPECTRUM_DOMAINS,
  addBlockObjective,
  getBlockObjective,
  listObjectivesForBlock,
  setBlockObjectiveStatus,
} from './athleteDevelopmentBlockObjectives';
import type { PilotRole } from './contracts';
import { ForbiddenError, ValidationError } from './errors';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-adb-objectives-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_athlete_development_block_objectives_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-athlete-development-block-objectives-migration.mjs',
);
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-objectives';
const OTHER_ORG_ID = 'org-elsewhere';
const ADMIN_ID = 'acct-obj-admin';
const OTHER_ADMIN_ID = 'acct-obj-other-admin';
// Coach of record for both athletes in ORG_ID.
const COACH_ID = 'acct-obj-coach';
const LAPSED_COACH_ID = 'acct-obj-lapsed';
// Active coach membership here, coach of record for nobody, no coverage.
const UNASSIGNED_COACH_ID = 'acct-obj-unassigned';
const OTHER_COACH_ID = 'acct-obj-other-coach';
// Active memberships HERE, in roles that may not author.
const ATHLETE_ACCOUNT_ID = 'acct-obj-athlete-account';
const SECOND_ATHLETE_ACCOUNT_ID = 'acct-obj-athlete-account-2';
const PARENT_ACCOUNT_ID = 'acct-obj-parent';
const UNLINKED_PARENT_ACCOUNT_ID = 'acct-obj-parent-unlinked';
const PARENT_ROW_ID = 'parent-obj-1';
const UNLINKED_PARENT_ROW_ID = 'parent-obj-2';
const ATHLETE_ID = 'ath-obj-1';
const SECOND_ATHLETE_ID = 'ath-obj-2';
const OTHER_ATHLETE_ID = 'ath-obj-other';
const BLOCK_ID = 'block-obj-ours';
const SECOND_BLOCK_ID = 'block-obj-sibling';
const OTHER_BLOCK_ID = 'block-obj-theirs';

/* One actor per arm of assertActorCanAccessAthlete, plus the near-miss for
   each. Access to an objective is not decided here -- it is decided on the
   parent block -- so these exist to prove the inheritance actually happens
   rather than being asserted in a comment. */
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
const UNASSIGNED_COACH = actorFor(UNASSIGNED_COACH_ID, 'coach');
const ATHLETE = actorFor(ATHLETE_ACCOUNT_ID, 'athlete', ORG_ID, ATHLETE_ID);
const SECOND_ATHLETE = actorFor(SECOND_ATHLETE_ACCOUNT_ID, 'athlete', ORG_ID, SECOND_ATHLETE_ID);
const GUARDIAN = actorFor(PARENT_ACCOUNT_ID, 'parent');
const UNLINKED_GUARDIAN = actorFor(UNLINKED_PARENT_ACCOUNT_ID, 'parent');
// Refused unconditionally by the chokepoint, so they need no account row.
const PLATFORM_OWNER = actorFor('acct-obj-owner', 'platform_owner');
const BOARD = actorFor('acct-obj-board', 'board');

const OBJECTIVE_TEXT = 'Jab off the back foot under pressure, not just off the front.';

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
 * THE WHOLE SCHEMA, then this slice's own table dropped back off when a case
 * needs to watch it get created.
 *
 * Why the whole schema: this suite drives feature code that resolves access
 * through the parent block, and that path reads pilot.athletes.deleted_at --
 * a column belonging to the data-retention migration, which the hand-picked
 * hand-picked migration list would never have named. A suite that picks its
 * own migrations is testing a database that has never existed anywhere. See
 * scripts/lib/full-schema.mjs and #706.
 *
 * `preMigration` leaves everything else standing -- two gyms, three blocks,
 * every account and link -- so the runner's refusal case has a database that
 * is correct in every respect except this one table.
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
     values ($1, 'organization_admin', $10, 'microsoft', null),
            ($2, 'coach',              $10, 'microsoft', null),
            ($3, 'coach',              $10, 'microsoft', null),
            ($4, 'coach',              $10, 'microsoft', null),
            ($5, 'coach',              $11, 'microsoft', null),
            ($6, 'athlete',            $10, 'microsoft', $12),
            ($7, 'athlete',            $10, 'microsoft', $13),
            ($8, 'parent',             $10, 'microsoft', null),
            ($9, 'parent',             $10, 'microsoft', null),
            ($14, 'organization_admin', $11, 'microsoft', null)
     on conflict do nothing`,
    [ADMIN_ID, COACH_ID, LAPSED_COACH_ID, UNASSIGNED_COACH_ID, OTHER_COACH_ID,
     ATHLETE_ACCOUNT_ID, SECOND_ATHLETE_ACCOUNT_ID, PARENT_ACCOUNT_ID, UNLINKED_PARENT_ACCOUNT_ID,
     ORG_ID, OTHER_ORG_ID, ATHLETE_ID, SECOND_ATHLETE_ID, OTHER_ADMIN_ID],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1,  $11, 'organization_admin', true),
            ($2,  $11, 'coach',              true),
            ($3,  $11, 'coach',              false),
            ($4,  $11, 'coach',              true),
            ($5,  $12, 'coach',              true),
            ($6,  $11, 'athlete',            true),
            ($7,  $11, 'athlete',            true),
            ($8,  $11, 'parent',             true),
            ($9,  $11, 'parent',             true),
            ($10, $12, 'organization_admin', true)
     on conflict do nothing`,
    [ADMIN_ID, COACH_ID, LAPSED_COACH_ID, UNASSIGNED_COACH_ID, OTHER_COACH_ID,
     ATHLETE_ACCOUNT_ID, SECOND_ATHLETE_ACCOUNT_ID, PARENT_ACCOUNT_ID, UNLINKED_PARENT_ACCOUNT_ID,
     OTHER_ADMIN_ID, ORG_ID, OTHER_ORG_ID],
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
       values ($1, $2, 'Objectives Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [org, athleteId, coachId],
    );
  }

  // One parent LINKED to ATHLETE_ID, one parent of the same gym linked to
  // nobody. Without the second, every guardian assertion below would also
  // pass for an implementation that let any parent read any athlete.
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

  for (const [org, blockId, athleteId, coachId] of [
    [ORG_ID, BLOCK_ID, ATHLETE_ID, COACH_ID],
    [ORG_ID, SECOND_BLOCK_ID, SECOND_ATHLETE_ID, COACH_ID],
    [OTHER_ORG_ID, OTHER_BLOCK_ID, OTHER_ATHLETE_ID, OTHER_COACH_ID],
  ] as const) {
    await client.query(
      `insert into pilot.athlete_development_blocks
         (organization_id, block_id, athlete_id, title, training_emphasis,
          starts_on, ends_on, created_by_account_id)
       values ($1, $2, $3, 'Fall strength block', 'Round-3 work rate',
               '2026-09-02'::date, '2026-10-14'::date, $4)
       on conflict do nothing`,
      [org, blockId, athleteId, coachId],
    );
  }

  if (preMigration) {
    await client.query('drop table if exists pilot.athlete_development_block_objectives cascade');
  }

  return client;
}

async function migratedDatabase(name: string): Promise<Client> {
  const client = await freshDatabase(name);
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

describe('block objectives migration', () => {
  test('creates the table from nothing and accepts an objective', async () => {
    const client = await freshDatabase('adbo_fresh', { preMigration: true });
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

      // The constraint still refuses what it refused: re-adding it must not
      // quietly widen the vocabulary. 'nutrition_body_composition' is no
      // longer the probe for that (it was admitted 2026-08-28), so this uses
      // a value that was never a domain and never will be.
      await expect(insertObjective(client, 'obj-still-refused', { domain: 'weight_cut' }))
        .rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });

  test('the domain vocabulary is exactly the ten that ship', async () => {
    const client = await freshDatabase('adbo_domains', { preMigration: true });
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

  test('nutrition / body composition is accepted, and near spellings still are not', async () => {
    // Admitted by owner decision 2026-08-28, once module 200 (the
    // Privacy-Tier System) existed to answer what tier the field sits at.
    // What was admitted is one domain label: the free-form weight vocabulary
    // below was never a domain and still is not, and this is where a later
    // change that over-reads that decision would surface first.
    const client = await freshDatabase('adbo_bodycomp', { preMigration: true });
    try {
      await client.query(migrationSql);

      await insertObjective(client, 'obj-bodycomp', { domain: 'nutrition_body_composition' });
      const stored = await client.query(
        'select domain from pilot.athlete_development_block_objectives where objective_id = $1',
        ['obj-bodycomp'],
      );
      expect(stored.rows).toEqual([{ domain: 'nutrition_body_composition' }]);

      for (const domain of ['nutrition', 'body_composition', 'weight_cut', 'weight_loss', 'weight_gain']) {
        await expect(insertObjective(client, `obj-${domain}`, { domain }))
          .rejects.toMatchObject({ code: '23514' });
      }
    } finally {
      await client.end();
    }
  });

  test('admitting the tenth domain left pilot.goals.category alone', async () => {
    // A separate surface -- athlete-filed, athlete-readable -- whose own
    // migration withholds 'Weight Loss' and 'Weight Gain'. The 2026-08-28
    // decision was about coach-authored objectives and did not reverse it.
    // Asserted here because "we decided body composition is fine" is exactly
    // the kind of summary that travels further than the decision did.
    const client = await freshDatabase('adbo_goals_untouched', { preMigration: true });
    try {
      await client.query(migrationSql);
      // pilot.goals and its category constraint arrive with the full schema
      // this fixture applies -- the whole repository's migrations, this
      // slice's own excepted. Nothing here re-applies them.

      const insertGoal = (goalId: string, category: string) => client.query(
        `insert into pilot.goals
           (organization_id, goal_id, athlete_id, title, target_date, metric, status,
            category, created_at, updated_at)
         values ($1, $2, $3, 'A goal', '2026-12-01'::date, 'rounds', 'active', $4, now(), now())`,
        [ORG_ID, goalId, ATHLETE_ID, category],
      );

      await insertGoal('goal-ok', 'Fitness');
      for (const category of ['Weight Loss', 'Weight Gain']) {
        await expect(insertGoal(`goal-${category.replace(' ', '-')}`, category))
          .rejects.toMatchObject({ code: '23514' });
      }
    } finally {
      await client.end();
    }
  });

  test('an invented domain, an invented status, and a blank objective are refused', async () => {
    const client = await freshDatabase('adbo_content', { preMigration: true });
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
    const client = await freshDatabase('adbo_columns', { preMigration: true });
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
    const client = await freshDatabase('adbo_tenancy', { preMigration: true });
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
    const client = await freshDatabase('adbo_cascade', { preMigration: true });
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
        actor: COACH,
        blockId: BLOCK_ID,
        domain: 'mental',
        objective: `  ${OBJECTIVE_TEXT}  `,
      });
      expect(created).toMatchObject({
        organization_id: ORG_ID,
        block_id: BLOCK_ID,
        domain: 'mental',
        objective: OBJECTIVE_TEXT,
        status: 'draft',
        // Provenance comes from the actor. There is no caller-supplied
        // author field left to disagree with the identity that was
        // authorized.
        created_by_account_id: COACH_ID,
      });
    } finally {
      await client.end();
    }
  });

  test('the creator must be an admin or coach with an ACTIVE membership here', async () => {
    // Three denials, one message. The other gym's coach, a former coach of
    // this one, and an active member in a role that may not author (owner
    // decision 2026-08-28: "Admin and coaches"). The gate is the parent
    // module's, imported rather than restated, so blocks and objectives
    // cannot drift apart.
    const client = await migratedDatabase('adbo_mod_membership');
    try {
      for (const actor of [
        actorFor(OTHER_COACH_ID, 'coach', ORG_ID),
        LAPSED_COACH,
        ATHLETE,
        GUARDIAN,
      ]) {
        await expect(addBlockObjective({
          actor,
          blockId: BLOCK_ID,
          domain: 'technical',
          objective: OBJECTIVE_TEXT,
        })).rejects.toBeInstanceOf(ForbiddenError);
      }
      expect((await client.query('select objective_id from pilot.athlete_development_block_objectives')).rows)
        .toEqual([]);

      // The control: an admin of this gym, who may.
      const created = await addBlockObjective({
        actor: ADMIN,
        blockId: BLOCK_ID,
        domain: 'technical',
        objective: OBJECTIVE_TEXT,
      });
      expect(created?.created_by_account_id).toBe(ADMIN_ID);
    } finally {
      await client.end();
    }
  });

  test('another organization\'s block is a hidden not-found, and writes nothing', async () => {
    const client = await migratedDatabase('adbo_mod_block');
    try {
      await expect(addBlockObjective({
        actor: COACH,
        blockId: OTHER_BLOCK_ID,
        domain: 'technical',
        objective: OBJECTIVE_TEXT,
      })).resolves.toBeNull();
      await expect(addBlockObjective({
        actor: COACH,
        blockId: 'block-never-existed',
        domain: 'technical',
        objective: OBJECTIVE_TEXT,
      })).resolves.toBeNull();

      expect((await client.query('select objective_id from pilot.athlete_development_block_objectives')).rows)
        .toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('a coach of this gym who cannot open the block cannot add to it', async () => {
    /* The read decision reaching this table. The objective has no
       athlete_id, so this is not a rule the module states -- it resolves the
       parent through getDevelopmentBlock, which is athlete-scoped, and
       inherits the answer. A coach with an active membership here, coach of
       record for nobody, gets the same null a stranger's block gives. */
    const client = await migratedDatabase('adbo_mod_unassigned');
    try {
      await expect(addBlockObjective({
        actor: UNASSIGNED_COACH,
        blockId: BLOCK_ID,
        domain: 'technical',
        objective: OBJECTIVE_TEXT,
      })).resolves.toBeNull();
      expect((await client.query('select objective_id from pilot.athlete_development_block_objectives')).rows)
        .toEqual([]);

      // The control: make them the athlete's coach and the identical call
      // succeeds, so the null above means "not your athlete" rather than
      // "not a writer".
      await client.query(
        'update pilot.athletes set coach_id = $1 where organization_id = $2 and athlete_id = $3',
        [UNASSIGNED_COACH_ID, ORG_ID, ATHLETE_ID],
      );
      const created = await addBlockObjective({
        actor: UNASSIGNED_COACH,
        blockId: BLOCK_ID,
        domain: 'technical',
        objective: OBJECTIVE_TEXT,
      });
      expect(created?.block_id).toBe(BLOCK_ID);
    } finally {
      await client.end();
    }
  });

  test('a body-composition objective is accepted, and an unsound one is still refused', async () => {
    const client = await migratedDatabase('adbo_mod_shape');
    try {
      const created = await addBlockObjective({
        actor: COACH,
        blockId: BLOCK_ID,
        domain: 'nutrition_body_composition',
        objective: 'Eat a real breakfast before morning conditioning.',
      });
      expect(created?.domain).toBe('nutrition_body_composition');

      await expect(addBlockObjective({
        actor: COACH,
        blockId: BLOCK_ID,
        domain: 'technical',
        objective: '   ',
      })).rejects.toBeInstanceOf(ValidationError);
      await expect(addBlockObjective({
        actor: COACH,
        blockId: BLOCK_ID,
        domain: 'weight_cut' as never,
        objective: 'Cut to 132 by the October show.',
      })).rejects.toBeInstanceOf(ValidationError);

      const written = await client.query(
        'select objective_id from pilot.athlete_development_block_objectives',
      );
      expect(written.rows).toHaveLength(1);
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

      const listed = await listObjectivesForBlock(COACH, BLOCK_ID);
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

      expect((await setBlockObjectiveStatus(COACH, 'obj-a', 'cancelled'))?.status).toBe('cancelled');
      await expect(setBlockObjectiveStatus(COACH, 'obj-a', 'archived' as never))
        .rejects.toBeInstanceOf(ValidationError);

      // The sibling is untouched: nothing cascades a status sideways.
      expect((await getBlockObjective(COACH, 'obj-b'))?.status).toBe('draft');
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

  test('reading an objective does not confer moving it', async () => {
    /* An athlete and their guardian can now read these rows. Whether an
       objective was met is the coach's judgment this table exists to record
       rather than compute, so the status setter carries the same write gate
       the author does. Each refusal below is preceded by the read that
       proves the actor could see the row -- otherwise a failure could be
       dismissed as "they never had access". */
    const client = await migratedDatabase('adbo_mod_status_gate');
    try {
      await insertObjective(client, 'obj-gated', { domain: 'technical' });

      for (const actor of [ATHLETE, GUARDIAN]) {
        expect((await getBlockObjective(actor, 'obj-gated'))?.objective_id).toBe('obj-gated');
        await expect(setBlockObjectiveStatus(actor, 'obj-gated', 'completed'))
          .rejects.toBeInstanceOf(ForbiddenError);
      }

      const untouched = await client.query(
        'select status from pilot.athlete_development_block_objectives where objective_id = $1',
        ['obj-gated'],
      );
      expect(untouched.rows).toEqual([{ status: 'draft' }]);
    } finally {
      await client.end();
    }
  });
});

describe('access is inherited from the block, arm by arm', () => {
  /* The owner decision of 2026-08-28 -- "Admin, Coach, Athlete, Guardian" --
     observed through a table that stores no athlete_id at all.

     Every case pairs the arm that must PASS with the near-miss that must
     FAIL. Both reads are exercised in each, because a rule enforced in
     getBlockObjective and forgotten in listObjectivesForBlock is not
     enforced. */

  async function seeded(name: string): Promise<Client> {
    const client = await migratedDatabase(name);
    await insertObjective(client, 'obj-mine', { domain: 'technical' });
    await insertObjective(client, 'obj-sibling', {
      domain: 'technical', block_id: SECOND_BLOCK_ID,
    });
    return client;
  }

  test('an organization admin reads the gym; an admin of the other gym reads none of it', async () => {
    const client = await seeded('adbo_read_admin');
    try {
      expect((await getBlockObjective(ADMIN, 'obj-mine'))?.objective_id).toBe('obj-mine');
      expect((await listObjectivesForBlock(ADMIN, BLOCK_ID)).map((r) => r.objective_id))
        .toEqual(['obj-mine']);

      expect(await getBlockObjective(OTHER_ADMIN, 'obj-mine')).toBeNull();
      expect(await listObjectivesForBlock(OTHER_ADMIN, BLOCK_ID)).toEqual([]);
      expect(await setBlockObjectiveStatus(OTHER_ADMIN, 'obj-mine', 'cancelled')).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('a coach reads their own athletes\' objectives, and an unassigned coach of the same gym reads none', async () => {
    const client = await seeded('adbo_read_coach');
    try {
      expect((await getBlockObjective(COACH, 'obj-mine'))?.objective_id).toBe('obj-mine');
      expect((await listObjectivesForBlock(COACH, SECOND_BLOCK_ID)).map((r) => r.objective_id))
        .toEqual(['obj-sibling']);

      expect(await getBlockObjective(UNASSIGNED_COACH, 'obj-mine')).toBeNull();
      expect(await listObjectivesForBlock(UNASSIGNED_COACH, BLOCK_ID)).toEqual([]);
      // A writer here by role, and still not for this athlete: the status
      // setter answers null rather than moving a row they cannot read.
      expect(await setBlockObjectiveStatus(UNASSIGNED_COACH, 'obj-mine', 'cancelled')).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('an athlete reads their own block\'s objectives and not the next athlete\'s', async () => {
    const client = await seeded('adbo_read_athlete');
    try {
      expect((await getBlockObjective(ATHLETE, 'obj-mine'))?.objective_id).toBe('obj-mine');
      expect((await listObjectivesForBlock(ATHLETE, BLOCK_ID)).map((r) => r.objective_id))
        .toEqual(['obj-mine']);

      // Same gym, same role, same membership -- a different athlete.
      expect(await getBlockObjective(ATHLETE, 'obj-sibling')).toBeNull();
      expect(await listObjectivesForBlock(ATHLETE, SECOND_BLOCK_ID)).toEqual([]);
      expect((await getBlockObjective(SECOND_ATHLETE, 'obj-sibling'))?.objective_id)
        .toBe('obj-sibling');
      expect(await getBlockObjective(SECOND_ATHLETE, 'obj-mine')).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('a linked guardian reads their child\'s objectives; an unlinked parent of the same gym reads none', async () => {
    const client = await seeded('adbo_read_guardian');
    try {
      expect((await getBlockObjective(GUARDIAN, 'obj-mine'))?.objective_id).toBe('obj-mine');
      expect((await listObjectivesForBlock(GUARDIAN, BLOCK_ID)).map((r) => r.objective_id))
        .toEqual(['obj-mine']);
      // Linked to one athlete, so the gym's other athlete is not theirs.
      expect(await getBlockObjective(GUARDIAN, 'obj-sibling')).toBeNull();

      expect(await getBlockObjective(UNLINKED_GUARDIAN, 'obj-mine')).toBeNull();
      expect(await listObjectivesForBlock(UNLINKED_GUARDIAN, BLOCK_ID)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('platform_owner and board are refused, as they are everywhere else', async () => {
    const client = await seeded('adbo_read_refused');
    try {
      for (const actor of [PLATFORM_OWNER, BOARD]) {
        expect(await getBlockObjective(actor, 'obj-mine')).toBeNull();
        expect(await listObjectivesForBlock(actor, BLOCK_ID)).toEqual([]);
      }
    } finally {
      await client.end();
    }
  });

  test('a soft-deleted athlete takes their objectives out of staff and guardian reach, two levels up', async () => {
    /* The nutrition_body_composition domain is why this case is here rather
       than only on the parent. An objective may now hold a body-composition
       sentence naming a minor; when the gym deletes that athlete, the
       sentence has to stop being readable through the objective as well as
       through the block. Each refusal is preceded by the read that proves
       the actor had access a moment earlier.

       THE ATHLETE ARM IS EXEMPT, AND THAT IS A FINDING RATHER THAN A
       DESIGN. assertActorCanAccessAthlete answers the athlete-self question
       in memory -- actor.athleteId compared to the requested id -- without
       ever asking whether the athlete row is live, so a withdrawn athlete
       keeps reading their own objectives. That is access.ts's behavior for
       every one of its callers, not something this slice introduced. See
       the parent suite's copy of this case for why it is asserted here and
       decided elsewhere: whether a withdrawn athlete keeps reading their own
       record is an owner question, and it is open on module 036. */
    const client = await seeded('adbo_read_deleted');
    try {
      for (const actor of [ADMIN, COACH, ATHLETE, GUARDIAN]) {
        expect((await getBlockObjective(actor, 'obj-mine'))?.objective_id).toBe('obj-mine');
      }

      await client.query(
        'update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2',
        [ORG_ID, ATHLETE_ID],
      );

      for (const actor of [ADMIN, COACH, GUARDIAN]) {
        expect(await getBlockObjective(actor, 'obj-mine')).toBeNull();
        expect(await listObjectivesForBlock(actor, BLOCK_ID)).toEqual([]);
      }

      // The gap, stated as behavior. If access.ts's athlete arm gains the
      // deleted_at predicate, this fails and names the decision that moved.
      expect((await getBlockObjective(ATHLETE, 'obj-mine'))?.objective_id).toBe('obj-mine');

      // The row is untouched: an access rule, not a delete.
      const stored = await client.query(
        'select objective_id from pilot.athlete_development_block_objectives where objective_id = $1',
        ['obj-mine'],
      );
      expect(stored.rows).toEqual([{ objective_id: 'obj-mine' }]);
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

      expect(await getBlockObjective(ADMIN, 'obj-theirs')).toBeNull();
      expect(await getBlockObjective(OTHER_ADMIN, 'obj-ours')).toBeNull();
      expect((await getBlockObjective(ADMIN, 'obj-ours'))?.objective_id).toBe('obj-ours');

      // A block id alone is not a key into this table -- only the pair is.
      expect(await listObjectivesForBlock(ADMIN, OTHER_BLOCK_ID)).toEqual([]);
      expect(await listObjectivesForBlock(OTHER_ADMIN, BLOCK_ID)).toEqual([]);

      // The update cannot probe for, or touch, another gym's objective.
      expect(await setBlockObjectiveStatus(ADMIN, 'obj-theirs', 'cancelled')).toBeNull();
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
    const client = await freshDatabase('adbo_rdy_no', { preMigration: true });
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /ATHLETE_DEVELOPMENT_BLOCK_OBJECTIVES_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('adbo_rdy_ok', { preMigration: true });
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });

  test('the readiness gate does not encode the domain policy, in either direction', async () => {
    // This one paid for itself. The gate was deliberately written not to
    // assert 'nutrition_body_composition' was ABSENT, on the grounds that a
    // deploy gate encoding a policy is a landmine under the decision that
    // changes it -- and within the hour the owner changed it. The reversal
    // was one line in the migration and one in the module, with no runner
    // edit and no blocked release. It stays policy-free in the other
    // direction too, for the same reason.
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
