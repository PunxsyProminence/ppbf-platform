// Real PostgreSQL-backed contract test for the assessment protocols
// migration (pilot.assessment_protocols, additive columns on
// pilot.assessments, pilot.data_collection_requests) and for
// assessmentProtocols.ts's functions running against a real transaction.
//
// Five things need proving, and none can be proven by reading SQL or by a
// mocked-query unit test:
//
// 1. pilot_assessments_protocol_fk actually holds: an assessment cannot
//    name a (protocol_id, protocol_version) pair that does not exist.
// 2. pilot_assessments_due (the partial index on due_on where
//    administered_on is null) means listDueAssessments returns only
//    un-administered rows -- an administered assessment past its due date
//    must not appear.
// 3. status='captured' without captured_at is rejected at the database
//    level (pilot_dcr_captured), and captureDataCollectionRequest always
//    stamps both fields together.
// 4. The open queue is ordered by priority then due date, and excludes
//    non-open requests.
// 5. The readiness check actually fails when the migration did not land.
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

let activeClient: Client | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows[0] ?? null;
  }),
}));

import {
  captureDataCollectionRequest,
  createDataCollectionRequest,
  declineDataCollectionRequest,
  listDueAssessments,
  listOpenDataCollectionRequests,
} from './assessmentProtocols';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-assessment-protocols-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_assessment_protocols_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-assessment-protocols-migration.mjs',
);

const ORG_A = 'org-assessproto-a';
const ATHLETE_A = 'athlete-assessproto-a';
const COACH_A = 'acct-assessproto-coach-a';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let baseSchemaSql: string;
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
    [ORG_A],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_A, ORG_A],
  );
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag,
        coach_id, created_at, updated_at)
     values ($1,$2,'Athlete A','2010-01-01','120lb','active','Contact',true,$3,now(),now())
     on conflict do nothing`,
    [ORG_A, ATHLETE_A, COACH_A],
  );

  activeClient = client;
  return client;
}

async function insertProtocol(
  client: Client,
  opts: { protocolId: string; protocolVersion?: number; name: string },
): Promise<void> {
  await client.query(
    `insert into pilot.assessment_protocols
       (organization_id, protocol_id, protocol_version, name, measure_kind, quality_measured, protocol_summary)
     values ($1,$2,$3,$4,'physical_test','A quality.','A summary.')`,
    [ORG_A, opts.protocolId, opts.protocolVersion ?? 1, opts.name],
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

describe('assessment protocols migration readiness against real Postgres', () => {
  test('the readiness check REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('ppbf_test_assessproto_readiness_negative');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /ASSESSMENT_PROTOCOLS_NOT_READY/,
      );
      const table = await client.query(`select to_regclass('pilot.assessment_protocols') as t`);
      expect(table.rows[0].t).toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('re-running is a no-op: no duplicate constraints or columns', async () => {
    const client = await freshDatabase('ppbf_test_assessproto_idempotent');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      const columns = await client.query(
        `select count(*)::int as n from information_schema.columns
         where table_schema = 'pilot' and table_name = 'assessments' and column_name = 'protocol_id'`,
      );
      expect(columns.rows[0].n).toBe(1);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot_assessments_protocol_fk', () => {
  test('an assessment naming a nonexistent (protocol_id, protocol_version) is rejected', async () => {
    const client = await freshDatabase('ppbf_test_assessproto_fk_reject');
    try {
      await applyMigrationTransaction(client, migrationSql);

      await expect(
        client.query(
          `insert into pilot.assessments
             (organization_id, assessment_id, athlete_id, assessor_account_id, assessment_type, result,
              protocol_id, protocol_version)
           values ($1,gen_random_uuid(),$2,$3,'physical_test','{}'::jsonb,$4,$5)`,
          [ORG_A, ATHLETE_A, COACH_A, 'protocol-does-not-exist', 1],
        ),
      ).rejects.toThrow(/pilot_assessments_protocol_fk|foreign key/);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('an assessment naming a real (protocol_id, protocol_version) is accepted', async () => {
    const client = await freshDatabase('ppbf_test_assessproto_fk_accept');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertProtocol(client, { protocolId: 'protocol-cmj', name: 'Countermovement Jump' });

      const inserted = await client.query(
        `insert into pilot.assessments
           (organization_id, assessment_id, athlete_id, assessor_account_id, assessment_type, result,
            protocol_id, protocol_version)
         values ($1,gen_random_uuid(),$2,$3,'physical_test','{"cm": 32}'::jsonb,'protocol-cmj',1)
         returning assessment_id`,
        [ORG_A, ATHLETE_A, COACH_A],
      );

      const { rows } = await client.query(`select assessment_id from pilot.assessments where organization_id = $1`, [ORG_A]);
      expect(rows).toEqual([{ assessment_id: inserted.rows[0].assessment_id }]);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot_assessments_due partial index', () => {
  test('listDueAssessments returns only un-administered rows past due', async () => {
    const client = await freshDatabase('ppbf_test_assessproto_due');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertProtocol(client, { protocolId: 'protocol-cmj', name: 'Countermovement Jump' });

      const due = await client.query(
        `insert into pilot.assessments
           (organization_id, assessment_id, athlete_id, assessor_account_id, assessment_type, result,
            protocol_id, protocol_version, due_on, administered_on)
         values ($1,gen_random_uuid(),$2,$3,'physical_test','{}'::jsonb,'protocol-cmj',1,'2026-01-01', null)
         returning assessment_id`,
        [ORG_A, ATHLETE_A, COACH_A],
      );
      await client.query(
        `insert into pilot.assessments
           (organization_id, assessment_id, athlete_id, assessor_account_id, assessment_type, result,
            protocol_id, protocol_version, due_on, administered_on)
         values ($1,gen_random_uuid(),$2,$3,'physical_test','{}'::jsonb,'protocol-cmj',1,'2026-01-01','2026-01-01')`,
        [ORG_A, ATHLETE_A, COACH_A],
      );
      await client.query(
        `insert into pilot.assessments
           (organization_id, assessment_id, athlete_id, assessor_account_id, assessment_type, result,
            protocol_id, protocol_version, due_on, administered_on)
         values ($1,gen_random_uuid(),$2,$3,'physical_test','{}'::jsonb,'protocol-cmj',1,'2099-01-01', null)`,
        [ORG_A, ATHLETE_A, COACH_A],
      );

      const dueRows = await listDueAssessments(ORG_A, { asOf: '2026-08-07' });
      expect(dueRows.map((row) => row.assessment_id)).toEqual([due.rows[0].assessment_id]);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot_dcr_captured', () => {
  test('status=captured without captured_at is rejected at the database level', async () => {
    const client = await freshDatabase('ppbf_test_assessproto_dcr_captured_check');
    try {
      await applyMigrationTransaction(client, migrationSql);

      await expect(
        client.query(
          `insert into pilot.data_collection_requests
             (organization_id, request_id, athlete_id, request_kind, prompt_text, reason_code, status)
           values ($1,'dcr-bad',$2,'photo','Take a photo.','coach_requested','captured')`,
          [ORG_A, ATHLETE_A],
        ),
      ).rejects.toThrow(/pilot_dcr_captured/);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('captureDataCollectionRequest always stamps captured_at and captured_by_account_id together', async () => {
    const client = await freshDatabase('ppbf_test_assessproto_capture_function');
    try {
      await applyMigrationTransaction(client, migrationSql);

      const created = await createDataCollectionRequest({
        organizationId: ORG_A,
        athleteId: ATHLETE_A,
        requestKind: 'photo',
        promptText: 'Take a form-check photo.',
        reasonCode: 'coach_requested',
      });

      const captured = await captureDataCollectionRequest({
        organizationId: ORG_A,
        requestId: created.request_id,
        capturedByAccountId: COACH_A,
        mediaRef: 'blob://photo-1',
      });

      expect(captured.status).toBe('captured');
      expect(captured.captured_at).not.toBeNull();
      expect(captured.captured_by_account_id).toBe(COACH_A);
      expect(captured.media_ref).toBe('blob://photo-1');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('capturing a request twice fails: the second call finds no open row', async () => {
    const client = await freshDatabase('ppbf_test_assessproto_capture_twice');
    try {
      await applyMigrationTransaction(client, migrationSql);

      const created = await createDataCollectionRequest({
        organizationId: ORG_A,
        athleteId: ATHLETE_A,
        requestKind: 'photo',
        promptText: 'Take a form-check photo.',
        reasonCode: 'coach_requested',
      });
      await captureDataCollectionRequest({
        organizationId: ORG_A,
        requestId: created.request_id,
        capturedByAccountId: COACH_A,
      });

      await expect(
        captureDataCollectionRequest({
          organizationId: ORG_A,
          requestId: created.request_id,
          capturedByAccountId: COACH_A,
        }),
      ).rejects.toThrow('DATA_COLLECTION_REQUEST_NOT_FOUND_OR_NOT_OPEN');
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('the open data collection request queue', () => {
  test('orders by priority then due date, and excludes captured/declined requests', async () => {
    const client = await freshDatabase('ppbf_test_assessproto_queue_order');
    try {
      await applyMigrationTransaction(client, migrationSql);

      const low = await createDataCollectionRequest({
        organizationId: ORG_A, athleteId: ATHLETE_A, requestKind: 'observation',
        promptText: 'Low priority.', reasonCode: 'coach_requested', priority: 'low', dueOn: '2026-01-01',
      });
      const high = await createDataCollectionRequest({
        organizationId: ORG_A, athleteId: ATHLETE_A, requestKind: 'video',
        promptText: 'High priority.', reasonCode: 'interval_due', priority: 'high', dueOn: '2026-06-01',
      });
      const declined = await createDataCollectionRequest({
        organizationId: ORG_A, athleteId: ATHLETE_A, requestKind: 'document',
        promptText: 'Will be declined.', reasonCode: 'coach_requested',
      });
      await declineDataCollectionRequest({ organizationId: ORG_A, requestId: declined.request_id, declinedReason: 'Not applicable.' });

      const queue = await listOpenDataCollectionRequests(ORG_A, { athleteId: ATHLETE_A });
      expect(queue.map((row) => row.request_id)).toEqual([high.request_id, low.request_id]);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});
