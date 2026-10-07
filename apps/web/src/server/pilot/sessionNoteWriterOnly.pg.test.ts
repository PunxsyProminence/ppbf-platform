// Real PostgreSQL-backed proof that only the writer can change a session
// note (OD-2026-10-06-025 ruling 4, Jason 2026-10-06: "Only the writer; coach
// adds own note").
//
// What needs proving that a mocked store cannot: the UPDATE in
// upsertSession, as the two session write routes run it, leaves the stored
// text untouched when anyone but the athlete who owns the session sends
// different text -- and does so in the statement itself, not in a read that
// a concurrent write could slip between. So the routes run here unmocked
// except for the principal (no session store) and the audit writer; the
// role gate, the athlete gate, the validator, the store and jsonError are
// all shipped code, and every refusal below is the one a caller would get.
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

jest.mock('./http', () => ({
  ...jest.requireActual('./http'),
  requirePrincipal: jest.fn(),
}));

jest.mock('./audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

import { POST as createOrUpsert } from '../../../app/api/pilot/sessions/route';
import { POST as update } from '../../../app/api/pilot/sessions/update/route';
import type { PilotPrincipal } from './auth';
import { requirePrincipal } from './http';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-session-note-writer-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

// The columns the session write touches, in the order `all` applies them,
// plus the soft-delete column the athlete gate reads and the coverage table
// the coach gate reads.
const MIGRATIONS = [
  'pilot_slice_postgres_coach_coverage_migration.sql',
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
  'pilot_slice_postgres_session_rpe_semantics_migration.sql',
  'pilot_slice_postgres_session_duration_migration.sql',
];

const ORG_ID = 'org-note-writer';
const COACH_OF_RECORD = 'acct-note-coach-record';
const OTHER_COACH = 'acct-note-coach-other';
const ORG_ADMIN = 'acct-note-org-admin';
const PARENT = 'acct-note-parent';
const ATHLETE_ACCOUNT = 'acct-note-athlete';
const ATHLETE_ID = 'ath-note-writer';
const OTHER_ATHLETE_ID = 'ath-note-other';
const SESSION_ID = 'sess-note-1';
const ATHLETE_TEXT = 'legs heavy today, slept four hours';

const mockRequirePrincipal = requirePrincipal as jest.Mock;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string;
let migrationSql: string[];

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
  for (const sql of migrationSql) {
    await client.query(sql);
  }
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  for (const [accountId, role] of [
    [COACH_OF_RECORD, 'coach'],
    [OTHER_COACH, 'coach'],
    [ORG_ADMIN, 'organization_admin'],
    [PARENT, 'parent'],
  ]) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'microsoft') on conflict do nothing`,
      [accountId, role, ORG_ID],
    );
  }
  // Two athletes under the same coach of record, so the coach can reach both
  // -- the setup the session-move case below needs.
  for (const athleteId of [ATHLETE_ID, OTHER_ATHLETE_ID]) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Note Writer', '2011-01-01', '60', 'active', 'contact', true, $3, now(), now())`,
      [ORG_ID, athleteId, COACH_OF_RECORD],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id)
     values ($1, 'athlete', $2, 'ppbf_local', $3) on conflict do nothing`,
    [ATHLETE_ACCOUNT, ORG_ID, ATHLETE_ID],
  );
  return client;
}

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: ATHLETE_ACCOUNT,
    role: 'athlete',
    organizationId: ORG_ID,
    athleteId: ATHLETE_ID,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  } as PilotPrincipal;
}

const WRITER = principal({});
const COACH_OF_RECORD_PRINCIPAL = principal({ accountId: COACH_OF_RECORD, role: 'coach', athleteId: null, authProvider: 'microsoft' });
const OTHER_COACH_PRINCIPAL = principal({ accountId: OTHER_COACH, role: 'coach', athleteId: null, authProvider: 'microsoft' });
const ORG_ADMIN_PRINCIPAL = principal({ accountId: ORG_ADMIN, role: 'organization_admin', athleteId: null, authProvider: 'microsoft' });
const PARENT_PRINCIPAL = principal({ accountId: PARENT, role: 'parent', athleteId: null, authProvider: 'microsoft' });

function body(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    session_id: SESSION_ID,
    athlete_id: ATHLETE_ID,
    date: now.slice(0, 10),
    rpe: null,
    rpe_method: 'UNKNOWN',
    notes: ATHLETE_TEXT,
    completed_flag: false,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function request(route: string, payload: Record<string, unknown>): NextRequest {
  return new NextRequest(`https://ppbf.example${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function writeAs(caller: PilotPrincipal, payload: Record<string, unknown>, via: 'update' | 'create' = 'update') {
  mockRequirePrincipal.mockResolvedValue(caller);
  return via === 'update'
    ? update(request('/api/pilot/sessions/update', payload))
    : createOrUpsert(request('/api/pilot/sessions', payload));
}

async function storedNote(client: Client): Promise<string> {
  const result = await client.query<{ notes: string }>(
    'select notes from pilot.sessions where organization_id = $1 and session_id = $2',
    [ORG_ID, SESSION_ID],
  );
  return result.rows[0].notes;
}

/** The athlete starts a session carrying their own note. */
async function athleteStartsSession() {
  const response = await writeAs(WRITER, body(), 'create');
  expect(response.status).toBe(200);
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
  migrationSql = await Promise.all(MIGRATIONS.map((file) => fs.readFile(path.join(INFRA_DIR, file), 'utf8')));
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

afterEach(() => {
  activeClient = null;
  jest.clearAllMocks();
});

describe('only the writer changes a session note', () => {
  test('the athlete who wrote it changes it, and the change is stored', async () => {
    const client = await freshDatabase('note_writer_self');
    try {
      activeClient = client;
      await athleteStartsSession();

      const response = await writeAs(WRITER, body({ notes: 'actually feeling better now' }));

      expect(response.status).toBe(200);
      expect(await storedNote(client)).toBe('actually feeling better now');
    } finally {
      await client.end();
    }
  });

  test.each([
    ['the coach of record', COACH_OF_RECORD_PRINCIPAL],
    ['an organization admin', ORG_ADMIN_PRINCIPAL],
  ])('%s reaches the athlete but cannot change the note: 403, text untouched', async (_label, caller) => {
    const client = await freshDatabase('note_writer_staff');
    try {
      activeClient = client;
      await athleteStartsSession();

      const response = await writeAs(caller, body({ notes: 'coach rewrote the kid' }));

      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('SESSION_NOTE_WRITER_ONLY');
      expect(await storedNote(client)).toBe(ATHLETE_TEXT);
    } finally {
      await client.end();
    }
  });

  test('the same refusal through POST /api/pilot/sessions with an existing id', async () => {
    const client = await freshDatabase('note_writer_create_path');
    try {
      activeClient = client;
      await athleteStartsSession();

      const response = await writeAs(COACH_OF_RECORD_PRINCIPAL, body({ notes: 'coach rewrote the kid' }), 'create');

      expect(response.status).toBe(403);
      expect(await storedNote(client)).toBe(ATHLETE_TEXT);
    } finally {
      await client.end();
    }
  });

  test('a coach who is not assigned is refused by the athlete gate; text untouched', async () => {
    const client = await freshDatabase('note_writer_other_coach');
    try {
      activeClient = client;
      await athleteStartsSession();

      const response = await writeAs(OTHER_COACH_PRINCIPAL, body({ notes: 'other coach text' }));

      expect(response.status).toBe(403);
      expect(await storedNote(client)).toBe(ATHLETE_TEXT);
    } finally {
      await client.end();
    }
  });

  test('a parent is refused by the role gate; text untouched', async () => {
    const client = await freshDatabase('note_writer_parent');
    try {
      activeClient = client;
      await athleteStartsSession();

      const response = await writeAs(PARENT_PRINCIPAL, body({ notes: 'parent text' }));

      expect(response.status).toBe(403);
      expect(await storedNote(client)).toBe(ATHLETE_TEXT);
    } finally {
      await client.end();
    }
  });

  test('the coach of record cannot move the session, and its note, to another athlete they coach', async () => {
    // Review finding: a move hands the note to a new owner, who would then be
    // its "writer". Refused in the same UPDATE; the row stays where it was.
    const client = await freshDatabase('note_writer_move');
    try {
      activeClient = client;
      await athleteStartsSession();

      const response = await writeAs(COACH_OF_RECORD_PRINCIPAL, body({ athlete_id: OTHER_ATHLETE_ID }));

      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('SESSION_NOTE_WRITER_ONLY');
      const row = await client.query<{ athlete_id: string; notes: string }>(
        'select athlete_id, notes from pilot.sessions where organization_id = $1 and session_id = $2',
        [ORG_ID, SESSION_ID],
      );
      expect(row.rows[0]).toEqual({ athlete_id: ATHLETE_ID, notes: ATHLETE_TEXT });
    } finally {
      await client.end();
    }
  });

  test('a staff write replaying an older note stored with stray spaces still goes through, bytes untouched', async () => {
    // The validator trims what the caller sends; a row seeded before the
    // routes existed may not be. The match ignores the ends, and the SET
    // keeps the stored bytes for a non-writer.
    const client = await freshDatabase('note_writer_stray_spaces');
    try {
      activeClient = client;
      await athleteStartsSession();
      await client.query(
        'update pilot.sessions set notes = $3 where organization_id = $1 and session_id = $2',
        [ORG_ID, SESSION_ID, `  ${ATHLETE_TEXT} \n`],
      );

      const response = await writeAs(COACH_OF_RECORD_PRINCIPAL, body({ completed_flag: true }));

      expect(response.status).toBe(200);
      expect(await storedNote(client)).toBe(`  ${ATHLETE_TEXT} \n`);
    } finally {
      await client.end();
    }
  });

  test("a staff write that leaves the note's text alone still updates the other columns", async () => {
    // Staff may still mark a session complete or set its RPE through the
    // API; the rule is about the words, not the row.
    const client = await freshDatabase('note_writer_staff_other_columns');
    try {
      activeClient = client;
      await athleteStartsSession();

      const response = await writeAs(
        COACH_OF_RECORD_PRINCIPAL,
        body({ rpe: 6, rpe_method: 'athlete_post_session_self_report', completed_flag: true }),
      );

      expect(response.status).toBe(200);
      const row = await client.query<{ notes: string; completed_flag: boolean; rpe: string }>(
        'select notes, completed_flag, rpe from pilot.sessions where organization_id = $1 and session_id = $2',
        [ORG_ID, SESSION_ID],
      );
      expect(row.rows[0].notes).toBe(ATHLETE_TEXT);
      expect(row.rows[0].completed_flag).toBe(true);
      expect(Number(row.rows[0].rpe)).toBe(6);
    } finally {
      await client.end();
    }
  });
});
