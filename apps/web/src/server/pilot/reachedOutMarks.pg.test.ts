// Real PostgreSQL-backed test for reachedOutMarks.ts (lane W4-6, SC-3a-2;
// OW27-33 B; Overwatch W4-6 Q4 A, and on #2176 the replace). './db' is mocked
// to route into the embedded server (the restMarks.pg.test.ts pattern), so the
// module's real SQL -- and audit.ts's and achievements.ts's -- runs against
// pilot.athlete_reached_out_marks as the full schema builds it, guard trigger
// and partial unique index included.
//
// What needs a real database to prove:
//   * a mark, a replace and a take-back write the rows and audit rows the
//     rulings name, and a repeat writes nothing;
//   * the list read shows a current mark only while it is newer than the
//     athlete's last day they came, by display name, with no account id;
//   * two coaches at once: the second reads the first's result (the lock and
//     the index), never two current marks, never a mark ended twice;
//   * a losing end (rowCount 0) is never taken as done.
//
// Disposable, local-only embedded Postgres. It NEVER connects to production
// or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';
import type { PoolClient } from 'pg';

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
import type { PilotRole } from './contracts';
import { ConflictError } from './errors';
import { readCurrentReachedOut, type ReachedOutMarkRole, setReachedOutMark } from './reachedOutMarks';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-reached-out-module-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const DATABASE_NAME = 'ppbf_test_reached_out_module';
const T = 'pilot.athlete_reached_out_marks';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let gymCount = 0;
/** The gym's day now, by the database's clock: a new mark's day. */
let TODAY: string;

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

/** `offset` days from TODAY, as a gym-local ISO day. */
function day(offset: number): string {
  return new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
}

interface Gym {
  organizationId: string;
  coach: ActorIdentity;
  coach2: ActorIdentity;
  admin: ActorIdentity;
}

/** A gym with two named coaches and a named organization admin, and athletes ada, ben, cy and dee. */
async function newGym(label: string): Promise<Gym> {
  gymCount += 1;
  const organizationId = `org-reached-${label}-${gymCount}`;
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [organizationId],
  );
  const staff: Array<[string, PilotRole, string]> = [
    [`acct-coach-${gymCount}`, 'coach', 'Jordan'],
    [`acct-coach2-${gymCount}`, 'coach', 'Sam'],
    [`acct-admin-${gymCount}`, 'organization_admin', 'Pat'],
  ];
  for (const [accountId, role, name] of staff) await staffMember(organizationId, accountId, role, name);
  for (const athleteId of ['ada', 'ben', 'cy', 'dee']) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag,
          coach_id, created_at, updated_at)
       values ($1, $2, $2, '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())`,
      [organizationId, athleteId, staff[0][0]],
    );
  }
  const actor = (index: number): ActorIdentity => ({
    organizationId, accountId: staff[index][0], role: staff[index][1], athleteId: null,
  });
  return { organizationId, coach: actor(0), coach2: actor(1), admin: actor(2) };
}

/** An account with an active membership here and the display name the gym typed. */
async function staffMember(organizationId: string, accountId: string, role: PilotRole, name: string) {
  await client.query('insert into pilot.accounts (account_id, role, organization_id) values ($1, $2, $3)', [
    accountId, role, organizationId,
  ]);
  await client.query(
    'insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, $3, true)',
    [accountId, organizationId, role],
  );
  await client.query(
    'insert into pilot.account_profiles (organization_id, account_id, staff_display_name) values ($1, $2, $3)',
    [organizationId, accountId, name],
  );
}

/** One transaction on `on` (default: the shared client), committed, or rolled back on a throw. */
async function inTransaction<T>(fn: (tx: PoolClient) => Promise<T>, on: Client = client, as?: PoolClient): Promise<T> {
  await on.query('BEGIN');
  try {
    const result = await fn(as ?? (on as unknown as PoolClient));
    await on.query('COMMIT');
    return result;
  } catch (error) {
    await on.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

function set(actor: ActorIdentity, athleteId: string, lastCameDay: string | null, reachedOut: boolean, on: Client = client) {
  const role = actor.role as ReachedOutMarkRole;
  return inTransaction((tx) => setReachedOutMark(tx, { actor, role, athleteId, lastCameDay, reachedOut }), on);
}

/**
 * The database stamps marked_at with its own clock and the guard refuses to move it, so a mark
 * "made N days ago" is made now and moved back with this session's triggers off.
 */
async function backdate(gym: Gym, athleteId: string, onDay: string) {
  await client.query('set session_replication_role = replica');
  try {
    await client.query(
      `update ${T} set marked_at = ($3 || ' 12:00')::timestamp at time zone 'America/New_York'
        where organization_id = $1 and athlete_id = $2 and cleared_at is null`,
      [gym.organizationId, athleteId, onDay],
    );
  } finally {
    await client.query('set session_replication_role = origin');
  }
}

async function marks(gym: Gym, athleteId: string) {
  const { rows } = await client.query(
    `select mark_id::text as mark_id, marked_by_account_id, marked_by_role, cleared_by_account_id, cleared_kind,
            cleared_at is not null as ended, cleared_at >= marked_at as ended_after
       from ${T} where organization_id = $1 and athlete_id = $2 order by marked_at, cleared_at nulls last`,
    [gym.organizationId, athleteId],
  );
  return rows;
}

async function audits(gym: Gym) {
  const { rows } = await client.query(
    `select event_type, actor_account_id, actor_role, entity_id, details
       from pilot.audit_events where organization_id = $1 and entity_type = 'athlete_reached_out_mark' order by audit_id`,
    [gym.organizationId],
  );
  return rows;
}

/** Waits until the backend `pid` is waiting on a lock: the second writer has reached the first's row. */
async function waitUntilBlocked(pid: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await client.query('select wait_event_type from pg_stat_activity where pid = $1', [pid]);
    if (rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`backend ${pid} never waited on a lock`);
}

async function secondConnection(): Promise<{ other: Client; pid: number }> {
  const other = new Client({ connectionString: connectionStringFor(DATABASE_NAME) });
  await other.connect();
  const { rows } = await other.query('select pg_backend_pid() as pid');
  return { other, pid: rows[0].pid as number };
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

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${DATABASE_NAME}`);
  await admin.query(`create database ${DATABASE_NAME}`);
  await admin.end();

  client = new Client({ connectionString: connectionStringFor(DATABASE_NAME) });
  await client.connect();
  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  await (fullSchema.applyFullSchema as (c: Client, o: { infraDir: string }) => Promise<unknown>)(client, { infraDir: INFRA_DIR });
  activeClient = client;
  TODAY = (await client.query(`select (clock_timestamp() at time zone 'America/New_York')::date::text as day`)).rows[0].day;
});

afterAll(async () => {
  activeClient = null;
  await client?.end().catch(() => {});
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

describe('setReachedOutMark on a real database', () => {
  test('a first mark is one current row naming who and the role, audited as a create; a repeat writes nothing', async () => {
    const gym = await newGym('first');
    await expect(set(gym.coach, 'ada', day(-20), true)).resolves.toBe('marked');
    await expect(set(gym.coach2, 'ada', day(-20), true)).resolves.toBe('already_marked');

    const rows = await marks(gym, 'ada');
    expect(rows).toEqual([expect.objectContaining({
      marked_by_account_id: gym.coach.accountId, marked_by_role: 'coach', cleared_by_account_id: null, cleared_kind: null, ended: false,
    })]);
    expect(await audits(gym)).toEqual([{
      event_type: 'create', actor_account_id: gym.coach.accountId, actor_role: 'coach', entity_id: rows[0].mark_id,
      details: { athlete_id: 'ada' },
    }]);
  });

  test('a stale mark (not newer than the last day they came) is ended as replaced by the new marker, and the new mark is current, both audited', async () => {
    const gym = await newGym('replace');
    await set(gym.coach, 'ada', day(-40), true);
    await backdate(gym, 'ada', day(-30));
    // Ada came back 25 days ago, after the mark, and stopped again. A mark on the day they came is stale too.
    await expect(set(gym.admin, 'ada', day(-25), true)).resolves.toBe('marked');
    await set(gym.coach, 'ben', day(-40), true);
    await backdate(gym, 'ben', day(-30));
    await expect(set(gym.coach2, 'ben', day(-30), true)).resolves.toBe('marked');

    const [old, current] = await marks(gym, 'ada');
    expect(old).toEqual(expect.objectContaining({
      marked_by_account_id: gym.coach.accountId, cleared_by_account_id: gym.admin.accountId, cleared_kind: 'replaced', ended: true, ended_after: true,
    }));
    expect(current).toEqual(expect.objectContaining({
      marked_by_account_id: gym.admin.accountId, marked_by_role: 'organization_admin', cleared_kind: null, ended: false,
    }));
    expect((await marks(gym, 'ben')).map((row) => row.cleared_kind)).toEqual(['replaced', null]);
    const adaAudits = (await audits(gym)).filter((row) => row.details.athlete_id === 'ada');
    expect(adaAudits).toEqual([
      expect.objectContaining({ event_type: 'create', entity_id: old.mark_id, actor_role: 'coach' }),
      { event_type: 'update', actor_account_id: gym.admin.accountId, actor_role: 'organization_admin', entity_id: old.mark_id,
        details: { athlete_id: 'ada', action: 'clear', cleared_kind: 'replaced' } },
      { event_type: 'create', actor_account_id: gym.admin.accountId, actor_role: 'organization_admin', entity_id: current.mark_id,
        details: { athlete_id: 'ada' } },
    ]);
    // The new mark is newer than the day they came, so marking again writes nothing.
    await expect(set(gym.coach, 'ada', day(-25), true)).resolves.toBe('already_marked');
    expect(await marks(gym, 'ada')).toHaveLength(2);
  });

  test('a take-back ends only a newer current mark, keeps the row and audits it; a stale mark, an ended one, or none has nothing to take back', async () => {
    const gym = await newGym('takeback');
    await expect(set(gym.coach, 'ada', null, false)).resolves.toBe('not_marked');
    await set(gym.coach, 'ada', day(-20), true);
    await expect(set(gym.coach2, 'ada', day(-20), false)).resolves.toBe('taken_back');
    await expect(set(gym.coach2, 'ada', day(-20), false)).resolves.toBe('not_marked');
    const [ended] = await marks(gym, 'ada');
    expect(ended).toEqual(expect.objectContaining({
      marked_by_account_id: gym.coach.accountId, cleared_by_account_id: gym.coach2.accountId, cleared_kind: 'taken_back', ended: true,
    }));
    expect((await audits(gym)).at(-1)).toEqual({
      event_type: 'update', actor_account_id: gym.coach2.accountId, actor_role: 'coach', entity_id: ended.mark_id,
      details: { athlete_id: 'ada', action: 'clear', cleared_kind: 'taken_back' },
    });

    // A stale mark is not taken back: it stays current until a new mark replaces it.
    await set(gym.coach, 'ben', day(-40), true);
    await backdate(gym, 'ben', day(-30));
    const before = await audits(gym);
    await expect(set(gym.coach, 'ben', day(-25), false)).resolves.toBe('not_marked');
    expect(await marks(gym, 'ben')).toEqual([expect.objectContaining({ ended: false })]);
    expect(await audits(gym)).toEqual(before);
  });

  test('a losing end (rowCount 0, no error under read committed) is never taken as done', async () => {
    const gym = await newGym('losing');
    // Every end answers as if another transaction had ended the mark first.
    const losing = (tx: PoolClient) => ({
      query: (text: string, values: unknown[]) => (/^\s*update pilot\.athlete_reached_out_marks/.test(text)
        ? Promise.resolve({ rows: [], rowCount: 0 })
        : tx.query(text, values)),
    }) as unknown as PoolClient;

    await set(gym.coach, 'ada', day(-20), true);
    const auditsBefore = await audits(gym);
    await expect(inTransaction((tx) => setReachedOutMark(losing(tx), {
      actor: gym.coach2, role: 'coach', athleteId: 'ada', lastCameDay: day(-20), reachedOut: false,
    }))).resolves.toBe('not_marked');
    expect(await audits(gym)).toEqual(auditsBefore);

    // A replace whose end lost inserts nothing: the whole transaction is refused and rolled back.
    await backdate(gym, 'ada', day(-30));
    await expect(inTransaction((tx) => setReachedOutMark(losing(tx), {
      actor: gym.coach2, role: 'coach', athleteId: 'ada', lastCameDay: day(-25), reachedOut: true,
    }))).rejects.toBeInstanceOf(ConflictError);
    expect(await marks(gym, 'ada')).toEqual([expect.objectContaining({ marked_by_account_id: gym.coach.accountId, ended: false })]);
    expect(await audits(gym)).toEqual(auditsBefore);
  });

  describe('two coaches at once: the second reads the first\'s result', () => {
    async function race(gym: Gym, athleteId: string, lastCameDay: string | null, reachedOut: boolean) {
      const { other, pid } = await secondConnection();
      try {
        await client.query('BEGIN');
        const first = await setReachedOutMark(client as unknown as PoolClient, {
          actor: gym.coach, role: 'coach', athleteId, lastCameDay, reachedOut,
        });
        const second = set(gym.coach2, athleteId, lastCameDay, reachedOut, other);
        await waitUntilBlocked(pid);
        await client.query('COMMIT');
        return [first, await second];
      } finally {
        await other.end();
      }
    }

    test('both mark an athlete with no mark: one current mark, one create', async () => {
      const gym = await newGym('race-mark');
      expect(await race(gym, 'ada', day(-20), true)).toEqual(['marked', 'already_marked']);
      expect(await marks(gym, 'ada')).toEqual([expect.objectContaining({ marked_by_account_id: gym.coach.accountId, ended: false })]);
      expect((await audits(gym)).map((row) => row.event_type)).toEqual(['create']);
    });

    test('both replace a stale mark: it is ended once, one new current mark', async () => {
      const gym = await newGym('race-replace');
      await set(gym.admin, 'ada', day(-40), true);
      await backdate(gym, 'ada', day(-30));
      expect(await race(gym, 'ada', day(-25), true)).toEqual(['marked', 'already_marked']);
      expect((await marks(gym, 'ada')).map((row) => [row.marked_by_account_id, row.cleared_by_account_id, row.cleared_kind])).toEqual([
        [gym.admin.accountId, gym.coach.accountId, 'replaced'],
        [gym.coach.accountId, null, null],
      ]);
      expect((await audits(gym)).map((row) => row.event_type)).toEqual(['create', 'update', 'create']);
    });

    test('both take back: it is ended once, by the first', async () => {
      const gym = await newGym('race-takeback');
      await set(gym.admin, 'ada', day(-20), true);
      expect(await race(gym, 'ada', day(-20), false)).toEqual(['taken_back', 'not_marked']);
      expect((await marks(gym, 'ada')).map((row) => [row.cleared_by_account_id, row.cleared_kind])).toEqual([
        [gym.coach.accountId, 'taken_back'],
      ]);
      expect((await audits(gym)).map((row) => row.event_type)).toEqual(['create', 'update']);
    });
  });
});

describe('readCurrentReachedOut on a real database', () => {
  test('a current mark shows only while newer than the last day they came, by display name and gym day, with no account id', async () => {
    const gym = await newGym('read');
    const other = await newGym('read-other');
    await set(gym.coach, 'ada', day(-20), true); // newer: shown, a coach signs "Coach"
    await set(gym.admin, 'ben', day(-20), true);
    await backdate(gym, 'ben', day(-20)); // marked on the day they last came: stale, not shown
    await set(gym.admin, 'cy', null, true); // never came: no mark is stale; an admin signs without "Coach"
    await set(gym.coach, 'dee', day(-20), true);
    await set(gym.coach, 'dee', day(-20), false); // taken back: not current
    await set(other.coach, 'ada', day(-20), true); // another gym's athlete of the same id

    const lastCame = new Map<string, string | null>([['ada', day(-20)], ['ben', day(-20)], ['cy', null], ['dee', day(-20)]]);
    const shown = await readCurrentReachedOut(gym.organizationId, lastCame);
    expect(Object.fromEntries(shown)).toEqual({
      ada: { by_name: 'Coach Jordan', on_day: TODAY },
      cy: { by_name: 'Pat', on_day: TODAY },
    });
    const text = JSON.stringify(Object.fromEntries(shown));
    for (const actor of [gym.coach, gym.coach2, gym.admin]) expect(text).not.toContain(actor.accountId);

    // The other gym reads its own mark only.
    expect(Object.fromEntries(await readCurrentReachedOut(other.organizationId, new Map([['ada', day(-20)], ['ben', null]]))))
      .toEqual({ ada: { by_name: 'Coach Jordan', on_day: TODAY } });
    // Nothing asked, nothing read.
    expect((await readCurrentReachedOut(gym.organizationId, new Map())).size).toBe(0);
  });

  test('a mark whose marker account was deleted stays, and its by_name is null: who it was is no longer known', async () => {
    const gym = await newGym('gone');
    const leaverId = `acct-leaver-${gymCount}`;
    await staffMember(gym.organizationId, leaverId, 'coach', 'Robin');
    const leaver: ActorIdentity = { organizationId: gym.organizationId, accountId: leaverId, role: 'coach', athleteId: null };
    await set(leaver, 'ada', day(-20), true);
    await expect(readCurrentReachedOut(gym.organizationId, new Map([['ada', day(-20)]])))
      .resolves.toEqual(new Map([['ada', { by_name: 'Coach Robin', on_day: TODAY }]]));

    await client.query('delete from pilot.accounts where account_id = $1', [leaverId]);
    expect(await marks(gym, 'ada')).toEqual([expect.objectContaining({ marked_by_account_id: null, ended: false })]);
    await expect(readCurrentReachedOut(gym.organizationId, new Map([['ada', day(-20)]])))
      .resolves.toEqual(new Map([['ada', { by_name: null, on_day: TODAY }]]));
  });
});
