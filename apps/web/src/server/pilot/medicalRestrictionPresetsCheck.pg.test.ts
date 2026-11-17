// Real PostgreSQL-backed test for pilot-check-medical-restriction-presets.mjs
// (lane DFX-count; OD-2026-11-17-009, the 14:02 note's count request).
//
// Spins up a disposable, local-only embedded Postgres (scripts/test-embedded-pg-server.mjs).
// This NEVER connects to production or staging.
//
// What it pins down:
//   * the three counts are right on a spread of rows (both pre-set values,
//     voided and not; one value only; neither);
//   * the printed report is the counts and fixed words, and NOTHING from a row
//     (no athlete, organization, restriction or account id, no note, incident,
//     date or void reason), proven on the script run as a separate process the
//     way run-checks.yml runs it;
//   * a database without the table says "table not present", never 0;
//   * the only statements sent are the READ ONLY begin, one SELECT and the
//     rollback, and Postgres refuses a write inside that transaction.

import { type ChildProcessByStdio, spawn, spawnSync } from 'node:child_process';
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-medical-restriction-presets-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const CHECKER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/pilot-check-medical-restriction-presets.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

// ts-jest would downlevel a plain import() of an .mjs into require(); this keeps it a real dynamic import.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

type PresetsResult =
  | { tablePresent: false }
  | { tablePresent: true; totalRecords: number; bothPresetValues: number; bothPresetValuesNotVoided: number };
let checkMedicalRestrictionPresets: (client: Client) => Promise<PresetsResult>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;

// Every value a row carries is a sentinel, so the output test can look for each one.
const ORG_ID = 'org-presets-sentinel';
const COACH_ID = 'acct-presets-coach-sentinel';
const ADMIN_ID = 'acct-presets-admin-sentinel';
const ATHLETE_ID = 'ath-presets-sentinel';
const NOTE = 'note-presets-sentinel';
const INCIDENT = 'incident-presets-sentinel';
const VOID_REASON = 'void-presets-sentinel';
const START = '2026-10-07';
const END = '2026-11-21';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
const restrictionIds: string[] = [];

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

async function newDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

async function seededDatabase(name: string): Promise<Client> {
  const client = await newDatabase(name);
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id)
     values ($1, 'coach', $3, 'microsoft', null), ($2, 'organization_admin', $3, 'microsoft', null)`,
    [COACH_ID, ADMIN_ID, ORG_ID],
  );
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Test Member', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );

  // [source, loss_of_consciousness, voided]
  const spread: ReadonlyArray<readonly [string, string, boolean]> = [
    ['ringside_affidavit', 'none', false],
    ['ringside_affidavit', 'none', false],
    ['ringside_affidavit', 'none', true],
    ['ringside_affidavit', 'unknown', false],
    ['other', 'none', false],
    ['training_knockout_or_concussion', 'over_1_min', true],
  ];
  for (const [source, loc, voided] of spread) {
    const { rows } = await client.query<{ restriction_id: string }>(
      `insert into pilot.medical_restrictions
         (organization_id, restriction_id, athlete_id, source, loss_of_consciousness, start_date, minimum_end_date,
          linked_incident_id, note, recorded_by_account_id, recorded_by_role,
          voided_at, voided_by_account_id, voided_by_role, void_reason)
       values ($1, gen_random_uuid(), $2, $3, $4, $5::date, $6::date, $7, $8, $9, 'coach',
               case when $10 then now() end, case when $10 then $11 end,
               case when $10 then 'organization_admin' end, case when $10 then $12 end)
       returning restriction_id::text`,
      [ORG_ID, ATHLETE_ID, source, loc, START, END, INCIDENT, NOTE, COACH_ID, voided, ADMIN_ID, VOID_REASON],
    );
    restrictionIds.push(rows[0].restriction_id);
  }
  return client;
}

function runScript(database: string) {
  return spawnSync(process.execPath, [CHECKER_SCRIPT_PATH], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      NODE_ENV: 'test',
      PPBF_POSTGRES_DISABLE_SSL: 'true',
      AZURE_POSTGRES_CONNECTION_STRING: connectionStringFor(database),
    },
    timeout: 60_000,
  });
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

  const checker = await nativeDynamicImport(pathToFileURL(CHECKER_SCRIPT_PATH).href);
  checkMedicalRestrictionPresets = checker.checkMedicalRestrictionPresets as typeof checkMedicalRestrictionPresets;
  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
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

describe('with the table present', () => {
  const DB = 'medres_presets_seeded';
  let client: Client;

  beforeAll(async () => {
    client = await seededDatabase(DB);
  });

  afterAll(async () => {
    await client.end();
  });

  test('counts all records, both pre-set values, and both pre-set values not voided', async () => {
    await expect(checkMedicalRestrictionPresets(client)).resolves.toEqual({
      tablePresent: true,
      totalRecords: 6,
      bothPresetValues: 3,
      bothPresetValuesNotVoided: 2,
    });
  });

  test('sends only the READ ONLY begin, one SELECT and the rollback', async () => {
    const sent: string[] = [];
    const recording = {
      query: (text: string, values?: unknown[]) => {
        sent.push(text.trim().split(/\s+/)[0].toUpperCase());
        return client.query(text, values);
      },
    } as unknown as Client;
    await checkMedicalRestrictionPresets(recording);
    expect(sent).toEqual(['BEGIN', 'SELECT', 'ROLLBACK']);
  });

  test('Postgres refuses a write inside the transaction the check opens', async () => {
    let refusal: unknown;
    const writing = {
      query: async (text: string, values?: unknown[]) => {
        const result = await client.query(text, values);
        if (/^select/i.test(text.trim())) {
          await client.query(`delete from pilot.medical_restrictions`).catch((error: unknown) => {
            refusal = error;
          });
        }
        return result;
      },
    } as unknown as Client;
    await checkMedicalRestrictionPresets(writing).catch(() => {});
    expect((refusal as { code?: string } | undefined)?.code).toBe('25006'); // read_only_sql_transaction
    const { rows } = await client.query<{ n: number }>('select count(*)::int as n from pilot.medical_restrictions');
    expect(rows[0].n).toBe(6);
  });

  test('the printed report is the counts and fixed words, with nothing from any row', () => {
    const run = runScript(DB);
    expect(run.status).toBe(0);
    expect(run.stdout.trimEnd().split(/\r?\n/)).toEqual([
      'USA Boxing medical restriction pre-set values check',
      '==================================================',
      'total_records: 6',
      'both_preset_values: 3',
      'both_preset_values_not_voided: 2',
      '',
      `"Records holding both pre-set values" means source = 'ringside_affidavit' and loss_of_consciousness = 'none'.`,
      'A count cannot tell a skipped field from a chosen one.',
    ]);
    expect(run.stderr).toBe('');
    const everything = `${run.stdout}\n${run.stderr}`;
    for (const value of [ORG_ID, COACH_ID, ADMIN_ID, ATHLETE_ID, NOTE, INCIDENT, VOID_REASON, START, END, 'Test Member', ...restrictionIds]) {
      expect(everything).not.toContain(value);
    }
  });
});

describe('without the table', () => {
  const DB = 'medres_presets_no_table';
  let client: Client;

  beforeAll(async () => {
    client = await newDatabase(DB);
    await client.query('create schema pilot');
  });

  afterAll(async () => {
    await client.end();
  });

  test('reports the table as not present, never a count of 0', async () => {
    await expect(checkMedicalRestrictionPresets(client)).resolves.toEqual({ tablePresent: false });
    const run = runScript(DB);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('pilot.medical_restrictions: table not present');
    expect(run.stdout).not.toMatch(/\b0\b/);
  });
});

test('refuses to run without a connection string, and never falls back to apps/web/.env.local', () => {
  const run = spawnSync(process.execPath, [CHECKER_SCRIPT_PATH], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'test' },
    timeout: 60_000,
  });
  expect(run.status).toBe(1);
  expect(run.stdout).toBe('');
  expect(run.stderr).toContain('MEDICAL RESTRICTION PRE-SET VALUES CHECK FAILED TO RUN');
});

test('the script has no way to read a file, so it cannot load apps/web/.env.local (which points at production on the build PC)', async () => {
  const source = await fs.readFile(CHECKER_SCRIPT_PATH, 'utf8');
  expect(source).not.toMatch(/from ['"](node:)?fs(\/promises)?['"]/);
  expect(source).not.toMatch(/require\(\s*['"](node:)?fs/);
  expect(source).not.toMatch(/import\(\s*['"](node:)?fs/);
  expect(source).not.toMatch(/loadEnvFile|\bdotenv\b/);
});

test('a connection that fails prints the error class and SQLSTATE only, never the user, database or host', async () => {
  const closedPort = await findFreePort();
  const run = spawnSync(process.execPath, [CHECKER_SCRIPT_PATH], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      NODE_ENV: 'test',
      PPBF_POSTGRES_DISABLE_SSL: 'true',
      AZURE_POSTGRES_CONNECTION_STRING: `postgres://user-presets-sentinel:pw-presets-sentinel@127.0.0.1:${closedPort}/db-presets-sentinel`,
    },
    timeout: 60_000,
  });
  expect(run.status).toBe(1);
  expect(run.stdout).toBe('');
  expect(run.stderr).toContain('MEDICAL RESTRICTION PRE-SET VALUES CHECK FAILED TO RUN');
  for (const value of ['user-presets-sentinel', 'pw-presets-sentinel', 'db-presets-sentinel', String(closedPort), '127.0.0.1']) {
    expect(run.stderr).not.toContain(value);
  }
});
