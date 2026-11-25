// Real PostgreSQL-backed test for the email alert's staff event sources (lane
// W4-1, EM-4a; plan on #2159, section 6). Each source must name exactly the
// people the app shows the event to. The test asks the pages' own reads, as
// each signed-in person would make them, and compares, person by person:
//   - safety_escalation: app/api/pilot/escalations/route.ts -- listEscalations
//     with athleteIdsForCoach and excludeAthleteVoice for a coach, unscoped
//     for an admin or organization admin, nothing for any other role;
//   - parent_reply: app/api/pilot/coach/family-message-replies/route.ts --
//     requireRole(coach, organization_admin, admin), assertActorCanAccessAthlete,
//     then listRepliesForStaff.
// Someone whose membership is off cannot sign in, so reads nothing.
//
// It NEVER connects to production or staging: an embedded server on a free
// local port, in a throwaway data directory.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
  withTransaction: jest.fn(async () => {
    throw new Error('test bug: nothing here opens a transaction');
  }),
  // The embedded server is on loopback, but production's is not; the sender's
  // PIN rule is applied as production applies it.
  isLoopbackPostgresConnectionString: () => false,
}));

import { assertActorCanAccessAthlete, athleteIdsForCoach, requireRole } from './access';
import type { PilotRole } from './contracts';
import type { EmailAlertCandidate } from './emailAlertQueue';
import { EMAIL_ALERT_EVENT_SOURCES, parentReplySource, safetyEscalationSource } from './emailAlertEvents';
import { runEmailAlertSweep, type EmailAlertSenderDependencies } from './emailAlertSender';
import { listEscalations } from './escalationLadder';
import { listRepliesForStaff } from './familyMessageReplies';
import type { OutboundMessage } from './graphMailer';
import { EMAIL_ALERT_EVENTS } from '@/src/shared/emailAlerts';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-email-alert-events-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-emailevents';
const OTHER_ORG = 'org-emailevents-other';

// account id, gym, membership role, membership on
const PEOPLE: Array<[string, string, string, boolean]> = [
  ['acct-ev-admin', ORG, 'admin', true],
  ['acct-ev-orgadmin', ORG, 'organization_admin', true],
  ['acct-ev-admin-off', ORG, 'admin', false],
  ['acct-ev-coach-own', ORG, 'coach', true], // coach of record of ATH_A and ATH_GONE
  ['acct-ev-coach-cover', ORG, 'coach', true], // covering ATH_B now; covering ATH_GONE_COVERED
  ['acct-ev-coach-expired', ORG, 'coach', true], // coverage of ATH_A ended
  ['acct-ev-coach-future', ORG, 'coach', true], // coverage of ATH_A not started
  ['acct-ev-coach-none', ORG, 'coach', true], // no athlete
  ['acct-ev-coach-off', ORG, 'coach', false], // coach of record of ATH_B, membership off
  ['acct-ev-volunteer', ORG, 'volunteer', true],
  ['acct-ev-staff', ORG, 'staff', true],
  ['acct-ev-parent', ORG, 'parent', true],
  ['acct-ev-athlete', ORG, 'athlete', true],
  ['acct-ev-other-admin', OTHER_ORG, 'admin', true],
  ['acct-ev-other-coach', OTHER_ORG, 'coach', true], // coach of record of ATH_OTHER
];

const ATH_A = 'ath-ev-a';
const ATH_B = 'ath-ev-b';
const ATH_GONE = 'ath-ev-gone';
const ATH_GONE_COVERED = 'ath-ev-gone-covered';
const ATH_OTHER = 'ath-ev-other';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;

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

/** The full schema, two gyms, the people above and their athletes. */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  for (const org of [ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [org],
    );
  }
  for (const [accountId, org, role, on] of PEOPLE) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, login_email)
       values ($1, $2, $3, 'magic_link', null, null)`,
      [accountId, role, org],
    );
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ($1, $2, $3, $4)`,
      [accountId, org, role, on],
    );
  }
  const athletes: Array<[string, string, string, boolean]> = [
    [ATH_A, ORG, 'acct-ev-coach-own', false],
    [ATH_B, ORG, 'acct-ev-coach-off', false],
    [ATH_GONE, ORG, 'acct-ev-coach-own', true],
    [ATH_GONE_COVERED, ORG, 'acct-ev-coach-none', true],
    [ATH_OTHER, OTHER_ORG, 'acct-ev-other-coach', false],
  ];
  for (const [athleteId, org, coachId, deleted] of athletes) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
       values ($1, $2, 'Event Athlete', '2000-03-14', '100', 'active', 'contact', true, $3, now(), now(),
               case when $4 then now() else null end)`,
      [org, athleteId, coachId, deleted],
    );
  }
  const coverage: Array<[string, string, string, string]> = [
    [ATH_B, 'acct-ev-coach-cover', '1 hour', '1 hour'],
    [ATH_GONE_COVERED, 'acct-ev-coach-cover', '1 hour', '1 hour'],
    [ATH_A, 'acct-ev-coach-expired', '3 hours', '-1 hour'],
    [ATH_A, 'acct-ev-coach-future', '-1 hour', '3 hours'],
  ];
  for (const [athleteId, coachId, startedAgo, endsIn] of coverage) {
    await client.query(
      `insert into pilot.coach_coverage
         (organization_id, athlete_id, covering_coach_id, granted_by_account_id, starts_at, expires_at)
       values ($1, $2, $3, 'acct-ev-admin', now() - $4::interval, now() + $5::interval)`,
      [ORG, athleteId, coachId, startedAgo, endsIn],
    );
  }
  return client;
}

async function escalation(
  client: Client,
  org: string,
  athleteId: string,
  sourceType: string,
  values: { minutesAgo?: number; status?: string; metadata?: Record<string, unknown> } = {},
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into pilot.safety_escalations
       (organization_id, escalation_id, source_type, athlete_id, severity, reason, escalated_to_role,
        triggered_by, status, metadata, created_at)
     values ($1, $2, $3, $4, 'high', 'reason', 'organization_admin', 'system', $5, $6::jsonb,
             now() - make_interval(mins => $7))`,
    [org, id, sourceType, athleteId, values.status ?? 'open', JSON.stringify(values.metadata ?? {}), values.minutesAgo ?? 5],
  );
  return id;
}

async function parentMessage(client: Client, org: string, athleteId: string, coachId: string): Promise<string> {
  const noteId = randomUUID();
  await client.query(
    `insert into pilot.coach_observations (organization_id, note_id, athlete_id, coach_account_id, note_type, note_text)
     values ($1, $2::uuid, $3, $4, 'parent_message', 'Bring gloves Thursday.')`,
    [org, noteId, athleteId, coachId],
  );
  return noteId;
}

async function reply(client: Client, org: string, noteId: string, athleteId: string, minutesAgo = 5): Promise<string> {
  const replyId = randomUUID();
  await client.query(
    `insert into pilot.family_message_replies
       (organization_id, reply_id, note_id, athlete_id, author_account_id, author_role, reply_text, created_at)
     values ($1, $2::uuid, $3::uuid, $4, 'acct-ev-parent', 'parent', 'Got it.', now() - make_interval(mins => $5))`,
    [org, replyId, noteId, athleteId, minutesAgo],
  );
  return replyId;
}

/** The sweep's window: the last hour, on the database's clock. */
async function lastHour(client: Client): Promise<{ from: Date; to: Date }> {
  const { rows } = await client.query<{ from: Date; to: Date }>(
    `select now() - interval '1 hour' as "from", now() as "to"`,
  );
  return rows[0];
}

/** "gym|account" -> the event ids. */
type Reach = Map<string, string[]>;

function reachOf(candidates: readonly EmailAlertCandidate[], eventKind: string): Reach {
  const reach: Reach = new Map();
  for (const c of candidates) {
    expect(c.userType).toBe('staff');
    expect(c.eventKind).toBe(eventKind);
    const key = `${c.organizationId}|${c.accountId}`;
    reach.set(key, [...(reach.get(key) ?? []), c.eventId].sort());
  }
  return reach;
}

function signedIn(accountId: string, org: string, role: string) {
  return { accountId, organizationId: org, role: role as PilotRole, athleteId: null };
}

/** What /admin/escalations shows each signed-in person (escalations/route.ts GET), in the window. */
async function escalationsPageReach(inWindow: ReadonlySet<string>): Promise<Reach> {
  const reach: Reach = new Map();
  for (const [accountId, org, role, on] of PEOPLE) {
    if (!on) continue;
    const isAdmin = role === 'admin' || role === 'organization_admin';
    if (!isAdmin && role !== 'coach') continue;
    const athleteIds = role === 'coach' ? await athleteIdsForCoach(org, accountId) : undefined;
    const rows = await listEscalations(org, { athleteIds, excludeAthleteVoice: role === 'coach' ? true : undefined });
    const ids = rows.map((row) => row.escalation_id).filter((id) => inWindow.has(id)).sort();
    if (ids.length) reach.set(`${org}|${accountId}`, ids);
  }
  return reach;
}

/** What the family-message-replies route gives each signed-in person, for every athlete, in the window. */
async function repliesPageReach(athleteIds: readonly string[], inWindow: ReadonlySet<string>): Promise<Reach> {
  const reach: Reach = new Map();
  for (const [accountId, org, role, on] of PEOPLE) {
    if (!on) continue;
    const actor = signedIn(accountId, org, role);
    try {
      requireRole(actor, ['coach', 'organization_admin', 'admin']);
    } catch {
      continue;
    }
    const ids: string[] = [];
    for (const athleteId of athleteIds) {
      try {
        await assertActorCanAccessAthlete(actor, athleteId);
      } catch {
        continue;
      }
      const rows = await listRepliesForStaff(org, athleteId);
      ids.push(...rows.map((row) => row.reply_id).filter((id) => inWindow.has(id)));
    }
    if (ids.length) reach.set(`${org}|${accountId}`, ids.sort());
  }
  return reach;
}

function sorted(reach: Reach): Array<[string, string[]]> {
  return [...reach.entries()].sort(([a], [b]) => a.localeCompare(b));
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
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
});

afterEach(async () => {
  if (activeClient) await activeClient.end();
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

describe('email alert staff event sources', () => {
  test('safety_escalation names exactly the people /admin/escalations shows each new row to', async () => {
    const client = await freshDatabase('emailevents_escalations');
    activeClient = client;

    const onA = await escalation(client, ORG, ATH_A, 'near_miss');
    const voiceOnA = await escalation(client, ORG, ATH_A, 'athlete_voice');
    const painNoteOnA = await escalation(client, ORG, ATH_A, 'athlete_voice', { metadata: { channel: 'pain_report_note' } });
    const onB = await escalation(client, ORG, ATH_B, 'pain_report');
    const shadowOnB = await escalation(client, ORG, ATH_B, 'shadow_disclosure', { status: 'acknowledged' });
    const openOnGone = await escalation(client, ORG, ATH_GONE, 'near_miss');
    const resolvedOnGone = await escalation(client, ORG, ATH_GONE, 'near_miss', { status: 'resolved' });
    const onGoneCovered = await escalation(client, ORG, ATH_GONE_COVERED, 'pain_report');
    const resolvedOnA = await escalation(client, ORG, ATH_A, 'near_miss', { status: 'resolved' });
    const old = await escalation(client, ORG, ATH_A, 'near_miss', { minutesAgo: 120 });
    const otherGym = await escalation(client, OTHER_ORG, ATH_OTHER, 'near_miss');

    const { from, to } = await lastHour(client);
    const source = reachOf(await safetyEscalationSource.candidates(from, to), 'safety_escalation');
    const inWindow = new Set([
      onA, voiceOnA, painNoteOnA, onB, shadowOnB, openOnGone, resolvedOnGone, onGoneCovered, resolvedOnA, otherGym,
    ]);
    const page = await escalationsPageReach(inWindow);

    // Person by person, the page's own read.
    expect(sorted(source)).toEqual(sorted(page));

    // And what that is, spelled out, so a fault shared by both cannot pass.
    const everyRowAnAdminSees = [
      onA, voiceOnA, painNoteOnA, onB, shadowOnB, openOnGone, onGoneCovered, resolvedOnA,
    ].sort();
    expect(sorted(source)).toEqual(sorted(new Map([
      [`${ORG}|acct-ev-admin`, everyRowAnAdminSees],
      [`${ORG}|acct-ev-orgadmin`, everyRowAnAdminSees],
      // Own athlete only; never an athlete_voice row (pain notes included); not a deleted athlete.
      [`${ORG}|acct-ev-coach-own`, [onA, resolvedOnA].sort()],
      // Covering ATH_B now; not the deleted athlete they cover.
      [`${ORG}|acct-ev-coach-cover`, [onB, shadowOnB].sort()],
      [`${OTHER_ORG}|acct-ev-other-admin`, [otherGym]],
      [`${OTHER_ORG}|acct-ev-other-coach`, [otherGym]],
    ])));
    expect([...source.values()].flat()).not.toContain(old);
    expect([...source.values()].flat()).not.toContain(resolvedOnGone);
  });

  test('parent_reply names exactly the staff the family-message-replies route shows each new reply to', async () => {
    const client = await freshDatabase('emailevents_replies');
    activeClient = client;

    const noteA = await parentMessage(client, ORG, ATH_A, 'acct-ev-coach-own');
    const noteB = await parentMessage(client, ORG, ATH_B, 'acct-ev-coach-own');
    const noteGone = await parentMessage(client, ORG, ATH_GONE, 'acct-ev-coach-own');
    const noteOther = await parentMessage(client, OTHER_ORG, ATH_OTHER, 'acct-ev-other-coach');
    const onA = await reply(client, ORG, noteA, ATH_A);
    const onB = await reply(client, ORG, noteB, ATH_B);
    const onGone = await reply(client, ORG, noteGone, ATH_GONE);
    const old = await reply(client, ORG, noteA, ATH_A, 120);
    const otherGym = await reply(client, OTHER_ORG, noteOther, ATH_OTHER);

    const { from, to } = await lastHour(client);
    const source = reachOf(await parentReplySource.candidates(from, to), 'parent_reply');
    const inWindow = new Set([onA, onB, onGone, otherGym]);
    const page = await repliesPageReach([ATH_A, ATH_B, ATH_GONE, ATH_OTHER], inWindow);

    expect(sorted(source)).toEqual(sorted(page));

    // Every coach, organization admin and admin of the gym whose membership is on;
    // a deleted athlete's reply reaches nobody; nothing crosses gyms.
    const live = [onA, onB].sort();
    expect(sorted(source)).toEqual(sorted(new Map([
      [`${ORG}|acct-ev-admin`, live],
      [`${ORG}|acct-ev-orgadmin`, live],
      [`${ORG}|acct-ev-coach-own`, live],
      [`${ORG}|acct-ev-coach-cover`, live],
      [`${ORG}|acct-ev-coach-expired`, live],
      [`${ORG}|acct-ev-coach-future`, live],
      [`${ORG}|acct-ev-coach-none`, live],
      [`${OTHER_ORG}|acct-ev-other-admin`, [otherGym]],
      [`${OTHER_ORG}|acct-ev-other-coach`, [otherGym]],
    ])));
    expect([...source.values()].flat()).not.toContain(old);
  });

  test('the tick reads these sources: "open the app" goes once to each switched-on reader of a new escalation or reply, and to nobody else', async () => {
    const client = await freshDatabase('emailevents_tick');
    activeClient = client;
    const readers = ['acct-ev-admin', 'acct-ev-coach-own', 'acct-ev-coach-cover'];
    await client.query(
      `update pilot.accounts set login_email = account_id || '@example.com' where account_id = any($1)`,
      [readers],
    );
    await client.query(
      `insert into pilot.email_alert_switches
         (organization_id, account_id, user_type, switched_on, switched_on_at, switched_off_at)
       values ($1, 'acct-ev-admin', 'staff', true, now(), null),
              ($1, 'acct-ev-coach-own', 'staff', true, now(), null),
              ($1, 'acct-ev-coach-cover', 'staff', false, null, now())`,
      [ORG],
    );
    const sent: OutboundMessage[] = [];
    const dependencies: EmailAlertSenderDependencies = {
      prepareSend: async () => async (message) => {
        sent.push(message);
      },
      gymName: async () => 'GYM',
      now: () => new Date(),
      clockMs: () => Date.now(),
    };

    // The first tick only sets each source's checkpoint.
    expect((await runEmailAlertSweep(dependencies)).queued).toBe(0);
    expect((await client.query('select event_kind from pilot.email_alert_checkpoints order by 1')).rows)
      .toEqual([{ event_kind: 'parent_reply' }, { event_kind: 'safety_escalation' }]);

    await escalation(client, ORG, ATH_A, 'near_miss', { minutesAgo: 0 });
    await escalation(client, ORG, ATH_A, 'athlete_voice', { minutesAgo: 0 });
    await reply(client, ORG, await parentMessage(client, ORG, ATH_A, 'acct-ev-coach-own'), ATH_A, 0);

    // The admin reads all three; the coach of record the near miss and the
    // reply, never the athlete_voice row; the covering coach reads the reply
    // but is switched off.
    expect(await runEmailAlertSweep(dependencies)).toMatchObject({ queued: 5, sent: 5, skipped: 0 });
    const perAddress = new Map<string, number>();
    for (const message of sent) {
      expect(message).toEqual({ to: message.to, subject: 'GYM: open the app', body: 'open the app' });
      perAddress.set(message.to, (perAddress.get(message.to) ?? 0) + 1);
    }
    expect([...perAddress.entries()].sort()).toEqual([
      ['acct-ev-admin@example.com', 3],
      ['acct-ev-coach-own@example.com', 2],
    ]);

    // Once: the next tick finds the same rows in its overlap and sends nothing.
    expect(await runEmailAlertSweep(dependencies)).toMatchObject({ queued: 0, sent: 0 });
    expect(sent).toHaveLength(5);
  });

  test('each source is a staff event on the shared list, read in a fixed order', () => {
    expect(EMAIL_ALERT_EVENT_SOURCES).toEqual([safetyEscalationSource, parentReplySource]);
    for (const source of EMAIL_ALERT_EVENT_SOURCES) {
      expect(EMAIL_ALERT_EVENTS.staff as readonly string[]).toContain(source.checkpointKey);
    }
  });
});
