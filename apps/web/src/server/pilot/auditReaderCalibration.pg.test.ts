// Real PostgreSQL-backed test for what the general audit reader
// (POST /api/pilot/audit/get) serves of calibration work: nothing, to any
// role.
//
// The route's own suite mocks the query and can only read the SQL text. This
// one runs the shipped handler against rows in a real database, so the claims
// are about what comes back:
//
//   * an organization admin gets no calibration_ row, filtered or unfiltered
//   * naming a calibration type, or one of its entity ids, answers exactly as
//     a type or id with no rows does
//   * the page still fills to its limit from the rows that may be served
//   * everything else an admin and a coach could read is unchanged
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

import { NextRequest } from 'next/server';
import { Client } from 'pg';

jest.setTimeout(180_000);

// The route resolves the caller from a session cookie; this suite is about
// which rows a signed-in caller is served, so the principal is supplied.
jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-audit-reader-calib-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_audit_reader_calib';

const ORG = 'org-audit-reader';
const OTHER_ORG = 'org-audit-reader-other';
const ADMIN = 'acct-audit-reader-admin';

const CALIBRATION_TYPES = [
  'calibration_project',
  'calibration_clip',
  'calibration_annotation_set',
  'calibration_annotation_event',
  'calibration_adjudication',
  'calibration_body_moment',
  'calibration_body_point',
  'calibration_event_stance_label',
];

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;
let route: typeof import('../../../app/api/pilot/audit/get/route');
let signIn: (role: string, organizationId?: string) => void;

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

interface AuditRow {
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown>;
}

/** One audit row, `minutesAgo` old, so order is the test's to decide. */
async function audit(entityType: string, entityId: string, minutesAgo: number, orgId: string = ORG): Promise<void> {
  await db.query(
    `insert into pilot.audit_events
       (event_type, actor_account_id, actor_role, organization_id, entity_type, entity_id, details, created_at)
     values ('create', $1, 'organization_admin', $2, $3, $4, $5::jsonb, now() - make_interval(mins => $6))`,
    [ADMIN, orgId, entityType, entityId, JSON.stringify({ event_class: 'punch', start_ms: 61_000, end_ms: 61_400 }), minutesAgo],
  );
}

async function read(body: Record<string, unknown>): Promise<{ status: number; events: AuditRow[]; text: string }> {
  const response = await route.POST(new NextRequest('http://localhost/api/pilot/audit/get', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  const text = await response.text();
  return { status: response.status, events: (JSON.parse(text).events ?? []) as AuditRow[], text };
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

  db = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await db.connect();
  await db.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));

  // Env before import: db.ts builds its pool on first use.
  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  const http = await import('@/src/server/pilot/http');
  signIn = (role, organizationId = ORG) => {
    (http.requirePrincipal as jest.Mock).mockResolvedValue({
      accountId: ADMIN,
      role,
      organizationId,
      athleteId: null,
      sessionToken: 'token',
      authProvider: 'microsoft',
    });
  };
  route = await import('../../../app/api/pilot/audit/get/route');

  for (const orgId of [ORG, OTHER_ORG]) {
    await db.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [orgId],
    );
  }

  // Newest first: eight calibration rows, then rows that may be served. The
  // calibration rows are the most recent on purpose -- a filter applied after
  // the fetch would spend the whole page on them.
  for (const [index, entityType] of CALIBRATION_TYPES.entries()) {
    await audit(entityType, `calib-${index}`, index + 1);
  }
  await audit('announcement', 'ann-1', 20);
  await audit('calibration_clip', 'calib-between-1', 20);
  await audit('drill', 'drill-1', 21);
  await audit('calibration_body_point', 'calib-between-2', 21);
  await audit('training_hold', 'hold-1', 22);
  // Not the prefix: these are served as before.
  await audit('calibration', 'bare-word', 23);
  await audit('recalibration_note', 'not-a-prefix', 24);
  await audit('Calibration_annotation_event', 'other-case', 25);
  // Another organization's calibration row and ordinary row.
  await audit('calibration_annotation_event', 'calib-foreign', 1, OTHER_ORG);
  await audit('announcement', 'ann-foreign', 2, OTHER_ORG);
});

afterAll(async () => {
  await db?.end().catch(() => {});
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

  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe('an organization admin reading the audit trace', () => {
  beforeEach(() => signIn('organization_admin'));

  test('gets no calibration row with no filter, and everything else as before', async () => {
    const { status, events, text } = await read({ limit: 100 });

    expect(status).toBe(200);
    expect(events.map((row) => row.entity_id)).toEqual([
      'ann-1', 'drill-1', 'hold-1', 'bare-word', 'not-a-prefix', 'other-case',
    ]);
    expect(text).not.toContain('calib-');
  });

  test('the page fills to its limit from the rows that may be served', async () => {
    const { events } = await read({ limit: 3 });
    expect(events.map((row) => row.entity_id)).toEqual(['ann-1', 'drill-1', 'hold-1']);
  });

  test.each(CALIBRATION_TYPES)('naming %s answers exactly as a type with no rows does', async (entityType) => {
    const named = await read({ entity_type: entityType });
    const absent = await read({ entity_type: 'no_such_type' });

    expect(named.status).toBe(200);
    expect(named.text).toBe(absent.text);
  });

  test('a calibration row cannot be reached by its entity id, with or without its type', async () => {
    const absent = await read({ entity_id: 'no-such-id' });
    for (const body of [
      { entity_id: 'calib-3' },
      { entity_id: 'calib-3', entity_type: 'calibration_annotation_event' },
      { entity_id: 'calib-3', entity_type: ' calibration_annotation_event ' },
    ]) {
      expect((await read(body)).text).toBe(absent.text);
    }
    // The same lookup still finds a row that may be served.
    expect((await read({ entity_id: 'hold-1' })).events.map((row) => row.entity_type)).toEqual(['training_hold']);
  });

  test('only the exact prefix is withheld', async () => {
    for (const [entityType, entityId] of [
      ['calibration', 'bare-word'],
      ['recalibration_note', 'not-a-prefix'],
      ['Calibration_annotation_event', 'other-case'],
    ]) {
      expect((await read({ entity_type: entityType })).events.map((row) => row.entity_id)).toEqual([entityId]);
    }
  });

  test('another organization\'s rows stay out, calibration or not', async () => {
    signIn('organization_admin', OTHER_ORG);
    const { events } = await read({ limit: 100 });
    expect(events.map((row) => row.entity_id)).toEqual(['ann-foreign']);
  });
});

describe('a coach reading the audit trace', () => {
  beforeEach(() => signIn('coach'));

  test('is still refused a calibration type by name, and sees none unfiltered', async () => {
    expect((await read({ entity_type: 'calibration_annotation_event' })).status).toBe(403);

    const { status, events } = await read({ limit: 100 });
    expect(status).toBe(200);
    expect(events.map((row) => row.entity_id)).toEqual(['ann-1', 'drill-1']);
  });
});
