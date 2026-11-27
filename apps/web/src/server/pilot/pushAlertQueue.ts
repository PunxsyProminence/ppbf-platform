/**
 * THE WEB PUSH QUEUE (lane W5-WP, WP-2b-1; plan and GO on #2228, sections 4
 * and 5). The push send log's writes before a send: the email alert queue's
 * design (emailAlertQueue.ts, lane W4-1 EM-3b-1) on push's own tables
 * (pilot.push_alert_sends and pilot.push_alert_checkpoints, WP-1a; QC A1 on
 * #2228). The push sender (WP-2b-2, not built yet) is to run these on the
 * worker tick:
 *   1. sweepPushAlertSource reads one of the email alert's event sources
 *      (EMAIL_ALERT_EVENT_SOURCES, emailAlertEvents.ts: push follows the gym's
 *      email event picks, OW27-18 A) past push's own checkpoint for it, with
 *      the email sweep's 10-minute overlap, and enqueuePushAlertSends queues
 *      one send per person who can read the event, has a browser on in that
 *      gym under that user type, and whose gym has the event ticked. Nobody
 *      else gets a row. A source's first push sweep only sets push's
 *      checkpoint, so nothing from more than ten minutes before it is pushed;
 *   2. recoverExpiredPushAlertLeases puts back sends whose lease ran out, or
 *      fails them if no try is left;
 *   3. claimDuePushAlertSends claims due sends (FOR UPDATE SKIP LOCKED, under
 *      a five-minute lease, so two replicas never claim the same one), counting
 *      a try on each (at most 5, as the table's CHECK allows).
 * Only whether a browser exists is read here: no endpoint and no key.
 */

import { isEmailAlertEventFor, type EmailAlertUserType } from '@/src/shared/emailAlerts';

import { query, queryOne } from './db';
import type { EmailAlertCandidate, EmailAlertSource } from './emailAlertQueue';

/** pilot.push_alert_sends allows tries 0 to 5 and a queued row only below 5 (WP-1a). */
export const PUSH_ALERT_MAX_TRIES = 5;
export const PUSH_ALERT_LEASE_SECONDS = 300;
/** The email sweep's overlap: the event sources' own times are written for it (emailAlertQueue.ts). */
const SWEEP_OVERLAP_MS = 10 * 60 * 1000;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Queues one push per candidate who has a browser on in that gym saved under
 * that user type, and whose gym has the event ticked (the email's own picks,
 * pilot.organization_email_alert_events, no row meaning ticked: OW27-18 A).
 * Nobody else gets a row.
 *   - THE BROWSER IS THE OPT-IN. The plan builds to QA A on #2228 (recommended;
 *     Jason has not answered QA): the tap on a device turns push on, whatever
 *     the email switch says. Under QA B this join gains the email switch. No
 *     browser row can exist before WP-3 (the only code that creates one),
 *     which waits for Jason's answer.
 *   - UNDER THAT USER TYPE, as the email queue asks the switch's: a browser
 *     saved as a parent's does not get a staff event. The sender asks the
 *     person's user type again before each send.
 * A candidate already queued for that event is left as it is (insert ... on
 * conflict do nothing, which also takes a candidate named twice), with one
 * exception, the email queue's.
 *
 * A RESTORED GYM NOTICE IS OFFERED AGAIN to whoever has certainly not had it
 * (Overwatch on #2193, comment 7165858842; the plan applies it to push,
 * section 4, WP-2b-1), as enqueueEmailAlertSends does, for the same reasons
 * (see there):
 *   - skipped, with no status code or error from any earlier try: every claim
 *     of it ended in a skip before any push service was asked;
 *   - failed on its first and only try. The sender (WP-2b-2) is to fail a push
 *     on its first try only when no browser can have taken it (every browser
 *     refused it finally); one browser's acceptance makes it sent.
 * It is offered again only while the notice is active and was changed after
 * the row became due (updated_at after next_try_at). A failed row keeps its
 * tries; a skipped row starts again from 0. The sender asks every check
 * again. Returns how many rows were written or queued again.
 */
export async function enqueuePushAlertSends(candidates: readonly EmailAlertCandidate[]): Promise<number> {
  const due = candidates.filter((candidate) =>
    isEmailAlertEventFor(candidate.userType, candidate.eventKind) && UUID_SHAPE.test(candidate.eventId));
  if (due.length === 0) return 0;
  const column = (pick: (candidate: EmailAlertCandidate) => string) => due.map(pick);
  const result = await queryOne<{ written: number }>(
    `with c as (
       select distinct c.organization_id, c.account_id, c.user_type, c.event_kind, c.event_id
         from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
                as c(organization_id, account_id, user_type, event_kind, event_id)
         left join pilot.organization_email_alert_events g
           on g.organization_id = c.organization_id and g.user_type = c.user_type and g.event_kind = c.event_kind
        where coalesce(g.ticked, true)
          and exists (select 1 from pilot.push_subscriptions b
                       where b.organization_id = c.organization_id and b.account_id = c.account_id
                         and b.user_type = c.user_type)
     ),
     inserted as (
       insert into pilot.push_alert_sends (organization_id, account_id, user_type, event_kind, event_id)
       select organization_id, account_id, user_type, event_kind, event_id from c
       on conflict on constraint pilot_push_alert_send_once_key do nothing
       returning send_id
     ),
     offered_again as (
       update pilot.push_alert_sends r
          set status = 'queued', skip_reason = null, finished_at = null,
              tries = case when r.status = 'skipped' then 0 else r.tries end,
              next_try_at = clock_timestamp(), user_type = c.user_type
         from c
        where r.organization_id = c.organization_id and r.account_id = c.account_id
          and r.event_kind = c.event_kind and r.event_id = c.event_id
          and r.event_kind = 'gym_notice'
          and ((r.status = 'skipped' and r.last_status_code is null and r.last_error_code is null)
               or (r.status = 'failed' and r.tries = 1))
          and exists (select 1 from pilot.announcements n
                       where n.organization_id = r.organization_id
                         and n.announcement_id = r.event_id::uuid
                         and n.active
                         and n.updated_at > r.next_try_at)
       returning r.send_id
     )
     select ((select count(*) from inserted) + (select count(*) from offered_again))::int as written`,
    [
      column((candidate) => candidate.organizationId),
      column((candidate) => candidate.accountId),
      column((candidate) => candidate.userType),
      column((candidate) => candidate.eventKind),
      column((candidate) => candidate.eventId),
    ],
  );
  return result?.written ?? 0;
}

/**
 * Reads one source from push's checkpoint for it (less the overlap) to now,
 * queues the pushes and moves the checkpoint on. Push keeps its own
 * checkpoints, so the email sweep's progress never moves push's. The first
 * push sweep of a source only sets the checkpoint.
 */
export async function sweepPushAlertSource(source: EmailAlertSource): Promise<number> {
  // The database's clock, the one the events' own times come from.
  const clock = await queryOne<{ now: Date }>('select clock_timestamp() as now');
  if (!clock) throw new Error('PUSH_ALERT_CLOCK_UNREADABLE');
  const to = clock.now;
  const checkpoint = await queryOne<{ swept_to: Date }>(
    'select swept_to from pilot.push_alert_checkpoints where event_kind = $1',
    [source.checkpointKey],
  );
  let written = 0;
  if (checkpoint) {
    const from = new Date(checkpoint.swept_to.getTime() - SWEEP_OVERLAP_MS);
    written = await enqueuePushAlertSends(await source.candidates(from, to));
  }
  // Two replicas may sweep at once: the checkpoint only moves forward.
  await query(
    `insert into pilot.push_alert_checkpoints (event_kind, swept_to) values ($1, $2)
     on conflict (event_kind) do update
       set swept_to = greatest(pilot.push_alert_checkpoints.swept_to, excluded.swept_to),
           updated_at = clock_timestamp()`,
    [source.checkpointKey, to],
  );
  return written;
}

/** Pushes whose lease ran out go back to the queue, or fail if no try is left. */
export async function recoverExpiredPushAlertLeases(): Promise<number> {
  const rows = await query<{ send_id: string }>(
    `update pilot.push_alert_sends
        set status = case when tries >= $1 then 'failed' else 'queued' end,
            finished_at = case when tries >= $1 then clock_timestamp() end,
            next_try_at = clock_timestamp(),
            last_status_code = null,
            last_error_code = 'LEASE_EXPIRED',
            lease_token = null,
            lease_expires_at = null
      where status = 'sending' and lease_expires_at <= clock_timestamp()
      returning send_id`,
    [PUSH_ALERT_MAX_TRIES],
  );
  return rows.length;
}

export interface ClaimedPushAlertSend {
  readonly send_id: string;
  readonly organization_id: string;
  readonly account_id: string;
  readonly user_type: EmailAlertUserType;
  readonly event_kind: string;
  readonly event_id: string;
  readonly tries: number;
  readonly lease_token: string;
}

/** Claims up to `limit` due pushes, oldest first, counting a try on each. */
export async function claimDuePushAlertSends(limit: number): Promise<ClaimedPushAlertSend[]> {
  return query<ClaimedPushAlertSend>(
    `with due as (
       select send_id from pilot.push_alert_sends
        where status = 'queued' and next_try_at <= clock_timestamp()
        order by next_try_at, send_id
        limit $1
        for update skip locked
     )
     update pilot.push_alert_sends s
        set status = 'sending',
            tries = s.tries + 1,
            lease_token = gen_random_uuid(),
            lease_expires_at = clock_timestamp() + make_interval(secs => $2)
       from due
      where s.send_id = due.send_id
      returning s.send_id, s.organization_id, s.account_id, s.user_type, s.event_kind, s.event_id, s.tries, s.lease_token`,
    [limit, PUSH_ALERT_LEASE_SECONDS],
  );
}
