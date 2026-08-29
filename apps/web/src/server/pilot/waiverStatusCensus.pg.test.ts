// Real PostgreSQL-backed test for the pilot.waivers.status census.
//
// The census exists to answer, before anyone proposes a CHECK constraint for
// this column, the question the repository cannot answer: which values does
// production actually hold. Two of the four writers store a literal; the two
// intake routes store whatever string a caller sent. So the answer is a fact
// about a database, and the owner decided on 2026-08-29 (D-7) to measure
// before constraining.
//
// A CENSUS CAN ONLY BE TRUSTED IF IT HAS BEEN SHOWN TO FIND THINGS, so every
// case here plants known values and asserts the census reports exactly those.
// The interesting population is not the obviously-wrong value: it is ' Signed
// ', which EVERY READER ACCEPTS and a byte-exact CHECK would REFUSE. That row
// is the one an unmeasured constraint takes a deploy down over, and it is the
// reason this script exists rather than a constraint.
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

import { WAIVER_STATUSES as READER_WAIVER_STATUSES } from './waiverCompliance';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-waiver-status-census-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const CENSUS_PATH = path.resolve(__dirname, '../../../scripts/pilot-check-waiver-statuses.mjs');

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs. Building the import through `new Function` keeps a
// real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-waiver-census';
const OTHER_ORG = 'org-waiver-census-two';
const COACH = 'coach@example.test';
const ATHLETE = 'ath-census';
const OTHER_ATHLETE = 'ath-census-two';
const GUARDIAN_ACCOUNT = 'guardian@example.test';
const PARENT_ID = 'par-census';

interface CensusValue {
  status: string;
  rowCount: number;
  waiverTypeCount: number;
  waiverTypes: string[];
  classification: 'EXACT' | 'NORMALISES' | 'UNRECOGNISED';
  isSynthetic: boolean;
}

interface CensusReport {
  checkConstraints: Array<{ conname: string; definition: string }>;
  parentColumnPresent: boolean;
  totalRowCount: number;
  values: CensusValue[];
  valuesTruncated: boolean;
  byOrganization: Array<{
    organization_id: string;
    status: string;
    waiver_type: string;
    row_count: number;
  }>;
  byOrganizationTruncated: boolean;
  guardianGate: {
    applicable: true;
    unreadable: Array<{ organization_id: string; status: string; row_count: number }>;
    unreadableRowCount: number;
    truncated: boolean;
  } | null;
  nonExactRowCount: number;
  unrecognisedRowCount: number;
  syntheticRowCount: number;
}

interface CensusModule {
  censusWaiverStatuses: (client: Client) => Promise<CensusReport>;
  WAIVER_STATUSES: string[];
  SYNTHETIC_STATUS: string;
  CONSENT_STATUSES_THE_VIDEO_GATE_UNDERSTANDS: string[];
}

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let census: CensusModule;
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

async function emptyDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

/** An organization, a coach, an athlete -- the minimum a waiver row needs. */
async function seedRoster(client: Client, organizationId: string, athleteId: string) {
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active')`,
    [organizationId],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft')
     on conflict (account_id) do nothing`,
    [COACH, organizationId],
  );
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Census Child', '2012-04-03', 'youth-60', 'active', 'Guardian', true, $3, now(), now())`,
    [organizationId, athleteId, COACH],
  );
}

/** The full production schema: base file plus every migration, by fixpoint. */
async function fullSchemaDatabase(name: string): Promise<Client> {
  const client = await emptyDatabase(name);
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  await seedRoster(client, ORG, ATHLETE);
  await seedRoster(client, OTHER_ORG, OTHER_ATHLETE);
  return client;
}

async function insertWaiver(
  client: Client,
  status: string,
  options: {
    organizationId?: string;
    athleteId?: string;
    waiverType?: string;
    parentId?: string | null;
  } = {},
) {
  const organizationId = options.organizationId ?? ORG;
  const athleteId = options.athleteId ?? ATHLETE;
  await client.query(
    `insert into pilot.waivers
       (organization_id, waiver_id, athlete_id, waiver_type, signed_by_name, signed_by_role,
        signed_at, consent_version, status, parent_id)
     values ($1, gen_random_uuid(), $2, $3, 'Guardian', 'parent', now(), 'v1', $4, $5)`,
    [organizationId, athleteId, options.waiverType ?? 'general', status, options.parentId ?? null],
  );
}

/** A guardian a parent_id-bearing waiver can legally point at. */
async function seedGuardian(client: Client) {
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'parent', $2, 'microsoft')`,
    [GUARDIAN_ACCOUNT, ORG],
  );
  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
     values ($1, $2, $3, 'Census Guardian')`,
    [ORG, PARENT_ID, GUARDIAN_ACCOUNT],
  );
}

function valueFor(report: CensusReport, status: string): CensusValue | undefined {
  return report.values.find((value) => value.status === status);
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

  census = (await nativeDynamicImport(pathToFileURL(CENSUS_PATH).href)) as unknown as CensusModule;
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

describe('the vocabulary it measures against', () => {
  /* THE DRIFT GUARD THE SCRIPT'S HEADER PROMISES. pilot-check-waiver-statuses
     .mjs cannot import waiverCompliance.ts -- it is a plain .mjs script and
     that is a TypeScript module in the Next.js build graph -- so it carries a
     copy of WAIVER_STATUSES. A copy nobody pins is a copy that drifts, and a
     census measuring against a stale vocabulary would report the new value as
     UNRECOGNISED and be believed. This is the only thing standing between
     those two lists. */
  it('is byte-identical to the list the readers actually use', () => {
    expect(census.WAIVER_STATUSES).toEqual([...READER_WAIVER_STATUSES]);
  });

  it('holds the synthetic-absence value separately, and inside the vocabulary', () => {
    // Both halves matter. 'missing' must be IN the vocabulary (readers produce
    // it) and must be NAMED (a stored row saying it is a different claim from
    // an absent row, and is reported on its own line).
    expect(census.WAIVER_STATUSES).toContain(census.SYNTHETIC_STATUS);
    expect(census.SYNTHETIC_STATUS).toBe('missing');
  });
});

describe('what the census finds', () => {
  let client: Client;

  beforeAll(async () => {
    client = await fullSchemaDatabase('ppbf_test_waiver_census_findings');
    await seedGuardian(client);

    // Byte-exact, on two waiver types, so the per-value type list is exercised.
    await insertWaiver(client, 'signed');
    await insertWaiver(client, 'signed', { waiverType: 'travel' });
    await insertWaiver(client, 'withdrawn');

    // THE ROW THIS SCRIPT EXISTS FOR: every reader accepts it, a byte-exact
    // CHECK refuses it.
    await insertWaiver(client, ' Signed ');
    await insertWaiver(client, 'SIGNED', { organizationId: OTHER_ORG, athleteId: OTHER_ATHLETE });

    // Already failing closed everywhere today.
    await insertWaiver(client, 'pending');

    // A stored row carrying the value readers synthesise for absence.
    await insertWaiver(client, 'missing');
  });

  afterAll(async () => {
    await client.end();
  });

  it('reports every distinct value with its count, whitespace and case intact', async () => {
    const report = await census.censusWaiverStatuses(client);

    expect(report.totalRowCount).toBe(7);
    expect(valueFor(report, 'signed')).toMatchObject({ rowCount: 2, classification: 'EXACT' });
    expect(valueFor(report, 'withdrawn')).toMatchObject({ rowCount: 1, classification: 'EXACT' });
    // Byte-exact keys: ' Signed ' and 'SIGNED' are DIFFERENT findings, and a
    // census that folded them would hide which one is in the database.
    expect(valueFor(report, ' Signed ')).toMatchObject({ rowCount: 1, classification: 'NORMALISES' });
    expect(valueFor(report, 'SIGNED')).toMatchObject({ rowCount: 1, classification: 'NORMALISES' });
    expect(valueFor(report, 'pending')).toMatchObject({ rowCount: 1, classification: 'UNRECOGNISED' });
    expect(report.valuesTruncated).toBe(false);
  });

  it('names the waiver types a value appears on', async () => {
    const report = await census.censusWaiverStatuses(client);
    const signed = valueFor(report, 'signed');
    expect(signed?.waiverTypeCount).toBe(2);
    expect([...(signed?.waiverTypes ?? [])].sort()).toEqual(['general', 'travel']);
  });

  it('counts exactly the rows a byte-exact CHECK would refuse', async () => {
    const report = await census.censusWaiverStatuses(client);

    // ' Signed ', 'SIGNED', 'pending'. NOT 'missing' -- it is byte-exact in
    // the vocabulary, so a CHECK over that vocabulary accepts it, and saying
    // otherwise would misreport what the constraint would do.
    expect(report.nonExactRowCount).toBe(3);
    expect(report.unrecognisedRowCount).toBe(1);
  });

  it('reports a stored synthetic-absence row on its own, not folded into the clean count', async () => {
    const report = await census.censusWaiverStatuses(client);
    expect(report.syntheticRowCount).toBe(1);
    expect(valueFor(report, 'missing')).toMatchObject({ isSynthetic: true, classification: 'EXACT' });
    // The two other EXACT values are not synthetic, so this flag is a real
    // discriminator rather than something set on everything.
    expect(valueFor(report, 'signed')?.isSynthetic).toBe(false);
  });

  it('says whose rows they are, per organization and waiver type', async () => {
    const report = await census.censusWaiverStatuses(client);

    expect(report.byOrganization).toEqual(
      expect.arrayContaining([
        { organization_id: ORG, status: ' Signed ', waiver_type: 'general', row_count: 1 },
        { organization_id: ORG, status: 'pending', waiver_type: 'general', row_count: 1 },
        { organization_id: OTHER_ORG, status: 'SIGNED', waiver_type: 'general', row_count: 1 },
      ]),
    );
    // The byte-exact rows are absent -- this list is the actionable population
    // and nothing else.
    expect(report.byOrganization.map((row) => row.status)).not.toContain('signed');
    expect(report.byOrganization.map((row) => row.status)).not.toContain('missing');
    expect(report.byOrganizationTruncated).toBe(false);
  });

  it('reports no CHECK constraint on a column that has none', async () => {
    const report = await census.censusWaiverStatuses(client);
    expect(report.checkConstraints).toEqual([]);
  });
});

describe('the guardian-scoped rows the video gate already refuses', () => {
  let client: Client;

  beforeAll(async () => {
    client = await fullSchemaDatabase('ppbf_test_waiver_census_guardian');
    await seedGuardian(client);

    await insertWaiver(client, 'signed', { waiverType: 'photo_media', parentId: PARENT_ID });
    await insertWaiver(client, 'withdrawn', { waiverType: 'photo_media', parentId: PARENT_ID });
    // Accepted by the gate: it trims and lowercases before comparing.
    await insertWaiver(client, ' Signed ', { waiverType: 'photo_media', parentId: PARENT_ID });
    // Refused by the gate with 409 GUARDIAN_CONSENT_UNREADABLE.
    await insertWaiver(client, 'pending', { waiverType: 'photo_media', parentId: PARENT_ID });
    // Not guardian-scoped, so invisible to that gate however odd it looks.
    await insertWaiver(client, 'pending', { waiverType: 'general', parentId: null });
  });

  afterAll(async () => {
    await client.end();
  });

  it('counts only the parent-scoped rows the gate cannot read', async () => {
    const report = await census.censusWaiverStatuses(client);

    expect(report.parentColumnPresent).toBe(true);
    expect(report.guardianGate?.unreadableRowCount).toBe(1);
    expect(report.guardianGate?.unreadable).toEqual([
      { organization_id: ORG, status: 'pending', row_count: 1 },
    ]);
  });

  it('does not count a guardian row the gate accepts after trimming', async () => {
    /* The asymmetry is the point. ' Signed ' is refused by a byte-exact CHECK
       and accepted by the gate, so it must appear in one count and not the
       other. A census that reported the same number twice would be telling
       the owner these are one question when they are two. */
    const report = await census.censusWaiverStatuses(client);
    const gateStatuses = (report.guardianGate?.unreadable ?? []).map((row) => row.status);
    expect(gateStatuses).not.toContain(' Signed ');
    expect(report.nonExactRowCount).toBeGreaterThan(report.guardianGate?.unreadableRowCount ?? 0);
  });
});

describe('a clean database', () => {
  it('reports zero refusable rows when every value is byte-exact', async () => {
    const client = await fullSchemaDatabase('ppbf_test_waiver_census_clean');
    try {
      await insertWaiver(client, 'signed');
      await insertWaiver(client, 'declined', { waiverType: 'travel' });

      const report = await census.censusWaiverStatuses(client);
      expect(report.totalRowCount).toBe(2);
      expect(report.nonExactRowCount).toBe(0);
      expect(report.unrecognisedRowCount).toBe(0);
      expect(report.syntheticRowCount).toBe(0);
      expect(report.byOrganization).toEqual([]);
      expect(report.guardianGate?.unreadableRowCount).toBe(0);
    } finally {
      await client.end();
    }
  });
});

describe('databases it cannot describe', () => {
  it('refuses a database with no pilot.waivers table rather than reporting it clean', async () => {
    /* THE ONE OUTPUT A CENSUS MUST NEVER PRODUCE is a false all-clear. An
       unmigrated database would otherwise answer "0 rows, every value
       byte-exact" -- which reads as a green light to add the constraint. */
    const client = await emptyDatabase('ppbf_test_waiver_census_no_table');
    try {
      await expect(census.censusWaiverStatuses(client)).rejects.toThrow('WAIVER_TABLE_ABSENT');
    } finally {
      await client.end();
    }
  });

  it('reports the guardian gate as not applicable when parent_id does not exist', async () => {
    /* Base schema only: pilot.waivers exists, parent_id does not, because the
       guardian-media-consent migration has not run here. Counting zero
       unreadable guardian rows would be true and misleading -- there are no
       guardian-scoped rows to be unreadable. The distinction is reported. */
    const client = await emptyDatabase('ppbf_test_waiver_census_no_parent_column');
    try {
      const fs = await import('node:fs/promises');
      await client.query(
        await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'),
      );
      await seedRoster(client, ORG, ATHLETE);
      await client.query(
        `insert into pilot.waivers
           (organization_id, waiver_id, athlete_id, waiver_type, signed_by_name, signed_by_role,
            signed_at, consent_version, status)
         values ($1, gen_random_uuid(), $2, 'general', 'Guardian', 'parent', now(), 'v1', 'pending')`,
        [ORG, ATHLETE],
      );

      const report = await census.censusWaiverStatuses(client);
      expect(report.parentColumnPresent).toBe(false);
      expect(report.guardianGate).toBeNull();
      // The rest of the census still works on such a database.
      expect(report.nonExactRowCount).toBe(1);
    } finally {
      await client.end();
    }
  });
});

describe('it cannot write', () => {
  /* THE SAFETY CLAIM, MADE FALSIFIABLE. The script's header says it is safe to
     run against production because there is no write path in the file. That
     sentence is worth nothing on its own -- somebody adds an `update` for a
     good reason and the sentence stays there being wrong.

     So the census is driven through a client that records every statement it
     issues. Adding any write to censusWaiverStatuses fails this test. The
     READ ONLY transaction is a second, independent line: Postgres itself
     raises 25006 on a write inside it. This test watches the first line,
     which is the one a reader of the file would otherwise have to take on
     trust. */
  it('issues nothing but a read-only transaction and selects', async () => {
    const client = await fullSchemaDatabase('ppbf_test_waiver_census_readonly');
    try {
      await insertWaiver(client, 'pending');

      const statements: string[] = [];
      const originalQuery = client.query.bind(client);
      const recording = new Proxy(client, {
        get(target, property, receiver) {
          if (property === 'query') {
            return (...args: unknown[]) => {
              const [first] = args;
              statements.push(typeof first === 'string' ? first : String((first as { text?: string })?.text));
              return (originalQuery as (...a: unknown[]) => unknown)(...args);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }) as Client;

      await census.censusWaiverStatuses(recording);

      expect(statements.length).toBeGreaterThan(0);
      expect(statements[0].trim()).toBe('BEGIN TRANSACTION READ ONLY');
      for (const statement of statements) {
        const verb = statement.trim().split(/\s+/)[0].toUpperCase();
        expect(['BEGIN', 'COMMIT', 'ROLLBACK', 'SELECT']).toContain(verb);
      }
    } finally {
      await client.end();
    }
  });
});
