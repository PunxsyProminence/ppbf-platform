/**
 * EACH PERSON'S WEB PUSH BROWSERS (lane W5-WP, WP-1b; plan, answers and GO on
 * #2228). Reads and writes the caller's own rows of pilot.push_subscriptions
 * (WP-1a), one per browser per gym.
 *
 * WHO. Push follows the email alert's settings (OW27-18 A), so it is offered
 * to exactly the people the email switch is offered to: emailAlertUserTypeFor
 * (coach, admin, organization admin, parents, and athletes 18 or over; no date
 * of birth counts as a minor, OD-2026-10-04-010). Anyone else is not offered
 * push, and any browser rows they still hold are removed at their next offer
 * read (GET) or save. A save decides again under its own locks, as the email
 * store's saves do (stillOfferedUnderLock). A device marked as a gym tablet
 * never offers push (OW27-17 B); the mark lives only in that browser
 * (gymTabletMark.ts), so the screen keeps that rule (src/lib/pushOffer.ts).
 *
 * FAIL CLOSED. Push is offered only when the three push settings are present
 * and shaped as web-push 3.6.7 requires (its src/vapid-helper.js), read as set
 * (never trimmed), and the public key is the private key's own: no keys, no
 * offer, so no control that does nothing.
 *
 * WHERE A PUSH MAY GO. web-push posts to whatever host and port url.parse
 * finds in the endpoint (its src/web-push-lib.js), so an endpoint is taken only
 * as an https URL on a plain DNS host with a path, the table's own CHECK, and
 * WHATWG URL must read the same host, with no port or userinfo. Refusing a host
 * that resolves to a private address is the sender's (WP-2).
 *
 * The auth secret and the endpoint never reach a log line, an audit row or a
 * response. One person per browser: a browser turned on by someone else, in
 * any gym, moves to the caller, under a lock on the endpoint so two first
 * saves cannot both stay (reviewer B on #2231); one person may have it in each
 * of their gyms. At most PUSH_BROWSERS_PER_PERSON per person per gym; saving
 * one more drops the one saved longest ago. device_key_hash stays null unless
 * Jason answers QB B on #2228.
 */

import { createECDH } from 'node:crypto';

import type { PoolClient } from 'pg';

import { isMinor } from '@/src/lib/minorAge';
import { emailAlertCandidateUserType, type EmailAlertUserType } from '@/src/shared/emailAlerts';

import { writePilotAuditEvent } from './audit';
import { queryOne, withTransaction } from './db';
import { accountDeletedSql } from './deletedAccountSignIn';
import { emailAlertUserTypeFor, type EmailAlertSwitchSubject } from './emailAlertSwitches';
import { ConflictError, ForbiddenError, ValidationError } from './errors';

export type PushSubject = EmailAlertSwitchSubject;
export type PushOffer = { readonly offered: false } | { readonly offered: true; readonly public_key: string };
export interface PushBrowser {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

/** The three push settings, as process.env holds them. */
export type PushSettings = Readonly<Record<string, string | undefined>>;

export const PUSH_BROWSERS_PER_PERSON = 10;
const NOT_OFFERED = 'Forbidden: web push is not offered to this account';
const ENDPOINT_SHAPE = /^https:\/\/((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63})\/[!-~]*$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** The longest browser key taken, padding included: 128 characters and two '='. */
const KEY_MAX_CHARACTERS = 130;

function decodedLength(value: string): number {
  return BASE64URL.test(value) ? Buffer.from(value, 'base64url').length : -1;
}

/** Whether the public key is the private key's own. web-push does not check; a mismatched pair could send nothing. */
function isKeyPair(publicKey: string, privateKey: string): boolean {
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(privateKey, 'base64url'));
    return ecdh.getPublicKey().equals(Buffer.from(publicKey, 'base64url'));
  } catch {
    return false;
  }
}

/**
 * The push settings' public key, only when all three are set and shaped as
 * web-push 3.6.7 checks them, on the raw strings as it does: a base64url public
 * key of 65 bytes, a private key of 32 bytes whose own public key it is, and an
 * https: or mailto: subject. The private key is checked, never returned.
 */
export function pushKeys(env: PushSettings = process.env): { readonly publicKey: string } | null {
  const publicKey = env.PPBF_WEB_PUSH_VAPID_PUBLIC_KEY ?? '';
  const privateKey = env.PPBF_WEB_PUSH_VAPID_PRIVATE_KEY ?? '';
  const subject = env.PPBF_WEB_PUSH_SUBJECT ?? '';
  if (decodedLength(publicKey) !== 65 || decodedLength(privateKey) !== 32 || !isKeyPair(publicKey, privateKey)) return null;
  if (!URL.canParse(subject) || !['https:', 'mailto:'].includes(new URL(subject).protocol)) return null;
  return { publicKey };
}

/** An endpoint the sender may post to, as the table's CHECK takes it, read the same way by WHATWG URL. */
export function parsePushEndpoint(value: unknown): string {
  const shape = typeof value === 'string' && value.length <= 2048 && !value.includes('@') && !value.includes('\\')
    ? ENDPOINT_SHAPE.exec(value)
    : null;
  const url = shape && URL.canParse(shape[0]) ? new URL(shape[0]) : null;
  if (!shape || !url || url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== ''
    || url.hostname !== shape[1].toLowerCase()) {
    throw new ValidationError('endpoint must be an https push service address');
  }
  return shape[0];
}

/** A browser key in base64url, padding dropped; `bytes` exact, or `minBytes` up to 128 characters. */
function parseKey(value: unknown, field: string, size: { bytes?: number; minBytes?: number }): string {
  // Length first: the padding strip below is not linear on a long run of '=' (reviewer E on #2236).
  const key = typeof value === 'string' && value.length <= KEY_MAX_CHARACTERS ? value.replace(/=+$/, '') : '';
  const length = decodedLength(key);
  const fits = size.bytes !== undefined ? length === size.bytes : length >= (size.minBytes ?? 0) && key.length <= 128;
  if (length < 0 || !fits) throw new ValidationError(`keys.${field} is not a browser push key`);
  return key;
}

function exactFields(value: unknown, fields: readonly string[], what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${what} must be a JSON object`);
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== [...fields].sort().join(',')) throw new ValidationError(`${what} takes exactly: ${fields.join(', ')}`);
  return value as Record<string, unknown>;
}

/** The body of a save: exactly { endpoint, keys: { p256dh, auth } }, as PushSubscription.toJSON gives it. */
export function parsePushBrowser(body: unknown): PushBrowser {
  const fields = exactFields(body, ['endpoint', 'keys'], 'The body');
  const keys = exactFields(fields.keys, ['p256dh', 'auth'], 'keys');
  return {
    endpoint: parsePushEndpoint(fields.endpoint),
    p256dh: parseKey(keys.p256dh, 'p256dh', { bytes: 65 }),
    auth: parseKey(keys.auth, 'auth', { minBytes: 16 }),
  };
}

/** The body of a check or a removal: exactly { endpoint }. */
export function parseEndpointBody(body: unknown): string {
  return parsePushEndpoint(exactFields(body, ['endpoint'], 'The body').endpoint);
}

function audit(client: PoolClient, subject: PushSubject, eventType: 'create' | 'update', details: Record<string, unknown>) {
  return writePilotAuditEvent({
    event_type: eventType,
    actor_account_id: subject.accountId,
    actor_role: subject.role,
    organization_id: subject.organizationId,
    entity_type: 'push_browser',
    entity_id: subject.accountId,
    // Never the endpoint or a key.
    details,
    shadow_mirror: false,
  }, client);
}

/**
 * Removes every browser row the caller holds in this gym, audited, when they
 * are no longer offered push -- asked again first, under the locks a save
 * takes and in its order (Codex on #2236): the athlete's own row FOR SHARE
 * (an athlete), then the account FOR NO KEY UPDATE. A date of birth corrected
 * to 18 or over, or a save, made before then has committed by then, and the
 * rows stay; one made after waits for this. As main's email store does
 * (emailAlertSwitches.ts lockPerson), a record some other account is linked
 * to (A5) is read, not locked.
 */
async function dropBrowsers(subject: PushSubject, now: Date): Promise<void> {
  // Most never had a row (every athlete under 18): one read, no lock, as the email store does.
  const any = await queryOne<{ found: boolean }>(
    'select true as found from pilot.push_subscriptions where organization_id = $1 and account_id = $2 limit 1',
    [subject.organizationId, subject.accountId],
  );
  if (!any) return;
  await withTransaction(async (client) => {
    const athleteId = emailAlertCandidateUserType(subject.role) === 'adult_athlete' ? subject.athleteId?.trim() || null : null;
    if (athleteId) {
      await client.query('select 1 from pilot.athletes where organization_id = $1 and athlete_id = $2 for share', [
        subject.organizationId, athleteId,
      ]);
    }
    await client.query('select 1 from pilot.accounts where account_id = $1 for no key update', [subject.accountId]);
    if (await emailAlertUserTypeFor(subject, now)) return;
    const { rowCount } = await client.query(
      'delete from pilot.push_subscriptions where organization_id = $1 and account_id = $2',
      [subject.organizationId, subject.accountId],
    );
    if (rowCount) await audit(client, subject, 'update', { push_browsers: 'all_off', reason: 'not_offered', count: rowCount });
  });
}

/** Whether push is offered to the caller, with the public key a browser subscribes with. */
export async function readPushOffer(subject: PushSubject, env: PushSettings = process.env, now = new Date()): Promise<PushOffer> {
  if (!(await emailAlertUserTypeFor(subject, now))) {
    await dropBrowsers(subject, now);
    return { offered: false };
  }
  const keys = pushKeys(env);
  return keys ? { offered: true, public_key: keys.publicKey } : { offered: false };
}

/**
 * Whether this browser is on for the caller in this gym, under the user type
 * they have now. A row saved under another (a parent made a coach) is one the
 * sender skips, so it is not on here, and the page offers to save it again,
 * which saves it under the new one (Codex on #2236). Read only: someone not
 * offered is refused, not cleared.
 */
export async function isPushOnHere(
  subject: PushSubject, body: unknown, env: PushSettings = process.env, now = new Date(),
): Promise<{ readonly on: boolean }> {
  const endpoint = parseEndpointBody(body);
  const userType = await emailAlertUserTypeFor(subject, now);
  if (!userType || !pushKeys(env)) throw new ForbiddenError(NOT_OFFERED);
  const row = await queryOne<{ on: boolean }>(
    `select true as on from pilot.push_subscriptions
      where organization_id = $1 and account_id = $2 and endpoint = $3 and user_type = $4`,
    [subject.organizationId, subject.accountId, endpoint, userType],
  );
  return { on: row?.on === true };
}

/** The date of birth of the live athlete record linked to this very account in this gym (emailAlertSwitches.ts's read). */
const LINKED_ATHLETE_DOB_SQL = `select to_char(ath.dob, 'YYYY-MM-DD') as dob
       from pilot.accounts acc
       join pilot.athletes ath
         on ath.organization_id = $1 and ath.athlete_id = acc.athlete_id
      where acc.account_id = $2 and acc.athlete_id = $3 and ath.deleted_at is null`;

/**
 * EVERYTHING A SAVE RESTS ON, AGAIN UNDER THE SAVE'S OWN LOCKS (reviewers E
 * and F on #2236), taken in the order of main's email store
 * (emailAlertSwitches.ts lockPerson, whose comment says why no writer waits
 * the other way): the athlete row FOR SHARE (an athlete), the account FOR NO
 * KEY UPDATE, then the gym FOR SHARE. The account lock also queues one
 * person's saves, so the cap holds. The athlete and gym locks keep the email
 * store's order; a change committed just after a save would leave the same
 * row either way, which the next offer read clears and the sender re-checks.
 * True only if, under them, the login is active and not deleted, its
 * membership of this gym is active with a role of the same user type, the gym
 * is active (a gym not active refuses a switch-on, as email does), and an
 * athlete's linked record is live and 18 or over.
 *
 * A copy, not an import: lockPerson is not exported, and its file belongs to
 * W4-1's open PRs. Once they merge, an exported helper is to replace this, so
 * A5 (#2219) reaches the check under the locks too.
 */
async function stillOfferedUnderLock(
  client: PoolClient, subject: PushSubject, userType: EmailAlertUserType, now: Date,
): Promise<boolean> {
  const athleteId = userType === 'adult_athlete' ? subject.athleteId?.trim() || null : null;
  if (athleteId) {
    await client.query('select 1 from pilot.athletes where organization_id = $1 and athlete_id = $2 for share', [
      subject.organizationId, athleteId,
    ]);
  }
  await client.query('select 1 from pilot.accounts where account_id = $1 for no key update', [subject.accountId]);
  const gym = await client.query<{ status: string }>(
    'select status from pilot.organizations where organization_id = $1 for share', [subject.organizationId],
  );
  const member = await client.query<{ role: string }>(
    `select m.role
       from pilot.accounts a
       join pilot.organization_memberships m
         on m.account_id = a.account_id and m.organization_id = $2 and m.active_flag
      where a.account_id = $1 and a.active_flag and not ${accountDeletedSql('a')}`,
    [subject.accountId, subject.organizationId],
  );
  const role = member.rows[0]?.role;
  if (gym.rows[0]?.status !== 'active' || !role || emailAlertCandidateUserType(role) !== userType) return false;
  if (userType !== 'adult_athlete') return true;
  const athlete = athleteId
    ? await client.query<{ dob: string | null }>(LINKED_ATHLETE_DOB_SQL, [subject.organizationId, subject.accountId, athleteId])
    : { rows: [] };
  return athlete.rows[0] !== undefined && !isMinor(athlete.rows[0].dob, now);
}

/** Turns push on for this browser, for the caller, in this gym. */
export async function savePushBrowser(
  subject: PushSubject, body: unknown, env: PushSettings = process.env, now = new Date(),
): Promise<{ readonly on: true }> {
  const browser = parsePushBrowser(body);
  const userType = await emailAlertUserTypeFor(subject, now);
  if (!userType) await dropBrowsers(subject, now);
  if (!userType || !pushKeys(env)) throw new ForbiddenError(NOT_OFFERED);
  let saved = false;
  try {
    saved = await withTransaction(async (client) => {
      // Every save of one browser, in any gym, by anyone, queues here, even
      // when no row exists yet to lock. Only saves take it, and first.
      await client.query(`select pg_advisory_xact_lock(hashtext('push_browser:' || $1))`, [browser.endpoint]);
      if (!(await stillOfferedUnderLock(client, subject, userType, now))) return false;
      const moved = await client.query<{ organization_id: string; account_id: string }>(
        'delete from pilot.push_subscriptions where endpoint = $1 and account_id <> $2 returning organization_id, account_id',
        [browser.endpoint, subject.accountId],
      );
      // Audited in the gym that lost the row too (reviewers E and F on #2236),
      // with no actor: the caller may be of another gym, and an account id can
      // be a sign-in address. The caller's own row below counts the move.
      for (const lost of moved.rows) {
        await writePilotAuditEvent({
          event_type: 'update',
          actor_account_id: null,
          actor_role: null,
          organization_id: lost.organization_id,
          entity_type: 'push_browser',
          entity_id: lost.account_id,
          details: { push_browser: 'off', reason: 'turned_on_by_another_person' },
          shadow_mirror: false,
        }, client);
      }
      const mine = await client.query(
        'select 1 from pilot.push_subscriptions where endpoint = $1 and organization_id = $2',
        [browser.endpoint, subject.organizationId],
      );
      await client.query(
        `insert into pilot.push_subscriptions (organization_id, account_id, user_type, endpoint, key_p256dh, key_auth)
         values ($1, $2, $3, $4, $5, $6)
         on conflict on constraint pilot_push_subscription_endpoint_key do update
           set account_id = excluded.account_id, user_type = excluded.user_type,
               key_p256dh = excluded.key_p256dh, key_auth = excluded.key_auth, device_key_hash = null,
               saved_at = clock_timestamp()`,
        [subject.organizationId, subject.accountId, userType, browser.endpoint, browser.p256dh, browser.auth],
      );
      const dropped = await client.query(
        `delete from pilot.push_subscriptions where subscription_id in (
           select subscription_id from pilot.push_subscriptions
            where organization_id = $1 and account_id = $2
            order by saved_at desc, subscription_id desc offset $3)`,
        [subject.organizationId, subject.accountId, PUSH_BROWSERS_PER_PERSON],
      );
      const again = (mine.rowCount ?? 0) > 0;
      await audit(client, subject, again ? 'update' : 'create', {
        push_browser: again ? 'saved_again' : 'on',
        user_type: userType,
        moved_from_another_person: moved.rowCount ?? 0,
        oldest_dropped: dropped.rowCount ?? 0,
      });
      return true;
    });
  } catch (error) {
    // Defensive, as the email store's: the membership row deleted by a writer
    // that takes neither the account nor the gym row. The same answer as anyone not offered.
    const pgError = error as { code?: unknown; constraint?: unknown };
    if (pgError.code === '23503' && pgError.constraint === 'pilot_push_subscription_membership_fk') {
      throw new ForbiddenError(NOT_OFFERED);
    }
    // Two people at the cap, each taking the other's oldest browser at once,
    // can deadlock (reviewer E on #2236). Nothing was written; say so, as
    // guardianLoginMove.ts does, rather than a 500.
    if (pgError.code === '40P01') {
      throw new ConflictError('Conflict: this browser was being changed at the same moment. Nothing was saved; try again.');
    }
    throw error;
  }
  // Refused under the locks: nothing was written. Rows already held are left
  // to the next offer read, which clears them only if no longer offered.
  if (!saved) throw new ForbiddenError(NOT_OFFERED);
  return { on: true };
}

/** Turns push off for this browser, for the caller, in this gym. Always allowed: an opt-out is never refused. */
export async function removePushBrowser(subject: PushSubject, body: unknown): Promise<{ readonly on: false }> {
  const endpoint = parseEndpointBody(body);
  await withTransaction(async (client) => {
    const { rowCount } = await client.query(
      'delete from pilot.push_subscriptions where organization_id = $1 and account_id = $2 and endpoint = $3',
      [subject.organizationId, subject.accountId, endpoint],
    );
    if (rowCount) await audit(client, subject, 'update', { push_browser: 'off' });
  });
  return { on: false };
}
