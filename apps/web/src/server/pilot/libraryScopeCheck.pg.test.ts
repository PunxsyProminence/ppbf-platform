// Real PostgreSQL coverage for the NON-CORPUS section of
// pilot-check-library-scope.mjs.
//
// The rest of that script counts, and counting is what left the last question
// unanswerable. A bulk approval takes every pending row in the organization it
// targets, so an uploaded document can become citable evidence without anyone
// deciding it should be -- and the approval run reports only PENDING rows, so a
// non-corpus row approved before the run is invisible in its output while its
// chunks still land in the totals. Closing that gap meant querying the database
// by hand.
//
// The section under test names those rows instead. What it must get right is
// entirely a matter of what a real query returns:
//
//   - the corpus/non-corpus split is a LIKE on an escaped underscore, and
//     `src\_%` versus `src_%` is the difference between excluding the corpus and
//     excluding almost everything, which no amount of reading catches reliably;
//   - the per-row document and chunk counts are scoped by (source, organization),
//     and a missing organization predicate inflates them the moment two gyms
//     hold a source id in common.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to staging or production: the script's
// run() -- which is what reads AZURE_POSTGRES_CONNECTION_STRING -- is never
// called, only the exported checkLibraryScope, against a client this suite owns.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-library-scope-check-pg-test-${process.pid}-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const CHECK_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/pilot-check-library-scope.mjs');

// The minimum set: the base schema creates the library tables and the capability
// map, the shadow-evidence migration adds the approval/verification columns the
// section reports, and the feeder-tracks migration adds the capability column
// the per-organization query reads.
const PREREQUISITE_FILES = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_shadow_evidence_migration.sql',
  'pilot_slice_postgres_capability_feeder_tracks_migration.sql',
];

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const GYM = 'org-gym-one';
const OTHER_GYM = 'org-gym-two';
const ADMIN = 'acct-admin-one';

interface NonCorpusRow {
  organization_id: string;
  source_id: string;
  title: string;
  source_type: string;
  approval_state: string;
  verification_state: string;
  approved_by_account_id: string | null;
  documents: number;
  chunks: number;
}

const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-capability-feeder-tracks-migration.mjs',
);

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let prerequisiteSchemaSql: string[];
let checkLibraryScope: (client: Client) => Promise<{ nonCorpus: NonCorpusRow[] }>;
let client: Client;

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

async function seedSource(
  target: Client,
  organizationId: string,
  sourceId: string,
  {
    title = `Title ${sourceId}`,
    sourceType = 'peer_reviewed',
    approved = false,
    documents = 1,
    chunks = 1,
  } = {},
): Promise<void> {
  await target.query(
    `insert into pilot.shadow_library_sources
       (source_id, organization_id, title, source_type, authority_tier, url,
        approval_state, verification_state, approved_by_account_id, approved_at,
        verified_by_account_id, verified_at)
     values ($1, $2, $3, $4, 1, $5,
       case when $6 then 'approved' else 'pending_review' end,
       case when $6 then 'verified' else 'unverified' end,
       case when $6 then $7 else null end, case when $6 then now() else null end,
       case when $6 then $7 else null end, case when $6 then now() else null end)`,
    [sourceId, organizationId, title, sourceType, `https://example.org/${organizationId}/${sourceId}`, approved, ADMIN],
  );

  for (let d = 0; d < documents; d += 1) {
    const documentId = `${sourceId}-doc-${d}`;
    await target.query(
      `insert into pilot.shadow_library_documents
         (document_id, source_id, organization_id, document_name, content_sha256)
       values ($1, $2, $3, $4, $5)`,
      [documentId, sourceId, organizationId, `Document ${documentId}`, `${organizationId}-${documentId}`],
    );
    for (let c = 0; c < chunks; c += 1) {
      await target.query(
        `insert into pilot.shadow_library_chunks
           (chunk_id, document_id, source_id, organization_id, ordinal, text_content)
         values ($1, $2, $3, $4, $5, $6)`,
        [`${documentId}-chunk-${c}`, documentId, sourceId, organizationId, c + 1, `Body ${c}`],
      );
    }
  }
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

  prerequisiteSchemaSql = await Promise.all(
    PREREQUISITE_FILES.map((file) => fs.readFile(path.join(INFRA_DIR, file), 'utf8')),
  );

  const scriptModule = await nativeDynamicImport(pathToFileURL(CHECK_SCRIPT_PATH).href);
  checkLibraryScope = scriptModule.checkLibraryScope as (c: Client) => Promise<{ nonCorpus: NonCorpusRow[] }>;

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query('drop database if exists ppbf_library_scope_check');
  await admin.query("create database ppbf_library_scope_check encoding 'UTF8' template template0");
  await admin.end();

  client = new Client({ connectionString: connectionStringFor('ppbf_library_scope_check') });
  await client.connect();
  for (const sql of prerequisiteSchemaSql) {
    await client.query(sql);
  }

  for (const organizationId of [GYM, OTHER_GYM]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft') on conflict do nothing`,
    [ADMIN, GYM],
  );

  // Two corpus rows, which must never appear in the section, and three
  // non-corpus rows, which must.
  await seedSource(client, GYM, 'src_aaaaaaaaaaaaaaaa');
  await seedSource(client, GYM, 'src_bbbbbbbbbbbbbbbb');
  await seedSource(client, GYM, 'source_uploaded_pending', {
    title: 'Punxsy Coaching System Source Manual v3',
    sourceType: 'internal_policy',
    documents: 2,
    chunks: 3,
  });
  await seedSource(client, GYM, 'source_uploaded_approved', {
    title: 'SHADOW Canonical Authority Model',
    sourceType: 'internal_policy',
    approved: true,
    documents: 1,
    chunks: 29,
  });
  // A second gym's own upload. Note it cannot reuse a source_id: source_id is
  // the PRIMARY KEY on shadow_library_sources, so ids are globally unique rather
  // than unique per organization, and two gyms holding "the same" source is not
  // a state this schema can reach.
  await seedSource(client, OTHER_GYM, 'source_other_gym_upload', {
    title: 'Another Gym Upload',
    sourceType: 'internal_policy',
    documents: 1,
    chunks: 1,
  });
});

afterAll(async () => {
  if (client) await client.end();
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
  // Only this suite's own directory, named for this process.
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

describe('the NON-CORPUS section names what a bulk approval would sweep in', () => {
  test('corpus rows are excluded and every non-corpus row is listed', async () => {
    const result = await checkLibraryScope(client);

    expect(result.nonCorpus.map((r) => `${r.organization_id}/${r.source_id}`).sort()).toEqual([
      'org-gym-one/source_uploaded_approved',
      'org-gym-one/source_uploaded_pending',
      'org-gym-two/source_other_gym_upload',
    ]);
  });

  test('it carries what a decision needs: title, type, state and approver', async () => {
    const result = await checkLibraryScope(client);
    const approved = result.nonCorpus.find(
      (r) => r.organization_id === GYM && r.source_id === 'source_uploaded_approved',
    );

    expect(approved).toMatchObject({
      title: 'SHADOW Canonical Authority Model',
      source_type: 'internal_policy',
      approval_state: 'approved',
      verification_state: 'verified',
      approved_by_account_id: ADMIN,
    });
  });

  test('a pending row reports no approver, which is what distinguishes it', async () => {
    const result = await checkLibraryScope(client);
    const pending = result.nonCorpus.find(
      (r) => r.organization_id === GYM && r.source_id === 'source_uploaded_pending',
    );

    expect(pending).toMatchObject({
      approval_state: 'pending_review',
      approved_by_account_id: null,
    });
  });

  // The arithmetic that made production's sweep checkable: 20 policy chunks plus
  // this row's 29 accounted for all 49. That only works if each row reports its
  // OWN documents and chunks. A subquery that dropped the source predicate and
  // filtered on organization alone would give every row in a gym the same
  // number -- the gym's total -- and the sum would stop meaning anything. The
  // gym below deliberately holds four sources so the totals and the per-row
  // figures cannot coincide.
  test('document and chunk counts belong to the row, not to the organization', async () => {
    const result = await checkLibraryScope(client);
    const pending = result.nonCorpus.find(
      (r) => r.organization_id === GYM && r.source_id === 'source_uploaded_pending',
    );
    const approved = result.nonCorpus.find(
      (r) => r.organization_id === GYM && r.source_id === 'source_uploaded_approved',
    );
    const otherGym = result.nonCorpus.find((r) => r.organization_id === OTHER_GYM);

    expect(pending).toMatchObject({ documents: 2, chunks: 6 });
    expect(approved).toMatchObject({ documents: 1, chunks: 29 });
    expect(otherGym).toMatchObject({ documents: 1, chunks: 1 });

    // Both live in the same gym and report different figures, which an
    // organization-only count could not produce.
    expect(pending?.chunks).not.toBe(approved?.chunks);
  });

  test('the approved subset is identifiable, which is what the printed NOTE counts', async () => {
    const result = await checkLibraryScope(client);
    const approved = result.nonCorpus.filter((r) => r.approval_state === 'approved');

    expect(approved).toHaveLength(1);
    expect(approved[0].source_id).toBe('source_uploaded_approved');
  });

  // The check is a diagnostic and must never write, whatever else changes in it.
  test('the check leaves the database untouched', async () => {
    const before = await client.query('select count(*)::int as n from pilot.shadow_library_sources');
    await checkLibraryScope(client);
    const after = await client.query('select count(*)::int as n from pilot.shadow_library_sources');

    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// The suite above migrates one database in beforeAll with a plain
// `client.query` and then tests the module on top of it. That proves the
// schema and proves nothing about scripts/pilot-apply-capability-feeder-tracks-migration.mjs's
// READINESS_QUERY -- the assertion that gates the actual dispatch, and the
// only code in this migration whose first real execution is against a live
// environment at the most expensive possible moment.
//
// #488 is what that costs: a readiness check that searched
// pg_get_constraintdef() for the literal `between 1 and 5` could not pass on
// ANY database, because Postgres deparses a CHECK from the parsed tree and
// emits `>= 1 AND <= 5`. The schema was correct the whole time. Only a real
// staging dispatch found it.
//
// The query is never restated here -- `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so this
// cannot stay green while the runner rots. It brings its own disposable
// database so the migrated one the module tests run against is untouched.
describe('capability feeder tracks runner readiness assertion', () => {
  async function runnerDatabase(name: string): Promise<Client> {
    const admin = new Client({ connectionString: connectionStringFor('postgres') });
    await admin.connect();
    await admin.query(`drop database if exists ${name}`);
    await admin.query(`create database ${name}`);
    await admin.end();

    const client = new Client({ connectionString: connectionStringFor(name) });
    await client.connect();
      await client.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
      await client.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_shadow_evidence_migration.sql'), 'utf8'));
    return client;
  }

  async function loadRunner(): Promise<(client: Client, sql: string) => Promise<void>> {
    const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
    return runnerModule.applyMigrationTransaction as (client: Client, sql: string) => Promise<void>;
  }

  test('the real runner REFUSES a database where the migration never ran', async () => {
    const applyMigrationTransaction = await loadRunner();
    const client = await runnerDatabase('ppbf_test_capft_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /CAPABILITY_FEEDER_TRACKS_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const applyMigrationTransaction = await loadRunner();
    const client = await runnerDatabase('ppbf_test_capft_rdy_ok');
    try {
      const migrationSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_capability_feeder_tracks_migration.sql'), 'utf8');
      await applyMigrationTransaction(client, migrationSql);
      // The `all` chain re-runs every migration on every dispatch (#489), so
      // the second pass has to survive its own first pass.
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });
});
