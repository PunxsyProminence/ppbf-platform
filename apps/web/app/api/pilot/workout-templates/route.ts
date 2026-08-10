import { NextResponse, type NextRequest } from 'next/server';

import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  getWorkoutTemplateWithItems,
  listWorkoutTemplates,
  type WorkoutTemplateDifficulty,
} from '@/src/server/pilot/workoutTemplates';

export const runtime = 'nodejs';

// Read-only browse over pilot.workout_templates. GET without template_id
// lists (filterable by session_type/difficulty/age_band); GET with
// template_id returns the template and its ordered items. Any
// authenticated role can browse; a template carries no athlete data.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);

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
