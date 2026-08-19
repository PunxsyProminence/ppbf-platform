// Real PostgreSQL-backed contract test for the readiness provenance migration.
//
// THE INVARIANT THIS EXISTS FOR: a readiness row cannot be written without
// stating where it came from. Three engine proposals (modules 021, 029, 033)
// independently refused to consume pilot.readiness because a score arrived
// with no way to audit its origin. The test that matters most below is the one
// asserting an insert WITHOUT a method fails -- a migration that adds the
// column but leaves its 'UNKNOWN' default in place passes every
// column-existence check while letting every future write silently claim
// unknown provenance, which is the exact state being fixed.
//
// The rest proves what reading the SQL cannot establish:
//
//   * the gap is real: without the migration none of the columns exist
//   * a row written before the migration is backfilled to 'UNKNOWN' rather
//     than to an invented method -- guessing a confident label during a
//     migration is the fabrication this change exists to end
//   * the measurement-property columns DO keep their defaults, because
//     defaulting toward "not established" fails in the safe direction
//   * the method vocabulary is enforced by the database, not only by the
//     TypeScript union
//   * re-running is a no-op, since `all` re-applies every increment
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

import { isReadinessMethodValidated } from './readinessProvenance';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-readiness-provenance-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_readiness_provenance_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-readiness-provenance-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-readiness';
const COACH_ID = 'acct-readiness-coach';
const ATHLETE_ID = 'ATH-READINESS-1';

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

/** Fresh database with the base schema and the org/coach/athlete rows the FKs need. */
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
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG_ID],
  );
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Readiness Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  return client;
}

/** A readiness reading of the shape the app wrote before provenance existed. */
async function insertLegacyReadiness(client: Client, readinessId: string, score: number): Promise<void> {
  await client.query(
    `insert into pilot.readiness
       (organization_id, readiness_id, athlete_id, score, category, measured_at)
     values ($1, $2, $3, $4, 'general', now())`,
    [ORG_ID, readinessId, ATHLETE_ID, score],
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
});

describe('readiness provenance migration against real Postgres', () => {
  test('the gap is real: without the migration no provenance column exists', async () => {
    const client = await freshDatabase('ppbf_test_readiness_absent');
    try {
      await expect(
        client.query('select method, reliability_status, validity_status, evidence_class from pilot.readiness'),
      ).rejects.toThrow(/column .* does not exist/i);
    } finally {
      await client.end();
    }
  });

  test('the migration adds the columns, not null, in assessment_protocols vocabulary', async () => {
    const client = await freshDatabase('ppbf_test_readiness_fresh');
    try {
      await client.query(migrationSql);

      const columns = await client.query(
        `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
         where table_schema = 'pilot'
           and table_name = 'readiness'
           and column_name in ('method', 'reliability_status', 'validity_status',
                               'evidence_class', 'recorded_by_account_id')
         order by column_name`,
      );

      expect(columns.rows).toEqual([
        {
          column_name: 'evidence_class',
          data_type: 'text',
          is_nullable: 'NO',
          column_default: "'INSUFFICIENT EVIDENCE'::text",
        },
        // The one that must have NO default -- see the dedicated test below.
        { column_name: 'method', data_type: 'text', is_nullable: 'NO', column_default: null },
        { column_name: 'recorded_by_account_id', data_type: 'text', is_nullable: 'YES', column_default: null },
        {
          column_name: 'reliability_status',
          data_type: 'text',
          is_nullable: 'NO',
          column_default: "'UNVALIDATED - PPBF MUST ESTABLISH'::text",
        },
        {
          column_name: 'validity_status',
          data_type: 'text',
          is_nullable: 'NO',
          column_default: "'UNKNOWN'::text",
        },
      ]);
    } finally {
      await client.end();
    }
  });

  // THE INVARIANT. A readiness row cannot be written without stating where it
  // came from. If `method` kept its migration-time default this insert would
  // succeed and silently record 'UNKNOWN' for a writer who actually knew.
  test('a readiness row cannot be written without stating where it came from', async () => {
    const client = await freshDatabase('ppbf_test_readiness_requires_method');
    try {
      await client.query(migrationSql);

      await expect(
        client.query(
          `insert into pilot.readiness
             (organization_id, readiness_id, athlete_id, score, category, measured_at)
           values ($1, gen_random_uuid(), $2, 7, 'general', now())`,
          [ORG_ID, ATHLETE_ID],
        ),
      ).rejects.toThrow(/null value .* violates not-null constraint/i);
    } finally {
      await client.end();
    }
  });

  test('stating the method lets the same insert through', async () => {
    const client = await freshDatabase('ppbf_test_readiness_method_ok');
    try {
      await client.query(migrationSql);

      await client.query(
        `insert into pilot.readiness
           (organization_id, readiness_id, athlete_id, score, category, measured_at, method, recorded_by_account_id)
         values ($1, gen_random_uuid(), $2, 7, 'general', now(), 'staff_entered_intake', $3)`,
        [ORG_ID, ATHLETE_ID, COACH_ID],
      );

      const row = await client.query(
        `select method, reliability_status, validity_status, evidence_class, recorded_by_account_id
         from pilot.readiness where athlete_id = $1`,
        [ATHLETE_ID],
      );
      // The measurement properties fall to their unvalidated defaults, which
      // is the honest state: no readiness method has been established.
      expect(row.rows[0]).toEqual({
        method: 'staff_entered_intake',
        reliability_status: 'UNVALIDATED - PPBF MUST ESTABLISH',
        validity_status: 'UNKNOWN',
        evidence_class: 'INSUFFICIENT EVIDENCE',
        recorded_by_account_id: COACH_ID,
      });
    } finally {
      await client.end();
    }
  });

  // The honest-backfill property. A migration that invented a method for
  // pre-existing rows would be asserting provenance nobody recorded.
  test('a reading written before the migration is backfilled to UNKNOWN, not to an invented method', async () => {
    const client = await freshDatabase('ppbf_test_readiness_legacy');
    try {
      await insertLegacyReadiness(client, '11111111-1111-1111-1111-111111111111', 8);
      await client.query(migrationSql);

      const row = await client.query(
        `select score::float8 as score, method, reliability_status, validity_status, evidence_class
         from pilot.readiness where readiness_id = $1`,
        ['11111111-1111-1111-1111-111111111111'],
      );
      expect(row.rows[0]).toEqual({
        score: 8,
        method: 'UNKNOWN',
        reliability_status: 'UNVALIDATED - PPBF MUST ESTABLISH',
        validity_status: 'UNKNOWN',
        evidence_class: 'INSUFFICIENT EVIDENCE',
      });
    } finally {
      await client.end();
    }
  });

  test('the database refuses a method outside the vocabulary', async () => {
    const client = await freshDatabase('ppbf_test_readiness_vocabulary');
    try {
      await client.query(migrationSql);

      // Includes 'calculated_l14' deliberately: readinessMath.ts's formula is
      // dead code with uncited coefficients, and it must not be able to claim
      // provenance without a migration that records that decision.
      for (const method of ['calculated_l14', 'self_reported', '']) {
        await expect(
          client.query(
            `insert into pilot.readiness
               (organization_id, readiness_id, athlete_id, score, category, measured_at, method)
             values ($1, gen_random_uuid(), $2, 7, 'general', now(), $3)`,
            [ORG_ID, ATHLETE_ID, method],
          ),
        ).rejects.toThrow(/pilot_readiness_method_check/);
      }
    } finally {
      await client.end();
    }
  });

  test('recorded_by_account_id must name a real account when present', async () => {
    const client = await freshDatabase('ppbf_test_readiness_recorded_by');
    try {
      await client.query(migrationSql);

      await expect(
        client.query(
          `insert into pilot.readiness
             (organization_id, readiness_id, athlete_id, score, category, measured_at, method, recorded_by_account_id)
           values ($1, gen_random_uuid(), $2, 7, 'general', now(), 'staff_entered_intake', 'acct-does-not-exist')`,
          [ORG_ID, ATHLETE_ID],
        ),
      ).rejects.toThrow(/pilot_readiness_recorded_by_fk/);
    } finally {
      await client.end();
    }
  });

  // `all` re-applies every increment on every dispatch, so this is the property
  // that makes dispatching it safe rather than merely convenient.
  test('re-running is a no-op and does not disturb stored provenance', async () => {
    const client = await freshDatabase('ppbf_test_readiness_rerun');
    try {
      await client.query(migrationSql);
      await client.query(
        `insert into pilot.readiness
           (organization_id, readiness_id, athlete_id, score, category, measured_at, method, recorded_by_account_id)
         values ($1, '22222222-2222-2222-2222-222222222222', $2, 6, 'general', now(), 'staff_entered_intake', $3)`,
        [ORG_ID, ATHLETE_ID, COACH_ID],
      );

      await client.query(migrationSql);

      const row = await client.query(
        'select method, recorded_by_account_id from pilot.readiness where readiness_id = $1',
        ['22222222-2222-2222-2222-222222222222'],
      );
      expect(row.rows[0]).toEqual({ method: 'staff_entered_intake', recorded_by_account_id: COACH_ID });

      // And the default is still gone after a second application -- otherwise
      // re-running would quietly reopen the hole this migration closed.
      await expect(
        client.query(
          `insert into pilot.readiness
             (organization_id, readiness_id, athlete_id, score, category, measured_at)
           values ($1, gen_random_uuid(), $2, 7, 'general', now())`,
          [ORG_ID, ATHLETE_ID],
        ),
      ).rejects.toThrow(/null value .* violates not-null constraint/i);
    } finally {
      await client.end();
    }
  });

  // The predicate the surfaces use to decide whether to show the caveat, run
  // against rows that really came out of the database rather than against
  // hand-built objects.
  test('nothing currently storable passes the validated-method predicate', async () => {
    const client = await freshDatabase('ppbf_test_readiness_predicate');
    try {
      // The legacy row goes in BEFORE the migration -- after it, the dropped
      // default makes a method-less insert impossible, which is the invariant
      // two tests above. So this is the only order that can produce one row of
      // each kind: a backfilled 'UNKNOWN' and a live-path 'staff_entered_intake'.
      await insertLegacyReadiness(client, '33333333-3333-3333-3333-333333333333', 9);
      await client.query(migrationSql);
      await client.query(
        `insert into pilot.readiness
           (organization_id, readiness_id, athlete_id, score, category, measured_at, method)
         values ($1, gen_random_uuid(), $2, 9, 'general', now(), 'staff_entered_intake')`,
        [ORG_ID, ATHLETE_ID],
      );

      const rows = await client.query<{
        method: string;
        reliability_status: string;
        validity_status: string;
      }>('select method, reliability_status, validity_status from pilot.readiness');

      expect(rows.rows).toHaveLength(2);
      for (const row of rows.rows) {
        expect({ method: row.method, validated: isReadinessMethodValidated(row) })
          .toEqual({ method: row.method, validated: false });
      }
    } finally {
      await client.end();
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// Every case above applies `migrationSql` with a plain `client.query`, which
// proves the schema and proves nothing about
// scripts/pilot-apply-readiness-provenance-migration.mjs's READINESS_QUERY -- the
// assertion that gates the dispatch, and the code whose first real execution
// is against a live environment at the most expensive possible moment. #488
// is what that costs: an assertion that could not pass on ANY database,
// found only by a staging dispatch it then blocked.
//
// The query is never restated here. `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so
// this cannot stay green while the runner rots.
describe('readiness provenance runner readiness assertion', () => {
  // Fails closed, but NOT through its own sentinel. READINESS_QUERY's last
  // clause is `select 1 from pilot.readiness where method is null`, and
  // `method` is a column this very migration adds -- so against a database
  // that has not had the migration applied the query itself raises
  // `column "method" does not exist` before assertReadiness() ever sees a
  // row. The dispatch still refuses, which is the property that matters, but
  // an operator reading the failure gets a raw Postgres error instead of
  // READINESS_PROVENANCE_NOT_READY. Asserting the behavior that actually
  // ships rather than the one the runner appears to promise: making this
  // expect the sentinel would be asserting a fiction. Reported separately --
  // fixing it is a runner change, not a test change.
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('rprov_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /column "method" does not exist/,
      );
      // Whatever the message, nothing was left behind: the transaction rolled
      // back, so a refused readiness check never half-migrates a database.
      const applied = await client.query(
        `select count(*)::int as n
           from information_schema.columns
          where table_schema = 'pilot' and table_name = 'readiness'
            and column_name = 'method'`,
      );
      expect(applied.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('rprov_rdy_ok');
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
