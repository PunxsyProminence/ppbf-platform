import { NextResponse, type NextRequest } from 'next/server';

import { assertAthleteBelongsToOrganization, requireRole } from '@/src/server/pilot/access';
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

// The session's id says whose record this is, not that it is still there: a
// session that outlived the athlete's deletion carries the same id. So the
// live row is required too, the same rule as assertActorCanAccessAthlete's
// athlete arm (OD-2026-09-29-002 item 10).
async function requireOwnAthleteId(principal: { organizationId: string; athleteId?: string | null }): Promise<string> {
  if (!principal.athleteId) throw new ValidationError('This account is not linked to an athlete record.');
  await assertAthleteBelongsToOrganization(principal.organizationId, principal.athleteId);
  return principal.athleteId;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['athlete']);
    const athleteId = await requireOwnAthleteId(principal);

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
    const athleteId = await requireOwnAthleteId(principal);

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
          body_mass_sent: typeof body.body_mass === 'number',
        },
        // shadow_mirror: false -- the mirrored shadow_events row would carry
        // body_mass_sent, a weigh-in signal about a child, to every reader of
        // /api/pilot/shadow/events tied to this athlete. A child's weight
        // record is health data whose family-feed exposure is not decided
        // (athleteBodyMass.ts, athleteMinorLimits.ts hold the same line).
        shadow_mirror: false,
      });
    }

    // The audit event is written BEFORE the weight: a failed weight write
    // must not leave a stored check-in with no audit record (a retry answers
    // created:false and would never write it).
    //
    // One weigh-in per check-in, keyed by the check-in. A repeat submission
    // the same day may add the weight if the first attempt did not store one
    // (a failed write is retried, not lost); it can never replace a stored
    // weight -- that is an idempotency conflict, answered body_mass_saved
    // false with the stored value unchanged.
    //
    // ANY OTHER FAILURE IS A PARTIAL SUCCESS, NOT A 500. The check-in and its
    // audit are already committed; a 500 would tell the athlete the check-in
    // failed, and after a reload the form is gone, so they could never say
    // the weight was lost. body_mass_failed lets the screen say exactly that.
    let bodyMassSaved = false;
    let bodyMassFailed = false;
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
        if (!(error instanceof FormulaRepositoryError && error.code === 'IDEMPOTENCY_CONFLICT')) {
          bodyMassFailed = true;
          console.error({
            event: 'check-in-body-mass-write-failed',
            check_in_id: result.row.check_in_id,
            errorClass: error instanceof Error ? error.name : typeof error,
          });
        }
      }
    }

    return NextResponse.json({
      item: result.row,
      already_checked_in: !result.created,
      body_mass_saved: bodyMassSaved,
      body_mass_failed: bodyMassFailed,
    });
  } catch (error) {
    return jsonError(error);
  }
}
