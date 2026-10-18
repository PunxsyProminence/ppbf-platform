// Real PostgreSQL test of cycle tracking (lane L58 PR-4; OD-2026-10-17-023 item 4, "C: Now"):
// the athlete's own route against the opt-in and entry tables.
//
// What needs a real database: that nothing is stored before the athlete turns it on; that a day is
// logged once; that an athlete can remove only their own date; that turning it off deletes every
// date; that no other role reaches it and a deleted athlete is refused; and that no audit row is
// written for any of it. Embedded, local-only Postgres; never staging or production.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { NextRequest } from 'next/server';
import { Client } from 'pg';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let activeClient: Client | null = null;

jest.mock('./db', () => {
  const actual = jest.requireActual('./db');
  return {
    ...actual,
    query: jest.fn(async (text: string, params: unknown[] = []) => {
      if (!activeClient) throw new Error('test bug: no active embedded client');
      return (await activeClient.query(text, params)).rows;
    }),
    queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
      if (!activeClient) throw new Error('test bug: no active embedded client');
      return (await activeClient.query(text, params)).rows[0] ?? null;
    }),
  };
});

jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});

import { GET, POST } from '@/app/api/pilot/athlete/cycle/route';

import { cycleDayError } from './athleteCycle';
import type { PilotPrincipal } from './auth';
import { requirePrincipal } from './http';

jest.setTimeout(180_000);
// initdb has taken ~170 s on a loaded Windows laptop; CI starts in seconds.
const STARTUP_TIMEOUT_MS = 300_000;

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-athlete-cycle-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const ORG = 'org-cycle';
const COACH = 'acct-cycle-coach';
const ATHLETE = 'ATH-CYCLE-1';
const OTHER_ATHLETE = 'ATH-CYCLE-2';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
const mockRequirePrincipal = requirePrincipal as jest.Mock;

function principal(role: PilotPrincipal['role'], athleteId: string | null): PilotPrincipal {
  const accountId = `acct-${athleteId ?? role}`;
  return { accountId, role, organizationId: ORG, athleteId, sessionToken: `token-${accountId}`, authProvider: 'ppbf_local' };
}

async function call(actor: PilotPrincipal, method: 'GET' | 'POST', body?: Record<string, unknown>) {
  mockRequirePrincipal.mockResolvedValue(actor);
  const request = new NextRequest('http://localhost/api/pilot/athlete/cycle', {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  const response = method === 'GET' ? await GET(request) : await POST(request);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const athlete = (athleteId = ATHLETE) => principal('athlete', athleteId);
const act = (body: Record<string, unknown>, athleteId = ATHLETE) => call(athlete(athleteId), 'POST', body);

async function rows(table: 'athlete_cycle_tracking' | 'athlete_cycle_entries') {
  const result = await activeClient!.query(`select athlete_id from pilot.${table} order by athlete_id`);
  return result.rows.map((row) => row.athlete_id);
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
  const admin = new Client({ connectionString: `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/postgres` });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const client = new Client({ connectionString: `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${name}` });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  await client.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [ORG]);
  await client.query(`insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, 'coach', $2, 'microsoft')`, [COACH, ORG]);
  for (const id of [ATHLETE, OTHER_ATHLETE]) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Cycle Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [ORG, id, COACH],
    );
  }
  activeClient = client;
  return client;
}

beforeAll(async () => {
  PG_PORT = await findFreePort();
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => { stderrOutput += chunk.toString(); });
  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input: serverProcess.stdout });
    const timeout = setTimeout(() => {
      rl.close();
      reject(new Error(`Embedded Postgres did not become ready in time. stderr:\n${stderrOutput}`));
    }, STARTUP_TIMEOUT_MS);
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
}, STARTUP_TIMEOUT_MS + 30_000);

afterAll(async () => {
  activeClient = null;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(safetyTimer); resolve(); } };
    const safetyTimer = setTimeout(finish, 15_000);
    safetyTimer.unref();
    serverProcess.once('exit', finish);
    serverProcess.kill('SIGTERM');
  });
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe('cycle tracking is opt-in and the athlete own', () => {
  test('nothing is stored before the athlete turns it on; then a day is logged once, newest first', async () => {
    const client = await freshDatabase('cycle_opt_in');
    try {
      expect((await call(athlete(), 'GET')).body).toEqual({ opted_in: false, entries: [] });
      const refused = await act({ action: 'add', day: '2026-10-01' });
      expect({ status: refused.status, error: refused.body.error }).toEqual({ status: 400, error: 'Turn cycle tracking on first.' });
      expect(await rows('athlete_cycle_entries')).toEqual([]);

      await act({ action: 'turn_on' });
      await act({ action: 'add', day: '2026-09-03' });
      await act({ action: 'add', day: '2026-10-01' });
      const again = await act({ action: 'add', day: '2026-10-01' });
      expect(again.status).toBe(200);
      expect((again.body.entries as Array<{ period_started_on: string }>).map((entry) => entry.period_started_on))
        .toEqual(['2026-10-01', '2026-09-03']);
      // No other athlete gained a row.
      expect(await rows('athlete_cycle_tracking')).toEqual([ATHLETE]);
    } finally {
      await client.end();
    }
  });

  test("'add' with no day logs the gym's today", async () => {
    const client = await freshDatabase('cycle_today');
    try {
      await act({ action: 'turn_on' });
      const today = await act({ action: 'add' });
      expect(today.status).toBe(200);
      expect((today.body.entries as unknown[]).length).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('an athlete removes only their own date; another athlete entry id matches nothing', async () => {
    const client = await freshDatabase('cycle_remove');
    try {
      await act({ action: 'turn_on' });
      await act({ action: 'turn_on' }, OTHER_ATHLETE);
      const mine = await act({ action: 'add', day: '2026-10-01' });
      const theirs = await act({ action: 'add', day: '2026-10-02' }, OTHER_ATHLETE);
      const theirId = (theirs.body.entries as Array<{ entry_id: string }>)[0].entry_id;
      const myId = (mine.body.entries as Array<{ entry_id: string }>)[0].entry_id;

      expect((await act({ action: 'remove', entry_id: theirId })).status).toBe(404);
      expect(await rows('athlete_cycle_entries')).toEqual([ATHLETE, OTHER_ATHLETE]);
      expect((await act({ action: 'remove', entry_id: myId })).body).toEqual({ opted_in: true, entries: [] });
      expect(await rows('athlete_cycle_entries')).toEqual([OTHER_ATHLETE]);
    } finally {
      await client.end();
    }
  });

  test('turning it off deletes every date, and only this athlete dates', async () => {
    const client = await freshDatabase('cycle_off');
    try {
      for (const id of [ATHLETE, OTHER_ATHLETE]) {
        await act({ action: 'turn_on' }, id);
        await act({ action: 'add', day: '2026-10-01' }, id);
      }
      expect((await act({ action: 'turn_off' })).body).toEqual({ opted_in: false, entries: [] });
      expect(await rows('athlete_cycle_tracking')).toEqual([OTHER_ATHLETE]);
      expect(await rows('athlete_cycle_entries')).toEqual([OTHER_ATHLETE]);
    } finally {
      await client.end();
    }
  });

  test('no other role reaches it, an unlinked login is told so, and a deleted athlete is refused', async () => {
    const client = await freshDatabase('cycle_access');
    try {
      await act({ action: 'turn_on' });
      await act({ action: 'add', day: '2026-10-01' });
      for (const role of ['coach', 'organization_admin', 'admin', 'parent', 'platform_owner', 'board'] as const) {
        expect({ role, status: (await call(principal(role, null), 'GET')).status }).toEqual({ role, status: 403 });
        expect({ role, status: (await call(principal(role, null), 'POST', { action: 'turn_off' })).status }).toEqual({ role, status: 403 });
      }
      expect((await call(principal('athlete', null), 'GET')).status).toBe(400);

      await client.query(`update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`, [ORG, ATHLETE]);
      expect((await call(athlete(), 'GET')).status).toBe(403);
      expect((await act({ action: 'add', day: '2026-10-02' })).status).toBe(403);
      // What was there stays until the purge deletes it with the athlete.
      expect(await rows('athlete_cycle_entries')).toEqual([ATHLETE]);
    } finally {
      await client.end();
    }
  });

  test('no audit row is written for any of it', async () => {
    const client = await freshDatabase('cycle_no_audit');
    try {
      await act({ action: 'turn_on' });
      const added = await act({ action: 'add', day: '2026-10-01' });
      await act({ action: 'remove', entry_id: (added.body.entries as Array<{ entry_id: string }>)[0].entry_id });
      await act({ action: 'turn_off' });
      const audit = await client.query(`select count(*)::int as n from pilot.audit_events`);
      const mirrored = await client.query(`select count(*)::int as n from pilot.shadow_events`);
      expect({ audit: audit.rows[0].n, mirrored: mirrored.rows[0].n }).toEqual({ audit: 0, mirrored: 0 });
    } finally {
      await client.end();
    }
  });

  test('a bad action or day is refused with its reason', async () => {
    const client = await freshDatabase('cycle_validation');
    try {
      await act({ action: 'turn_on' });
      for (const [body, mentions] of [
        [{ action: 'share' }, 'action'],
        [{ action: 'add', day: '10/01/2026' }, 'date'],
        [{ action: 'add', day: '2026-02-30' }, 'real date'],
        [{ action: 'add', day: '2999-01-01' }, 'after today'],
        [{ action: 'remove' }, 'entry_id'],
      ] as const) {
        const refused = await act(body as Record<string, unknown>);
        expect({ body, status: refused.status, mentions: String(refused.body.error).includes(mentions) })
          .toEqual({ body, status: 400, mentions: true });
      }
      expect(cycleDayError('2026-10-18', new Date('2026-10-18T16:00:00Z'))).toBeNull();
    } finally {
      await client.end();
    }
  });
});
