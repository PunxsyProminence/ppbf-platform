import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { GYM_TIME_ZONE } from '../../lib/gymTime';
import type { ActorIdentity } from './access';
import { getStaffDisplayName } from './achievements';
import { writePilotAuditEvent } from './audit';
import { query } from './db';
import { ConflictError } from './errors';

/**
 * THE "REACHED OUT" MARK on the stopped-coming page (lane W4-6, SC-3a-2; table
 * pilot.athlete_reached_out_marks, whose migration header quotes the rulings).
 * This module holds the table's SQL, the newer-or-stale rule and the marker's
 * name lookup. Who may call it, for which athlete (for a mark, one on the
 * list now), and that athlete's last day they came are stoppedComing.ts's
 * (Overwatch on #2163, answer A). Writes run on the caller's transaction
 * client.
 *
 * NEWER, NOT STALE (plan section 4): a mark counts only while its gym-local day
 * is after the athlete's last day they came (Overwatch on #2176 for a stale one).
 *
 * WHAT LEAVES: the marker's staff name at this gym (getStaffDisplayName, the
 * gated lookup every staff name uses) and the mark's gym-local day; a write
 * answers one outcome word. Never an account id. When the marker cannot be
 * named (a deleted account, one neither a member nor based here, no name on
 * record), by_name is null, never a stand-in such as "Your coach": an unknown value is
 * not shown as a name (AGENT_KERNEL, the floor: "an unknown value never looks
 * complete"), as painReportAlert.ts names a pain report's reviewer.
 *
 * by_role is the role the mark was made in, from the mark's own marked_by_role
 * (never looked up again): 'coach', or 'office' for an organization admin or
 * the legacy admin name. The page shows it only when there is no name, as
 * "by a coach" or "by the gym office" (lane W5-FU, F2; App Overwatch's answer
 * A on #2248). It is a role, not a name.
 */

/** The role a mark was made in, as the page words it: a coach, or the gym office. */
export type ReachedOutByRole = 'coach' | 'office';

export interface ReachedOut {
  /** The marker's staff name at this gym; null when they cannot be named. */
  readonly by_name: string | null;
  /** The role the mark was made in (marked_by_role): 'office' for organization_admin and admin. */
  readonly by_role: ReachedOutByRole;
  /** The gym-local day it was marked. */
  readonly on_day: string;
}

export type ReachedOutOutcome = 'marked' | 'already_marked' | 'taken_back' | 'not_marked';

/** The roles the table admits (pilot_athlete_reached_out_marks_role_check). */
export type ReachedOutMarkRole = 'coach' | 'organization_admin' | 'admin';

/** ISO days compare as text. No last day (never came): every mark is newer. */
function isNewer(onDay: string, lastCameDay: string | null): boolean {
  return lastCameDay === null || onDay > lastCameDay;
}

/** Each named athlete's current mark as the page shows it, by athlete id; none when absent or stale. */
export async function readCurrentReachedOut(
  organizationId: string,
  lastCameDays: ReadonlyMap<string, string | null>,
): Promise<Map<string, ReachedOut>> {
  const shown = new Map<string, ReachedOut>();
  if (lastCameDays.size === 0) return shown;
  const rows = await query<{
    athlete_id: string;
    marked_by_account_id: string | null;
    marked_by_role: ReachedOutMarkRole;
    on_day: string;
  }>(
    `select athlete_id, marked_by_account_id, marked_by_role,
            (marked_at at time zone $3)::date::text as on_day
       from pilot.athlete_reached_out_marks
      where organization_id = $1
        and athlete_id = any($2::text[])
        and cleared_at is null`,
    [organizationId, [...lastCameDays.keys()], GYM_TIME_ZONE],
  );
  // One lookup per distinct marker, as painReportAlert.ts names reviewers.
  const names = new Map<string, string | null>();
  for (const row of rows) {
    if (!isNewer(row.on_day, lastCameDays.get(row.athlete_id) ?? null)) continue;
    let byName: string | null = null;
    if (row.marked_by_account_id !== null) {
      byName = names.has(row.marked_by_account_id)
        ? names.get(row.marked_by_account_id) ?? null
        : await getStaffDisplayName(organizationId, row.marked_by_account_id);
      names.set(row.marked_by_account_id, byName);
    }
    shown.set(row.athlete_id, {
      by_name: byName,
      by_role: row.marked_by_role === 'coach' ? 'coach' : 'office',
      on_day: row.on_day,
    });
  }
  return shown;
}

interface Writer {
  client: PoolClient;
  actor: ActorIdentity;
  role: ReachedOutMarkRole;
  athleteId: string;
}

async function audit(w: Writer, eventType: 'create' | 'update', markId: string, details: Record<string, unknown>) {
  await writePilotAuditEvent({
    event_type: eventType,
    actor_account_id: w.actor.accountId,
    actor_role: w.role,
    organization_id: w.actor.organizationId,
    entity_type: 'athlete_reached_out_mark',
    entity_id: markId,
    details: { athlete_id: w.athleteId, ...details },
    shadow_mirror: false,
  }, w.client);
}

/**
 * Ends one current mark, naming who and how, audited. False when no row was
 * ended: under read committed a losing UPDATE answers rowCount 0, no error.
 */
async function endMark(w: Writer, markId: string, kind: 'taken_back' | 'replaced'): Promise<boolean> {
  const ended = await w.client.query(
    `update pilot.athlete_reached_out_marks
        set cleared_at = clock_timestamp(), cleared_by_account_id = $3, cleared_kind = $4
      where organization_id = $1 and mark_id = $2::uuid and cleared_at is null`,
    [w.actor.organizationId, markId, w.actor.accountId, kind],
  );
  if (ended.rowCount !== 1) return false;
  await audit(w, 'update', markId, { action: 'clear', cleared_kind: kind });
  return true;
}

/** Inserts a current mark, audited; false when another current mark already holds the athlete. */
async function insertMark(w: Writer): Promise<boolean> {
  const markId = randomUUID();
  const inserted = await w.client.query(
    `insert into pilot.athlete_reached_out_marks
       (organization_id, mark_id, athlete_id, marked_by_account_id, marked_by_role)
     values ($1, $2::uuid, $3, $4, $5)
     on conflict (organization_id, athlete_id) where cleared_at is null do nothing`,
    [w.actor.organizationId, markId, w.athleteId, w.actor.accountId, w.role],
  );
  if (inserted.rowCount !== 1) return false;
  await audit(w, 'create', markId, {});
  return true;
}

/**
 * Marks (`reachedOut` true) or takes back (false) on the caller's transaction, `role` and
 * `lastCameDay` read there. A newer current mark stands; a stale one is ended as 'replaced' and
 * the new mark inserted; only a newer one is taken back. Each write is audited ('create', or
 * 'update' with action 'clear' and cleared_kind), shadow_mirror false, as rest marks are. The mark
 * row is locked first, so a second coach at once waits and reads the first's result.
 */
export async function setReachedOutMark(client: PoolClient, input: {
  actor: ActorIdentity;
  role: ReachedOutMarkRole;
  athleteId: string;
  lastCameDay: string | null;
  reachedOut: boolean;
}): Promise<ReachedOutOutcome> {
  const { actor, athleteId } = input;
  const w: Writer = { client, actor, role: input.role, athleteId };
  const locked = await client.query<{ mark_id: string; on_day: string }>(
    `select mark_id::text as mark_id, (marked_at at time zone $3)::date::text as on_day
       from pilot.athlete_reached_out_marks
      where organization_id = $1 and athlete_id = $2 and cleared_at is null
        for update`,
    [actor.organizationId, athleteId, GYM_TIME_ZONE],
  );
  const current = locked.rows[0] ?? null;
  const newer = current !== null && isNewer(current.on_day, input.lastCameDay);

  if (!input.reachedOut) {
    if (!current || !newer) return 'not_marked';
    return (await endMark(w, current.mark_id, 'taken_back')) ? 'taken_back' : 'not_marked';
  }
  if (current && newer) return 'already_marked';
  if (current) {
    // Both halves or neither: the throw rolls the caller's transaction back.
    if (!(await endMark(w, current.mark_id, 'replaced')) || !(await insertMark(w))) {
      throw new ConflictError('The reached-out mark changed while it was being saved. Reload and try again.', 'REACHED_OUT_MARK_CHANGED');
    }
    return 'marked';
  }
  return (await insertMark(w)) ? 'marked' : 'already_marked';
}
