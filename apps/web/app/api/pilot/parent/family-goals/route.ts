// /api/pilot/parent/family-goals -- a guardian's family goals for one child
// (#1593, PH-06).
//
// GET ?athlete_id=: this guardian's own goals and the goals the gym's staff set
// for that child, never the other guardian's (OD-2026-10-12-024's principle).
// POST { athlete_id, title, support_action, target_date? }: add a goal.
// PATCH { goal_id, action: 'edit' | 'done' | 'undo' | 'retire', ... }: change
// a goal THIS guardian wrote. A staff goal is read-only here (PH-06 Q-2 A).
//
// Parent only. The child must be linked to this guardian on this request
// (linked, not deleted, under 18); anything else is the same 404. The gym and
// the writer come from the session, never the body. Staff names only, no
// account ids (OD-2026-10-06-025). Nothing is sent: no email, no push.
import { NextResponse, type NextRequest } from 'next/server';

import {
  createFamilyGoal,
  listFamilyGoalsForGuardian,
  updateFamilyGoal,
  type FamilyGoalChange,
} from '@/src/server/pilot/familyGoals';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['parent']);

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim() ?? '';
    if (!athleteId) throw new Error('Missing athlete_id');

    const items = await listFamilyGoalsForGuardian(principal.organizationId, principal.accountId, athleteId);
    return NextResponse.json({ ok: true, items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['parent']);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const athleteId = typeof body?.athlete_id === 'string' ? body.athlete_id.trim() : '';
    if (!athleteId) throw new Error('Missing athlete_id');

    const item = await createFamilyGoal({
      organizationId: principal.organizationId,
      accountId: principal.accountId,
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
    requireRole(principal, ['parent']);

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

    const item = await updateFamilyGoal({
      organizationId: principal.organizationId,
      accountId: principal.accountId,
      goalId,
      change,
    });
    return NextResponse.json({ ok: true, item });
  } catch (error) {
    return jsonError(error);
  }
}
