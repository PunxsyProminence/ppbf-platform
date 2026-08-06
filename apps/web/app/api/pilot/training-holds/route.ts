import { NextResponse, type NextRequest } from 'next/server';

import {
  assertAthleteBelongsToOrganization,
  assertCoachAssignedToAthlete,
  isOrganizationAdminRole,
} from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  TRAINING_HOLD_REASON_CATEGORIES,
  TRAINING_HOLD_SCOPES,
  getActiveTrainingHold,
  getTrainingHoldById,
  liftTrainingHold,
  listTrainingHolds,
  placeTrainingHold,
  type TrainingHoldReasonCategory,
  type TrainingHoldRow,
  type TrainingHoldScope,
  type TrainingHoldStatus,
} from '@/src/server/pilot/trainingHolds';

export const runtime = 'nodejs';

const TEXT_FIELD_MAX = 2000;

/**
 * Training holds (capability #82).
 *
 * Authority (owner decision, 2026-08-06): a coach may place and lift holds
 * for their own athletes (including athletes they hold an active coverage
 * grant for -- assertCoachAssignedToAthlete admits both); organization
 * admins may place and lift any. Athletes and their guardians read their
 * OWN hold in an athlete-safe projection -- explanation, lift condition,
 * scope -- never reason_text, which is staff-facing detail. Board and
 * platform_owner get nothing here: a hold names one child, and both roles
 * are aggregate-only by doctrine.
 */

interface AthleteFacingHold {
  scope: TrainingHoldScope;
  athlete_explanation: string;
  lift_condition_text: string;
  placed_at: string;
  expires_at: string | null;
}

function athleteFacing(hold: TrainingHoldRow): AthleteFacingHold {
  return {
    scope: hold.scope,
    athlete_explanation: hold.athlete_explanation,
    lift_condition_text: hold.lift_condition_text,
    placed_at: hold.placed_at,
    expires_at: hold.expires_at,
  };
}

function isStaff(role: string): boolean {
  return role === 'coach' || isOrganizationAdminRole(role as never);
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const role = principal.role;

    if (role === 'athlete') {
      if (!principal.athleteId) {
        return NextResponse.json({ ok: true, hold: null });
      }
      const hold = await getActiveTrainingHold(principal.organizationId, principal.athleteId);
      return NextResponse.json({ ok: true, hold: hold ? athleteFacing(hold) : null });
    }

    if (role === 'parent') {
      const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim() ?? '';
      if (!athleteId) throw new Error('Missing athlete_id');
      const linked = await guardianAthleteIds(principal.organizationId, principal.accountId);
      if (!linked.includes(athleteId)) {
        throw new Error('Forbidden: parent not linked to athlete');
      }
      const hold = await getActiveTrainingHold(principal.organizationId, athleteId);
      return NextResponse.json({ ok: true, hold: hold ? athleteFacing(hold) : null });
    }

    if (!isStaff(role)) {
      throw new Error('Forbidden: role not allowed');
    }

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim() || undefined;
    const statusParam = request.nextUrl.searchParams.get('status');
    if (statusParam !== null && !['active', 'lifted', 'expired'].includes(statusParam)) {
      throw new Error('Unsupported status: must be active, lifted, or expired');
    }

    if (role === 'coach') {
      // A coach reads holds per athlete, through the same assignment gate
      // every other athlete-scoped read uses -- no org-wide hold roster.
      if (!athleteId) throw new Error('Missing athlete_id');
      await assertCoachAssignedToAthlete(principal.accountId, athleteId, principal.organizationId);
    }

    const holds = await listTrainingHolds(principal.organizationId, {
      athleteId,
      status: (statusParam ?? undefined) as TrainingHoldStatus | undefined,
    });
    return NextResponse.json({ ok: true, holds });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const role = principal.role;
    if (!isStaff(role)) {
      throw new Error('Forbidden: role not allowed');
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw new Error('Missing request body');

    const action = typeof body.action === 'string' ? body.action : '';

    if (action === 'place') {
      const athleteId = typeof body.athlete_id === 'string' ? body.athlete_id.trim() : '';
      if (!athleteId) throw new Error('Missing athlete_id');

      const scope = typeof body.scope === 'string' ? body.scope : '';
      if (!TRAINING_HOLD_SCOPES.includes(scope as TrainingHoldScope)) {
        throw new Error('Unsupported scope: must be all_training, contact_only, or conditioning_only');
      }

      const reasonCategory = typeof body.reason_category === 'string' ? body.reason_category : '';
      if (!TRAINING_HOLD_REASON_CATEGORIES.includes(reasonCategory as TrainingHoldReasonCategory)) {
        throw new Error('Unsupported reason_category');
      }

      const athleteExplanation = typeof body.athlete_explanation === 'string' ? body.athlete_explanation.trim() : '';
      if (!athleteExplanation) {
        // NOT optional: a hold a child cannot read a reason for is a
        // punishment, not a safety measure.
        throw new Error('Missing athlete_explanation: the sentence the athlete reads is required');
      }

      const reasonText = typeof body.reason_text === 'string' ? body.reason_text.trim() : '';
      const liftConditionText = typeof body.lift_condition_text === 'string' ? body.lift_condition_text.trim() : '';
      for (const [name, value] of [
        ['athlete_explanation', athleteExplanation],
        ['reason_text', reasonText],
        ['lift_condition_text', liftConditionText],
      ] as const) {
        if (value.length > TEXT_FIELD_MAX) {
          throw new Error(`Unsupported ${name}: longer than ${TEXT_FIELD_MAX} characters`);
        }
      }

      let expiresAt: string | null = null;
      if (body.expires_at !== undefined && body.expires_at !== null) {
        if (typeof body.expires_at !== 'string' || Number.isNaN(Date.parse(body.expires_at))) {
          throw new Error('Unsupported expires_at: must be an ISO timestamp');
        }
        if (Date.parse(body.expires_at) <= Date.now()) {
          throw new Error('Unsupported expires_at: must be in the future');
        }
        expiresAt = new Date(body.expires_at).toISOString();
      }

      if (role === 'coach') {
        await assertCoachAssignedToAthlete(principal.accountId, athleteId, principal.organizationId);
      } else {
        await assertAthleteBelongsToOrganization(principal.organizationId, athleteId);
      }

      const hold = await placeTrainingHold({
        organizationId: principal.organizationId,
        athleteId,
        scope: scope as TrainingHoldScope,
        reasonCategory: reasonCategory as TrainingHoldReasonCategory,
        reasonText,
        athleteExplanation,
        liftConditionText,
        placedByAccountId: principal.accountId,
        placedByRole: role === 'coach' ? 'coach' : role === 'admin' ? 'admin' : 'organization_admin',
        expiresAt,
      });

      await writePilotAuditEvent({
        event_type: 'safety_hold_placed',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'training_hold',
        entity_id: hold.hold_id,
        details: { athlete_id: athleteId, scope, reason_category: reasonCategory },
      });

      return NextResponse.json({ ok: true, hold });
    }

    if (action === 'lift') {
      const holdId = typeof body.hold_id === 'string' ? body.hold_id.trim() : '';
      if (!holdId) throw new Error('Missing hold_id');

      const liftNote = typeof body.lift_note === 'string' ? body.lift_note.trim() : '';
      if (liftNote.length > TEXT_FIELD_MAX) {
        throw new Error(`Unsupported lift_note: longer than ${TEXT_FIELD_MAX} characters`);
      }

      // The coach-authority check needs the hold's athlete BEFORE the lift.
      // "Not yours" and "not real" land on the same Missing error, so a
      // coach cannot probe hold ids across the roster.
      const existing = await getTrainingHoldById(principal.organizationId, holdId);
      if (!existing) throw new Error('Missing hold record');
      if (role === 'coach') {
        try {
          await assertCoachAssignedToAthlete(principal.accountId, existing.athlete_id, principal.organizationId);
        } catch {
          throw new Error('Missing hold record');
        }
      }

      const lifted = await liftTrainingHold(principal.organizationId, holdId, principal.accountId, liftNote);
      if (!lifted) throw new Error('Missing hold record');

      await writePilotAuditEvent({
        event_type: 'safety_hold_lifted',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'training_hold',
        entity_id: holdId,
        details: { athlete_id: lifted.athlete_id, note_written: liftNote.length > 0 },
      });

      return NextResponse.json({ ok: true, hold: lifted });
    }

    throw new Error('Unsupported action: must be place or lift');
  } catch (error) {
    return jsonError(error);
  }
}
