/**
 * THE EMAIL ALERT SENDER (lane W4-1, EM-3b-2; plan on #2159, sections 4 and 5).
 *
 * OD-2026-11-19-019: an opt-in email that says only "open the app". It runs on
 * the server's worker tick (instrumentation.ts), every 30 seconds by default,
 * on every replica, and only where PPBF_SHADOW_WORKER_ENABLED is 'true' (GO
 * condition 7 on #2159: Overwatch confirms production has it before EM-3
 * merges). Each tick:
 *   1. sweeps each event source and queues its sends (emailAlertQueue.ts);
 *   2. puts back sends whose lease ran out (emailAlertQueue.ts);
 *   3. claims due sends one at a time (emailAlertQueue.ts), re-checks the
 *      person, fetches the gym's name and the Graph token, re-checks the person
 *      again, and sends only while the claim's lease
 *      still has four of its five minutes left; the Graph call is cut off at
 *      30 seconds. A send cut off after Graph took it can still go twice (the
 *      send log migration lists when). One row's failure is logged and the
 *      tick goes on. It stops claiming after 20 seconds or 20 sends; the
 *      source sweeps and lease recovery before that, and the send in flight,
 *      come on top (the token fetch is cut off at 10 seconds).
 *
 * RE-CHECKED BEFORE EVERY SEND (plan 5.2). The switch is on, under the row's
 * user type. Sign-in to this gym is on, as resolvePrincipal (auth.ts) would
 * find it, or stricter (a platform owner is not let into a gym that is not
 * active): this is the account's own gym (every sign-in mints its session
 * there), the account is active and not deleted, its membership here is active,
 * the gym is active, a PIN account holds only roles PIN may sign in as
 * (pinLoginPermitted, both roles), and the membership's role fits the home
 * role's sign-in (sessionCredentialFits). The person's role in that gym and
 * age still give that user type (an unknown date of birth is a minor,
 * OD-2026-10-04-010), and any account linked to an athlete record under 18 or
 * deleted gets nothing, whatever its role. The person is still one the
 * event's source names: can still read the event in the app, or for a
 * guardian's message is still nudged by it (emailAlertEvents.ts). The gym still has the event
 * ticked; there is an address. Any no: the row is skipped with its reason and
 * nothing is sent. Asked twice: once before the gym's name and the token are
 * fetched, so a person not to be mailed costs no token; and again after them,
 * just before the lease check and the send, because either can be slow (the
 * name's read has no cut-off, the token's has 10 seconds), and the email goes
 * to the address that second answer gives (Codex on EM-3b-2).
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


import { sessionCredentialFits } from './auth';
import type { PilotRole } from './contracts';
import { pinLoginPermitted } from './credentialPolicy';
import { isLoopbackPostgresConnectionString, query, queryOne } from './db';
import { accountDeletedSql } from './deletedAccountSignIn';
import {
  claimDueEmailAlertSends,
  EMAIL_ALERT_LEASE_SECONDS,
  EMAIL_ALERT_MAX_TRIES,
  recoverExpiredEmailAlertLeases,
  sweepEmailAlertSource,
  type ClaimedEmailAlertSend,
  type EmailAlertSource,
} from './emailAlertQueue';
import { EMAIL_ALERT_EVENT_SOURCES, emailAlertEventStillReadable } from './emailAlertEvents';
import { isGymEmailAlertEventTicked } from './emailAlertGymEvents';
import { emailAlertUserTypeFor } from './emailAlertSwitches';
import { MailSendError, sendPlainTextMail, type OutboundMessage } from './graphMailer';
import { SENDER } from './magicLinkStore';
import { getGraphAccessToken } from './managedIdentityToken';
import { getOrganizationProfile, OrganizationProfileUnavailableError } from './organizationProfileStore';

/** The waits between tries, one fewer than the tries (emailAlertSender.test.ts pins it). */
export const EMAIL_ALERT_RETRY_WAIT_MINUTES = [1, 5, 15, 60] as const;
/**
 * A send goes to Graph only with this much of its claim's lease left. The
 * token is fetched before this is checked, so only the Graph call, cut off at
 * EMAIL_ALERT_MAIL_TIMEOUT_MS, runs after it: it ends long before another
 * replica could take the row back.
 */
export const EMAIL_ALERT_LEASE_LEFT_TO_SEND_SECONDS = EMAIL_ALERT_LEASE_SECONDS - 60;
export const EMAIL_ALERT_MAIL_TIMEOUT_MS = 30_000;
/**
 * The Graph token fetch is cut off at this. The shared provider
 * (graphTokenProvider) has no cut-off; a hung identity endpoint becomes a
 * ManagedIdentityError, recorded as SEND_ERROR and retried.
 */
export const EMAIL_ALERT_TOKEN_TIMEOUT_MS = 10_000;
/** The tick stops claiming after this, or after this many sends. */
export const EMAIL_ALERT_SEND_LIMITS = { budgetMs: 20_000, sendsPerTick: 20 } as const;

export interface EmailAlertSenderDependencies {
  /** Gets ready to send (the Graph token, which can be slow) and returns the send itself. */
  readonly prepareSend: () => Promise<(message: OutboundMessage) => Promise<void>>;
  /** The gym's short name for the subject. */
  readonly gymName: (organizationId: string) => Promise<string>;
  readonly now: () => Date;
  /** The clock the tick's claim budget reads. */
  readonly clockMs: () => number;
  /** Whether the person is still one the event's source names (emailAlertEvents.ts). */
  readonly stillReads: (send: ClaimedEmailAlertSend) => Promise<boolean>;
}

export function emailAlertSenderDependencies(
  mailTimeoutMs: number = EMAIL_ALERT_MAIL_TIMEOUT_MS,
  tokenTimeoutMs: number = EMAIL_ALERT_TOKEN_TIMEOUT_MS,
): EmailAlertSenderDependencies {
  return {
    prepareSend: async () => {
      // graphTokenProvider's own call, with the fetch cut off (a reviewer on EM-3b-2).
      const token = await getGraphAccessToken({
        fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(tokenTimeoutMs) }),
        identityEndpoint: process.env.IDENTITY_ENDPOINT,
        identityHeader: process.env.IDENTITY_HEADER,
        now: () => Date.now(),
      });
      return (message) =>
        sendPlainTextMail(message, { sender: SENDER, saveToSentItems: false }, {
          getAccessToken: async () => token,
          fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(mailTimeoutMs) }),
        });
    },
    gymName: gymShortName,
    now: () => new Date(),
    clockMs: () => Date.now(),
    stillReads: emailAlertEventStillReadable,
  };
}

/**
 * The gym's names: this gym's stored profile's short and legal name
 * (getOrganizationProfile; outside production with no row, its development
 * profile), or, when production has no profile to read, its name of record
 * (pilot.organizations) for both. Not the sign-in email's read, which names
 * the operating gym's profile and has no such fallback. Exported for the
 * alert address code's email too (emailAlertCode.ts, EM-2b-2).
 */
export async function gymNames(organizationId: string): Promise<{ shortName: string; legalName: string }> {
  try {
    const { shortName, legalName } = await getOrganizationProfile(organizationId);
    return { shortName, legalName };
  } catch (error) {
    if (!(error instanceof OrganizationProfileUnavailableError)) throw error;
  }
  const row = await queryOne<{ organization_name: string }>(
    'select organization_name from pilot.organizations where organization_id = $1',
    [organizationId],
  );
  const name = row?.organization_name ?? '';
  return { shortName: name, legalName: name };
}

export async function gymShortName(organizationId: string): Promise<string> {
  return (await gymNames(organizationId)).shortName;
}

type SkipReason = 'switched_off' | 'gym_unticked' | 'sign_in_off' | 'not_offered' | 'no_address';
type Decision = { readonly send: true; readonly to: string } | { readonly send: false; readonly reason: SkipReason };

/** The checks made again just before a send (plan 5.2). */
async function recheck(row: ClaimedEmailAlertSend, dependencies: EmailAlertSenderDependencies): Promise<Decision> {
  const now = dependencies.now();
  const person = await queryOne<{
    active_flag: boolean;
    account_deleted: boolean;
    home_organization_id: string;
    home_role: string;
    auth_provider: string;
    is_platform_owner: boolean;
    holds_board_seat: boolean;
    login_email: string | null;
    athlete_id: string | null;
    member_role: string | null;
    member_active: boolean | null;
    gym_status: string | null;
    switched_on: boolean | null;
    switch_user_type: string | null;
    confirmed_address: string | null;
  }>(
    `select a.active_flag, ${accountDeletedSql('a')} as account_deleted,
            a.organization_id as home_organization_id, a.role as home_role, a.auth_provider,
            a.is_platform_owner,
            exists (select 1 from pilot.board_seats bs
                     where bs.organization_id = $1 and bs.account_id = a.account_id) as holds_board_seat,
            a.login_email, a.athlete_id,
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
  if (!signInIsOn(row, person)) return { send: false, reason: 'sign_in_off' };
  const subject = {
    organizationId: row.organization_id,
    accountId: row.account_id,
    role: person.member_role as PilotRole,
    athleteId: person.athlete_id,
  };
  const userType = await emailAlertUserTypeFor(subject, now);
  if (userType !== row.user_type || person.switch_user_type !== row.user_type) {
    return { send: false, reason: 'not_offered' };
  }
  // An account linked to an athlete record is that athlete's, whatever role
  // it now holds: under 18, unknown or deleted, it gets nothing.
  if (person.athlete_id && userType !== 'adult_athlete'
    && (await emailAlertUserTypeFor({ ...subject, role: 'athlete' }, now)) !== 'adult_athlete') {
    return { send: false, reason: 'not_offered' };
  }
  if (!(await dependencies.stillReads(row))) return { send: false, reason: 'not_offered' };
  if (!(await isGymEmailAlertEventTicked(row.organization_id, userType, row.event_kind))) {
    return { send: false, reason: 'gym_unticked' };
  }
  const to = (userType === 'adult_athlete' ? person.confirmed_address : person.login_email)?.trim();
  return to ? { send: true, to } : { send: false, reason: 'no_address' };
}

/** Sign-in to this gym is on, as resolvePrincipal (auth.ts) would find it. */
function signInIsOn(
  row: ClaimedEmailAlertSend,
  person: {
    active_flag: boolean; account_deleted: boolean; home_organization_id: string; home_role: string;
    auth_provider: string; is_platform_owner: boolean; holds_board_seat: boolean;
    member_role: string | null; member_active: boolean | null; gym_status: string | null;
  },
): boolean {
  if (person.home_organization_id !== row.organization_id) return false;
  if (!person.active_flag || person.account_deleted || !person.member_active || !person.member_role) return false;
  if (person.gym_status !== 'active') return false;
  const sessionRole = person.member_role as PilotRole;
  const homeRole = person.home_role as PilotRole;
  const pinContext = {
    databaseIsLoopback: isLoopbackPostgresConnectionString(process.env.AZURE_POSTGRES_CONNECTION_STRING),
    holdsBoardSeat: person.holds_board_seat,
  };
  if (person.auth_provider === 'ppbf_local'
    && (!pinLoginPermitted({ role: sessionRole }, pinContext) || !pinLoginPermitted({ role: homeRole }, pinContext))) {
    return false;
  }
  return sessionCredentialFits({ homeRole, sessionRole, isPlatformOwner: person.is_platform_owner });
}

type Outcome = 'sent' | 'skipped' | 'retried' | 'failed' | 'lost';

/** Re-checks and sends one claimed row, then records the outcome under its lease. */
export async function deliverEmailAlertSend(
  row: ClaimedEmailAlertSend,
  dependencies: EmailAlertSenderDependencies,
): Promise<Outcome> {
  const first = await recheck(row, dependencies);
  if (!first.send) return skip(row, first.reason);
  const name = (await dependencies.gymName(row.organization_id)).trim();
  let send: (message: OutboundMessage) => Promise<void>;
  try {
    // The token first: a slow refresh then costs this claim its lease, not a
    // second email.
    send = await dependencies.prepareSend();
  } catch (error) {
    return failed(row, error);
  }
  // Asked again after the slow steps, just before the lease check and the
  // send: a switch turned off, a sign-in or age change, or a new address
  // meanwhile is what counts (Codex on EM-3b-2).
  const decision = await recheck(row, dependencies);
  if (!decision.send) return skip(row, decision.reason);
  try {
    // Send only while this claim's lease has time to spare: a lease that ran
    // out may already be another replica's, and that one would send too.
    const live = await queryOne<{ live: boolean }>(
      `select true as live from pilot.email_alert_sends
        where send_id = $1 and lease_token = $2 and status = 'sending'
          and lease_expires_at > clock_timestamp() + make_interval(secs => $3)`,
      [row.send_id, row.lease_token, EMAIL_ALERT_LEASE_LEFT_TO_SEND_SECONDS],
    );
    if (!live) return 'lost';
    await send({
      to: decision.to,
      subject: name ? `${name}: open the app` : 'Open the app',
      body: 'open the app',
    });
  } catch (error) {
    return failed(row, error);
  }
  const written = await finish(row, `status = 'sent', finished_at = clock_timestamp(), last_status_code = null, last_error_code = null`, []);
  return written ? 'sent' : 'lost';
}

async function skip(row: ClaimedEmailAlertSend, reason: SkipReason): Promise<Outcome> {
  const written = await finish(row, `status = 'skipped', skip_reason = $3, finished_at = clock_timestamp()`, [reason]);
  return written ? 'skipped' : 'lost';
}

/** A try that failed: final, or queued again after its wait (plan 5.4). */
async function failed(row: ClaimedEmailAlertSend, error: unknown): Promise<Outcome> {
  const mailError = error instanceof MailSendError ? error : undefined;
  const status = mailError?.statusCode;
  const code = mailError ? (mailError.graphErrorCode ?? mailError.reason) : 'SEND_ERROR';
  const final = (status !== undefined && status >= 400 && status < 500 && status !== 429)
    || mailError?.reason === 'RECIPIENT_MALFORMED' || mailError?.reason === 'MESSAGE_EMPTY';
  if (final || row.tries >= EMAIL_ALERT_MAX_TRIES) {
    const written = await finish(row, `status = 'failed', finished_at = clock_timestamp(),
                                       last_status_code = $3, last_error_code = $4`, [status ?? null, code]);
    return written ? 'failed' : 'lost';
  }
  const written = await finish(row, `status = 'queued',
                                     next_try_at = clock_timestamp() + make_interval(mins => $5),
                                     last_status_code = $3, last_error_code = $4`,
  [status ?? null, code, EMAIL_ALERT_RETRY_WAIT_MINUTES[row.tries - 1]]);
  return written ? 'retried' : 'lost';
}

/** Writes an outcome only while this claim still holds the row's lease; says whether it did. */
async function finish(row: ClaimedEmailAlertSend, set: string, values: unknown[]): Promise<boolean> {
  const written = await query<{ send_id: string }>(
    `update pilot.email_alert_sends
        set ${set}, lease_token = null, lease_expires_at = null
      where send_id = $1 and lease_token = $2 and status = 'sending'
      returning send_id`,
    [row.send_id, row.lease_token, ...values],
  );
  return written.length === 1;
}

export interface EmailAlertSweepResult {
  queued: number;
  recovered: number;
  sent: number;
  skipped: number;
  retried: number;
  failed: number;
  /** Claims whose lease ran short or was taken back: nothing sent, or nothing recorded. */
  lost: number;
}

/** One tick of the sender. A failing source is logged and the rest still run. */
export async function runEmailAlertSweep(
  dependencies: EmailAlertSenderDependencies = emailAlertSenderDependencies(),
  sources: readonly EmailAlertSource[] = EMAIL_ALERT_EVENT_SOURCES,
  limits: { readonly budgetMs: number; readonly sendsPerTick: number } = EMAIL_ALERT_SEND_LIMITS,
): Promise<EmailAlertSweepResult> {
  const result: EmailAlertSweepResult = { queued: 0, recovered: 0, sent: 0, skipped: 0, retried: 0, failed: 0, lost: 0 };
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
  // One claim at a time, so each lease starts when its send does.
  const stopClaimingAt = dependencies.clockMs() + limits.budgetMs;
  for (let count = 0; count < limits.sendsPerTick && dependencies.clockMs() < stopClaimingAt; count += 1) {
    const [row] = await claimDueEmailAlertSends(1);
    if (!row) break;
    try {
      result[await deliverEmailAlertSend(row, dependencies)] += 1;
    } catch (error) {
      // The row stays claimed until its lease runs out, then is put back.
      console.error('Email alert send failed', { errorClass: error instanceof Error ? error.name : typeof error });
    }
  }
  return result;
}
