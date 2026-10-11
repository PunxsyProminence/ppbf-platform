import { NextResponse, type NextRequest } from 'next/server';

// The aliasing requireRole, on its own line: coachingContentAccess.test.ts
// holds every registered route to exactly this import.
import { requireRole } from '@/src/server/pilot/access';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { readStaffHoldWarning } from '@/src/server/pilot/trainingHolds';
import {
  TEMPLATE_STEP_FIELDS_NOT_CARRIED,
  issueWorkoutTemplate,
} from '@/src/server/pilot/workoutTemplates';

export const runtime = 'nodejs';

// A coach issues a saved workout template to ONE athlete in one action
// (OD-2026-10-07-012 ruling 2; OD-2026-10-08-002 item 2). Every step becomes
// an assignment, and a reference drill the gym has not adopted is adopted in
// the same transaction. An untested draft drill -- or any other step that
// cannot be assigned as it stands -- refuses the whole issue and is named.
// The rules and the transaction are issueWorkoutTemplate's; this file is the
// gates and the answer.
//
// WHY POST-ONLY AND ITS OWN FILE. workout-templates/route.ts is the read of a
// content class under the coaching-content reader policy, and the gate sweep in
// coachingContentAccess.test.ts asserts it applies that policy and nothing
// else. This is a write with a narrower gate, so it is registered there as an
// author-only route, like drills/promote.

// The three roles that may assign a drill (progression/assignments) and the
// same three that may adopt one (drills/promote DRILL_AUTHOR_ROLES): issuing a
// template does both. platform_owner reads templates under the reader policy
// and is refused here, as it is for both of those writes.
const DRILL_AUTHOR_ROLES = ['coach', 'organization_admin', 'admin'] as const;

function requireText(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`Missing ${field}`);
  }
  return raw.trim();
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DRILL_AUTHOR_ROLES]);

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const templateId = requireText(body.template_id, 'template_id');
    const athleteId = requireText(body.athlete_id, 'athlete_id');

    // REACH, before anything about the template is read. "No such athlete" and
    // "an athlete this coach cannot reach" collapse to the same 404 (the
    // coach-cards rule), so this route cannot be used to probe which athlete
    // ids are real.
    try {
      await assertActorCanAccessAthlete(principal, athleteId);
    } catch {
      return hiddenNotFound();
    }

    // The organization is the session's, never the body's.
    const result = await issueWorkoutTemplate({
      organizationId: principal.organizationId,
      templateId,
      athleteId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
    });

    // Another gym's template id reads exactly like one that does not exist.
    if (result.outcome === 'not_found') {
      return hiddenNotFound();
    }

    if (result.outcome === 'refused') {
      return NextResponse.json(
        { error: result.message, code: 'WORKOUT_TEMPLATE_ISSUE_REFUSED', drills: result.drills },
        { status: 409 },
      );
    }

    // OD-2026-10-06-024 ruling 1 ("Warn only, both places"): an active training
    // hold does NOT stop the issue. Read AFTER the transaction committed and
    // never able to fail it (readStaffHoldWarning does not throw); the key is
    // absent when the athlete is not held, exactly as on progression/assignments.
    const holdWarning = await readStaffHoldWarning(principal.role, principal.organizationId, athleteId);

    return NextResponse.json(
      {
        ok: true,
        organization_id: principal.organizationId,
        athlete_id: athleteId,
        template: result.template,
        // What was created, and only that: one separate assignment per step.
        created: { assignments: result.steps.length, adopted_drills: result.adopted.length },
        steps: result.steps,
        adopted_drills: result.adopted,
        // The step columns an assignment has nowhere to store. Named so a
        // client cannot take the session's structure to have travelled.
        not_carried: [...TEMPLATE_STEP_FIELDS_NOT_CARRIED],
        ...(holdWarning ? { hold_warning: holdWarning } : {}),
      },
      { status: 201 },
    );
  } catch (error) {
    return jsonError(error);
  }
}
