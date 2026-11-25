/**
 * HOW MANY DAYS WITHOUT A PRESENT MARK PUT AN ATHLETE ON THE "WHO HAS STOPPED
 * COMING" LIST (lane W4-6, SC-0a; Jason's ruling OW27-30 A: a gym setting the
 * organization admin can change, first value 2 weeks).
 *
 * One number per gym, from pilot.organization_stopped_coming_policy. No row
 * means the ruled first value, 14 days. The value is one of a fixed list
 * (Overwatch, W4-6 Q1 A): the database CHECK holds the same list, so neither a
 * route bug nor a hand-written row can list every athlete (0 days) or none.
 *
 * This module only reads and writes the number. Who is listed is SC-1's.
 *
 * The list lives here and nowhere else. The gym admin's drawer takes it from
 * the GET's `choices`, so the browser never imports this module (it loads pg).
 *
 * WHO. Reading over HTTP: the gym admin only (Overwatch, W4-6 Q6 A); the
 * stopped-coming list carries the number in its own answer. Writing: the gym
 * admin only (isOrganizationAdminRole). The route applies both;
 * setStoppedComingPolicy checks the role again so a second caller cannot skip it.
 */

import { isOrganizationAdminRole } from './access';
import { writePilotAuditEvent } from './audit';
import type { PilotRole } from './contracts';
import { queryOne, withTransaction } from './db';
import { ForbiddenError, ValidationError } from './errors';

/** The days the gym admin may choose: 1, 2, 3, 4, 6 or 8 weeks. */
export const STOPPED_COMING_GAP_DAYS = [7, 14, 21, 28, 42, 56] as const;
export type StoppedComingGapDays = (typeof STOPPED_COMING_GAP_DAYS)[number];
/** OW27-30 A: "first value 2 weeks". */
export const DEFAULT_STOPPED_COMING_GAP_DAYS: StoppedComingGapDays = 14;

export function isStoppedComingGapDays(value: unknown): value is StoppedComingGapDays {
  return typeof value === 'number' && (STOPPED_COMING_GAP_DAYS as readonly number[]).includes(value);
}

export interface StoppedComingPolicy {
  readonly gap_days: StoppedComingGapDays;
  /** true when no gym admin has set it (or it was put back) and the default applies. */
  readonly is_default: boolean;
}

const DEFAULT_POLICY: StoppedComingPolicy = { gap_days: DEFAULT_STOPPED_COMING_GAP_DAYS, is_default: true };

export async function readStoppedComingPolicy(organizationId: string): Promise<StoppedComingPolicy> {
  const row = await queryOne<{ gap_days: number }>(
    'select gap_days from pilot.organization_stopped_coming_policy where organization_id = $1',
    [organizationId],
  );
  if (!row) return DEFAULT_POLICY;
  // The CHECK makes this unreachable; if it is ever reached, the stored value
  // is not one this module can stand behind, so it fails loudly rather than
  // guess which athletes to list.
  if (!isStoppedComingGapDays(row.gap_days)) {
    throw new Error('STOPPED_COMING_POLICY_INVALID_STORED_VALUE');
  }
  return { gap_days: row.gap_days, is_default: false };
}

/**
 * Sets the gym's number, or with `gapDays: null` deletes the row so the
 * default applies again ("Use the default"). Either way the change and its
 * audit row (old and new value) commit together.
 */
export async function setStoppedComingPolicy(input: {
  readonly organizationId: string;
  readonly actorAccountId: string;
  readonly actorRole: PilotRole;
  readonly gapDays: unknown;
}): Promise<StoppedComingPolicy> {
  if (!isOrganizationAdminRole(input.actorRole)) {
    throw new ForbiddenError('Forbidden: only the gym admin sets the stopped-coming days');
  }
  const gapDays = input.gapDays;
  if (gapDays !== null && !isStoppedComingGapDays(gapDays)) {
    throw new ValidationError(`Unsupported gap_days: choose one of ${STOPPED_COMING_GAP_DAYS.join(', ')}, or null for the default`);
  }

  return withTransaction(async (client) => {
    // Lock the gym's own row first: with no setting row yet there is nothing
    // for the select below to lock, and two first saves at once would both
    // audit "previous: none". FOR NO KEY UPDATE, as tabletIdlePolicy.ts does,
    // so inserts elsewhere that reference this gym are not held up.
    await client.query('select 1 from pilot.organizations where organization_id = $1 for no key update', [input.organizationId]);
    const before = await client.query<{ gap_days: number }>(
      `select gap_days from pilot.organization_stopped_coming_policy
        where organization_id = $1 for update`,
      [input.organizationId],
    );
    const previous = before.rows[0]?.gap_days ?? null;

    if (gapDays === null) {
      await client.query('delete from pilot.organization_stopped_coming_policy where organization_id = $1', [input.organizationId]);
    } else {
      await client.query(
        `insert into pilot.organization_stopped_coming_policy (organization_id, gap_days, set_by_account_id, set_at)
         values ($1, $2, $3, clock_timestamp())
         on conflict (organization_id) do update
           set gap_days = excluded.gap_days,
               set_by_account_id = excluded.set_by_account_id,
               set_at = excluded.set_at`,
        [input.organizationId, gapDays, input.actorAccountId],
      );
    }
    await writePilotAuditEvent({
      // 'update' either way (AUDIT_EVENT_TYPES has no delete); gap_days null says the row went.
      event_type: 'update',
      actor_account_id: input.actorAccountId,
      actor_role: input.actorRole,
      organization_id: input.organizationId,
      entity_type: 'organization_stopped_coming_policy',
      entity_id: input.organizationId,
      // gap_days null: the row was deleted and the default applies from now on.
      details: { gap_days: gapDays, previous_gap_days: previous },
      // A gym setting, not a person's record: nothing for SHADOW to learn from.
      shadow_mirror: false,
    }, client);
    return gapDays === null ? DEFAULT_POLICY : { gap_days: gapDays, is_default: false };
  });
}
