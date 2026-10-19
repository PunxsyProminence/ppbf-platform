// Real PostgreSQL-backed test for testDay.ts (lane L60, OD-2026-10-17-026: the quarterly test day
// -- height, the jumps ruled in OD-2026-10-04-020, and the 20-m shuttle). './db' is mocked to route
// into the embedded server, so the module's SQL, the height guard trigger and access.ts all run
// against real rows.
//
// What needs a real database to prove:
//   * every filled cell lands where one-at-a-time entry puts it (heights in pilot.athlete_heights,
//     jumps and the shuttle in pilot.assessments, read back by the athlete's own history), and a
//     blank cell writes nothing;
//   * all or nothing: one athlete the seat does not reach, or a database refusal part-way, leaves
//     nothing written;
//   * once: the same save again writes nothing and says so; the same key with other numbers is a
//     conflict and changes nothing;
//   * every saved height has its own audit row, and the save one row naming its cells, in the same
//     transaction; a retry that leaves a cell off is told that cell stays saved.
//
// Disposable, local-only embedded Postgres. It NEVER connects to production or staging.

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

function client(): Client {
  if (!activeClient) throw new Error('test bug: no active embedded client');
  return activeClient;
}

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => (await client().query(text, params)).rows),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => (await client().query(text, params)).rows[0] ?? null),
  withTransaction: jest.fn(async (fn: (c: Client) => Promise<unknown>) => {
    await client().query('BEGIN');
    try {
      const result = await fn(client());
      await client().query('COMMIT');
      return result;
    } catch (error) {
      await client().query('ROLLBACK');
      throw error;
    }
  }),
}));

import type { ActorIdentity } from './access';
import { listAthleteAssessmentHistory } from './assessmentResults';
import { readAthleteHeights } from './athleteHeights';
import { withTransaction } from './db';
import { ConflictError, ForbiddenError } from './errors';
import { parseTestDay, recordTestDay } from './testDay';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-test-day-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const TEMPLATE_DB = 'testday_template';
const TODAY = '2026-10-17';

const ORG = 'org-testday';
const OTHER_ORG = 'org-testday-other';
const A1 = 'ATH-TESTDAY-1';
const A2 = 'ATH-TESTDAY-2';
const FOREIGN = 'ATH-TESTDAY-FOREIGN';

const COACH: ActorIdentity = { accountId: 'acct-testday-coach', role: 'coach', organizationId: ORG, athleteId: null };
const GUARDIAN: ActorIdentity = { accountId: 'acct-testday-guardian', role: 'parent', organizationId: ORG, athleteId: null };
const ATHLETE_SELF: ActorIdentity = { accountId: 'acct-testday-athlete', role: 'athlete', organizationId: ORG, athleteId: A1 };

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;

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
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function adminQuery(sql: string): Promise<void> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

async function seed(c: Client): Promise<void> {
  for (const org of [ORG, OTHER_ORG]) {
    await c.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [org]);
  }
  await c.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ('acct-testday-coach', 'coach', $1, 'microsoft'), ('acct-testday-guardian', 'parent', $1, 'microsoft'),
            ('acct-testday-athlete', 'athlete', $1, 'microsoft')`,
    [ORG],
  );
  await c.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ('acct-testday-coach', $1, 'coach', true), ('acct-testday-guardian', $1, 'parent', true),
            ('acct-testday-athlete', $1, 'athlete', true)`,
    [ORG],
  );
  for (const [org, athlete] of [[ORG, A1], [ORG, A2], [OTHER_ORG, FOREIGN]] as const) {
    await c.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Test Day Athlete', '2012-03-04', 'fly', 'active', 'contact', true, 'acct-testday-coach', now(), now())`,
      [org, athlete],
    );
  }
  // The guardian is A1's own linked guardian; the athlete login is A1's own.
  await c.query(`update pilot.accounts set athlete_id = $1 where account_id = 'acct-testday-athlete'`, [A1]);
  await c.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
     values ($1, 'parent-testday-1', 'acct-testday-guardian', 'Linked Guardian')`,
    [ORG],
  );
  await c.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, 'parent-testday-1', $2, 'parent')`,
    [ORG, A1],
  );
}

async function freshDatabase(name: string): Promise<Client> {
  await adminQuery(`drop database if exists ${name} with (force)`);
  await adminQuery(`create database ${name} template ${TEMPLATE_DB}`);
  const c = new Client({ connectionString: connectionStringFor(name) });
  await c.connect();
  activeClient = c;
  return c;
}

const FORM = {
  administered_on: '2026-10-16',
  request_key: 'test-day-save-1',
  rows: [
    { athlete_id: A1, height_cm: 151.4, cmj_cm: 31.5, broad_cm: 172, shuttle_level: 7, shuttle_number: 4 },
    // A2 ran the shuttle and the broad jump only; the other cells are blank.
    { athlete_id: A2, height_cm: '', cmj_cm: null, broad_cm: 160.2, shuttle_level: 5, shuttle_number: 9 },
  ],
};

async function counts(c: Client): Promise<{ heights: number; assessments: number }> {
  const result = await c.query(
    `select (select count(*)::int from pilot.athlete_heights) as heights,
            (select count(*)::int from pilot.assessments) as assessments`,
  );
  return result.rows[0];
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

  const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<Record<string, unknown>>;
  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  const applyFullSchema = fullSchema.applyFullSchema as (c: Client, opts?: { infraDir?: string }) => Promise<unknown>;
  await adminQuery(`drop database if exists ${TEMPLATE_DB} with (force)`);
  await adminQuery(`create database ${TEMPLATE_DB}`);
  const template = new Client({ connectionString: connectionStringFor(TEMPLATE_DB) });
  await template.connect();
  try {
    await applyFullSchema(template, { infraDir: INFRA_DIR });
    await seed(template);
  } finally {
    await template.end();
  }
});

afterEach(async () => {
  await activeClient?.end().catch(() => {});
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

describe('test day', () => {
  test('every filled cell lands where one-at-a-time entry puts it; blank cells write nothing', async () => {
    const c = await freshDatabase('testday_lands');
    const result = await recordTestDay(COACH, parseTestDay(FORM, TODAY));
    // A1: height, CMJ, broad jump, shuttle; A2: broad jump, shuttle.
    expect(result).toEqual({ written: 6, already_saved: 0, earlier_not_on_form: [] });
    expect(await counts(c)).toEqual({ heights: 1, assessments: 5 });
    // One audit row for the height, one for the save: no measurement in either.
    const audit = await c.query(`select entity_type, details from pilot.audit_events where entity_type in ('athlete_height', 'test_day') order by entity_type`);
    expect(audit.rows.map((row) => row.entity_type)).toEqual(['athlete_height', 'test_day']);
    expect(JSON.stringify(audit.rows)).not.toMatch(/151\.4|31\.5|172|160\.2/);
    expect(audit.rows[1].details.cells).toHaveLength(6);

    const h1 = await readAthleteHeights(COACH, A1);
    expect(h1.latest).toMatchObject({ height_cm: 151.4, measured_on: '2026-10-16', recorded_by_role: 'coach' });
    expect((await readAthleteHeights(COACH, A2)).readings).toEqual([]);

    const history = (await listAthleteAssessmentHistory(ORG, A1)).entries;
    expect(history.map((e) => [e.protocol_id, e.kind, e.value, e.shuttle]).sort()).toEqual([
      ['ppbf-jump-broad-distance', 'jump', 172, null],
      ['ppbf-jump-cmj-height', 'jump', 31.5, null],
      ['ppbf-shuttle-20m', 'shuttle', 7, 4],
    ]);
    expect(history.every((e) => e.administered_on === '2026-10-16')).toBe(true);
    const a2 = (await listAthleteAssessmentHistory(ORG, A2)).entries;
    expect(a2.map((e) => e.protocol_id).sort()).toEqual(['ppbf-jump-broad-distance', 'ppbf-shuttle-20m']);

    const kinds = await c.query(`select distinct administration_kind, assessor_role from pilot.assessments`);
    expect(kinds.rows).toEqual([{ administration_kind: 'scheduled_interval', assessor_role: 'coach' }]);
  });

  test('the same save again writes nothing new and says so', async () => {
    const c = await freshDatabase('testday_once');
    await recordTestDay(COACH, parseTestDay(FORM, TODAY));
    const again = await recordTestDay(COACH, parseTestDay(FORM, TODAY));
    expect(again).toEqual({ written: 0, already_saved: 6, earlier_not_on_form: [] });
    expect(await counts(c)).toEqual({ heights: 1, assessments: 5 });
    const audit = await c.query(`select count(*)::int as n from pilot.audit_events where entity_type in ('athlete_height', 'test_day')`);
    expect(audit.rows[0].n).toBe(2);
  });

  test('the same key with other numbers is a conflict and changes nothing', async () => {
    const c = await freshDatabase('testday_conflict');
    await recordTestDay(COACH, parseTestDay(FORM, TODAY));
    for (const change of [
      { height_cm: 152 },
      { cmj_cm: 30 },
      { shuttle_number: 5 },
    ]) {
      const form = { ...FORM, rows: [{ ...FORM.rows[0], ...change }, FORM.rows[1]] };
      await expect(recordTestDay(COACH, parseTestDay(form, TODAY))).rejects.toBeInstanceOf(ConflictError);
    }
    await expect(recordTestDay(COACH, parseTestDay({ ...FORM, administered_on: '2026-10-15' }, TODAY)))
      .rejects.toBeInstanceOf(ConflictError);
    expect(await counts(c)).toEqual({ heights: 1, assessments: 5 });
    expect((await readAthleteHeights(COACH, A1)).latest?.height_cm).toBe(151.4);
  });

  test('a cell added on a retry is written; what was already saved is not repeated', async () => {
    const c = await freshDatabase('testday_added');
    const first = { ...FORM, rows: [FORM.rows[0]] };
    await recordTestDay(COACH, parseTestDay(first, TODAY));
    const second = await recordTestDay(COACH, parseTestDay(FORM, TODAY));
    expect(second).toEqual({ written: 2, already_saved: 4, earlier_not_on_form: [] });
    expect(await counts(c)).toEqual({ heights: 1, assessments: 5 });
  });

  test('one athlete the seat does not reach refuses the whole save before anything is written', async () => {
    const c = await freshDatabase('testday_foreign');
    for (const foreignRow of [{ athlete_id: FOREIGN, broad_cm: 150 }, { athlete_id: FOREIGN, height_cm: 150 }]) {
      (withTransaction as jest.Mock).mockClear();
      const form = { ...FORM, rows: [...FORM.rows, foreignRow] };
      await expect(recordTestDay(COACH, parseTestDay(form, TODAY))).rejects.toBeInstanceOf(ForbiddenError);
      // Refused by the check before the transaction, not by an insert's filter inside it.
      expect(withTransaction).not.toHaveBeenCalled();
    }
    expect(await counts(c)).toEqual({ heights: 0, assessments: 0 });
  });

  test('a guardian records nothing, even for their own child; an athlete nothing, even for themself', async () => {
    const c = await freshDatabase('testday_guardian');
    const ownChild = { ...FORM, rows: [FORM.rows[0]] };
    for (const who of [GUARDIAN, ATHLETE_SELF]) {
      await expect(recordTestDay(who, parseTestDay(ownChild, TODAY))).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await counts(c)).toEqual({ heights: 0, assessments: 0 });
  });

  test('a database refusal part-way rolls the whole save back', async () => {
    const c = await freshDatabase('testday_rollback');
    // The coach's seat ends after the access check passed: the height guard refuses the
    // second athlete's height inside the transaction, and the first athlete's cells go too.
    const form = { ...FORM, rows: [FORM.rows[0], { ...FORM.rows[1], height_cm: 140.1 }] };
    const parsed = parseTestDay(form, TODAY);
    await c.query(`create function public.end_seat() returns trigger language plpgsql as $$
      begin
        update pilot.organization_memberships set active_flag = false where account_id = 'acct-testday-coach';
        return new;
      end $$`);
    await c.query(`create trigger end_seat_after_first after insert on pilot.assessments
      for each row when (new.athlete_id = '${A1}' and new.protocol_id = 'ppbf-shuttle-20m') execute function public.end_seat()`);
    await expect(recordTestDay(COACH, parsed)).rejects.toMatchObject({ code: 'TEST_DAY_NOT_PERMITTED' });
    expect(await counts(c)).toEqual({ heights: 0, assessments: 0 });
    const audit = await c.query(`select count(*)::int as n from pilot.audit_events where entity_type in ('athlete_height', 'test_day')`);
    expect(audit.rows[0].n).toBe(0);
  });

  test('a soft-deleted athlete on the form refuses the save', async () => {
    const c = await freshDatabase('testday_deleted');
    await c.query('update pilot.athletes set deleted_at = now() where athlete_id = $1', [A2]);
    await expect(recordTestDay(COACH, parseTestDay(FORM, TODAY))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await counts(c)).toEqual({ heights: 0, assessments: 0 });
  });
});

describe('test day: retries that differ from the first attempt', () => {
  test('a retry that leaves a cell off is told it stays saved', async () => {
    const c = await freshDatabase('testday_dropped');
    await recordTestDay(COACH, parseTestDay(FORM, TODAY));
    const dropped = { ...FORM, rows: [{ ...FORM.rows[0], cmj_cm: '' }, FORM.rows[1]] };
    const result = await recordTestDay(COACH, parseTestDay(dropped, TODAY));
    expect(result).toEqual({
      written: 0,
      already_saved: 5,
      earlier_not_on_form: [{ athlete_id: A1, measure: 'ppbf-jump-cmj-height' }],
    });
    expect(await counts(c)).toEqual({ heights: 1, assessments: 5 });
  });

  test('a changed date on a row with no height is a conflict too', async () => {
    const c = await freshDatabase('testday_date_nohgt');
    const onlyA2 = { ...FORM, rows: [FORM.rows[1]] };
    await recordTestDay(COACH, parseTestDay(onlyA2, TODAY));
    await expect(recordTestDay(COACH, parseTestDay({ ...onlyA2, administered_on: '2026-10-15' }, TODAY)))
      .rejects.toBeInstanceOf(ConflictError);
    expect(await counts(c)).toEqual({ heights: 0, assessments: 2 });
  });

  test('a blank shuttle beside filled cells is "not tested", and a long save key still fits', async () => {
    const c = await freshDatabase('testday_blank_long');
    const form = {
      administered_on: '2026-10-16',
      request_key: 'k'.repeat(200),
      rows: [{ athlete_id: A1, height_cm: 151.4, cmj_cm: 31.5, broad_cm: '', shuttle_level: '', shuttle_number: '' }],
    };
    expect(await recordTestDay(COACH, parseTestDay(form, TODAY))).toMatchObject({ written: 2 });
    expect(await counts(c)).toEqual({ heights: 1, assessments: 1 });
  });
});
