// Real PostgreSQL-backed test for the discipline value census.
//
// The census exists to answer, before anyone runs `validate constraint`, the
// question NOT VALID deliberately left unanswered: which existing rows name a
// discipline their organization's registry does not hold. Postgres reports only
// the FIRST offending key when a validation fails, so an operator without this
// learns them one row at a time, from production.
//
// A census can only be trusted if it has been shown to FIND things. So every
// case here plants known offenders and asserts the census reports exactly
// those -- and the offenders are planted BEFORE the foreign keys are applied,
// because that is the only way they can exist: NOT VALID enforces new writes
// and skips the existing rows, which is precisely the population this reports.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-discipline-census-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const CENSUS_PATH = path.resolve(__dirname, '../../../scripts/pilot-check-discipline-values.mjs');

/** Everything the three tables and their foreign keys need, in apply order. */
const SCHEMA = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_activity_log_migration.sql',
  'pilot_slice_postgres_drill_library_v3_migration.sql',
  'pilot_slice_postgres_multidiscipline_migration.sql',
  'pilot_slice_postgres_session_scripts_migration.sql',
  'pilot_slice_postgres_competence_cohorts_migration.sql',
];
const FOREIGN_KEYS = [
  'pilot_slice_postgres_drill_library_discipline_fk_migration.sql',
  'pilot_slice_postgres_session_scripts_discipline_fk_migration.sql',
  'pilot_slice_postgres_cohort_definitions_discipline_fk_migration.sql',
];

const ORG_REGISTERED = 'org-with-registry';
const ORG_EMPTY = 'org-with-no-registry';
const COACH = 'acct-census-coach';

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs. Building the import through `new Function` keeps a
// real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules. Same pattern as calibrationProjects.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

type CensusReport = {
  emptyRegistries: Array<{ organization_id: string; row_count: number }>;
  emptyRegistryRowCount: number;
  blockingRowCount: number;
  tables: Array<{
    table: string;
    constraintExists: boolean;
    constraintValidated: boolean;
    unknown: Array<{ organization_id: string; discipline: string; row_count: number }>;
    unknownRowCount: number;
  }>;
};

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let census: (client: Client) => Promise<CensusReport>;
const sql: Record<string, string> = {};

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

async function insertDrill(client: Client, organizationId: string, drillId: string, discipline?: string) {
  await client.query(
    `insert into pilot.drill_library (
       organization_id, drill_id, lineage_id, name, category, target_behavior, purpose,
       standard_setup, execution, what_good_looks_like, what_bad_looks_like${discipline ? ', discipline' : ''}
     )
     values ($1, $2, $2, $3, 'defense', 'b', 'p', 's', 'e', 'g', 'bad'${discipline ? ', $4' : ''})`,
    discipline ? [organizationId, drillId, drillId, discipline] : [organizationId, drillId, drillId],
  );
}

/**
 * A database at the state this census is for: content rows already written,
 * then the foreign keys applied NOT VALID over the top of them.
 */
async function databaseWithLegacyRows(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  for (const file of SCHEMA) {
    await client.query(sql[file]);
  }

  for (const org of [ORG_REGISTERED, ORG_EMPTY]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH, ORG_REGISTERED],
  );
  // Only one organization gets a registry. The other is the empty-registry case.
  for (const discipline of ['boxing', 'conditioning']) {
    await client.query(
      `insert into pilot.disciplines
         (organization_id, discipline, display_name, lane, exposure_model)
       values ($1, $2, $2, 'striking', 'head_impact')`,
      [ORG_REGISTERED, discipline],
    );
  }
  return client;
}

async function applyForeignKeys(client: Client) {
  for (const file of FOREIGN_KEYS) {
    await client.query(sql[file]);
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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  for (const file of [...SCHEMA, ...FOREIGN_KEYS]) {
    sql[file] = await fs.readFile(path.join(INFRA_DIR, file), 'utf8');
  }

  // The real script, not a copy of its query.
  const censusModule = await nativeDynamicImport(pathToFileURL(CENSUS_PATH).href);
  census = censusModule.checkDisciplineValues as (client: Client) => Promise<CensusReport>;
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

describe('a database whose values all resolve', () => {
  test('reports CLEAN, and says the constraints are installed but unvalidated', async () => {
    const client = await databaseWithLegacyRows('census_clean');
    try {
      await insertDrill(client, ORG_REGISTERED, 'drl-ok', 'boxing');
      await applyForeignKeys(client);

      const report = await census(client);

      expect(report.blockingRowCount).toBe(0);
      expect(report.emptyRegistries).toEqual([]);
      // The state that makes this census necessary, reported rather than assumed.
      for (const entry of report.tables) {
        expect(entry.constraintExists).toBe(true);
        expect(entry.constraintValidated).toBe(false);
      }
    } finally {
      await client.end();
    }
  });
});

describe('a row naming a discipline the registry does not hold', () => {
  test('is found, named, and counted', async () => {
    const client = await databaseWithLegacyRows('census_unknown');
    try {
      // 'general' is the value the drill-library CHECK still admits and the
      // registry has never contained. Planted before the FK, which is the only
      // way such a row can exist.
      await insertDrill(client, ORG_REGISTERED, 'drl-g1', 'general');
      await insertDrill(client, ORG_REGISTERED, 'drl-g2', 'general');
      await applyForeignKeys(client);

      const report = await census(client);
      const drills = report.tables.find((entry) => entry.table === 'drill_library');

      expect(drills?.unknown).toEqual([
        { organization_id: ORG_REGISTERED, discipline: 'general', row_count: 2 },
      ]);
      expect(report.blockingRowCount).toBe(2);
      // Its registry is not empty, so it must not also appear as one.
      expect(report.emptyRegistries).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('every distinct value is enumerated, not a sample of them', async () => {
    // The failure the multiorg orphan check records: ten ids named, covering
    // 23 of 43 rows, and a cleanup built from that list missed twenty.
    //
    // Planted in session_scripts rather than drill_library because
    // drill_library still carries the literal CHECK #757 deliberately left in
    // place, which admits five values and nothing else. session_scripts has no
    // CHECK, so it is the table that can actually hold the variety a real
    // census has to enumerate -- and the one where an unknown value is most
    // likely to exist, precisely because nothing ever constrained it.
    const client = await databaseWithLegacyRows('census_enumerate');
    try {
      for (const [index, discipline] of ['krav_maga', 'judo', 'sambo'].entries()) {
        await client.query(
          `insert into pilot.session_scripts
             (organization_id, script_id, lineage_id, name, created_by_account_id, discipline)
           values ($1, $2, $2, $2, $3, $4)`,
          [ORG_REGISTERED, `scr-${index}`, COACH, discipline],
        );
      }
      await applyForeignKeys(client);

      const report = await census(client);
      const scripts = report.tables.find((entry) => entry.table === 'session_scripts');

      expect(scripts?.unknown.map((row) => row.discipline).sort())
        .toEqual(['judo', 'krav_maga', 'sambo']);
      expect(scripts?.unknownRowCount).toBe(3);
      expect(report.blockingRowCount).toBe(3);
    } finally {
      await client.end();
    }
  });
});

describe('an organization with no registry at all', () => {
  test('is reported separately, because the fix is different', async () => {
    // Seeding a registry and deciding what a stray value meant are different
    // actions. Collapsing them into one number would tell an operator to go
    // looking for rows to reinterpret when what they need is a seed run.
    const client = await databaseWithLegacyRows('census_empty');
    try {
      await insertDrill(client, ORG_EMPTY, 'drl-orphaned');
      await applyForeignKeys(client);

      const report = await census(client);

      expect(report.emptyRegistries).toEqual([
        { organization_id: ORG_EMPTY, row_count: 1 },
      ]);
      expect(report.emptyRegistryRowCount).toBe(1);
      // Counted once. Not also listed as an unknown value for that table.
      expect(report.tables.find((entry) => entry.table === 'drill_library')?.unknown).toEqual([]);
      expect(report.blockingRowCount).toBe(1);
    } finally {
      await client.end();
    }
  });
});

describe('what the census may not do', () => {
  test('changes nothing it looks at', async () => {
    // It is meant to be safe to point at production, so this asserts the
    // property rather than trusting the READ ONLY transaction to be there.
    const client = await databaseWithLegacyRows('census_readonly');
    try {
      await insertDrill(client, ORG_REGISTERED, 'drl-keep', 'general');
      await applyForeignKeys(client);

      const before = await client.query(
        'select organization_id, drill_id, discipline from pilot.drill_library order by drill_id',
      );
      const registryBefore = await client.query('select count(*)::int as n from pilot.disciplines');

      await census(client);

      const after = await client.query(
        'select organization_id, drill_id, discipline from pilot.drill_library order by drill_id',
      );
      const registryAfter = await client.query('select count(*)::int as n from pilot.disciplines');

      expect(after.rows).toEqual(before.rows);
      expect(registryAfter.rows[0].n).toBe(registryBefore.rows[0].n);
    } finally {
      await client.end();
    }
  });

  test('agrees with what validate constraint would actually do', async () => {
    // The census is only worth running if its answer predicts the validation.
    // Same database, both questions, asserted against each other.
    const client = await databaseWithLegacyRows('census_agrees');
    try {
      await insertDrill(client, ORG_REGISTERED, 'drl-bad', 'general');
      await applyForeignKeys(client);

      const report = await census(client);
      expect(report.blockingRowCount).toBeGreaterThan(0);

      await expect(
        client.query('alter table pilot.drill_library validate constraint pilot_drill_library_discipline_fk'),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.end();
    }
  });

  test('and when it reports CLEAN, the validation succeeds', async () => {
    const client = await databaseWithLegacyRows('census_clean_validates');
    try {
      await insertDrill(client, ORG_REGISTERED, 'drl-fine', 'conditioning');
      await applyForeignKeys(client);

      const report = await census(client);
      expect(report.blockingRowCount).toBe(0);

      await expect(
        client.query('alter table pilot.drill_library validate constraint pilot_drill_library_discipline_fk'),
      ).resolves.toBeDefined();
    } finally {
      await client.end();
    }
  });
});
