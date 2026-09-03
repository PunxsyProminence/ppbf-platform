// Real PostgreSQL-backed contract test for the clearance-type seeds
// migration. Four things need proving, and none can be proven by reading
// SQL:
//
// 1. Every organization that exists when the migration runs ends up with
//    all four defaults, with the exact names/authorities/validity the
//    platform ships.
// 2. Re-running does not duplicate.
// 3. A gym's own edits (archiving, rewriting, renaming a default) survive a
//    re-run.
// 4. The runner's readiness check actually fails when the seeds did not
//    land -- a negative control, so an all-green suite proves something.
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

import { Client, type PoolClient } from 'pg';

import { seedDefaultClearanceTypes } from './clearanceTypeSeeds';
import { seedDefaultSafetyGates } from './safetyGateSeeds';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-clearance-type-seeds-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_clearance_type_seeds_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-clearance-type-seeds-migration.mjs',
);

const ORG_A = 'org-ct-seed-a';
const ORG_B = 'org-ct-seed-b';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

type DefaultType = {
  idFor: (organizationId: string) => string;
  name: string;
  issuingAuthority: string;
  authorityKind: string;
  validityMonths: number;
};

// The four the platform ships. Spelled out here rather than parsed from the
// SQL under test, matching complianceRuleSeeds.pg.test.ts's own reasoning.
const DEFAULT_TYPES: DefaultType[] = [
  {
    idFor: (org) => `ct_safesport_${org}`,
    name: 'SafeSport Training',
    issuingAuthority: 'U.S. Center for SafeSport',
    authorityKind: 'governing_body',
    validityMonths: 12,
  },
  {
    idFor: (org) => `ct_usaboxing_coach_${org}`,
    name: 'USA Boxing Coach Certification',
    issuingAuthority: 'USA Boxing',
    authorityKind: 'governing_body',
    validityMonths: 12,
  },
  {
    idFor: (org) => `ct_background_check_${org}`,
    name: 'Background Check',
    issuingAuthority: 'PA Dept of Human Services',
    authorityKind: 'state_statutory',
    validityMonths: 60,
  },
  {
    idFor: (org) => `ct_cpr_first_aid_${org}`,
    name: 'CPR/First Aid',
    issuingAuthority: 'American Red Cross',
    authorityKind: 'governing_body',
    validityMonths: 24,
  },
];

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let seedsSql: string;
let baseSchemaSql: string;
let clearanceRegisterSql: string;
let safetyGateMatrixSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;

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

async function freshDatabase(
  name: string,
  withClearanceRegister = true,
  withSafetyGateMatrix = false,
): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  if (withClearanceRegister) {
    await client.query(clearanceRegisterSql);
  }
  if (withSafetyGateMatrix) {
    await client.query(safetyGateMatrixSql);
  }
  for (const organizationId of [ORG_A, ORG_B]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
  }
  return client;
}

async function typesFor(client: Client, organizationId: string) {
  const { rows } = await client.query(
    `select clearance_type_id, name, issuing_authority, authority_kind, validity_months, active
     from pilot.clearance_types
     where organization_id = $1
     order by clearance_type_id`,
    [organizationId],
  );
  return rows as Array<{
    clearance_type_id: string;
    name: string;
    issuing_authority: string;
    authority_kind: string;
    validity_months: number;
    active: boolean;
  }>;
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
  clearanceRegisterSql = await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_clearance_register_migration.sql'), 'utf8');
  safetyGateMatrixSql = await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_safety_gate_matrix_migration.sql'), 'utf8');
  seedsSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

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

describe('clearance type seeds against real Postgres', () => {
  test('the gap is real: the clearance register migration alone leaves every gym with no clearance types', async () => {
    const client = await freshDatabase('ppbf_test_ct_seeds_gap');
    try {
      const { rows } = await client.query(`select count(*)::int as n from pilot.clearance_types`);
      expect(rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  // NEGATIVE CONTROL. If readiness passed here, every other assertion in
  // this file would be worthless.
  test('the readiness check REFUSES a database where the seeds never ran', async () => {
    const client = await freshDatabase('ppbf_test_ct_seeds_readiness_negative');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /CLEARANCE_TYPE_SEEDS_NOT_READY/,
      );
      const { rows } = await client.query(`select count(*)::int as n from pilot.clearance_types`);
      expect(rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('without the clearance register migration the seeds cannot apply at all', async () => {
    const client = await freshDatabase('ppbf_test_ct_seeds_no_table', false);
    try {
      await expect(applyMigrationTransaction(client, seedsSql)).rejects.toThrow(
        /clearance_types|does not exist/,
      );
    } finally {
      await client.end();
    }
  });

  test('every organization that exists gets all four defaults, verbatim', async () => {
    const client = await freshDatabase('ppbf_test_ct_seeds_fresh');
    try {
      await applyMigrationTransaction(client, seedsSql);

      for (const organizationId of [ORG_A, ORG_B]) {
        const rows = await typesFor(client, organizationId);
        expect(rows).toHaveLength(DEFAULT_TYPES.length);
        expect(
          rows.map((row) => ({
            clearance_type_id: row.clearance_type_id,
            name: row.name,
            issuing_authority: row.issuing_authority,
            authority_kind: row.authority_kind,
            validity_months: row.validity_months,
            active: row.active,
          })),
        ).toEqual(
          [...DEFAULT_TYPES]
            .map((type) => ({
              clearance_type_id: type.idFor(organizationId),
              name: type.name,
              issuing_authority: type.issuingAuthority,
              authority_kind: type.authorityKind,
              validity_months: type.validityMonths,
              active: true,
            }))
            .sort((a, b) => a.clearance_type_id.localeCompare(b.clearance_type_id)),
        );
      }
    } finally {
      await client.end();
    }
  });

  test('re-running does not duplicate', async () => {
    const client = await freshDatabase('ppbf_test_ct_seeds_idempotent');
    try {
      await applyMigrationTransaction(client, seedsSql);
      await applyMigrationTransaction(client, seedsSql);
      await applyMigrationTransaction(client, seedsSql);

      const { rows } = await client.query(
        `select organization_id, count(*)::int as n
         from pilot.clearance_types
         group by organization_id
         order by organization_id`,
      );
      expect(rows).toEqual([
        { organization_id: ORG_A, n: DEFAULT_TYPES.length },
        { organization_id: ORG_B, n: DEFAULT_TYPES.length },
      ]);
    } finally {
      await client.end();
    }
  });

  test('an archived default stays archived', async () => {
    const client = await freshDatabase('ppbf_test_ct_seeds_archived');
    try {
      await applyMigrationTransaction(client, seedsSql);
      await client.query(
        `update pilot.clearance_types set active = false
         where organization_id = $1 and name = 'CPR/First Aid'`,
        [ORG_A],
      );

      await applyMigrationTransaction(client, seedsSql);

      const rows = await typesFor(client, ORG_A);
      expect(rows).toHaveLength(DEFAULT_TYPES.length);
      expect(rows.find((row) => row.name === 'CPR/First Aid')?.active).toBe(false);
      const untouched = await typesFor(client, ORG_B);
      expect(untouched.every((row) => row.active)).toBe(true);
    } finally {
      await client.end();
    }
  });

  test('an edited default keeps the gym\'s own authority and validity', async () => {
    const client = await freshDatabase('ppbf_test_ct_seeds_edited');
    try {
      await applyMigrationTransaction(client, seedsSql);
      await client.query(
        `update pilot.clearance_types
         set issuing_authority = 'PPBF Internal Committee', validity_months = 36
         where organization_id = $1 and name = 'Background Check'`,
        [ORG_A],
      );

      await applyMigrationTransaction(client, seedsSql);

      const rows = await typesFor(client, ORG_A);
      expect(rows).toHaveLength(DEFAULT_TYPES.length);
      expect(rows.find((row) => row.name === 'Background Check')).toMatchObject({
        issuing_authority: 'PPBF Internal Committee',
        validity_months: 36,
      });
    } finally {
      await client.end();
    }
  });

  test('a renamed default is not re-created under its original name', async () => {
    const client = await freshDatabase('ppbf_test_ct_seeds_renamed');
    try {
      await applyMigrationTransaction(client, seedsSql);
      await client.query(
        `update pilot.clearance_types set name = 'SafeSport Core Training (PPBF)'
         where organization_id = $1 and name = 'SafeSport Training'`,
        [ORG_A],
      );

      await applyMigrationTransaction(client, seedsSql);

      const rows = await typesFor(client, ORG_A);
      expect(rows).toHaveLength(DEFAULT_TYPES.length);
      expect(rows.map((row) => row.name)).toContain('SafeSport Core Training (PPBF)');
      expect(rows.map((row) => row.name)).not.toContain('SafeSport Training');
    } finally {
      await client.end();
    }
  });

  test('a seeded type is a usable target for a person_clearances row', async () => {
    const client = await freshDatabase('ppbf_test_ct_seeds_usable');
    try {
      await applyMigrationTransaction(client, seedsSql);
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
         values ('acct-ct-seed-coach', 'coach', $1, 'microsoft')`,
        [ORG_A],
      );
      await client.query(
        `insert into pilot.person_clearances
           (organization_id, clearance_id, person_account_id, clearance_type_id, status, document_ref)
         values ($1, 'clr-seeded', 'acct-ct-seed-coach', $2, 'submitted', 'orgA/acct-ct-seed-coach/doc.pdf')`,
        [ORG_A, `ct_safesport_${ORG_A}`],
      );

      const { rows } = await client.query(
        `select ct.name
         from pilot.person_clearances pc
         join pilot.clearance_types ct
           on ct.organization_id = pc.organization_id and ct.clearance_type_id = pc.clearance_type_id
         where pc.clearance_id = 'clr-seeded'`,
      );
      expect(rows).toEqual([{ name: 'SafeSport Training' }]);
    } finally {
      await client.end();
    }
  });

  // The other half of the fix: a gym created through the application gets its
  // clearance types at creation, not at the next migration run.
  test('seeding a newly created organization gives it all four defaults, scoped to itself', async () => {
    const client = await freshDatabase('ppbf_test_ct_seeds_new_org');
    try {
      await applyMigrationTransaction(client, seedsSql);
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status)
         values ('org-brand-new', 'Brand New Gym', 'active')`,
      );
      expect(await typesFor(client, 'org-brand-new')).toHaveLength(0);

      await seedDefaultClearanceTypes('org-brand-new', client as unknown as PoolClient);

      const newOrgRows = await typesFor(client, 'org-brand-new');
      expect(newOrgRows).toHaveLength(DEFAULT_TYPES.length);
      expect(newOrgRows.map((row) => row.name).sort()).toEqual(
        DEFAULT_TYPES.map((type) => type.name).sort(),
      );

      // Organization-scoped: seeding the new org must not touch the two
      // organizations the migration already seeded.
      const orgARows = await typesFor(client, ORG_A);
      expect(orgARows).toHaveLength(DEFAULT_TYPES.length);
      expect(orgARows.every((row) => row.clearance_type_id.endsWith(`_${ORG_A}`))).toBe(true);
    } finally {
      await client.end();
    }
  });

  test('repeat provisioning of a newly created organization does not duplicate', async () => {
    const client = await freshDatabase('ppbf_test_ct_seeds_new_org_idempotent');
    try {
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status)
         values ('org-brand-new-2', 'Brand New Gym Two', 'active')`,
      );

      await seedDefaultClearanceTypes('org-brand-new-2', client as unknown as PoolClient);
      await seedDefaultClearanceTypes('org-brand-new-2', client as unknown as PoolClient);
      await seedDefaultClearanceTypes('org-brand-new-2', client as unknown as PoolClient);

      expect(await typesFor(client, 'org-brand-new-2')).toHaveLength(DEFAULT_TYPES.length);
    } finally {
      await client.end();
    }
  });

  // createOrganization() calls seedDefaultSafetyGates and
  // seedDefaultClearanceTypes with the SAME client, inside the SAME
  // transaction (auth.ts). This exercises that exact pairing against a real
  // Postgres transaction to prove the new call does not disturb the existing
  // safety-gate provisioning it now runs alongside.
  //
  // TRANSACTION_ATOMICITY_PROOF: SOURCE_PROVEN, not TESTED end-to-end. This
  // proves both calls succeed together inside one real transaction and both
  // commit. It does not force a mid-transaction failure and assert a
  // rollback -- no existing project pattern injects a runtime failure into
  // withTransaction without production-only test hooks, and adding one was
  // out of scope for this bounded change. Atomicity on the failure path
  // rests on seedDefaultClearanceTypes receiving and using
  // createOrganization's own transaction client exactly like
  // seedDefaultSafetyGates and seedDefaultComplianceRules already do --
  // visible directly in auth.ts and unchanged by this diff. Compliance-rule
  // provisioning is not re-exercised in this file: it already has its own
  // dedicated regression coverage in complianceRuleSeeds.pg.test.ts, and
  // createOrganization's call to it was not touched by this change.
  test('a newly created organization gets its clearance types alongside its existing safety-gate defaults, in one transaction', async () => {
    const client = await freshDatabase('ppbf_test_ct_seeds_with_safety_gates', true, true);
    try {
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status)
         values ('org-brand-new-3', 'Brand New Gym Three', 'active')`,
      );

      await client.query('BEGIN');
      await seedDefaultSafetyGates('org-brand-new-3', client as unknown as PoolClient);
      await seedDefaultClearanceTypes('org-brand-new-3', client as unknown as PoolClient);
      await client.query('COMMIT');

      expect(await typesFor(client, 'org-brand-new-3')).toHaveLength(DEFAULT_TYPES.length);
      const { rows: gateRows } = await client.query(
        `select gate_key from pilot.safety_gates where organization_id = $1 order by gate_key`,
        ['org-brand-new-3'],
      );
      expect(gateRows.map((row: { gate_key: string }) => row.gate_key)).toEqual([
        'contact_medical_clearance',
        'training_hold',
      ]);
    } finally {
      await client.end();
    }
  });
});
