// Real PostgreSQL-backed contract test for the drill owner-authored label
// migration (OD-2026-10-06-026 ruling 4: "PPBF owner-authored").
//
// What has to be proven, and none of it by reading the SQL:
//
// 1. 'PPBF owner-authored' is rejected before the migration and accepted after.
//    Asserting only the "after" would pass against a migration that dropped the
//    constraint entirely.
// 2. Strictly ADDITIVE: the three values the old CHECK accepted still are, and
//    a row stored under one of them is not relabelled.
// 3. The column is still CONSTRAINED, under the SAME constraint name the v3
//    runner, vocabularies.ts and its pg mirror address.
// 4. Exactly one CHECK survives, re-running is a no-op, and re-running the v3
//    migration afterwards (an `all` rebuild) does not put the narrow list back.
// 5. The readiness check refuses a database where the migration did not land.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-drill-owner-label-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-drill-owner-authored-label-migration.mjs',
);

const ORG = 'org-label';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSql: string;
let drillLibrarySql: string;
let migrationSql: string;
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
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/** A database with the drill library applied but the label NOT yet added. */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSql);
  await client.query(drillLibrarySql);
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1,$1,'active')`,
    [ORG],
  );
  return client;
}

const SOURCE_MANUAL = 'PPBF source manual v3';
const LITERATURE_DRAFT =
  'LITERATURE-GROUNDED DRAFT — generated from cited registry claims; REQUIRES FLOOR VALIDATION';
const CRAFT_DRAFT = 'COACHING-CRAFT DRAFT — no directly relevant research retrieved; REQUIRES FLOOR VALIDATION';
const OWNER_AUTHORED = 'PPBF owner-authored';

let drillSeq = 0;
async function insertDrill(client: Client, fieldProvenance: string): Promise<string> {
  drillSeq += 1;
  const id = `d-${drillSeq}`;
  await client.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, name, category, target_behavior, purpose,
        standard_setup, execution, what_good_looks_like, what_bad_looks_like, field_provenance)
     values ($1,$2,$2,$2,'c','t','p','s','e','g','b',$3)`,
    [ORG, id, fieldProvenance],
  );
  return id;
}

async function provenanceChecks(client: Client): Promise<{ conname: string; def: string; convalidated: boolean }[]> {
  const result = await client.query<{ conname: string; def: string; convalidated: boolean }>(
    `select con.conname, pg_get_constraintdef(con.oid) as def, con.convalidated
     from pg_constraint con
     join pg_class rel on rel.oid = con.conrelid
     join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'pilot' and rel.relname = 'drill_library'
       and con.contype = 'c' and pg_get_constraintdef(con.oid) ilike '%field_provenance%'`,
  );
  return result.rows;
}

describe('before the label', () => {
  test('PPBF owner-authored is rejected by the v3 CHECK', async () => {
    const client = await freshDatabase('ppbf_label_before');
    try {
      await expect(insertDrill(client, OWNER_AUTHORED)).rejects.toMatchObject({ code: '23514' });
      await expect(insertDrill(client, SOURCE_MANUAL)).resolves.toBeDefined();
    } finally {
      await client.end();
    }
  });
});

describe('after the label', () => {
  test('accepts PPBF owner-authored, still accepts the three old values, and nothing else', async () => {
    const client = await freshDatabase('ppbf_label_after');
    try {
      await applyMigrationTransaction(client, migrationSql);

      await expect(insertDrill(client, OWNER_AUTHORED)).resolves.toBeDefined();
      await expect(insertDrill(client, SOURCE_MANUAL)).resolves.toBeDefined();
      await expect(insertDrill(client, LITERATURE_DRAFT)).resolves.toBeDefined();
      await expect(insertDrill(client, CRAFT_DRAFT)).resolves.toBeDefined();
      // Still constrained: a paraphrase is a refusal, as before.
      await expect(insertDrill(client, 'PPBF Owner Authored')).rejects.toMatchObject({ code: '23514' });
      await expect(insertDrill(client, '')).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });

  test('a row stored under a draft label before the migration is not relabelled', async () => {
    const client = await freshDatabase('ppbf_label_rows_untouched');
    try {
      const draft = await insertDrill(client, LITERATURE_DRAFT);
      const craft = await insertDrill(client, CRAFT_DRAFT);
      const manual = await insertDrill(client, SOURCE_MANUAL);
      await applyMigrationTransaction(client, migrationSql);

      const rows = await client.query<{ drill_id: string; field_provenance: string }>(
        `select drill_id, field_provenance from pilot.drill_library`,
      );
      expect(rows.rows).toHaveLength(3);
      expect(rows.rows).toEqual(expect.arrayContaining([
        { drill_id: draft, field_provenance: LITERATURE_DRAFT },
        { drill_id: craft, field_provenance: CRAFT_DRAFT },
        { drill_id: manual, field_provenance: SOURCE_MANUAL },
      ]));
    } finally {
      await client.end();
    }
  });

  test('exactly one CHECK governs the column, under the name every reader addresses', async () => {
    const client = await freshDatabase('ppbf_label_single_check');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const checks = await provenanceChecks(client);
      expect(checks).toHaveLength(1);
      expect(checks[0].conname).toBe('pilot_drill_library_field_provenance_check');
      expect(checks[0].def).toContain(OWNER_AUTHORED);
      // Validated, not NOT VALID: existing rows were checked when it was added.
      expect(checks[0].convalidated).toBe(true);
    } finally {
      await client.end();
    }
  });

  test('re-applying the v3 migration afterwards (an all-list rebuild) keeps the widened list', async () => {
    const client = await freshDatabase('ppbf_label_v3_rerun');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await client.query(drillLibrarySql);
      await expect(insertDrill(client, OWNER_AUTHORED)).resolves.toBeDefined();
      expect(await provenanceChecks(client)).toHaveLength(1);
    } finally {
      await client.end();
    }
  });
});

describe('migration mechanics', () => {
  test('re-running is a no-op, and does not accumulate constraints', async () => {
    const client = await freshDatabase('ppbf_label_idempotent');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
      expect(await provenanceChecks(client)).toHaveLength(1);
      await expect(insertDrill(client, OWNER_AUTHORED)).resolves.toBeDefined();
    } finally {
      await client.end();
    }
  });

  test('the readiness check REFUSES a database where the drill library never landed', async () => {
    const admin = new Client({ connectionString: connectionStringFor('postgres') });
    await admin.connect();
    await admin.query('drop database if exists ppbf_label_bare');
    await admin.query('create database ppbf_label_bare');
    await admin.end();

    const client = new Client({ connectionString: connectionStringFor('ppbf_label_bare') });
    await client.connect();
    try {
      await client.query(baseSql);
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow(
        /DRILL_OWNER_AUTHORED_LABEL_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the readiness check REFUSES a no-op migration that changed nothing', async () => {
    const client = await freshDatabase('ppbf_label_noop');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /DRILL_OWNER_AUTHORED_LABEL_NOT_READY/,
      );
      // And the narrow v3 list is still in force: nothing was dropped on the way out.
      await expect(insertDrill(client, OWNER_AUTHORED)).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });
});

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

  baseSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  drillLibrarySql = await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_drill_library_v3_migration.sql'), 'utf8',
  );
  migrationSql = await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_drill_owner_authored_label_migration.sql'), 'utf8',
  );

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as typeof applyMigrationTransaction;
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
    const safetyTimer = setTimeout(finish, 10_000);
    serverProcess.once('exit', finish);
    serverProcess.kill('SIGTERM');
  });
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

