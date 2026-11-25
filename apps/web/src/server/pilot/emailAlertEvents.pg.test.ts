// Real PostgreSQL-backed test for the email alert's event sources (lane W4-1,
// EM-4a and EM-4b; plan on #2159, section 6). Each source must name exactly
// the people the app shows the event to. The test asks the pages' own reads,
// as each signed-in person would make them, and compares, person by person:
//   - safety_escalation: app/api/pilot/escalations/route.ts -- listEscalations
//     with athleteIdsForCoach and excludeAthleteVoice for a coach, unscoped
//     for an admin or organization admin, nothing for any other role;
//   - parent_reply: app/api/pilot/coach/family-message-replies/route.ts --
//     requireRole(coach, organization_admin, admin), assertActorCanAccessAthlete,
//     then listRepliesForStaff;
//   - gym_notice: listLiveAnnouncements for every placement the role may read
//     (mayReadLivePlacement), for roles with an email user type;
//   - coach_message: app/api/pilot/athlete/coach-messages/route.ts --
//     assertActorCanAccessAthlete for the linked athlete, then
//     listAthleteCoachMessages.
// Each also asks the send-time check for every person and event. Someone whose
// membership is off cannot sign in, so reads nothing.
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
  withTransaction: jest.fn(async () => {
    throw new Error('test bug: nothing here opens a transaction');
  }),
  // The embedded server is on loopback, but production's is not; the sender's
  // PIN rule is applied as production applies it.
  isLoopbackPostgresConnectionString: () => false,
}));

import { assertActorCanAccessAthlete, athleteIdsForCoach, requireRole } from './access';
import {
  ANNOUNCEMENT_PLACEMENTS,
  listLiveAnnouncements,
  mayReadLivePlacement,
  setAnnouncementActive,
  type AnnouncementPlacement,
} from './announcements';
import { listAthleteCoachMessages } from './athleteCoachMessages';
import type { PilotRole } from './contracts';
import { enqueueEmailAlertSends, sweepEmailAlertSource, type EmailAlertCandidate, type EmailAlertSource } from './emailAlertQueue';
import {
  coachMessageSource,
  EMAIL_ALERT_EVENT_SOURCES,
  EMAIL_ALERT_READ_RULE_KINDS,
  emailAlertEventStillReadable,
  familyNoteSource,
  gymNoticeSource,
  NOTICE_PLACEMENTS_EMAILED,
  NOTICE_READER_ROLES,
  parentReplySource,
  safetyEscalationSource,
} from './emailAlertEvents';
import { emailAlertSenderDependencies, runEmailAlertSweep, type EmailAlertSenderDependencies } from './emailAlertSender';
import { listEscalations } from './escalationLadder';
import { listRepliesForStaff } from './familyMessageReplies';
import { MailSendError, type OutboundMessage } from './graphMailer';
import { PILOT_SESSION_COOKIE } from './env';
import { hashToken } from './security';
import { GET as parentMessagesGET } from '@/app/api/pilot/parent/messages/route';
import { gymDayIso } from '@/src/lib/gymTime';
import { EMAIL_ALERT_EVENTS, emailAlertCandidateUserType } from '@/src/shared/emailAlerts';

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

// account id, gym, membership role, membership on, and the account's own
// role where it differs: resolvePrincipal (auth.ts) signs in as the membership.
const PEOPLE: Array<[string, string, string, boolean, string?]> = [
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
  ['acct-ev-athlete', ORG, 'athlete', true], // linked to ATH_A
  ['acct-ev-athlete-off', ORG, 'athlete', false], // linked to ATH_C, membership off
  ['acct-ev-athlete-gone', ORG, 'athlete', true], // linked to the deleted ATH_GONE
  ['acct-ev-home-admin', ORG, 'coach', true, 'admin'], // an admin account, a coach here, coaching no one
  ['acct-ev-home-coach', ORG, 'volunteer', true, 'coach'],
  ['acct-ev-other-admin', OTHER_ORG, 'admin', true],
  ['acct-ev-other-coach', OTHER_ORG, 'coach', true], // coach of record of ATH_OTHER
  ['acct-ev-other-athlete', OTHER_ORG, 'athlete', true], // linked to the other gym's ATH_OTHER
];

const ATH_A = 'ath-ev-a';
const ATH_B = 'ath-ev-b';
const ATH_GONE = 'ath-ev-gone';
const ATH_GONE_COVERED = 'ath-ev-gone-covered';
const ATH_C = 'ath-ev-c'; // coach-own's second athlete
// One athlete id names a different child in each gym (deletedAthletes.ts):
// the other gym's live athlete has the id of this gym's deleted one, and the
// other gym also has a live ATH_B, coached on record by this gym's coach-none.
const ATH_OTHER = ATH_GONE;

// Athlete accounts and the record each is linked to, in its own gym.
const ATHLETE_LINKS: ReadonlyArray<[string, string]> = [
  ['acct-ev-athlete', ATH_A],
  ['acct-ev-athlete-off', ATH_C],
  ['acct-ev-athlete-gone', ATH_GONE],
  ['acct-ev-other-athlete', ATH_OTHER],
];

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
  for (const [accountId, org, role, on, homeRole] of PEOPLE) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, login_email)
       values ($1, $2, $3, 'magic_link', null, null)`,
      [accountId, homeRole ?? role, org],
    );
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ($1, $2, $3, $4)`,
      [accountId, org, role, on],
    );
  }
  const athletes: Array<[string, string, string, boolean]> = [
    [ATH_A, ORG, 'acct-ev-coach-own', false],
    [ATH_C, ORG, 'acct-ev-coach-own', false],
    [ATH_B, ORG, 'acct-ev-coach-off', false],
    [ATH_GONE, ORG, 'acct-ev-coach-own', true],
    [ATH_GONE_COVERED, ORG, 'acct-ev-coach-none', true],
    [ATH_OTHER, OTHER_ORG, 'acct-ev-other-coach', false],
    [ATH_B, OTHER_ORG, 'acct-ev-coach-none', false],
    [ATH_GONE_COVERED, OTHER_ORG, 'acct-ev-other-coach', false],
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
  for (const [accountId, athleteId] of ATHLETE_LINKS) {
    await client.query('update pilot.accounts set athlete_id = $2 where account_id = $1', [accountId, athleteId]);
  }
  // gym, athlete, covering coach, started this long ago, ends in this long
  const coverage: Array<[string, string, string, string, string]> = [
    [ORG, ATH_B, 'acct-ev-coach-cover', '1 hour', '1 hour'],
    [ORG, ATH_GONE_COVERED, 'acct-ev-coach-cover', '1 hour', '1 hour'],
    [ORG, ATH_A, 'acct-ev-coach-expired', '3 hours', '-1 hour'],
    [ORG, ATH_A, 'acct-ev-coach-future', '-1 hour', '3 hours'],
    // The other gym's live ATH_B, covered now by this gym's coach-expired.
    [OTHER_ORG, ATH_B, 'acct-ev-coach-expired', '1 hour', '1 hour'],
  ];
  for (const [org, athleteId, coachId, startedAgo, endsIn] of coverage) {
    await client.query(
      `insert into pilot.coach_coverage
         (organization_id, athlete_id, covering_coach_id, granted_by_account_id, starts_at, expires_at)
       values ($1, $2, $3, $6, now() - $4::interval, now() + $5::interval)`,
      [org, athleteId, coachId, startedAgo, endsIn, org === ORG ? 'acct-ev-admin' : 'acct-ev-other-admin'],
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

async function notice(
  client: Client,
  org: string,
  values: {
    placement?: string; kind?: string; active?: boolean; minutesAgo?: number;
    startsInMinutes?: number | null; endsInMinutes?: number | null;
  } = {},
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into pilot.announcements
       (organization_id, announcement_id, message, author_name, author_role, placement, kind, active,
        starts_at, ends_at, created_at, updated_at)
     values ($1, $2::uuid, 'Notice', 'Office', 'organization_admin', $3, $4, $5,
             case when $6::int is null then null else now() + make_interval(mins => $6::int) end,
             case when $7::int is null then null else now() + make_interval(mins => $7::int) end,
             now() - make_interval(mins => $8), now() - make_interval(mins => $8))`,
    [org, id, values.placement ?? 'gym_notices', values.kind ?? 'notice', values.active ?? true,
      values.startsInMinutes ?? null, values.endsInMinutes ?? null, values.minutesAgo ?? 5],
  );
  return id;
}

async function athleteMessage(
  client: Client,
  org: string,
  athleteId: string,
  values: { authorRole?: string | null; noteType?: string; minutesAgo?: number } = {},
): Promise<string> {
  const noteId = randomUUID();
  await client.query(
    `insert into pilot.coach_observations
       (organization_id, note_id, athlete_id, coach_account_id, author_role, note_type, note_text, created_at)
     values ($1, $2::uuid, $3, $4, $5, $6, 'Good work today.', now() - make_interval(mins => $7))`,
    [org, noteId, athleteId, org === ORG ? 'acct-ev-coach-own' : 'acct-ev-other-coach',
      values.authorRole === undefined ? 'coach' : values.authorRole, values.noteType ?? 'athlete_message', values.minutesAgo ?? 5],
  );
  return noteId;
}

// A row "made after the first tick" is dated a minute back, still inside the
// sweep's 10-minute overlap. The sweep reads the database clock to the
// millisecond, so a row from that same millisecond waits for the next tick
// (whose overlap reads it): a row dated "now" could make a test flaky.
const JUST_NOW = 1;

/** The sweep's window: the last hour, on the database's clock. */
async function lastHour(client: Client): Promise<{ from: Date; to: Date }> {
  const { rows } = await client.query<{ from: Date; to: Date }>(
    `select now() - interval '1 hour' as "from", now() as "to"`,
  );
  return rows[0];
}

/** "gym|account" -> the event ids. */
type Reach = Map<string, string[]>;

/** The user type each person's role gives (the shared list), as the sender re-checks it. */
function userTypeOf(accountId: string): string | null {
  const person = PEOPLE.find(([id]) => id === accountId);
  return person ? emailAlertCandidateUserType(person[2]) : null;
}

function reachOf(candidates: readonly EmailAlertCandidate[], eventKind: string, userType: (accountId: string) => string | null = () => 'staff'): Reach {
  const reach: Reach = new Map();
  for (const c of candidates) {
    expect({ account: c.accountId, userType: c.userType }).toEqual({ account: c.accountId, userType: userType(c.accountId) });
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

/**
 * The send-time check (emailAlertEventStillReadable) agrees with the page for
 * every person and every event in the window: yes exactly where the page shows it.
 */
async function expectStillReadableAsPage(
  page: Reach,
  events: ReadonlySet<string>,
  eventKind: string,
  userType: (accountId: string) => string | null = () => 'staff',
) {
  for (const [accountId, org] of PEOPLE) {
    const shown = page.get(`${org}|${accountId}`) ?? [];
    for (const eventId of events) {
      const reads = await emailAlertEventStillReadable({
        organization_id: org, account_id: accountId, user_type: (userType(accountId) ?? 'staff') as 'staff',
        event_kind: eventKind, event_id: eventId,
      });
      expect({ accountId, eventId, reads }).toEqual({ accountId, eventId, reads: shown.includes(eventId) });
    }
  }
}

// The placements each user type's signed-in screens show, read from the pages,
// not from emailAlertEvents.ts (everywhere is added by listLiveAnnouncements):
//   - staff: CoachWorkspace.tsx reads coach_workspace; /notices
//     (app/notices/page.tsx, admin and coach) lists every placement but
//     everywhere, the sign-in page's gym_notices included;
//   - parent: ParentHub.tsx reads parent_hub;
//   - adult athlete: AthleteWorkspace.tsx reads athlete_workspace.
const SIGNED_IN_SCREENS: Readonly<Record<string, readonly string[]>> = {
  staff: ['coach_workspace', 'gym_notices', 'athlete_workspace', 'parent_hub'],
  parent: ['parent_hub'],
  adult_athlete: ['athlete_workspace'],
};
// The ruling, apart from the screens: a sign-in-page notice emails nobody,
// wherever else it shows (Overwatch on #2159, comment 7160013584).
const NEVER_EMAILED: readonly string[] = ['gym_notices'];

/**
 * What each signed-in person's notice boards show: the live notices of their
 * own boards, with everywhere (listLiveAnnouncements), where their role may
 * read the placement (announcements/get/route.ts), in the window.
 *
 * Every live notice, up to the read's 25, not the 3 a board draws
 * (AnnouncementBanner.tsx, limit = 3, newest posted first). A known gap, put to
 * Overwatch on #2159 (comment 7159860480, "also noted"): a notice that goes
 * live behind three newer ones (scheduled, or restored) is emailed but is not
 * on the board. The fix is the board's order, outside this lane.
 */
async function noticesPageReach(inWindow: ReadonlySet<string>): Promise<Reach> {
  const reach: Reach = new Map();
  for (const [accountId, org, role, on] of PEOPLE) {
    const userType = emailAlertCandidateUserType(role);
    if (!on || !userType) continue;
    const ids = new Set<string>();
    for (const placement of ANNOUNCEMENT_PLACEMENTS) {
      if (!SIGNED_IN_SCREENS[userType].includes(placement) || NEVER_EMAILED.includes(placement)) continue;
      if (!mayReadLivePlacement(role as PilotRole, placement)) continue;
      for (const row of await listLiveAnnouncements(org, { placement, kind: 'notice', limit: 25 })) {
        if (inWindow.has(row.announcement_id)) ids.add(row.announcement_id);
      }
    }
    if (ids.size) reach.set(`${org}|${accountId}`, [...ids].sort());
  }
  return reach;
}

/** What GET /api/pilot/athlete/coach-messages gives each signed-in athlete, in the window. */
async function coachMessagesPageReach(inWindow: ReadonlySet<string>): Promise<Reach> {
  const reach: Reach = new Map();
  for (const [accountId, org, role, on] of PEOPLE) {
    const link = ATHLETE_LINKS.find(([id]) => id === accountId);
    if (!on || role !== 'athlete' || !link) continue;
    try {
      await assertActorCanAccessAthlete({ ...signedIn(accountId, org, role), athleteId: link[1] }, link[1]);
    } catch {
      continue;
    }
    const ids = (await listAthleteCoachMessages(org, link[1])).map((row) => row.note_id).filter((id) => inWindow.has(id));
    if (ids.length) reach.set(`${org}|${accountId}`, ids.sort());
  }
  return reach;
}

function sorted(reach: Reach): Array<[string, string[]]> {
  return [...reach.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** The sender's real dependencies, its read check included; Graph is replaced by a recorder. */
function recorder(): { sent: OutboundMessage[]; dependencies: EmailAlertSenderDependencies } {
  const sent: OutboundMessage[] = [];
  const dependencies: EmailAlertSenderDependencies = {
    ...emailAlertSenderDependencies(),
    prepareSend: async () => async (message) => {
      sent.push(message);
    },
    gymName: async () => 'GYM',
  };
  return { sent, dependencies };
}

// FAMILY NOTES (family_note). A child under 18 in each gym, the one id naming
// a different child in each (deletedAthletes.ts); a deleted child; a child who
// is 18; a child who turns 18 today and one who turns 18 tomorrow, on the
// gym's day. Guardian records: this gym's parent; a second guardian, behind
// two records; a guardian whose membership is off; one whose login is switched
// off; one whose login is deleted; a record with no login; a coach's login
// behind a guardian record; and the other gym's guardian.
const KID = 'ath-ev-kid';
const KID_GONE = 'ath-ev-kid-gone';
const KID_ADULT = 'ath-ev-kid-adult';
const KID_18_TODAY = 'ath-ev-kid-18-today';
const KID_18_TOMORROW = 'ath-ev-kid-18-tomorrow';
// Every login behind a guardian record, with its gym. Which of them the
// /parent messages page answers is the route's to say (familyNotesPageReach).
const GUARDIAN_LOGINS: ReadonlyArray<[string, string]> = [
  ['acct-ev-parent', ORG],
  ['acct-ev-parent-two', ORG],
  ['acct-ev-parent-off', ORG], // membership off
  ['acct-ev-parent-inactive', ORG], // login switched off
  ['acct-ev-parent-deleted', ORG], // login deleted
  ['acct-ev-coach-own', ORG], // a coach's login
  ['acct-ev-other-parent', OTHER_ORG],
];

/**
 * The date of birth of someone who turns 18 `days` days after the gym's
 * today. 29 February eighteen years back never exists (18 is not a multiple
 * of 4): the day before is already 18, the day after not yet. A run that
 * crosses the gym's midnight between the fixture and the check would see a
 * different day.
 */
function turns18In(days: number): string {
  const [year, month, day] = (gymDayIso(new Date()) as string).split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1, day + days));
  const born = target.getUTCFullYear() - 18;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (target.getUTCMonth() === 1 && target.getUTCDate() === 29) return days <= 0 ? `${born}-02-28` : `${born}-03-01`;
  return `${born}-${pad(target.getUTCMonth() + 1)}-${pad(target.getUTCDate())}`;
}

async function familyFixture(client: Client) {
  const children: Array<[string, string, string, string, boolean]> = [
    [KID, ORG, 'acct-ev-coach-own', '2015-01-01', false],
    [KID_GONE, ORG, 'acct-ev-coach-own', '2015-01-01', true],
    [KID_ADULT, ORG, 'acct-ev-coach-own', '2000-01-01', false],
    [KID_18_TODAY, ORG, 'acct-ev-coach-own', turns18In(0), false],
    [KID_18_TOMORROW, ORG, 'acct-ev-coach-own', turns18In(1), false],
    [KID, OTHER_ORG, 'acct-ev-other-coach', '2015-01-01', false],
  ];
  for (const [athleteId, org, coachId, dob, deleted] of children) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
       values ($1, $2, 'Event Child', $4::date, '60', 'active', 'contact', true, $3, now(), now(),
               case when $5 then now() else null end)`,
      [org, athleteId, coachId, dob, deleted],
    );
  }
  // account, gym, membership on, login on, login deleted
  const logins: Array<[string, string, boolean, boolean, boolean]> = [
    ['acct-ev-parent-two', ORG, true, true, false],
    ['acct-ev-parent-off', ORG, false, true, false],
    ['acct-ev-parent-inactive', ORG, true, false, false],
    ['acct-ev-parent-deleted', ORG, true, true, true],
    ['acct-ev-other-parent', OTHER_ORG, true, true, false],
  ];
  for (const [accountId, org, on, loginOn, deleted] of logins) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email, active_flag, deleted_at)
       values ($1, 'parent', $2, 'magic_link', $1 || '@example.com', $3, case when $4 then now() else null end)`,
      [accountId, org, loginOn, deleted],
    );
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, 'parent', $3)`,
      [accountId, org, on],
    );
  }
  const guardians: Array<[string, string, string | null, string[]]> = [
    [ORG, 'par-ev-1', 'acct-ev-parent', [KID, KID_GONE, KID_ADULT, KID_18_TODAY, KID_18_TOMORROW]],
    [ORG, 'par-ev-2', 'acct-ev-parent-two', [KID]],
    [ORG, 'par-ev-7', 'acct-ev-parent-two', [KID]], // the same login, a second record for the same child
    [ORG, 'par-ev-3', 'acct-ev-parent-off', [KID]],
    [ORG, 'par-ev-8', 'acct-ev-parent-inactive', [KID]],
    [ORG, 'par-ev-9', 'acct-ev-parent-deleted', [KID]],
    [ORG, 'par-ev-4', null, [KID]],
    [ORG, 'par-ev-5', 'acct-ev-coach-own', [KID]],
    [OTHER_ORG, 'par-ev-6', 'acct-ev-other-parent', [KID]],
  ];
  for (const [org, parentId, accountId, athleteIds] of guardians) {
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name) values ($1, $2, $3, 'Event Guardian')`,
      [org, parentId, accountId],
    );
    for (const athleteId of athleteIds) {
      await client.query(
        `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
         values ($1, $2, $3, 'parent')`,
        [org, parentId, athleteId],
      );
    }
  }
}

async function familyNote(
  client: Client,
  org: string,
  athleteId: string,
  values: { author?: string; noteType?: string; minutesAgo?: number } = {},
): Promise<string> {
  const noteId = randomUUID();
  await client.query(
    `insert into pilot.coach_observations (organization_id, note_id, athlete_id, coach_account_id, note_type, note_text, created_at)
     values ($1, $2::uuid, $3, $4, $5, 'Bring gloves Thursday.', now() - make_interval(mins => $6))`,
    [org, noteId, athleteId, values.author ?? (org === ORG ? 'acct-ev-coach-own' : 'acct-ev-other-coach'),
      values.noteType ?? 'parent_message', values.minutesAgo ?? 5],
  );
  return noteId;
}

/**
 * What GET /api/pilot/parent/messages, the route itself, gives each guardian
 * login in the window, signed in with a real session in its own gym: the
 * route's session gate (resolvePrincipal) and role check decide who gets a
 * page at all, not this test.
 */
async function familyNotesPageReach(client: Client, inWindow: ReadonlySet<string>): Promise<Reach> {
  const reach: Reach = new Map();
  for (const [accountId, org] of GUARDIAN_LOGINS) {
    const token = `token-${accountId}-${randomUUID()}`;
    await client.query(
      `insert into pilot.session_tokens (token_hash, account_id, organization_id, expires_at, sign_in_method)
       values ($1, $2, $3, now() + interval '1 hour', 'magic_link')`,
      [hashToken(token), accountId, org],
    );
    const response = await parentMessagesGET(new NextRequest('http://localhost/api/pilot/parent/messages', {
      headers: { cookie: `${PILOT_SESSION_COOKIE}=${token}` },
    }));
    if (response.status !== 200) continue;
    const { items } = (await response.json()) as { items: Array<{ note_id: string }> };
    const ids = items.map((item) => item.note_id).filter((id) => inWindow.has(id));
    if (ids.length) reach.set(`${org}|${accountId}`, ids.sort());
  }
  return reach;
}

/**
 * A sign-in address (account id + @example.com) and the switch on under the
 * user type each role gives; an adult athlete's confirmed address is
 * <account id>.confirmed@example.com.
 */
async function switchOn(client: Client, accountIds: readonly string[]) {
  await client.query(
    `update pilot.accounts set login_email = account_id || '@example.com' where account_id = any($1)`,
    [accountIds],
  );
  for (const accountId of accountIds) {
    const userType = userTypeOf(accountId);
    await client.query(
      `insert into pilot.email_alert_switches
         (organization_id, account_id, user_type, switched_on, switched_on_at, switched_off_at, confirmed_address, confirmed_at)
       select organization_id, account_id, $2, true, now(), null,
              case when $2 = 'adult_athlete' then account_id || '.confirmed@example.com' end,
              case when $2 = 'adult_athlete' then now() end
         from pilot.organization_memberships where account_id = $1`,
      [accountId, userType],
    );
  }
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
    await expectStillReadableAsPage(page, inWindow, 'safety_escalation');
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
    const page = await repliesPageReach([ATH_A, ATH_B, ATH_GONE], inWindow);

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
      // Signed in here as a coach, whatever the account's own role.
      [`${ORG}|acct-ev-home-admin`, live],
      [`${OTHER_ORG}|acct-ev-other-admin`, [otherGym]],
      [`${OTHER_ORG}|acct-ev-other-coach`, [otherGym]],
    ])));
    expect([...source.values()].flat()).not.toContain(old);
    await expectStillReadableAsPage(page, inWindow, 'parent_reply');
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
    const { sent, dependencies } = recorder();

    // The first tick only sets each source's checkpoint.
    expect((await runEmailAlertSweep(dependencies)).queued).toBe(0);
    expect((await client.query('select event_kind from pilot.email_alert_checkpoints order by 1')).rows)
      .toEqual([
        { event_kind: 'coach_message' }, { event_kind: 'family_note' }, { event_kind: 'gym_notice' },
        { event_kind: 'parent_reply' }, { event_kind: 'safety_escalation' },
      ]);

    await escalation(client, ORG, ATH_A, 'near_miss', { minutesAgo: JUST_NOW });
    await escalation(client, ORG, ATH_A, 'athlete_voice', { minutesAgo: JUST_NOW });
    await reply(client, ORG, await parentMessage(client, ORG, ATH_A, 'acct-ev-coach-own'), ATH_A, JUST_NOW);

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

  test('just before the send, someone who can no longer read the event is skipped as not_offered; the rest are sent', async () => {
    const client = await freshDatabase('emailevents_stillreads');
    activeClient = client;
    await switchOn(client, ['acct-ev-admin', 'acct-ev-orgadmin', 'acct-ev-coach-own', 'acct-ev-coach-cover']);
    const { sent, dependencies } = recorder();
    await runEmailAlertSweep(dependencies); // sets the checkpoints

    const voiceOnA = await escalation(client, ORG, ATH_A, 'athlete_voice', { minutesAgo: JUST_NOW });
    const nearMissOnA = await escalation(client, ORG, ATH_A, 'near_miss', { minutesAgo: JUST_NOW });
    const painOnB = await escalation(client, ORG, ATH_B, 'pain_report', { minutesAgo: JUST_NOW });
    const nearMissOnC = await escalation(client, ORG, ATH_C, 'near_miss', { minutesAgo: JUST_NOW });
    const replyOnA = await reply(client, ORG, await parentMessage(client, ORG, ATH_A, 'acct-ev-coach-own'), ATH_A, JUST_NOW);
    const replyOnB = await reply(client, ORG, await parentMessage(client, ORG, ATH_B, 'acct-ev-coach-own'), ATH_B, JUST_NOW);
    const label = new Map([
      [voiceOnA, 'voiceOnA'], [nearMissOnA, 'nearMissOnA'], [painOnB, 'painOnB'], [nearMissOnC, 'nearMissOnC'],
      [replyOnA, 'replyOnA'], [replyOnB, 'replyOnB'],
    ]);

    // Queued while everyone can read them...
    for (const source of EMAIL_ALERT_EVENT_SOURCES) await sweepEmailAlertSource(source);
    expect(Number((await client.query('select count(*) from pilot.email_alert_sends')).rows[0].count)).toBe(19);

    // ...then, before the send: the organization admin becomes a coach of no
    // one, ATH_A moves to another coach (coach-own keeps ATH_C), the cover of
    // ATH_B ends, and ATH_B is deleted.
    await client.query(`update pilot.accounts set role = 'coach' where account_id = 'acct-ev-orgadmin'`);
    await client.query(`update pilot.organization_memberships set role = 'coach' where account_id = 'acct-ev-orgadmin'`);
    await client.query(`update pilot.athletes set coach_id = 'acct-ev-coach-none' where organization_id = $1 and athlete_id = $2`, [ORG, ATH_A]);
    await client.query(`update pilot.coach_coverage set expires_at = now() where organization_id = $1 and athlete_id = $2`, [ORG, ATH_B]);
    await client.query(`update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`, [ORG, ATH_B]);

    expect(await runEmailAlertSweep(dependencies)).toMatchObject({ queued: 0, sent: 9, skipped: 10 });
    const { rows } = await client.query(
      `select account_id, event_id, status, skip_reason from pilot.email_alert_sends order by account_id, event_id`,
    );
    const outcome = (accountId: string) => rows
      .filter((row) => row.account_id === accountId)
      .map((row) => `${label.get(row.event_id)} ${row.status === 'sent' ? 'sent' : row.skip_reason}`)
      .sort();
    // An admin still sees an open row about a deleted athlete; nobody reads a deleted athlete's replies.
    expect(outcome('acct-ev-admin')).toEqual([
      'nearMissOnA sent', 'nearMissOnC sent', 'painOnB sent', 'replyOnA sent', 'replyOnB not_offered', 'voiceOnA sent',
    ]);
    expect(outcome('acct-ev-orgadmin')).toEqual([
      'nearMissOnA not_offered', 'nearMissOnC not_offered', 'painOnB not_offered', 'replyOnA sent', 'replyOnB not_offered',
      'voiceOnA not_offered',
    ]);
    // Still the coach of ATH_C: that row is sent, ATH_A's is not.
    expect(outcome('acct-ev-coach-own')).toEqual([
      'nearMissOnA not_offered', 'nearMissOnC sent', 'replyOnA sent', 'replyOnB not_offered',
    ]);
    expect(outcome('acct-ev-coach-cover')).toEqual(['painOnB not_offered', 'replyOnA sent', 'replyOnB not_offered']);
    expect(sent).toHaveLength(9);

    // An event kind no source knows, or a user type other than staff, reads as no.
    const adminReads = { organization_id: ORG, account_id: 'acct-ev-admin', event_id: nearMissOnA };
    expect(await emailAlertEventStillReadable({ ...adminReads, user_type: 'staff', event_kind: 'safety_escalation' })).toBe(true);
    expect(await emailAlertEventStillReadable({ ...adminReads, user_type: 'staff', event_kind: 'family_note' })).toBe(false);
    expect(await emailAlertEventStillReadable({ ...adminReads, user_type: 'parent', event_kind: 'safety_escalation' })).toBe(false);
  });

  test('gym_notice names, once it is live, exactly the people whose signed-in boards show it, under their own user type; a sign-in-page notice names nobody', async () => {
    const client = await freshDatabase('emailevents_notices');
    activeClient = client;

    const wall = await notice(client, ORG, { placement: 'gym_notices' });
    const parentsOnly = await notice(client, ORG, { placement: 'parent_hub' });
    const athletesOnly = await notice(client, ORG, { placement: 'athlete_workspace' });
    const coachesOnly = await notice(client, ORG, { placement: 'coach_workspace' });
    const everywhere = await notice(client, ORG, { placement: 'everywhere' });
    const motivation = await notice(client, ORG, { placement: 'everywhere', kind: 'motivation' });
    const retired = await notice(client, ORG, { placement: 'everywhere', active: false });
    // Posted two hours ago for a start five minutes ago: it counts from its start.
    const startedLately = await notice(client, ORG, { placement: 'everywhere', minutesAgo: 120, startsInMinutes: -5 });
    // Posted now with a start five hours ago: it counts from its posting.
    const backdated = await notice(client, ORG, { placement: 'everywhere', startsInMinutes: -300 });
    const notYetLive = await notice(client, ORG, { placement: 'everywhere', startsInMinutes: 60 });
    const ended = await notice(client, ORG, { placement: 'everywhere', endsInMinutes: -1 });
    const old = await notice(client, ORG, { placement: 'everywhere', minutesAgo: 120 });
    // Posted two hours ago, retired, and restored a minute ago: a restore sets
    // it live again (Overwatch on #2193, comment 7165858842), so it counts from
    // then. A minute back, not now(): lastHour's "to" comes back through
    // node-postgres as a Date, cut to the millisecond, and a restore in that
    // same millisecond would fall just after it (reviewer A on #2193).
    const restored = await notice(client, ORG, { placement: 'everywhere', minutesAgo: 120, active: false });
    await client.query(
      `update pilot.announcements set active = true, updated_at = now() - interval '1 minute' where announcement_id = $1`,
      [restored],
    );
    const otherGym = await notice(client, OTHER_ORG, { placement: 'everywhere' });

    const { from, to } = await lastHour(client);
    const source = reachOf(await gymNoticeSource.candidates(from, to), 'gym_notice', userTypeOf);
    const inWindow = new Set([
      wall, parentsOnly, athletesOnly, coachesOnly, everywhere, motivation, retired, startedLately, backdated, notYetLive,
      ended, restored, otherGym,
    ]);
    const page = await noticesPageReach(inWindow);

    expect(sorted(source)).toEqual(sorted(page));

    // The sign-in page's notice (wall) reaches nobody.
    const forStaff = [parentsOnly, athletesOnly, coachesOnly, everywhere, startedLately, backdated, restored].sort();
    const forParents = [parentsOnly, everywhere, startedLately, backdated, restored].sort();
    const forAthletes = [athletesOnly, everywhere, startedLately, backdated, restored].sort();
    expect(sorted(source)).toEqual(sorted(new Map([
      ...['acct-ev-admin', 'acct-ev-orgadmin', 'acct-ev-coach-own', 'acct-ev-coach-cover', 'acct-ev-coach-expired',
        'acct-ev-coach-future', 'acct-ev-coach-none', 'acct-ev-home-admin'].map((id) => [`${ORG}|${id}`, forStaff] as [string, string[]]),
      [`${ORG}|acct-ev-parent`, forParents],
      // The sender then sends only to an athlete 18 or over (acct-ev-athlete-gone's record is deleted).
      [`${ORG}|acct-ev-athlete`, forAthletes],
      [`${ORG}|acct-ev-athlete-gone`, forAthletes],
      [`${OTHER_ORG}|acct-ev-other-admin`, [otherGym]],
      [`${OTHER_ORG}|acct-ev-other-coach`, [otherGym]],
      [`${OTHER_ORG}|acct-ev-other-athlete`, [otherGym]],
    ])));
    expect([...source.values()].flat()).not.toContain(old);
    expect([...source.values()].flat()).not.toContain(wall);
    await expectStillReadableAsPage(page, inWindow, 'gym_notice', userTypeOf);
    // A send queued under another user type than the role now gives reads as no.
    expect(await emailAlertEventStillReadable({
      organization_id: ORG, account_id: 'acct-ev-parent', user_type: 'staff', event_kind: 'gym_notice', event_id: everywhere,
    })).toBe(false);
  });

  test('coach_message names only the athlete account linked to the record, for messages from staff', async () => {
    const client = await freshDatabase('emailevents_coach_messages');
    activeClient = client;
    // Two accounts the page never shows these messages to: one whose home gym
    // is the other gym, linked there to its ATH_B, with an athlete membership
    // here too (every sign-in is minted in the home gym); and one linked to
    // this gym's ATH_B but holding a coach membership here.
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, login_email)
       values ('acct-ev-roaming-athlete', 'athlete', $2, 'magic_link', $3, null),
              ('acct-ev-athlete-now-coach', 'coach', $1, 'magic_link', $3, null)`,
      [ORG, OTHER_ORG, ATH_B],
    );
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ('acct-ev-roaming-athlete', $1, 'athlete', true), ('acct-ev-athlete-now-coach', $1, 'coach', true)`,
      [ORG],
    );

    const toA = await athleteMessage(client, ORG, ATH_A);
    const toAFromAdmin = await athleteMessage(client, ORG, ATH_A, { authorRole: 'organization_admin' });
    // 'admin' is a membership role of its own: createCoachObservation stores it.
    const toAFromAdminRole = await athleteMessage(client, ORG, ATH_A, { authorRole: 'admin' });
    const toAFromParent = await athleteMessage(client, ORG, ATH_A, { authorRole: 'parent' });
    const toAUnknownAuthor = await athleteMessage(client, ORG, ATH_A, { authorRole: null });
    const familyNoteOnA = await athleteMessage(client, ORG, ATH_A, { noteType: 'parent_message' });
    const toC = await athleteMessage(client, ORG, ATH_C); // its account's membership is off
    const toGone = await athleteMessage(client, ORG, ATH_GONE); // a deleted record
    const toB = await athleteMessage(client, ORG, ATH_B); // only the two accounts above link to an ATH_B
    const old = await athleteMessage(client, ORG, ATH_A, { minutesAgo: 120 });
    const otherGym = await athleteMessage(client, OTHER_ORG, ATH_OTHER);

    const { from, to } = await lastHour(client);
    const source = reachOf(await coachMessageSource.candidates(from, to), 'coach_message', () => 'adult_athlete');
    const inWindow = new Set([
      toA, toAFromAdmin, toAFromAdminRole, toAFromParent, toAUnknownAuthor, familyNoteOnA, toC, toGone, toB, otherGym,
    ]);
    const page = await coachMessagesPageReach(inWindow);

    expect(sorted(source)).toEqual(sorted(page));
    expect(sorted(source)).toEqual(sorted(new Map([
      [`${ORG}|acct-ev-athlete`, [toA, toAFromAdmin, toAFromAdminRole].sort()],
      [`${OTHER_ORG}|acct-ev-other-athlete`, [otherGym]],
    ])));
    expect([...source.values()].flat()).not.toContain(old);
    await expectStillReadableAsPage(page, inWindow, 'coach_message', () => 'adult_athlete');
    // A send queued under another user type reads as no.
    expect(await emailAlertEventStillReadable({
      organization_id: ORG, account_id: 'acct-ev-athlete', user_type: 'parent', event_kind: 'coach_message', event_id: toA,
    })).toBe(false);
    // The two accounts the page never shows ATH_B's message to are refused at
    // the send too (they are not in PEOPLE, so the check above skips them).
    for (const accountId of ['acct-ev-roaming-athlete', 'acct-ev-athlete-now-coach']) {
      expect({
        accountId,
        reads: await emailAlertEventStillReadable({
          organization_id: ORG, account_id: accountId, user_type: 'adult_athlete', event_kind: 'coach_message', event_id: toB,
        }),
      }).toEqual({ accountId, reads: false });
    }
  });

  test('a scheduled notice is queued by the sweep, with its real checkpoint, only once its start time has passed', async () => {
    const client = await freshDatabase('emailevents_scheduled');
    activeClient = client;
    await switchOn(client, ['acct-ev-parent']);
    const { dependencies } = recorder();
    await runEmailAlertSweep(dependencies); // sets the checkpoints

    const scheduled = randomUUID();
    await client.query(
      `insert into pilot.announcements
         (organization_id, announcement_id, message, author_name, author_role, placement, kind, active, starts_at)
       values ($1, $2::uuid, 'Notice', 'Office', 'organization_admin', 'everywhere', 'notice', true,
               now() + interval '2 seconds')`,
      [ORG, scheduled],
    );
    const queuedFor = async () => (await client.query<{ account_id: string }>(
      'select account_id from pilot.email_alert_sends where event_kind = $1 and event_id = $2 order by account_id',
      ['gym_notice', scheduled],
    )).rows.map((row) => row.account_id);

    // Posted, not yet live: the sweep reads past it, and its checkpoint moves on.
    await sweepEmailAlertSource(gymNoticeSource);
    expect(await queuedFor()).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 2_500));
    await sweepEmailAlertSource(gymNoticeSource);
    expect(await queuedFor()).toEqual(['acct-ev-parent']);
  });

  test('family_note names exactly the guardians whose /parent messages page shows each new note, while the child is under 18', async () => {
    const client = await freshDatabase('emailevents_family_notes');
    activeClient = client;
    await familyFixture(client);

    const toKid = await familyNote(client, ORG, KID);
    const toKidByAdmin = await familyNote(client, ORG, KID, { author: 'acct-ev-admin' });
    const toKidGone = await familyNote(client, ORG, KID_GONE);
    const toKidAdult = await familyNote(client, ORG, KID_ADULT);
    const toKid18Today = await familyNote(client, ORG, KID_18_TODAY);
    const toKid18Tomorrow = await familyNote(client, ORG, KID_18_TOMORROW);
    const notAFamilyNote = await familyNote(client, ORG, KID, { noteType: 'athlete_message' });
    const old = await familyNote(client, ORG, KID, { minutesAgo: 120 });
    const otherGym = await familyNote(client, OTHER_ORG, KID);
    // Its author's account purged since (the parent-authored purge sets
    // coach_account_id to null): no longer on the page.
    const authorPurged = await familyNote(client, ORG, KID);
    await client.query(`update pilot.coach_observations set coach_account_id = null where note_id = $1::uuid`, [authorPurged]);

    const { from, to } = await lastHour(client);
    const source = reachOf(await familyNoteSource.candidates(from, to), 'family_note', () => 'parent');
    const inWindow = new Set([
      toKid, toKidByAdmin, toKidGone, toKidAdult, toKid18Today, toKid18Tomorrow, notAFamilyNote, otherGym, authorPurged,
    ]);
    const page = await familyNotesPageReach(client, inWindow);

    expect(sorted(source)).toEqual(sorted(page));
    // Each note once per login, though the second guardian's login is behind
    // two records for the child.
    expect(sorted(source)).toEqual(sorted(new Map([
      [`${ORG}|acct-ev-parent`, [toKid, toKidByAdmin, toKid18Tomorrow].sort()],
      [`${ORG}|acct-ev-parent-two`, [toKid, toKidByAdmin].sort()],
      [`${OTHER_ORG}|acct-ev-other-parent`, [otherGym]],
    ])));
    expect([...source.values()].flat()).not.toContain(old);

    // Just before the send: yes exactly where the page shows the note, for
    // every guardian login and every note in the window.
    const asks = (accountId: string, org: string, eventId: string, userType = 'parent') =>
      emailAlertEventStillReadable({
        organization_id: org, account_id: accountId, user_type: userType as 'parent', event_kind: 'family_note', event_id: eventId,
      });
    for (const [accountId, org] of GUARDIAN_LOGINS) {
      const shown = page.get(`${org}|${accountId}`) ?? [];
      for (const eventId of inWindow) {
        expect({ accountId, eventId, reads: await asks(accountId, org, eventId) })
          .toEqual({ accountId, eventId, reads: shown.includes(eventId) });
      }
    }
    // A send queued under another user type reads as no.
    expect(await asks('acct-ev-parent', ORG, toKid, 'staff')).toBe(false);
    // And each change after the sweep is seen at the send: the link removed,
    // the membership switched off, the child turned 18.
    await client.query(`delete from pilot.guardian_links where organization_id = $1 and parent_id in ('par-ev-2', 'par-ev-7')`, [ORG]);
    expect(await asks('acct-ev-parent-two', ORG, toKid)).toBe(false);
    // The gym suspended: its session gate lets no parent in, and the source
    // names nobody there; back to active, the guardian reads the note again.
    await client.query(`update pilot.organizations set status = 'suspended' where organization_id = $1`, [OTHER_ORG]);
    const suspended = reachOf(await familyNoteSource.candidates(from, to), 'family_note', () => 'parent');
    expect(sorted(suspended)).toEqual(sorted(await familyNotesPageReach(client, inWindow)));
    expect(suspended.has(`${OTHER_ORG}|acct-ev-other-parent`)).toBe(false);
    expect(await asks('acct-ev-other-parent', OTHER_ORG, otherGym)).toBe(false);
    await client.query(`update pilot.organizations set status = 'active' where organization_id = $1`, [OTHER_ORG]);
    expect(await asks('acct-ev-other-parent', OTHER_ORG, otherGym)).toBe(true);
    await client.query(`update pilot.organization_memberships set active_flag = false where account_id = 'acct-ev-other-parent'`);
    expect(await asks('acct-ev-other-parent', OTHER_ORG, otherGym)).toBe(false);
    expect(await asks('acct-ev-parent', ORG, toKid)).toBe(true);
    await client.query(`update pilot.athletes set dob = '2000-01-01' where organization_id = $1 and athlete_id = $2`, [ORG, KID]);
    expect(await asks('acct-ev-parent', ORG, toKid)).toBe(false);
  });

  test('a family note reaches each switched-on guardian of the child, at the sign-in address, once', async () => {
    const client = await freshDatabase('emailevents_family_tick');
    activeClient = client;
    await familyFixture(client);
    await switchOn(client, ['acct-ev-parent']);
    await client.query(
      `insert into pilot.email_alert_switches (organization_id, account_id, user_type, switched_on, switched_on_at)
       values ($1, 'acct-ev-parent-two', 'parent', true, now())`,
      [ORG],
    );
    const { sent, dependencies } = recorder();
    await runEmailAlertSweep(dependencies); // sets the checkpoints

    await familyNote(client, ORG, KID, { minutesAgo: JUST_NOW });
    expect(await runEmailAlertSweep(dependencies)).toMatchObject({ queued: 2, sent: 2 });
    expect(sent.map((m) => m.to).sort()).toEqual(['acct-ev-parent-two@example.com', 'acct-ev-parent@example.com']);
    for (const message of sent) expect(message).toEqual({ to: message.to, subject: 'GYM: open the app', body: 'open the app' });

    expect(await runEmailAlertSweep(dependencies)).toMatchObject({ queued: 0, sent: 0 });
    expect(sent).toHaveLength(2);
  });

  test('a retired notice is not sent; a notice restored later is sent then, once; a live one and a coach message reach a parent, a coach and an adult athlete', async () => {
    const client = await freshDatabase('emailevents_notice_tick');
    activeClient = client;
    await switchOn(client, ['acct-ev-parent', 'acct-ev-coach-own', 'acct-ev-athlete']);
    const { sent, dependencies } = recorder();
    await runEmailAlertSweep(dependencies); // sets the checkpoints

    const live = await notice(client, ORG, { placement: 'everywhere', minutesAgo: JUST_NOW });
    // Retired when it would have gone live, a quarter of an hour ago; restored
    // below, after the sweep's ten-minute overlap. A restore sets it live
    // again (Overwatch on #2193, comment 7165858842), so it is sent then.
    const restoredLater = await notice(client, ORG, { placement: 'everywhere', minutesAgo: 15, active: false });
    const toBeRetired = await notice(client, ORG, { placement: 'everywhere', minutesAgo: JUST_NOW });
    const message = await athleteMessage(client, ORG, ATH_A, { minutesAgo: JUST_NOW });
    for (const source of [gymNoticeSource, coachMessageSource]) await sweepEmailAlertSource(source);
    expect(Number((await client.query('select count(*) from pilot.email_alert_sends')).rows[0].count)).toBe(7);

    // Retire and restore through the app's own write, setAnnouncementActive,
    // which stamps updated_at (an admin's change: no author check).
    const setActive = async (announcementId: string, active: boolean) => {
      expect(await setAnnouncementActive({ organizationId: ORG, announcementId, active, onlyAuthorAccountId: null }))
        .toMatchObject({ announcement_id: announcementId, active });
      // The sweep's "to" comes back as a Date cut to the millisecond; a sweep
      // in the same millisecond as the write would read just short of it (the
      // next tick's overlap reads it again; a test sweeps once).
      await new Promise((resolve) => setTimeout(resolve, 5));
    };
    await setActive(toBeRetired, false);
    await setActive(restoredLater, true);
    expect(await runEmailAlertSweep(dependencies)).toMatchObject({ queued: 3, sent: 7, skipped: 3 });
    const sends = async () => {
      const { rows } = await client.query(
        `select account_id, event_id, status, skip_reason from pilot.email_alert_sends order by account_id, event_kind, event_id`,
      );
      const label = new Map([[live, 'live'], [toBeRetired, 'retired'], [restoredLater, 'restored'], [message, 'message']]);
      return rows.map((row) => `${row.account_id} ${label.get(row.event_id)} ${row.status === 'sent' ? 'sent' : row.skip_reason}`).sort();
    };
    const expected = [
      'acct-ev-athlete live sent', 'acct-ev-athlete message sent', 'acct-ev-athlete restored sent', 'acct-ev-athlete retired not_offered',
      'acct-ev-coach-own live sent', 'acct-ev-coach-own restored sent', 'acct-ev-coach-own retired not_offered',
      'acct-ev-parent live sent', 'acct-ev-parent restored sent', 'acct-ev-parent retired not_offered',
    ].sort();
    expect(await sends()).toEqual(expected);
    // The adult athlete at the confirmed address; staff and parents at their sign-in address.
    expect(sent.map((m) => m.to).sort()).toEqual([
      'acct-ev-athlete.confirmed@example.com', 'acct-ev-athlete.confirmed@example.com', 'acct-ev-athlete.confirmed@example.com',
      'acct-ev-coach-own@example.com', 'acct-ev-coach-own@example.com',
      'acct-ev-parent@example.com', 'acct-ev-parent@example.com',
    ]);

    // A notice already sent, retired and restored again, emails nobody twice.
    await setActive(live, false);
    await setActive(live, true);
    expect(await runEmailAlertSweep(dependencies)).toMatchObject({ queued: 0, sent: 0 });
    expect(await sends()).toEqual(expected);
    expect(sent).toHaveLength(7);

    // The notice retired before its sends went out was skipped, so nobody has
    // had it: restored, it is queued again for each reader and sent, once
    // (reviewer A on #2193).
    await setActive(toBeRetired, true);
    expect(await runEmailAlertSweep(dependencies)).toMatchObject({ queued: 3, sent: 3, skipped: 0 });
    expect(await sends()).toEqual(expected.map((row) => row.replace(' retired not_offered', ' retired sent')).sort());
    expect(sent).toHaveLength(10);
    expect(await runEmailAlertSweep(dependencies)).toMatchObject({ queued: 0, sent: 0 });
  });

  test('a skipped notice send is queued again only when the notice is restored after the skip, and then once', async () => {
    const client = await freshDatabase('emailevents_notice_skip_restore');
    activeClient = client;
    await switchOn(client, ['acct-ev-athlete', 'acct-ev-parent']);
    const { sent, dependencies } = recorder();
    await runEmailAlertSweep(dependencies); // sets the checkpoints

    // The adult athlete's record corrected to under 18 before their own next
    // read retires the switch: the source still names the login, and the
    // sender refuses it as not_offered. The parent switches off between the
    // queueing and the send, and back on after.
    await client.query(`update pilot.athletes set dob = '2015-01-01' where organization_id = $1 and athlete_id = $2`, [ORG, ATH_A]);
    const live = await notice(client, ORG, { placement: 'everywhere', minutesAgo: JUST_NOW });
    expect(await sweepEmailAlertSource(gymNoticeSource)).toBe(2);
    const parentSwitch = (on: boolean) => client.query(
      `update pilot.email_alert_switches set switched_on = $2, switched_on_at = now(), switched_off_at = case when $2 then null else now() end
        where organization_id = $1 and account_id = 'acct-ev-parent'`,
      [ORG, on],
    );
    await parentSwitch(false);
    expect(await runEmailAlertSweep(dependencies)).toMatchObject({ queued: 0, sent: 0, skipped: 2 });
    await parentSwitch(true);
    const sends = async () => (await client.query(
      `select account_id, status, skip_reason from pilot.email_alert_sends order by account_id`,
    )).rows.map((row) => `${row.account_id} ${row.status} ${row.skip_reason ?? ''}`.trim());
    const skipped = ['acct-ev-athlete skipped not_offered', 'acct-ev-parent skipped switched_off'];

    // The next sweeps read the notice again in their overlap; the notice is
    // unchanged, so each row stays skipped, not queued and skipped again.
    for (let tick = 0; tick < 2; tick += 1) {
      expect(await runEmailAlertSweep(dependencies)).toMatchObject({ queued: 0, sent: 0, skipped: 0 });
    }
    expect(await sends()).toEqual(skipped);
    expect(sent).toEqual([]);

    // Restored after the skip: live again, so each is queued again and the
    // sender asks again. The parent, switched on now, has it; the minor is
    // refused again. Then nothing more.
    for (const active of [false, true]) {
      await setAnnouncementActive({ organizationId: ORG, announcementId: live, active, onlyAuthorAccountId: null });
      await new Promise((resolve) => setTimeout(resolve, 5)); // see setActive above
    }
    expect(await runEmailAlertSweep(dependencies)).toMatchObject({ queued: 2, sent: 1, skipped: 1 });
    expect(sent.map((m) => m.to)).toEqual(['acct-ev-parent@example.com']);
    expect(await sends()).toEqual(['acct-ev-athlete skipped not_offered', 'acct-ev-parent sent']);
    expect(await runEmailAlertSweep(dependencies)).toMatchObject({ queued: 0, sent: 0, skipped: 0 });
    expect(sent).toHaveLength(1);
  });

  test('a restore that lands while the sender is deciding, after it read the notice as retired, still re-offers the send', async () => {
    const client = await freshDatabase('emailevents_notice_restore_race');
    activeClient = client;
    await switchOn(client, ['acct-ev-parent']);
    const { sent, dependencies } = recorder();
    await runEmailAlertSweep(dependencies); // sets the checkpoints

    const live = await notice(client, ORG, { placement: 'everywhere', minutesAgo: JUST_NOW });
    expect(await sweepEmailAlertSource(gymNoticeSource)).toBe(1);
    await setAnnouncementActive({ organizationId: ORG, announcementId: live, active: false, onlyAuthorAccountId: null });
    expect(await runEmailAlertSweep(dependencies)).toMatchObject({ sent: 0, skipped: 1 });
    // The restore committed between the sender's read and its skip: its time
    // is after the row became due and before the skip was written.
    await client.query(
      `update pilot.announcements n
          set active = true,
              updated_at = s.next_try_at + (s.finished_at - s.next_try_at) / 2
         from pilot.email_alert_sends s
        where n.announcement_id = $1::uuid and s.event_id = $1::text
          and s.next_try_at < s.finished_at`,
      [live],
    );
    expect(await runEmailAlertSweep(dependencies)).toMatchObject({ queued: 1, sent: 1 });
    expect(sent.map((m) => m.to)).toEqual(['acct-ev-parent@example.com']);
  });

  test('a restore offers a notice again only where no try can have reached the person: a first-try refusal yes, a try Graph may have taken no', async () => {
    const client = await freshDatabase('emailevents_notice_restore_certainty');
    activeClient = client;
    await switchOn(client, ['acct-ev-parent', 'acct-ev-coach-own']);
    // The parent's first try is a 503 (Graph may have taken the mail); the
    // coach's is a 403, a final refusal.
    const refusals = new Map<string, MailSendError>([
      ['acct-ev-parent@example.com', new MailSendError('GRAPH_SEND_FAILED', 503, 'ServiceUnavailable')],
      ['acct-ev-coach-own@example.com', new MailSendError('GRAPH_SEND_FAILED', 403, 'ErrorAccessDenied')],
    ]);
    const calls: string[] = [];
    const dependencies: EmailAlertSenderDependencies = {
      ...emailAlertSenderDependencies(),
      prepareSend: async () => async (message) => {
        calls.push(message.to);
        const refusal = refusals.get(message.to);
        if (refusal) throw refusal;
      },
      gymName: async () => 'GYM',
    };
    await runEmailAlertSweep(dependencies); // sets the checkpoints

    const live = await notice(client, ORG, { placement: 'everywhere', minutesAgo: JUST_NOW });
    expect(await runEmailAlertSweep(dependencies)).toMatchObject({ queued: 2, sent: 0, retried: 1, failed: 1 });
    // Retired; the parent's retry comes due and is skipped as not_offered.
    await setAnnouncementActive({ organizationId: ORG, announcementId: live, active: false, onlyAuthorAccountId: null });
    await client.query(`update pilot.email_alert_sends set next_try_at = clock_timestamp() where account_id = 'acct-ev-parent'`);
    expect(await runEmailAlertSweep(dependencies)).toMatchObject({ queued: 0, sent: 0, skipped: 1 });

    // Restored, with Graph now taking both: the coach, refused at once, is
    // offered again and sent; the parent, whose try Graph may have taken, is
    // not. Then nothing more.
    refusals.clear();
    await setAnnouncementActive({ organizationId: ORG, announcementId: live, active: true, onlyAuthorAccountId: null });
    await new Promise((resolve) => setTimeout(resolve, 5)); // see setActive above
    expect(await runEmailAlertSweep(dependencies)).toMatchObject({ queued: 1, sent: 1 });
    expect(await runEmailAlertSweep(dependencies)).toMatchObject({ queued: 0, sent: 0 });
    expect(calls.sort()).toEqual(['acct-ev-coach-own@example.com', 'acct-ev-coach-own@example.com', 'acct-ev-parent@example.com']);
    const { rows } = await client.query(
      `select account_id, status, skip_reason, tries, last_status_code from pilot.email_alert_sends order by account_id`,
    );
    expect(rows).toEqual([
      // The coach's two tries in all; the parent's 503 is kept as the record of its try.
      { account_id: 'acct-ev-coach-own', status: 'sent', skip_reason: null, tries: 2, last_status_code: null },
      { account_id: 'acct-ev-parent', status: 'skipped', skip_reason: 'not_offered', tries: 2, last_status_code: 503 },
    ]);
  });

  test('a candidate named twice queues once and fails nothing; a retire between the source read and the queueing offers nothing again', async () => {
    const client = await freshDatabase('emailevents_notice_reoffer_edges');
    activeClient = client;
    await switchOn(client, ['acct-ev-parent']);
    const twice = (candidate: EmailAlertCandidate) => [candidate, candidate];
    const familyNoteKey: EmailAlertCandidate = {
      organizationId: ORG, accountId: 'acct-ev-parent', userType: 'parent', eventKind: 'family_note', eventId: randomUUID(),
    };
    expect(await enqueueEmailAlertSends(twice(familyNoteKey))).toBe(1);
    expect(await enqueueEmailAlertSends(twice(familyNoteKey))).toBe(0);
    // That note exists nowhere; its row goes, so the sweeps below send only the notice.
    await client.query(`delete from pilot.email_alert_sends where event_kind = 'family_note'`);

    // The parent switched off when the send came up: skipped, before Graph.
    const live = await notice(client, ORG, { placement: 'everywhere', minutesAgo: JUST_NOW });
    const toParent: EmailAlertCandidate = {
      organizationId: ORG, accountId: 'acct-ev-parent', userType: 'parent', eventKind: 'gym_notice', eventId: live,
    };
    expect(await enqueueEmailAlertSends([toParent])).toBe(1);
    const parentSwitch = (on: boolean) => client.query(
      `update pilot.email_alert_switches set switched_on = $1, switched_on_at = now() where account_id = 'acct-ev-parent'`,
      [on],
    );
    await parentSwitch(false);
    const { sent, dependencies } = recorder();
    expect(await runEmailAlertSweep(dependencies)).toMatchObject({ sent: 0, skipped: 1 });
    await parentSwitch(true);
    const parentRow = async () => (await client.query(
      `select status, skip_reason from pilot.email_alert_sends where account_id = 'acct-ev-parent'`,
    )).rows;

    // A retire that lands after the source read the notice as live and before
    // the queueing: the notice is not live, so nothing is offered again.
    await setAnnouncementActive({ organizationId: ORG, announcementId: live, active: false, onlyAuthorAccountId: null });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await enqueueEmailAlertSends([toParent])).toBe(0);
    expect(await parentRow()).toEqual([{ status: 'skipped', skip_reason: 'switched_off' }]);

    // Restored: offered again once, even when the candidate is named twice.
    await setAnnouncementActive({ organizationId: ORG, announcementId: live, active: true, onlyAuthorAccountId: null });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await enqueueEmailAlertSends(twice(toParent))).toBe(1);
    expect(await enqueueEmailAlertSends(twice(toParent))).toBe(0);
    expect(await runEmailAlertSweep(dependencies)).toMatchObject({ sent: 1 });
    expect(sent.map((m) => m.to)).toEqual(['acct-ev-parent@example.com']);
  });

  test('a source that fails is logged by class, and the next source still queues and sends', async () => {
    const client = await freshDatabase('emailevents_failing');
    activeClient = client;
    await switchOn(client, ['acct-ev-admin']);
    const { sent, dependencies } = recorder();
    const failing: EmailAlertSource = {
      checkpointKey: 'failing_source',
      candidates: async () => {
        throw new Error('the source failed');
      },
    };
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runEmailAlertSweep(dependencies, [failing, safetyEscalationSource]); // sets the checkpoints
      await escalation(client, ORG, ATH_A, 'near_miss', { minutesAgo: JUST_NOW });
      expect(await runEmailAlertSweep(dependencies, [failing, safetyEscalationSource]))
        .toMatchObject({ queued: 1, sent: 1 });
      expect(sent.map((message) => message.to)).toEqual(['acct-ev-admin@example.com']);
      expect(errors).toHaveBeenCalledWith('Email alert source failed', { source: 'failing_source', errorClass: 'Error' });
    } finally {
      errors.mockRestore();
    }
  });

  test('every placement a notice is emailed for is one the role may read on its page (mayReadLivePlacement)', () => {
    for (const role of NOTICE_READER_ROLES) {
      const userType = emailAlertCandidateUserType(role);
      expect(userType).not.toBeNull();
      for (const placement of NOTICE_PLACEMENTS_EMAILED[userType!]) {
        expect({ role, placement, mayRead: mayReadLivePlacement(role as PilotRole, placement as AnnouncementPlacement) })
          .toEqual({ role, placement, mayRead: true });
      }
    }
    // And the sign-in page's notices email nobody (Overwatch on #2159, comment 7160013584).
    expect(Object.values(NOTICE_PLACEMENTS_EMAILED).flat()).not.toContain('gym_notices');
  });

  test('the sender reads these sources and this read check unless told otherwise', () => {
    expect(emailAlertSenderDependencies().stillReads).toBe(emailAlertEventStillReadable);
  });

  test('each source is an event on the shared list, read in a fixed order, with a send-time read rule', () => {
    expect(EMAIL_ALERT_EVENT_SOURCES.map((source) => source.checkpointKey))
      .toEqual(['safety_escalation', 'parent_reply', 'gym_notice', 'coach_message', 'family_note']);
    expect([safetyEscalationSource, parentReplySource, gymNoticeSource, coachMessageSource].map((source) => source.checkpointKey))
      .toEqual(['safety_escalation', 'parent_reply', 'gym_notice', 'coach_message']);
    const listed = Object.values(EMAIL_ALERT_EVENTS).flat() as string[];
    for (const source of EMAIL_ALERT_EVENT_SOURCES) {
      expect(listed).toContain(source.checkpointKey);
    }
    // A source the sweep reads but the send-time check does not know would be
    // skipped on every send.
    expect(EMAIL_ALERT_EVENT_SOURCES.map((source) => source.checkpointKey)).toEqual(EMAIL_ALERT_READ_RULE_KINDS);
  });
});
