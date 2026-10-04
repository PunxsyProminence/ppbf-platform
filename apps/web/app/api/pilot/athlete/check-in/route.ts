import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import {
  bodyMassInputError,
  recordCheckInBodyMass,
  toKilograms,
  type BodyMassUnit,
} from '@/src/server/pilot/athleteBodyMass';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { ValidationError } from '@/src/server/pilot/errors';
import { FormulaRepositoryError } from '@/src/server/pilot/formulas/repository';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  WELLNESS_COLUMNS,
  checkIn,
  getTodayCheckIn,
  listRecentCheckIns,
  sleepHoursError,
  wellnessValueError,
} from '@/src/server/pilot/athleteCheckIns';

export const runtime = 'nodejs';

// Athlete self check-in (Phase 2 slice 1). SELF ONLY: the athlete acts on
// their own record via the athlete id bound to their session principal --
// there is no athlete_id parameter to aim at anyone else, and no other
// role has a path here (coach/admin views of arrivals are a later,
// separate read surface; parents have none). Checking in never writes
// attendance and never touches readiness formula scores.

function requireOwnAthleteId(principal: { athleteId?: string | null }): string {
  if (!principal.athleteId) throw new ValidationError('This account is not linked to an athlete record.');
  return principal.athleteId;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['athlete']);
    const athleteId = requireOwnAthleteId(principal);

    const [today, recent] = await Promise.all([
      getTodayCheckIn(principal.organizationId, athleteId),
      listRecentCheckIns(principal.organizationId, athleteId),
    ]);
    return NextResponse.json({ today, recent });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['athlete']);
    const athleteId = requireOwnAthleteId(principal);

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    // Swept from WELLNESS_COLUMNS rather than a literal list. The three
    // original fields were named here by hand, and the next measure migration
    // adds a column whose validation would simply have been forgotten -- an
    // unvalidated field reaches the database check instead, which refuses the
    // whole insert with a Postgres error rather than the stated reason the
    // contract promises.
    for (const field of WELLNESS_COLUMNS) {
      const problem = wellnessValueError(field, body[field]);
      if (problem) throw new ValidationError(problem);
    }
    const sleepProblem = sleepHoursError(body.sleep_hours);
    if (sleepProblem) throw new ValidationError(sleepProblem);
    // Optional body mass (elite-boxing item 5). Validated before the check-in
    // is written, so a refused weight refuses the whole check-in with its
    // reason instead of leaving a check-in whose weight silently went missing.
    const bodyMassProblem = bodyMassInputError(body.body_mass, body.body_mass_unit);
    if (bodyMassProblem) throw new ValidationError(bodyMassProblem);

    const result = await checkIn({
      organizationId: principal.organizationId,
      athleteId,
      energy: body.energy as number | undefined,
      soreness: body.soreness as number | undefined,
      focus: body.focus as number | undefined,
      sleepHours: body.sleep_hours as number | undefined,
      hydration: body.hydration as number | undefined,
      motivation: body.motivation as number | undefined,
      mentalClarity: body.mental_clarity as number | undefined,
      stress: body.stress as number | undefined,
      nutritionCompliance: body.nutrition_compliance as number | undefined,
      note: typeof body.note === 'string' ? body.note : '',
    });
    if (!result) return hiddenNotFound();

    // One weigh-in per check-in, keyed by the check-in. A repeat submission
    // the same day may add the weight if the first attempt did not store one
    // (a failed write is retried, not lost); it can never replace a stored
    // weight -- that is an idempotency conflict, answered body_mass_saved
    // false with the stored value unchanged.
    let bodyMassSaved = false;
    if (typeof body.body_mass === 'number') {
      try {
        await recordCheckInBodyMass({
          organizationId: principal.organizationId,
          athleteId,
          checkInId: result.row.check_in_id,
          kilograms: toKilograms(body.body_mass, body.body_mass_unit as BodyMassUnit),
          observedAt: new Date(result.row.created_at).toISOString(),
          accountId: principal.accountId,
        });
        bodyMassSaved = true;
      } catch (error) {
        if (!(error instanceof FormulaRepositoryError && error.code === 'IDEMPOTENCY_CONFLICT')) throw error;
      }
    }

    if (result.created) {
      await writePilotAuditEvent({
        event_type: 'create',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'athlete_check_in',
        entity_id: result.row.check_in_id,
        details: {
          athlete_id: athleteId,
          checked_in_on: result.row.checked_in_on,
          body_mass_recorded: bodyMassSaved,
        },
      });
    }
    return NextResponse.json({
      item: result.row,
      already_checked_in: !result.created,
      body_mass_saved: bodyMassSaved,
    });
  } catch (error) {
    return jsonError(error);
  }
}
