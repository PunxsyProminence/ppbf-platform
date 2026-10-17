// /api/pilot/coach/family-goals -- the family goals of one athlete, for staff
// (PH-06b; Jason: "completion state returns to coach").
//
// GET ?athlete_id=: every live goal for the child -- both guardians' and the
// gym's -- with who set it ("A guardian", or the staff member's name), its
// target date, and Done (completed_at) or in progress. Retired goals are left
// out.
// POST { athlete_id, title, support_action, target_date? }: add a staff goal.
// PATCH { goal_id, action: 'edit' | 'done' | 'undo' | 'retire', ... }: change
// a STAFF goal. A guardian's goal is read-only to staff (PH-06 Q-2 A); the
// family sees staff goals read-only (familyGoals.ts).
//
// Staff only: coach, organization admin and legacy admin (Q-E A), the same
// list as coach/family-notes. The athlete gate is assertActorCanAccessAthlete
// -- every athlete of the caller's own gym (OD-2026-10-11-007) and none of
// another's; for a PATCH it is applied to the goal's athlete in familyGoals.ts.
// The gym and the writer come from the session, never the body. No account
// ids or emails are returned (OD-2026-10-06-025). Nothing is sent.
import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import {
  createStaffFamilyGoal,
  listFamilyGoalsForStaff,
  updateStaffFamilyGoal,
  type FamilyGoalChange,
} from '@/src/server/pilot/familyGoals';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'organization_admin', 'admin']);

    const athleteId = new URL(request.url).searchParams.get('athlete_id')?.trim() ?? '';
    if (!athleteId) throw new Error('Missing athlete_id');
    await assertActorCanAccessAthlete(principal, athleteId);

    const items = await listFamilyGoalsForStaff(principal.organizationId, athleteId);
    return NextResponse.json({ ok: true, items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'organization_admin', 'admin']);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const athleteId = typeof body?.athlete_id === 'string' ? body.athlete_id.trim() : '';
    if (!athleteId) throw new Error('Missing athlete_id');
    await assertActorCanAccessAthlete(principal, athleteId);

    const item = await createStaffFamilyGoal({
      actor: principal,
      athleteId,
      title: body?.title,
      supportAction: body?.support_action,
      targetDate: body?.target_date,
    });
    return NextResponse.json({ ok: true, item });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'organization_admin', 'admin']);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const goalId = typeof body?.goal_id === 'string' ? body.goal_id.trim() : '';
    if (!goalId) throw new Error('Missing goal_id');

    let change: FamilyGoalChange;
    switch (body?.action) {
      case 'edit':
        change = { kind: 'edit', title: body.title, supportAction: body.support_action, targetDate: body.target_date };
        break;
      case 'done':
        change = { kind: 'done', done: true };
        break;
      case 'undo':
        change = { kind: 'done', done: false };
        break;
      case 'retire':
        change = { kind: 'retire' };
        break;
      default:
        throw new Error('Unsupported action: use edit, done, undo or retire');
    }

    const item = await updateStaffFamilyGoal({ actor: principal, goalId, change });
    return NextResponse.json({ ok: true, item });
  } catch (error) {
    return jsonError(error);
  }
}
