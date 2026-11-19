/**
 * HOW LONG A GYM TABLET MAY SIT IDLE BEFORE IT SIGNS ITSELF OUT
 * (lane U1, AS2-a; Jason's ruling OW25-53 A: the gym admin sets it in gym
 * settings, first value 1 hour).
 *
 * One number per gym, from pilot.organization_tablet_idle_policy. No row means
 * the ruled default, 60 minutes. The value is one of a fixed list (Overwatch
 * Q3): the database CHECK holds the same list, so neither a route bug nor a
 * hand-written row can set a tablet to sign out mid-round.
 *
 * This module only reads and writes the number. Which device is a gym tablet,
 * the countdown and the sign-out are the browser's (lane U1, AS2-b).
 *
 * WHO. Reading: any signed-in member of the gym, because the tablet asks with
 * whoever is signed in on it, athletes included; the answer is one number and
 * says nothing about a person. Writing: the gym admin only
 * (isOrganizationAdminRole). The route applies both; setTabletIdlePolicy
 * checks the role again so a second caller cannot skip it.
 */

import { isOrganizationAdminRole } from './access';
import { writePilotAuditEvent } from './audit';
import type { PilotRole } from './contracts';
import { queryOne, withTransaction } from './db';
import { ForbiddenError, ValidationError } from './errors';

export const TABLET_IDLE_MINUTES = [15, 30, 60, 120, 240] as const;
export type TabletIdleMinutes = (typeof TABLET_IDLE_MINUTES)[number];
export const DEFAULT_TABLET_IDLE_MINUTES: TabletIdleMinutes = 60;

export interface TabletIdlePolicy {
  readonly idle_minutes: TabletIdleMinutes;
  /** true when no gym admin has set it and the default applies. */
  readonly is_default: boolean;
}

export function isTabletIdleMinutes(value: unknown): value is TabletIdleMinutes {
  return typeof value === 'number' && (TABLET_IDLE_MINUTES as readonly number[]).includes(value);
}

export async function readTabletIdlePolicy(organizationId: string): Promise<TabletIdlePolicy> {
  const row = await queryOne<{ idle_minutes: number }>(
    'select idle_minutes from pilot.organization_tablet_idle_policy where organization_id = $1',
    [organizationId],
  );
  if (!row) return { idle_minutes: DEFAULT_TABLET_IDLE_MINUTES, is_default: true };
  // The CHECK makes this unreachable; if it is ever reached, the stored value
  // is not one this module can stand behind, so it fails loudly rather than
  // guess a time for a shared tablet.
  if (!isTabletIdleMinutes(row.idle_minutes)) {
    throw new Error('TABLET_IDLE_POLICY_INVALID_STORED_VALUE');
  }
  return { idle_minutes: row.idle_minutes, is_default: false };
}

export async function setTabletIdlePolicy(input: {
  readonly organizationId: string;
  readonly actorAccountId: string;
  readonly actorRole: PilotRole;
  readonly idleMinutes: unknown;
}): Promise<TabletIdlePolicy> {
  if (!isOrganizationAdminRole(input.actorRole)) {
    throw new ForbiddenError('Forbidden: only the gym admin sets the gym tablet sign-out time');
  }
  if (!isTabletIdleMinutes(input.idleMinutes)) {
    throw new ValidationError(`Unsupported idle_minutes: choose one of ${TABLET_IDLE_MINUTES.join(', ')}`);
  }
  const idleMinutes = input.idleMinutes;

  return withTransaction(async (client) => {
    // Lock the gym's own row first: with no setting row yet there is nothing
    // for the select below to lock, and two first saves at once would both
    // audit "previous: none".
    await client.query('select 1 from pilot.organizations where organization_id = $1 for update', [input.organizationId]);
    const before = await client.query<{ idle_minutes: number }>(
      `select idle_minutes from pilot.organization_tablet_idle_policy
        where organization_id = $1 for update`,
      [input.organizationId],
    );
    await client.query(
      `insert into pilot.organization_tablet_idle_policy (organization_id, idle_minutes, set_by_account_id, set_at)
       values ($1, $2, $3, clock_timestamp())
       on conflict (organization_id) do update
         set idle_minutes = excluded.idle_minutes,
             set_by_account_id = excluded.set_by_account_id,
             set_at = excluded.set_at`,
      [input.organizationId, idleMinutes, input.actorAccountId],
    );
    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: input.actorAccountId,
      actor_role: input.actorRole,
      organization_id: input.organizationId,
      entity_type: 'organization_tablet_idle_policy',
      entity_id: input.organizationId,
      details: {
        idle_minutes: idleMinutes,
        previous_idle_minutes: before.rows[0]?.idle_minutes ?? null,
      },
      // A gym setting, not a person's record: nothing for SHADOW to learn from.
      shadow_mirror: false,
    }, client);
    return { idle_minutes: idleMinutes, is_default: false };
  });
}
