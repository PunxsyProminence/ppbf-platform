/**
 * THE EMAIL ALERT QUEUE (lane W4-1, EM-3b-1; plan on #2159, sections 4 and 5).
 *
 * The send log's writes before a send: the sender (emailAlertSender.ts,
 * EM-3b-2) runs these on the server's worker tick, on every replica.
 *   1. sweepEmailAlertSource reads an event source past its checkpoint, with
 *      a 10-minute overlap so a row that commits late is not missed (plan
 *      5.1), and enqueueEmailAlertSends queues one send per person who can
 *      read the event, has switched on (EM-1) and whose gym has the event
 *      ticked (EM-5). Nobody else gets a row. A source's first sweep only sets
 *      its checkpoint, so nothing from more than ten minutes before it is ever
 *      sent (the next sweep reads the overlap). The sources arrive in EM-4a
 *      and EM-4b;
 *   2. recoverExpiredEmailAlertLeases puts back sends whose lease ran out (a
 *      server stopped mid-send), or fails them if no try is left;
 *   3. claimDueEmailAlertSends claims due sends (FOR UPDATE SKIP LOCKED, under
 *      a five-minute lease, so two replicas never claim the same one), counting
 *      a try on each (plan 5.4: at most 5).
 * No address is read or written here.
 */

import { isEmailAlertEventFor, type EmailAlertUserType } from '@/src/shared/emailAlerts';

import { query, queryOne } from './db';

export const EMAIL_ALERT_MAX_TRIES = 5;
export const EMAIL_ALERT_LEASE_SECONDS = 300;
const SWEEP_OVERLAP_MS = 10 * 60 * 1000;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One person who can read one event, as a source finds them. */
export interface EmailAlertCandidate {
  readonly organizationId: string;
  readonly accountId: string;
  readonly userType: EmailAlertUserType;
  readonly eventKind: string;
  readonly eventId: string;
}

/**
 * An event table the sweep reads (EM-4a and EM-4b add them). The overlap holds
 * only if a source's times come from the database clock in the inserting
 * transaction (a column default of now() does) and that transaction commits
 * within ten minutes.
 */
export interface EmailAlertSource {
  /** Its checkpoint key; the sends it queues carry the candidates' own kinds. */
  readonly checkpointKey: string;
  /** Everyone who can read an event that arrived after `from` and up to `to`. */
  readonly candidates: (from: Date, to: Date) => Promise<EmailAlertCandidate[]>;
}

export const EMAIL_ALERT_SOURCES: readonly EmailAlertSource[] = [];

/**
 * Queues one send per candidate whose switch is on under that user type and
 * whose gym has the event ticked; nobody else gets a row. A candidate already
 * queued for that event is left as it is. Returns how many rows were written.
 */
export async function enqueueEmailAlertSends(candidates: readonly EmailAlertCandidate[]): Promise<number> {
  const due = candidates.filter((candidate) =>
    isEmailAlertEventFor(candidate.userType, candidate.eventKind) && UUID_SHAPE.test(candidate.eventId));
  if (due.length === 0) return 0;
  const column = (pick: (candidate: EmailAlertCandidate) => string) => due.map(pick);
  const written = await query<{ send_id: string }>(
    `insert into pilot.email_alert_sends (organization_id, account_id, user_type, event_kind, event_id)
     select c.organization_id, c.account_id, c.user_type, c.event_kind, c.event_id
       from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
              as c(organization_id, account_id, user_type, event_kind, event_id)
       join pilot.email_alert_switches s
         on s.organization_id = c.organization_id and s.account_id = c.account_id
        and s.switched_on and s.user_type = c.user_type
       left join pilot.organization_email_alert_events g
         on g.organization_id = c.organization_id and g.user_type = c.user_type and g.event_kind = c.event_kind
      where coalesce(g.ticked, true)
     on conflict on constraint pilot_email_alert_send_once_key do nothing
     returning send_id`,
    [
      column((candidate) => candidate.organizationId),
      column((candidate) => candidate.accountId),
      column((candidate) => candidate.userType),
      column((candidate) => candidate.eventKind),
      column((candidate) => candidate.eventId),
    ],
  );
  return written.length;
}

/**
 * Reads one source from its checkpoint (less the overlap) to now, queues the
 * sends and moves the checkpoint on. The first sweep of a source only sets the
 * checkpoint, so events from before it existed are never sent.
 */
export async function sweepEmailAlertSource(source: EmailAlertSource): Promise<number> {
  // The database's clock, the one the events' own times come from.
  const clock = await queryOne<{ now: Date }>('select clock_timestamp() as now');
  if (!clock) throw new Error('EMAIL_ALERT_CLOCK_UNREADABLE');
  const to = clock.now;
  const checkpoint = await queryOne<{ swept_to: Date }>(
    'select swept_to from pilot.email_alert_checkpoints where event_kind = $1',
    [source.checkpointKey],
  );
  let written = 0;
  if (checkpoint) {
    const from = new Date(checkpoint.swept_to.getTime() - SWEEP_OVERLAP_MS);
    written = await enqueueEmailAlertSends(await source.candidates(from, to));
  }
  // Two replicas may sweep at once: the checkpoint only moves forward.
  await query(
    `insert into pilot.email_alert_checkpoints (event_kind, swept_to) values ($1, $2)
     on conflict (event_kind) do update
       set swept_to = greatest(pilot.email_alert_checkpoints.swept_to, excluded.swept_to),
           updated_at = clock_timestamp()`,
    [source.checkpointKey, to],
  );
  return written;
}

/** Sends whose lease ran out go back to the queue, or fail if no try is left. */
export async function recoverExpiredEmailAlertLeases(): Promise<number> {
  const rows = await query<{ send_id: string }>(
    `update pilot.email_alert_sends
        set status = case when tries >= $1 then 'failed' else 'queued' end,
            finished_at = case when tries >= $1 then clock_timestamp() end,
            next_try_at = clock_timestamp(),
            last_status_code = null,
            last_error_code = 'LEASE_EXPIRED',
            lease_token = null,
            lease_expires_at = null
      where status = 'sending' and lease_expires_at <= clock_timestamp()
      returning send_id`,
    [EMAIL_ALERT_MAX_TRIES],
  );
  return rows.length;
}

export interface ClaimedEmailAlertSend {
  readonly send_id: string;
  readonly organization_id: string;
  readonly account_id: string;
  readonly user_type: EmailAlertUserType;
  readonly event_kind: string;
  readonly tries: number;
  readonly lease_token: string;
}

/** Claims up to `limit` due sends, oldest first, counting a try on each. */
export async function claimDueEmailAlertSends(limit: number): Promise<ClaimedEmailAlertSend[]> {
  return query<ClaimedEmailAlertSend>(
    `with due as (
       select send_id from pilot.email_alert_sends
        where status = 'queued' and next_try_at <= clock_timestamp()
        order by next_try_at, send_id
        limit $1
        for update skip locked
     )
     update pilot.email_alert_sends s
        set status = 'sending',
            tries = s.tries + 1,
            lease_token = gen_random_uuid(),
            lease_expires_at = clock_timestamp() + make_interval(secs => $2)
       from due
      where s.send_id = due.send_id
      returning s.send_id, s.organization_id, s.account_id, s.user_type, s.event_kind, s.tries, s.lease_token`,
    [limit, EMAIL_ALERT_LEASE_SECONDS],
  );
}
