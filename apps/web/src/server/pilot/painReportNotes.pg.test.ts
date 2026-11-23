// DR-25 on real PostgreSQL, through the real routes: the athlete's note on a pain report and the
// coach's "Mark reviewed" (Jason 2026-11-23, DR-25 A, to be recorded; Overwatch GO on PR #2133,
// Q1-Q6 A).
//
// What this proves, with the whole schema in the `all` order (so the pain-report-review migration
// and every reader's tables are real):
//   - a note lands on the pain report's near miss and NOWHERE ELSE: a marker string in it is absent
//     from the observation, the shadow event, the near miss's description and metadata, every
//     escalation and the audit trail;
//   - the athlete's response is the same whether or not the note discloses, and whether or not the
//     escalation it owes could be filed (oracle-safe);
//   - a disclosing note files the escalation the SHADOW chat rules give it (admin-only names staff:
//     'athlete_voice'; otherwise 'shadow_disclosure'), with a fixed reason and no words of the note;
//   - a coach's read never carries an admin-only note, or anything saying one exists; an
//     organization admin's read carries it and the verdict;
//   - "Mark reviewed" has the read's gate exactly: any coach of the gym (since #1480) and an
//     organization admin may; another gym's coach and a deleted athlete get the same 404 as a
//     missing report; parent, athlete, board and platform owner are refused by role; the first
//     review wins;
//   - once an athlete's note named staff, their later disclosing notes stay admin-only (SHADOW
//     chat's conversationAlreadyNamedStaff), and the escalation is filed even when the shadow event
//     that follows the near miss fails;
//   - a note over 500 characters, or from anyone but the athlete, is refused before anything is
//     stored.
// The sentences that disclose are verbatim from shadowDisclosureRoute.pg.test.ts, where the SHADOW
// rules classify them. It never connects to production or staging.

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
  ...jest.requireActual('./db'),
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
    const client = activeClient;
    await client.query('BEGIN');
    try {
      const result = await fn({ query: (text: string, values: unknown[]) => client.query(text, values) });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }),
}));

jest.mock('./http', () => ({
  ...jest.requireActual('./http'),
  requirePrincipal: jest.fn(),
}));

jest.mock('./shadowReadiness', () => ({
  assertShadowRuntimeReadiness: jest.fn(async () => undefined),
}));

import { NextRequest } from 'next/server';

import { GET as painReportsGET } from '@/app/api/pilot/coach/pain-reports/route';
import { GET as noteGET } from '@/app/api/pilot/coach/pain-reports/[nearMissId]/note/route';
import { POST as reviewPOST } from '@/app/api/pilot/coach/pain-reports/[nearMissId]/review/route';
import { POST as observationsPOST } from '@/app/api/pilot/shadow/formulas/observations/route';
import { getStaffDisplayName } from './achievements';
import type { PilotPrincipal } from './auth';
import * as escalationLadder from './escalationLadder';
import * as shadowEvents from './shadowEvents';
import { requirePrincipal } from './http';

jest.setTimeout(300_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-pain-notes-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const TEMPLATE_DB = 'prn_template';

const ORG = 'org-pain-notes';
const OTHER_ORG = 'org-pain-notes-other';
const ATHLETE_ID = 'ATH-PN-1';
const ATHLETE_ACCOUNT = 'acct-pn-athlete';
const COACH_OF_RECORD = 'acct-pn-coach';
const UNRELATED_COACH = 'acct-pn-coach-other';
const ORG_ADMIN = 'acct-pn-admin';
const PARENT = 'acct-pn-parent';
const BOARD = 'acct-pn-board';
const OTHER_GYM_COACH = 'acct-pn-coach-elsewhere';

// Verbatim from shadowDisclosureRoute.pg.test.ts (LEADS-CHECK-2026-10-15): names gym staff.
const STAFF_DISCLOSURE = 'My coach hits me and I am scared to go to the gym';
// Same source: a disclosure that names no one at the gym.
const NON_STAFF_DISCLOSURE = 'My dad hits me';
const MARKER = 'ZQX7MARKER';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const mockRequirePrincipal = jest.mocked(requirePrincipal);

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let databaseCounter = 0;

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

async function adminQuery(sql: string): Promise<void> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

function principal(accountId: string, role: PilotPrincipal['role'], organizationId = ORG, athleteId: string | null = null): PilotPrincipal {
  return { accountId, role, organizationId, athleteId, sessionToken: `session-${accountId}`, authProvider: 'ppbf_local' };
}

const AS = {
  athlete: () => principal(ATHLETE_ACCOUNT, 'athlete', ORG, ATHLETE_ID),
  coach: () => principal(COACH_OF_RECORD, 'coach'),
  unrelatedCoach: () => principal(UNRELATED_COACH, 'coach'),
  orgAdmin: () => principal(ORG_ADMIN, 'organization_admin'),
  otherGymCoach: () => principal(OTHER_GYM_COACH, 'coach', OTHER_ORG),
};

let sequence = 0;

/** The athlete's pain report, as AthleteWorkspace.tsx sends it, with an optional note. */
async function filePain(note: unknown, options: { as?: PilotPrincipal; value?: number; kind?: string } = {}) {
  mockRequirePrincipal.mockResolvedValue(options.as ?? AS.athlete());
  sequence += 1;
  const id = `pain_${Date.now()}_${sequence}`;
  const body: Record<string, unknown> = {
    athleteId: ATHLETE_ID,
    contextId: id,
    kind: options.kind ?? 'pain_report',
    value: options.value ?? 3,
    unit: 'severity_1_10',
    dimensions: { location: 'Left knee', painType: 'Sharp', injuryFlag: true },
    observedAt: new Date().toISOString(),
    idempotencyKey: `${id}-pain_report`,
  };
  if (note !== undefined) body.note = note;
  const response = await observationsPOST(new NextRequest('http://localhost/api/pilot/shadow/formulas/observations', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }));
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function readPainList(as: PilotPrincipal) {
  mockRequirePrincipal.mockResolvedValue(as);
  const response = await painReportsGET(new NextRequest('http://localhost/api/pilot/coach/pain-reports'));
  return { status: response.status, body: await response.json() as { painReports?: Array<Record<string, unknown>> } };
}

async function readNote(as: PilotPrincipal, nearMissId: string) {
  mockRequirePrincipal.mockResolvedValue(as);
  const response = await noteGET(
    new NextRequest(`http://localhost/api/pilot/coach/pain-reports/${nearMissId}/note`),
    { params: Promise.resolve({ nearMissId }) },
  );
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function review(as: PilotPrincipal, nearMissId: string) {
  mockRequirePrincipal.mockResolvedValue(as);
  const response = await reviewPOST(
    new NextRequest(`http://localhost/api/pilot/coach/pain-reports/${nearMissId}/review`, { method: 'POST' }),
    { params: Promise.resolve({ nearMissId }) },
  );
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function nearMisses(): Promise<Array<Record<string, unknown>>> {
  return (await activeClient!.query(
    `select near_miss_id::text, description, metadata, athlete_note, athlete_note_admin_only,
            reviewed_by_account_id, reviewed_at
       from pilot.shadow_near_misses order by created_at`,
  )).rows;
}

async function escalations(): Promise<Array<Record<string, unknown>>> {
  return (await activeClient!.query(
    `select source_type, source_id, escalated_to_role, reason, metadata from pilot.safety_escalations order by created_at`,
  )).rows;
}

/** Every place other than the near miss's own note column that could carry the note's words. */
async function markerElsewhere(): Promise<string[]> {
  const found: string[] = [];
  const checks: Array<[string, string]> = [
    ['shadow_formula_observations', 'select to_jsonb(o)::text as t from pilot.shadow_formula_observations o'],
    ['shadow_events', 'select to_jsonb(e)::text as t from pilot.shadow_events e'],
    ['near miss description/metadata', 'select description || metadata::text as t from pilot.shadow_near_misses'],
    ['safety_escalations', 'select to_jsonb(s)::text as t from pilot.safety_escalations s'],
    ['shadow_audit_entries', 'select to_jsonb(a)::text as t from pilot.shadow_audit_entries a'],
  ];
  for (const [label, sql] of checks) {
    const rows = (await activeClient!.query(sql)).rows as Array<{ t: string }>;
    if (rows.some((row) => row.t.includes(MARKER))) found.push(label);
  }
  return found;
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
  const applyFullSchema = fullSchema.applyFullSchema as (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
  await adminQuery(`drop database if exists ${TEMPLATE_DB} with (force)`);
  await adminQuery(`create database ${TEMPLATE_DB}`);
  const template = new Client({ connectionString: connectionStringFor(TEMPLATE_DB) });
  await template.connect();
  try {
    await applyFullSchema(template, { infraDir: INFRA_DIR });
    for (const org of [ORG, OTHER_ORG]) {
      await template.query(
        `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
        [org],
      );
    }
    for (const [account, role, org, email] of [
      [COACH_OF_RECORD, 'coach', ORG, 'rosa.coach@gym.test'],
      [UNRELATED_COACH, 'coach', ORG, 'other.coach@gym.test'],
      [ORG_ADMIN, 'organization_admin', ORG, 'office@gym.test'],
      [PARENT, 'parent', ORG, 'parent@home.test'],
      [BOARD, 'board', ORG, 'board@gym.test'],
      [OTHER_GYM_COACH, 'coach', OTHER_ORG, 'elsewhere@gym.test'],
    ] as const) {
      await template.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email) values ($1, $2, $3, 'microsoft', $4)`,
        [account, role, org, email],
      );
    }
    await template.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Note Athlete', '2013-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [ORG, ATHLETE_ID, COACH_OF_RECORD],
    );
    await template.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id) values ($1, 'athlete', $2, 'ppbf_local', $3)`,
      [ATHLETE_ACCOUNT, ORG, ATHLETE_ID],
    );
  } finally {
    await template.end();
  }
});

beforeEach(async () => {
  databaseCounter += 1;
  const name = `prn_case_${databaseCounter}`;
  await adminQuery(`drop database if exists ${name} with (force)`);
  await adminQuery(`create database ${name} template ${TEMPLATE_DB}`);
  activeClient = new Client({ connectionString: connectionStringFor(name) });
  await activeClient.connect();
  mockRequirePrincipal.mockReset();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await activeClient?.end();
  activeClient = null;
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

/** The athlete's answer with what differs between any two saves (ids, times) taken out. */
function comparable(body: Record<string, unknown>): string {
  return JSON.stringify(body, (key, value) => (
    /id$|Id$|_at$|At$|^observation$/.test(key) && key !== '' ? '<varies>' : value
  ));
}

describe('pain report note (DR-25)', () => {
  test('a note lands on the near miss and nowhere else', async () => {
    const filed = await filePain(`left knee clicks ${MARKER} when I squat`);
    expect(filed.status).toBe(200);

    const [row] = await nearMisses();
    expect(row.athlete_note).toBe(`left knee clicks ${MARKER} when I squat`);
    expect(row.athlete_note_admin_only).toBe(false);
    expect(await markerElsewhere()).toEqual([]);
    expect(await escalations()).toEqual([]);
  });

  test('a disclosing note is stored the same way and files its escalation with no words of the note', async () => {
    // The disclosure naming no one first: once staff are named, later ones stay admin-only.
    await filePain(`${NON_STAFF_DISCLOSURE} ${MARKER}`);
    await filePain(`${STAFF_DISCLOSURE} ${MARKER}`);

    const rows = await nearMisses();
    expect(rows.map((row) => row.athlete_note_admin_only)).toEqual([false, true]);
    expect(await markerElsewhere()).toEqual([]);

    const filed = await escalations();
    expect(filed.map((row) => [row.source_type, row.escalated_to_role])).toEqual([
      ['shadow_disclosure', 'coach'],
      ['athlete_voice', 'organization_admin'],
    ]);
    for (const [index, escalation] of filed.entries()) {
      expect(escalation.source_id).toBeNull();
      expect(escalation.reason).toBe(
        'An athlete wrote a note on a pain report that needs a person to read it. '
        + 'Open the Escalations page and press Read the note on this escalation. If it does not open, speak with the athlete.',
      );
      expect(escalation.metadata).toEqual({ channel: 'pain_report_note', near_miss_id: rows[index].near_miss_id });
    }
  });

  test("once a note named staff, the same athlete's later disclosing notes stay admin-only; a plain note does not", async () => {
    await filePain(STAFF_DISCLOSURE);
    await filePain('he hit me again');
    await filePain('my knee still hurts');

    const rows = await nearMisses();
    expect(rows.map((row) => row.athlete_note_admin_only)).toEqual([true, true, false]);
    expect((await escalations()).map((row) => row.source_type)).toEqual(['athlete_voice', 'athlete_voice']);
    const coach = await readPainList(AS.coach());
    expect(coach.body.painReports!.map((report) => report.note ?? '(no note)').sort())
      .toEqual(['(no note)', '(no note)', 'my knee still hurts']);
  });

  test('an unresolved athlete_voice escalation from SHADOW chat makes a later disclosing note admin-only', async () => {
    // Q10 B on #2138: the child named staff in SHADOW chat first.
    await escalationLadder.fileEscalation({
      organizationId: ORG,
      sourceType: 'athlete_voice',
      sourceId: null,
      athleteId: ATHLETE_ID,
      severity: 'critical',
      reason: 'An athlete said something in SHADOW chat that needs a person to follow up.',
      escalatedToRole: 'organization_admin',
      triggeredBy: 'system',
      metadata: { channel: 'shadow_chat', conversation_id: 'conv-1' },
    });
    await filePain('he hit me again');
    expect((await nearMisses()).map((row) => row.athlete_note_admin_only)).toEqual([true]);
  });

  test('a resolved athlete_voice escalation from another channel, with no pain-note history, is not counted', async () => {
    const chat = await escalationLadder.fileEscalation({
      organizationId: ORG,
      sourceType: 'athlete_voice',
      sourceId: null,
      athleteId: ATHLETE_ID,
      severity: 'high',
      reason: 'An athlete used the feedback box to say something that needs a person to read it.',
      escalatedToRole: 'organization_admin',
      triggeredBy: 'system',
      metadata: { submission_id: 'sub-1' },
    });
    await activeClient!.query(
      `update pilot.safety_escalations set status = 'resolved', resolved_at = now() where escalation_id = $1`,
      [chat.escalation_id],
    );
    await filePain('he hit me again');
    expect((await nearMisses()).map((row) => row.athlete_note_admin_only)).toEqual([false]);
  });

  test('an earlier note held for admins counts even when its escalation was never filed', async () => {
    jest.spyOn(escalationLadder, 'fileEscalation').mockRejectedValueOnce(new Error('database went away'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await filePain(STAFF_DISCLOSURE);
    expect(await escalations()).toEqual([]);

    await filePain('he hit me again');
    const rows = await nearMisses();
    expect(rows.map((row) => row.athlete_note_admin_only)).toEqual([true, true]);
    expect((await escalations()).map((row) => row.source_type)).toEqual(['athlete_voice']);
  });

  test('a failed earlier-note lookup holds the note for admins and still stores the report, with the same answer', async () => {
    const plain = await filePain('sore after sparring');
    const db = jest.requireMock('./db') as { queryOne: jest.Mock };
    const original = db.queryOne.getMockImplementation()!;
    db.queryOne.mockImplementation(async (text: string, params: unknown[] = []) => {
      if (text.includes('athlete_note_admin_only)')) throw new Error('lookup failed');
      return original(text, params);
    });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const answer = await filePain('he hit me again');
      expect(answer.status).toBe(200);
      expect(comparable(answer.body)).toBe(comparable(plain.body));
    } finally {
      db.queryOne.mockImplementation(original);
    }
    const rows = await nearMisses();
    expect(rows.map((row) => [row.athlete_note, row.athlete_note_admin_only])).toEqual([
      ['sore after sparring', false],
      ['he hit me again', true],
    ]);
  });

  test('the escalation is filed even when the shadow event after the near miss fails', async () => {
    jest.spyOn(shadowEvents, 'emitShadowEvent').mockRejectedValue(new Error('event insert failed'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const answer = await filePain(STAFF_DISCLOSURE);
    expect(answer.status).toBe(500);
    expect((await escalations()).map((row) => row.source_type)).toEqual(['athlete_voice']);
  });

  test('the athlete is answered the same with a plain note, a disclosing note, no note, and when the escalation fails', async () => {
    const plain = await filePain('sore after sparring');
    const disclosing = await filePain(STAFF_DISCLOSURE);
    const none = await filePain(undefined);
    jest.spyOn(escalationLadder, 'fileEscalation').mockRejectedValue(new Error('database went away'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const failed = await filePain(STAFF_DISCLOSURE);

    for (const answer of [plain, disclosing, none, failed]) {
      expect(answer.status).toBe(200);
      expect(comparable(answer.body)).toBe(comparable(plain.body));
    }
    expect((plain.body.painReport as Record<string, unknown>).coachNotified).toBe(true);

    // The failed filing still stored the note held for admins, so no coach can read it.
    const rows = await nearMisses();
    expect(rows[3].athlete_note).toBe(STAFF_DISCLOSURE);
    expect(rows[3].athlete_note_admin_only).toBe(true);
    // The log names the report, never the note.
    const logged = JSON.stringify(jest.mocked(console.error).mock.calls);
    expect(logged).not.toContain('coach hits');
  });

  test('a note over 500 characters, from a coach, on another kind, or not a string is refused before anything is stored', async () => {
    expect((await filePain('x'.repeat(501))).status).toBe(400);
    expect((await filePain(['not', 'text'])).status).toBe(400);
    expect((await filePain('sore\u0000knee')).status).toBe(400);
    expect((await filePain('sore', { as: AS.coach() })).status).toBe(400);
    expect((await filePain('sore', { kind: 'numeric', value: 4 })).status).toBe(400);
    expect(await nearMisses()).toEqual([]);

    // 500 accented characters are 500, not 1000 bytes; edge whitespace is trimmed; blank is no note.
    expect((await filePain(`  ${'é'.repeat(500)}\n`)).status).toBe(200);
    expect((await filePain('   \n\t ')).status).toBe(200);
    expect((await filePain(' \u200b\ufeff ')).status).toBe(200);
    expect((await nearMisses()).map((row) => row.athlete_note)).toEqual(['é'.repeat(500), null, null]);
  });
});

describe('the coach pain list (DR-25)', () => {
  test('a coach reads a plain note; an admin-only note reaches a coach as no note at all', async () => {
    await filePain('sore after sparring');
    await filePain(STAFF_DISCLOSURE);

    const coach = await readPainList(AS.coach());
    expect(coach.status).toBe(200);
    const coachNotes = coach.body.painReports!.map((report) => report.note).sort();
    expect(coachNotes).toEqual([null, 'sore after sparring']);
    // Nothing on the coach's copy says a held note exists: the same keys as a report with none.
    for (const report of coach.body.painReports!) {
      expect(Object.keys(report).sort()).toEqual(Object.keys(coach.body.painReports![0]).sort());
      expect(report).not.toHaveProperty('noteAdminOnly');
    }
    expect(JSON.stringify(coach.body)).not.toContain('coach hits');

    const admin = await readPainList(AS.orgAdmin());
    const adminView = admin.body.painReports!.map((report) => [report.note, report.noteAdminOnly]).sort();
    expect(adminView).toEqual([[STAFF_DISCLOSURE, true], ['sore after sparring', false]]);
  });
});

describe('Mark reviewed (DR-25)', () => {
  test('the coach of record marks it reviewed; the first review wins; the list shows who and when', async () => {
    await filePain('sore after sparring');
    const [{ near_miss_id: id }] = await nearMisses();

    const first = await review(AS.coach(), id as string);
    expect(first.status).toBe(200);
    const expectedName = await getStaffDisplayName(ORG, COACH_OF_RECORD);
    expect(first.body.reviewed).toEqual({ at: expect.any(String), byName: expectedName });
    expect(JSON.stringify(first.body)).not.toContain(COACH_OF_RECORD);

    const second = await review(AS.orgAdmin(), id as string);
    expect(second.status).toBe(200);
    expect(second.body.reviewed).toEqual(first.body.reviewed);

    const [row] = await nearMisses();
    expect(row.reviewed_by_account_id).toBe(COACH_OF_RECORD);
    const audits = (await activeClient!.query(
      `select action, actor_account_id from pilot.shadow_audit_entries where entity_type = 'near_miss' and action = 'reviewed'`,
    )).rows;
    expect(audits).toEqual([{ action: 'reviewed', actor_account_id: COACH_OF_RECORD }]);

    const list = await readPainList(AS.coach());
    expect(list.body.painReports![0].reviewed).toEqual(first.body.reviewed);
  });

  test('any coach the read admits may review: a coach of this gym who is not the coach of record', async () => {
    // The read's gate, not a narrower one (Q1 A): since #1480 (2026-10-12) a coach reaches every
    // live athlete of their own gym (access.ts assertCoachReachesAthlete), so they read the list.
    await filePain('sore after sparring');
    const [{ near_miss_id: id }] = await nearMisses();
    expect((await readPainList(AS.unrelatedCoach())).body.painReports).toHaveLength(1);
    const answer = await review(AS.unrelatedCoach(), id as string);
    expect(answer.status).toBe(200);
    expect((await nearMisses())[0].reviewed_by_account_id).toBe(UNRELATED_COACH);
  });

  test('a deleted athlete, another gym, a missing report, a near miss that is not a pain report and a malformed id all get the same 404', async () => {
    await filePain('sore after sparring');
    const [{ near_miss_id: id }] = await nearMisses();
    const handFlagged = (await activeClient!.query(
      `insert into pilot.shadow_near_misses (organization_id, athlete_id, description, severity, detected_by, metadata)
       values ($1, $2, 'Hand-flagged.', 'low', 'human', '{}'::jsonb) returning near_miss_id::text`,
      [ORG, ATHLETE_ID],
    )).rows[0].near_miss_id as string;

    const refused = [
      await review(AS.otherGymCoach(), id as string),
      await review(AS.coach(), '00000000-0000-4000-8000-000000000000'),
      await review(AS.coach(), handFlagged),
      await review(AS.coach(), 'not-a-uuid'),
    ];
    // Refused by the access check itself: the athlete was deleted, so no coach reaches them.
    await activeClient!.query('update pilot.athletes set deleted_at = now() where athlete_id = $1', [ATHLETE_ID]);
    refused.push(await review(AS.coach(), id as string));
    for (const answer of refused) {
      expect(answer.status).toBe(404);
      expect(answer.body).toEqual(refused[0].body);
    }
    const rows = await nearMisses();
    expect(rows.every((row) => row.reviewed_at === null && row.reviewed_by_account_id === null)).toBe(true);
  });

  test('parent, athlete, board and platform owner are refused by role and nothing is written', async () => {
    await filePain('sore after sparring');
    const [{ near_miss_id: id }] = await nearMisses();
    for (const as of [
      principal(PARENT, 'parent'),
      AS.athlete(),
      principal(BOARD, 'board'),
      principal('acct-pn-platform', 'platform_owner'),
    ]) {
      const answer = await review(as, id as string);
      expect([as.role, answer.status]).toEqual([as.role, 403]);
    }
    const [row] = await nearMisses();
    expect(row.reviewed_at).toBeNull();
  });
});

// Q12 A on #2139: "Read the note" on a pain-note escalation, through the near miss it points at.
describe('Read the note (DR-25, Q12 A)', () => {
  test('an admin reads a held note and is told it is held; a coach reading the same gets no note and no key', async () => {
    await filePain(STAFF_DISCLOSURE);
    const [{ near_miss_id: id }] = await nearMisses();

    const admin = await readNote(AS.orgAdmin(), id as string);
    expect(admin.status).toBe(200);
    expect(admin.body).toEqual({ ok: true, note: STAFF_DISCLOSURE, noteAdminOnly: true });

    const coach = await readNote(AS.coach(), id as string);
    expect(coach.status).toBe(200);
    expect(coach.body).toEqual({ ok: true, note: null });
  });

  test('a coach reads a plain note; the read has no 7-day window', async () => {
    await filePain('sore after sparring');
    const [{ near_miss_id: id }] = await nearMisses();
    await activeClient!.query(
      `update pilot.shadow_near_misses set created_at = now() - interval '30 days' where near_miss_id = $1::uuid`,
      [id],
    );
    expect((await readPainList(AS.coach())).body.painReports).toEqual([]);
    const coach = await readNote(AS.coach(), id as string);
    expect(coach.body).toEqual({ ok: true, note: 'sore after sparring' });
  });

  test('another gym, a deleted athlete, a missing report, a non-pain near miss and a malformed id all get the same 404', async () => {
    await filePain('sore after sparring');
    const [{ near_miss_id: id }] = await nearMisses();
    const handFlagged = (await activeClient!.query(
      `insert into pilot.shadow_near_misses (organization_id, athlete_id, description, severity, detected_by, metadata)
       values ($1, $2, 'Hand-flagged.', 'low', 'human', '{}'::jsonb) returning near_miss_id::text`,
      [ORG, ATHLETE_ID],
    )).rows[0].near_miss_id as string;

    const refused = [
      await readNote(AS.otherGymCoach(), id as string),
      await readNote(AS.orgAdmin(), '00000000-0000-4000-8000-000000000000'),
      await readNote(AS.orgAdmin(), handFlagged),
      await readNote(AS.orgAdmin(), 'not-a-uuid'),
    ];
    await activeClient!.query('update pilot.athletes set deleted_at = now() where athlete_id = $1', [ATHLETE_ID]);
    refused.push(await readNote(AS.orgAdmin(), id as string));
    for (const answer of refused) {
      expect(answer.status).toBe(404);
      expect(answer.body).toEqual(refused[0].body);
    }
  });

  test('parent, athlete, board and platform owner are refused by role', async () => {
    await filePain('sore after sparring');
    const [{ near_miss_id: id }] = await nearMisses();
    for (const as of [
      principal(PARENT, 'parent'),
      AS.athlete(),
      principal(BOARD, 'board'),
      principal('acct-pn-platform', 'platform_owner'),
    ]) {
      const answer = await readNote(as, id as string);
      expect([as.role, answer.status]).toEqual([as.role, 403]);
      expect(JSON.stringify(answer.body)).not.toContain('sore after sparring');
    }
  });
});
