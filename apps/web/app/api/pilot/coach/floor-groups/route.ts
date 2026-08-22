import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  addGroup,
  createPlan,
  listGroups,
  listPlans,
  placeAthlete,
  removeAthlete,
} from '@/src/server/pilot/floorGroups';

export const runtime = 'nodejs';

// Floor groups (modules 121 + 123): today's room, split for today. Coach
// surface -- coaches make the floor, so coaches write here. A placement
// is a fact about one session and carries no level, rank, or judgment;
// nothing recorded here follows an athlete to tomorrow.
//
// Placing or removing a named athlete is still a write against that
// athlete's day, so both go through assertActorCanAccessAthlete: making the
// floor is a coach act, but only for the athletes this coach actually has
// (assignment, or an active coverage grant).

const FLOOR_ROLES = ['coach', 'organization_admin', 'admin'] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...FLOOR_ROLES]);

    const planId = request.nextUrl.searchParams.get('plan_id')?.trim();
    if (planId) {
      const groups = await listGroups(principal.organizationId, planId);
      return NextResponse.json({ groups });
    }
    const plans = await listPlans(principal.organizationId);
    return NextResponse.json({ plans });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...FLOOR_ROLES]);

    const body = (await request.json()) as Record<string, unknown>;

    if (body.action === 'create_plan') {
      const planOn = text(body.plan_on)?.trim();
      if (!planOn || !ISO_DATE.test(planOn)) throw new ValidationError('plan_on must be a date (YYYY-MM-DD).');

      const rotationMinutes = body.rotation_minutes;
      if (rotationMinutes !== undefined && rotationMinutes !== null) {
        if (typeof rotationMinutes !== 'number' || !Number.isInteger(rotationMinutes)
          || rotationMinutes < 1 || rotationMinutes > 120) {
          throw new ValidationError('rotation_minutes must be a whole number of minutes from 1 to 120, or omitted.');
        }
      }

      const item = await createPlan({
        organizationId: principal.organizationId,
        planOn,
        classId: text(body.class_id)?.trim() || null,
        title: text(body.title),
        rotationMinutes: (rotationMinutes as number | undefined) ?? null,
        notes: text(body.notes),
        createdByAccountId: principal.accountId,
      });
      if (!item) return hiddenNotFound();
      await audit(principal, item.plan_id, { action: 'create_plan', plan_on: item.plan_on });
      return NextResponse.json({ item });
    }

    if (body.action === 'add_group') {
      const planId = text(body.plan_id)?.trim();
      const groupName = text(body.group_name)?.trim();
      if (!planId) throw new ValidationError('Missing plan_id.');
      if (!groupName) throw new ValidationError('Missing group_name.');

      const item = await addGroup({
        organizationId: principal.organizationId,
        planId,
        groupName,
        stationName: text(body.station_name),
        focus: text(body.focus),
        rotationOrder: typeof body.rotation_order === 'number' ? body.rotation_order : null,
        coachAccountId: text(body.coach_account_id)?.trim() || null,
      });
      if (!item) return hiddenNotFound();
      return NextResponse.json({ item });
    }

    if (body.action === 'place') {
      const planId = text(body.plan_id)?.trim();
      const groupId = text(body.group_id)?.trim();
      const athleteId = text(body.athlete_id)?.trim();
      if (!planId || !groupId || !athleteId) {
        throw new ValidationError('place needs plan_id, group_id, and athlete_id.');
      }
      await assertActorCanAccessAthlete(principal, athleteId);

      const groups = await placeAthlete({
        organizationId: principal.organizationId,
        planId,
        groupId,
        athleteId,
      });
      if (!groups) return hiddenNotFound();
      return NextResponse.json({ groups });
    }

    if (body.action === 'remove') {
      const planId = text(body.plan_id)?.trim();
      const athleteId = text(body.athlete_id)?.trim();
      if (!planId || !athleteId) throw new ValidationError('remove needs plan_id and athlete_id.');
      await assertActorCanAccessAthlete(principal, athleteId);

      const groups = await removeAthlete({
        organizationId: principal.organizationId,
        planId,
        athleteId,
      });
      return NextResponse.json({ groups });
    }

    throw new ValidationError("action must be 'create_plan', 'add_group', 'place', or 'remove'.");
  } catch (error) {
    return jsonError(error);
  }
}

async function audit(principal: PilotPrincipal, entityId: string, details: Record<string, unknown>) {
  await writePilotAuditEvent({
    event_type: 'create',
    actor_account_id: principal.accountId,
    actor_role: principal.role,
    organization_id: principal.organizationId,
    entity_type: 'floor_plan',
    entity_id: entityId,
    details,
  });
}
