/**
 * THE EMAIL ALERT SENDER (lane W4-1, EM-3b; plan on #2159, sections 4 and 5).
 *
 * OD-2026-11-19-019: an opt-in email that says only "open the app". It runs on
 * the server's worker tick (instrumentation.ts), every 30 seconds by default.
 * Each tick:
 *   1. sweeps each event source past its checkpoint, with a 10-minute overlap
 *      so a row that commits late is not missed (plan 5.1), and queues one
 *      send per person who can read the event, has switched on (EM-1) and
 *      whose gym has the event ticked (EM-5). Nobody else gets a row. A
 *      source's first sweep only sets its checkpoint: no history is sent;
 *   2. puts back sends whose lease ran out (a server stopped mid-send);
 *   3. claims due sends (FOR UPDATE SKIP LOCKED, under a lease, so two
 *      replicas never send the same one), re-checks the person and sends.
 *
 * RE-CHECKED BEFORE EVERY SEND (plan 5.2). The switch is on, under the row's
 * user type; sign-in is on (account active and not deleted, membership of
 * that gym active, gym active: resolvePrincipal's checks); the person's role
 * in that gym and age still give that user type (an unknown date of birth is
 * a minor, OD-2026-10-04-010); the gym still has the event ticked; there is an
 * address. Any no: the row is skipped with its reason and nothing is sent.
 *
 * WHAT IS SENT (plan 5.3). Subject "<gym short name>: open the app", body
 * "open the app": no link, no word about the event. From the sign-in sender
 * (OW27-05 A), with no Sent Items copy (Overwatch's answer A on #2159).
 * Staff and parents get it at their sign-in address; an adult athlete at the
 * address they confirmed (OW27-38 B). The address is read here, at send time,
 * and never written to the send log or to a log line.
 *
 * RETRIES (plan 5.4). A try is counted when a send is claimed. At most 5 tries,
 * waiting 1, 5, 15 and 60 minutes. A Graph 4xx other than 429, a malformed
 * address and an empty message are final.
 */

import { isEmailAlertEventFor, type EmailAlertUserType } from '@/src/shared/emailAlerts';

import type { PilotRole } from './contracts';
import { query, queryOne } from './db';
import { accountDeletedSql } from './deletedAccountSignIn';
import { isGymEmailAlertEventTicked } from './emailAlertGymEvents';
import { emailAlertUserTypeFor } from './emailAlertSwitches';
import { MailSendError, sendPlainTextMail, type OutboundMessage } from './graphMailer';
import { SENDER } from './magicLinkStore';
import { graphTokenProvider } from './managedIdentityToken';
import { getOrganizationProfile, OrganizationProfileUnavailableError } from './organizationProfileStore';

export const EMAIL_ALERT_MAX_TRIES = 5;
export const EMAIL_ALERT_RETRY_WAIT_MINUTES = [1, 5, 15, 60] as const;
const LEASE_SECONDS = 120;
const SWEEP_OVERLAP_MS = 10 * 60 * 1000;
const SENDS_PER_TICK = 20;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One person who can read one event, as a source finds them. */
export interface EmailAlertCandidate {
  readonly organizationId: string;
  readonly accountId: string;
  readonly userType: EmailAlertUserType;
  readonly eventKind: string;
  readonly eventId: string;
}

/** An event table the sweep reads (EM-4a and EM-4b add them). */
export interface EmailAlertSource {
  /** Its checkpoint key; the sends it queues carry the candidates' own kinds. */
  readonly checkpointKey: string;
  /** Everyone who can read an event that arrived after `from` and up to `to`. */
  readonly candidates: (from: Date, to: Date) => Promise<EmailAlertCandidate[]>;
}

export const EMAIL_ALERT_SOURCES: readonly EmailAlertSource[] = [];

export interface EmailAlertSenderDependencies {
  readonly sendMail: (message: OutboundMessage) => Promise<void>;
  /** The gym's short name for the subject. */
  readonly gymName: (organizationId: string) => Promise<string>;
  readonly now: () => Date;
}

export function emailAlertSenderDependencies(): EmailAlertSenderDependencies {
  return {
    sendMail: (message) =>
      sendPlainTextMail(message, { sender: SENDER, saveToSentItems: false }, {
        getAccessToken: graphTokenProvider(),
        fetchImpl: fetch,
      }),
    gymName: gymShortName,
    now: () => new Date(),
  };
}

async function gymShortName(organizationId: string): Promise<string> {
  try {
    return (await getOrganizationProfile(organizationId)).shortName;
  } catch (error) {
    if (!(error instanceof OrganizationProfileUnavailableError)) throw error;
  }
  const row = await queryOne<{ organization_name: string }>(
    'select organization_name from pilot.organizations where organization_id = $1',
    [organizationId],
  );
  return row?.organization_name ?? '';
}

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
    [limit, LEASE_SECONDS],
  );
}

type SkipReason = 'switched_off' | 'gym_unticked' | 'sign_in_off' | 'not_offered' | 'no_address';
type Decision = { readonly send: true; readonly to: string } | { readonly send: false; readonly reason: SkipReason };

/** The checks made again just before a send (plan 5.2). */
async function recheck(row: ClaimedEmailAlertSend, now: Date): Promise<Decision> {
  const person = await queryOne<{
    active_flag: boolean;
    account_deleted: boolean;
    login_email: string | null;
    athlete_id: string | null;
    member_role: string | null;
    member_active: boolean | null;
    gym_status: string | null;
    switched_on: boolean | null;
    switch_user_type: string | null;
    confirmed_address: string | null;
  }>(
    `select a.active_flag, ${accountDeletedSql('a')} as account_deleted, a.login_email, a.athlete_id,
            om.role as member_role, om.active_flag as member_active, o.status as gym_status,
            s.switched_on, s.user_type as switch_user_type, s.confirmed_address
       from pilot.accounts a
       left join pilot.organization_memberships om on om.account_id = a.account_id and om.organization_id = $1
       left join pilot.organizations o on o.organization_id = $1
       left join pilot.email_alert_switches s on s.organization_id = $1 and s.account_id = a.account_id
      where a.account_id = $2`,
    [row.organization_id, row.account_id],
  );
  if (!person?.switched_on) return { send: false, reason: 'switched_off' };
  if (!person.active_flag || person.account_deleted || !person.member_active || person.gym_status !== 'active') {
    return { send: false, reason: 'sign_in_off' };
  }
  const userType = await emailAlertUserTypeFor({
    organizationId: row.organization_id,
    accountId: row.account_id,
    role: person.member_role as PilotRole,
    athleteId: person.athlete_id,
  }, now);
  if (userType !== row.user_type || person.switch_user_type !== row.user_type) {
    return { send: false, reason: 'not_offered' };
  }
  if (!(await isGymEmailAlertEventTicked(row.organization_id, userType, row.event_kind))) {
    return { send: false, reason: 'gym_unticked' };
  }
  const to = (userType === 'adult_athlete' ? person.confirmed_address : person.login_email)?.trim();
  return to ? { send: true, to } : { send: false, reason: 'no_address' };
}

type Outcome = 'sent' | 'skipped' | 'retried' | 'failed';

/** Re-checks and sends one claimed row, then records the outcome under its lease. */
export async function deliverEmailAlertSend(
  row: ClaimedEmailAlertSend,
  dependencies: EmailAlertSenderDependencies,
): Promise<Outcome> {
  const decision = await recheck(row, dependencies.now());
  if (!decision.send) {
    await finish(row, `status = 'skipped', skip_reason = $3, finished_at = clock_timestamp()`, [decision.reason]);
    return 'skipped';
  }
  const name = (await dependencies.gymName(row.organization_id)).trim();
  try {
    await dependencies.sendMail({
      to: decision.to,
      subject: name ? `${name}: open the app` : 'Open the app',
      body: 'open the app',
    });
  } catch (error) {
    const mailError = error instanceof MailSendError ? error : undefined;
    const status = mailError?.statusCode;
    const code = mailError ? (mailError.graphErrorCode ?? mailError.reason) : 'SEND_ERROR';
    const final = (status !== undefined && status >= 400 && status < 500 && status !== 429)
      || mailError?.reason === 'RECIPIENT_MALFORMED' || mailError?.reason === 'MESSAGE_EMPTY';
    if (final || row.tries >= EMAIL_ALERT_MAX_TRIES) {
      await finish(row, `status = 'failed', finished_at = clock_timestamp(),
                         last_status_code = $3, last_error_code = $4`, [status ?? null, code]);
      return 'failed';
    }
    await finish(row, `status = 'queued',
                       next_try_at = clock_timestamp() + make_interval(mins => $5),
                       last_status_code = $3, last_error_code = $4`,
    [status ?? null, code, EMAIL_ALERT_RETRY_WAIT_MINUTES[row.tries - 1]]);
    return 'retried';
  }
  await finish(row, `status = 'sent', finished_at = clock_timestamp(), last_status_code = null, last_error_code = null`, []);
  return 'sent';
}

/** Writes an outcome only while this claim still holds the row's lease. */
async function finish(row: ClaimedEmailAlertSend, set: string, values: unknown[]): Promise<void> {
  await query(
    `update pilot.email_alert_sends
        set ${set}, lease_token = null, lease_expires_at = null
      where send_id = $1 and lease_token = $2 and status = 'sending'`,
    [row.send_id, row.lease_token, ...values],
  );
}

export interface EmailAlertSweepResult {
  queued: number;
  recovered: number;
  sent: number;
  skipped: number;
  retried: number;
  failed: number;
}

/** One tick of the sender. A failing source is logged and the rest still run. */
export async function runEmailAlertSweep(
  dependencies: EmailAlertSenderDependencies = emailAlertSenderDependencies(),
  sources: readonly EmailAlertSource[] = EMAIL_ALERT_SOURCES,
): Promise<EmailAlertSweepResult> {
  const result: EmailAlertSweepResult = { queued: 0, recovered: 0, sent: 0, skipped: 0, retried: 0, failed: 0 };
  for (const source of sources) {
    try {
      result.queued += await sweepEmailAlertSource(source);
    } catch (error) {
      console.error('Email alert source failed', {
        source: source.checkpointKey,
        errorClass: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  result.recovered = await recoverExpiredEmailAlertLeases();
  for (const row of await claimDueEmailAlertSends(SENDS_PER_TICK)) {
    result[await deliverEmailAlertSend(row, dependencies)] += 1;
  }
  return result;
}
