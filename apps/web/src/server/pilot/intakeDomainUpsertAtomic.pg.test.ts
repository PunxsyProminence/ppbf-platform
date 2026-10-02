// Real PostgreSQL proof that POST /api/pilot/intake/domain-upsert writes a
// record and the three rows that account for it as ONE unit.
//
// WHAT WAS WRONG. The route ran four (for guardian_link, five) separate
// autocommit statements: the record, then pilot.audit_events, then
// pilot.shadow_events, then pilot.shadow_telemetry_events. The record was
// committed the moment its own statement returned. A failure on any later
// statement answered 500 for a write that had already happened: the coach's
// page showed a failure and kept the draft, the coach sent it again, and a
// Message Home reached the family's feed twice -- the first copy possibly with
// no audit row at all.
//
// WHY THIS CANNOT BE A MOCKED TEST. route.test.ts can show that each writer is
// handed the transaction's client. It cannot show that a row is gone, because
// only a database decides what a rollback removes. Here the later statement
// fails for real -- a trigger on the table raises -- and the assertion is a
// count of what is left in every table the request could have touched.
//
// The whole route handler runs, with its real authority check and its real
// athlete-access check against seeded rows. Only requirePrincipal is stubbed,
// the same seam the other route-driving .pg suites use.
//
// NOT COVERED, deliberately: a write that commits but whose answer never
// reaches the browser. A transaction cannot close that; it needs a request key
// from the page.
//
// Spins up the same disposable, local-only embedded Postgres the other suites
// use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import type { Readable } from 'node:stream';

import { NextRequest } from 'next/server';
import { Client } from 'pg';

import { requirePrincipal } from './http';
import type { PilotPrincipal } from './auth';

jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-intake-upsert-atomic-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const TEST_DB_NAME = 'ppbf_test_intake_upsert_atomic';

const ORG = 'org-atomic';
const ATHLETE = 'ath-atomic';
const UNASSIGNED_ATHLETE = 'ath-atomic-unassigned';
const ADMIN = 'acct-atomic-admin';
const COACH = 'acct-atomic-coach';
const OTHER_COACH = 'acct-atomic-other-coach';
const GUARDIAN = 'acct-atomic-guardian';

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;
let domainUpsert: typeof import('@/app/api/pilot/intake/domain-upsert/route').POST;
let listParentMessages: typeof import('./intake').listParentMessages;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
        return;
      }
      server.close(() => reject(new Error('Could not determine a free port')));
    });
  });
}

function principal(accountId: string, role: PilotPrincipal['role']): PilotPrincipal {
  return {
    accountId,
    role,
    organizationId: ORG,
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  } as PilotPrincipal;
}

/* Every table a domain-upsert request can write to. The record tables first,
   then the three accounting tables. pilot.shadow_authority_checks is counted
   separately: it is written BEFORE the transaction and is meant to survive. */
const RECORD_TABLES = [
  'emergency_contacts',
  'medical_intake',
  'waivers',
  'assessments',
  'attendance',
  'readiness',
  'coach_observations',
  'parents',
  'guardian_links',
] as const;
const ACCOUNTING_TABLES = ['audit_events', 'shadow_events', 'shadow_telemetry_events'] as const;
const WRITTEN_TABLES = [...RECORD_TABLES, ...ACCOUNTING_TABLES] as const;

type Counts = Record<string, number>;

async function countRows(tables: readonly string[]): Promise<Counts> {
  const counts: Counts = {};
  for (const table of tables) {
    const result = await db.query<{ n: string }>(
      `select count(*)::text as n from pilot.${table} where organization_id = $1`,
      [ORG],
    );
    counts[table] = Number(result.rows[0].n);
  }
  return counts;
}

async function authorityChecks(): Promise<number> {
  const result = await db.query<{ n: string }>(
    'select count(*)::text as n from pilot.shadow_authority_checks where organization_id = $1',
    [ORG],
  );
  return Number(result.rows[0].n);
}

/* A REAL failure, raised by the database on the table named. Not a rejected
   mock: the statement reaches Postgres, Postgres refuses it, and whatever is
   left behind afterwards is what Postgres actually kept. */
async function failInsertsOn(table: string): Promise<void> {
  await db.query(
    `create trigger lane_d_injected_failure before insert on pilot.${table}
       for each row execute function pilot.lane_d_injected_failure()`,
  );
}

async function stopFailing(table: string): Promise<void> {
  await db.query(`drop trigger if exists lane_d_injected_failure on pilot.${table}`);
}

let sequence = 0;

interface EntityCase {
  entityType: string;
  /** The table(s) the record itself lands in. */
  recordTables: readonly string[];
  payload: () => Record<string, unknown>;
}

/* One real payload per entity type the route accepts. Each call makes a fresh
   one, so a count going up by one can only be this request's row. */
const ENTITY_CASES: EntityCase[] = [
  {
    entityType: 'emergency_contact',
    recordTables: ['emergency_contacts'],
    payload: () => ({ full_name: `Contact ${++sequence}`, phone: '555-0100', relationship_to_athlete: 'aunt' }),
  },
  {
    entityType: 'medical',
    recordTables: ['medical_intake'],
    payload: () => ({ conditions: `asthma ${++sequence}`, clearance_status: 'pending' }),
  },
  {
    entityType: 'waiver',
    recordTables: ['waivers'],
    payload: () => ({ waiver_type: 'general', signed_by_name: `Signer ${++sequence}`, signed_by_role: 'guardian', status: 'signed' }),
  },
  {
    entityType: 'assessment',
    recordTables: ['assessments'],
    payload: () => ({ assessment_type: 'intake_assessment', result: { score: ++sequence } }),
  },
  {
    entityType: 'attendance',
    recordTables: ['attendance'],
    // A different day each time, so no rule about one row per day can be what
    // decides the count.
    payload: () => ({ attendance_date: `2026-01-${String((++sequence % 28) + 1).padStart(2, '0')}`, status: 'present' }),
  },
  {
    entityType: 'readiness',
    recordTables: ['readiness'],
    payload: () => ({ score: 5, category: `general-${++sequence}` }),
  },
  {
    entityType: 'coach_note',
    recordTables: ['coach_observations'],
    payload: () => ({ note_type: 'parent_message', note_text: `Please bring the medical form on Thursday (${++sequence}).` }),
  },
  {
    entityType: 'guardian_link',
    recordTables: ['parents', 'guardian_links'],
    // A new parent_id each time: both statements are upserts, and only an
    // INSERT shows up in a count.
    payload: () => ({ parent_id: `par-atomic-${++sequence}`, full_name: 'Second Guardian', relationship_to_athlete: 'father' }),
  },
];

async function post(entityType: string, payload: Record<string, unknown>, athleteId = ATHLETE) {
  const response = await domainUpsert(new NextRequest('http://localhost/api/pilot/intake/domain-upsert', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entity_type: entityType, athlete_id: athleteId, payload }),
  }));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  PG_PORT = await freePort();

  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => {
    stderrOutput += String(chunk);
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

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  db = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await db.connect();

  // The whole schema, every migration in dependency order -- the shape
  // production runs, not the base file plus whichever migrations were
  // remembered (see guardianContactProjection.pg.test.ts for why).
  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  const applyFullSchema = helper.applyFullSchema as (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
  await applyFullSchema(db, { infraDir: INFRA_DIR });

  await db.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, 'Atomic Intake Gym', 'active')`,
    [ORG],
  );
  for (const [accountId, role] of [[ADMIN, 'organization_admin'], [COACH, 'coach'], [OTHER_COACH, 'coach'], [GUARDIAN, 'parent']]) {
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'microsoft')`,
      [accountId, role, ORG],
    );
  }
  await db.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at)
     values
       ($1, $2, 'Rosa Ortiz', '2012-04-03', 'youth-60', 'active', 'Guardian', true, $4, now(), now()),
       ($1, $3, 'Not This Coach', '2011-01-01', 'youth-65', 'active', 'Nobody', true, $5, now(), now())`,
    [ORG, ATHLETE, UNASSIGNED_ATHLETE, COACH, OTHER_COACH],
  );
  await db.query(
    `create function pilot.lane_d_injected_failure() returns trigger language plpgsql as $$
     begin
       raise exception 'injected failure on %', tg_table_name;
     end $$`,
  );

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  domainUpsert = (await import('@/app/api/pilot/intake/domain-upsert/route')).POST;
  listParentMessages = (await import('./intake')).listParentMessages;
});

afterAll(async () => {
  const { closePool } = await import('./db');
  await closePool().catch(() => {});
  await db?.end().catch(() => {});

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

let errorSpy: jest.SpyInstance | undefined;

/* A 500 only counts if it is THE injected one. jsonError logs the error class
   and SQLSTATE of every unhandled failure, and P0001 is what a plpgsql
   `raise exception` carries -- so a 500 from anything else on the way to the
   record (a bad seed, a broken payload) cannot pass for the failure under
   test. */
function expectInjectedFailureWasTheCause(): void {
  expect(errorSpy).toHaveBeenCalledWith('unhandled-route-error', expect.objectContaining({ code: 'P0001' }));
}

beforeEach(() => {
  mockRequirePrincipal.mockResolvedValue(principal(ADMIN, 'organization_admin'));
  // jsonError logs the class and SQLSTATE of every 500. Expected here, by the
  // dozen; silenced so a real diagnostic is not buried under them.
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  errorSpy?.mockRestore();
  for (const table of WRITTEN_TABLES) {
    await stopFailing(table);
  }
});

/* ── The baseline: with nothing failing, each entity type writes its rows ────
   A "nothing was left behind" assertion is only worth as much as the proof
   that the same request, unhindered, leaves something. Without this, a payload
   the route refused outright would pass every rollback case below. */
describe('with nothing failing', () => {
  test.each(ENTITY_CASES)('$entityType commits its record and exactly one of each accounting row', async (entity) => {
    const before = await countRows(WRITTEN_TABLES);

    const { status, body } = await post(entity.entityType, entity.payload());

    expect(body).toMatchObject({ ok: true, entity_type: entity.entityType, athlete_id: ATHLETE });
    expect(status).toBe(200);
    expect(typeof body.entity_id === 'string' && body.entity_id.length > 0).toBe(true);

    const after = await countRows(WRITTEN_TABLES);
    for (const table of WRITTEN_TABLES) {
      const expected = entity.recordTables.includes(table) || (ACCOUNTING_TABLES as readonly string[]).includes(table) ? 1 : 0;
      expect({ table, added: after[table] - before[table] }).toEqual({ table, added: expected });
    }
  });
});

/* ── The defect: a failure after the record leaves the record behind ────────
   Every entity type, against a failure at each of the three later statements.
   On the code before this change the record's count went up by one in every
   one of these and the route still answered 500. */
describe('a failure on a later statement', () => {
  const matrix = ENTITY_CASES.flatMap((entity) => ACCOUNTING_TABLES.map((failing) => ({ entity, failing })));

  test.each(matrix)('$entity.entityType: pilot.$failing fails -> 500 and nothing at all is committed', async ({ entity, failing }) => {
    const before = await countRows(WRITTEN_TABLES);
    const checksBefore = await authorityChecks();
    await failInsertsOn(failing);

    const { status, body } = await post(entity.entityType, entity.payload());

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Internal server error' });
    expectInjectedFailureWasTheCause();
    expect(await countRows(WRITTEN_TABLES)).toEqual(before);
    // The authority check is written before the transaction and is not part
    // of it: the attempt stays on record even though the write did not happen.
    expect(await authorityChecks()).toBe(checksBefore + 1);
  });

  test('guardian_link: the link fails after the guardian was written -> the guardian row is not kept either', async () => {
    const before = await countRows(WRITTEN_TABLES);
    await failInsertsOn('guardian_links');

    const { status } = await post('guardian_link', { parent_id: 'par-atomic-half', full_name: 'Half Written' });

    expect(status).toBe(500);
    expectInjectedFailureWasTheCause();
    expect(await countRows(WRITTEN_TABLES)).toEqual(before);
    const parent = await db.query('select 1 from pilot.parents where organization_id = $1 and parent_id = $2', [ORG, 'par-atomic-half']);
    expect(parent.rowCount).toBe(0);
  });

  /* The same link, this time naming a real parent login -- the path where the
     REAL assertActiveParentAccount runs (ahead of the transaction) and the
     parents row carries a foreign key to that account. */
  test('guardian_link naming a parent account: a later failure keeps nothing, and the retry links that account once', async () => {
    const before = await countRows(WRITTEN_TABLES);
    const link = { parent_id: 'par-atomic-account', account_id: GUARDIAN, full_name: 'Account Guardian' };

    await failInsertsOn('shadow_events');
    const failed = await post('guardian_link', link);
    expect(failed.status).toBe(500);
    expectInjectedFailureWasTheCause();
    expect(await countRows(WRITTEN_TABLES)).toEqual(before);

    await stopFailing('shadow_events');
    const retried = await post('guardian_link', link);
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ ok: true, entity_type: 'guardian_link', entity_id: `par-atomic-account:${ATHLETE}` });
    const linked = await db.query<{ account_id: string }>(
      `select p.account_id from pilot.parents p
         join pilot.guardian_links l on l.organization_id = p.organization_id and l.parent_id = p.parent_id
        where p.organization_id = $1 and p.parent_id = 'par-atomic-account' and l.athlete_id = $2`,
      [ORG, ATHLETE],
    );
    expect(linked.rows).toEqual([{ account_id: GUARDIAN }]);
  });
});

/* ── What the family's feed would return ────────────────────────────────────
   The reported harm, read through listParentMessages -- the query behind the
   parent feed. It is that query, not the feed: no guardian session and no
   /parent/messages route run here. A duplicate row in what this returns is a
   duplicate card on the family's screen. */
describe('Message Home, sent by the assigned coach', () => {
  const TEXT = 'Practice moves to 5pm on Friday.';

  async function feed(): Promise<string[]> {
    return (await listParentMessages(ORG, [ATHLETE])).filter((row) => row.note_text === TEXT).map((row) => row.note_id);
  }

  test.each(ACCOUNTING_TABLES)('fails on pilot.%s, is sent again, and the family reads it exactly once', async (failing) => {
    mockRequirePrincipal.mockResolvedValue(principal(COACH, 'coach'));
    await db.query(`delete from pilot.coach_observations where organization_id = $1 and note_text = $2`, [ORG, TEXT]);
    const message = { note_type: 'parent_message', note_text: TEXT };

    await failInsertsOn(failing);
    const failed = await post('coach_note', message);
    expect(failed.status).toBe(500);
    expectInjectedFailureWasTheCause();
    // The coach was told it failed, and it did: the family has nothing.
    expect(await feed()).toEqual([]);

    await stopFailing(failing);
    const resent = await post('coach_note', message);
    expect(resent.status).toBe(200);
    expect(resent.body).toMatchObject({ ok: true, entity_type: 'coach_note', athlete_id: ATHLETE });

    // One message, and it is the one the route named in its answer.
    expect(await feed()).toEqual([resent.body.entity_id]);
    const audit = await db.query(
      `select 1 from pilot.audit_events where organization_id = $1 and entity_type = 'intake_coach_note' and entity_id = $2`,
      [ORG, resent.body.entity_id],
    );
    expect(audit.rowCount).toBe(1);
  });
});

/* ── What stays outside the transaction ─────────────────────────────────── */
describe('a refused request', () => {
  test('a coach not assigned to the athlete is refused 403, writes nothing, and the authority check is still recorded', async () => {
    mockRequirePrincipal.mockResolvedValue(principal(COACH, 'coach'));
    const before = await countRows(WRITTEN_TABLES);
    const checksBefore = await authorityChecks();

    const { status } = await post('coach_note', { note_type: 'parent_message', note_text: 'Should never be stored.' }, UNASSIGNED_ATHLETE);

    expect(status).toBe(403);
    expect(await countRows(WRITTEN_TABLES)).toEqual(before);
    expect(await authorityChecks()).toBe(checksBefore + 1);
  });
});

/* ── The writers themselves ─────────────────────────────────────────────────
   The route cases above cannot see one thing: an accounting writer that is
   HANDED the client and quietly ignores it. If the last insert in the
   sequence ran on the pool, a trigger on its table would still fail the
   request and roll the rest back, and every case above would stay green.
   So each writer is driven directly: given a client, its row must vanish with
   that transaction; given none, its row must be committed on its own, which
   is what every other caller in the codebase still relies on. */
describe('each accounting writer', () => {
  class Abandon extends Error {}

  const auditEvent = (mirror: boolean) => ({
    event_type: 'create' as const,
    actor_account_id: ADMIN,
    actor_role: 'organization_admin' as const,
    organization_id: ORG,
    entity_type: 'intake_coach_note',
    entity_id: 'writer-proof',
    details: {},
    ...(mirror ? {} : { shadow_mirror: false }),
  });
  const shadowEvent = {
    organizationId: ORG,
    eventName: 'SHADOW_INTAKE_DOMAIN_UPSERTED',
    entityType: 'intake_coach_note',
    entityId: 'writer-proof',
    actorAccountId: ADMIN,
    actorRole: 'organization_admin',
  };
  const metric = { organizationId: ORG, metricName: 'shadow.intake.domain_upsert', actorAccountId: ADMIN, actorRole: 'organization_admin' };

  type Client = import('pg').PoolClient;
  const WRITERS: Array<{ name: string; adds: Counts; run: (client?: Client) => Promise<void> }> = [
    {
      name: 'writePilotAuditEvent (no mirror)',
      adds: { audit_events: 1, shadow_events: 0, shadow_telemetry_events: 0 },
      run: async (client) => (await import('./audit')).writePilotAuditEvent(auditEvent(false), ...(client ? [client] as const : [])),
    },
    {
      // The mirrored path writes all three tables; all three must follow the client.
      name: 'writePilotAuditEvent (mirrored)',
      adds: { audit_events: 1, shadow_events: 1, shadow_telemetry_events: 1 },
      run: async (client) => (await import('./audit')).writePilotAuditEvent(auditEvent(true), ...(client ? [client] as const : [])),
    },
    {
      name: 'emitShadowEvent',
      adds: { audit_events: 0, shadow_events: 1, shadow_telemetry_events: 0 },
      run: async (client) => (await import('./shadowEvents')).emitShadowEvent(shadowEvent, ...(client ? [client] as const : [])),
    },
    {
      name: 'writeShadowTelemetryEvent',
      adds: { audit_events: 0, shadow_events: 0, shadow_telemetry_events: 1 },
      run: async (client) => (await import('./shadowTelemetry')).writeShadowTelemetryEvent(metric, ...(client ? [client] as const : [])),
    },
  ];

  test.each(WRITERS)('$name: on a client, its rows go when that transaction is abandoned', async ({ run }) => {
    const { withTransaction } = await import('./db');
    const before = await countRows(ACCOUNTING_TABLES);

    await expect(withTransaction(async (client) => {
      await run(client);
      throw new Abandon();
    })).rejects.toBeInstanceOf(Abandon);

    expect(await countRows(ACCOUNTING_TABLES)).toEqual(before);
  });

  test.each(WRITERS)('$name: with no client, its rows are committed on their own, as before', async ({ run, adds }) => {
    const before = await countRows(ACCOUNTING_TABLES);

    await run();

    const after = await countRows(ACCOUNTING_TABLES);
    for (const table of ACCOUNTING_TABLES) {
      expect({ table, added: after[table] - before[table] }).toEqual({ table, added: adds[table] });
    }
  });
});
