import { NextResponse, type NextRequest } from 'next/server';

import { getAthleteById } from '@/src/server/pilot/entities';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import { getSubjectIdentity } from '@/src/server/pilot/profileDb';
import { getGuardianGateSummary } from '@/src/server/pilot/safetyGateMatrix';
import { getActiveTrainingHold, type TrainingHoldRow, type TrainingHoldScope } from '@/src/server/pilot/trainingHolds';

export const runtime = 'nodejs';

/**
 * Capability #84: THE GUARDIAN'S SAFETY ROLLUP.
 *
 * Before this route, a guardian had zero visibility into whether their own
 * child was under an active training hold or how they stood against the
 * organization's safety gates -- both already exist and are already
 * readable by staff (training-holds/route.ts, safetyGateMatrix.ts), but no
 * guardian-facing surface aggregated them. Every value here mirrors the
 * SAME athlete-safe projection training-holds/route.ts's `athleteFacing()`
 * already builds for the athlete themselves (reason_text/reason_category
 * never leave the server) and getGuardianGateSummary's own doc comment
 * (gate outcome and name only, never reason/metadata) -- a guardian reads
 * exactly what their child would read, never staff detail.
 *
 * Deliberately excludes pilot.safety_escalations entirely: an
 * 'athlete_voice' escalation exists because a child typed something into
 * the feedback box, and escalationLadder.ts's own doctrine is that this
 * must never reach a surface the athlete's own guardian can read (a
 * guardian may be exactly who a child is disclosing about, or leaking
 * "an escalation exists" at all could itself be unsafe). Consent status
 * is not embedded either -- it already has its own page (/parent/consent,
 * T-008); this route links out rather than duplicating that read.
 *
 * Owner decision, 2026-08-19: placed_by_name is now included here too, kept
 * in lockstep with training-holds/route.ts's own athleteFacing() so a
 * guardian reads the exact same point-of-contact name their child does.
 */
interface AthleteFacingHold {
  scope: TrainingHoldScope;
  athlete_explanation: string;
  lift_condition_text: string;
  placed_at: string;
  expires_at: string | null;
  placed_by_name: string;
}

async function athleteFacing(organizationId: string, hold: TrainingHoldRow): Promise<AthleteFacingHold> {
  const placer = await getSubjectIdentity(organizationId, hold.placed_by_account_id);
  return {
    scope: hold.scope,
    athlete_explanation: hold.athlete_explanation,
    lift_condition_text: hold.lift_condition_text,
    placed_at: hold.placed_at,
    expires_at: hold.expires_at,
    placed_by_name: placer?.fullName ?? hold.placed_by_account_id,
  };
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['parent']);

    const athleteIds = await guardianAthleteIds(principal.organizationId, principal.accountId);

    const items = await Promise.all(
      athleteIds.map(async (athleteId) => {
        const [athlete, hold, gates] = await Promise.all([
          getAthleteById(principal.organizationId, athleteId),
          getActiveTrainingHold(principal.organizationId, athleteId),
          getGuardianGateSummary(principal.organizationId, athleteId),
        ]);

        return {
          athlete_id: athleteId,
          athlete_name: athlete?.full_name ?? null,
          hold: hold ? await athleteFacing(principal.organizationId, hold) : null,
          gates: gates.map((gate) => ({
            gate_key: gate.gate_key,
            name: gate.name,
            category: gate.category,
            outcome: gate.outcome,
            evaluated_at: gate.evaluated_at,
          })),
        };
      }),
    );

    return NextResponse.json({ ok: true, items });
  } catch (error) {
    return jsonError(error);
  }
}
