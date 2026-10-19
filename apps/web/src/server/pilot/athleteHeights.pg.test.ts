// Real PostgreSQL-backed test for athleteHeights.ts on top of the athlete-metrics migration
// (lane L60, OD-2026-10-17-026 (b)). './db' is mocked to route into the embedded server (the
// athleteContactCaps.pg.test.ts pattern), so the module's real SQL -- and access.ts's -- runs
// against real rows.
//
// What needs a real database to prove:
//   * coach-only, both ways: any coach of the gym (OD-2026-10-12-016), the office and the legacy
//     admin seat read and record; the athlete, a guardian, the board, a volunteer, the platform
//     owner, a coach of another gym and a lapsed seat are refused, and a soft-deleted athlete is
//     reached by nobody;
//   * one save key is one reading, and the retry says it wrote nothing (no second audit row);
//   * a correction is a new row, the original stays and stops counting, and a second correction
//     of the same reading is refused;
//   * the growth rate is read from the readings in force only.
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
  withTransaction: jest.fn(async (fn: (client: Client) => Promise<unknown>) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const client = activeClient;
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }),
}));

import type { ActorIdentity } from './access';
import { heightAccessibleAthleteIds, readAthleteHeights, recordAndSummarize } from './athleteHeights';
import type { PilotRole } from './contracts';
import { ConflictError, ForbiddenError } from './errors';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-athlete-heights-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const TEMPLATE_DB = 'heights_template';

const ORG = 'org-heights';
const OTHER_ORG = 'org-heights-other';
const ATHLETE = 'ATH-HEIGHTS-1';
const SECOND_ATHLETE = 'ATH-HEIGHTS-2';
const DELETED_ATHLETE = 'ATH-HEIGHTS-GONE';

const PEOPLE: Array<{ id: string; role: PilotRole; org: string; seat: PilotRole | null; active?: boolean }> = [
  { id: 'acct-heights-coach', role: 'coach', org: ORG, seat: 'coach' },
  // Not the athlete's coach of record: any coach of the gym coaches every athlete (OD-2026-10-12-016).
  { id: 'acct-heights-other-coach', role: 'coach', org: ORG, seat: 'coach' },
  { id: 'acct-heights-office', role: 'organization_admin', org: ORG, seat: 'organization_admin' },
  { id: 'acct-heights-legacy-admin', role: 'admin', org: ORG, seat: 'admin' },
  { id: 'acct-heights-athlete', role: 'athlete', org: ORG, seat: 'athlete' },
  { id: 'acct-heights-guardian', role: 'parent', org: ORG, seat: 'parent' },
  { id: 'acct-heights-board', role: 'board', org: ORG, seat: 'board' },
  { id: 'acct-heights-volunteer', role: 'volunteer', org: ORG, seat: 'volunteer' },
  { id: 'acct-heights-platform', role: 'platform_owner', org: ORG, seat: 'platform_owner' },
  { id: 'acct-heights-visitor', role: 'coach', org: OTHER_ORG, seat: null },
  { id: 'acct-heights-lapsed', role: 'coach', org: ORG, seat: 'coach', active: false },
];

function actor(id: string): ActorIdentity {
  const person = PEOPLE.find((p) => p.id === id);
  if (!person) throw new Error(`test bug: no person ${id}`);
  return {
    accountId: person.id,
    role: person.role,
    organizationId: ORG,
    athleteId: person.role === 'athlete' ? ATHLETE : null,
  };
}

const COACH = actor('acct-heights-coach');

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

async function seed(client: Client): Promise<void> {
  for (const org of [ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [org],
    );
  }
  for (const person of PEOPLE) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id)
       values ($1, $2, $3, 'microsoft', $4)`,
      [person.id, person.role, person.org, person.role === 'athlete' ? ATHLETE : null],
    );
    if (person.seat) {
      await client.query(
        `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, $3, $4)`,
        [person.id, ORG, person.seat, person.active ?? true],
      );
    }
  }
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ('acct-heights-visitor', $1, 'coach', true)`,
    [OTHER_ORG],
  );
  for (const athlete of [ATHLETE, SECOND_ATHLETE, DELETED_ATHLETE]) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Height Athlete', '2012-03-04', 'fly', 'active', 'contact', true, 'acct-heights-coach', now(), now())`,
      [ORG, athlete],
    );
  }
  await client.query('update pilot.athletes set deleted_at = now() where athlete_id = $1', [DELETED_ATHLETE]);
  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
     values ($1, 'parent-heights-1', 'acct-heights-guardian', 'Linked Guardian')`,
    [ORG],
  );
  await client.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, 'parent-heights-1', $2, 'parent')`,
    [ORG, ATHLETE],
  );
}

async function freshDatabase(name: string): Promise<Client> {
  await adminQuery(`drop database if exists ${name} with (force)`);
  await adminQuery(`create database ${name} template ${TEMPLATE_DB}`);
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  activeClient = client;
  return client;
}

function save(who: ActorIdentity, overrides: Partial<{
  athleteId: string; heightCm: number; measuredOn: string; requestKey: string; supersedesHeightId: string | null;
}> = {}) {
  return recordAndSummarize(who, {
    athleteId: overrides.athleteId ?? ATHLETE,
    heightCm: overrides.heightCm ?? 151.4,
    measuredOn: overrides.measuredOn ?? '2026-10-16',
    requestKey: overrides.requestKey ?? `key-${Math.random().toString(36).slice(2)}`,
    supersedesHeightId: overrides.supersedesHeightId ?? null,
  });
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
  const applyFullSchema = fullSchema.applyFullSchema as (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;

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

describe('athlete heights: coach-only', () => {
  test('any coach of the gym, the office and the legacy admin seat record and read', async () => {
    await freshDatabase('heights_staff');
    await save(COACH, { heightCm: 140.2, measuredOn: '2026-07-01' });
    await save(actor('acct-heights-other-coach'), { heightCm: 141.0, measuredOn: '2026-08-01' });
    await save(actor('acct-heights-office'), { heightCm: 142.6, measuredOn: '2026-09-01' });
    await save(actor('acct-heights-legacy-admin'), { heightCm: 143.1, measuredOn: '2026-10-01' });
    for (const id of ['acct-heights-coach', 'acct-heights-other-coach', 'acct-heights-office', 'acct-heights-legacy-admin']) {
      const summary = await readAthleteHeights(actor(id), ATHLETE);
      expect(summary.readings.map((r) => r.height_cm)).toEqual([143.1, 142.6, 141.0, 140.2]);
    }
  });

  test.each([
    'acct-heights-athlete',
    'acct-heights-guardian',
    'acct-heights-board',
    'acct-heights-volunteer',
    'acct-heights-platform',
    'acct-heights-lapsed',
  ])('%s can neither read nor record, and nothing is written', async (id) => {
    const client = await freshDatabase(`heights_refused_${id.replace(/[^a-z]/g, '_')}`);
    await save(COACH);
    await expect(readAthleteHeights(actor(id), ATHLETE)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(save(actor(id))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await heightAccessibleAthleteIds(actor(id), [ATHLETE, SECOND_ATHLETE])).toEqual(new Set());
    const n = await client.query('select count(*)::int as n from pilot.athlete_heights');
    expect(n.rows[0].n).toBe(1);
  });

  test('a coach of another gym, acting in that gym, reaches none of this gym\'s athletes', async () => {
    await freshDatabase('heights_visitor');
    const visitor: ActorIdentity = {
      accountId: 'acct-heights-visitor',
      role: 'coach',
      organizationId: OTHER_ORG,
      athleteId: null,
    };
    await expect(readAthleteHeights(visitor, ATHLETE)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(save(visitor)).rejects.toBeInstanceOf(ForbiddenError);
  });

  test('a soft-deleted athlete is reached by nobody', async () => {
    await freshDatabase('heights_deleted');
    await expect(save(COACH, { athleteId: DELETED_ATHLETE })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(readAthleteHeights(actor('acct-heights-office'), DELETED_ATHLETE)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await heightAccessibleAthleteIds(COACH, [ATHLETE, DELETED_ATHLETE])).toEqual(new Set([ATHLETE]));
  });
});

describe('athlete heights: one save, corrections, growth', () => {
  test('a retry with the same key returns the first reading and says it wrote nothing', async () => {
    const client = await freshDatabase('heights_retry');
    const first = await save(COACH, { requestKey: 'k-1' });
    expect(first.created).toBe(true);
    const again = await save(COACH, { requestKey: 'k-1' });
    expect(again.created).toBe(false);
    expect(again.reading.height_id).toBe(first.reading.height_id);
    await expect(save(COACH, { requestKey: 'k-1', heightCm: 152.0 })).rejects.toBeInstanceOf(ConflictError);
    await expect(save(COACH, { requestKey: 'k-1', athleteId: SECOND_ATHLETE })).rejects.toBeInstanceOf(ConflictError);
    const n = await client.query('select count(*)::int as n from pilot.athlete_heights');
    expect(n.rows[0].n).toBe(1);
    // One reading, one audit row, written with it; the retry added none.
    const audit = await client.query(
      `select event_type, entity_id, details->>'athlete_id' as athlete_id from pilot.audit_events where entity_type = 'athlete_height'`,
    );
    expect(audit.rows).toEqual([{ event_type: 'create', entity_id: first.reading.height_id, athlete_id: ATHLETE }]);
  });

  test("the same save replayed by another coach of the gym returns the first coach's reading", async () => {
    await freshDatabase('heights_replay_other');
    const first = await save(COACH, { requestKey: 'k-shared' });
    const replay = await save(actor('acct-heights-other-coach'), { requestKey: 'k-shared' });
    expect(replay).toMatchObject({ created: false, reading: { height_id: first.reading.height_id, recorded_by_role: 'coach' } });
  });

  test('a seat that ends between the access check and the insert is a refusal, not a server error', async () => {
    const client = await freshDatabase('heights_seat_race');
    await client.query(`create function public.end_heights_seat() returns trigger language plpgsql as $$
      begin
        update pilot.organization_memberships set active_flag = false where account_id = 'acct-heights-coach';
        return new;
      end $$`);
    // Fires before the guard (triggers run in name order).
    await client.query(`create trigger a_end_seat before insert on pilot.athlete_heights
      for each row execute function public.end_heights_seat()`);
    await expect(save(COACH)).rejects.toMatchObject({ code: 'HEIGHT_NOT_PERMITTED' });
    const n = await client.query('select count(*)::int as n from pilot.athlete_heights');
    expect(n.rows[0].n).toBe(0);
  });

  test('a correction keeps the original, stops it counting, and cannot be made twice', async () => {
    await freshDatabase('heights_correct');
    const before = await save(COACH, { heightCm: 140.0, measuredOn: '2026-07-01' });
    const typo = await save(COACH, { heightCm: 115.4, measuredOn: '2026-10-01' });
    expect(typo.summary.growth?.to_cm).toBe(115.4);

    const fixed = await save(COACH, { heightCm: 151.4, measuredOn: '2026-10-01', supersedesHeightId: typo.reading.height_id });
    expect(fixed.summary.readings.find((r) => r.height_id === typo.reading.height_id)?.superseded).toBe(true);
    expect(fixed.summary.latest?.height_id).toBe(fixed.reading.height_id);
    expect(fixed.summary.growth).toMatchObject({
      from_measured_on: '2026-07-01',
      from_cm: 140,
      to_measured_on: '2026-10-01',
      to_cm: 151.4,
      days: 92,
      change_cm: 11.4,
    });
    expect(fixed.summary.readings).toHaveLength(3);

    await expect(
      save(COACH, { heightCm: 150.0, measuredOn: '2026-10-01', supersedesHeightId: typo.reading.height_id }),
    ).rejects.toBeInstanceOf(ConflictError);
    // Another athlete's reading cannot be the one replaced.
    await expect(
      save(COACH, { athleteId: SECOND_ATHLETE, supersedesHeightId: before.reading.height_id }),
    ).rejects.toMatchObject({ code: 'HEIGHT_CORRECTION_TARGET_INVALID' });
  });

  test('readings under 60 days apart give no rate; the newest pair 60 or more days apart does', async () => {
    await freshDatabase('heights_growth');
    await save(COACH, { heightCm: 140.0, measuredOn: '2026-06-01' });
    const close = await save(COACH, { heightCm: 141.0, measuredOn: '2026-07-15' });
    expect(close.summary.growth).toBeNull();
    const later = await save(COACH, { heightCm: 143.0, measuredOn: '2026-09-15' });
    // 2026-07-15 -> 2026-09-15 is 62 days; that is the newest earlier reading 60+ days back.
    expect(later.summary.growth).toMatchObject({ from_measured_on: '2026-07-15', days: 62, change_cm: 2 });
    expect(later.summary.growth?.cm_per_year).toBeCloseTo((2 / 62) * 365.25, 1);
  });

  test('59 days apart is no rate; 60 days apart is one', async () => {
    await freshDatabase('heights_boundary');
    await save(COACH, { heightCm: 140.0, measuredOn: '2026-08-01' });
    const fiftyNine = await save(COACH, { heightCm: 141.0, measuredOn: '2026-09-29' });
    expect(fiftyNine.summary.growth).toBeNull();
    const sixty = await save(COACH, { heightCm: 141.2, measuredOn: '2026-09-30' });
    expect(sixty.summary.growth).toMatchObject({ from_measured_on: '2026-08-01', days: 60 });
  });

  test('a long history never hides the pair the rate needs', async () => {
    await freshDatabase('heights_long');
    await save(COACH, { heightCm: 140.0, measuredOn: '2026-01-01' });
    // Thirty readings in the last month: more than the list shows.
    for (let day = 1; day <= 30; day += 1) {
      await save(COACH, { heightCm: 150.0, measuredOn: `2026-09-${String(day).padStart(2, '0')}` });
    }
    const summary = await readAthleteHeights(COACH, ATHLETE);
    expect(summary.readings).toHaveLength(24);
    expect(summary.growth).toMatchObject({ from_measured_on: '2026-01-01', to_measured_on: '2026-09-30' });
  });
});
