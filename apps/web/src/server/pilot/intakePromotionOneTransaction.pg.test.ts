// Real PostgreSQL proof that intake promotion's writes are one transaction
// (OD-2026-10-03-002 section 5, Jason 2026-10-03: "One transaction around
// intake's writes"; the remainder after #1143 delivered under his reply "A").
//
// WHAT IT PROVES
//
//   1. SUCCESS IS UNCHANGED. A full promotion -- athlete, athlete login,
//      guardian login, guardian record and link, emergency contact, medical,
//      waiver, assessment, attendance, readiness, coach note, documents, case
//      status, audit row -- writes exactly what it wrote before.
//   2. A FAILURE AFTER THE ATHLETE WRITE LEAVES NOTHING. A real Postgres error
//      is raised by a trigger at a chosen table: the guardian link (right
//      after the guardian's login is written), and the audit row (the last
//      write in the transaction). Either way no athlete record, no athlete
//      login, no guardian login, no membership, no guardian record or link,
//      and no other promotion row is left, the case stays approved, and an
//      existing guardian login's sessions are not revoked.
//
// Each fails if the client is not passed to that write: the write commits on
// its own pooled connection and survives the rollback.
//
// The route runs for real on the real db.ts against the embedded database.
// Only the signed-in principal, the shadow runtime readiness and authority
// gates, and the case lookups that stand in front of promotion are stubbed.
//
// Spins up the same disposable, local-only embedded Postgres the other .pg
// suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { NextRequest } from 'next/server';
import { Client } from 'pg';

jest.setTimeout(300_000);

const ORG = 'org-iot';
const ADMIN = 'iot-admin';

jest.mock('./http', () => ({
  ...jest.requireActual('./http'),
  requirePrincipal: jest.fn(async () => ({
    accountId: 'iot-admin',
    role: 'organization_admin',
    organizationId: 'org-iot',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  })),
}));
jest.mock('./shadowReadiness', () => ({ assertShadowRuntimeReadiness: jest.fn() }));
jest.mock('./shadowAuthority', () => ({
  ...jest.requireActual('./shadowAuthority'),
  assertShadowAuthority: jest.fn(),
}));
// The case and its documents are real rows; the gates that read them are
// stood in for, since they are not what this suite is about.
jest.mock('./intake', () => ({
  ...jest.requireActual('./intake'),
  getIntakeCaseById: jest.fn(async () => ({ intake_case_id: 'case', status: 'approved' })),
  assertActorCanAccessIntakeCase: jest.fn(async () => ({ found: true, submittedByAccountId: 'iot-admin', subjectAthleteIds: [] })),
  listIntakeDocumentsByCase: jest.fn(async () => [{ intake_document_id: 'doc' }]),
  isIntakeDocumentReadyForReview: jest.fn(() => true),
}));

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-intake-one-transaction-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_intake_one_transaction';
const MIGRATIONS = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
  'pilot_slice_postgres_emergency_contact_note_migration.sql',
  'pilot_slice_postgres_readiness_provenance_migration.sql',
  'pilot_slice_postgres_observation_author_role_migration.sql',
  'pilot_slice_postgres_guardian_media_consent_migration.sql',
  'pilot_slice_postgres_waiver_recorded_by_migration.sql',
  'pilot_slice_postgres_research_requirement_subject_migration.sql',
];

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let POST: typeof import('../../../app/api/pilot/intake/review-action/route').POST;

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

// Every table a promotion writes, and the rows in it for this organization.
const PROMOTION_TABLES = [
  'athletes',
  'parents',
  'guardian_links',
  'emergency_contacts',
  'medical_intake',
  'waivers',
  'assessments',
  'attendance',
  'readiness',
  'coach_observations',
  'documents',
  'audit_events',
  'shadow_events',
  'shadow_research_requirements',
  'shadow_telemetry_events',
];

async function rowCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of PROMOTION_TABLES) {
    const row = await client.query<{ n: number }>(
      `select count(*)::int as n from pilot.${table} where organization_id = $1`,
      [ORG],
    );
    counts[table] = row.rows[0].n;
  }
  return counts;
}

async function accountIds(): Promise<string[]> {
  const rows = await client.query<{ account_id: string }>(
    'select account_id from pilot.accounts where organization_id = $1 order by account_id',
    [ORG],
  );
  return rows.rows.map((row) => row.account_id);
}

async function membershipIds(): Promise<string[]> {
  const rows = await client.query<{ account_id: string }>(
    'select account_id from pilot.organization_memberships where organization_id = $1 order by account_id',
    [ORG],
  );
  return rows.rows.map((row) => row.account_id);
}

async function caseState(caseId: string) {
  const row = await client.query<{ status: string; promoted: boolean; owner: string | null; review_status: string }>(
    `select c.status, c.promoted_at is not null as promoted, d.owner_entity_id as owner, d.review_status
       from pilot.intake_cases c
       join pilot.intake_documents d on d.organization_id = c.organization_id and d.intake_case_id = c.intake_case_id
      where c.organization_id = $1 and c.intake_case_id = $2`,
    [ORG, caseId],
  );
  return row.rows[0];
}

async function seedCase(): Promise<string> {
  const caseId = randomUUID();
  await client.query(
    `insert into pilot.intake_cases (organization_id, intake_case_id, status, summary, submitted_by_account_id)
     values ($1, $2, 'approved', 'iot case', $3)`,
    [ORG, caseId, ADMIN],
  );
  await client.query(
    `insert into pilot.intake_documents
       (organization_id, intake_document_id, intake_case_id, document_type, file_name, blob_path, classification, review_status)
     values ($1, $2, $3, 'athlete_registration', 'reg.pdf', 'intake/reg.pdf', 'restricted', 'approved')`,
    [ORG, randomUUID(), caseId],
  );
  return caseId;
}

// An existing guardian login, active, with a live session. Provisioning an
// existing login revokes its sessions; a rolled-back promotion must not.
async function seedExistingGuardian(): Promise<void> {
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email, active_flag)
     values ('iot-guardian', 'parent', $1, 'microsoft', 'guardian@iot.example', true)`,
    [ORG],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ('iot-guardian', $1, 'parent', true)`,
    [ORG],
  );
  await client.query(
    `insert into pilot.session_tokens (token_hash, account_id, organization_id)
     values ('iot-guardian-session', 'iot-guardian', $1)`,
    [ORG],
  );
}

async function guardianSessionRevoked(): Promise<boolean> {
  const row = await client.query<{ revoked: boolean }>(
    `select revoked_at is not null as revoked from pilot.session_tokens where token_hash = 'iot-guardian-session'`,
  );
  return row.rows[0].revoked;
}

function promoteRequest(caseId: string, guardianEmail: string, guardianAccountId: string): NextRequest {
  return new NextRequest('http://localhost/api/pilot/intake/review-action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      intake_case_id: caseId,
      action: 'promote',
      notes: 'iot',
      promotion: {
        athlete: {
          athlete_id: 'IOT-ATH',
          account_id: 'iot-athlete-login',
          full_name: 'Iot Athlete',
          dob: '2012-01-01',
          weight_class: 'open',
          gym_status: 'active',
          emergency_contact: 'Iot Guardian 555-0100',
          coach_id: ADMIN,
        },
        guardian: {
          parent_id: 'iot-parent',
          account_id: guardianAccountId,
          full_name: 'Iot Guardian',
          phone: '555-0100',
          email: guardianEmail,
          relationship_to_athlete: 'mother',
        },
        emergency_contact: { full_name: 'Iot Guardian', relationship_to_athlete: 'mother', phone: '555-0100' },
        medical: { conditions: 'none', clearance_status: 'pending' },
        waiver: {
          waiver_type: 'general',
          signed_by_name: 'Iot Guardian',
          signed_by_role: 'guardian',
          signed_at: '2026-10-01T12:00:00.000Z',
          consent_version: 'v1',
          status: 'signed',
        },
        assessment: { assessment_type: 'intake', result: { note: 'ok' } },
        attendance: { attendance_date: '2026-10-03', status: 'present' },
        readiness: { score: 7, category: 'general', measured_at: '2026-10-03T12:00:00Z' },
        coach_note: { note_text: 'first session' },
      },
    }),
  });
}

async function failAt(table: string | null): Promise<void> {
  await client.query('delete from iot_fault');
  if (table) await client.query('insert into iot_fault (at_table) values ($1)', [table]);
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
    }, 240_000);
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

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  for (const file of MIGRATIONS) {
    await client.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
  }

  // The fault: a real Postgres error, raised by the named table's own write
  // inside the promotion's transaction.
  await client.query('create table iot_fault (at_table text not null)');
  await client.query(`
    create function iot_raise_fault() returns trigger language plpgsql as $$
    begin
      if exists (select 1 from iot_fault where at_table = tg_table_name) then
        raise exception 'iot injected fault at %', tg_table_name;
      end if;
      return new;
    end $$`);
  for (const table of ['guardian_links', 'audit_events']) {
    await client.query(
      `create trigger iot_fault_${table} before insert or update on pilot.${table}
       for each row execute function iot_raise_fault()`,
    );
  }

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [ORG],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email, active_flag)
     values ($1, 'organization_admin', $2, 'microsoft', 'admin@iot.example', true)`,
    [ADMIN, ORG],
  );

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it).
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  process.env.PPBF_INTAKE_PROMOTION_ENABLED = 'true';

  ({ POST } = await import('../../../app/api/pilot/intake/review-action/route'));
});

afterAll(async () => {
  const { closePool } = await import('./db');
  await closePool();
  await client?.end();
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

beforeEach(async () => {
  await failAt(null);
  for (const table of [...PROMOTION_TABLES].reverse()) {
    if (table === 'athletes') continue;
    await client.query(`delete from pilot.${table} where organization_id = $1`, [ORG]);
  }
  await client.query('delete from pilot.intake_cases where organization_id = $1', [ORG]);
  await client.query('delete from pilot.athletes where organization_id = $1', [ORG]);
  await client.query('delete from pilot.session_tokens where organization_id = $1', [ORG]);
  await client.query('delete from pilot.organization_memberships where organization_id = $1', [ORG]);
  await client.query('delete from pilot.accounts where organization_id = $1 and account_id <> $2', [ORG, ADMIN]);
});

test('a full promotion writes everything it wrote before', async () => {
  const caseId = await seedCase();

  const response = await POST(promoteRequest(caseId, 'new-guardian@iot.example', 'iot-new-guardian'));

  expect(response.status).toBe(200);
  expect(await rowCounts()).toEqual({
    athletes: 1,
    parents: 1,
    guardian_links: 1,
    emergency_contacts: 1,
    medical_intake: 1,
    waivers: 1,
    assessments: 1,
    attendance: 1,
    readiness: 1,
    coach_observations: 1,
    documents: 1,
    audit_events: 1,
    shadow_events: 1,
    shadow_research_requirements: 1,
    shadow_telemetry_events: 1,
  });
  expect(await accountIds()).toEqual(['iot-admin', 'iot-athlete-login', 'iot-new-guardian']);
  expect(await membershipIds()).toEqual(['iot-athlete-login', 'iot-new-guardian']);

  const athleteLogin = await client.query(
    `select role, athlete_id, pin_hash, active_flag, auth_provider from pilot.accounts where account_id = 'iot-athlete-login'`,
  );
  // The athlete login: bound to the record, no credential, inactive until a
  // code is redeemed.
  expect(athleteLogin.rows[0]).toEqual({
    role: 'athlete', athlete_id: 'IOT-ATH', pin_hash: null, active_flag: false, auth_provider: 'ppbf_local',
  });
  const guardianLogin = await client.query(
    `select role, login_email, active_flag, auth_provider from pilot.accounts where account_id = 'iot-new-guardian'`,
  );
  expect(guardianLogin.rows[0]).toEqual({
    role: 'parent', login_email: 'new-guardian@iot.example', active_flag: true, auth_provider: 'microsoft',
  });
  const parent = await client.query(
    `select p.account_id, l.athlete_id, l.relationship_to_athlete
       from pilot.parents p
       join pilot.guardian_links l on l.organization_id = p.organization_id and l.parent_id = p.parent_id
      where p.organization_id = $1 and p.parent_id = 'iot-parent'`,
    [ORG],
  );
  expect(parent.rows).toEqual([{ account_id: 'iot-new-guardian', athlete_id: 'IOT-ATH', relationship_to_athlete: 'mother' }]);
  expect(await caseState(caseId)).toEqual({
    status: 'promoted', promoted: true, owner: 'IOT-ATH', review_status: 'promoted',
  });
});

test.each(['guardian_links', 'audit_events'])(
  'a failure at %s, after the athlete write, leaves nothing behind',
  async (table) => {
    const caseId = await seedCase();
    await seedExistingGuardian();
    const accountsBefore = await accountIds();
    const membershipsBefore = await membershipIds();
    const guardianBefore = await client.query(
      `select role, active_flag, updated_at from pilot.accounts where account_id = 'iot-guardian'`,
    );
    await failAt(table);

    const response = await POST(promoteRequest(caseId, 'guardian@iot.example', 'iot-guardian'));

    expect(response.status).toBe(500);
    expect(await rowCounts()).toEqual(Object.fromEntries(PROMOTION_TABLES.map((name) => [name, 0])));
    // No athlete login and no new account or membership; the existing
    // guardian login is as it was, its session still live.
    expect(await accountIds()).toEqual(accountsBefore);
    expect(await membershipIds()).toEqual(membershipsBefore);
    const guardianAfter = await client.query(
      `select role, active_flag, updated_at from pilot.accounts where account_id = 'iot-guardian'`,
    );
    expect(guardianAfter.rows).toEqual(guardianBefore.rows);
    expect(await guardianSessionRevoked()).toBe(false);
    expect(await caseState(caseId)).toEqual({
      status: 'approved', promoted: false, owner: null, review_status: 'approved',
    });

    // Fixed and retried, the same promotion goes through whole.
    await failAt(null);
    const retry = await POST(promoteRequest(caseId, 'guardian@iot.example', 'iot-guardian'));
    expect(retry.status).toBe(200);
    expect((await rowCounts()).athletes).toBe(1);
    expect((await caseState(caseId)).status).toBe('promoted');
  },
);
