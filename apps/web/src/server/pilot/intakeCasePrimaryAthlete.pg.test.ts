// Real PostgreSQL-backed proof for the build-list row "Intake cases never get
// primary_athlete_id written" (OD-2026-09-29-002 item 4). Three parts, one
// database:
//   WRITER    bindIntakeDocumentsToOwner, the call promotion makes on its
//             transaction, sets pilot.intake_cases.primary_athlete_id to the
//             athlete it binds the documents to -- and a rolled-back
//             promotion leaves it unset.
//   BACKFILL  the intake-case-primary-athlete migration, through its own
//             runner, sets the column on cases whose documents name exactly
//             one athlete; leaves pending, two-athlete and already-set cases
//             alone; changes nothing on a second run; and the runner refuses
//             a migration that leaves a one-owner case behind.
//   ACCESS    the review queue (listReviewQueue -> getShadowReviewProjection)
//             scopes a coach by the column, keeps unattributed cases, and
//             drops a deleted athlete's case from the list and its count
//             (OD-2026-09-29-002 item 10, "10 C"). The deletion is the real
//             deleteAthleteRecord. Another gym's athlete with the same id is
//             never deleted and stays in its gym's queue.
//
// Every "after" is preceded by its "before" in the same database, so a reader
// that showed nothing could not pass.
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

import type { PilotRole } from './contracts';
import { deleteAthleteRecord } from './dataDeletion';
import { withTransaction } from './db';
import { assertActorCanAccessIntakeCase, bindIntakeDocumentsToOwner, listReviewQueue } from './intake';
import { getShadowReviewProjection } from './shadowReadModels';

jest.setTimeout(600_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-intake-case-primary-athlete-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-intake-case-primary-athlete-migration.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_PATH = path.join(INFRA_DIR, 'pilot_slice_postgres_intake_case_primary_athlete_migration.sql');
const DATABASE = 'intake_case_primary_athlete';

const ORG = 'org-icpa';
/** A second gym whose athlete carries GONE's id and is never deleted. */
const OTHER_ORG = 'org-icpa-other';

const ADMIN = 'acct-icpa-admin';
const OTHER_ADMIN = 'acct-icpa-other-admin';
/** Coach of record for GONE and LIVE. */
const COACH = 'acct-icpa-coach';
/** Coach of record for ELSE only. */
const ELSE_COACH = 'acct-icpa-else-coach';
const UPLOADER = 'acct-icpa-uploader';
/** Guardian of LIVE only. */
const GUARDIAN_LIVE = 'acct-icpa-guardian-live';
/** Guardian of GONE only. */
const GUARDIAN_GONE = 'acct-icpa-guardian-gone';

/** Deleted in the ACCESS part. */
const GONE = 'ATH-ICPA-GONE';
const LIVE = 'ATH-ICPA-LIVE';
const ELSE = 'ATH-ICPA-ELSE';

/** Cases. UUIDs, as the column type requires. */
const C = {
  pending: '00000000-0000-4000-8000-000000000001',
  gone: '00000000-0000-4000-8000-000000000002',
  live: '00000000-0000-4000-8000-000000000003',
  else: '00000000-0000-4000-8000-000000000004',
  two: '00000000-0000-4000-8000-000000000005',
  twoWithGone: '00000000-0000-4000-8000-00000000000c',
  mismatch: '00000000-0000-4000-8000-00000000000d',
  filedForGone: '00000000-0000-4000-8000-00000000000e',
  alreadySet: '00000000-0000-4000-8000-000000000006',
  otherGym: '00000000-0000-4000-8000-000000000007',
  writer: '00000000-0000-4000-8000-000000000008',
  rolledBack: '00000000-0000-4000-8000-000000000009',
  nonAthleteOwner: '00000000-0000-4000-8000-00000000000a',
  leftBehind: '00000000-0000-4000-8000-00000000000b',
} as const;

const OLD_UPDATED_AT = '2026-09-01 12:00:00+00';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<{ casesUpdated: number }>;
let migrationSql: string;

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

let documentCounter = 0;

/** A case as the schema holds it, with one document per owner (null = unbound). */
async function seedCase(org: string, caseId: string, owners: Array<string | null>, primaryAthleteId: string | null = null) {
  await activeClient!.query(
    `insert into pilot.intake_cases
       (organization_id, intake_case_id, status, primary_athlete_id, summary, submitted_by_account_id, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [org, caseId, owners.some((o) => o !== null) ? 'promoted' : 'pending_review', primaryAthleteId,
      `case ${caseId}`, org === ORG ? UPLOADER : OTHER_ADMIN, OLD_UPDATED_AT],
  );
  for (const owner of owners) {
    documentCounter += 1;
    await activeClient!.query(
      `insert into pilot.intake_documents
         (organization_id, intake_document_id, intake_case_id, document_type, file_name, blob_path,
          classification, review_status, owner_entity_type, owner_entity_id)
       values ($1, $2, $3, 'athlete_registration', $4, $5, 'restricted', $6, $7, $8)`,
      [org, `10000000-0000-4000-8000-${String(documentCounter).padStart(12, '0')}`, caseId,
        `registration-${documentCounter}.pdf`, `intake/${caseId}/${documentCounter}.pdf`,
        owner ? 'promoted' : 'pending_review', owner ? 'athlete' : null, owner],
    );
  }
}

async function seed(client: Client): Promise<void> {
  const q = (sql: string, params: unknown[] = []) => client.query(sql, params);

  for (const org of [ORG, OTHER_ORG]) {
    await q(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [org]);
  }
  for (const [account, role, org] of [
    [ADMIN, 'organization_admin', ORG],
    [OTHER_ADMIN, 'organization_admin', OTHER_ORG],
    [COACH, 'coach', ORG],
    [ELSE_COACH, 'coach', ORG],
    [UPLOADER, 'coach', ORG],
    [GUARDIAN_LIVE, 'parent', ORG],
    [GUARDIAN_GONE, 'parent', ORG],
  ] as const) {
    await q(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag, login_email)
       values ($1, $2, $3, 'microsoft', true, $1 || '@gym.test')`,
      [account, role, org],
    );
    await q(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ($1, $2, $3, true)`,
      [account, org, role],
    );
  }
  for (const [org, athlete, coach] of [
    [ORG, GONE, COACH],
    [ORG, LIVE, COACH],
    [ORG, ELSE, ELSE_COACH],
    [OTHER_ORG, GONE, OTHER_ADMIN],
  ] as const) {
    await q(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, $2, '2011-05-06', 'fly', 'active', 'contact', true, $3, now() - interval '1 year', now())`,
      [org, athlete, coach],
    );
  }

  for (const [account, parent, athlete] of [
    [GUARDIAN_LIVE, 'PAR-ICPA-LIVE', LIVE],
    [GUARDIAN_GONE, 'PAR-ICPA-GONE', GONE],
  ] as const) {
    await q(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name) values ($1, $2, $3, $3)`,
      [ORG, parent, account],
    );
    await q(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, $2, $3, 'parent')`,
      [ORG, parent, athlete],
    );
  }

  // The state production is in before the migration: every column NULL.
  await seedCase(ORG, C.pending, [null, null]);
  await seedCase(ORG, C.gone, [GONE, GONE]);
  await seedCase(ORG, C.live, [LIVE]);
  await seedCase(ORG, C.else, [ELSE]);
  await seedCase(ORG, C.two, [LIVE, ELSE]);
  await seedCase(ORG, C.twoWithGone, [GONE, LIVE]);
  await seedCase(ORG, C.alreadySet, [LIVE], LIVE);
  // Filed naming GONE, documents not yet bound: createIntakeCase accepts
  // primaryAthleteId. Only the column names the athlete here.
  await seedCase(ORG, C.filedForGone, [null], GONE);
  await seedCase(OTHER_ORG, C.otherGym, [GONE]);
}

async function primaryOf(org: string, caseId: string): Promise<string | null> {
  const row = await activeClient!.query<{ primary_athlete_id: string | null }>(
    `select primary_athlete_id from pilot.intake_cases where organization_id = $1 and intake_case_id = $2`,
    [org, caseId],
  );
  if (row.rows.length !== 1) throw new Error(`test bug: case ${caseId} not found in ${org}`);
  return row.rows[0].primary_athlete_id;
}

async function queueFor(org: string, accountId: string, role: PilotRole): Promise<string[]> {
  const queue = await listReviewQueue(org, { actorAccountId: accountId, actorRole: role });
  return queue.map((item) => item.intake_case_id).sort();
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
  const runner = await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href);
  applyMigrationTransaction = runner.applyMigrationTransaction as typeof applyMigrationTransaction;
  migrationSql = await fs.readFile(MIGRATION_PATH, 'utf8');

  await adminQuery(`create database ${DATABASE}`);
  activeClient = new Client({ connectionString: connectionStringFor(DATABASE) });
  await activeClient.connect();
  // The full schema runs this migration too, on an empty database: a no-op.
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

describe('BACKFILL: the intake-case-primary-athlete migration, through its runner', () => {
  test('before it runs, every promoted case has a NULL column (the positive control)', async () => {
    for (const caseId of [C.gone, C.live, C.else, C.two]) {
      expect(await primaryOf(ORG, caseId)).toBeNull();
    }
    expect(await primaryOf(OTHER_ORG, C.otherGym)).toBeNull();
  });

  test('the runner refuses a migration that leaves a one-owner case behind, and rolls back what it did write', async () => {
    const partial = `update pilot.intake_cases set primary_athlete_id = '${LIVE}'
                     where organization_id = '${ORG}' and intake_case_id = '${C.live}'`;
    await expect(applyMigrationTransaction(activeClient!, partial)).rejects.toThrow(
      /INTAKE_CASE_PRIMARY_ATHLETE_NOT_READY: 3 case/,
    );
    expect(await primaryOf(ORG, C.live)).toBeNull();
  });

  test('the runner refuses a column naming a different athlete than the documents, and the migration never overwrites it', async () => {
    // No code produces this state; it stands in for a migration that wrote
    // the wrong value.
    await seedCase(ORG, C.mismatch, [ELSE], LIVE);
    try {
      await expect(applyMigrationTransaction(activeClient!, migrationSql)).rejects.toThrow(
        /INTAKE_CASE_PRIMARY_ATHLETE_NOT_READY: 1 case/,
      );
      expect(await primaryOf(ORG, C.mismatch)).toBe(LIVE);
      expect(await primaryOf(ORG, C.gone)).toBeNull();
    } finally {
      await activeClient!.query(`delete from pilot.intake_cases where organization_id = $1 and intake_case_id = $2`, [ORG, C.mismatch]);
    }
  });

  test('it sets each one-athlete case to that athlete, in its own gym', async () => {
    const outcome = await applyMigrationTransaction(activeClient!, migrationSql);
    expect(outcome.casesUpdated).toBe(4);
    expect(await primaryOf(ORG, C.gone)).toBe(GONE);
    expect(await primaryOf(ORG, C.live)).toBe(LIVE);
    expect(await primaryOf(ORG, C.else)).toBe(ELSE);
    expect(await primaryOf(OTHER_ORG, C.otherGym)).toBe(GONE);
  });

  test('pending and two-athlete cases are left NULL, and an already-set case as it was', async () => {
    expect(await primaryOf(ORG, C.pending)).toBeNull();
    expect(await primaryOf(ORG, C.two)).toBeNull();
    expect(await primaryOf(ORG, C.twoWithGone)).toBeNull();
    expect(await primaryOf(ORG, C.alreadySet)).toBe(LIVE);
  });

  test('updated_at is untouched, so the queue order does not change', async () => {
    const rows = await activeClient!.query<{ moved: number }>(
      `select count(*)::int as moved from pilot.intake_cases where updated_at <> $1::timestamptz`,
      [OLD_UPDATED_AT],
    );
    expect(rows.rows[0].moved).toBe(0);
  });

  test('a second run changes no row', async () => {
    const before = await activeClient!.query(`select organization_id, intake_case_id, primary_athlete_id from pilot.intake_cases order by 1, 2`);
    const outcome = await applyMigrationTransaction(activeClient!, migrationSql);
    expect(outcome.casesUpdated).toBe(0);
    const after = await activeClient!.query(`select organization_id, intake_case_id, primary_athlete_id from pilot.intake_cases order by 1, 2`);
    expect(after.rows).toEqual(before.rows);
  });

  test('a case promoted later with the column still empty is picked up by a rerun', async () => {
    await seedCase(ORG, C.leftBehind, [LIVE]);
    await expect(applyMigrationTransaction(activeClient!, 'select 1')).rejects.toThrow(
      /INTAKE_CASE_PRIMARY_ATHLETE_NOT_READY: 1 case/,
    );
    expect((await applyMigrationTransaction(activeClient!, migrationSql)).casesUpdated).toBe(1);
    expect(await primaryOf(ORG, C.leftBehind)).toBe(LIVE);
    await activeClient!.query(`delete from pilot.intake_cases where organization_id = $1 and intake_case_id = $2`, [ORG, C.leftBehind]);
  });
});

describe('WRITER: bindIntakeDocumentsToOwner, as promotion calls it', () => {
  test('binding the documents to an athlete sets the case column on the same transaction', async () => {
    await seedCase(ORG, C.writer, [null, null]);
    expect(await primaryOf(ORG, C.writer)).toBeNull();
    await withTransaction(async (client) => {
      await bindIntakeDocumentsToOwner(
        { organizationId: ORG, intakeCaseId: C.writer, ownerEntityType: 'athlete', ownerEntityId: LIVE },
        client,
      );
    });
    expect(await primaryOf(ORG, C.writer)).toBe(LIVE);
    const owners = await activeClient!.query(
      `select distinct owner_entity_type, owner_entity_id from pilot.intake_documents where organization_id = $1 and intake_case_id = $2`,
      [ORG, C.writer],
    );
    expect(owners.rows).toEqual([{ owner_entity_type: 'athlete', owner_entity_id: LIVE }]);
  });

  test('a re-promotion to another athlete moves the column with the documents', async () => {
    await withTransaction(async (client) => {
      await bindIntakeDocumentsToOwner(
        { organizationId: ORG, intakeCaseId: C.writer, ownerEntityType: 'athlete', ownerEntityId: ELSE },
        client,
      );
    });
    expect(await primaryOf(ORG, C.writer)).toBe(ELSE);
    await activeClient!.query(`delete from pilot.intake_cases where organization_id = $1 and intake_case_id = $2`, [ORG, C.writer]);
  });

  test('a promotion that rolls back after the bind leaves the column NULL', async () => {
    await seedCase(ORG, C.rolledBack, [null]);
    await expect(withTransaction(async (client) => {
      await bindIntakeDocumentsToOwner(
        { organizationId: ORG, intakeCaseId: C.rolledBack, ownerEntityType: 'athlete', ownerEntityId: LIVE },
        client,
      );
      throw new Error('a later promotion write failed');
    })).rejects.toThrow('a later promotion write failed');
    expect(await primaryOf(ORG, C.rolledBack)).toBeNull();
    await activeClient!.query(`delete from pilot.intake_cases where organization_id = $1 and intake_case_id = $2`, [ORG, C.rolledBack]);
  });

  test('an owner that is not an athlete does not set the column', async () => {
    await seedCase(ORG, C.nonAthleteOwner, [null]);
    await withTransaction(async (client) => {
      await bindIntakeDocumentsToOwner(
        { organizationId: ORG, intakeCaseId: C.nonAthleteOwner, ownerEntityType: 'guardian', ownerEntityId: 'PAR-ICPA-1' },
        client,
      );
    });
    expect(await primaryOf(ORG, C.nonAthleteOwner)).toBeNull();
    await activeClient!.query(`delete from pilot.intake_cases where organization_id = $1 and intake_case_id = $2`, [ORG, C.nonAthleteOwner]);
  });
});

describe('ACCESS: the review queue reads the column', () => {
  // After the backfill: gone=GONE, live=LIVE, else=ELSE, alreadySet=LIVE,
  // filedForGone=GONE (documents unbound); pending, two and twoWithGone are NULL.
  const unattributed = [C.pending, C.two, C.twoWithGone];

  async function totalFor(accountId: string, role: PilotRole): Promise<number> {
    return (await getShadowReviewProjection(
      { organizationId: ORG, actorAccountId: accountId, actorRole: role },
      { limit: 200 },
    )).total;
  }

  test('before the deletion: the admin sees every case in the gym, and the count agrees (the positive control)', async () => {
    expect(await queueFor(ORG, ADMIN, 'organization_admin')).toEqual(
      [C.pending, C.gone, C.live, C.else, C.two, C.twoWithGone, C.alreadySet, C.filedForGone].sort(),
    );
    expect(await totalFor(ADMIN, 'organization_admin')).toBe(8);
    expect(await queueFor(OTHER_ORG, OTHER_ADMIN, 'organization_admin')).toEqual([C.otherGym]);
  });

  test("a coach sees their own athletes' cases and the unattributed ones, not another coach's", async () => {
    expect(await queueFor(ORG, COACH, 'coach')).toEqual([C.gone, C.live, C.alreadySet, C.filedForGone, ...unattributed].sort());
    expect(await totalFor(COACH, 'coach')).toBe(7);
    expect(await queueFor(ORG, ELSE_COACH, 'coach')).toEqual([C.else, ...unattributed].sort());
  });

  // Jason, 2026-10-05, asked in this lane: "A: keep (Recommended)" -- a
  // guardian (and the athlete) sees their own child's intake cases and case
  // detail. A guardian's queue lists their own child's cases and nothing
  // unattributed; before the column was written it was always empty.
  test("a guardian sees only their own child's cases", async () => {
    expect(await queueFor(ORG, GUARDIAN_LIVE, 'parent')).toEqual([C.live, C.alreadySet].sort());
    expect(await queueFor(ORG, GUARDIAN_GONE, 'parent')).toEqual([C.gone, C.filedForGone].sort());
  });

  test('a platform owner sees only the unattributed cases', async () => {
    expect(await queueFor(ORG, ADMIN, 'platform_owner')).toEqual([...unattributed].sort());
  });

  describe('after deleteAthleteRecord(GONE)', () => {
    beforeAll(async () => {
      await deleteAthleteRecord({ accountId: ADMIN, role: 'organization_admin', organizationId: ORG }, GONE, 'Family moved away');
      const marked = await activeClient!.query<{ deleted_at: string | null }>(
        `select deleted_at::text as deleted_at from pilot.athletes where organization_id = $1 and athlete_id = $2`,
        [ORG, GONE],
      );
      expect(marked.rows[0].deleted_at).not.toBeNull();
    });

    test("GONE's cases leave the admin's queue (named by the column, by the documents, or by both); the rest stay", async () => {
      expect(await queueFor(ORG, ADMIN, 'organization_admin')).toEqual(
        [C.pending, C.live, C.else, C.two, C.alreadySet].sort(),
      );
    });

    test('they leave the count too, so paging agrees with the list', async () => {
      expect(await totalFor(ADMIN, 'organization_admin')).toBe(5);
      expect(await totalFor(COACH, 'coach')).toBe(4);
    });

    test("GONE's coach and GONE's guardian no longer see them either", async () => {
      expect(await queueFor(ORG, COACH, 'coach')).toEqual([C.live, C.alreadySet, C.pending, C.two].sort());
      expect(await queueFor(ORG, GUARDIAN_GONE, 'parent')).toEqual([]);
    });

    test("opening GONE's case is refused, even for the admin; LIVE's opens", async () => {
      const admin = { accountId: ADMIN, role: 'organization_admin' as const, organizationId: ORG };
      await expect(assertActorCanAccessIntakeCase(admin, ORG, C.gone)).rejects.toThrow();
      expect((await assertActorCanAccessIntakeCase(admin, ORG, C.live)).subjectAthleteIds).toEqual([LIVE]);
    });

    test("the other gym's athlete with GONE's id keeps its case", async () => {
      expect(await queueFor(OTHER_ORG, OTHER_ADMIN, 'organization_admin')).toEqual([C.otherGym]);
    });
  });
});
