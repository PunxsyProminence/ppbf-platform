// Real PostgreSQL-backed test for the intake document security review write.
//
// reviewIntakeDocumentSecurity is a jsonb-merge UPDATE with a RETURNING
// clause -- exactly the statement class whose only prior coverage was mocks
// when the worker's claim statement shipped broken (#89). This suite runs the
// real statement against the real schema and closes the loop that matters:
// the states the review writes must be the states isIntakeDocumentReadyForReview
// accepts, on a row created the way the upload route creates it.
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

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-intake-review-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const SCHEMA_SQL_PATH = path.resolve(__dirname, '../../../../../infra/azure/pilot_slice_postgres.sql');
const TEST_DB_NAME = 'ppbf_test_intake_review';

const ORG_ID = 'org-intake-review';
const ACCOUNT_ID = 'acct-intake-admin';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let intake: typeof import('./intake');

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

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  const migrateClient = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await migrateClient.connect();
  await migrateClient.query(await fs.readFile(SCHEMA_SQL_PATH, 'utf8'));
  await migrateClient.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  await migrateClient.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft') on conflict do nothing`,
    [ACCOUNT_ID, ORG_ID],
  );
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  // Imported only after the connection string is in place, so the app's lazily
  // constructed pool targets this disposable database.
  intake = await import('./intake');
});

afterAll(async () => {
  const { closePool } = await import('./db');
  await closePool();

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

async function createCaseWithDocument(): Promise<{ caseId: string; documentId: string }> {
  const caseId = await intake.createIntakeCase({
    organizationId: ORG_ID,
    summary: 'Review test case',
    submittedByAccountId: ACCOUNT_ID,
  });
  const documentId = await intake.createIntakeDocument({
    organizationId: ORG_ID,
    intakeCaseId: caseId,
    documentType: 'medical_form',
    fileName: 'medical_form.pdf',
    blobPath: `quarantine/${ORG_ID}/${caseId}/medical_form.pdf`,
    classification: 'medical_form',
    // The exact metadata the upload route writes at birth.
    metadata: { hint: 'medical_form', quarantine_status: 'pending_security_review', content_sha256: 'abc' },
  });
  return { caseId, documentId };
}

describe('intake document security review against the real schema', () => {
  test('a freshly uploaded document is not ready; a clean review makes it ready', async () => {
    const { documentId } = await createCaseWithDocument();

    const before = await intake.getIntakeDocumentById(ORG_ID, documentId);
    expect(before).not.toBeNull();
    expect(intake.isIntakeDocumentReadyForReview(before!)).toBe(false);

    const reviewed = await intake.reviewIntakeDocumentSecurity({
      organizationId: ORG_ID,
      intakeDocumentId: documentId,
      decision: 'clean',
      reviewedByAccountId: ACCOUNT_ID,
      reviewedByRole: 'organization_admin',
      notes: 'Opened the PDF; contents are the medical form.',
    });
    expect(reviewed).not.toBeNull();
    expect(intake.isIntakeDocumentReadyForReview(reviewed!)).toBe(true);
    // Birth metadata survives the merge; the attestation trail is recorded.
    expect(reviewed!.metadata).toMatchObject({
      content_sha256: 'abc',
      security_state: 'clean',
      extraction_state: 'ready_for_review',
      security_review: expect.objectContaining({
        decision: 'clean',
        reviewed_by_account_id: ACCOUNT_ID,
      }),
    });
  });

  test('a quarantined review leaves the document unready, and a later clean re-review recovers it', async () => {
    const { documentId } = await createCaseWithDocument();

    const quarantined = await intake.reviewIntakeDocumentSecurity({
      organizationId: ORG_ID,
      intakeDocumentId: documentId,
      decision: 'quarantined',
      reviewedByAccountId: ACCOUNT_ID,
      reviewedByRole: 'organization_admin',
    });
    expect(intake.isIntakeDocumentReadyForReview(quarantined!)).toBe(false);

    const recovered = await intake.reviewIntakeDocumentSecurity({
      organizationId: ORG_ID,
      intakeDocumentId: documentId,
      decision: 'clean',
      reviewedByAccountId: ACCOUNT_ID,
      reviewedByRole: 'organization_admin',
    });
    expect(intake.isIntakeDocumentReadyForReview(recovered!)).toBe(true);
    expect((recovered!.metadata.security_review as { decision: string }).decision).toBe('clean');
  });

  test('a review scoped to the wrong organization touches nothing', async () => {
    const { documentId } = await createCaseWithDocument();
    const result = await intake.reviewIntakeDocumentSecurity({
      organizationId: 'org-other',
      intakeDocumentId: documentId,
      decision: 'clean',
      reviewedByAccountId: ACCOUNT_ID,
      reviewedByRole: 'organization_admin',
    });
    expect(result).toBeNull();
    const untouched = await intake.getIntakeDocumentById(ORG_ID, documentId);
    expect(intake.isIntakeDocumentReadyForReview(untouched!)).toBe(false);
  });
});
