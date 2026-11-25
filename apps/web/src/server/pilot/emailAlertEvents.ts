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
 * Family and athlete events arrive in EM-4b, the parent's new message in EM-4c.
 */

import type { ClaimedEmailAlertSend, EmailAlertCandidate, EmailAlertSource } from './emailAlertQueue';
import { query, queryOne } from './db';
import { athleteNotDeletedSql } from './deletedAthletes';

const STAFF_ROLES = ['coach', 'organization_admin', 'admin'];
const ADMIN_ROLES = ['organization_admin', 'admin'];

/** A staff event: its read rule once, read for a time window and for one person and event. */
interface StaffEvent {
  readonly kind: string;
  /** Selects organization_id, account_id and event_id; $1 is the role list, `where` is ANDed in. */
  readonly readers: (where: string) => string;
  readonly roles: readonly string[];
  /** The `where` for rows created after $2 and up to $3. */
  readonly inWindow: string;
  /** The `where` for gym $2, account $3 and event $4. */
  readonly oneReader: string;
}

const SAFETY_ESCALATION: StaffEvent = {
  kind: 'safety_escalation',
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

const PARENT_REPLY: StaffEvent = {
  kind: 'parent_reply',
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

function staffSource(event: StaffEvent): EmailAlertSource {
  return {
    checkpointKey: event.kind,
    candidates: async (from, to) => {
      const rows = await query<{ organization_id: string; account_id: string; event_id: string }>(
        event.readers(event.inWindow),
        [event.roles, from, to],
      );
      return rows.map((row): EmailAlertCandidate => ({
        organizationId: row.organization_id,
        accountId: row.account_id,
        userType: 'staff',
        eventKind: event.kind,
        eventId: row.event_id,
      }));
    },
  };
}

export const safetyEscalationSource = staffSource(SAFETY_ESCALATION);
export const parentReplySource = staffSource(PARENT_REPLY);

/** The sources the sweep reads, in this order (EM-4b and EM-4c add theirs). */
export const EMAIL_ALERT_EVENT_SOURCES: readonly EmailAlertSource[] = [safetyEscalationSource, parentReplySource];

const STAFF_EVENTS: readonly StaffEvent[] = [SAFETY_ESCALATION, PARENT_REPLY];

/** The event kinds the send-time check has a read rule for (a test ties them to the sources). */
export const EMAIL_ALERT_READ_RULE_KINDS: readonly string[] = STAFF_EVENTS.map((event) => event.kind);

/**
 * Whether this person can still read this event in the app, asked again just
 * before the send. An event kind no source here knows reads as no.
 */
export async function emailAlertEventStillReadable(
  send: Pick<ClaimedEmailAlertSend, 'organization_id' | 'account_id' | 'user_type' | 'event_kind' | 'event_id'>,
): Promise<boolean> {
  const event = STAFF_EVENTS.find((candidate) => candidate.kind === send.event_kind);
  if (!event || send.user_type !== 'staff') return false;
  const row = await queryOne(
    `select 1 from (${event.readers(event.oneReader)}) still_reads`,
    [event.roles, send.organization_id, send.account_id, send.event_id],
  );
  return row !== null;
}
