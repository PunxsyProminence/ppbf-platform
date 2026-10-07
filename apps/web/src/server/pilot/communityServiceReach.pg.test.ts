// Real PostgreSQL-backed proof of the coach-reach rule on the community
// service read (route survey 2026-10-07, batch B1; OD-2026-10-05-024 item 2)
// and of the mentorship athlete lookup the DELETE route authorizes on.
//
// './db' is routed into the embedded server, so getCommunityServiceTotals,
// accessibleAthleteIds (coach of record + live coach_coverage window) and
// getMentorshipAthleteIds below are the production functions evaluating
// their real SQL against real rows. What a unit mock cannot prove and this
// suite does: that the coverage window predicate admits a covering coach
// and refuses an expired one, that a login's accounts.athlete_id and a
// row's activity_log.athlete_id both map a person to their athlete, that
// an adult volunteer reaches no coach, and that the mentorship read returns
// BOTH athlete ids in the caller's organization only.
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

// Routes every module's queries into the embedded database the suite opened.
// Declared before the imports so jest's mock hoisting sees it.
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
import { getMentorshipAthleteIds } from './achievements';
import { getCommunityServiceTotals } from './communityService';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-community-service-reach-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

// The base schema already carries pilot.coach_coverage and
// pilot.athletes.deleted_at (both are in production); the two tables read
// here are layered on top of it the way production applied them.
const LAYERED_MIGRATIONS = [
  'pilot_slice_postgres_activity_log_migration.sql',
  'pilot_slice_postgres_achievements_migration.sql',
];

const ORG = 'org-service-reach';
const OTHER_ORG = 'org-service-elsewhere';
const ADMIN = 'acct-sr-admin';
const COACH_RECORD = 'acct-sr-coach-record'; // coach of record for ATH_A and ATH_C
const COACH_COVER = 'acct-sr-coach-cover'; // covers ATH_B by a live grant, nobody by assignment
const COACH_OTHER = 'acct-sr-coach-other'; // coach of record for ATH_B and ATH_D
const COACH_NOBODY = 'acct-sr-coach-nobody'; // assigned nothing, covers nothing
const PLATFORM = 'acct-sr-platform';
const VOLUNTEER = 'acct-sr-volunteer'; // an adult with service hours and no athlete record
const ATH_A = 'ath-sr-a';
const ATH_B = 'ath-sr-b';
const ATH_C = 'ath-sr-c'; // login carries no athlete_id; the ROW names the athlete
const ATH_D = 'ath-sr-d'; // row carries no athlete_id; the LOGIN names the athlete
const LOGIN_A = 'acct-sr-kid-a';
const LOGIN_B = 'acct-sr-kid-b';
const LOGIN_C = 'acct-sr-kid-c';
const LOGIN_D = 'acct-sr-kid-d';
const MENTORSHIP = 'mentor-sr-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string;
let layeredSql: string[];
let client: Client;

function actor(accountId: string, role: ActorIdentity['role'], organizationId = ORG): ActorIdentity {
  return { accountId, role, organizationId, athleteId: null };
}

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

  const db = new Client({ connectionString: connectionStringFor(name) });
  await db.connect();
  await db.query(baseSchemaSql);
  for (const sql of layeredSql) {
    await db.query(sql);
  }
  return db;
}

async function seed(db: Client): Promise<void> {
  for (const org of [ORG, OTHER_ORG]) {
    await db.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  const staff = `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag)
     values ($1, $2, $3, 'microsoft', true)`;
  await db.query(staff, [ADMIN, 'organization_admin', ORG]);
  await db.query(staff, [COACH_RECORD, 'coach', ORG]);
  await db.query(staff, [COACH_COVER, 'coach', ORG]);
  await db.query(staff, [COACH_OTHER, 'coach', ORG]);
  await db.query(staff, [COACH_NOBODY, 'coach', ORG]);
  await db.query(staff, [PLATFORM, 'platform_owner', ORG]);
  await db.query(staff, [VOLUNTEER, 'volunteer', ORG]);

  const athlete = `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, $2, '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())`;
  await db.query(athlete, [ORG, ATH_A, COACH_RECORD]);
  await db.query(athlete, [ORG, ATH_B, COACH_OTHER]);
  await db.query(athlete, [ORG, ATH_C, COACH_RECORD]);
  await db.query(athlete, [ORG, ATH_D, COACH_OTHER]);

  const login = `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag, athlete_id)
     values ($1, 'athlete', $2, 'ppbf_local', true, $3)`;
  await db.query(login, [LOGIN_A, ORG, ATH_A]);
  await db.query(login, [LOGIN_B, ORG, ATH_B]);
  await db.query(login, [LOGIN_C, ORG, null]);
  await db.query(login, [LOGIN_D, ORG, ATH_D]);

  // COACH_COVER holds a live grant on ATH_B and an EXPIRED one on ATH_A.
  await db.query(
    `insert into pilot.coach_coverage (organization_id, athlete_id, covering_coach_id, granted_by_account_id, starts_at, expires_at)
     values ($1, $2, $3, $4, now() - interval '1 hour', now() + interval '1 hour'),
            ($1, $5, $3, $4, now() - interval '3 hours', now() - interval '1 hour')`,
    [ORG, ATH_B, COACH_COVER, ADMIN, ATH_A],
  );

  // One verified community-service entry per person. community_service is a
  // verifier-required domain (pilot_activity_log_verified_check), so every
  // row names the admin as verifier.
  const service = `insert into pilot.activity_log
       (organization_id, activity_id, person_account_id, athlete_id, activity_domain, activity_type,
        occurred_on, duration_minutes, capture_method, recorded_by_role, recorded_by_account_id,
        verified_by_account_id, verified_at)
     values ($1, $2, $3, $4, 'community_service', 'food_bank', $5, $6, 'supervisor_entry', 'admin', $7, $7, now())`;
  await db.query(service, [ORG, 'svc-a', LOGIN_A, ATH_A, '2026-09-01', 120, ADMIN]);
  await db.query(service, [ORG, 'svc-b', LOGIN_B, ATH_B, '2026-09-02', 90, ADMIN]);
  await db.query(service, [ORG, 'svc-c', LOGIN_C, ATH_C, '2026-09-03', 60, ADMIN]);
  await db.query(service, [ORG, 'svc-d', LOGIN_D, null, '2026-09-04', 45, ADMIN]);
  await db.query(service, [ORG, 'svc-vol', VOLUNTEER, null, '2026-09-05', 240, ADMIN]);

  // A mentors B.
  await db.query(
    `insert into pilot.mentorships (organization_id, mentorship_id, mentor_athlete_id, mentee_athlete_id, created_by_account_id)
     values ($1, $2, $3, $4, $5)`,
    [ORG, MENTORSHIP, ATH_A, ATH_B, COACH_RECORD],
  );
}

async function peopleSeenBy(who: ActorIdentity): Promise<string[]> {
  return (await getCommunityServiceTotals(who)).map((person) => person.person_account_id).sort();
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
  layeredSql = await Promise.all(
    LAYERED_MIGRATIONS.map((file) => fs.readFile(path.join(INFRA_DIR, file), 'utf8')),
  );

  client = await freshDatabase('community_service_reach');
  await seed(client);
  activeClient = client;
});

afterAll(async () => {
  activeClient = null;
  await client?.end().catch(() => undefined);
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (serverProcess.exitCode === null) serverProcess.kill('SIGKILL');
        resolve();
      }, 10_000);
      serverProcess.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => undefined);
});

describe('GET community service: who sees whose hours', () => {
  test('the organization admin sees every person, the adult volunteer included', async () => {
    expect(await peopleSeenBy(actor(ADMIN, 'organization_admin'))).toEqual(
      [LOGIN_A, LOGIN_B, LOGIN_C, LOGIN_D, VOLUNTEER].sort(),
    );
  });

  test('the coach of record sees only their own athletes, mapped through the row OR the login', async () => {
    // ATH_C is reached through the row's athlete_id (login has none).
    expect(await peopleSeenBy(actor(COACH_RECORD, 'coach'))).toEqual([LOGIN_A, LOGIN_C].sort());
    // ATH_D is reached through the login's athlete_id (row has none).
    expect(await peopleSeenBy(actor(COACH_OTHER, 'coach'))).toEqual([LOGIN_B, LOGIN_D].sort());
  });

  test('a covering coach sees the athlete they are covering right now, and not one whose grant expired', async () => {
    expect(await peopleSeenBy(actor(COACH_COVER, 'coach'))).toEqual([LOGIN_B]);
  });

  test('a coach with no assignment and no coverage sees nobody', async () => {
    expect(await peopleSeenBy(actor(COACH_NOBODY, 'coach'))).toEqual([]);
  });

  test('the platform owner sees nobody (organization-private athlete records)', async () => {
    expect(await peopleSeenBy(actor(PLATFORM, 'platform_owner'))).toEqual([]);
  });

  test('the volunteer, who has no athlete record, is on no coach list even when a coach reaches every child', async () => {
    await client.query(
      `insert into pilot.coach_coverage (organization_id, athlete_id, covering_coach_id, granted_by_account_id, starts_at, expires_at)
       select $1, athlete_id, $2, $3, now() - interval '1 hour', now() + interval '1 hour'
       from pilot.athletes where organization_id = $1`,
      [ORG, COACH_NOBODY, ADMIN],
    );
    try {
      expect(await peopleSeenBy(actor(COACH_NOBODY, 'coach'))).toEqual([LOGIN_A, LOGIN_B, LOGIN_C, LOGIN_D].sort());
    } finally {
      await client.query('delete from pilot.coach_coverage where covering_coach_id = $1', [COACH_NOBODY]);
    }
  });

  test('a person filter does not widen reach: asking for an unreached person returns nothing', async () => {
    const totals = await getCommunityServiceTotals(actor(COACH_RECORD, 'coach'), { personAccountId: LOGIN_B });
    expect(totals).toEqual([]);
    const own = await getCommunityServiceTotals(actor(COACH_RECORD, 'coach'), { personAccountId: LOGIN_A });
    expect(own.map((p) => p.person_account_id)).toEqual([LOGIN_A]);
    expect(own[0].verified_minutes).toBe(120);
  });
});

describe('getMentorshipAthleteIds', () => {
  test('returns both athletes of the pairing, in the caller organization only', async () => {
    expect(await getMentorshipAthleteIds(ORG, MENTORSHIP)).toEqual({
      mentor_athlete_id: ATH_A,
      mentee_athlete_id: ATH_B,
    });
    expect(await getMentorshipAthleteIds(OTHER_ORG, MENTORSHIP)).toBeNull();
    expect(await getMentorshipAthleteIds(ORG, 'mentor-does-not-exist')).toBeNull();
  });
});
