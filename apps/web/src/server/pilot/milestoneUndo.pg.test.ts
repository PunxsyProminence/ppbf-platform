// Real PostgreSQL contract test for undoSelfMilestone and the reads around it (lane L43, F-133;
// OD-2026-10-17-003: "10-minute undo of their own mark; never touches a coach's mark; history
// kept"):
//
//   1. THE OWNER: another athlete's award, or one made from another account, matches nothing;
//   2. THEIR OWN MARK ONLY: a coach's award is never taken back;
//   3. THE WINDOW, by the database's clock: a mark older than ten minutes stands;
//   4. ONCE, and a reversal, not a delete: the row stays with undone_at set, and every read that
//      shows or counts awards leaves it out;
//   5. a later real mark, or a coach's award, brings the same row back; a standing award keeps its
//      first date.
//
// Each property is asserted against the real schema, because the SQL is the whole guarantee: the
// route only forwards the athlete it cleared and the account that is signed in.
//
// Spins up the same disposable, local-only embedded Postgres the other suites use. It NEVER
// connects to production or staging.

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
  MILESTONE_UNDO_WINDOW_MINUTES,
  awardMilestone,
  listMilestoneAwards,
  undoSelfMilestone,
} from './achievements';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-milestone-undo-app-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const TEMPLATE_DB = 'mundo_app_template';

const ORG = 'org-mundo-app';
const COACH = 'acct-mundo-app-coach';
const ATHLETE_ACCOUNT = 'acct-mundo-app-athlete';
const OTHER_ACCOUNT = 'acct-mundo-app-other';
const ATHLETE = 'ATH-MUNDO-APP-1';
const OTHER_ATHLETE = 'ATH-MUNDO-APP-2';
const MILE = 'conditioning.mile_unbroken';
const WRAPS = 'craft.wraps_own_hands';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let databaseCounter = 0;

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

async function createDatabase(name: string, template?: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(template ? `create database ${name} template ${template}` : `create database ${name}`);
  await admin.end();
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

/** The whole schema (in the `all` order) and the people, built once; each test gets a copy. */
async function buildTemplate(): Promise<void> {
  const client = await createDatabase(TEMPLATE_DB);
  try {
    await applyFullSchema(client, { infraDir: INFRA_DIR });
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [ORG],
    );
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'coach', $4, 'microsoft'), ($2, 'athlete', $4, 'microsoft'), ($3, 'athlete', $4, 'microsoft')`,
      [COACH, ATHLETE_ACCOUNT, OTHER_ACCOUNT, ORG],
    );
    for (const athleteId of [ATHLETE, OTHER_ATHLETE]) {
      await client.query(
        `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
           emergency_contact, active_flag, coach_id, created_at, updated_at)
         values ($1, $2, 'Undo Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
        [ORG, athleteId, COACH],
      );
    }
  } finally {
    await client.end();
  }
}

async function withDatabase(run: (client: Client) => Promise<void>): Promise<void> {
  databaseCounter += 1;
  const client = await createDatabase(`mundo_app_${databaseCounter}`, TEMPLATE_DB);
  activeClient = client;
  try {
    await run(client);
  } finally {
    activeClient = null;
    await client.end();
  }
}

function selfMark(milestoneKey = MILE, athleteId = ATHLETE, account = ATHLETE_ACCOUNT) {
  return awardMilestone({
    organizationId: ORG, athleteId, milestoneKey, awardedByRole: 'self', awardedByAccountId: account,
  });
}

function coachMark(milestoneKey = MILE, athleteId = ATHLETE) {
  return awardMilestone({
    organizationId: ORG, athleteId, milestoneKey, awardedByRole: 'coach', awardedByAccountId: COACH,
  });
}

function undo(params: { milestoneKey?: string; athleteId?: string; actor?: string } = {}) {
  return undoSelfMilestone({
    organizationId: ORG,
    athleteId: params.athleteId ?? ATHLETE,
    milestoneKey: params.milestoneKey ?? MILE,
    actorAccountId: params.actor ?? ATHLETE_ACCOUNT,
  });
}

/** Moves a mark back in time on the database's own clock, as a mark made `minutes` ago. */
async function markMadeAgo(client: Client, minutes: number, milestoneKey = MILE): Promise<void> {
  await client.query(
    `update pilot.athlete_milestones set awarded_at = now() - $3 * interval '1 minute'
      where organization_id = $1 and athlete_id = $2 and milestone_key = $4`,
    [ORG, ATHLETE, minutes, milestoneKey],
  );
}

async function rowOf(client: Client, milestoneKey = MILE, athleteId = ATHLETE) {
  const rows = await client.query(
    `select awarded_by_role, awarded_by_account_id, awarded_at, undone_at
       from pilot.athlete_milestones where organization_id = $1 and athlete_id = $2 and milestone_key = $3`,
    [ORG, athleteId, milestoneKey],
  );
  return rows.rows[0] ?? null;
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

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
  await buildTemplate();
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

describe('undoSelfMilestone (OD-2026-10-17-003, F-133)', () => {
  test('the athlete takes back their own fresh mark: the row stays, undone, and no read shows it', async () => {
    await withDatabase(async (client) => {
      const marked = await selfMark();
      expect(marked).not.toBeNull();

      const undone = await undo();
      expect(undone).toMatchObject({ athlete_id: ATHLETE, milestone_key: MILE });
      expect(new Date(undone!.undone_awarded_at).toISOString()).toBe(new Date(marked!.awarded_at).toISOString());

      const row = await rowOf(client);
      expect(row).not.toBeNull();
      expect(row.undone_at).toBeInstanceOf(Date);
      expect(await listMilestoneAwards(ORG, ATHLETE)).toEqual([]);
    });
  });

  test("a coach's award is never taken back, fresh or not", async () => {
    await withDatabase(async (client) => {
      await coachMark();
      expect(await undo()).toBeNull();
      expect((await rowOf(client)).undone_at).toBeNull();
      expect((await listMilestoneAwards(ORG, ATHLETE)).map((a) => a.milestone_key)).toEqual([MILE]);
    });
  });

  test("a coach marking the athlete's own fresh award makes it the coach's -- first date kept -- and the athlete's Undo no longer reaches it", async () => {
    await withDatabase(async (client) => {
      await selfMark();
      await markMadeAgo(client, 2);
      const firstAt = (await rowOf(client)).awarded_at as Date;

      // The coach's screen was read before the athlete tapped; the coach marks it a minute later.
      const award = await coachMark();
      expect(award).toMatchObject({ awarded_by_role: 'coach' });
      const row = await rowOf(client);
      expect(row).toMatchObject({ awarded_by_role: 'coach', awarded_by_account_id: COACH, undone_at: null });
      expect((row.awarded_at as Date).toISOString()).toBe(firstAt.toISOString());

      expect(await undo()).toBeNull();
      expect((await rowOf(client)).undone_at).toBeNull();
      expect((await listMilestoneAwards(ORG, ATHLETE)).map((a) => a.milestone_key)).toEqual([MILE]);
    });
  });

  test("the athlete marking a coach's standing award changes nothing", async () => {
    await withDatabase(async (client) => {
      await coachMark();
      const before = await rowOf(client);
      await selfMark();
      expect(await rowOf(client)).toEqual(before);
      expect(await undo()).toBeNull();
    });
  });

  test("taken back, then a coach's award brings it back as the coach's, which is never undone", async () => {
    await withDatabase(async (client) => {
      await selfMark();
      expect(await undo()).not.toBeNull();
      await coachMark();
      expect(await rowOf(client)).toMatchObject({ awarded_by_role: 'coach', awarded_by_account_id: COACH, undone_at: null });
      expect(await undo()).toBeNull();
      expect((await rowOf(client)).undone_at).toBeNull();
    });
  });

  test("another athlete's mark, or a mark made from another account, matches nothing", async () => {
    await withDatabase(async (client) => {
      await selfMark(MILE, OTHER_ATHLETE, OTHER_ACCOUNT);
      // The cleared athlete is ATHLETE: naming the other athlete's award from this account fails.
      expect(await undo({ athleteId: OTHER_ATHLETE })).toBeNull();
      expect((await rowOf(client, MILE, OTHER_ATHLETE)).undone_at).toBeNull();

      // ATHLETE's own row, but marked from another account: not this account's mark.
      await selfMark(MILE, ATHLETE, OTHER_ACCOUNT);
      expect(await undo()).toBeNull();
      expect((await rowOf(client)).undone_at).toBeNull();
      // The account that made it may.
      expect(await undo({ actor: OTHER_ACCOUNT })).not.toBeNull();
    });
  });

  test('the window is ten minutes on the database clock: nine stands open, eleven is closed', async () => {
    expect(MILESTONE_UNDO_WINDOW_MINUTES).toBe(10);
    await withDatabase(async (client) => {
      await selfMark(MILE);
      await selfMark(WRAPS);
      await markMadeAgo(client, 11, MILE);
      await markMadeAgo(client, 9, WRAPS);

      expect(await undo({ milestoneKey: MILE })).toBeNull();
      expect((await rowOf(client, MILE)).undone_at).toBeNull();
      expect(await undo({ milestoneKey: WRAPS })).not.toBeNull();
    });
  });

  test('once: an award already taken back matches nothing', async () => {
    await withDatabase(async () => {
      await selfMark();
      expect(await undo()).not.toBeNull();
      expect(await undo()).toBeNull();
    });
  });

  test('a later real mark brings the same row back with its new date; a standing award keeps its first', async () => {
    await withDatabase(async (client) => {
      await selfMark();
      await markMadeAgo(client, 5);
      const firstAt = (await rowOf(client)).awarded_at as Date;

      // A second tap on a standing award moves nothing.
      await selfMark();
      expect(((await rowOf(client)).awarded_at as Date).toISOString()).toBe(firstAt.toISOString());

      expect(await undo()).not.toBeNull();
      const back = await selfMark();
      expect(back).toMatchObject({ milestone_key: MILE, awarded_by_role: 'self' });
      const row = await rowOf(client);
      expect(row.undone_at).toBeNull();
      expect((row.awarded_at as Date).getTime()).toBeGreaterThan(firstAt.getTime());
      expect((await listMilestoneAwards(ORG, ATHLETE)).map((a) => a.milestone_key)).toEqual([MILE]);

      // Still one row for the milestone: no countable quantity accumulated.
      const count = await client.query(
        'select count(*)::int as n from pilot.athlete_milestones where organization_id = $1 and athlete_id = $2',
        [ORG, ATHLETE],
      );
      expect(count.rows[0].n).toBe(1);
    });
  });
});
