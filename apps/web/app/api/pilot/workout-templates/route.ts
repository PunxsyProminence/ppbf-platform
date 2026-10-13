import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { COACHING_CONTENT_READER_ROLES } from '@/src/server/pilot/coachingContentAccess';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  projectWorkoutTemplateDetailForReader,
  projectWorkoutTemplatesForReader,
  readsFullWorkoutTemplates,
} from '@/src/server/pilot/workoutTemplateProjection';
import {
  getWorkoutTemplateWithItems,
  listUntestedTemplateDrills,
  listWorkoutTemplates,
  type WorkoutTemplateDifficulty,
} from '@/src/server/pilot/workoutTemplates';

export const runtime = 'nodejs';

// Read-only browse over pilot.workout_templates. GET without template_id
// lists (filterable by session_type/difficulty/age_band); GET with
// template_id returns the template and its ordered items.
//
// WHO MAY BROWSE was an open question this route used to answer alone, with
// "any authenticated role can browse; a template carries no athlete data".
// The second half of that is still true and is why the answer is as wide as it
// is. The first half is now decided centrally: on 2026-08-28 the owner ruled
// that the 2026-08-27 coaching-content read policy governs the CONTENT CLASS
// rather than only the three routes it happened to name, and a workout
// template is that class. So this route reaches the one policy in
// coachingContentAccess.ts, and the board -- oversight, not coaching craft --
// is excluded from it. Isolation is unchanged either way: the reads below take
// the principal's organization and accept no other.
//
// The gate sits ABOVE the query parse deliberately. Below it, the answer to
// "may I read this?" would depend on how well-formed the request was; that was
// measured on the cue-library sibling rather than argued.
//
// WHAT EACH READER RECEIVES is a second question, answered after the gate: a
// coach or organization admin gets the stored rows, every other admitted role
// gets them without the author's account id and role, the coach's notes or
// the coach's other free text (workoutTemplateProjection.ts). Both branches
// below go through it.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...COACHING_CONTENT_READER_ROLES]);

    const { searchParams } = new URL(request.url);
    const templateId = searchParams.get('template_id');

    if (templateId) {
      const detail = await getWorkoutTemplateWithItems(principal.organizationId, templateId);
      if (!detail) {
        return NextResponse.json({ error: 'WORKOUT_TEMPLATE_NOT_FOUND' }, { status: 404 });
      }
      const projected = projectWorkoutTemplateDetailForReader(principal.role, detail);
      // The drills no coach of this gym has floor-tested, for the coach's
      // confirm step before issuing (issue #1473): the same list the issue
      // names afterwards. Only the readers who issue workouts receive it, a
      // coach or an organization admin; nobody else is sent it (Overwatch,
      // issue #1473 Q1).
      if (readsFullWorkoutTemplates(principal.role)) {
        return NextResponse.json({
          ...projected,
          untested_drills: await listUntestedTemplateDrills(principal.organizationId, detail.items),
        });
      }
      return NextResponse.json(projected);
    }

    const templates = await listWorkoutTemplates(principal.organizationId, {
      sessionType: searchParams.get('session_type') ?? undefined,
      difficulty: (searchParams.get('difficulty') as WorkoutTemplateDifficulty | null) ?? undefined,
      ageBand: searchParams.get('age_band') ?? undefined,
    });
    return NextResponse.json({ templates: projectWorkoutTemplatesForReader(principal.role, templates) });
  } catch (error) {
    return jsonError(error);
  }
}
