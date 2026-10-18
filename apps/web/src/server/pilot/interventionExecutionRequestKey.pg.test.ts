// Real PostgreSQL contract test for
// pilot_slice_postgres_intervention_execution_request_key_migration.sql (finding F-135, lane L55).
//
// What needs a real database to prove: that a request key names at most one execution in a gym
// and the same key in another gym is a different key; that executions sent without a key are
// unlimited and compared for nothing; that a key is refused blank, all spaces, or over 200
// characters; that a row written before the migration keeps NULL; that re-applying the file is a
// no-op; that the file holds nothing destructive; and that the runner's readiness assertion
// refuses a result it did not produce. Spins up the disposable local embedded Postgres the other
// migration suites use. It never connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-intervention-request-key-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-intervention-execution-request-key-migration.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const MIGRATION_FILE = 'pilot_slice_postgres_intervention_execution_request_key_migration.sql';
const INDEX = 'pilot_intervention_executions_one_per_request_key';
const CHECK = 'pilot_intervention_executions_request_key_check';

const ORG = 'org-ikey';
const OTHER_ORG = 'org-ikey-other';
const COACH = 'acct-ikey-coach';
const OTHER_COACH = 'acct-ikey-other-coach';
const ATHLETE = 'ATH-IKEY-1';
const PROTOCOL = 'proto-ikey';

type Apply = (client: Client, sql: string) => Promise<void>;

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let applyRunner: Apply;
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
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function freshDatabase(name: string, schema: 'full' | 'none' = 'full'): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  if (schema === 'none') return client;

  // The whole schema in the `all` order, which now includes this migration.
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  for (const [org, coach] of [[ORG, COACH], [OTHER_ORG, OTHER_COACH]]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [org],
    );
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'coach', $2, 'microsoft')`,
      [coach, org],
    );
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Key Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())`,
      [org, ATHLETE, coach],
    );
    await client.query(
      `insert into pilot.intervention_protocols
         (organization_id, protocol_id, lineage_id, version, title, target_problem, hypothesis,
          intervention_description, expected_outcome, created_by_account_id)
       values ($1, $2, $2, 1, 'Round-3 endurance block', 'fades in round 3',
               'aerobic capacity limits round 3 output', 'constrained 3-round intervals',
               'round-3 work rate holds', $3)`,
      [org, PROTOCOL, coach],
    );
  }
  return client;
}

/** Starts one execution the way startExecution writes it, with the given key (or none). */
async function insertExecution(client: Client, org: string, requestKey: string | null): Promise<string> {
  const executionId = randomUUID();
  const coach = org === ORG ? COACH : OTHER_COACH;
  await client.query(
    `insert into pilot.intervention_executions
       (organization_id, execution_id, lineage_id, version, athlete_id, protocol_id, protocol_version,
        recorded_by_account_id, request_key)
     values ($1, $2, $2, 1, $3, $4, 1, $5, $6)`,
    [org, executionId, ATHLETE, PROTOCOL, coach, requestKey],
  );
  return executionId;
}

async function refusal(promise: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; constraint?: string };
  }
  throw new Error('expected the write to be refused');
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

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
  applyRunner = (await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href)).applyMigrationTransaction as Apply;
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
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

describe('intervention execution request key migration (F-135)', () => {
  test('a key names at most one execution in a gym; re-applying through the runner keeps it so', async () => {
    const client = await freshDatabase('ikey_one_per_gym');
    try {
      const key = randomUUID();
      const first = await insertExecution(client, ORG, key);
      await applyRunner(client, migrationSql);
      await applyRunner(client, migrationSql);

      const second = await refusal(insertExecution(client, ORG, key));
      expect(second.code).toBe('23505');
      expect(second.constraint).toBe(INDEX);

      const rows = await client.query(
        'select execution_id from pilot.intervention_executions where organization_id = $1 and request_key = $2',
        [ORG, key],
      );
      expect(rows.rows).toEqual([{ execution_id: first }]);
    } finally {
      await client.end();
    }
  });

  test('the same key in another gym is a different key', async () => {
    const client = await freshDatabase('ikey_other_gym');
    try {
      const key = randomUUID();
      await insertExecution(client, ORG, key);
      await insertExecution(client, OTHER_ORG, key);
      const count = await client.query('select count(*)::int as n from pilot.intervention_executions where request_key = $1', [key]);
      expect(count.rows[0].n).toBe(2);
    } finally {
      await client.end();
    }
  });

  test('executions sent without a key are unlimited', async () => {
    const client = await freshDatabase('ikey_no_key');
    try {
      await insertExecution(client, ORG, null);
      await insertExecution(client, ORG, null);
      await insertExecution(client, ORG, null);
      const count = await client.query(
        'select count(*)::int as n from pilot.intervention_executions where organization_id = $1 and request_key is null',
        [ORG],
      );
      expect(count.rows[0].n).toBe(3);
    } finally {
      await client.end();
    }
  });

  test('a key is refused blank, all spaces, or over 200 characters; 200 is kept as sent', async () => {
    const client = await freshDatabase('ikey_limits');
    try {
      for (const bad of ['', '   ', 'k'.repeat(201)]) {
        const refused = await refusal(insertExecution(client, ORG, bad));
        expect(refused.code).toBe('23514');
        expect(refused.constraint).toBe(CHECK);
      }
      const longest = ` ${'k'.repeat(198)} `;
      const executionId = await insertExecution(client, ORG, longest);
      const row = await client.query(
        'select request_key from pilot.intervention_executions where organization_id = $1 and execution_id = $2',
        [ORG, executionId],
      );
      expect(row.rows[0].request_key).toBe(longest);
    } finally {
      await client.end();
    }
  });

  test('an execution written before the migration keeps a NULL key', async () => {
    const client = await freshDatabase('ikey_before');
    try {
      // The schema as it stood before this file: the column (and with it the check and the
      // index) is not there.
      await client.query('alter table pilot.intervention_executions drop column request_key');
      const executionId = randomUUID();
      await client.query(
        `insert into pilot.intervention_executions
           (organization_id, execution_id, lineage_id, version, athlete_id, protocol_id, protocol_version,
            recorded_by_account_id)
         values ($1, $2, $2, 1, $3, $4, 1, $5)`,
        [ORG, executionId, ATHLETE, PROTOCOL, COACH],
      );

      await applyRunner(client, migrationSql);

      const row = await client.query(
        'select request_key from pilot.intervention_executions where organization_id = $1 and execution_id = $2',
        [ORG, executionId],
      );
      expect(row.rows).toEqual([{ request_key: null }]);
    } finally {
      await client.end();
    }
  });

  test('the file holds nothing destructive: its one drop is its own check, re-added', async () => {
    const sql = migrationSql.toLowerCase().replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bdrop\s+(table|column|index|schema|function|trigger)\b/);
    expect(sql).not.toMatch(/\btruncate\b/);
    expect(sql).not.toMatch(/\bdelete\s+from\b/);
    expect(sql).not.toMatch(/\bupdate\s+pilot\./);
    expect(sql.match(/\bdrop\s+constraint\s+if\s+exists\s+(\w+)/g)).toEqual([`drop constraint if exists ${CHECK}`]);
    expect(sql).toMatch(new RegExp(`add constraint ${CHECK}\\b`));
  });

  test('the runner refuses a same-named index that is not unique', async () => {
    const client = await freshDatabase('ikey_index_plain');
    try {
      // The file's if-not-exists keeps an index built earlier under this name, so only readiness
      // can say it is wrong.
      await client.query(`drop index pilot.${INDEX}`);
      await client.query(
        `create index ${INDEX} on pilot.intervention_executions(organization_id, request_key) where request_key is not null`,
      );
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('INTERVENTION_EXECUTION_REQUEST_KEY_NOT_READY: index_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a same-named unique index over the key alone, or without the partial predicate', async () => {
    const client = await freshDatabase('ikey_index_shape');
    try {
      await client.query(`drop index pilot.${INDEX}`);
      await client.query(`create unique index ${INDEX} on pilot.intervention_executions(request_key) where request_key is not null`);
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('INTERVENTION_EXECUTION_REQUEST_KEY_NOT_READY: index_ready');

      await client.query(`drop index pilot.${INDEX}`);
      await client.query(`create unique index ${INDEX} on pilot.intervention_executions(organization_id, request_key)`);
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('INTERVENTION_EXECUTION_REQUEST_KEY_NOT_READY: index_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a result without the check', async () => {
    const client = await freshDatabase('ikey_check_missing');
    try {
      await expect(
        applyRunner(client, `alter table pilot.intervention_executions drop constraint ${CHECK}`),
      ).rejects.toThrow('INTERVENTION_EXECUTION_REQUEST_KEY_NOT_READY: check_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a pre-existing request_key column that is NOT NULL', async () => {
    const client = await freshDatabase('ikey_column_not_null');
    try {
      await client.query('alter table pilot.intervention_executions drop column request_key');
      await client.query(`alter table pilot.intervention_executions add column request_key text not null default 'k'`);
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('INTERVENTION_EXECUTION_REQUEST_KEY_NOT_READY: column_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a result it did not produce', async () => {
    // An empty database: "applying" a statement that creates nothing must not commit.
    const client = await freshDatabase('ikey_not_ready', 'none');
    try {
      await expect(applyRunner(client, 'select 1')).rejects.toThrow('INTERVENTION_EXECUTION_REQUEST_KEY_NOT_READY');
    } finally {
      await client.end();
    }
  });
});
