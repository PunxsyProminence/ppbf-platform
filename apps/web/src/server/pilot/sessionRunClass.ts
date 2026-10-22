import type { PoolClient } from 'pg';

import { gymDayIso } from '../../lib/gymTime';
import { type ActorIdentity, actorRunsClass, isOrganizationAdminRole } from './access';
import { writePilotAuditEvent } from './audit';
import { query, withTransaction } from './db';
import {
  type SchedulerClass,
  countClassNoShows,
  getSchedulerClassById,
  isRegisteredForClass,
  lockSchedulerClass,
  markClassNoShowsAbsent,
  undoSessionRegisterPresent,
  writeSessionRegisterPresent,
} from './schedulerDb';
import { lockStaffMembership, type StaffNoteRole } from './sessionStaffNotes';

// A LIVE SESSION TIED TO THE SCHEDULED CLASS IT IS RUNNING (D4, OD-2026-10-21-002, Jason: "A: Tie
// them (Rec.)"; details OD-2026-10-21-004), so a coach enters attendance once: a "here" tap on a
// tied session also writes the class register. Columns: pilot_slice_postgres_session_run_class_migration.sql
// (session_script_runs.class_id; session_run_athletes.register_class_id / register_written_at).
// Every register statement is in schedulerDb.ts, the register's one writer.
//
//   tie       at start (sessionScriptRuns.ts) or while live (setSessionRunClass), to TODAY's class
//             (the gym's day, gymDayIso, never delivered_on), not cancelled, that the coach
//             teaches, scheduled or covers; an organization admin any such class. One live session
//             per class (pilot_ssrun_one_live_per_class). Tying mid-session copies the standing marks.
//   untie     the register marks stay; they stop being the session's to undo (pointers cleared).
//   tap here  no register mark: Present, undoable; Present already: nothing; Absent or Excused:
//             Present, and the coach is told what it was (ruling 1). The class cancelled since, or
//             the coach no longer running it: the session mark stands, the register is skipped and
//             the coach is told. A later register change wins: a standing mark is never re-copied.
//   untap     the register mark the tap created is removed only if nobody changed it since, and
//             the removal is audited (ruling 2); a mark the tap did not create is left alone
//             ('unchanged', so the coach can be told the register still stands).
//   no-shows  at End Session, one tap by the coach marks Absent every signed-up athlete with no
//             mark (ruling 3, "A: Offer it (Rec.)"); never automatic (markSessionNoShowsAbsent).
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
  ['SESSION_RUN_NOT_TIED', 'This session is not tied to a class, so there is no class register to mark.'],
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
  // 'unchanged': an untap on a tied session whose tap created no register mark (it was Present
  // already, or turned Absent/Excused into Present, or was skipped); the register is left as it is.
  | { effect: 'created' | 'already_present' | 'removed' | 'kept' | 'unchanged' | 'no_show_absent' }
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
  if (result.effect === 'created' || result.effect === 'flipped') await auditRegister(client, tap, result);
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

/** Inside a write's transaction: the actor's own live run, locked, with the codes sessionScriptRuns.ts uses. */
async function lockOwnLiveRun(client: PoolClient, actor: ActorIdentity, runId: string): Promise<{ class_id: string | null }> {
  const { rows } = await client.query<{ delivered_by_account_id: string; run_state: string | null; class_id: string | null }>(
    `select delivered_by_account_id, run_state, class_id from pilot.session_script_runs
      where organization_id = $1 and run_id = $2
        for update`,
    [actor.organizationId, runId],
  );
  const owned = rows[0];
  // Another coach's run reads exactly like a missing one.
  if (!owned || owned.delivered_by_account_id !== actor.accountId) throw new SessionRunClassError('SESSION_RUN_NOT_FOUND', 404);
  if (owned.run_state !== 'in_progress') throw new SessionRunClassError('SESSION_RUN_NOT_LIVE', 409);
  return { class_id: owned.class_id };
}

/** The athletes whose mark stands in this run, ids only: what a tie copies and the no-shows tap skips. */
async function standingMarkIds(client: Pick<PoolClient, 'query'>, organizationId: string, runId: string, lock: boolean): Promise<string[]> {
  const { rows } = await client.query<{ athlete_id: string }>(
    `select m.athlete_id
       from pilot.session_run_athletes m
       join pilot.athletes a on a.organization_id = m.organization_id and a.athlete_id = m.athlete_id
      where m.organization_id = $1 and m.run_id = $2 and m.removed_at is null and a.deleted_at is null
      order by m.athlete_id${lock ? ' for update of m for share of a' : ''}`,
    [organizationId, runId],
  );
  return rows.map((row) => row.athlete_id);
}

export interface TieOutcome {
  class_id: string | null;
  /** Tying mid-session: what each standing mark did to the register. */
  copied: Array<{ athlete_id: string } & RegisterResult>;
}

/**
 * Tie the actor's own live session to a class, or untie it (classId null). Untying, or tying to a
 * different class, leaves the register marks in place and clears the session's claim to undo them.
 */
export async function setSessionRunClass(actor: ActorIdentity, runId: string, classId: string | null): Promise<TieOutcome> {
  return withTransaction(async (client) => {
    const role = await lockStaffMembership(client, actor);
    if (!role) throw new SessionRunClassError('SESSION_RUN_NOT_FOUND', 404);
    const owned = await lockOwnLiveRun(client, actor, runId);
    if (owned.class_id === classId) return { class_id: classId, copied: [] };

    // The lock order: run, then the marks (and their athletes), then the class, then the register.
    const standing = await standingMarkIds(client, actor.organizationId, runId, true);
    await client.query(
      `update pilot.session_run_athletes set register_class_id = null, register_written_at = null
        where organization_id = $1 and run_id = $2 and register_class_id is not null`,
      [actor.organizationId, runId],
    );
    if (classId) await lockTieableClass(client, { ...actor, role }, classId);
    try {
      await client.query(
        `update pilot.session_script_runs set class_id = $3 where organization_id = $1 and run_id = $2`,
        [actor.organizationId, runId, classId],
      );
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'pilot_ssrun_one_live_per_class') {
        throw new SessionRunClassError('SESSION_CLASS_ALREADY_LIVE', 409);
      }
      throw error;
    }
    await writePilotAuditEvent(
      {
        event_type: 'update',
        actor_account_id: actor.accountId,
        actor_role: role,
        organization_id: actor.organizationId,
        entity_type: 'session_script_run',
        entity_id: runId,
        details: { run_id: runId, class_id: classId, previous_class_id: owned.class_id },
        shadow_mirror: false,
      },
      client,
    );

    const copied: TieOutcome['copied'] = [];
    if (classId) {
      for (const athleteId of standing) {
        const tap = { organizationId: actor.organizationId, runId, classId, athleteId, accountId: actor.accountId, role };
        copied.push({ athlete_id: athleteId, ...(await copyTapToRegister(client, tap)) });
      }
    }
    return { class_id: classId, copied };
  });
}

/**
 * The End Session no-shows tap on the actor's own live tied session (ruling 3): every athlete
 * signed up for the class with no register mark and no standing mark here becomes Absent, each
 * audited. The class is re-checked under its lock, as for a tap.
 */
export async function markSessionNoShowsAbsent(actor: ActorIdentity, runId: string): Promise<{ marked: string[] }> {
  return withTransaction(async (client) => {
    const role = await lockStaffMembership(client, actor);
    if (!role) throw new SessionRunClassError('SESSION_RUN_NOT_FOUND', 404);
    const { class_id: classId } = await lockOwnLiveRun(client, actor, runId);
    if (!classId) throw new SessionRunClassError('SESSION_RUN_NOT_TIED', 409);
    const standing = await standingMarkIds(client, actor.organizationId, runId, false);
    const item = await lockSchedulerClass(client, actor.organizationId, classId);
    if (!item || item.status === 'cancelled') throw new SessionRunClassError('SESSION_CLASS_CANCELLED', 409);
    if (!isOrganizationAdminRole(role) && !actorRunsClass(actor, item)) throw new SessionRunClassError('SESSION_CLASS_NOT_YOURS', 403);
    const marked = await markClassNoShowsAbsent(
      client,
      actor.organizationId,
      {
        class_id: classId,
        method: isOrganizationAdminRole(role) ? 'admin_override' : 'coach_override',
        checked_in_by_role: role,
        checked_in_by_account_id: actor.accountId,
      },
      standing,
      new Date().toISOString(),
    );
    for (const athleteId of marked) {
      const tap = { organizationId: actor.organizationId, runId, classId, athleteId, accountId: actor.accountId, role };
      await auditRegister(client, tap, { effect: 'no_show_absent' });
    }
    return { marked };
  });
}

/** The class a live run is tied to, as the live screen names it, and how many no-shows the tap would mark now. */
export async function describeRunClass(organizationId: string, runId: string, classId: string) {
  const item = await getSchedulerClassById(organizationId, classId);
  if (!item) return null;
  const reader = { query: async (text: string, values?: unknown[]) => ({ rows: await query(text, values) }) };
  const standing = await standingMarkIds(reader as unknown as Pick<PoolClient, 'query'>, organizationId, runId, false);
  return {
    class_id: item.class_id,
    title: item.title,
    start_at: item.start_at,
    end_at: item.end_at,
    status: item.status,
    no_shows: await countClassNoShows(organizationId, classId, standing),
  };
}

export interface TieableClass {
  class_id: string;
  title: string;
  start_at: string;
  end_at: string;
  /** A live session other than the caller's already runs it (one live session per class). */
  held_by_other_session: boolean;
}

/** Today's classes (the gym's day) this actor may tie a session to, earliest first: the start picker. */
export async function listTieableClasses(actor: Tier, now = new Date()): Promise<TieableClass[]> {
  const rows = await query<SchedulerClass & { held_by_other_session: boolean }>(
    `select c.class_id, c.title, c.start_at::text, c.end_at::text, c.coach_account_id,
            c.scheduled_by_account_id, c.covering_coach_account_id, c.status,
            exists (
              select 1 from pilot.session_script_runs r
               where r.organization_id = c.organization_id and r.class_id = c.class_id
                 and r.run_state = 'in_progress' and r.delivered_by_account_id <> $2
            ) as held_by_other_session
       from pilot.scheduler_classes c
      where c.organization_id = $1 and c.status <> 'cancelled'
        and c.start_at between $3::timestamptz - interval '1 day' and $3::timestamptz + interval '1 day'
      order by c.start_at, c.class_id`,
    [actor.organizationId, actor.accountId, now.toISOString()],
  );
  const today = gymDayIso(now);
  return rows
    .filter((item) => gymDayIso(item.start_at) === today)
    .filter((item) => isOrganizationAdminRole(actor.role) || actorRunsClass(actor, item))
    .map(({ class_id, title, start_at, end_at, held_by_other_session }) => ({ class_id, title, start_at, end_at, held_by_other_session }));
}
