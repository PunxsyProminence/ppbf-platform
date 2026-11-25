/**
 * WHERE THE EMAIL ALERT'S EVENTS COME FROM (lane W4-1, EM-4a; plan on #2159,
 * section 6). Each source reads one event table and names everyone who can
 * read each new row in the app; the queue (emailAlertQueue.ts) then keeps only
 * those who have switched on and whose gym has the event ticked, and the
 * sender re-checks each of them before every send.
 *
 * A source mirrors its page's read rule exactly, so an email never tells
 * anyone about an event the app would not show them
 * (emailAlertEvents.pg.test.ts compares each source with the page's own read,
 * person by person). Times are the rows' created_at, set by now() in the
 * inserting transaction, as the sweep's overlap needs.
 *
 * STAFF (EM-4a):
 *   - safety_escalation: every new row of pilot.safety_escalations, SHADOW
 *     safety alerts and pain-note alerts included. Readers, as
 *     app/api/pilot/escalations/route.ts: the gym's admins and organization
 *     admins see every row; a coach sees the rows about the athletes they
 *     coach or are covering now (athleteIdsForCoach, access.ts), never an
 *     athlete_voice row. A resolved row about a deleted athlete is on nobody's
 *     list (listEscalations, escalationLadder.ts), so it is not sent either.
 *   - parent_reply: every new row of pilot.family_message_replies. Readers, as
 *     app/api/pilot/coach/family-message-replies/route.ts: every coach,
 *     organization admin and admin of the gym, while the athlete is live
 *     (assertActorCanAccessAthlete).
 * Family and athlete events arrive in EM-4b, the parent's new message in EM-4c.
 */

import type { EmailAlertCandidate, EmailAlertSource } from './emailAlertQueue';
import { query } from './db';
import { athleteNotDeletedSql } from './deletedAthletes';

const STAFF_ROLES = ['coach', 'organization_admin', 'admin'];
const ADMIN_ROLES = ['organization_admin', 'admin'];

function staffCandidates(
  rows: ReadonlyArray<{ organization_id: string; account_id: string; event_id: string }>,
  eventKind: string,
): EmailAlertCandidate[] {
  return rows.map((row) => ({
    organizationId: row.organization_id,
    accountId: row.account_id,
    userType: 'staff',
    eventKind,
    eventId: row.event_id,
  }));
}

export const safetyEscalationSource: EmailAlertSource = {
  checkpointKey: 'safety_escalation',
  candidates: async (from, to) => staffCandidates(await query(
    `select e.organization_id, m.account_id, e.escalation_id as event_id
       from pilot.safety_escalations e
       join pilot.organization_memberships m
         on m.organization_id = e.organization_id and m.active_flag
      where e.created_at > $1 and e.created_at <= $2
        and (e.status <> 'resolved' or ${athleteNotDeletedSql('e')})
        and (
          m.role = any($3::text[])
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
    [from, to, ADMIN_ROLES],
  ), 'safety_escalation'),
};

export const parentReplySource: EmailAlertSource = {
  checkpointKey: 'parent_reply',
  candidates: async (from, to) => staffCandidates(await query(
    `select r.organization_id, m.account_id, r.reply_id::text as event_id
       from pilot.family_message_replies r
       join pilot.athletes a
         on a.organization_id = r.organization_id and a.athlete_id = r.athlete_id and a.deleted_at is null
       join pilot.organization_memberships m
         on m.organization_id = r.organization_id and m.active_flag and m.role = any($3::text[])
      where r.created_at > $1 and r.created_at <= $2`,
    [from, to, STAFF_ROLES],
  ), 'parent_reply'),
};

/** The sources the sweep reads, in this order (EM-4b and EM-4c add theirs). */
export const EMAIL_ALERT_EVENT_SOURCES: readonly EmailAlertSource[] = [safetyEscalationSource, parentReplySource];
