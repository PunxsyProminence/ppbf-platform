/**
 * THE WEB PUSH SENDER (lane W5-WP, WP-2b-2b; plan and GO on #2228, section 4).
 *
 * The email alert sender's design (emailAlertSender.ts, W4-1 EM-3b-2) for the
 * push queue (pushAlertQueue.ts). runPushAlertSweep is one tick; WP-2b-2c puts
 * it on the worker tick after the email sweep. While the push settings are
 * unset or invalid (pushKeys, pushSubscriptions.ts) a tick does nothing at all:
 * push sends nothing. Each tick otherwise:
 *   1. sweeps each event source into push's queue (pushAlertQueue.ts);
 *   2. puts back pushes whose lease ran out;
 *   3. claims due pushes one at a time, re-checks the person, and posts the
 *      push to all their browsers in that gym at once (at most 10), only while
 *      the claim's lease has four of its five minutes left. Each post is cut
 *      off at 10 seconds, so a send ends well inside that. It stops claiming
 *      after 20 seconds or 20 pushes.
 *
 * RE-CHECKED BEFORE EVERY SEND, as the email sender does: the email switch is
 * on under the row's user type (QK A on #2228, until Jason answers QA); sign-in
 * to this gym is on, the gym active among it; the person's role and age still
 * give that user type, and any account linked to an athlete record under 18 or
 * deleted gets nothing; the person is still one the event's source names; the
 * gym still has the event ticked; and the person has a browser on in that gym
 * under that user type. Any no: the row is skipped with its reason.
 *
 * WHAT IS SENT. web-push 3.6.7 (QD (a)) builds each request: the fixed payload
 * "open", encrypted to the browser's keys, and the VAPID header. The service
 * worker reads nothing from it and shows only "Open the app" (public/sw.js,
 * QE A). One Topic for every push, so a push service keeps only the newest one
 * a browser has not fetched yet; TTL and urgency are web-push's defaults. The
 * request is posted by pushTransport.ts, which refuses a host whose address is
 * not public. No endpoint or key is logged or written to the send log.
 *
 * OUTCOMES, one per row for all the person's browsers in that gym:
 *   - a browser answering 2xx took it, and the push is sent;
 *   - 404 or 410: that browser is gone. Its row is deleted in every gym where
 *     that browser is still this person's (the endpoint key is endpoint-first
 *     for this), with an audit row in each, as the store's removals have;
 *   - 429, any 5xx, or no answer (a time-out or a network error): worth another try;
 *   - any other answer, a host that is not public, or a request that cannot be
 *     built: final for that browser. (A status outside 100-599 never comes
 *     back: pushTransport.ts refuses it as PUSH_BAD_STATUS, worth another try.)
 * Any browser took it: sent. Else, one worth another try with tries left: back
 * to the queue after the email's waits (1, 5, 15 and 60 minutes; at most 5
 * tries), with the last status and error. Else: failed, with them. So, as
 * pushAlertQueue.ts requires for the restored-notice re-offer: every try that
 * may have reached a push service leaves a code; a skip keeps the codes it
 * had; and a push fails on its first try only when no browser can have taken it.
 */

import { generateRequestDetails } from 'web-push';

import { sessionCredentialFits } from './auth';
import type { PilotRole } from './contracts';
import { pinLoginPermitted } from './credentialPolicy';
import { isLoopbackPostgresConnectionString, query, queryOne } from './db';
import { accountDeletedSql } from './deletedAccountSignIn';
import type { EmailAlertSource } from './emailAlertQueue';
import { EMAIL_ALERT_EVENT_SOURCES, emailAlertEventStillReadable } from './emailAlertEvents';
import { isGymEmailAlertEventTicked } from './emailAlertGymEvents';
import { EMAIL_ALERT_RETRY_WAIT_MINUTES, EMAIL_ALERT_SEND_LIMITS } from './emailAlertSender';
import { emailAlertUserTypeFor } from './emailAlertSwitches';
import {
  claimDuePushAlertSends,
  PUSH_ALERT_LEASE_SECONDS,
  PUSH_ALERT_MAX_TRIES,
  recoverExpiredPushAlertLeases,
  sweepPushAlertSource,
  type ClaimedPushAlertSend,
} from './pushAlertQueue';
import { parsePushEndpoint, PUSH_BROWSERS_PER_PERSON, pushKeys, type PushSettings } from './pushSubscriptions';
import { postPushRequest, PUSH_POST_DEFAULTS, PushPostError } from './pushTransport';

export const PUSH_PAYLOAD = 'open';
export const PUSH_TOPIC = 'open-the-app';
/** web-push 3.6.7's own default TTL (four weeks), passed as such. */
export const PUSH_TTL_SECONDS = 2_419_200;
export const PUSH_POST_TIMEOUT_MS = 10_000;
/** A push is posted only with this much of its claim's lease left (all browsers at once, 10 s each, fit well inside). */
export const PUSH_LEASE_LEFT_TO_SEND_SECONDS = PUSH_ALERT_LEASE_SECONDS - 60;

type VapidDetails = { readonly subject: string; readonly publicKey: string; readonly privateKey: string };

/** The three push settings, only when pushKeys finds them valid (the private key is checked there, never returned). */
export function pushVapidDetails(env: PushSettings): VapidDetails | null {
  const keys = pushKeys(env);
  if (!keys) return null;
  return {
    subject: env.PPBF_WEB_PUSH_SUBJECT ?? '',
    publicKey: keys.publicKey,
    privateKey: env.PPBF_WEB_PUSH_VAPID_PRIVATE_KEY ?? '',
  };
}

export interface PushAlertSenderDependencies {
  readonly env: PushSettings;
  /** Posts one built request; resolves to the status code (pushTransport.ts). */
  readonly post: (details: ReturnType<typeof generateRequestDetails>) => Promise<number>;
  readonly now: () => Date;
  readonly clockMs: () => number;
  readonly stillReads: (send: ClaimedPushAlertSend) => Promise<boolean>;
}

export function pushAlertSenderDependencies(env: PushSettings = process.env): PushAlertSenderDependencies {
  return {
    env,
    post: (details) => postPushRequest(details, { ...PUSH_POST_DEFAULTS, timeoutMs: PUSH_POST_TIMEOUT_MS }),
    now: () => new Date(),
    clockMs: () => Date.now(),
    stillReads: emailAlertEventStillReadable,
  };
}

type SkipReason = 'switched_off' | 'gym_unticked' | 'sign_in_off' | 'not_offered' | 'no_subscription';
type Browser = { readonly subscription_id: string; readonly endpoint: string; readonly key_p256dh: string; readonly key_auth: string };
type Decision = { readonly send: true; readonly browsers: readonly Browser[] } | { readonly send: false; readonly reason: SkipReason };

interface Person {
  active_flag: boolean;
  account_deleted: boolean;
  home_organization_id: string;
  home_role: string;
  auth_provider: string;
  is_platform_owner: boolean;
  holds_board_seat: boolean;
  athlete_id: string | null;
  member_role: string | null;
  member_active: boolean | null;
  gym_status: string | null;
  switched_on: boolean | null;
  switch_user_type: string | null;
}

/** The checks made again just before a send, as emailAlertSender.ts makes them. */
async function recheck(row: ClaimedPushAlertSend, dependencies: PushAlertSenderDependencies): Promise<Decision> {
  const now = dependencies.now();
  const person = await queryOne<Person>(
    `select a.active_flag, ${accountDeletedSql('a')} as account_deleted,
            a.organization_id as home_organization_id, a.role as home_role, a.auth_provider,
            a.is_platform_owner,
            exists (select 1 from pilot.board_seats bs
                     where bs.organization_id = $1 and bs.account_id = a.account_id) as holds_board_seat,
            a.athlete_id, om.role as member_role, om.active_flag as member_active, o.status as gym_status,
            s.switched_on, s.user_type as switch_user_type
       from pilot.accounts a
       left join pilot.organization_memberships om on om.account_id = a.account_id and om.organization_id = $1
       left join pilot.organizations o on o.organization_id = $1
       left join pilot.email_alert_switches s on s.organization_id = $1 and s.account_id = a.account_id
      where a.account_id = $2`,
    [row.organization_id, row.account_id],
  );
  // QK A: the email switch too, until Jason answers QA (its user type below).
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
  const browsers = await query<Browser>(
    `select subscription_id::text, endpoint, key_p256dh, key_auth from pilot.push_subscriptions
      where organization_id = $1 and account_id = $2 and user_type = $3
      order by subscription_id limit $4`,
    [row.organization_id, row.account_id, row.user_type, PUSH_BROWSERS_PER_PERSON],
  );
  return browsers.length > 0 ? { send: true, browsers } : { send: false, reason: 'no_subscription' };
}

/**
 * Sign-in to this gym is on, as resolvePrincipal (auth.ts) would find it: a
 * copy of emailAlertSender.ts's signInIsOn, which it does not export (that
 * file is W4-1's; the plan edits none of W4-1's files beyond its wording).
 */
function signInIsOn(row: ClaimedPushAlertSend, person: Person): boolean {
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

type Answer = { readonly took: true } | { readonly took: false; readonly gone: boolean; readonly again: boolean; readonly status: number | null; readonly code: string };

/** Posts the push to one browser and says what came of it. */
async function postToBrowser(browser: Browser, vapid: VapidDetails, dependencies: PushAlertSenderDependencies): Promise<Answer> {
  let details;
  try {
    details = generateRequestDetails(
      { endpoint: parsePushEndpoint(browser.endpoint), keys: { p256dh: browser.key_p256dh, auth: browser.key_auth } },
      PUSH_PAYLOAD,
      { vapidDetails: vapid, TTL: PUSH_TTL_SECONDS, urgency: 'normal', topic: PUSH_TOPIC },
    );
  } catch {
    return { took: false, gone: false, again: false, status: null, code: 'PUSH_REQUEST_UNBUILDABLE' };
  }
  let status: number;
  try {
    status = await dependencies.post(details);
  } catch (error) {
    if (error instanceof PushPostError) {
      // A host that is not public was never reached; a time-out or an answer cut short may have been.
      return { took: false, gone: false, again: error.code !== 'PUSH_HOST_NOT_PUBLIC', status: null, code: error.code };
    }
    return { took: false, gone: false, again: true, status: null, code: 'PUSH_NETWORK_ERROR' };
  }
  if (status >= 200 && status <= 299) return { took: true };
  if (status === 404 || status === 410) return { took: false, gone: true, again: false, status, code: 'PUSH_GONE' };
  const again = status === 429 || status >= 500;
  return { took: false, gone: false, again, status, code: again ? 'PUSH_TRY_AGAIN' : 'PUSH_REFUSED' };
}

type Outcome = 'sent' | 'skipped' | 'retried' | 'failed' | 'lost';

/** Re-checks and sends one claimed row, then records the outcome under its lease. */
export async function deliverPushAlertSend(
  row: ClaimedPushAlertSend,
  vapid: VapidDetails,
  dependencies: PushAlertSenderDependencies,
): Promise<Outcome> {
  const decision = await recheck(row, dependencies);
  if (!decision.send) {
    const written = await finish(row, `status = 'skipped', skip_reason = $3, finished_at = clock_timestamp()`, [decision.reason]);
    return written ? 'skipped' : 'lost';
  }
  // Send only while this claim's lease has time to spare: a lease that ran
  // out may already be another replica's, and that one would send too.
  const live = await queryOne<{ live: boolean }>(
    `select true as live from pilot.push_alert_sends
      where send_id = $1 and lease_token = $2 and status = 'sending'
        and lease_expires_at > clock_timestamp() + make_interval(secs => $3)`,
    [row.send_id, row.lease_token, PUSH_LEASE_LEFT_TO_SEND_SECONDS],
  );
  if (!live) return 'lost';
  // All the person's browsers at once: a send takes one post's time, not ten.
  const answers = await Promise.all(decision.browsers.map((browser) => postToBrowser(browser, vapid, dependencies)));
  let took = false;
  let worthAgain: Extract<Answer, { took: false }> | null = null;
  let last: Extract<Answer, { took: false }> | null = null;
  const gone: string[] = [];
  for (const [index, answer] of answers.entries()) {
    if (answer.took) {
      took = true;
      continue;
    }
    last = answer;
    if (answer.again) worthAgain = answer;
    if (answer.gone) gone.push(decision.browsers[index].endpoint);
  }
  if (gone.length > 0) {
    // Every gym's row of a gone browser that is still this person's (a
    // browser moved to someone else since is theirs), audited in each gym
    // with no actor and never the endpoint, in one statement.
    await query(
      `with gone as (
         delete from pilot.push_subscriptions
          where endpoint = any($1::text[]) and account_id = $2
          returning organization_id, account_id
       )
       insert into pilot.audit_events
         (event_type, actor_account_id, actor_role, organization_id, entity_type, entity_id, details)
       select 'update', null, null, organization_id, 'push_browser', account_id,
              jsonb_build_object('push_browser', 'off', 'reason', 'gone', 'count', count(*))
         from gone group by organization_id, account_id`,
      [gone, row.account_id],
    );
  }
  if (took) {
    const written = await finish(row, `status = 'sent', finished_at = clock_timestamp(), last_status_code = null, last_error_code = null`, []);
    return written ? 'sent' : 'lost';
  }
  const answer = worthAgain ?? last;
  if (worthAgain && row.tries < PUSH_ALERT_MAX_TRIES) {
    const written = await finish(row, `status = 'queued',
                                       next_try_at = clock_timestamp() + make_interval(mins => $5),
                                       last_status_code = $3, last_error_code = $4`,
    [worthAgain.status, worthAgain.code, EMAIL_ALERT_RETRY_WAIT_MINUTES[row.tries - 1]]);
    return written ? 'retried' : 'lost';
  }
  const written = await finish(row, `status = 'failed', finished_at = clock_timestamp(),
                                     last_status_code = $3, last_error_code = $4`, [answer?.status ?? null, answer?.code ?? 'PUSH_NOT_SENT']);
  return written ? 'failed' : 'lost';
}

/** Writes an outcome only while this claim still holds the row's lease; says whether it did. */
async function finish(row: ClaimedPushAlertSend, set: string, values: unknown[]): Promise<boolean> {
  const written = await query<{ send_id: string }>(
    `update pilot.push_alert_sends
        set ${set}, lease_token = null, lease_expires_at = null
      where send_id = $1 and lease_token = $2 and status = 'sending'
      returning send_id`,
    [row.send_id, row.lease_token, ...values],
  );
  return written.length === 1;
}

export interface PushAlertSweepResult {
  queued: number;
  recovered: number;
  sent: number;
  skipped: number;
  retried: number;
  failed: number;
  /** Claims whose lease ran short or was taken back: nothing sent, or nothing recorded. */
  lost: number;
}

/** One tick of the push sender. Nothing at all while the push settings are unset. A failing source is logged and the rest still run. */
export async function runPushAlertSweep(
  dependencies: PushAlertSenderDependencies = pushAlertSenderDependencies(),
  sources: readonly EmailAlertSource[] = EMAIL_ALERT_EVENT_SOURCES,
  limits: { readonly budgetMs: number; readonly sendsPerTick: number } = EMAIL_ALERT_SEND_LIMITS,
): Promise<PushAlertSweepResult> {
  const result: PushAlertSweepResult = { queued: 0, recovered: 0, sent: 0, skipped: 0, retried: 0, failed: 0, lost: 0 };
  const vapid = pushVapidDetails(dependencies.env);
  if (!vapid) return result;
  for (const source of sources) {
    try {
      result.queued += await sweepPushAlertSource(source);
    } catch (error) {
      console.error('Push alert source failed', {
        source: source.checkpointKey,
        errorClass: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  result.recovered = await recoverExpiredPushAlertLeases();
  // One claim at a time, so each lease starts when its send does.
  const stopClaimingAt = dependencies.clockMs() + limits.budgetMs;
  for (let count = 0; count < limits.sendsPerTick && dependencies.clockMs() < stopClaimingAt; count += 1) {
    const [row] = await claimDuePushAlertSends(1);
    if (!row) break;
    try {
      result[await deliverPushAlertSend(row, vapid, dependencies)] += 1;
    } catch (error) {
      // The row stays claimed until its lease runs out, then is put back.
      console.error('Push alert send failed', { errorClass: error instanceof Error ? error.name : typeof error });
    }
  }
  return result;
}
