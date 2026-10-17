// Real PostgreSQL-backed test for the coach roster (entities.ts#getAthletesForCoach).
//
// Until issue #1480 PR C this pinned a field split: dob and emergency_contact
// were blanked for athletes the coach had no assignment or live coverage on.
// Since OD-2026-10-11-007 ("lets make it coaches to whole gym") every coach of
// the gym reads both for every live athlete of it, and the cases below pin
// that -- plus the two boundaries that remain: another gym, and deletion.
// Every assertion reads the columns back out of a real database.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

// Routes entities.ts's queries into whichever embedded database the current
// test opened. Declared before the import so jest's mock hoisting sees it.
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

import { getAthletesByOrganization, getAthletesForCoach } from './entities';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-coach-roster-scope-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const ORG_ID = 'org-roster';
const OTHER_ORG_ID = 'org-roster-other';
const RECORD_COACH = 'acct-coach-record';
const OTHER_COACH = 'acct-coach-other';
const ADMIN_ACCOUNT = 'acct-admin-roster';

/** Coached by RECORD_COACH. */
const ATH_MINE = 'ATH-MINE';
/** Coached by OTHER_COACH, no grant: redacted for RECORD_COACH until #1480. */
const ATH_THEIRS = 'ATH-THEIRS';
/** Coached by OTHER_COACH: the coverage case until #1480. */
const ATH_COVERED = 'ATH-COVERED';

const CONTACT_MINE = 'Rosa Vance 814-555-0110';
const CONTACT_THEIRS = 'Ada Pike 814-555-0111';
const CONTACT_COVERED = 'Ivan Sokol 814-555-0112';

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

/**
 * Fresh database: two orgs, two coaches, an admin, and three athletes -- one
 * belonging to the reading coach and two belonging to the other coach. The
 * other org gets an athlete carrying the SAME athlete_id as a covered one, so
 * a cross-tenant leak has something to leak.
 *
 * `dropCoverageTable` reproduces a database without the coach_coverage
 * migration, which the roster no longer reads at all (issue #1480 PR C).
 */
async function freshDatabase(name: string, { dropCoverageTable = false }: { dropCoverageTable?: boolean } = {}): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  /* THE WHOLE SCHEMA, not the base file alone. This suite drives feature
     code, so it has no business deciding which migrations exist -- and the
     column it was missing (athletes.deleted_at) belongs to a migration it
     never picked. See scripts/lib/full-schema.mjs. */
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  if (dropCoverageTable) {
    await client.query('drop table if exists pilot.coach_coverage cascade');
  }

  for (const organizationId of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
    for (const coach of [RECORD_COACH, OTHER_COACH]) {
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
         values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
        [organizationId === ORG_ID ? coach : `${coach}-other`, organizationId],
      );
    }
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft') on conflict do nothing`,
    [ADMIN_ACCOUNT, ORG_ID],
  );

  const athletes: Array<[string, string, string, string]> = [
    [ATH_MINE, RECORD_COACH, CONTACT_MINE, '2011-05-06'],
    [ATH_THEIRS, OTHER_COACH, CONTACT_THEIRS, '2012-06-07'],
    [ATH_COVERED, OTHER_COACH, CONTACT_COVERED, '2013-07-08'],
  ];
  for (const [athleteId, coachId, contact, dob] of athletes) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, $3, $4, 'fly', 'active', $5, true, $6, now(), now())`,
      [ORG_ID, athleteId, `Name ${athleteId}`, dob, contact, coachId],
    );
  }

  // Same athlete_id, different organization. Nothing this coach reads may
  // ever surface it, and a grant written against it must not open the door
  // to the row in ORG_ID either.
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Other Org Child', '2014-08-09', 'fly', 'active', 'other org contact', true, $3, now(), now())`,
    [OTHER_ORG_ID, ATH_COVERED, `${RECORD_COACH}-other`],
  );

  return client;
}

function rowFor<T extends { athlete_id: string }>(items: T[], athleteId: string): T {
  const found = items.find((item) => item.athlete_id === athleteId);
  if (!found) throw new Error(`test bug: ${athleteId} missing from the roster`);
  return found;
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

describe('the list stays whole', () => {
  test('a coach still sees every athlete in the organization, including the ones they do not coach', async () => {
    const client = await freshDatabase('ppbf_test_roster_whole');
    activeClient = client;
    try {
      const items = await getAthletesForCoach(ORG_ID, RECORD_COACH);

      expect(items.map((item) => item.athlete_id).sort()).toEqual([ATH_COVERED, ATH_MINE, ATH_THEIRS]);
      // Name and gym status are what a coach plans a floor and picks up cover
      // from, so they are present for every row.
      for (const item of items) {
        expect(item.full_name).toBe(`Name ${item.athlete_id}`);
        expect(item.gym_status).toBe('active');
        expect(item.weight_class).toBe('fly');
        expect(item.active_flag).toBe(true);
      }
    } finally {
      await client.end();
    }
  });

  test('the roster is org-scoped: another gym\'s child never appears', async () => {
    const client = await freshDatabase('ppbf_test_roster_tenancy');
    activeClient = client;
    try {
      const items = await getAthletesForCoach(ORG_ID, RECORD_COACH);

      expect(items).toHaveLength(3);
      expect(items.map((item) => item.full_name)).not.toContain('Other Org Child');
    } finally {
      await client.end();
    }
  });
});

/* THE FIELDS FOLLOW THE WHOLE-GYM RULE (issue #1480 PR C).

   Until #1480 the roster blanked dob and emergency_contact for athletes the
   coach was not coach of record for and held no live coverage grant on. Since
   OD-2026-10-11-007 ("lets make it coaches to whole gym") assertActorCanAccessAthlete
   admits every coach of the athlete's gym, so athletes/get already returned both
   fields per athlete; the roster now matches. Another gym's child and a
   deleted athlete never appear at all. */
describe('every coach of the gym reads the fields for every live athlete of it', () => {
  test('the coach of record reads dob and emergency_contact for their own athlete', async () => {
    const client = await freshDatabase('ppbf_test_roster_mine');
    activeClient = client;
    try {
      const mine = rowFor(await getAthletesForCoach(ORG_ID, RECORD_COACH), ATH_MINE);

      expect(mine.dob).not.toBeNull();
      expect(mine.emergency_contact).toBe(CONTACT_MINE);
    } finally {
      await client.end();
    }
  });

  test('an athlete this coach is not assigned to and holds no grant on comes back with both fields', async () => {
    const client = await freshDatabase('ppbf_test_roster_theirs');
    activeClient = client;
    try {
      const items = await getAthletesForCoach(ORG_ID, RECORD_COACH);
      const theirs = rowFor(items, ATH_THEIRS);
      const covered = rowFor(items, ATH_COVERED);

      expect(theirs.dob).not.toBeNull();
      expect(theirs.emergency_contact).toBe(CONTACT_THEIRS);
      expect(covered.emergency_contact).toBe(CONTACT_COVERED);
    } finally {
      await client.end();
    }
  });

  test('a second coach of the same gym reads the same fields for the first coach\'s athlete', async () => {
    const client = await freshDatabase('ppbf_test_roster_other_coach');
    activeClient = client;
    try {
      const mine = rowFor(await getAthletesForCoach(ORG_ID, OTHER_COACH), ATH_MINE);

      expect(mine.dob).not.toBeNull();
      expect(mine.emergency_contact).toBe(CONTACT_MINE);
    } finally {
      await client.end();
    }
  });

  test('another gym\'s child and their contact are absent from the whole payload', async () => {
    const client = await freshDatabase('ppbf_test_roster_no_leak');
    activeClient = client;
    try {
      const serialized = JSON.stringify(await getAthletesForCoach(ORG_ID, RECORD_COACH));

      expect(serialized).not.toContain('Other Org Child');
      expect(serialized).not.toContain('other org contact');
    } finally {
      await client.end();
    }
  });

  test('a deleted athlete is not on the roster, fields and all', async () => {
    const client = await freshDatabase('ppbf_test_roster_deleted');
    activeClient = client;
    try {
      await client.query(
        'update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2',
        [ORG_ID, ATH_THEIRS],
      );
      const serialized = JSON.stringify(await getAthletesForCoach(ORG_ID, RECORD_COACH));

      expect(serialized).not.toContain(ATH_THEIRS);
      expect(serialized).not.toContain(CONTACT_THEIRS);
    } finally {
      await client.end();
    }
  });

  test('the roster no longer depends on pilot.coach_coverage at all', async () => {
    // The relationship test it used to run is gone, so a database without the
    // coverage table reads the same roster, fields included.
    const client = await freshDatabase('ppbf_test_roster_no_coverage', { dropCoverageTable: true });
    activeClient = client;
    try {
      const theirs = rowFor(await getAthletesForCoach(ORG_ID, RECORD_COACH), ATH_THEIRS);

      expect(theirs.emergency_contact).toBe(CONTACT_THEIRS);
    } finally {
      await client.end();
    }
  });
});

describe('the admin read is untouched', () => {
  // The split is coach-only. If this ever starts redacting, the admin athlete
  // console (which renders dob into a date input) silently loses the field.
  test('an organization-wide read still carries dob and emergency_contact for every athlete', async () => {
    const client = await freshDatabase('ppbf_test_roster_admin');
    activeClient = client;
    try {
      const items = await getAthletesByOrganization(ORG_ID);

      expect(items).toHaveLength(3);
      for (const item of items) {
        expect(item.dob).not.toBeNull();
        expect(item.emergency_contact).toBeTruthy();
      }
    } finally {
      await client.end();
    }
  });
});
