// Real PostgreSQL-backed contract test for the research-submissions migration.
//
// What needs a real database to prove: the table creates from nothing over
// the base schema; re-apply is a row-preserving no-op; the duplicate-link
// refusal and review-attribution check are enforced by the DATABASE, not just
// the module; and the no-auto-resolve boundary holds structurally -- writing
// a submission row does not touch the requirement's status.
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

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-research-submissions-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_shadow_research_submissions_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-shadow-research-submissions-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-research';
const ADMIN_ID = 'acct-research-admin';
const SOURCE_ID = 'src-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let baseSchemaSql: string;

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
  await client.query(baseSchemaSql);
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft') on conflict do nothing`,
    [ADMIN_ID, ORG_ID],
  );
  await client.query(
    `insert into pilot.shadow_library_sources (source_id, organization_id, title, source_type, authority_tier)
     values ($1, $2, 'RPE reliability in adolescent athletes', 'peer_reviewed', 1)`,
    [SOURCE_ID, ORG_ID],
  );
  return client;
}

async function insertRequirement(client: Client): Promise<number> {
  const result = await client.query(
    `insert into pilot.shadow_research_requirements
       (organization_id, source_event_name, source_entity_type, source_entity_id,
        research_requirement, knowledge_gap, source_status, source_confidence_tier,
        source_verification_state, created_by_account_id, created_by_role)
     values ($1, 'question', 'athlete', 'ath-1', 'Is RPE reliable at age 12?',
             'adolescent RPE reliability', 'active', 'tier_2', 'unverified', $2, 'coach')
     returning research_requirement_id`,
    [ORG_ID, ADMIN_ID],
  );
  return Number(result.rows[0].research_requirement_id);
}

function insertSubmission(client: Client, requirementId: number, submissionId: string, sourceId = SOURCE_ID) {
  return client.query(
    `insert into pilot.shadow_research_submissions
       (organization_id, submission_id, research_requirement_id, source_id, submitted_by_account_id)
     values ($1, $2, $3, $4, $5)`,
    [ORG_ID, submissionId, requirementId, sourceId, ADMIN_ID],
  );
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
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;
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

describe('research submissions migration', () => {
  test('creates from nothing, links a submission, and re-apply is a row-preserving no-op', async () => {
    const client = await freshDatabase('research_fresh');
    try {
      await client.query(migrationSql);
      const requirementId = await insertRequirement(client);
      await insertSubmission(client, requirementId, 'sub-1');
      await client.query(migrationSql);

      const rows = await client.query(
        'select submission_id, applicability_state from pilot.shadow_research_submissions where organization_id = $1',
        [ORG_ID],
      );
      expect(rows.rows).toEqual([{ submission_id: 'sub-1', applicability_state: 'unreviewed' }]);
    } finally {
      await client.end();
    }
  });

  test('the same source cannot be linked twice to the same requirement', async () => {
    const client = await freshDatabase('research_dup');
    try {
      await client.query(migrationSql);
      const requirementId = await insertRequirement(client);
      await insertSubmission(client, requirementId, 'sub-1');

      await expect(insertSubmission(client, requirementId, 'sub-2'))
        .rejects.toMatchObject({ code: '23505', constraint: 'pilot_shadow_research_submissions_unique_link' });
    } finally {
      await client.end();
    }
  });

  test('a review verdict without a reviewer is refused by the database', async () => {
    const client = await freshDatabase('research_attrib');
    try {
      await client.query(migrationSql);
      const requirementId = await insertRequirement(client);

      await expect(client.query(
        `insert into pilot.shadow_research_submissions
           (organization_id, submission_id, research_requirement_id, source_id,
            submitted_by_account_id, applicability_state)
         values ($1, 'sub-bad', $2, $3, $4, 'responsive')`,
        [ORG_ID, requirementId, SOURCE_ID, ADMIN_ID],
      )).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });

  test('writing a submission leaves the requirement status untouched: no auto-resolve path exists', async () => {
    const client = await freshDatabase('research_boundary');
    try {
      await client.query(migrationSql);
      const requirementId = await insertRequirement(client);
      await insertSubmission(client, requirementId, 'sub-1');
      await client.query(
        `update pilot.shadow_research_submissions
         set applicability_state = 'responsive', reviewed_by_account_id = $2, reviewed_at = now()
         where organization_id = $1 and submission_id = 'sub-1'`,
        [ORG_ID, ADMIN_ID],
      );

      const requirement = await client.query(
        'select status, resolved_at from pilot.shadow_research_requirements where research_requirement_id = $1',
        [requirementId],
      );
      expect(requirement.rows[0].status).toBe('open');
      expect(requirement.rows[0].resolved_at).toBeNull();

      // And there is no trigger wired to this table that could ever do it.
      const triggers = await client.query(
        `select tgname from pg_trigger
         where tgrelid = to_regclass('pilot.shadow_research_submissions') and not tgisinternal`,
      );
      expect(triggers.rows).toEqual([]);
    } finally {
      await client.end();
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// Every case above applies `migrationSql` with a plain `client.query`, which
// proves the schema and proves nothing about
// scripts/pilot-apply-shadow-research-submissions-migration.mjs's READINESS_QUERY -- the
// assertion that gates the dispatch, and the code whose first real execution
// is against a live environment at the most expensive possible moment. #488
// is what that costs: an assertion that could not pass on ANY database,
// found only by a staging dispatch it then blocked.
//
// The query is never restated here. `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so
// this cannot stay green while the runner rots.
describe('shadow research submissions runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('shres_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /SHADOW_RESEARCH_SUBMISSIONS_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('shres_rdy_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      // The `all` chain re-runs every migration on every dispatch (#489), so
      // the second pass has to survive its own first pass.
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });
});
