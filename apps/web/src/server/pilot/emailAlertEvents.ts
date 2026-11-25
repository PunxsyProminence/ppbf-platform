/**
 * WHERE THE EMAIL ALERT'S EVENTS COME FROM (lane W4-1, EM-4a; plan on #2159,
 * section 6). Each source reads one event table and names everyone who can
 * read each new row in the app; the queue (emailAlertQueue.ts) then keeps only
 * those who have switched on and whose gym has the event ticked.
 *
 * A source mirrors its page's read rule (emailAlertEvents.pg.test.ts compares
 * each with the page's own read, person by person), and the same rule is asked
 * again for the one person and event just before the send
 * (emailAlertEventStillReadable, called by emailAlertSender.ts): someone who
 * can no longer read the row by then -- moved off the athlete, coverage ended,
 * no longer an admin, the athlete deleted (an admin still reads an open
 * escalation about a deleted athlete, so is still sent it) -- is skipped as
 * 'not_offered', the send log's reason for "this event is not for them now".
 * Reach is judged when the sweep reads the row, so someone who can read it
 * only later (coverage granted afterwards) is not emailed for it. The source
 * names a membership whatever the account's sign-in; the sender's own
 * re-check refuses anyone who cannot sign in to that gym, and any account
 * linked to an athlete under 18. Times are the rows' created_at, set by now()
 * in the inserting transaction, as the sweep's overlap needs.
 *
 * STAFF (EM-4a):
 *   - safety_escalation: every new row of pilot.safety_escalations, SHADOW
 *     safety alerts and pain-note alerts included. Readers, as
 *     app/api/pilot/escalations/route.ts: the gym's admins and organization
 *     admins see every row; a coach sees the rows about the athletes they
 *     coach or are covering now (athleteIdsForCoach, access.ts), never an
 *     athlete_voice row. A resolved row about a deleted athlete is on nobody's
 *     list (listEscalations, escalationLadder.ts), so it is not sent either.
 *     The role is the membership's, as resolvePrincipal (auth.ts) reads it.
 *   - parent_reply: every new row of pilot.family_message_replies. Readers, as
 *     app/api/pilot/coach/family-message-replies/route.ts: every coach,
 *     organization admin and admin of the gym, while the athlete is live
 *     (assertActorCanAccessAthlete).
 * FAMILY AND ATHLETE (EM-4b):
 *   - gym_notice: a notice (never the Chalkboard's 'motivation') as it goes
 *     live, to every coach, organization admin, admin, parent and athlete whose
 *     role may read its placement (mayReadLivePlacement, announcements.ts, the
 *     page's own rule), each under the user type their role gives.
 *   - coach_message: a coach's or admin's message to an athlete, to that
 *     athlete's own account (athlete/coach-messages/route.ts); the sender sends
 *     only to an athlete 18 or over.
 *   - family_note (to come): a coach's message to a family, to the guardians
 *     linked to the child (parent/messages/route.ts), once W4-4's #2179 lands
 *     its one-statement guardian-link rule to reuse.
 * The parent's new message arrives in EM-4c.
 */

import type { EmailAlertUserType } from '@/src/shared/emailAlerts';
import { emailAlertCandidateUserType } from '@/src/shared/emailAlerts';

import { mayReadLivePlacement, type AnnouncementPlacement } from './announcements';
import type { PilotRole } from './contracts';
import type { ClaimedEmailAlertSend, EmailAlertCandidate, EmailAlertSource } from './emailAlertQueue';
import { query, queryOne } from './db';
import { athleteNotDeletedSql } from './deletedAthletes';

const STAFF_ROLES = ['coach', 'organization_admin', 'admin'];
const ADMIN_ROLES = ['organization_admin', 'admin'];

type SendToCheck = Pick<ClaimedEmailAlertSend, 'organization_id' | 'account_id' | 'user_type' | 'event_kind' | 'event_id'>;

/** One event kind: the sweep's source, and the same rule asked again just before the send. */
interface AlertEvent {
  readonly kind: string;
  readonly source: EmailAlertSource;
  readonly stillReads: (send: SendToCheck) => Promise<boolean>;
}

/** An event whose read rule is one SQL statement, read for a time window and for one person and event. */
interface SqlEvent {
  readonly kind: string;
  readonly userType: EmailAlertUserType;
  /** Selects organization_id, account_id and event_id; $1 is `roles`, `where` is ANDed in. */
  readonly readers: (where: string) => string;
  readonly roles: readonly string[];
  /** The `where` for rows created after $2 and up to $3. */
  readonly inWindow: string;
  /** The `where` for gym $2, account $3 and event $4. */
  readonly oneReader: string;
}

const SAFETY_ESCALATION: SqlEvent = {
  kind: 'safety_escalation',
  userType: 'staff',
  readers: (where) =>
    `select e.organization_id, m.account_id, e.escalation_id as event_id
       from pilot.safety_escalations e
       join pilot.organization_memberships m
         on m.organization_id = e.organization_id and m.active_flag
      where ${where}
        and (e.status <> 'resolved' or ${athleteNotDeletedSql('e')})
        and (
          m.role = any($1::text[])
          or (m.role = 'coach' and e.source_type <> 'athlete_voice' and (
            exists (
              select 1 from pilot.athletes a
               where a.organization_id = e.organization_id and a.athlete_id = e.athlete_id
                 and a.coach_id = m.account_id and a.deleted_at is null
            )
            or exists (
              select 1 from pilot.coach_coverage cc
               join pilot.athletes a
                 on a.organization_id = cc.organization_id and a.athlete_id = cc.athlete_id
                and a.deleted_at is null
               where cc.organization_id = e.organization_id and cc.athlete_id = e.athlete_id
                 and cc.covering_coach_id = m.account_id
                 and cc.starts_at <= now() and cc.expires_at > now()
            )
          ))
        )`,
  roles: ADMIN_ROLES,
  inWindow: 'e.created_at > $2 and e.created_at <= $3',
  oneReader: 'e.organization_id = $2 and m.account_id = $3 and e.escalation_id = $4',
};

const PARENT_REPLY: SqlEvent = {
  kind: 'parent_reply',
  userType: 'staff',
  readers: (where) =>
    `select r.organization_id, m.account_id, r.reply_id::text as event_id
       from pilot.family_message_replies r
       join pilot.athletes a
         on a.organization_id = r.organization_id and a.athlete_id = r.athlete_id and a.deleted_at is null
       join pilot.organization_memberships m
         on m.organization_id = r.organization_id and m.active_flag and m.role = any($1::text[])
      where ${where}`,
  roles: STAFF_ROLES,
  inWindow: 'r.created_at > $2 and r.created_at <= $3',
  // Event ids passed the send log's UUID check when they were queued.
  oneReader: 'r.organization_id = $2 and m.account_id = $3 and r.reply_id = $4::uuid',
};

/**
 * A coach's message to an athlete (EM-4b): the athlete's own account, as
 * GET /api/pilot/athlete/coach-messages reads it -- an athlete membership in
 * the account's own gym, the account linked to that athlete record, the record
 * live (assertActorCanAccessAthlete), and only messages a coach, organization
 * admin or admin wrote (listAthleteCoachMessages). The sender then sends only
 * to an athlete 18 or over with a confirmed address.
 */
const COACH_MESSAGE: SqlEvent = {
  kind: 'coach_message',
  userType: 'adult_athlete',
  readers: (where) =>
    `select co.organization_id, m.account_id, co.note_id::text as event_id
       from pilot.coach_observations co
       join pilot.athletes a
         on a.organization_id = co.organization_id and a.athlete_id = co.athlete_id and a.deleted_at is null
       join pilot.accounts acc
         on acc.organization_id = co.organization_id and acc.athlete_id = co.athlete_id
       join pilot.organization_memberships m
         on m.organization_id = co.organization_id and m.account_id = acc.account_id
        and m.active_flag and m.role = 'athlete'
      where ${where}
        and co.note_type = 'athlete_message' and co.author_role = any($1::text[])`,
  roles: STAFF_ROLES,
  inWindow: 'co.created_at > $2 and co.created_at <= $3',
  oneReader: 'co.organization_id = $2 and m.account_id = $3 and co.note_id = $4::uuid',
};

function sqlEvent(event: SqlEvent): AlertEvent {
  return {
    kind: event.kind,
    source: {
      checkpointKey: event.kind,
      candidates: async (from, to) => {
        const rows = await query<{ organization_id: string; account_id: string; event_id: string }>(
          event.readers(event.inWindow),
          [event.roles, from, to],
        );
        return rows.map((row): EmailAlertCandidate => ({
          organizationId: row.organization_id,
          accountId: row.account_id,
          userType: event.userType,
          eventKind: event.kind,
          eventId: row.event_id,
        }));
      },
    },
    stillReads: async (send) => {
      if (send.user_type !== event.userType) return false;
      const row = await queryOne(
        `select 1 from (${event.readers(event.oneReader)}) still_reads`,
        [event.roles, send.organization_id, send.account_id, send.event_id],
      );
      return row !== null;
    },
  };
}

/**
 * A gym notice going live (EM-4b; the notice kind only, GO condition 1). It
 * counts from the moment it goes live -- when it is posted, or at its start
 * time if that is later -- so a scheduled notice is sent when people can read
 * it, not before. Readers: every coach, organization admin, admin, parent and
 * athlete of the gym whose role may read the notice's placement
 * (mayReadLivePlacement, announcements.ts, the page's own rule), each under
 * the user type their role gives. A notice retired, or ended, by the send is
 * not sent; one switched back on later is not sent again.
 */
const NOTICE_READER_ROLES = ['coach', 'organization_admin', 'admin', 'parent', 'athlete'];
const NOTICE_LIVE_FROM = 'greatest(n.created_at, coalesce(n.starts_at, n.created_at))';
const NOTICE_LIVE_NOW = `n.kind = 'notice' and n.active
        and (n.starts_at is null or n.starts_at <= now()) and (n.ends_at is null or n.ends_at > now())`;

function readsNotice(role: string, placement: string, userType?: string): EmailAlertUserType | null {
  const type = emailAlertCandidateUserType(role);
  if (!type || (userType !== undefined && type !== userType)) return null;
  return mayReadLivePlacement(role as PilotRole, placement as AnnouncementPlacement) ? type : null;
}

const GYM_NOTICE: AlertEvent = {
  kind: 'gym_notice',
  source: {
    checkpointKey: 'gym_notice',
    candidates: async (from, to) => {
      const notices = await query<{ organization_id: string; event_id: string; placement: string }>(
        `select n.organization_id, n.announcement_id::text as event_id, n.placement
           from pilot.announcements n
          where ${NOTICE_LIVE_NOW}
            and ${NOTICE_LIVE_FROM} > $1 and ${NOTICE_LIVE_FROM} <= $2`,
        [from, to],
      );
      if (notices.length === 0) return [];
      const members = await query<{ organization_id: string; account_id: string; role: string }>(
        `select organization_id, account_id, role from pilot.organization_memberships
          where active_flag and organization_id = any($1::text[]) and role = any($2::text[])`,
        [[...new Set(notices.map((notice) => notice.organization_id))], NOTICE_READER_ROLES],
      );
      const candidates: EmailAlertCandidate[] = [];
      for (const notice of notices) {
        for (const member of members) {
          if (member.organization_id !== notice.organization_id) continue;
          const userType = readsNotice(member.role, notice.placement);
          if (userType) {
            candidates.push({
              organizationId: notice.organization_id,
              accountId: member.account_id,
              userType,
              eventKind: 'gym_notice',
              eventId: notice.event_id,
            });
          }
        }
      }
      return candidates;
    },
  },
  stillReads: async (send) => {
    const row = await queryOne<{ placement: string; role: string }>(
      `select n.placement, m.role
         from pilot.announcements n
         join pilot.organization_memberships m
           on m.organization_id = n.organization_id and m.account_id = $2 and m.active_flag
        where n.organization_id = $1 and n.announcement_id = $3::uuid
          and ${NOTICE_LIVE_NOW}`,
      [send.organization_id, send.account_id, send.event_id],
    );
    return row !== null && readsNotice(row.role, row.placement, send.user_type) !== null;
  },
};

const EVENTS: readonly AlertEvent[] = [
  sqlEvent(SAFETY_ESCALATION),
  sqlEvent(PARENT_REPLY),
  GYM_NOTICE,
  sqlEvent(COACH_MESSAGE),
];

export const [safetyEscalationSource, parentReplySource, gymNoticeSource, coachMessageSource] = EVENTS.map(
  (event) => event.source,
);

/** The sources the sweep reads, in this order (EM-4c adds the parent's new message). */
export const EMAIL_ALERT_EVENT_SOURCES: readonly EmailAlertSource[] = EVENTS.map((event) => event.source);

/** The event kinds the send-time check has a read rule for (a test ties them to the sources). */
export const EMAIL_ALERT_READ_RULE_KINDS: readonly string[] = EVENTS.map((event) => event.kind);

/**
 * Whether this person can still read this event in the app, asked again just
 * before the send. An event kind no source here knows reads as no.
 */
export async function emailAlertEventStillReadable(send: SendToCheck): Promise<boolean> {
  const event = EVENTS.find((candidate) => candidate.kind === send.event_kind);
  return event ? event.stillReads(send) : false;
}
