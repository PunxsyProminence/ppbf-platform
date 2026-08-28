import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { canSetParentTask, setParentTaskDueDate } from '@/src/server/pilot/parentTasks';

export const runtime = 'nodejs';

/**
 * THE STAFF SIDE: put a due date on a parent message, or take one off.
 *
 * A parent-support task is a message with a deadline. The message is written
 * where messages have always been written (POST /api/pilot/intake/domain-upsert
 * with note_type 'parent_message'); this route only says "and it is due by
 * then". Splitting it that way means no existing write path changes, and a
 * gym that never uses this keeps exactly the messaging it has today.
 *
 * NOT ON THE PARENT ROUTE, deliberately. /api/pilot/parent/messages carries
 * one parent write -- ticking a task off -- and putting the due-date write
 * beside it would make one route where a guardian and a coach both post
 * different things under different rules. Two routes, two audiences, two
 * authorisations that cannot be confused for one another.
 *
 * A GUARDIAN MAY NOT SET ONE. canSetParentTask admits coach and organization
 * admin only. That is not a judgement about guardians' own reminders: it is
 * that a task nobody at the gym asked for, appearing in a list the gym reads
 * as its outstanding work, makes "who wanted this" unanswerable. Guardian
 * self-set reminders would be a different feature with a different audience.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);

    if (!canSetParentTask(principal.role)) {
      throw new Error('Forbidden: role may not set a parent task');
    }

    const body = (await request.json().catch(() => null)) as
      { note_id?: string; athlete_id?: string; due_date?: string | null } | null;

    const noteId = body?.note_id?.trim();
    if (!noteId) {
      throw new Error('Missing note_id');
    }

    const athleteId = body?.athlete_id?.trim();
    if (!athleteId) {
      throw new Error('Missing athlete_id');
    }

    /* The athlete gate BEFORE the note lookup, so a coach off this child's
       roster is refused without learning whether the note exists.

       An earlier version of this comment claimed that this check and the
       module's note lookup together confined a coach to families they work
       with. They did not: they were checks on two different objects, and
       nothing tied the note to the athlete. setParentTaskDueDate now takes
       the authorised athleteId and matches the note against it, so the
       binding is in the module rather than in a claim made here. */
    await assertActorCanAccessAthlete(principal, athleteId);

    const dueDate = body?.due_date ?? null;
    const task = await setParentTaskDueDate({
      organizationId: principal.organizationId,
      noteId,
      athleteId,
      dueDate,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
    });

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'coach_note',
      entity_id: noteId,
      details: { action: dueDate ? 'parent_task_due_set' : 'parent_task_due_cleared' },
    });

    return NextResponse.json({
      ok: true,
      task: { due_date: task.dueDate, completed_at: task.completedAt },
    });
  } catch (error) {
    return jsonError(error);
  }
}
