// Real PostgreSQL-backed test for listAthleteFamilyDrills (map item 16): the
// athlete's own assignments that train one skill family.
//
// WHY A REAL DATABASE. Every property worth proving is a join or a predicate:
// the path assignment -> pilot.drills -> reference_drill_id ->
// pilot.drill_library.skill_id or pilot.drill_secondary_skills, the
// organization on every join, the athlete filter, cancelled work left out,
// and hand-authored / legacy work counted as unlinked rather than lost.
//
// One fixture, read-only, every scenario side by side -- the same shape and
// reasons as assignmentDrillInstruction.pg.test.ts. './db' is routed into the
// embedded server, so the function runs its production SQL. It NEVER connects
// to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

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

import { FAMILY_MEMBER_CODES } from './skillFamilies';
import { countUnlinkedAssignments, listAthleteFamilyDrills } from './skillProgressionOrder';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-skill-progression-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const DATABASE_NAME = 'ppbf_test_skill_progression';

const ORG_A = 'org-skp-a';
/** The other gym. Reuses ORG_A's drill and athlete ids on purpose. */
const ORG_B = 'org-skp-b';
const COACH_A = 'acct-skp-coach-a';
const COACH_B = 'acct-skp-coach-b';
const ATHLETE = 'ATH-SKP-1';
const OTHER_ATHLETE = 'ATH-SKP-2';

const SKILL_01 = [...FAMILY_MEMBER_CODES['SKILL-01']!];

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let seededClient: Client;

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

async function insertReference(client: Client, organizationId: string, drillId: string, skillId: string | null) {
  await client.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, version, supersedes_drill_id, name, discipline, category,
        difficulty, target_behavior, purpose, standard_setup, execution, what_good_looks_like,
        what_bad_looks_like, common_errors, corrections, transfer, contact_level, equipment_needed,
        requires_coach_authorization, source_ref, grounding_claim_ids, active, created_by_account_id,
        created_by_role, skill_id)
     values ($1,$2,$2,1,null,$2,'boxing','footwork','intermediate',
             't','p','s','e','g','b','c','x','t','light_technical','none',
             false,'ref',array[]::text[],true,'acct-skp-author','platform_owner',$3)`,
    [organizationId, drillId, skillId],
  );
}

async function insertOperational(
  client: Client,
  organizationId: string,
  drillId: string,
  name: string,
  referenceDrillId: string | null,
) {
  await client.query(
    `insert into pilot.drills
       (organization_id, drill_id, name, category, focus, active, lineage_id, supersedes_drill_id, reference_drill_id, version)
     values ($1,$2,$3,'bagwork','Focus.',true,$2,null,$4,1)`,
    [organizationId, drillId, name, referenceDrillId],
  );
}

async function insertAssignment(
  client: Client,
  opts: {
    organizationId: string;
    assignmentId: string;
    athleteId: string;
    coach: string;
    drillId: string | null;
    status?: string;
    assignedAt: string;
  },
) {
  await client.query(
    `insert into pilot.drill_assignments
       (assignment_id, organization_id, gap_id, athlete_id, assigned_by_account_id, drill_id,
        drill_name, drill_description, status, completion_percentage, assigned_at)
     values ($1,$2,null,$3,$4,$5,'Typed on the day','Typed.',$6,0,$7)`,
    [
      opts.assignmentId,
      opts.organizationId,
      opts.athleteId,
      opts.coach,
      opts.drillId,
      opts.status ?? 'assigned',
      opts.assignedAt,
    ],
  );
}

async function seededDatabase(): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${DATABASE_NAME}`);
  await admin.query(`create database ${DATABASE_NAME}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(DATABASE_NAME) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const [organizationId, coachId] of [
    [ORG_A, COACH_A],
    [ORG_B, COACH_B],
  ]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [organizationId],
    );
    await client.query(
      `insert into pilot.disciplines (organization_id, discipline, display_name, lane, exposure_model)
       values ($1, 'boxing', 'Boxing', 'striking', 'head_impact')`,
      [organizationId],
    );
    await client.query(
      `insert into pilot.accounts (account_id, login_email, role, organization_id, auth_provider)
       values ($1, $1 || '@ppbf.test', 'coach', $2, 'microsoft')`,
      [coachId, organizationId],
    );
    for (const athleteId of [ATHLETE, OTHER_ATHLETE]) {
      await client.query(
        `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
         values ($1, $2, 'Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
        [organizationId, athleteId, coachId],
      );
    }
  }

  // ORG_A reference drills: a SKILL-01 primary, a non-SKILL-01 primary, and a
  // non-SKILL-01 primary carrying a SKILL-01 secondary.
  await insertReference(client, ORG_A, 'ref-guard', 'SK-GUARD-01');
  await insertReference(client, ORG_A, 'ref-jab', 'SK-JAB-01');
  await insertReference(client, ORG_A, 'ref-jab-guard', 'SK-JAB-01');
  await client.query(
    `insert into pilot.drill_secondary_skills (organization_id, drill_id, skill_id) values ($1, 'ref-jab-guard', 'SK-STANCE-01')`,
    [ORG_A],
  );

  await insertOperational(client, ORG_A, 'op-guard', 'Guard Reset', 'ref-guard');
  await insertOperational(client, ORG_A, 'op-jab', 'Jab Line', 'ref-jab');
  await insertOperational(client, ORG_A, 'op-jab-guard', 'Jab Then Guard', 'ref-jab-guard');
  // Hand-authored by the gym: no reference behind it.
  await insertOperational(client, ORG_A, 'op-gym', 'Gym Bag Rounds', null);
  // Promoted reference drills with no primary skill code (the seed ships
  // these, e.g. warm-ups): one with no secondary row either -- no family can
  // ever claim it, so it is unlinked -- and one carrying a secondary code,
  // which is linked.
  await insertReference(client, ORG_A, 'ref-warmup', null);
  await insertOperational(client, ORG_A, 'op-warmup', 'Warm-Up', 'ref-warmup');
  await insertReference(client, ORG_A, 'ref-warmup-guard', null);
  await client.query(
    `insert into pilot.drill_secondary_skills (organization_id, drill_id, skill_id) values ($1, 'ref-warmup-guard', 'SK-GUARD-02')`,
    [ORG_A],
  );
  await insertOperational(client, ORG_A, 'op-warmup-guard', 'Warm-Up Guard', 'ref-warmup-guard');
  // A promoted drill whose code has no family decided yet: neither listed
  // under SKILL-01 nor counted as unlinked (its family reads "not mapped yet").
  await insertReference(client, ORG_A, 'ref-footwork', 'SK-FW-01');
  await insertOperational(client, ORG_A, 'op-footwork', 'Footwork Box', 'ref-footwork');

  const a = { organizationId: ORG_A, athleteId: ATHLETE, coach: COACH_A };
  await insertAssignment(client, { ...a, assignmentId: 'asg-guard', drillId: 'op-guard', status: 'in_progress', assignedAt: '2026-10-01T00:00:00Z' });
  await insertAssignment(client, { ...a, assignmentId: 'asg-jab-guard', drillId: 'op-jab-guard', status: 'completed', assignedAt: '2026-10-02T00:00:00Z' });
  await insertAssignment(client, { ...a, assignmentId: 'asg-jab', drillId: 'op-jab', assignedAt: '2026-10-02T00:00:00Z' });
  await insertAssignment(client, { ...a, assignmentId: 'asg-guard-cancelled', drillId: 'op-guard', status: 'cancelled', assignedAt: '2026-10-03T00:00:00Z' });
  await insertAssignment(client, { ...a, assignmentId: 'asg-gym', drillId: 'op-gym', assignedAt: '2026-10-01T00:00:00Z' });
  await insertAssignment(client, { ...a, assignmentId: 'asg-legacy', drillId: null, assignedAt: '2026-09-01T00:00:00Z' });
  await insertAssignment(client, { ...a, assignmentId: 'asg-warmup', drillId: 'op-warmup', assignedAt: '2026-09-15T00:00:00Z' });
  await insertAssignment(client, { ...a, assignmentId: 'asg-warmup-guard', drillId: 'op-warmup-guard', assignedAt: '2026-09-10T00:00:00Z' });
  await insertAssignment(client, { ...a, assignmentId: 'asg-footwork', drillId: 'op-footwork', assignedAt: '2026-09-12T00:00:00Z' });
  await insertAssignment(client, { ...a, assignmentId: 'asg-gym-cancelled', drillId: 'op-gym', status: 'cancelled', assignedAt: '2026-10-01T00:00:00Z' });
  // Another athlete in the same gym, on a SKILL-01 drill.
  await insertAssignment(client, { ...a, athleteId: OTHER_ATHLETE, assignmentId: 'asg-other-athlete', drillId: 'op-guard', assignedAt: '2026-10-01T00:00:00Z' });

  // Another athlete's hand-authored work: must not reach ATHLETE's unlinked count.
  await insertAssignment(client, { ...a, athleteId: OTHER_ATHLETE, assignmentId: 'asg-other-athlete-gym', drillId: 'op-gym', assignedAt: '2026-10-01T00:00:00Z' });

  // ORG_B: the same drill ids and the same athlete id. ORG_B's ref-jab-guard
  // has NO secondary row, so only ORG_A's SK-STANCE-01 secondary could make it
  // match -- which it must not, across gyms.
  await insertReference(client, ORG_B, 'ref-guard', 'SK-GUARD-01');
  await insertOperational(client, ORG_B, 'op-guard', 'Other Gym Guard', 'ref-guard');
  await insertReference(client, ORG_B, 'ref-jab-guard', 'SK-JAB-01');
  await insertOperational(client, ORG_B, 'op-jab-guard', 'Other Gym Jab', 'ref-jab-guard');
  await insertAssignment(client, {
    organizationId: ORG_B,
    athleteId: ATHLETE,
    coach: COACH_B,
    assignmentId: 'asg-org-b-jab',
    drillId: 'op-jab-guard',
    assignedAt: '2026-10-02T00:00:00Z',
  });
  await insertAssignment(client, {
    organizationId: ORG_B,
    athleteId: ATHLETE,
    coach: COACH_B,
    assignmentId: 'asg-org-b',
    drillId: 'op-guard',
    assignedAt: '2026-10-01T00:00:00Z',
  });

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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = helper.applyFullSchema as typeof applyFullSchema;

  seededClient = await seededDatabase();
  activeClient = seededClient;
});

afterAll(async () => {
  activeClient = null;
  await seededClient?.end().catch(() => {});
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

describe('listAthleteFamilyDrills (real database)', () => {
  test('SKILL-01: own live work, by primary or secondary code, newest first', async () => {
    const items = await listAthleteFamilyDrills(ORG_A, ATHLETE, SKILL_01);

    expect(items.map((i) => [i.assignment_id, i.drill_display_name, i.status])).toEqual([
      ['asg-jab-guard', 'Jab Then Guard', 'completed'],
      ['asg-guard', 'Guard Reset', 'in_progress'],
      ['asg-warmup-guard', 'Warm-Up Guard', 'assigned'],
    ]);
  });

  test('a drill outside the family, cancelled work, another athlete and another gym are all absent', async () => {
    const items = await listAthleteFamilyDrills(ORG_A, ATHLETE, SKILL_01);
    const ids = items.map((i) => i.assignment_id);

    expect(ids).not.toContain('asg-jab');
    expect(ids).not.toContain('asg-warmup');
    expect(ids).not.toContain('asg-footwork');
    expect(ids).not.toContain('asg-guard-cancelled');
    expect(ids).not.toContain('asg-other-athlete');
    expect(ids).not.toContain('asg-org-b');
  });

  test('the other gym sees only its own row for the same athlete id', async () => {
    const items = await listAthleteFamilyDrills(ORG_B, ATHLETE, SKILL_01);

    // asg-org-b-jab is absent: the SK-STANCE-01 secondary row belongs to ORG_A.
    expect(items.map((i) => [i.assignment_id, i.drill_display_name])).toEqual([['asg-org-b', 'Other Gym Guard']]);
    expect(await countUnlinkedAssignments(ORG_B, ATHLETE)).toBe(0);
  });

  test('live work with no skill code at all is counted as unlinked; cancelled or coded work is not', async () => {
    // asg-gym, asg-legacy and asg-warmup (reference with no code at all).
    // Left out: asg-gym-cancelled, the other athlete's work, asg-warmup-guard
    // (secondary code), asg-footwork and asg-jab (codes whose family is undecided).
    expect(await countUnlinkedAssignments(ORG_A, ATHLETE)).toBe(3);
    expect(await countUnlinkedAssignments(ORG_A, OTHER_ATHLETE)).toBe(1);
  });

  test('it writes nothing (READ ONLY transaction)', async () => {
    await seededClient.query('begin read only');
    try {
      await listAthleteFamilyDrills(ORG_A, ATHLETE, SKILL_01);
      await countUnlinkedAssignments(ORG_A, ATHLETE);
    } finally {
      await seededClient.query('rollback');
    }
  });
});
