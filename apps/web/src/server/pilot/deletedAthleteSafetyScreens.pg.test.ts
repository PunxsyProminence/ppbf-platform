// Real PostgreSQL-backed proof of the org-admin safety screens' answer for a
// deleted athlete (Jason, 2026-09-30, OD-2026-09-30-004 "#1027 Q1", "B"):
// a deleted athlete's items leave a safety screen ONCE THEY ARE RESOLVED; an
// unresolved one stays until somebody deals with it.
//
// WHAT "RESOLVED" MEANS, per screen, in its own data:
//   safety escalations   status 'resolved'                     (open, acknowledged stay)
//   training holds       status 'lifted' or 'expired'          (active stays)
//   compliance violations status 'resolved' or 'dismissed'     (new, acknowledged, escalated stay)
//   feedback queue       triage_status 'done' or 'declined'    (new, triaged, planned stay)
// Those four readers changed. A fifth change is the one place B does not
// apply: the safety review page's FAILING GATES leave at once (Jason,
// 2026-09-30). A gate resolves only by a newer passing evaluation, and no path
// can write one for a deleted athlete, so "until resolved" would have meant
// "until the retention purge". Three screens already behaved this way and are
// PINNED here, not changed, so a later edit cannot quietly break them:
//   safety flags         lists status 'open' only
//   safety review page   lists active holds, unresolved escalations and open
//                        violations
//   board escalation summary counts status 'open' only, names nobody
// The eighth, the video-compliance publication queue, hid a deleted athlete's
// publications at once in #1027 and is not revisited here.
//
// EVERY READER IS RUN BEFORE AND AFTER THE DELETION, IN THE SAME DATABASE.
// "Before" is the positive control: a reader that showed nothing would pass
// every "after" assertion. LIVE carries the same items as GONE and is never
// deleted: a filter that hid everyone's resolved items would fail on LIVE. A
// second gym's athlete carries GONE's id and is never deleted: a filter that
// matched on athlete_id alone would fail on it.
//
// The deletion is the real deleteAthleteRecord, so the mark read here is the
// one production writes.
//
// Spins up the same disposable, local-only embedded Postgres the other suites
// use. It NEVER connects to production or staging.

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

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

// Routes every module's queries into the embedded database. withTransaction
// runs on the SAME client, so the deletion is one unit of work as in production.
let activeClient: Client | null = null;

jest.mock('./db', () => ({
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
}));

// The routes take their principal from here; the rest of the module stays real.
jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return {
    ...actual,
    requirePrincipal: jest.fn(),
    requireMicrosoftAuthenticatedPrincipal: jest.fn(),
  };
});

import { GET as safetyReviewGET } from '@/app/api/pilot/admin/safety-review/route';
import { GET as boardEscalationSummaryGET } from '@/app/api/pilot/board/escalation-summary/route';
import { GET as violationsGET } from '@/app/api/pilot/compliance/violations/route';
import { GET as escalationsGET } from '@/app/api/pilot/escalations/route';
import { POST as feedbackListPOST } from '@/app/api/pilot/feedback/list/route';
import { GET as safetyFlagsGET } from '@/app/api/pilot/safety-flags/route';
import { GET as trainingHoldsGET } from '@/app/api/pilot/training-holds/route';

import type { PilotPrincipal } from './auth';
import { deleteAthleteRecord } from './dataDeletion';
import { insertAthleteIfAbsent } from './entities';
import { requireMicrosoftAuthenticatedPrincipal, requirePrincipal } from './http';
import { raiseSafetyFlag, resolveSafetyFlag } from './safetyFlags';

jest.setTimeout(600_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-deleted-athlete-safety-screens-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const DATABASE = 'deleted_athlete_safety_screens';

const ORG = 'org-l2';
/** A second gym whose athlete carries GONE's id and is never deleted. */
const OTHER_ORG = 'org-l2-other';

const ADMIN = 'acct-l2-admin';
const COACH = 'acct-l2-coach';
const BOARD = 'acct-l2-board';
const OTHER_ADMIN = 'acct-l2-other-admin';
const OTHER_COACH = 'acct-l2-other-coach';
/** A guardian deleted over a year ago, whose account the retention purge removes mid-suite. */
const PURGED_GUARDIAN = 'acct-l2-guardian-purged';

/** Deleted between the two halves of the suite. */
const GONE = 'ATH-L2-GONE';
/** The second gym's athlete account for ITS athlete carrying GONE's id; never deleted. */
const OTHER_GONE_ACCOUNT = 'acct-l2-other-athlete-gone';
const GONE_ACCOUNT = 'acct-l2-athlete-gone';
/** Never deleted: the control. */
const LIVE = 'ATH-L2-LIVE';
const LIVE_ACCOUNT = 'acct-l2-athlete-live';
/* ACCOUNTS THAT DRIFT. A submission freezes the gym and the capacity it was
   written in; the account behind it can be re-roled or moved to another gym
   afterwards, keeping its athlete_id (auth.ts upsertOrganizationMembership).
   Each of these has feedback and no other safety item. */
/** An athlete who becomes a coach on the same login; the athlete record is later deleted. */
const AGED = 'ATH-L2-AGED';
const AGED_ACCOUNT = 'acct-l2-athlete-aged';
/** One athlete_id in both gyms: live in ORG, deleted in OTHER_ORG. The ORG login later moves to OTHER_ORG. */
const SHARED = 'ATH-L2-SHARED';
const SHARED_ACCOUNT = 'acct-l2-athlete-shared';
/** A guardian whose login moves to OTHER_ORG and is deleted there. */
const MOVED_GUARDIAN = 'acct-l2-guardian-moved';
/** An athlete deleted, then removed by the retention purge, which leaves the login behind.
    The second gym has a live athlete with the same id. */
const PURGED_ATHLETE = 'ATH-L2-PURGED';
const PURGED_ATHLETE_ACCOUNT = 'acct-l2-athlete-purged';
/** An athlete deleted and purged, whose athlete_id the roster then gives to a different child. */
const REUSED = 'ATH-L2-REUSED';
const REUSED_ACCOUNT = 'acct-l2-athlete-reused';
/** As REUSED, but the old login is also purged (re-roled to parent first), so the new child can hold a login. */
const FREED = 'ATH-L2-FREED';
const FREED_ACCOUNT = 'acct-l2-athlete-freed';
const FREED_NEW_ACCOUNT = 'acct-l2-athlete-freed-new';
/** An athlete row removed while its login stayed live; the id then goes to a new child, who is later deleted. */
const ORPHANED = 'ATH-L2-ORPHANED';
const ORPHANED_ACCOUNT = 'acct-l2-athlete-orphaned';
/** A login that exists before its athlete row does; the row is created mid-suite, then the athlete writes. */
const LATE_ROW = 'ATH-L2-LATE-ROW';
const LATE_ROW_ACCOUNT = 'acct-l2-athlete-late-row';
/** A coach whose login is later re-roled to athlete and then deleted. */
const COACH_TURNED_ATHLETE = 'acct-l2-coach-turned-athlete';
/** A live athlete whose login is later re-roled to parent, deleted and purged, clearing the reference. */
const TURNED = 'ATH-L2-TURNED';
const TURNED_ACCOUNT = 'acct-l2-athlete-turned-parent';

/** Open critical escalations only. With GONE and LIVE that is six athletes; losing GONE would read five, still over the floor of 5, so the count itself shows it. */
const FILLERS = ['ATH-L2-F1', 'ATH-L2-F2', 'ATH-L2-F3', 'ATH-L2-F4'];

const RULE = 'rule-l2';
const GATE_FAILING = 'l2_gate_failing';
const GATE_CLEARED = 'l2_gate_cleared';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;

function principal(accountId: string, role: PilotPrincipal['role'], organizationId = ORG): PilotPrincipal {
  return {
    accountId,
    role,
    organizationId,
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

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

/** Every item id below is `<athlete>:<what>`, so a reader's output reads as a list of claims. */
async function seed(client: Client): Promise<void> {
  const q = (sql: string, params: unknown[] = []) => client.query(sql, params);

  for (const org of [ORG, OTHER_ORG]) {
    await q(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [org]);
  }
  for (const [account, role, org] of [
    [ADMIN, 'organization_admin', ORG],
    [COACH, 'coach', ORG],
    [BOARD, 'board', ORG],
    [OTHER_ADMIN, 'organization_admin', OTHER_ORG],
    [OTHER_COACH, 'coach', OTHER_ORG],
    [PURGED_GUARDIAN, 'parent', ORG],
    [MOVED_GUARDIAN, 'parent', ORG],
    [COACH_TURNED_ATHLETE, 'coach', ORG],
  ] as const) {
    await q(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag, login_email)
       values ($1, $2, $3, 'microsoft', true, $1 || '@gym.test')`,
      [account, role, org],
    );
  }
  for (const [org, athlete, coach] of [
    [ORG, GONE, COACH],
    [ORG, LIVE, COACH],
    ...FILLERS.map((filler) => [ORG, filler, COACH] as const),
    [OTHER_ORG, GONE, OTHER_COACH],
    [ORG, AGED, COACH],
    [ORG, SHARED, COACH],
    [OTHER_ORG, SHARED, OTHER_COACH],
    [ORG, PURGED_ATHLETE, COACH],
    [OTHER_ORG, PURGED_ATHLETE, OTHER_COACH],
    [ORG, TURNED, COACH],
    [ORG, REUSED, COACH],
    [ORG, FREED, COACH],
    [ORG, ORPHANED, COACH],
  ] as const) {
    await q(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, $2, '2011-05-06', 'fly', 'active', 'contact', true, $3, now() - interval '1 year', now())`,
      [org, athlete, coach],
    );
  }
  for (const [account, org, athlete] of [
    [GONE_ACCOUNT, ORG, GONE],
    [LIVE_ACCOUNT, ORG, LIVE],
    [OTHER_GONE_ACCOUNT, OTHER_ORG, GONE],
    [AGED_ACCOUNT, ORG, AGED],
    [SHARED_ACCOUNT, ORG, SHARED],
    [PURGED_ATHLETE_ACCOUNT, ORG, PURGED_ATHLETE],
    [TURNED_ACCOUNT, ORG, TURNED],
    [REUSED_ACCOUNT, ORG, REUSED],
    [FREED_ACCOUNT, ORG, FREED],
    [ORPHANED_ACCOUNT, ORG, ORPHANED],
    // No athlete row yet: accounts.athlete_id has no foreign key.
    [LATE_ROW_ACCOUNT, ORG, LATE_ROW],
  ] as const) {
    await q(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, auth_provider, active_flag, login_email)
       values ($1, 'athlete', $2, $3, 'ppbf_local', true, null)`,
      [account, org, athlete],
    );
  }

  const escalation = (org: string, athlete: string, what: string, status: string, severity = 'high') =>
    q(
      `insert into pilot.safety_escalations (organization_id, escalation_id, source_type, athlete_id, severity,
         reason, escalated_to_role, triggered_by, status)
       values ($1, $2, 'incident', $3, $4, 'seeded', 'organization_admin', 'human', $5)`,
      [org, `${athlete}:${what}`, athlete, severity, status],
    );
  const hold = (org: string, athlete: string, what: string, status: string, expired = false) =>
    q(
      `insert into pilot.training_holds (organization_id, hold_id, athlete_id, scope, reason_category,
         athlete_explanation, placed_by_account_id, placed_by_role, status, placed_at, expires_at)
       values ($1, $2, $3, 'all_training', 'other', 'seeded', $4, 'organization_admin', $5,
               now() - interval '3 days', case when $6 then now() - interval '1 day' else null end)`,
      [org, `${athlete}:${what}`, athlete, org === ORG ? ADMIN : OTHER_ADMIN, status, expired],
    );
  const violation = (org: string, athlete: string, what: string, status: string) =>
    q(
      `insert into pilot.compliance_violations (violation_id, organization_id, rule_id, athlete_id,
         detected_by_account_id, violation_timestamp, severity, status)
       values ($1, $2, $3, $4, $5, now(), 'high', $6)`,
      [`${athlete}:${what}`, org, RULE, athlete, org === ORG ? COACH : OTHER_COACH, status],
    );

  await q(
    `insert into pilot.compliance_rules (rule_id, organization_id, rule_name, rule_category, description, detection_logic)
     values ($1, $2, 'Headgear required for sparring', 'safety', 'Sparring without headgear.', 'manual')`,
    [RULE, ORG],
  );

  for (const [key, name] of [[GATE_FAILING, 'Failing gate'], [GATE_CLEARED, 'Cleared gate']]) {
    await q(
      `insert into pilot.safety_gates (organization_id, gate_id, gate_key, name, category, enforcement, requirement_text)
       values ($1, $2, $2, $3, 'medical', 'flag', 'seeded')`,
      [ORG, key, name],
    );
  }

  for (const athlete of [GONE, LIVE]) {
    await escalation(ORG, athlete, 'esc-open', 'open', 'critical');
    await escalation(ORG, athlete, 'esc-acknowledged', 'acknowledged');
    await escalation(ORG, athlete, 'esc-resolved', 'resolved', 'critical');

    await hold(ORG, athlete, 'hold-active', 'active');
    await hold(ORG, athlete, 'hold-lifted', 'lifted');
    await hold(ORG, athlete, 'hold-expired', 'expired', true);

    for (const status of ['new', 'acknowledged', 'escalated', 'resolved', 'dismissed']) {
      await violation(ORG, athlete, `violation-${status}`, status);
    }

    for (const [gate, outcomes] of [
      [GATE_FAILING, ['flagged']],
      [GATE_CLEARED, ['flagged', 'passed']],
    ] as const) {
      for (const [index, outcome] of outcomes.entries()) {
        await q(
          `insert into pilot.safety_gate_evaluations (organization_id, evaluation_id, gate_key, athlete_id, outcome,
             evaluated_by_account_id, evaluated_by_role, evaluated_at)
           values ($1, $2, $3, $4, $5, $6, 'coach', now() - make_interval(hours => $7))`,
          [ORG, `${athlete}:${gate}:${index}`, gate, athlete, outcome, COACH, 10 - index],
        );
      }
    }
  }
  for (const filler of FILLERS) {
    await escalation(ORG, filler, 'esc-open', 'open', 'critical');
  }
  // The second gym's athlete with GONE's id: resolved items that must survive GONE's deletion.
  // (Ids carry "other-gym": escalation and violation ids are unique across gyms.)
  await escalation(OTHER_ORG, GONE, 'esc-resolved-other-gym', 'resolved');
  await hold(OTHER_ORG, GONE, 'hold-lifted-other-gym', 'lifted');
  await violation(OTHER_ORG, GONE, 'violation-resolved-other-gym', 'resolved');

  // Feedback is keyed by the writer's account, and freezes the gym and the
  // capacity it was written in.
  for (const [account, org, role, tag] of [
    [GONE_ACCOUNT, ORG, 'athlete', GONE],
    [LIVE_ACCOUNT, ORG, 'athlete', LIVE],
    [PURGED_GUARDIAN, ORG, 'parent', 'GUARDIAN'],
    [OTHER_GONE_ACCOUNT, OTHER_ORG, 'athlete', 'OTHER-GYM'],
    [AGED_ACCOUNT, ORG, 'athlete', 'AGED-AS-ATHLETE'],
    [SHARED_ACCOUNT, ORG, 'athlete', 'SHARED'],
    [MOVED_GUARDIAN, ORG, 'parent', 'MOVED-GUARDIAN'],
    [PURGED_ATHLETE_ACCOUNT, ORG, 'athlete', 'PURGED-ATHLETE'],
    [COACH_TURNED_ATHLETE, ORG, 'coach', 'COACH-TURNED-ATHLETE'],
    [TURNED_ACCOUNT, ORG, 'athlete', 'ATHLETE-TURNED-PARENT'],
    [REUSED_ACCOUNT, ORG, 'athlete', 'REUSED-OLD'],
    [FREED_ACCOUNT, ORG, 'athlete', 'FREED-OLD'],
    [ORPHANED_ACCOUNT, ORG, 'athlete', 'ORPHANED-OLD'],
  ] as const) {
    await feedbackSet(client, org, account, role, tag);
  }
}

/** Five submissions, one per triage status, bodies `<tag>:feedback-<status>`; triage set the way setFeedbackTriage sets it. */
async function feedbackSet(client: Client, org: string, account: string, role: string, tag: string): Promise<void> {
  for (const status of ['new', 'triaged', 'planned', 'done', 'declined']) {
    await client.query(
      `insert into pilot.feedback_submissions (organization_id, submitted_by_account_id, submitted_by_role, kind, body, route)
       values ($1, $2, $3, 'other', $4, $5)`,
      [org, account, role, `${tag}:feedback-${status}`, role === 'athlete' ? 'safeguarding' : 'product'],
    );
    if (status !== 'new') {
      await client.query(
        `update pilot.feedback_submissions
            set triage_status = $2, triaged_by_account_id = $3, triaged_at = now(), updated_at = now()
          where body = $1`,
        [`${tag}:feedback-${status}`, status, ADMIN],
      );
    }
  }
}

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockMicrosoftPrincipal = requireMicrosoftAuthenticatedPrincipal as jest.Mock;

function request(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

async function json<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

/* The screens, each reduced to the item ids it shows. */

async function escalationsScreen(actor = principal(ADMIN, 'organization_admin')): Promise<string[]> {
  mockRequirePrincipal.mockResolvedValue(actor);
  const body = await json<{ escalations: Array<{ escalation_id: string }> }>(
    await escalationsGET(request('/api/pilot/escalations')),
  );
  return body.escalations.map((row) => row.escalation_id);
}

async function trainingHoldsScreen(actor = principal(ADMIN, 'organization_admin')): Promise<string[]> {
  mockRequirePrincipal.mockResolvedValue(actor);
  const body = await json<{ holds: Array<{ hold_id: string }> }>(
    await trainingHoldsGET(request('/api/pilot/training-holds')),
  );
  return body.holds.map((row) => row.hold_id);
}

async function violationsScreen(actor = principal(ADMIN, 'organization_admin')): Promise<string[]> {
  mockRequirePrincipal.mockResolvedValue(actor);
  const body = await json<{ items: Array<{ violation_id: string }> }>(
    await violationsGET(request('/api/pilot/compliance/violations?limit=100')),
  );
  return body.items.map((row) => row.violation_id);
}

async function feedbackScreen(actor = principal(ADMIN, 'organization_admin')): Promise<string[]> {
  mockMicrosoftPrincipal.mockResolvedValue(actor);
  const response = await feedbackListPOST(
    new NextRequest('http://localhost/api/pilot/feedback/list', {
      method: 'POST',
      body: JSON.stringify({ limit: 200 }),
      headers: { 'content-type': 'application/json' },
    }),
  );
  const body = await json<{ items: Array<{ body: string }> }>(response);
  return body.items.map((row) => row.body);
}

/** The feedback queue as body -> the submitter name the admin is shown. */
async function feedbackNames(): Promise<Map<string, string | null>> {
  mockMicrosoftPrincipal.mockResolvedValue(principal(ADMIN, 'organization_admin'));
  const response = await feedbackListPOST(
    new NextRequest('http://localhost/api/pilot/feedback/list', {
      method: 'POST',
      body: JSON.stringify({ limit: 200 }),
      headers: { 'content-type': 'application/json' },
    }),
  );
  const body = await json<{ items: Array<{ body: string; submitter_name: string | null }> }>(response);
  return new Map(body.items.map((row) => [row.body, row.submitter_name]));
}

async function safetyFlagsScreen(): Promise<string[]> {
  mockRequirePrincipal.mockResolvedValue(principal(ADMIN, 'organization_admin'));
  const body = await json<{ flags: Array<{ trigger_detail: string }> }>(
    await safetyFlagsGET(request('/api/pilot/safety-flags')),
  );
  return body.flags.map((row) => row.trigger_detail);
}

interface SafetyReviewBody {
  openHolds: Array<{ hold_id: string }>;
  failingGates: Array<{ athlete_id: string; gate_key: string }>;
  openEscalations: Array<{ escalation_id: string }>;
  openViolations: Array<{ violation_id: string }>;
}

async function safetyReviewScreen(): Promise<string[]> {
  mockRequirePrincipal.mockResolvedValue(principal(ADMIN, 'organization_admin'));
  const body = await json<SafetyReviewBody>(await safetyReviewGET(request('/api/pilot/admin/safety-review')));
  return [
    ...body.openHolds.map((row) => row.hold_id),
    ...body.failingGates.map((row) => `${row.athlete_id}:${row.gate_key}`),
    ...body.openEscalations.map((row) => row.escalation_id),
    ...body.openViolations.map((row) => row.violation_id),
  ];
}

async function boardOpenCritical(): Promise<{ status: string; count: number | null }> {
  mockRequirePrincipal.mockResolvedValue(principal(BOARD, 'board'));
  const body = await json<{ summary: { openBySeverity: { critical: { status: string; count: number | null } } } }>(
    await boardEscalationSummaryGET(request('/api/pilot/board/escalation-summary')),
  );
  return body.summary.openBySeverity.critical;
}

const ids = (athlete: string, what: readonly string[]) => what.map((item) => `${athlete}:${item}`);

const ESCALATIONS_UNRESOLVED = ['esc-open', 'esc-acknowledged'];
const ESCALATIONS_RESOLVED = ['esc-resolved'];
const HOLDS_UNRESOLVED = ['hold-active'];
const HOLDS_RESOLVED = ['hold-lifted', 'hold-expired'];
const VIOLATIONS_UNRESOLVED = ['violation-new', 'violation-acknowledged', 'violation-escalated'];
const VIOLATIONS_RESOLVED = ['violation-resolved', 'violation-dismissed'];
const FEEDBACK_UNRESOLVED = ['feedback-new', 'feedback-triaged', 'feedback-planned'];
const FEEDBACK_RESOLVED = ['feedback-done', 'feedback-declined'];

/* The four screens that changed: before the deletion everything shows, after
   it the deleted athlete's resolved items do not. */
const CHANGED_SCREENS = [
  { name: 'safety escalations', read: () => escalationsScreen(), unresolved: ESCALATIONS_UNRESOLVED, resolved: ESCALATIONS_RESOLVED },
  { name: 'training holds', read: () => trainingHoldsScreen(), unresolved: HOLDS_UNRESOLVED, resolved: HOLDS_RESOLVED },
  { name: 'compliance violations', read: () => violationsScreen(), unresolved: VIOLATIONS_UNRESOLVED, resolved: VIOLATIONS_RESOLVED },
  { name: 'feedback queue', read: () => feedbackScreen(), unresolved: FEEDBACK_UNRESOLVED, resolved: FEEDBACK_RESOLVED },
];

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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = helper.applyFullSchema as typeof applyFullSchema;

  await adminQuery(`create database ${DATABASE}`);
  activeClient = new Client({ connectionString: connectionStringFor(DATABASE) });
  await activeClient.connect();
  await applyFullSchema(activeClient, { infraDir: INFRA_DIR });
  await seed(activeClient);

  // Safety flags through their own write path: one left open, one resolved.
  for (const athlete of [GONE, LIVE]) {
    for (const what of ['flag-open', 'flag-acknowledged']) {
      const flag = await raiseSafetyFlag({
        organizationId: ORG,
        athleteId: athlete,
        flagClass: 'system_guidance',
        flagCode: 'l2_seeded',
        severity: 'attention',
        triggeredBy: 'human_entry',
        triggerDetail: `${athlete}:${what}`,
      });
      if (what === 'flag-acknowledged') {
        await resolveSafetyFlag({
          organizationId: ORG,
          flagId: flag.flag_id,
          status: 'acknowledged',
          resolution: 'acted_on',
          coachNote: 'Seen and handled in person.',
          resolvedByAccountId: ADMIN,
          resolvedByRole: 'organization_admin',
        });
      }
    }
  }
});

afterAll(async () => {
  await activeClient?.end();
  activeClient = null;
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
  // On Windows postgres can still hold the directory for a moment after the
  // kill; retrying on EBUSY/EPERM keeps a passing run from failing its
  // teardown (drillLifecycle.pg.test.ts does the same).
  await fs.rm(DATA_DIR, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
});

describe('before the deletion (the positive control)', () => {
  test("the safety review page lists both athletes' failing gate, and neither's cleared one", async () => {
    const shown = await safetyReviewScreen();
    expect(shown).toEqual(expect.arrayContaining([`${GONE}:${GATE_FAILING}`, `${LIVE}:${GATE_FAILING}`]));
    expect(shown).not.toContain(`${GONE}:${GATE_CLEARED}`);
    expect(shown).not.toContain(`${LIVE}:${GATE_CLEARED}`);
  });

  test.each(CHANGED_SCREENS.map((screen) => [screen.name, screen] as const))(
    '%s shows every item of both athletes, resolved or not',
    async (_name, screen) => {
      const shown = await screen.read();
      for (const athlete of [GONE, LIVE]) {
        expect(shown).toEqual(expect.arrayContaining(ids(athlete, [...screen.unresolved, ...screen.resolved])));
      }
    },
  );

  test('safety flags list open flags only, for everyone', async () => {
    const shown = await safetyFlagsScreen();
    expect(shown).toEqual(expect.arrayContaining([`${GONE}:flag-open`, `${LIVE}:flag-open`]));
    expect(shown).not.toContain(`${GONE}:flag-acknowledged`);
    expect(shown).not.toContain(`${LIVE}:flag-acknowledged`);
  });

  test('the board counts six athletes with an open critical escalation (GONE, LIVE, four fillers)', async () => {
    expect(await boardOpenCritical()).toMatchObject({ status: 'available', count: 6 });
  });
});

describe('after deleteAthleteRecord(GONE)', () => {
  beforeAll(async () => {
    await deleteAthleteRecord({ accountId: ADMIN, role: 'organization_admin', organizationId: ORG }, GONE, 'Family moved away');
    const marked = await activeClient!.query<{ deleted_at: string | null }>(
      `select deleted_at::text as deleted_at from pilot.athletes where organization_id = $1 and athlete_id = $2`,
      [ORG, GONE],
    );
    expect(marked.rows[0].deleted_at).not.toBeNull();
  });

  test.each(CHANGED_SCREENS.map((screen) => [screen.name, screen] as const))(
    "%s hides GONE's resolved items and still shows GONE's unresolved ones",
    async (_name, screen) => {
      const shown = await screen.read();
      expect(shown).toEqual(expect.arrayContaining(ids(GONE, screen.unresolved)));
      for (const item of ids(GONE, screen.resolved)) {
        expect(shown).not.toContain(item);
      }
      // The control: the live athlete's resolved items are untouched.
      expect(shown).toEqual(expect.arrayContaining(ids(LIVE, [...screen.unresolved, ...screen.resolved])));
    },
  );

  test("an athlete account left open still has its closed feedback hidden: the athlete's own mark decides", async () => {
    await activeClient!.query(`update pilot.accounts set deleted_at = null where account_id = $1`, [GONE_ACCOUNT]);
    try {
      const shown = await feedbackScreen();
      expect(shown).toEqual(expect.arrayContaining(ids(GONE, FEEDBACK_UNRESOLVED)));
      for (const item of ids(GONE, FEEDBACK_RESOLVED)) {
        expect(shown).not.toContain(item);
      }
    } finally {
      await activeClient!.query(`update pilot.accounts set deleted_at = now() where account_id = $1`, [GONE_ACCOUNT]);
    }
  });

  test("a LIVE athlete whose login alone was deleted keeps every feedback row, closed ones included", async () => {
    // The state intake names ATHLETE_RECORD_HELD_BY_DELETED_LOGIN: the child is still in the gym.
    await activeClient!.query(
      `update pilot.accounts set deleted_at = now(), active_flag = false where account_id = $1`,
      [LIVE_ACCOUNT],
    );
    try {
      expect(await feedbackScreen()).toEqual(
        expect.arrayContaining(ids(LIVE, [...FEEDBACK_UNRESOLVED, ...FEEDBACK_RESOLVED])),
      );
    } finally {
      await activeClient!.query(
        `update pilot.accounts set deleted_at = null, active_flag = true where account_id = $1`,
        [LIVE_ACCOUNT],
      );
    }
  });

  test("a purged guardian's closed feedback stays hidden when the purge empties its account reference", async () => {
    // Before anything happens to the guardian, all five rows show.
    expect(await feedbackScreen()).toEqual(
      expect.arrayContaining(ids('GUARDIAN', [...FEEDBACK_UNRESOLVED, ...FEEDBACK_RESOLVED])),
    );
    // What both retention paths do to a parent account deleted over a year ago.
    await activeClient!.query(
      `update pilot.accounts set deleted_at = now() - interval '2 years', active_flag = false where account_id = $1`,
      [PURGED_GUARDIAN],
    );
    // Deleted, not yet purged: a guardian's own mark is their account's.
    const deletedNotPurged = await feedbackScreen();
    expect(deletedNotPurged).toEqual(expect.arrayContaining(ids('GUARDIAN', FEEDBACK_UNRESOLVED)));
    for (const item of ids('GUARDIAN', FEEDBACK_RESOLVED)) {
      expect(deletedNotPurged).not.toContain(item);
    }
    await activeClient!.query(`delete from pilot.accounts where account_id = $1`, [PURGED_GUARDIAN]);
    const cleared = await activeClient!.query(
      `select count(*)::int as n from pilot.feedback_submissions where body like 'GUARDIAN:%' and submitted_by_account_id is null`,
    );
    expect(cleared.rows[0].n).toBe(5);

    const shown = await feedbackScreen();
    expect(shown).toEqual(expect.arrayContaining(ids('GUARDIAN', FEEDBACK_UNRESOLVED)));
    for (const item of ids('GUARDIAN', FEEDBACK_RESOLVED)) {
      expect(shown).not.toContain(item);
    }
  });

  /* DRIFTED ACCOUNTS: the submission's frozen gym and role decide, and where
     the account no longer proves who wrote the row, the row stays. */
  const FEEDBACK_ALL = [...FEEDBACK_UNRESOLVED, ...FEEDBACK_RESOLVED];
  const run = (sql: string, params: unknown[] = []) => activeClient!.query(sql, params);
  const newChild = async (athleteId: string, fullName: string) => {
    const now = new Date().toISOString();
    const created = await insertAthleteIfAbsent(ORG, {
      athlete_id: athleteId,
      full_name: fullName,
      dob: '2013-02-03',
      weight_class: 'fly',
      gym_status: 'active',
      emergency_contact: 'contact',
      active_flag: true,
      coach_id: COACH,
      created_at: now,
      updated_at: now,
    });
    expect(created).toBe(true);
  };

  test('a login re-roled away from athlete, athlete_id still set: nothing it wrote is judged by the athlete record', async () => {
    // The athlete ages into a coach on the same login, writes again as a coach,
    // and the old athlete record is then deleted. The person is still here.
    await run(`update pilot.accounts set role = 'coach' where account_id = $1`, [AGED_ACCOUNT]);
    await feedbackSet(activeClient!, ORG, AGED_ACCOUNT, 'coach', 'AGED-AS-COACH');
    await run(`update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`, [ORG, AGED]);
    const kept = (await run(`select athlete_id from pilot.accounts where account_id = $1`, [AGED_ACCOUNT])).rows[0];
    expect(kept.athlete_id).toBe(AGED);

    let shown = await feedbackScreen();
    expect(shown).toEqual(expect.arrayContaining(ids('AGED-AS-ATHLETE', FEEDBACK_ALL)));
    expect(shown).toEqual(expect.arrayContaining(ids('AGED-AS-COACH', FEEDBACK_ALL)));

    // The coach's login is then deleted: what they wrote as a coach closes out
    // of the queue; what the child wrote stays, because this login no longer
    // proves an athlete wrote it.
    await run(`update pilot.accounts set deleted_at = now(), active_flag = false where account_id = $1`, [AGED_ACCOUNT]);
    shown = await feedbackScreen();
    expect(shown).toEqual(expect.arrayContaining(ids('AGED-AS-ATHLETE', FEEDBACK_ALL)));
    expect(shown).toEqual(expect.arrayContaining(ids('AGED-AS-COACH', FEEDBACK_UNRESOLVED)));
    for (const item of ids('AGED-AS-COACH', FEEDBACK_RESOLVED)) {
      expect(shown).not.toContain(item);
    }
  });

  test("one athlete_id in both gyms: the other gym's deletion, and the login moving there, hide nothing here", async () => {
    await run(`update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`, [OTHER_ORG, SHARED]);
    expect(await feedbackScreen()).toEqual(expect.arrayContaining(ids('SHARED', FEEDBACK_ALL)));

    // upsertOrganizationMembership's rewrite: the gym changes, athlete_id does
    // not, so the login now names the OTHER gym's deleted athlete.
    await run(`update pilot.accounts set organization_id = $2 where account_id = $1`, [SHARED_ACCOUNT, OTHER_ORG]);
    expect(await feedbackScreen()).toEqual(expect.arrayContaining(ids('SHARED', FEEDBACK_ALL)));

    // This gym's SHARED is then deleted too. The login is no longer this gym's,
    // so it no longer proves which athlete wrote these rows: they stay.
    await run(`update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`, [ORG, SHARED]);
    expect(await feedbackScreen()).toEqual(expect.arrayContaining(ids('SHARED', FEEDBACK_ALL)));
  });

  test("a coach's login later re-roled to athlete and deleted hides nothing the coach wrote", async () => {
    // A deleted athlete login is not a deleted person (a live athlete's login
    // can be deleted on its own), so it no longer proves the coach is gone.
    await run(
      `update pilot.accounts set role = 'athlete', deleted_at = now(), active_flag = false where account_id = $1`,
      [COACH_TURNED_ATHLETE],
    );
    expect(await feedbackScreen()).toEqual(expect.arrayContaining(ids('COACH-TURNED-ATHLETE', FEEDBACK_ALL)));
  });

  test("an athlete's submission whose account reference cleared stays: only a non-athlete's cleared reference proves a deletion", async () => {
    // The purge deletes by the login's CURRENT role, so an athlete's login
    // re-roled to parent, deleted and purged clears the reference on rows a
    // child wrote, while the athlete record is still live.
    await run(
      `update pilot.accounts set role = 'parent', deleted_at = now() - interval '2 years', active_flag = false where account_id = $1`,
      [TURNED_ACCOUNT],
    );
    await run(`delete from pilot.accounts where account_id = $1`, [TURNED_ACCOUNT]);
    const cleared = await run(
      `select count(*)::int as n from pilot.feedback_submissions
        where body like 'ATHLETE-TURNED-PARENT:%' and submitted_by_account_id is null and submitted_by_role = 'athlete'`,
    );
    expect(cleared.rows[0].n).toBe(5);
    expect(await feedbackScreen()).toEqual(expect.arrayContaining(ids('ATHLETE-TURNED-PARENT', FEEDBACK_ALL)));
  });

  test('a guardian login moved to another gym and deleted there hides nothing in the gym it wrote in', async () => {
    await run(
      `update pilot.accounts set organization_id = $2, deleted_at = now(), active_flag = false where account_id = $1`,
      [MOVED_GUARDIAN, OTHER_ORG],
    );
    expect(await feedbackScreen()).toEqual(expect.arrayContaining(ids('MOVED-GUARDIAN', FEEDBACK_ALL)));
  });

  test("a deleted athlete's closed feedback stays hidden after the retention purge removes the athlete row", async () => {
    const expectClosedHidden = async () => {
      const shown = await feedbackScreen();
      expect(shown).toEqual(expect.arrayContaining(ids('PURGED-ATHLETE', FEEDBACK_UNRESOLVED)));
      for (const item of ids('PURGED-ATHLETE', FEEDBACK_RESOLVED)) {
        expect(shown).not.toContain(item);
      }
    };
    expect(await feedbackScreen()).toEqual(expect.arrayContaining(ids('PURGED-ATHLETE', FEEDBACK_ALL)));
    await deleteAthleteRecord({ accountId: ADMIN, role: 'organization_admin', organizationId: ORG }, PURGED_ATHLETE, 'Left the gym');
    await expectClosedHidden();
    // The purge: the athlete row goes, the login stays, deleted, naming nothing
    // in THIS gym (the second gym's live athlete with the same id is not it).
    await run(`delete from pilot.athletes where organization_id = $1 and athlete_id = $2`, [ORG, PURGED_ATHLETE]);
    const login = (await run(`select athlete_id, deleted_at from pilot.accounts where account_id = $1`, [PURGED_ATHLETE_ACCOUNT])).rows[0];
    expect(login.athlete_id).toBe(PURGED_ATHLETE);
    expect(login.deleted_at).not.toBeNull();
    await expectClosedHidden();
  });

  test("a purged athlete's id given to a new child: the old rows stay closed-hidden and are never put under the new child's name", async () => {
    // Before: the athlete's rows show, under the athlete's own name (the seed
    // names each athlete after its id).
    let names = await feedbackNames();
    for (const item of ids('REUSED-OLD', FEEDBACK_ALL)) {
      expect(names.get(item)).toBe(REUSED);
    }

    // Deleted, then purged the way the cleanup job does it: the athlete row
    // goes, the deleted login stays and still carries the athlete_id.
    await deleteAthleteRecord({ accountId: ADMIN, role: 'organization_admin', organizationId: ORG }, REUSED, 'Left the gym');
    await run(`delete from pilot.athletes where organization_id = $1 and athlete_id = $2`, [ORG, REUSED]);
    const oldLogin = (await run(`select athlete_id, deleted_at from pilot.accounts where account_id = $1`, [REUSED_ACCOUNT])).rows[0];
    expect(oldLogin.athlete_id).toBe(REUSED);
    expect(oldLogin.deleted_at).not.toBeNull();

    // The roster's own create path gives the id to a different child.
    await newChild(REUSED, 'New Child');

    names = await feedbackNames();
    // The purged child's unresolved rows are still on the queue, with no athlete name...
    for (const item of ids('REUSED-OLD', FEEDBACK_UNRESOLVED)) {
      expect(names.has(item)).toBe(true);
      expect(names.get(item)).toBeNull();
    }
    // ...and their closed rows stay hidden: the live row with that id is not them.
    for (const item of ids('REUSED-OLD', FEEDBACK_RESOLVED)) {
      expect(names.has(item)).toBe(false);
    }
    expect(Array.from(names.values())).not.toContain('New Child');

    // The control: naming still works for an athlete who is who their login says.
    for (const item of ids(LIVE, FEEDBACK_ALL)) {
      expect(names.get(item)).toBe(LIVE);
    }

    // Deleting the NEW child re-stamps the old login's deleted_at (the deletion
    // addresses the login by athlete_id), so "created before the login was
    // deleted" would now be true of the new child. Nothing changes here,
    // because the test of identity is the submission's own date.
    const stampBefore = (await run(`select deleted_at::text as at from pilot.accounts where account_id = $1`, [REUSED_ACCOUNT])).rows[0].at;
    await deleteAthleteRecord({ accountId: ADMIN, role: 'organization_admin', organizationId: ORG }, REUSED, 'New child left too');
    const stampAfter = (await run(`select deleted_at::text as at from pilot.accounts where account_id = $1`, [REUSED_ACCOUNT])).rows[0].at;
    expect(stampAfter).not.toBe(stampBefore);
    names = await feedbackNames();
    for (const item of ids('REUSED-OLD', FEEDBACK_UNRESOLVED)) {
      expect(names.has(item)).toBe(true);
      expect(names.get(item)).toBeNull();
    }
    for (const item of ids('REUSED-OLD', FEEDBACK_RESOLVED)) {
      expect(names.has(item)).toBe(false);
    }

    // The new child has no feedback of their own to test here: one login per
    // athlete_id per gym, and the purged child's deleted login still holds it
    // (the next test frees it).
    await expect(
      run(
        `insert into pilot.accounts (account_id, role, organization_id, athlete_id, auth_provider, active_flag, login_email)
         values ('acct-l2-new-child', 'athlete', $1, $2, 'ppbf_local', true, null)`,
        [ORG, REUSED],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  test("once the old login is purged too, the new child gets a login: their own feedback is theirs, the old child's is nobody's", async () => {
    await deleteAthleteRecord({ accountId: ADMIN, role: 'organization_admin', organizationId: ORG }, FREED, 'Left the gym');
    await run(`delete from pilot.athletes where organization_id = $1 and athlete_id = $2`, [ORG, FREED]);
    // The purge removes logins by their CURRENT role: re-roled to parent, the
    // old athlete login goes, and the one-login-per-athlete slot is free.
    await run(
      `update pilot.accounts set role = 'parent', deleted_at = now() - interval '2 years' where account_id = $1`,
      [FREED_ACCOUNT],
    );
    await run(`delete from pilot.accounts where account_id = $1`, [FREED_ACCOUNT]);

    await newChild(FREED, 'Freed New Child');
    await run(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, auth_provider, active_flag, login_email)
       values ($1, 'athlete', $2, $3, 'ppbf_local', true, null)`,
      [FREED_NEW_ACCOUNT, ORG, FREED],
    );
    await feedbackSet(activeClient!, ORG, FREED_NEW_ACCOUNT, 'athlete', 'FREED-NEW');

    const names = await feedbackNames();
    // The new child's own feedback behaves like any live athlete's: all five, named.
    for (const item of ids('FREED-NEW', FEEDBACK_ALL)) {
      expect(names.get(item)).toBe('Freed New Child');
    }
    // The old child's rows have a cleared reference on an athlete-written row:
    // nothing proves who wrote them, so they all stay, and carry no name.
    for (const item of ids('FREED-OLD', FEEDBACK_ALL)) {
      expect(names.has(item)).toBe(true);
      expect(names.get(item)).toBeNull();
    }
  });

  test("a new child under an old LIVE login's id is not the writer, even once the new child is deleted", async () => {
    // The athlete row went without the login being deleted (a guardian's
    // deletion withdraws the athlete row only); the id is then given to a new
    // child, and the new child is later deleted.
    await run(`delete from pilot.athletes where organization_id = $1 and athlete_id = $2`, [ORG, ORPHANED]);
    await newChild(ORPHANED, 'Orphaned New Child');
    await run(`update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`, [ORG, ORPHANED]);

    const names = await feedbackNames();
    // The deleted row is the NEW child's, not the writer's: it proves nothing
    // about the writer, so every old row stays, unnamed.
    for (const item of ids('ORPHANED-OLD', FEEDBACK_ALL)) {
      expect(names.has(item)).toBe(true);
      expect(names.get(item)).toBeNull();
    }
  });

  test('an athlete whose record was created after their login is still the writer of what they write afterwards', async () => {
    // Intake can provision a login before the athlete row exists. What matters
    // is the row existing when the SUBMISSION is written, not when the login was.
    await run(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Late Row Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [ORG, LATE_ROW, COACH],
    );
    const order = (await run(
      `select (ath.created_at > acct.created_at) as row_after_login
         from pilot.athletes ath, pilot.accounts acct
        where ath.organization_id = $1 and ath.athlete_id = $2 and acct.account_id = $3`,
      [ORG, LATE_ROW, LATE_ROW_ACCOUNT],
    )).rows[0];
    expect(order.row_after_login).toBe(true);
    await feedbackSet(activeClient!, ORG, LATE_ROW_ACCOUNT, 'athlete', 'LATE-ROW');

    let names = await feedbackNames();
    for (const item of ids('LATE-ROW', FEEDBACK_ALL)) {
      expect(names.get(item)).toBe('Late Row Athlete');
    }
    // And the rule still bites for them: deleted, their closed rows leave.
    await deleteAthleteRecord({ accountId: ADMIN, role: 'organization_admin', organizationId: ORG }, LATE_ROW, 'Left the gym');
    names = await feedbackNames();
    for (const item of ids('LATE-ROW', FEEDBACK_UNRESOLVED)) {
      expect(names.get(item)).toBe('Late Row Athlete');
    }
    for (const item of ids('LATE-ROW', FEEDBACK_RESOLVED)) {
      expect(names.has(item)).toBe(false);
    }
  });

  test("the second gym's athlete with GONE's id keeps its resolved items", async () => {
    const other = principal(OTHER_ADMIN, 'organization_admin', OTHER_ORG);
    expect(await escalationsScreen(other)).toEqual([`${GONE}:esc-resolved-other-gym`]);
    expect(await trainingHoldsScreen(other)).toEqual([`${GONE}:hold-lifted-other-gym`]);
    expect(await violationsScreen(other)).toEqual([`${GONE}:violation-resolved-other-gym`]);
    // Feedback is keyed by account; the other gym's account for its own GONE is live.
    expect((await feedbackScreen(other)).sort()).toEqual(
      ids('OTHER-GYM', [...FEEDBACK_UNRESOLVED, ...FEEDBACK_RESOLVED]).sort(),
    );
  });

  test("a status filter asking for resolved items does not bring GONE's back", async () => {
    mockRequirePrincipal.mockResolvedValue(principal(ADMIN, 'organization_admin'));
    const escalations = await json<{ escalations: Array<{ escalation_id: string }> }>(
      await escalationsGET(request('/api/pilot/escalations?status=resolved')),
    );
    expect(escalations.escalations.map((row) => row.escalation_id)).toEqual([`${LIVE}:esc-resolved`]);
    const holds = await json<{ holds: Array<{ hold_id: string }> }>(
      await trainingHoldsGET(request('/api/pilot/training-holds?status=lifted')),
    );
    expect(holds.holds.map((row) => row.hold_id)).toEqual([`${LIVE}:hold-lifted`]);
  });

  /* PINNED: these three already behaved this way before this change. */

  test("safety flags still show GONE's open flag, and never the resolved one", async () => {
    const shown = await safetyFlagsScreen();
    expect(shown).toEqual(expect.arrayContaining([`${GONE}:flag-open`, `${LIVE}:flag-open`]));
    expect(shown).not.toContain(`${GONE}:flag-acknowledged`);
  });

  test("the safety review page drops GONE's failing gate at once and keeps LIVE's", async () => {
    const shown = await safetyReviewScreen();
    expect(shown).not.toContain(`${GONE}:${GATE_FAILING}`);
    expect(shown).toContain(`${LIVE}:${GATE_FAILING}`);
  });

  test("the safety review page still shows GONE's unresolved items, and none resolved", async () => {
    const shown = await safetyReviewScreen();
    expect(shown).toEqual(
      expect.arrayContaining([
        `${GONE}:hold-active`,
        ...ids(GONE, ESCALATIONS_UNRESOLVED),
        ...ids(GONE, VIOLATIONS_UNRESOLVED),
      ]),
    );
    // LIVE too: the page's own open-only filters, not just this change's, keep resolved items off it.
    for (const athlete of [GONE, LIVE]) {
      for (const item of [
        `${athlete}:${GATE_CLEARED}`,
        ...ids(athlete, HOLDS_RESOLVED),
        ...ids(athlete, ESCALATIONS_RESOLVED),
        ...ids(athlete, VIOLATIONS_RESOLVED),
      ]) {
        expect(shown).not.toContain(item);
      }
    }
    expect(shown).toEqual(expect.arrayContaining([`${LIVE}:hold-active`, `${LIVE}:${GATE_FAILING}`]));
  });

  test("the board still counts GONE's open critical escalation", async () => {
    expect(await boardOpenCritical()).toMatchObject({ status: 'available', count: 6 });
  });
});
