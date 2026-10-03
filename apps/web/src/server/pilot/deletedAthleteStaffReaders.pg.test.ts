// Real PostgreSQL-backed proof that the people console and the SHADOW library
// curator queue stop showing a deleted athlete's rows (Jason, 2026-09-29,
// "10 C", OD-2026-09-29-002 item 10: everything tied to the athlete is marked
// deleted at the same moment). These were the readers #1027 left behind
// because other changes owned their files that week:
//   listOrganizationMembers        a deleted athlete's own login
//   listOrganizationGuardianLinks  a guardian's link to a deleted child
//   listShadowLibraryReviewQueue   a library document filed against them
// and one write-path guard that read the same rows:
//   removeGuardianLink             its last-link refusal counted a deleted
//                                  child's link, so it let an admin remove a
//                                  guardian's one LIVE link
//
// EVERY READER IS RUN BEFORE AND AFTER THE DELETION, IN THE SAME DATABASE.
// "Before" is the positive control: a reader that showed nothing would pass
// every "after" assertion. LIVE carries the same rows as GONE and is never
// deleted. A second gym's athlete carries GONE's id and is never deleted: a
// filter matching on athlete_id alone would hide it from its own gym's list. A
// coach who was once the athlete AGED (the login still carries AGED's
// athlete_id, and AGED is deleted too) stays listed:
// the member filter is for athlete logins only (overwatch, 2026-10-03, "#2 =
// (a) athlete logins only").
//
// The deletion is the real deleteAthleteRecord, so the mark read here is the
// one production writes.
//
// Spins up the same disposable, local-only embedded Postgres the other suites
// use. It NEVER connects to production or staging.

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
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let activeClient: Client | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows[0] ?? null;
  }),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    await activeClient.query('BEGIN');
    try {
      const result = await fn(activeClient);
      await activeClient.query('COMMIT');
      return result;
    } catch (error) {
      await activeClient.query('ROLLBACK');
      throw error;
    }
  }),
}));

import { deleteAthleteRecord } from './dataDeletion';
import { listShadowLibraryReviewQueue } from './shadowLibrary';
import { listOrganizationGuardianLinks, listOrganizationMembers, removeGuardianLink } from './staffProvisioning';

jest.setTimeout(600_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-deleted-athlete-staff-readers-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const DATABASE = 'deleted_athlete_staff_readers';

const ORG = 'org-dsr';
/** A second gym whose athlete carries GONE's id and is never deleted. */
const OTHER_ORG = 'org-dsr-other';

const ADMIN = 'acct-dsr-admin';
const COACH = 'acct-dsr-coach';
const OTHER_COACH = 'acct-dsr-other-coach';

/** Deleted between the two halves of the suite. */
const GONE = 'ATH-DSR-GONE';
const GONE_ACCOUNT = 'acct-dsr-athlete-gone';
/** Never deleted: the control. */
const LIVE = 'ATH-DSR-LIVE';
const LIVE_ACCOUNT = 'acct-dsr-athlete-live';
const LIVE_TWO = 'ATH-DSR-LIVE-TWO';
/** Also deleted: an athlete whose login was re-roled to coach and still carries the athlete_id. */
const AGED = 'ATH-DSR-AGED';
const EX_ATHLETE_COACH = 'acct-dsr-coach-was-aged';
/** The second gym's athlete login for ITS athlete with GONE's id; never deleted. */
const OTHER_GONE_ACCOUNT = 'acct-dsr-other-athlete-gone';

/** Linked to GONE and LIVE. */
const GUARDIAN = 'acct-dsr-guardian';
const GUARDIAN_PARENT = 'PAR-DSR-1';
/** Linked to LIVE and LIVE_TWO: the control for the last-link refusal. */
const GUARDIAN_LIVE = 'acct-dsr-guardian-live';
const GUARDIAN_LIVE_PARENT = 'PAR-DSR-2';

const SOURCE = 'src-dsr';
const DOC_GONE = 'doc-dsr-gone';
const DOC_LIVE = 'doc-dsr-live';
const DOC_GYM_WIDE = 'doc-dsr-gym-wide';

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
  const q = (sql: string, params: unknown[] = []) => client.query(sql, params);

  for (const org of [ORG, OTHER_ORG]) {
    await q(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [org]);
  }
  for (const [account, role, org] of [
    [ADMIN, 'organization_admin', ORG],
    [COACH, 'coach', ORG],
    [OTHER_COACH, 'coach', OTHER_ORG],
    [GUARDIAN, 'parent', ORG],
    [GUARDIAN_LIVE, 'parent', ORG],
  ] as const) {
    await q(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag, login_email)
       values ($1, $2, $3, 'microsoft', true, $1 || '@gym.test')`,
      [account, role, org],
    );
  }
  for (const [org, athlete, coach] of [
    [ORG, GONE, COACH],
    [ORG, LIVE, COACH],
    [ORG, LIVE_TWO, COACH],
    [ORG, AGED, COACH],
    [OTHER_ORG, GONE, OTHER_COACH],
  ] as const) {
    await q(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, $4, '2011-05-06', 'fly', 'active', 'contact', true, $3, now() - interval '1 year', now())`,
      [org, athlete, coach, org === ORG ? athlete : `other gym ${athlete}`],
    );
  }
  for (const [account, org, athlete, role] of [
    [GONE_ACCOUNT, ORG, GONE, 'athlete'],
    [LIVE_ACCOUNT, ORG, LIVE, 'athlete'],
    [OTHER_GONE_ACCOUNT, OTHER_ORG, GONE, 'athlete'],
    [EX_ATHLETE_COACH, ORG, AGED, 'coach'],
  ] as const) {
    await q(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, auth_provider, active_flag, login_email)
       values ($1, $4, $2, $3, 'ppbf_local', true, null)`,
      [account, org, athlete, role],
    );
  }
  for (const [account, role, org] of [
    [ADMIN, 'organization_admin', ORG],
    [COACH, 'coach', ORG],
    [GUARDIAN, 'parent', ORG],
    [GUARDIAN_LIVE, 'parent', ORG],
    [GONE_ACCOUNT, 'athlete', ORG],
    [LIVE_ACCOUNT, 'athlete', ORG],
    [EX_ATHLETE_COACH, 'coach', ORG],
    // The second gym's athlete with GONE's id, a member of its own gym.
    [OTHER_GONE_ACCOUNT, 'athlete', OTHER_ORG],
  ] as const) {
    await q(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ($1, $2, $3, true)
       on conflict (account_id, organization_id) do update set role = excluded.role`,
      [account, org, role],
    );
  }

  for (const [account, parent, athletes] of [
    [GUARDIAN, GUARDIAN_PARENT, [GONE, LIVE]],
    [GUARDIAN_LIVE, GUARDIAN_LIVE_PARENT, [LIVE, LIVE_TWO]],
  ] as const) {
    await q(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name) values ($1, $2, $3, $3)`,
      [ORG, parent, account],
    );
    for (const athlete of athletes) {
      await q(
        `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
         values ($1, $2, $3, 'parent')`,
        [ORG, parent, athlete],
      );
    }
  }

  await q(
    `insert into pilot.shadow_library_sources (source_id, organization_id, title, source_type, authority_tier, url)
     values ($1, $2, 'Seeded source', 'peer_reviewed', 1, 'https://example.org/dsr')`,
    [SOURCE, ORG],
  );
  for (const [document, subject] of [
    [DOC_GONE, GONE],
    [DOC_LIVE, LIVE],
    [DOC_GYM_WIDE, null],
  ] as const) {
    await q(
      `insert into pilot.shadow_library_documents (document_id, source_id, organization_id, subject_id, document_name, content_sha256)
       values ($1, $2, $3, $4, $1, $1)`,
      [document, SOURCE, ORG, subject],
    );
  }
}

async function memberIds(): Promise<string[]> {
  return (await listOrganizationMembers(ORG)).map((member) => member.account_id);
}

async function guardianLinks(): Promise<string[]> {
  return (await listOrganizationGuardianLinks(ORG)).map((link) => `${link.account_id}:${link.athlete_id}`);
}

async function curatorDocuments(): Promise<string[]> {
  return (await listShadowLibraryReviewQueue({ organizationId: ORG })).documents.map((document) => document.document_id);
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

  await adminQuery(`create database ${DATABASE}`);
  activeClient = new Client({ connectionString: connectionStringFor(DATABASE) });
  await activeClient.connect();
  await applyFullSchema(activeClient, { infraDir: INFRA_DIR });
  await seed(activeClient);
});

afterAll(async () => {
  await activeClient?.end();
  activeClient = null;
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
  // On Windows postgres can still hold the directory for a moment after the
  // kill; retrying on EBUSY/EPERM keeps a passing run from failing its teardown.
  await fs.rm(DATA_DIR, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
});

describe('before the deletion (the positive control)', () => {
  test("the second gym's member list shows its athlete with GONE's id", async () => {
    expect((await listOrganizationMembers(OTHER_ORG)).map((member) => member.account_id)).toContain(OTHER_GONE_ACCOUNT);
  });

  test('the member list shows both athletes, and the coach who was once AGED', async () => {
    expect(await memberIds()).toEqual(expect.arrayContaining([GONE_ACCOUNT, LIVE_ACCOUNT, EX_ATHLETE_COACH]));
  });

  test("the guardian-link list shows the guardian's link to both children", async () => {
    expect(await guardianLinks()).toEqual(expect.arrayContaining([`${GUARDIAN}:${GONE}`, `${GUARDIAN}:${LIVE}`]));
  });

  test("the curator queue shows GONE's document, LIVE's and the gym-wide one", async () => {
    expect(await curatorDocuments()).toEqual(expect.arrayContaining([DOC_GONE, DOC_LIVE, DOC_GYM_WIDE]));
  });
});

describe('after deleteAthleteRecord(GONE)', () => {
  beforeAll(async () => {
    await deleteAthleteRecord({ accountId: ADMIN, role: 'organization_admin', organizationId: ORG }, GONE, 'Family moved away');
    await deleteAthleteRecord({ accountId: ADMIN, role: 'organization_admin', organizationId: ORG }, AGED, 'Now coaches');
    const marked = await activeClient!.query<{ deleted_at: string | null }>(
      `select deleted_at::text as deleted_at from pilot.athletes where organization_id = $1 and athlete_id = $2`,
      [ORG, GONE],
    );
    expect(marked.rows[0].deleted_at).not.toBeNull();
  });

  test("the member list drops GONE's login and keeps LIVE's and the ex-athlete coach", async () => {
    const shown = await memberIds();
    expect(shown).not.toContain(GONE_ACCOUNT);
    expect(shown).toEqual(expect.arrayContaining([LIVE_ACCOUNT, EX_ATHLETE_COACH, GUARDIAN, ADMIN]));
  });

  test("an athlete login left open is still dropped: the athlete record's own mark decides", async () => {
    await activeClient!.query(`update pilot.accounts set deleted_at = null where account_id = $1`, [GONE_ACCOUNT]);
    try {
      expect(await memberIds()).not.toContain(GONE_ACCOUNT);
    } finally {
      await activeClient!.query(`update pilot.accounts set deleted_at = now() where account_id = $1`, [GONE_ACCOUNT]);
    }
  });

  test("a live athlete whose login alone is marked deleted is dropped too: the login's own mark decides", async () => {
    await activeClient!.query(`update pilot.accounts set deleted_at = now() where account_id = $1`, [LIVE_ACCOUNT]);
    try {
      expect(await memberIds()).not.toContain(LIVE_ACCOUNT);
    } finally {
      await activeClient!.query(`update pilot.accounts set deleted_at = null where account_id = $1`, [LIVE_ACCOUNT]);
    }
  });

  test("the second gym's member list keeps its own live athlete with GONE's id", async () => {
    const shown = (await listOrganizationMembers(OTHER_ORG)).map((member) => member.account_id);
    expect(shown).toContain(OTHER_GONE_ACCOUNT);
  });

  test("the guardian-link list drops the link to GONE and keeps the link to LIVE", async () => {
    const shown = await guardianLinks();
    expect(shown).not.toContain(`${GUARDIAN}:${GONE}`);
    expect(shown).toEqual(expect.arrayContaining([`${GUARDIAN}:${LIVE}`, `${GUARDIAN_LIVE}:${LIVE}`]));
  });

  test("the curator queue drops GONE's document and keeps LIVE's and the gym-wide one", async () => {
    const shown = await curatorDocuments();
    expect(shown).not.toContain(DOC_GONE);
    expect(shown).toEqual(expect.arrayContaining([DOC_LIVE, DOC_GYM_WIDE]));
  });

  test("removeGuardianLink refuses to remove the guardian's one LIVE link: GONE's link does not count", async () => {
    await expect(
      removeGuardianLink({ organizationId: ORG, accountId: GUARDIAN, athleteId: LIVE }),
    ).rejects.toThrow(/only athlete this guardian is linked to/);
    expect(await guardianLinks()).toContain(`${GUARDIAN}:${LIVE}`);
  });

  test('removeGuardianLink does not offer the link to GONE', async () => {
    await expect(
      removeGuardianLink({ organizationId: ORG, accountId: GUARDIAN, athleteId: GONE }),
    ).rejects.toThrow(/not linked to this guardian/);
  });

  test('a guardian with two live links can still have one removed (the refusal is not over-broad)', async () => {
    await expect(
      removeGuardianLink({ organizationId: ORG, accountId: GUARDIAN_LIVE, athleteId: LIVE_TWO }),
    ).resolves.toEqual({ parentId: GUARDIAN_LIVE_PARENT, athleteId: LIVE_TWO });
  });
});
