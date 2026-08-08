// Real PostgreSQL-backed contract test for the drill vocabulary widening
// migration (owner decision, 2026-08-08).
//
// Six things need proving, and none can be proven by reading the SQL:
//
// 1. The two values the archive authors deliberately -- 'literature_grounded_draft'
//    and 'warmup_decay' -- are accepted after the migration and rejected before
//    it. Asserting only the "after" would pass against a migration that dropped
//    the constraints entirely.
// 2. The widening is strictly ADDITIVE: every value the old vocabularies
//    accepted is still accepted, so applying this can never invalidate a row
//    that was already stored.
// 3. The columns are still CONSTRAINED. A migration that dropped the old CHECK
//    and failed to add the new one leaves the column open to anything, which is
//    strictly worse than the narrow constraint it replaced.
// 4. Exactly one CHECK survives per widened column -- a leftover duplicate
//    would silently re-impose the narrow vocabulary.
// 5. Re-running is a no-op, including the drop-then-add loop.
// 6. The readiness check refuses a database where the migration did not land.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-drill-vocab-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-drill-vocabulary-widening-migration.mjs',
);

const ORG = 'org-vocab';

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

/** A database with the drill library applied but NOT yet widened. */
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
  await client.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, name, category, target_behavior, purpose,
        standard_setup, execution, what_good_looks_like, what_bad_looks_like)
     values ($1,'d1','d1','n','c','t','p','s','e','g','b')`,
    [ORG],
  );
  return client;
}

let scaleSeq = 0;
async function insertScale(client: Client, authoringState: string): Promise<void> {
  scaleSeq += 1;
  await client.query(
    `insert into pilot.drill_scale_levels
       (organization_id, scale_id, drill_id, scale_level, is_starting_point, demand_description,
        constraint_applied, contact_level, coach_watch_point, authoring_state)
     values ($1,$2,'d1',$3,false,'d','c','none','w',$4)`,
    [ORG, `sc-${scaleSeq}`, ['A', 'B', 'C'][scaleSeq % 3], authoringState],
  );
}

let ruleSeq = 0;
async function insertRule(client: Client, ruleKind: string): Promise<void> {
  ruleSeq += 1;
  await client.query(
    `insert into pilot.drill_stop_rules
       (organization_id, stop_rule_id, drill_id, ordinal, condition_text, scope, rule_kind)
     values ($1,$2,'d1',$3,'x','universal',$4)`,
    [ORG, `sr-${ruleSeq}`, ruleSeq, ruleKind],
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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  baseSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  drillLibrarySql = await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_drill_library_v3_migration.sql'), 'utf8',
  );
  migrationSql = await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_drill_vocabulary_widening_migration.sql'), 'utf8',
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

describe('before the widening', () => {
  test('the two archive values are rejected', async () => {
    const client = await freshDatabase('ppbf_vocab_before');
    try {
      await expect(insertScale(client, 'literature_grounded_draft')).rejects.toThrow(/authoring_state/);
      await expect(insertRule(client, 'warmup_decay')).rejects.toThrow(/rule_kind/);
    } finally {
      await client.end();
    }
  });
});

describe('after the widening', () => {
  let client: Client;

  beforeAll(async () => {
    client = await freshDatabase('ppbf_vocab_after');
    await applyMigrationTransaction(client, migrationSql);
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  test('accepts the two values the archive authors deliberately', async () => {
    await expect(insertScale(client, 'literature_grounded_draft')).resolves.toBeUndefined();
    await expect(insertRule(client, 'warmup_decay')).resolves.toBeUndefined();
  });

  test('still accepts every value the old vocabularies accepted', async () => {
    // The widening must be strictly additive: a row already stored under the
    // old vocabulary can never be invalidated by applying this.
    for (const state of ['authored', 'scaffold_needs_coach_review']) {
      await expect(insertScale(client, state)).resolves.toBeUndefined();
    }
    for (const kind of ['technique_degradation', 'fatigue', 'safety', 'intent_drift', 'coach_judgment']) {
      await expect(insertRule(client, kind)).resolves.toBeUndefined();
    }
  });

  test('the columns are still constrained, not merely unlocked', async () => {
    // Dropping the old CHECK without adding the new one would pass every test
    // above while leaving the column open to anything at all.
    await expect(insertScale(client, 'whatever_i_like')).rejects.toThrow(/authoring_state/);
    await expect(insertRule(client, 'whatever_i_like')).rejects.toThrow(/rule_kind/);
  });

  test('exactly one CHECK survives per widened column', async () => {
    const scale = await client.query(
      `select count(*)::int as n from pg_constraint con
       join pg_class rel on rel.oid = con.conrelid
       join pg_namespace nsp on nsp.oid = rel.relnamespace
       where nsp.nspname='pilot' and rel.relname='drill_scale_levels'
         and con.contype='c' and pg_get_constraintdef(con.oid) ilike '%authoring_state%'`,
    );
    const rules = await client.query(
      `select count(*)::int as n from pg_constraint con
       join pg_class rel on rel.oid = con.conrelid
       join pg_namespace nsp on nsp.oid = rel.relnamespace
       where nsp.nspname='pilot' and rel.relname='drill_stop_rules'
         and con.contype='c' and pg_get_constraintdef(con.oid) ilike '%rule_kind%'`,
    );
    expect(scale.rows[0].n).toBe(1);
    expect(rules.rows[0].n).toBe(1);
  });
});

describe('migration mechanics', () => {
  test('re-running is a no-op, and does not accumulate constraints', async () => {
    const client = await freshDatabase('ppbf_vocab_idempotent');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      const result = await client.query(
        `select count(*)::int as n from pg_constraint
         where conname in ('pilot_drill_scale_authoring_state_check','pilot_drill_stop_rule_kind_check')`,
      );
      expect(result.rows[0].n).toBe(2);
      await expect(insertScale(client, 'literature_grounded_draft')).resolves.toBeUndefined();
    } finally {
      await client.end();
    }
  });

  test('the readiness check REFUSES a database where the drill library never landed', async () => {
    const admin = new Client({ connectionString: connectionStringFor('postgres') });
    await admin.connect();
    await admin.query('drop database if exists ppbf_vocab_bare');
    await admin.query('create database ppbf_vocab_bare');
    await admin.end();

    const client = new Client({ connectionString: connectionStringFor('ppbf_vocab_bare') });
    await client.connect();
    try {
      await client.query(baseSql);
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow(
        /DRILL_VOCAB_WIDENING_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the readiness check REFUSES a no-op migration that changed nothing', async () => {
    const client = await freshDatabase('ppbf_vocab_noop');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /DRILL_VOCAB_WIDENING_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });
});
