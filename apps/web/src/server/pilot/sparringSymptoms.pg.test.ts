// Real PostgreSQL test of the sparring symptom flag (lane L58 PR-3; OD-2026-10-17-023 item 1,
// OD-2026-10-17-029): the athlete's own route, the report it keeps, and the one flag it files.
//
// What needs a real database: that a tick files exactly one escalation to the gym's recipient
// (default: the athlete's coach) with one fixed severity and the ticked items in words; that a
// resend flags nothing new and a later tick flags only itself, while the report keeps every tick
// (the table's guard); that "None of these" is stored and flags nothing; that the next-day check is
// due only after the athlete sparred the previous gym day; and that no one but the athlete reaches
// the route, a deleted athlete included. Embedded, local-only Postgres; never staging or production.

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
    withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
      if (!activeClient) throw new Error('test bug: no active embedded client');
      await activeClient.query('BEGIN');
      try {
        const result = await fn(activeClient);
        await activeClient.query('COMMIT');
        return result;
      } catch (error) {
        await activeClient.query('ROLLBACK');
        throw error;
      }
    }),
  };
});

jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});

import { GET, POST } from '@/app/api/pilot/athlete/sparring-symptoms/route';

import type { PilotPrincipal } from './auth';
import { requirePrincipal } from './http';
import { getSparringSymptomToday } from './sparringSymptoms';

jest.setTimeout(180_000);
// initdb has taken ~170 s on a loaded Windows laptop; CI starts in seconds.
const STARTUP_TIMEOUT_MS = 300_000;

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-sparring-symptoms-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const ORG = 'org-symptoms';
const COACH = 'acct-symptoms-coach';
const ATHLETES = ['ATH-SYM-1', 'ATH-SYM-2', 'ATH-SYM-3'] as const;
const [ATHLETE, OTHER_ATHLETE, THIRD_ATHLETE] = ATHLETES;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
const mockRequirePrincipal = requirePrincipal as jest.Mock;

function principal(role: PilotPrincipal['role'], athleteId: string | null, accountId = `acct-${athleteId ?? role}`): PilotPrincipal {
  return { accountId, role, organizationId: ORG, athleteId, sessionToken: `token-${accountId}`, authProvider: 'ppbf_local' };
}

async function call(actor: PilotPrincipal, method: 'GET' | 'POST', body?: Record<string, unknown>) {
  mockRequirePrincipal.mockResolvedValue(actor);
  const request = new NextRequest('http://localhost/api/pilot/athlete/sparring-symptoms', {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  const response = method === 'GET' ? await GET(request) : await POST(request);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const send = (athleteId: string, context: string, symptoms: unknown) =>
  call(principal('athlete', athleteId), 'POST', { context, symptoms });

async function escalations(athleteId = ATHLETE) {
  const { rows } = await activeClient!.query(
    `select source_type, source_id, severity, reason, escalated_to_role, triggered_by, triggered_by_role, metadata
     from pilot.safety_escalations where organization_id = $1 and athlete_id = $2 order by created_at, reason`,
    [ORG, athleteId],
  );
  return rows;
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
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, 'coach', $2, 'microsoft')`,
    [COACH, ORG],
  );
  for (const athlete of ATHLETES) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Symptom Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [ORG, athlete, COACH],
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

describe('the sparring symptom flag', () => {
  test("a tick files one flag to the athlete's coach: fixed severity, the ticks in words, the report keeps them", async () => {
    const client = await freshDatabase('symptoms_flag');
    try {
      const sent = await send(ATHLETE, 'after_sparring', ['dizzy', 'headache']);
      expect(sent.status).toBe(200);
      expect(sent.body).toMatchObject({
        flagged: true,
        added_symptoms: ['headache', 'dizzy'],
        item: { context: 'after_sparring', symptoms: ['headache', 'dizzy'] },
        protocol_text: '',
        recipient_role: 'coach',
      });
      const reportId = (sent.body.item as { report_id: string }).report_id;
      expect(await escalations()).toEqual([{
        source_type: 'sparring_symptom',
        source_id: reportId,
        severity: 'high',
        reason: 'Reported after sparring: Headache, Dizzy or off balance.',
        escalated_to_role: 'coach',
        triggered_by: 'human',
        triggered_by_role: 'athlete',
        metadata: expect.objectContaining({ report_id: reportId, context: 'after_sparring' }),
      }]);
      const audit = await client.query(
        `select event_type, entity_type, entity_id, details from pilot.audit_events where entity_type = 'sparring_symptom_report'`,
      );
      expect(audit.rows).toEqual([{
        event_type: 'update', entity_type: 'sparring_symptom_report', entity_id: reportId,
        details: { athlete_id: ATHLETE, context: 'after_sparring', flagged: true },
      }]);
      // Not mirrored to the SHADOW event feed.
      const mirrored = await client.query(`select count(*)::int as n from pilot.shadow_events where entity_type = 'sparring_symptom_report'`);
      expect(mirrored.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('a resend flags nothing new, a smaller resend removes nothing, and a new tick flags only itself', async () => {
    const client = await freshDatabase('symptoms_resend');
    try {
      await send(ATHLETE, 'after_sparring', ['headache', 'dizzy']);
      expect((await send(ATHLETE, 'after_sparring', ['headache', 'dizzy'])).body).toMatchObject({ flagged: false, added_symptoms: [] });
      expect((await send(ATHLETE, 'after_sparring', ['headache'])).body).toMatchObject({
        flagged: false,
        item: { symptoms: ['headache', 'dizzy'] },
      });
      const more = await send(ATHLETE, 'after_sparring', ['ringing', 'headache']);
      expect(more.body).toMatchObject({ flagged: true, added_symptoms: ['ringing'], item: { symptoms: ['headache', 'dizzy', 'ringing'] } });
      expect((await escalations()).map((row) => row.reason)).toEqual([
        'Reported after sparring: Headache, Dizzy or off balance.',
        'Reported after sparring: Ringing in your ears.',
      ]);
    } finally {
      await client.end();
    }
  });

  test('"None of these" is stored and flags nothing; a later tick the same day still flags', async () => {
    const client = await freshDatabase('symptoms_none');
    try {
      const none = await send(ATHLETE, 'next_day', []);
      expect(none.body).toMatchObject({ flagged: false, item: { context: 'next_day', symptoms: [] } });
      expect(await escalations()).toEqual([]);
      expect((await send(ATHLETE, 'next_day', ['foggy'])).body).toMatchObject({ flagged: true });
      expect((await escalations()).map((row) => row.reason)).toEqual(['Reported the day after sparring: Foggy or slow.']);
    } finally {
      await client.end();
    }
  });

  test('the severity is the same however many items are ticked', async () => {
    const client = await freshDatabase('symptoms_severity');
    try {
      await send(ATHLETE, 'after_sparring', ['ringing']);
      await send(OTHER_ATHLETE, 'after_sparring', ['headache', 'dizzy', 'nausea', 'foggy', 'vision', 'ringing', 'hard_head_shot']);
      const severities = [...await escalations(ATHLETE), ...await escalations(OTHER_ATHLETE)].map((row) => row.severity);
      expect(severities).toEqual(['high', 'high']);
    } finally {
      await client.end();
    }
  });

  test("the gym's recipient setting routes the flag and the sent line; its protocol words come back", async () => {
    const client = await freshDatabase('symptoms_recipient');
    try {
      await client.query(
        `insert into pilot.organization_symptom_flag_settings (organization_id, recipient_role, protocol_text)
         values ($1, 'organization_admin', 'Sit out the rest of the night.')`,
        [ORG],
      );
      const sent = await send(ATHLETE, 'after_sparring', ['vision']);
      expect(sent.body).toMatchObject({ recipient_role: 'organization_admin', protocol_text: 'Sit out the rest of the night.' });
      expect((await escalations()).map((row) => row.escalated_to_role)).toEqual(['organization_admin']);
    } finally {
      await client.end();
    }
  });

  test('the next-day check is due after an own sparring session or a sparring log the previous gym day, not otherwise', async () => {
    const client = await freshDatabase('symptoms_next_day');
    try {
      // 2026-10-20 16:00Z is noon on 2026-10-20 at the gym; the previous gym day is 2026-10-19.
      const now = new Date('2026-10-20T16:00:00Z');
      await client.query(
        `insert into pilot.sessions (organization_id, session_id, athlete_id, date, rpe, rpe_method, notes, completed_flag,
           created_at, updated_at, session_type)
         values ($1, 's-1', $2, '2026-10-19', 7, 'athlete_post_session_self_report', '', true, now(), now(), 'sparring'),
                ($1, 's-2', $3, '2026-10-19', 5, 'athlete_post_session_self_report', '', true, now(), now(), 'technique'),
                ($1, 's-3', $3, '2026-10-17', 8, 'athlete_post_session_self_report', '', true, now(), now(), 'sparring')`,
        [ORG, ATHLETE, OTHER_ATHLETE],
      );
      await client.query(
        `insert into pilot.sparring_exposure (organization_id, exposure_id, activity_id, athlete_id, segment_number, sparring_type,
           time_under_impact_sec, coach_observed_intensity, coach_observed_head_contact, supervising_coach_account_id, session_date)
         values ($1, 'x-1', null, $2, 1, 'technical', 60, 'light', 'incidental', $3, '2026-10-19')`,
        [ORG, THIRD_ATHLETE, COACH],
      );
      const due = await Promise.all(ATHLETES.map(async (athleteId) => (await getSparringSymptomToday(ORG, athleteId, now)).nextDayDue));
      expect(due).toEqual([true, false, true]);
    } finally {
      await client.end();
    }
  });

  test('only the athlete reaches the route, for their own record; a deleted athlete is refused', async () => {
    const client = await freshDatabase('symptoms_access');
    try {
      for (const role of ['coach', 'organization_admin', 'admin', 'parent', 'platform_owner'] as const) {
        expect({ role, status: (await call(principal(role, null), 'GET')).status }).toEqual({ role, status: 403 });
        expect({ role, status: (await call(principal(role, null), 'POST', { context: 'after_sparring', symptoms: ['headache'] })).status })
          .toEqual({ role, status: 403 });
      }
      expect((await call(principal('athlete', null, 'acct-unlinked'), 'GET')).status).toBe(400);

      await send(OTHER_ATHLETE, 'after_sparring', ['headache']);
      // The route has no athlete id to aim: an athlete reads only their own day.
      expect((await call(principal('athlete', ATHLETE), 'GET')).body).toMatchObject({ after_sparring: null, next_day: null });

      await client.query(`update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`, [ORG, ATHLETE]);
      expect((await call(principal('athlete', ATHLETE), 'GET')).status).toBe(403);
      expect((await send(ATHLETE, 'after_sparring', ['headache'])).status).toBe(403);
      expect(await escalations(ATHLETE)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('a context or item outside the lists, or no list, is refused with its reason and writes nothing', async () => {
    const client = await freshDatabase('symptoms_validation');
    try {
      for (const [context, symptoms, field] of [
        ['before_sparring', ['headache'], 'context'],
        ['after_sparring', ['concussion'], 'symptoms'],
        ['after_sparring', 'headache', 'symptoms'],
        ['after_sparring', [3], 'symptoms'],
      ] as const) {
        const refused = await send(ATHLETE, context, symptoms);
        expect({ field, status: refused.status, mentions: String(refused.body.error).includes(field) })
          .toEqual({ field, status: 400, mentions: true });
      }
      const stored = await client.query('select count(*)::int as n from pilot.sparring_symptom_reports');
      expect(stored.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });
});
