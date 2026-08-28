import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { COACHING_CONTENT_READER_ROLES } from '@/src/server/pilot/coachingContentAccess';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  getWorkoutTemplateWithItems,
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
      return NextResponse.json(detail);
    }

    const templates = await listWorkoutTemplates(principal.organizationId, {
      sessionType: searchParams.get('session_type') ?? undefined,
      difficulty: (searchParams.get('difficulty') as WorkoutTemplateDifficulty | null) ?? undefined,
      ageBand: searchParams.get('age_band') ?? undefined,
    });
    return NextResponse.json({ templates });
  } catch (error) {
    return jsonError(error);
  }
}
