import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { COACHING_CONTENT_READER_ROLES } from '@/src/server/pilot/coachingContentAccess';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { editWorkoutTemplate, parseWorkoutTemplateEdit } from '@/src/server/pilot/workoutTemplateEdit';
import {
  projectWorkoutTemplateDetailForReader,
  projectWorkoutTemplatesForReader,
  readsFullWorkoutTemplates,
} from '@/src/server/pilot/workoutTemplateProjection';
import {
  getWorkoutTemplateWithItems,
  readWorkoutTemplateFieldDrafts,
  listUntestedTemplateDrills,
  listWorkoutTemplates,
  planTemplateIssue,
  type WorkoutTemplateDifficulty,
} from '@/src/server/pilot/workoutTemplates';

export const runtime = 'nodejs';

/**
 * The steps an issue of this template would refuse, said BEFORE the coach
 * presses Issue (lane U1, U1-ISSUE; dry run 2026-11-19: "Intro to Boxing --
 * Session 1" could not be issued and the coach learned why only after
 * confirming). planTemplateIssue is the issue's own read-only plan, so this
 * adds no rule: same drills, same reasons. It is drill-level and names no
 * athlete; refusals that depend on the athlete still come after Confirm.
 *
 * null when the check itself could not run: the template still opens, and
 * the page says the steps could not be checked rather than "none refused".
 */
async function refusedBeforeIssue(
  organizationId: string,
  items: Parameters<typeof planTemplateIssue>[1],
): Promise<Array<{ name: string; steps: number[]; reason: string }> | null> {
  try {
    const plan = await planTemplateIssue(organizationId, items);
    return plan.refused.map((drill) => ({ name: drill.name, steps: drill.steps, reason: drill.reason }));
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
    console.error({
      event: 'workout-template-refusal-check-failed',
      ...(typeof code === 'string' ? { code } : {}),
    });
    return null;
  }
}

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
          refused_drills: await refusedBeforeIssue(principal.organizationId, detail.items),
          // Which shown fields are still AI drafts, for the staff mark (lane ED-UI PR3; OW25-57:
          // coaches and admins only). This branch alone: every other reader gets the projection.
          field_drafts: await readWorkoutTemplateFieldDrafts(principal.organizationId, detail.template),
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

// WHO MAY EDIT A WORKOUT TEMPLATE (OD-2026-11-19-005, OW25-51; Overwatch ruling
// 2026-11-19): a coach or organization admin of THIS gym ('admin' is the legacy
// row name for organization_admin, roleAlias.ts:17-24) -- the author list that
// issues templates (workout-templates/issue), held identical across routes by
// coachingContentAccess.test.ts. The platform owner is refused: a gym's
// templates are the gym's content (contentImport/actor.ts:31-38). Every other
// role is refused. Another gym's template reads as not found, because the edit
// looks it up by principal.organizationId and no other.
const DRILL_AUTHOR_ROLES = ['coach', 'organization_admin', 'admin'] as const;

// Edits one workout template and its items: the body names the version being
// edited (template_id, which must still be the current version), the template
// fields that change, and optionally the whole ordered item list. The edit is
// written as the template's next version (workoutTemplateEdit.ts); workouts
// already issued keep what they were issued.
export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DRILL_AUTHOR_ROLES]);

    const body = await request.json().catch(() => null);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error('Request body must be a JSON object');
    }

    const result = await editWorkoutTemplate({
      organizationId: principal.organizationId,
      request: parseWorkoutTemplateEdit(body as Record<string, unknown>),
      actorAccountId: principal.accountId,
      actorRole: principal.role,
    });
    return NextResponse.json({ ok: true, organization_id: principal.organizationId, ...result });
  } catch (error) {
    return jsonError(error);
  }
}
