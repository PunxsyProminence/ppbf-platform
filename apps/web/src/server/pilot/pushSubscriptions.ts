/**
 * EACH PERSON'S WEB PUSH BROWSERS (lane W5-WP, WP-1b; plan, answers and GO on
 * #2228). Reads and writes the caller's own rows of pilot.push_subscriptions
 * (WP-1a), one per browser per gym.
 *
 * WHO. Push follows the email alert's settings (OW27-18 A), so it is offered
 * to exactly the people the email switch is offered to: emailAlertUserTypeFor
 * (coach, admin, organization admin, parents, and athletes 18 or over; no date
 * of birth counts as a minor, OD-2026-10-04-010). Anyone else is not offered
 * push, and any browser rows they still hold are removed at their next read or
 * save. A device marked as a gym tablet never offers push (OW27-17 B); the mark
 * lives only in that browser (gymTabletMark.ts), so the screen keeps that rule
 * (src/lib/pushOffer.ts), not this module.
 *
 * FAIL CLOSED. Push is offered only when the three push settings are present
 * and shaped as web-push 3.6.7 requires (its src/vapid-helper.js): no keys, no
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

import type { PoolClient } from 'pg';

import { writePilotAuditEvent } from './audit';
import { queryOne, withTransaction } from './db';
import { emailAlertUserTypeFor, type EmailAlertSwitchSubject } from './emailAlertSwitches';
import { ForbiddenError, ValidationError } from './errors';

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

function decodedLength(value: string): number {
  return BASE64URL.test(value) ? Buffer.from(value, 'base64url').length : -1;
}

/**
 * The push settings' public key, only when all three are set and shaped as
 * web-push 3.6.7 checks them: a base64url public key of 65 bytes, a private key
 * of 32 bytes, and an https: or mailto: subject. The private key is checked,
 * never returned.
 */
export function pushKeys(env: PushSettings = process.env): { readonly publicKey: string } | null {
  const publicKey = env.PPBF_WEB_PUSH_VAPID_PUBLIC_KEY?.trim() ?? '';
  const privateKey = env.PPBF_WEB_PUSH_VAPID_PRIVATE_KEY?.trim() ?? '';
  const subject = env.PPBF_WEB_PUSH_SUBJECT?.trim() ?? '';
  if (decodedLength(publicKey) !== 65 || decodedLength(privateKey) !== 32) return null;
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
  const key = typeof value === 'string' ? value.replace(/=+$/, '') : '';
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

/** Removes every browser row the caller holds in this gym, audited, when they are no longer offered push. */
async function dropBrowsers(subject: PushSubject): Promise<void> {
  await withTransaction(async (client) => {
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
    await dropBrowsers(subject);
    return { offered: false };
  }
  const keys = pushKeys(env);
  return keys ? { offered: true, public_key: keys.publicKey } : { offered: false };
}

async function offeredUserType(subject: PushSubject, env: PushSettings, now: Date) {
  const userType = await emailAlertUserTypeFor(subject, now);
  if (!userType) await dropBrowsers(subject);
  if (!userType || !pushKeys(env)) throw new ForbiddenError(NOT_OFFERED);
  return userType;
}

/** Whether this browser is on for the caller in this gym. */
export async function isPushOnHere(
  subject: PushSubject, body: unknown, env: PushSettings = process.env, now = new Date(),
): Promise<{ readonly on: boolean }> {
  const endpoint = parseEndpointBody(body);
  await offeredUserType(subject, env, now);
  const row = await queryOne<{ on: boolean }>(
    `select true as on from pilot.push_subscriptions
      where organization_id = $1 and account_id = $2 and endpoint = $3`,
    [subject.organizationId, subject.accountId, endpoint],
  );
  return { on: row?.on === true };
}

/** Turns push on for this browser, for the caller, in this gym. */
export async function savePushBrowser(
  subject: PushSubject, body: unknown, env: PushSettings = process.env, now = new Date(),
): Promise<{ readonly on: true }> {
  const browser = parsePushBrowser(body);
  const userType = await offeredUserType(subject, env, now);
  try {
    await withTransaction(async (client) => {
      // Every save of one browser, in any gym, by anyone, queues here, even
      // when no row exists yet to lock.
      await client.query(`select pg_advisory_xact_lock(hashtext('push_browser:' || $1))`, [browser.endpoint]);
      const moved = await client.query(
        'delete from pilot.push_subscriptions where endpoint = $1 and account_id <> $2',
        [browser.endpoint, subject.accountId],
      );
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
    });
  } catch (error) {
    // The caller's membership of this gym went while saving: the same answer as anyone not offered.
    const pgError = error as { code?: unknown; constraint?: unknown };
    if (pgError.code === '23503' && pgError.constraint === 'pilot_push_subscription_membership_fk') {
      throw new ForbiddenError(NOT_OFFERED);
    }
    throw error;
  }
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
