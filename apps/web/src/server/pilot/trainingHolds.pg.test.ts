// Real PostgreSQL-backed contract test for the training-holds migration
// (pilot.training_holds, capability #82) and for the REAL module behavior on
// top of it: './db' is mocked to route into the embedded server, so
// placeTrainingHold, liftTrainingHold, findRegistrationBlockingHold, and
// registerForClassTransactionally below are the actual production functions
// executing their actual SQL against actual rows. The acceptance criteria
// (a hold blocks registration; lifting restores it; the escalation files in
// the same transaction; one active hold per athlete) are proven at the only
// altitude that can prove them.
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
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return fn({ query: (text: string, values: unknown[]) => activeClient!.query(text, values) });
  }),
}));

import { registerForClassTransactionally } from './schedulerDb';
import {
  findRegistrationBlockingHold,
  flagContactDuringHold,
  getActiveTrainingHold,
  liftTrainingHold,
  placeTrainingHold,
} from './trainingHolds';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-training-holds-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_training_holds_migration.sql';

const ORG_ID = 'org-holds';
const COACH_ID = 'acct-coach-1';
const ADMIN_ID = 'acct-admin-1';
const ATHLETE_ID = 'ATH-HOLD-1';
const CLASS_ID = 'class-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
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

async function freshDatabase(
  name: string,
  { applyIncrement = false, dropHoldsTableFirst = false }: { applyIncrement?: boolean; dropHoldsTableFirst?: boolean } = {},
): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  if (dropHoldsTableFirst) {
    await client.query('drop table if exists pilot.training_holds cascade');
  }
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  for (const [account, role] of [[COACH_ID, 'coach'], [ADMIN_ID, 'organization_admin']] as const) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'microsoft') on conflict do nothing`,
      [account, role, ORG_ID],
    );
  }
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Held Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  await client.query(
    `insert into pilot.scheduler_classes (organization_id, class_id, title, start_at, end_at, location, capacity, scheduled_by_account_id, coach_account_id, status)
     values ($1, $2, 'Youth Boxing', now() + interval '1 day', now() + interval '1 day 1 hour', 'Main Floor', 10, $3, $3, 'open')`,
    [ORG_ID, CLASS_ID, COACH_ID],
  );
  if (applyIncrement) {
    await client.query(migrationSql);
  }
  return client;
}

function placeInput(overrides: Partial<Parameters<typeof placeTrainingHold>[0]> = {}) {
  return {
    organizationId: ORG_ID,
    athleteId: ATHLETE_ID,
    scope: 'all_training' as const,
    reasonCategory: 'medical' as const,
    reasonText: 'Concussion protocol pending clearance.',
    athleteExplanation: 'We are giving your head time to heal before you train again.',
    liftConditionText: 'A doctor says you are ready.',
    placedByAccountId: COACH_ID,
    placedByRole: 'coach' as const,
    ...overrides,
  };
}

function registration() {
  const now = new Date().toISOString();
  return {
    registration_id: `reg-${Math.random().toString(36).slice(2, 10)}`,
    class_id: CLASS_ID,
    athlete_id: ATHLETE_ID,
    requested_by_role: 'athlete',
    requested_by_account_id: 'acct-athlete-1',
    parent_reviewed: false,
    created_at: now,
    updated_at: now,
  } as Parameters<typeof registerForClassTransactionally>[3];
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
  // pilot.shadow_near_misses is not in the base schema -- the REGRESS rung's
  // contact flag writes near misses, so its migration is part of the floor.
  baseSchemaSql += await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_shadow_decision_loop_migration.sql'),
    'utf8',
  );
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
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
});

afterEach(() => {
  activeClient = null;
});

describe('the real hold lifecycle against real rows (#82 acceptance)', () => {
  test('place -> escalation filed in the same transaction -> registration blocked -> lift -> registration open', async () => {
    const client = await freshDatabase('ppbf_test_holds_lifecycle', { dropHoldsTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      const placed = await placeTrainingHold(placeInput());

      // The alarm exists, points at the hold, and names no staff detail.
      const escalations = await client.query(
        `select source_type, source_id, severity, reason from pilot.safety_escalations
         where organization_id = $1 and athlete_id = $2`,
        [ORG_ID, ATHLETE_ID],
      );
      expect(escalations.rows).toHaveLength(1);
      expect(escalations.rows[0]).toMatchObject({ source_type: 'training_hold', source_id: placed.hold_id, severity: 'high' });
      expect(escalations.rows[0].reason.toLowerCase()).not.toContain('concussion');

      // STOP: the real scheduler function refuses with the hold's words.
      const blocked = await registerForClassTransactionally(ORG_ID, CLASS_ID, ATHLETE_ID, registration());
      expect(blocked).toEqual({
        outcome: 'training_hold',
        holdId: placed.hold_id,
        athleteExplanation: 'We are giving your head time to heal before you train again.',
        liftConditionText: 'A doctor says you are ready.',
      });

      // Lift, attributed -- and the door reopens.
      const lifted = await liftTrainingHold(ORG_ID, placed.hold_id, ADMIN_ID, 'Doctor cleared.');
      expect(lifted).toMatchObject({ status: 'lifted', lifted_by_account_id: ADMIN_ID });
      await expect(getActiveTrainingHold(ORG_ID, ATHLETE_ID)).resolves.toBeNull();

      const open = await registerForClassTransactionally(ORG_ID, CLASS_ID, ATHLETE_ID, registration());
      expect(open).toMatchObject({ outcome: 'registered' });
    } finally {
      await client.end();
    }
  });

  test('a scoped (REGRESS) hold does not block registration, and flags contact instead', async () => {
    const client = await freshDatabase('ppbf_test_holds_scoped', { dropHoldsTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      await placeTrainingHold(placeInput({ scope: 'contact_only', reasonCategory: 'fatigue' }));

      const outcome = await registerForClassTransactionally(ORG_ID, CLASS_ID, ATHLETE_ID, registration());
      expect(outcome).toMatchObject({ outcome: 'registered' });

      // Contact logged during the hold raises a high near miss (the real
      // shadowNearMisses path) -- record kept, alarm raised.
      const flagged = await flagContactDuringHold({
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        kind: 'contact_level',
        value: 2,
        actorAccountId: COACH_ID,
        actorRole: 'coach',
        contextId: 'ctx-session-1',
        observedAt: new Date().toISOString(),
      });
      expect(flagged.flagged).toBe(true);

      const nearMisses = await client.query(
        `select severity, metadata->>'trigger' as trigger from pilot.shadow_near_misses
         where organization_id = $1 and athlete_id = $2`,
        [ORG_ID, ATHLETE_ID],
      );
      expect(nearMisses.rows).toContainEqual({ severity: 'high', trigger: 'contact_observation_during_training_hold' });
    } finally {
      await client.end();
    }
  });

  test('one active hold per athlete: the partial unique index refuses a second even under raw SQL', async () => {
    const client = await freshDatabase('ppbf_test_holds_unique', { dropHoldsTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      const placed = await placeTrainingHold(placeInput());
      await expect(placeTrainingHold(placeInput({ scope: 'contact_only' }))).rejects.toThrow(/^Hold already exists/);

      // Even bypassing the module, the database itself refuses.
      await expect(
        client.query(
          `insert into pilot.training_holds (organization_id, hold_id, athlete_id, scope, reason_category, athlete_explanation, placed_by_account_id, placed_by_role)
           values ($1, 'hold-race', $2, 'all_training', 'other', 'x', $3, 'admin')`,
          [ORG_ID, ATHLETE_ID, ADMIN_ID],
        ),
      ).rejects.toThrow(/idx_training_holds_one_active|duplicate key/i);

      // A lifted hold does not block a new one.
      await liftTrainingHold(ORG_ID, placed.hold_id, ADMIN_ID, '');
      await expect(placeTrainingHold(placeInput())).resolves.toMatchObject({ status: 'active' });
    } finally {
      await client.end();
    }
  });

  test('re-lifting is an Unsupported transition, and an expired hold stops mattering at read time', async () => {
    const client = await freshDatabase('ppbf_test_holds_transitions', { dropHoldsTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      const placed = await placeTrainingHold(placeInput());
      await liftTrainingHold(ORG_ID, placed.hold_id, ADMIN_ID, 'Cleared.');
      await expect(liftTrainingHold(ORG_ID, placed.hold_id, COACH_ID, 'again')).rejects.toThrow(
        "Unsupported transition: hold is 'lifted' and cannot be lifted",
      );
      // The first lift's attribution survives the failed second attempt.
      const { rows } = await client.query(
        `select lifted_by_account_id, lift_note from pilot.training_holds where hold_id = $1`,
        [placed.hold_id],
      );
      expect(rows[0]).toEqual({ lifted_by_account_id: ADMIN_ID, lift_note: 'Cleared.' });

      // A hold whose clock ran out: status still 'active', but every read
      // excludes it -- expiry needs no cron.
      await client.query(
        `insert into pilot.training_holds (organization_id, hold_id, athlete_id, scope, reason_category, athlete_explanation, placed_by_account_id, placed_by_role, placed_at, expires_at)
         values ($1, 'hold-expired', $2, 'all_training', 'other', 'x', $3, 'admin', now() - interval '2 days', now() - interval '1 day')`,
        [ORG_ID, ATHLETE_ID, ADMIN_ID],
      );
      await expect(getActiveTrainingHold(ORG_ID, ATHLETE_ID)).resolves.toBeNull();
      await expect(findRegistrationBlockingHold(ORG_ID, ATHLETE_ID)).resolves.toBeNull();
    } finally {
      await client.end();
    }
  });

  test('a database without the holds table degrades to pre-#82 behavior, never a 500', async () => {
    const client = await freshDatabase('ppbf_test_holds_missing', { dropHoldsTableFirst: true });
    activeClient = client;
    try {
      await expect(findRegistrationBlockingHold(ORG_ID, ATHLETE_ID)).resolves.toBeNull();
      const outcome = await registerForClassTransactionally(ORG_ID, CLASS_ID, ATHLETE_ID, registration());
      expect(outcome).toMatchObject({ outcome: 'registered' });
      await expect(
        flagContactDuringHold({
          organizationId: ORG_ID,
          athleteId: ATHLETE_ID,
          kind: 'contact_level',
          value: 2,
          actorAccountId: COACH_ID,
          actorRole: 'coach',
          contextId: 'ctx-1',
          observedAt: new Date().toISOString(),
        }),
      ).resolves.toEqual({ flagged: false });
    } finally {
      await client.end();
    }
  });
});

describe('training holds schema against real Postgres', () => {
  test.each([
    ['scope', 'weekends_only'],
    ['reason_category', 'vibes'],
    ['status', 'paused'],
    ['placed_by_role', 'athlete'],
  ])('the database refuses an invalid %s value', async (column, badValue) => {
    const client = await freshDatabase('ppbf_test_holds_vocab', { dropHoldsTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      const defaults: Record<string, string> = {
        scope: 'all_training',
        reason_category: 'other',
        status: 'active',
        placed_by_role: 'coach',
      };
      const row = { ...defaults, [column]: badValue };
      await expect(
        client.query(
          `insert into pilot.training_holds (organization_id, hold_id, athlete_id, scope, reason_category, athlete_explanation, placed_by_account_id, placed_by_role, status)
           values ($1, 'hold-vocab', $2, $3, $4, 'x', $5, $6, $7)`,
          [ORG_ID, ATHLETE_ID, row.scope, row.reason_category, COACH_ID, row.placed_by_role, row.status],
        ),
      ).rejects.toThrow(/violates check constraint/i);
    } finally {
      await client.end();
    }
  });

  test('a blank athlete_explanation is refused by the database, not just the route', async () => {
    const client = await freshDatabase('ppbf_test_holds_explanation', { dropHoldsTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      await expect(
        client.query(
          `insert into pilot.training_holds (organization_id, hold_id, athlete_id, scope, reason_category, athlete_explanation, placed_by_account_id, placed_by_role)
           values ($1, 'hold-blank', $2, 'all_training', 'other', '   ', $3, 'coach')`,
          [ORG_ID, ATHLETE_ID, COACH_ID],
        ),
      ).rejects.toThrow(/violates check constraint/i);
    } finally {
      await client.end();
    }
  });

  test('the widened audit vocabulary admits the hold events and still refuses inventions', async () => {
    const client = await freshDatabase('ppbf_test_holds_audit', { dropHoldsTableFirst: true, applyIncrement: true });
    activeClient = client;
    try {
      for (const eventType of ['safety_hold_placed', 'safety_hold_lifted']) {
        await client.query(
          `insert into pilot.audit_events (event_type, actor_account_id, actor_role, organization_id, entity_type, entity_id, details)
           values ($1, $2, 'coach', $3, 'training_hold', 'hold-1', '{}'::jsonb)`,
          [eventType, COACH_ID, ORG_ID],
        );
      }
      await expect(
        client.query(
          `insert into pilot.audit_events (event_type, actor_account_id, actor_role, organization_id, entity_type, entity_id, details)
           values ('safety_hold_extended', $1, 'coach', $2, 'training_hold', 'hold-1', '{}'::jsonb)`,
          [COACH_ID, ORG_ID],
        ),
      ).rejects.toThrow(/violates check constraint/i);
    } finally {
      await client.end();
    }
  });

  test('the pre-migration shape is reproducible: dropped table, increment not applied, table absent', async () => {
    const client = await freshDatabase('ppbf_test_holds_premigration', { dropHoldsTableFirst: true });
    activeClient = client;
    try {
      await expect(client.query('select 1 from pilot.training_holds')).rejects.toThrow(
        /relation "pilot.training_holds" does not exist/i,
      );
    } finally {
      await client.end();
    }
  });

  // The table is defined twice by hand (base schema for fresh environments,
  // increment for existing ones); this is the drift alarm.
  test('the base-schema table and the migration-built table are the same shape', async () => {
    const baseBuilt = await freshDatabase('ppbf_test_holds_shape_base');
    const migrationBuilt = await freshDatabase('ppbf_test_holds_shape_migrated', {
      dropHoldsTableFirst: true,
      applyIncrement: true,
    });
    try {
      async function shape(client: Client) {
        const columns = await client.query(
          `select column_name, data_type, is_nullable, coalesce(column_default, '') as column_default
           from information_schema.columns
           where table_schema = 'pilot' and table_name = 'training_holds'
           order by column_name`,
        );
        const checks = await client.query(
          `select pg_get_constraintdef(oid) as def
           from pg_constraint
           where conrelid = to_regclass('pilot.training_holds')
           order by pg_get_constraintdef(oid)`,
        );
        const indexes = await client.query(
          `select indexname, indexdef from pg_indexes
           where schemaname = 'pilot' and tablename = 'training_holds'
           order by indexname`,
        );
        return { columns: columns.rows, checks: checks.rows, indexes: indexes.rows };
      }
      const baseShape = await shape(baseBuilt);
      const migratedShape = await shape(migrationBuilt);
      expect(migratedShape.columns).toEqual(baseShape.columns);
      expect(migratedShape.checks).toEqual(baseShape.checks);
      expect(migratedShape.indexes).toEqual(baseShape.indexes);
    } finally {
      await baseBuilt.end();
      await migrationBuilt.end();
    }
  });
});
