// Real PostgreSQL-backed contract test for the Safety Escalations migration
// (pilot.safety_escalations) -- capability #194.
//
// Unlike the safety-gate-matrix and compliance-rule-seeds migrations, this
// one seeds nothing: an escalation only exists once a near miss, pain
// report, or safety-gate flag actually happens, so an empty table after
// migration is the correct starting state, not a gap to prove closed.
// What needs proving instead:
//
// 1. The table and its vocabulary constraints exist and are enforced by the
//    database, not only by the TypeScript module.
// 2. 'board' is specifically rejected as an escalated_to_role -- board is
//    an aggregate-only side channel, not a rung on this ladder, and that
//    boundary should not be something only application code remembers.
// 3. Foreign keys hold: an escalation cannot reference an athlete or
//    organization that does not exist.
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

// Routes escalationLadder.ts's queries into whichever embedded database the
// current test opened (the coachCoverage suite's pattern), so listEscalations
// below is the REAL production function executing its REAL SQL -- the
// athlete_voice exclusion predicate lives in that SQL, and a unit mock can
// only assert the string, not the behavior.
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

import { listEscalations } from './escalationLadder';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-safety-escalations-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_safety_escalations_migration.sql';

const ORG_ID = 'org-escalations';
const COACH_ID = 'acct-escalations-coach';
const ATHLETE_ID = 'ATH-ESCALATIONS-1';

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

/**
 * Fresh database with the base schema and one org/coach/athlete.
 *
 * `dropEscalationsTableFirst` reproduces the only kind of database the
 * increment migration exists for: one from BEFORE this change, where
 * pilot_slice_postgres.sql had not yet grown the table. Without it, every
 * assertion in this suite ran against the base schema's copy of the table
 * and the migration's `create table if not exists` was a guaranteed no-op --
 * the migration itself was never actually under test.
 */
async function freshDatabase(
  name: string,
  { applyIncrement = false, dropEscalationsTableFirst = false }: { applyIncrement?: boolean; dropEscalationsTableFirst?: boolean } = {},
): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  if (dropEscalationsTableFirst) {
    await client.query('drop table if exists pilot.safety_escalations cascade');
  }
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG_ID],
  );
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Escalations Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  if (applyIncrement) {
    await client.query(migrationSql);
  }
  return client;
}

/** Column shapes + check constraints + indexes for pilot.safety_escalations, for the drift diff. */
async function escalationsTableShape(client: Client) {
  const columns = await client.query(
    `select column_name, data_type, is_nullable, coalesce(column_default, '') as column_default
     from information_schema.columns
     where table_schema = 'pilot' and table_name = 'safety_escalations'
     order by column_name`,
  );
  const checks = await client.query(
    `select pg_get_constraintdef(oid) as def
     from pg_constraint
     where conrelid = to_regclass('pilot.safety_escalations')
     order by pg_get_constraintdef(oid)`,
  );
  const indexes = await client.query(
    // indexdef, not just indexname: a name can match while columns, order,
    // or DESC drift -- the exact thing this diff exists to catch.
    `select indexname, indexdef from pg_indexes
     where schemaname = 'pilot' and tablename = 'safety_escalations'
     order by indexname`,
  );
  return { columns: columns.rows, checks: checks.rows, indexes: indexes.rows };
}

async function insertEscalation(client: Client, overrides: Partial<Record<string, unknown>> = {}): Promise<void> {
  const row = {
    escalation_id: 'esc-1',
    source_type: 'near_miss',
    source_id: null,
    athlete_id: ATHLETE_ID,
    severity: 'critical',
    reason: 'Contact logged without a current medical clearance.',
    escalated_to_role: 'organization_admin',
    triggered_by: 'system',
    triggered_by_account_id: COACH_ID,
    triggered_by_role: 'coach',
    status: 'open',
    ...overrides,
  };
  await client.query(
    `insert into pilot.safety_escalations (
       organization_id, escalation_id, source_type, source_id, athlete_id,
       severity, reason, escalated_to_role, triggered_by,
       triggered_by_account_id, triggered_by_role, status
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      ORG_ID,
      row.escalation_id,
      row.source_type,
      row.source_id,
      row.athlete_id,
      row.severity,
      row.reason,
      row.escalated_to_role,
      row.triggered_by,
      row.triggered_by_account_id,
      row.triggered_by_role,
      row.status,
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

describe('safety escalations against real Postgres', () => {
  test('the base schema already carries the table (fresh environments need no increment)', async () => {
    const client = await freshDatabase('ppbf_test_escalations_base');
    try {
      const { rows } = await client.query(`select count(*)::int as n from pilot.safety_escalations`);
      expect(rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('re-running the increment migration on top of the base schema is a safe no-op', async () => {
    const client = await freshDatabase('ppbf_test_escalations_rerun');
    try {
      await insertEscalation(client);
      await client.query(migrationSql);

      const { rows } = await client.query(`select escalation_id from pilot.safety_escalations where organization_id = $1`, [ORG_ID]);
      expect(rows).toEqual([{ escalation_id: 'esc-1' }]);
    } finally {
      await client.end();
    }
  });

  test('status defaults to open, and every timestamp/resolution column starts empty', async () => {
    const client = await freshDatabase('ppbf_test_escalations_defaults', { dropEscalationsTableFirst: true, applyIncrement: true });
    try {
      await insertEscalation(client);

      const { rows } = await client.query(
        `select status, acknowledged_at, resolved_at, resolution_note from pilot.safety_escalations where escalation_id = 'esc-1'`,
      );
      expect(rows[0]).toEqual({ status: 'open', acknowledged_at: null, resolved_at: null, resolution_note: '' });
    } finally {
      await client.end();
    }
  });

  test.each([
    ['source_type', 'source_type', 'made_up_source'],
    ['severity', 'severity', 'urgent'],
    ['status', 'status', 'unread'],
    ['escalated_to_role', 'escalated_to_role', 'board'],
    ['escalated_to_role', 'escalated_to_role', 'platform_owner'],
    ['triggered_by', 'triggered_by', 'ai'],
  ])('the database refuses an invalid %s value', async (_label, column, badValue) => {
    const client = await freshDatabase('ppbf_test_escalations_vocab', { dropEscalationsTableFirst: true, applyIncrement: true });
    try {
      await expect(insertEscalation(client, { [column]: badValue })).rejects.toThrow(/violates check constraint/i);
    } finally {
      await client.end();
    }
  });

  // #198 widened the source_type vocabulary: athleteVoice.ts files these when
  // an athlete's feedback submission routes to safeguarding.
  test('the athlete_voice source_type stores, carrying the submission pointer in source_id', async () => {
    const client = await freshDatabase('ppbf_test_escalations_voice', { dropEscalationsTableFirst: true, applyIncrement: true });
    try {
      await insertEscalation(client, { source_type: 'athlete_voice', source_id: 'sub-123' });
      const { rows } = await client.query(
        `select source_type, source_id from pilot.safety_escalations where escalation_id = 'esc-1'`,
      );
      expect(rows[0]).toEqual({ source_type: 'athlete_voice', source_id: 'sub-123' });
    } finally {
      await client.end();
    }
  });

  test('every admitted status value stores', async () => {
    const client = await freshDatabase('ppbf_test_escalations_status_admits', { dropEscalationsTableFirst: true, applyIncrement: true });
    try {
      for (const [index, status] of ['open', 'acknowledged', 'resolved'].entries()) {
        await client.query(
          `insert into pilot.safety_escalations (
             organization_id, escalation_id, source_type, athlete_id, severity, reason,
             escalated_to_role, triggered_by, status
           ) values ($1,$2,'near_miss',$3,'low','x','coach','system',$4)`,
          [ORG_ID, `esc-status-${index}`, ATHLETE_ID, status],
        );
      }
      const { rows } = await client.query(
        `select status from pilot.safety_escalations where organization_id = $1 order by status`,
        [ORG_ID],
      );
      expect(rows.map((r) => r.status)).toEqual(['acknowledged', 'open', 'resolved']);
    } finally {
      await client.end();
    }
  });

  test('an escalation cannot reference an athlete that does not exist', async () => {
    const client = await freshDatabase('ppbf_test_escalations_fk_athlete', { dropEscalationsTableFirst: true, applyIncrement: true });
    try {
      await expect(insertEscalation(client, { athlete_id: 'ATH-DOES-NOT-EXIST' })).rejects.toThrow(
        /violates foreign key constraint/i,
      );
    } finally {
      await client.end();
    }
  });

  test('an escalation cannot reference an organization that does not exist', async () => {
    const client = await freshDatabase('ppbf_test_escalations_fk_org', { dropEscalationsTableFirst: true, applyIncrement: true });
    try {
      await expect(
        client.query(
          `insert into pilot.safety_escalations (
             organization_id, escalation_id, source_type, athlete_id, severity, reason,
             escalated_to_role, triggered_by
           ) values ('org-does-not-exist','esc-x','near_miss',$1,'low','x','coach','system')`,
          [ATHLETE_ID],
        ),
      ).rejects.toThrow(/violates foreign key constraint/i);
    } finally {
      await client.end();
    }
  });

  test('resolving stamps resolved_at, resolved_by, and the resolution note together', async () => {
    const client = await freshDatabase('ppbf_test_escalations_resolve', { dropEscalationsTableFirst: true, applyIncrement: true });
    try {
      await insertEscalation(client);

      await client.query(
        `update pilot.safety_escalations
         set status = 'resolved', resolved_by_account_id = $2, resolved_at = now(), resolution_note = $3
         where organization_id = $1 and escalation_id = 'esc-1'`,
        [ORG_ID, COACH_ID, 'Cleared by physician, note on file.'],
      );

      const { rows } = await client.query(
        `select status, resolved_by_account_id, resolution_note, resolved_at is not null as has_resolved_at
         from pilot.safety_escalations where escalation_id = 'esc-1'`,
      );
      expect(rows[0]).toEqual({
        status: 'resolved',
        resolved_by_account_id: COACH_ID,
        resolution_note: 'Cleared by physician, note on file.',
        has_resolved_at: true,
      });
    } finally {
      await client.end();
    }
  });

  test('source_id is nullable, for a repeated_pattern escalation with no single originating row', async () => {
    const client = await freshDatabase('ppbf_test_escalations_null_source', { dropEscalationsTableFirst: true, applyIncrement: true });
    try {
      await client.query(
        `insert into pilot.safety_escalations (
           organization_id, escalation_id, source_type, source_id, athlete_id, severity, reason,
           escalated_to_role, triggered_by, metadata
         ) values ($1,'esc-pattern','repeated_pattern',null,$2,'high','pattern reason','organization_admin','system','{"trigger_key":"x"}'::jsonb)`,
        [ORG_ID, ATHLETE_ID],
      );

      const { rows } = await client.query(
        `select source_id, metadata from pilot.safety_escalations where escalation_id = 'esc-pattern'`,
      );
      expect(rows[0]).toEqual({ source_id: null, metadata: { trigger_key: 'x' } });
    } finally {
      await client.end();
    }
  });

  // NEGATIVE CONTROL for everything above: the pre-migration shape is real.
  // If this fails, dropEscalationsTableFirst is broken and every
  // { dropEscalationsTableFirst: true, applyIncrement: true } test in this
  // file is silently back to testing the base schema's copy.
  test('the pre-migration shape is reproducible: dropped table, increment not applied, table absent', async () => {
    const client = await freshDatabase('ppbf_test_escalations_premigration', { dropEscalationsTableFirst: true });
    try {
      await expect(client.query('select 1 from pilot.safety_escalations')).rejects.toThrow(
        /relation "pilot.safety_escalations" does not exist/i,
      );
    } finally {
      await client.end();
    }
  });

  // The table is defined twice by hand -- once in pilot_slice_postgres.sql
  // for fresh environments, once in the increment migration for existing
  // ones -- and nothing else compares them. Any drift here means a
  // fresh-built gym and a migrated gym silently run different schemas: the
  // exact defect class the safety-gate seeds ownership test exists to
  // prevent for seed VALUES, asserted here for table SHAPE.
  test('the base-schema table and the migration-built table are byte-for-byte the same shape', async () => {
    const baseBuilt = await freshDatabase('ppbf_test_escalations_shape_base');
    const migrationBuilt = await freshDatabase('ppbf_test_escalations_shape_migrated', {
      dropEscalationsTableFirst: true,
      applyIncrement: true,
    });
    try {
      const baseShape = await escalationsTableShape(baseBuilt);
      const migratedShape = await escalationsTableShape(migrationBuilt);
      expect(migratedShape.columns).toEqual(baseShape.columns);
      expect(migratedShape.checks).toEqual(baseShape.checks);
      expect(migratedShape.indexes).toEqual(baseShape.indexes);
    } finally {
      await baseBuilt.end();
      await migrationBuilt.end();
    }
  });

  // #198: a database where an EARLIER revision of this migration ran carries
  // the four-value source_type CHECK. create-if-not-exists no-ops there, so
  // the repair do-block must widen the stale CHECK in place -- otherwise
  // every athlete_voice filing violates the constraint, and the filing code
  // deliberately swallows that failure (oracle safety), making the loss
  // silent. This reproduces the stale database and re-runs the migration.
  test('re-running the migration widens a stale pre-athlete_voice CHECK in place', async () => {
    const client = await freshDatabase('ppbf_test_escalations_stale_check', {
      dropEscalationsTableFirst: true,
      applyIncrement: true,
    });
    try {
      // Regress the CHECK to the pre-#198 vocabulary.
      await client.query('alter table pilot.safety_escalations drop constraint safety_escalations_source_type_check');
      await client.query(
        `alter table pilot.safety_escalations
         add constraint safety_escalations_source_type_check
         check (source_type in ('near_miss', 'pain_report', 'safety_gate_evaluation', 'repeated_pattern'))`,
      );
      await expect(insertEscalation(client, { source_type: 'athlete_voice' })).rejects.toThrow(
        /violates check constraint/i,
      );

      // Re-apply: the repair block must widen it.
      await client.query(migrationSql);
      await insertEscalation(client, { escalation_id: 'esc-repaired', source_type: 'athlete_voice' });
      const { rows } = await client.query(
        `select source_type from pilot.safety_escalations where escalation_id = 'esc-repaired'`,
      );
      expect(rows[0]).toEqual({ source_type: 'athlete_voice' });
    } finally {
      await client.end();
    }
  });
});

// ─── the real listEscalations against real rows (#198 coach exclusion) ───────
//
// The exclusion predicate lives in listEscalations' SQL. The unit test can
// only assert the string contains it; this executes the actual function
// against actual rows, so an inverted or deleted predicate fails HERE even
// while every string assertion stays green.

describe('the real listEscalations against real rows', () => {
  afterEach(() => {
    activeClient = null;
  });

  test('excludeAthleteVoice strips athlete_voice rows and nothing else; omitting it returns them', async () => {
    const client = await freshDatabase('ppbf_test_escalations_real_list', {
      dropEscalationsTableFirst: true,
      applyIncrement: true,
    });
    activeClient = client;
    try {
      await insertEscalation(client, { escalation_id: 'esc-nm', source_type: 'near_miss' });
      await insertEscalation(client, { escalation_id: 'esc-av', source_type: 'athlete_voice', source_id: 'sub-1' });

      // The coach-shaped call: athlete-scoped, exclusion on.
      const coachView = await listEscalations(ORG_ID, { athleteIds: [ATHLETE_ID], excludeAthleteVoice: true });
      expect(coachView.map((row) => row.escalation_id)).toEqual(['esc-nm']);

      // The admin-shaped call: no exclusion -- both rows, critical first.
      const adminView = await listEscalations(ORG_ID, {});
      expect(adminView.map((row) => row.escalation_id).sort()).toEqual(['esc-av', 'esc-nm']);

      // An explicit false behaves like omission, not like true.
      const explicitFalse = await listEscalations(ORG_ID, { athleteIds: [ATHLETE_ID], excludeAthleteVoice: false });
      expect(explicitFalse.map((row) => row.escalation_id).sort()).toEqual(['esc-av', 'esc-nm']);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});
