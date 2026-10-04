// adultPathway.ts against real rows (map item 17, B1b): the production
// functions run their own SQL, inside real transactions, against the full
// schema in deploy order (scripts/lib/full-schema.mjs), so the access
// chokepoint, the membership gate, the dob read, the row locks and the
// append-only stamps are all the real thing. './db' routes into one embedded
// Postgres client; withTransaction runs a real BEGIN/COMMIT/ROLLBACK on it.
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
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const client = activeClient;
    await client.query('BEGIN');
    try {
      const result = await fn({ query: (text: string, values: unknown[]) => client.query(text, values) });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }),
}));

import type { ActorIdentity } from './access';
import {
  confirmPathwayCheckpoint,
  getAthletePathway,
  grantMinorAllowance,
  placeAthleteOnStage,
  withdrawMinorAllowance,
  withdrawPathwayCheckpoint,
} from './adultPathway';
import type { PilotRole } from './contracts';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-adult-pathway-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-path';
const OTHER_ORG_ID = 'org-path-elsewhere';
const ADMIN_ID = 'acct-path-admin';
const OTHER_ADMIN_ID = 'acct-path-other-admin';
const COACH_ID = 'acct-path-coach'; // coach of record for both athletes
const UNASSIGNED_COACH_ID = 'acct-path-unassigned'; // active coach here, reaches nobody
const ATHLETE_ACCOUNT_ID = 'acct-path-athlete';
const PARENT_ACCOUNT_ID = 'acct-path-parent';
const ADULT_ID = 'ath-path-adult';
const MINOR_ID = 'ath-path-minor';

function actorFor(accountId: string, role: PilotRole, organizationId: string = ORG_ID, athleteId: string | null = null): ActorIdentity {
  return { accountId, role, organizationId, athleteId };
}

const ADMIN = actorFor(ADMIN_ID, 'organization_admin');
const OTHER_ADMIN = actorFor(OTHER_ADMIN_ID, 'organization_admin', OTHER_ORG_ID);
const COACH = actorFor(COACH_ID, 'coach');
const UNASSIGNED_COACH = actorFor(UNASSIGNED_COACH_ID, 'coach');
const ATHLETE = actorFor(ATHLETE_ACCOUNT_ID, 'athlete', ORG_ID, ADULT_ID);
const GUARDIAN = actorFor(PARENT_ACCOUNT_ID, 'parent');

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
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

async function freshDatabase(name: string): Promise<Client> {
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
     values ($1, 'organization_admin', $7, 'microsoft', null),
            ($2, 'organization_admin', $8, 'microsoft', null),
            ($3, 'coach',              $7, 'microsoft', null),
            ($4, 'coach',              $7, 'microsoft', null),
            ($5, 'athlete',            $7, 'microsoft', $9),
            ($6, 'parent',             $7, 'microsoft', null)
     on conflict do nothing`,
    [ADMIN_ID, OTHER_ADMIN_ID, COACH_ID, UNASSIGNED_COACH_ID, ATHLETE_ACCOUNT_ID, PARENT_ACCOUNT_ID,
     ORG_ID, OTHER_ORG_ID, ADULT_ID],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $7, 'organization_admin', true),
            ($2, $8, 'organization_admin', true),
            ($3, $7, 'coach',              true),
            ($4, $7, 'coach',              true),
            ($5, $7, 'athlete',            true),
            ($6, $7, 'parent',             true)
     on conflict do nothing`,
    [ADMIN_ID, OTHER_ADMIN_ID, COACH_ID, UNASSIGNED_COACH_ID, ATHLETE_ACCOUNT_ID, PARENT_ACCOUNT_ID,
     ORG_ID, OTHER_ORG_ID],
  );
  for (const [athleteId, dob] of [[ADULT_ID, '1990-01-01'], [MINOR_ID, '2012-01-01']] as const) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Pathway Athlete', $3, '100', 'active', 'contact', true, $4, now(), now())
       on conflict do nothing`,
      [ORG_ID, athleteId, dob, COACH_ID],
    );
  }
  activeClient = client;
  return client;
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
});

afterEach(async () => {
  if (activeClient) await activeClient.end().catch(() => {});
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

describe('adultPathway.ts against real rows', () => {
  test('placing again replaces: the old row is stamped and chained, history kept', async () => {
    const client = await freshDatabase('path_replace');
    const first = await placeAthleteOnStage({ actor: COACH, athleteId: ADULT_ID, stageKey: 'foundation' });
    const second = await placeAthleteOnStage({ actor: ADMIN, athleteId: ADULT_ID, stageKey: 'intermediate', note: 'Ready.' });
    await expect(placeAthleteOnStage({ actor: COACH, athleteId: ADULT_ID, stageKey: 'intermediate' }))
      .rejects.toMatchObject({ code: 'PATHWAY_ALREADY_PLACED' });

    const old = await client.query(
      `select end_reason, ended_by_account_id, ended_by_role, superseded_by_placement_id::text as next
         from pilot.athlete_pathway_stages where placement_id = $1`,
      [first.placement_id],
    );
    expect(old.rows[0]).toEqual({
      end_reason: 'replaced', ended_by_account_id: ADMIN_ID, ended_by_role: 'organization_admin', next: second.placement_id,
    });

    const pathway = await getAthletePathway(COACH, ADULT_ID);
    expect(pathway.current?.stage_key).toBe('intermediate');
    expect(pathway.current?.set_by_role).toBe('organization_admin');
    expect(pathway.history).toHaveLength(2);
    expect(pathway.eligibility).toEqual({ eligible: true, basis: 'adult' });
  });

  test('a minor needs a live allowance; switching it off ends the placement, stamped with who', async () => {
    const client = await freshDatabase('path_minor');
    await expect(placeAthleteOnStage({ actor: COACH, athleteId: MINOR_ID, stageKey: 'foundation' }))
      .rejects.toMatchObject({ code: 'PATHWAY_ALLOWANCE_REQUIRED' });
    await expect(grantMinorAllowance({ actor: COACH, athleteId: MINOR_ID, reason: '  ' }))
      .rejects.toMatchObject({ code: 'PATHWAY_INVALID' });

    await grantMinorAllowance({ actor: COACH, athleteId: MINOR_ID, reason: 'Adult open class; guardian agreed.' });
    await expect(grantMinorAllowance({ actor: COACH, athleteId: MINOR_ID, reason: 'again' }))
      .rejects.toMatchObject({ code: 'PATHWAY_ALLOWANCE_EXISTS' });
    const placed = await placeAthleteOnStage({ actor: COACH, athleteId: MINOR_ID, stageKey: 'foundation' });
    await confirmPathwayCheckpoint({ actor: COACH, athleteId: MINOR_ID, stageKey: 'foundation', goalKey: 'footwork' });

    const result = await withdrawMinorAllowance({ actor: ADMIN, athleteId: MINOR_ID });
    expect(result.endedPlacementId).toBe(placed.placement_id);
    const ended = await client.query(
      `select end_reason, ended_by_account_id, superseded_by_placement_id
         from pilot.athlete_pathway_stages where placement_id = $1`,
      [placed.placement_id],
    );
    expect(ended.rows[0]).toEqual({ end_reason: 'allowance_withdrawn', ended_by_account_id: ADMIN_ID, superseded_by_placement_id: null });

    const pathway = await getAthletePathway(COACH, MINOR_ID);
    expect(pathway.current).toBeNull();
    expect(pathway.allowance).toBeNull();
    expect(pathway.eligibility).toEqual({ eligible: false, basis: 'minor' });
    // History stays: the ended placement and the tick are still there.
    expect(pathway.history).toHaveLength(1);
    expect(pathway.checkpoints.map((c) => c.goal_key)).toEqual(['footwork']);

    await expect(placeAthleteOnStage({ actor: COACH, athleteId: MINOR_ID, stageKey: 'foundation' }))
      .rejects.toMatchObject({ code: 'PATHWAY_ALLOWANCE_REQUIRED' });
    await expect(confirmPathwayCheckpoint({ actor: COACH, athleteId: MINOR_ID, stageKey: 'foundation', goalKey: 'aerobic_base' }))
      .rejects.toMatchObject({ code: 'PATHWAY_ALLOWANCE_REQUIRED' });
  });

  test("withdrawing an adult's allowance leaves their placement alone", async () => {
    await freshDatabase('path_adult_allowance');
    await grantMinorAllowance({ actor: COACH, athleteId: ADULT_ID, reason: 'Entered by mistake.' });
    await placeAthleteOnStage({ actor: COACH, athleteId: ADULT_ID, stageKey: 'advanced' });
    const result = await withdrawMinorAllowance({ actor: COACH, athleteId: ADULT_ID });
    expect(result.endedPlacementId).toBeNull();
    expect((await getAthletePathway(COACH, ADULT_ID)).current?.stage_key).toBe('advanced');
  });

  test('a goal is confirmed once, undone by a stamp, and may be confirmed again', async () => {
    const client = await freshDatabase('path_checkpoints');
    await confirmPathwayCheckpoint({ actor: COACH, athleteId: ADULT_ID, stageKey: 'foundation', goalKey: 'footwork' });
    await expect(confirmPathwayCheckpoint({ actor: COACH, athleteId: ADULT_ID, stageKey: 'foundation', goalKey: 'footwork' }))
      .rejects.toMatchObject({ code: 'PATHWAY_ALREADY_CONFIRMED' });
    await withdrawPathwayCheckpoint({ actor: ADMIN, athleteId: ADULT_ID, goalKey: 'footwork' });
    await expect(withdrawPathwayCheckpoint({ actor: ADMIN, athleteId: ADULT_ID, goalKey: 'footwork' }))
      .rejects.toMatchObject({ code: 'PATHWAY_NOT_CONFIRMED' });
    await confirmPathwayCheckpoint({ actor: COACH, athleteId: ADULT_ID, stageKey: 'foundation', goalKey: 'footwork' });
    const rows = await client.query(
      `select count(*)::int as n, count(withdrawn_at)::int as w from pilot.athlete_pathway_checkpoints`,
    );
    expect(rows.rows[0]).toEqual({ n: 2, w: 1 });
  });

  test('only staff who reach the athlete may read or write', async () => {
    const client = await freshDatabase('path_access');
    for (const actor of [ATHLETE, GUARDIAN, UNASSIGNED_COACH, OTHER_ADMIN]) {
      await expect(getAthletePathway(actor, ADULT_ID)).rejects.toMatchObject({ code: 'PATHWAY_NOT_PERMITTED' });
      await expect(placeAthleteOnStage({ actor, athleteId: ADULT_ID, stageKey: 'foundation' }))
        .rejects.toMatchObject({ code: 'PATHWAY_NOT_PERMITTED' });
      await expect(grantMinorAllowance({ actor, athleteId: MINOR_ID, reason: 'x' }))
        .rejects.toMatchObject({ code: 'PATHWAY_NOT_PERMITTED' });
    }
    for (const table of ['athlete_pathway_stages', 'athlete_pathway_minor_allowances']) {
      const rows = await client.query(`select count(*)::int as n from pilot.${table}`);
      expect(rows.rows[0].n).toBe(0);
    }
    await placeAthleteOnStage({ actor: ADMIN, athleteId: ADULT_ID, stageKey: 'foundation' });
  });
});
