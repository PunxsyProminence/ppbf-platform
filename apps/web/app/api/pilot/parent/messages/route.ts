import { NextResponse, type NextRequest } from 'next/server';

import { getAthleteById } from '@/src/server/pilot/entities';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import { listParentMessages } from '@/src/server/pilot/intake';
import { parentTaskStateForNotes, setParentTaskCompletion } from '@/src/server/pilot/parentTasks';

export const runtime = 'nodejs';

/**
 * Capability #90: the read side of one-directional coach/admin -> parent
 * messaging. There is deliberately no POST here -- a coach/admin sends via
 * the existing POST /api/pilot/intake/domain-upsert
 * (entity_type: 'coach_note', note_type: 'parent_message'), so this route
 * only ever reads. Reply, threading, and any parent-initiated send are
 * explicitly out of scope: real moderation/product decisions, not
 * something this pass guesses at.
 *
 * TASK STATE rides on the same read. A message that carries a due date is a
 * parent-support task -- "bring gloves Thursday", "the medical form is still
 * outstanding" -- and pilot.parent_task_state holds the due-and-done for it,
 * keyed to the note. A message without one has `task: null`, which is most of
 * them.
 *
 * The POST below is the ONE parent write on this route, and it is narrow: tick
 * a task off, or put it back. It is not a reply, not a send, and not a new
 * task -- setting a due date stays with whoever wrote the message
 * (parentTasks.canSetParentTask). A guardian may close their own errand and
 * nothing else.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['parent']);

    const athleteIds = await guardianAthleteIds(principal.organizationId, principal.accountId);

    const [messages, athletes] = await Promise.all([
      listParentMessages(principal.organizationId, athleteIds),
      Promise.all(athleteIds.map((athleteId) => getAthleteById(principal.organizationId, athleteId))),
    ]);

    const nameByAthleteId = new Map(
      athletes.filter((athlete): athlete is NonNullable<typeof athlete> => Boolean(athlete)).map((athlete) => [athlete.athlete_id, athlete.full_name]),
    );

    /* Asked for the notes this guardian was already authorised to read, on
       the list listParentMessages just returned. No second athlete lookup and
       no second authorisation: guardianAthleteIds above is the one that
       decides, and a differently-shaped check here would be a second thing to
       keep correct. */
    const taskState = await parentTaskStateForNotes(
      principal.organizationId,
      messages.map((message) => message.note_id),
    );

    const items = messages.map((message) => {
      const task = taskState.get(message.note_id) ?? null;
      return {
        note_id: message.note_id,
        athlete_id: message.athlete_id,
        athlete_name: nameByAthleteId.get(message.athlete_id) ?? null,
        sender_role: message.sender_role,
        note_text: message.note_text,
        created_at: message.created_at,
        // null, not omitted: a message with no task is a fact about it, and a
        // key that vanishes is one a client can misread as "not loaded yet".
        task: task
          ? {
            due_date: task.dueDate,
            completed_at: task.completedAt,
          }
          : null,
      };
    });

    return NextResponse.json({ ok: true, items });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Tick a parent-support task off, or put it back.
 *
 * Body: { note_id, completed }.
 *
 * completed_by_account_id is NOT disclosed on the read above, and this route
 * does not return it either. Who closed a household errand is provenance for
 * an audit, not something one guardian needs to read about the other -- the
 * same reasoning that keeps a co-guardian's contact details out of the intake
 * projection.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['parent']);

    const body = (await request.json().catch(() => null)) as
      { note_id?: string; completed?: boolean } | null;

    const noteId = body?.note_id?.trim();
    if (!noteId) {
      throw new Error('Missing note_id');
    }
    if (typeof body?.completed !== 'boolean') {
      throw new Error('Missing completed');
    }

    /* The same scoping the GET uses, resolved fresh on this request rather
       than trusted from the client. A guardian unlinked since their last read
       holds a stale note_id, and this is where it stops being usable. */
    const athleteIds = await guardianAthleteIds(principal.organizationId, principal.accountId);

    const task = await setParentTaskCompletion({
      organizationId: principal.organizationId,
      noteId,
      completed: body.completed,
      actorAccountId: principal.accountId,
      athleteIdsInScope: athleteIds,
    });

    return NextResponse.json({
      ok: true,
      task: { due_date: task.dueDate, completed_at: task.completedAt },
    });
  } catch (error) {
    return jsonError(error);
  }
}
