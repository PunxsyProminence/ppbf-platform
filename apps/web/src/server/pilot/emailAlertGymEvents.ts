/**
 * THE GYM'S CHOICE OF WHICH EVENTS SEND THE EMAIL ALERT (lane W4-1, EM-5).
 *
 * OW27-10 A: the gym's organization admin chooses, for each user type (staff,
 * parents, athletes 18 or over), which events can send the email. OW27-39 A:
 * every event starts ticked; each person's own switch (EM-1) still starts off.
 *
 * Rows of pilot.organization_email_alert_events hold the admin's choices; a
 * (user type, event) pair with no row is ticked. The list of events per user
 * type is src/shared/emailAlerts.ts EMAIL_ALERT_EVENTS: a stored row for an
 * event no longer on the list is ignored, and a write for one is refused.
 *
 * WHO. Reading and writing: the organization admin only ('admin' by alias).
 * The route applies requireRole; setGymEmailAlertEvent checks the role again so
 * a second caller cannot skip it. The sender (EM-3, not yet built) reads
 * isGymEmailAlertEventTicked with no person attached.
 *
 * Each change writes one audit row (user type, event, ticked before and after)
 * in the same transaction. No person data is stored or audited here.
 */

import {
  EMAIL_ALERT_EVENTS,
  EMAIL_ALERT_USER_TYPES,
  isEmailAlertEventFor,
  type EmailAlertEventKind,
  type EmailAlertUserType,
} from '@/src/shared/emailAlerts';

import { isOrganizationAdminRole } from './access';
import { writePilotAuditEvent } from './audit';
import type { PilotRole } from './contracts';
import { query, queryOne, withTransaction } from './db';
import { ForbiddenError, ValidationError } from './errors';

export interface GymEmailAlertEvent {
  readonly user_type: EmailAlertUserType;
  readonly event_kind: EmailAlertEventKind;
  readonly ticked: boolean;
  /** true when no admin has chosen and the starting value (ticked) applies. */
  readonly is_default: boolean;
}

/** Every event on every user type's list, in list order, with the gym's choice. */
export async function readGymEmailAlertEvents(organizationId: string): Promise<GymEmailAlertEvent[]> {
  const rows = await query<{ user_type: string; event_kind: string; ticked: boolean }>(
    `select user_type, event_kind, ticked
       from pilot.organization_email_alert_events
      where organization_id = $1`,
    [organizationId],
  );
  const chosen = new Map(rows.map((row) => [`${row.user_type}:${row.event_kind}`, row.ticked]));
  return EMAIL_ALERT_USER_TYPES.flatMap((userType) => EMAIL_ALERT_EVENTS[userType].map((eventKind) => {
    const choice = chosen.get(`${userType}:${eventKind}`);
    return { user_type: userType, event_kind: eventKind, ticked: choice ?? true, is_default: choice === undefined };
  }));
}

/**
 * Whether this gym sends this event to this user type. An event not on the
 * user type's list is never sent, whatever is stored.
 */
export async function isGymEmailAlertEventTicked(
  organizationId: string,
  userType: EmailAlertUserType,
  eventKind: string,
): Promise<boolean> {
  if (!isEmailAlertEventFor(userType, eventKind)) return false;
  const row = await queryOne<{ ticked: boolean }>(
    `select ticked from pilot.organization_email_alert_events
      where organization_id = $1 and user_type = $2 and event_kind = $3`,
    [organizationId, userType, eventKind],
  );
  return row ? row.ticked : true;
}

export async function setGymEmailAlertEvent(input: {
  readonly organizationId: string;
  readonly actorAccountId: string;
  readonly actorRole: PilotRole;
  readonly userType: unknown;
  readonly eventKind: unknown;
  readonly ticked: unknown;
}): Promise<GymEmailAlertEvent> {
  if (!isOrganizationAdminRole(input.actorRole)) {
    throw new ForbiddenError('Forbidden: only the gym admin chooses which events send email alerts');
  }
  if (!isEmailAlertEventFor(input.userType, input.eventKind)) {
    throw new ValidationError('Unsupported user_type and event_kind: choose an event on that user type\'s list');
  }
  if (typeof input.ticked !== 'boolean') {
    throw new ValidationError('ticked must be true or false');
  }
  const userType = input.userType as EmailAlertUserType;
  const eventKind = input.eventKind as EmailAlertEventKind;
  const ticked = input.ticked;

  return withTransaction(async (client) => {
    // Lock the gym's own row first: with no choice row yet there is nothing
    // for the select below to lock, and two first saves at once would race on
    // the insert. FOR NO KEY UPDATE, so other inserts that reference the gym
    // are not held up (tabletIdlePolicy.ts's rule).
    await client.query('select 1 from pilot.organizations where organization_id = $1 for no key update', [input.organizationId]);
    const before = await client.query<{ ticked: boolean }>(
      `select ticked from pilot.organization_email_alert_events
        where organization_id = $1 and user_type = $2 and event_kind = $3
        for update`,
      [input.organizationId, userType, eventKind],
    );
    await client.query(
      `insert into pilot.organization_email_alert_events
         (organization_id, user_type, event_kind, ticked, set_by_account_id, set_at)
       values ($1, $2, $3, $4, $5, clock_timestamp())
       on conflict (organization_id, user_type, event_kind) do update
         set ticked = excluded.ticked,
             set_by_account_id = excluded.set_by_account_id,
             set_at = excluded.set_at`,
      [input.organizationId, userType, eventKind, ticked, input.actorAccountId],
    );
    const previous = before.rows[0];
    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: input.actorAccountId,
      actor_role: input.actorRole,
      organization_id: input.organizationId,
      entity_type: 'organization_email_alert_event',
      entity_id: `${input.organizationId}:${userType}:${eventKind}`,
      details: {
        user_type: userType,
        event_kind: eventKind,
        ticked,
        previous_ticked: previous ? previous.ticked : true,
        previous_was_default: !previous,
      },
      // A gym setting, not a person's record: nothing for SHADOW to learn from.
      shadow_mirror: false,
    }, client);
    return { user_type: userType, event_kind: eventKind, ticked, is_default: false };
  });
}
