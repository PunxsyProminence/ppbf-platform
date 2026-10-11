import { NextResponse, type NextRequest } from 'next/server';

// The aliasing requireRole, on its own line: coachingContentAccess.test.ts
// holds every registered route to exactly this import.
import { requireRole } from '@/src/server/pilot/access';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { readStaffHoldWarning } from '@/src/server/pilot/trainingHolds';
import { issueWorkoutTemplate } from '@/src/server/pilot/workoutTemplates';

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

// A REQUEST KEY (optional). The coach's screen makes one random id for a press
// of Issue and sends the same one again when that press got no answer. A key
// that already names an issue of this template to this athlete is a repeat:
// nothing is written and the first issue is answered, with 200 rather than
// 201 so "this request created it" is never said twice. The limits are the
// column's own check (not blank, at most 200 characters). A request that
// sends no key is issued exactly as before.
const REQUEST_KEY_MAX = 200;

function readRequestKey(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > REQUEST_KEY_MAX) {
    throw new ValidationError(`request_key must be text of 1 to ${REQUEST_KEY_MAX} characters`);
  }
  return raw;
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DRILL_AUTHOR_ROLES]);

    // A body that is not a JSON object (unparseable, null, a bare string) names
    // nothing, and is answered as the missing field it amounts to.
    const parsed: unknown = await request.json().catch(() => null);
    const body = (parsed !== null && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
    const templateId = requireText(body.template_id, 'template_id');
    const athleteId = requireText(body.athlete_id, 'athlete_id');
    const requestKey = readRequestKey(body.request_key);

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
      requestKey,
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

    // A repeat of a request that already issued this workout. Nothing was
    // written this time, so nothing is reported as created; the hold note is
    // said again because the first answer may never have arrived.
    if (result.outcome === 'already_issued') {
      return NextResponse.json({
        ok: true,
        already_issued: true,
        organization_id: principal.organizationId,
        athlete_id: athleteId,
        issue_id: result.issue_id,
        template: result.template,
        step_count: result.step_count,
        ...(holdWarning ? { hold_warning: holdWarning } : {}),
      });
    }

    return NextResponse.json(
      {
        ok: true,
        organization_id: principal.organizationId,
        athlete_id: athleteId,
        // The issued workout: the row that holds each step's block, order,
        // scale level, contact level and coach note beside its assignment.
        issue_id: result.issue_id,
        template: result.template,
        // What was created: one assignment per step, in one workout.
        created: { assignments: result.steps.length, adopted_drills: result.adopted.length },
        steps: result.steps,
        adopted_drills: result.adopted,
        ...(holdWarning ? { hold_warning: holdWarning } : {}),
      },
      { status: 201 },
    );
  } catch (error) {
    return jsonError(error);
  }
}
