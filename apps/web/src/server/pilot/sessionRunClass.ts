import type { PoolClient } from 'pg';

import { gymDayIso } from '../../lib/gymTime';
import { type ActorIdentity, actorRunsClass, isOrganizationAdminRole } from './access';
import { writePilotAuditEvent } from './audit';
import {
  type SchedulerClass,
  isRegisteredForClass,
  lockSchedulerClass,
  undoSessionRegisterPresent,
  writeSessionRegisterPresent,
} from './schedulerDb';
import type { StaffNoteRole } from './sessionStaffNotes';

// A LIVE SESSION TIED TO THE SCHEDULED CLASS IT IS RUNNING (D4, OD-2026-10-21-002, Jason: "A: Tie
// them (Rec.)"; details OD-2026-10-21-004), so a coach enters attendance once: a "here" tap on a
// tied session also writes the class register. Columns: pilot_slice_postgres_session_run_class_migration.sql
// (session_script_runs.class_id; session_run_athletes.register_class_id / register_written_at).
// Every register statement is in schedulerDb.ts, the register's one writer.
//
//   tie       at start (sessionScriptRuns.ts), to TODAY's class (the gym's day, gymDayIso, never
//             delivered_on), not cancelled, that the coach teaches, scheduled or covers; an
//             organization admin any such class. One live session per class
//             (pilot_ssrun_one_live_per_class).
//   tap here  no register mark: Present, undoable; Present already: nothing; Absent or Excused:
//             Present, and the coach is told what it was (ruling 1). The class cancelled since, or
//             the coach no longer running it: the session mark stands, the register is skipped and
//             the coach is told. A later register change wins: a standing mark is never re-copied.
//   untap     the register mark the tap created is removed only if nobody changed it since, and
//             the removal is audited (ruling 2).
// An UNTIED (open gym) session writes no register: its marks stay session detail (OD-2026-10-13-016).
// Session auto-close finishes runs and never comes here, so it never writes the register.
//
// LOCK ORDER, one way only: staff membership, run, athlete, session mark, class, register row.

export class SessionRunClassError extends Error {
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = 'SessionRunClassError';
    this.status = status;
  }
}

/** What a coach reads for each refusal (wording PROPOSED); `error` stays the code. */
export const SESSION_CLASS_MESSAGES: ReadonlyMap<string, string> = new Map([
  ['SESSION_CLASS_NOT_FOUND', 'That class is not on the schedule.'],
  ['SESSION_CLASS_NOT_YOURS', 'Only the coach, cover or scheduler of this class, or an admin, can run its register.'],
  ['SESSION_CLASS_CANCELLED', 'This class was cancelled.'],
  ['SESSION_CLASS_NOT_TODAY', "A session can only be tied to one of today's classes."],
  ['SESSION_CLASS_ALREADY_LIVE', 'Another live session is already running this class. Start without a class, or ask that coach to end theirs.'],
]);

type Tier = Pick<ActorIdentity, 'organizationId' | 'accountId' | 'role'>;

/** Inside the caller's transaction: the class, share-locked, if this actor may tie a session to it now. */
export async function lockTieableClass(client: PoolClient, actor: Tier, classId: string, now = new Date()): Promise<SchedulerClass> {
  const item = await lockSchedulerClass(client, actor.organizationId, classId);
  if (!item) throw new SessionRunClassError('SESSION_CLASS_NOT_FOUND', 404);
  if (!isOrganizationAdminRole(actor.role) && !actorRunsClass(actor, item)) {
    throw new SessionRunClassError('SESSION_CLASS_NOT_YOURS', 403);
  }
  if (item.status === 'cancelled') throw new SessionRunClassError('SESSION_CLASS_CANCELLED', 409);
  if (gymDayIso(item.start_at) !== gymDayIso(now)) throw new SessionRunClassError('SESSION_CLASS_NOT_TODAY', 409);
  return item;
}

export type RegisterResult =
  | { effect: 'created' | 'already_present' | 'removed' | 'kept' }
  | { effect: 'flipped'; previous_status: 'absent' | 'excused' }
  | { effect: 'skipped'; reason: 'class_cancelled' | 'not_your_class' };

interface TapOnRegister {
  organizationId: string;
  runId: string;
  classId: string;
  athleteId: string;
  accountId: string;
  /** The staff role held now (lockStaffMembership). */
  role: StaffNoteRole;
}

function auditRegister(client: PoolClient, tap: TapOnRegister, result: RegisterResult) {
  return writePilotAuditEvent(
    {
      event_type: result.effect === 'created' ? 'create' : 'update',
      actor_account_id: tap.accountId,
      actor_role: tap.role,
      organization_id: tap.organizationId,
      entity_type: 'scheduler_attendance',
      entity_id: `${tap.classId}:${tap.athleteId}`,
      details: { via: 'session_run', run_id: tap.runId, class_id: tap.classId, athlete_id: tap.athleteId, ...result },
      // Staff only, as the session mark is (sessionRunAthletes.ts gives the reason).
      shadow_mirror: false,
    },
    client,
  );
}

/** A "here" tap on a tied session: the register, after the session mark is written and locked. */
export async function copyTapToRegister(client: PoolClient, tap: TapOnRegister): Promise<RegisterResult> {
  const item = await lockSchedulerClass(client, tap.organizationId, tap.classId);
  if (!item || item.status === 'cancelled') return { effect: 'skipped', reason: 'class_cancelled' };
  if (!isOrganizationAdminRole(tap.role) && !actorRunsClass({ accountId: tap.accountId }, item)) {
    return { effect: 'skipped', reason: 'not_your_class' };
  }
  const registered = await isRegisteredForClass(client, tap.organizationId, tap.classId, tap.athleteId);
  const written = await writeSessionRegisterPresent(
    client,
    tap.organizationId,
    {
      class_id: tap.classId,
      athlete_id: tap.athleteId,
      // No new marking method: the ones the register already uses for this marker.
      method: !registered ? 'walk_in' : isOrganizationAdminRole(tap.role) ? 'admin_override' : 'coach_override',
      checked_in_by_role: tap.role,
      checked_in_by_account_id: tap.accountId,
    },
    new Date().toISOString(),
  );
  if (written.effect === 'created') {
    await client.query(
      `update pilot.session_run_athletes
          set register_class_id = $4, register_written_at = $5::timestamptz
        where organization_id = $1 and run_id = $2 and athlete_id = $3`,
      [tap.organizationId, tap.runId, tap.athleteId, tap.classId, written.updated_at],
    );
  }
  const result: RegisterResult = written.effect === 'flipped'
    ? { effect: 'flipped', previous_status: written.previous_status }
    : { effect: written.effect };
  if (result.effect !== 'already_present') await auditRegister(client, tap, result);
  return result;
}

/** An untap: take back the register mark this session mark created, if unchanged (ruling 2). */
export async function undoTapOnRegister(
  client: PoolClient,
  tap: TapOnRegister,
  writtenAt: string,
): Promise<RegisterResult> {
  await lockSchedulerClass(client, tap.organizationId, tap.classId);
  const removed = await undoSessionRegisterPresent(client, tap.organizationId, {
    class_id: tap.classId,
    athlete_id: tap.athleteId,
    written_at: writtenAt,
    account_id: tap.accountId,
  });
  const result: RegisterResult = { effect: removed ? 'removed' : 'kept' };
  if (removed) await auditRegister(client, tap, result);
  return result;
}
