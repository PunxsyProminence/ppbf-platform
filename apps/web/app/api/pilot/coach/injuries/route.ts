import { NextResponse, type NextRequest } from 'next/server';

import {
  accessibleAthleteIds,
  assertAthleteBelongsToOrganization,
  assertCoachAssignedToAthlete,
} from '@/src/server/pilot/access';
import {
  getInjuryById,
  listInjuriesForAthlete,
  listLinkCandidates,
  markInjuryEnteredInError,
  recordInjury,
  updateInjury,
} from '@/src/server/pilot/athleteInjuries';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { NotFoundError, ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import { SHADOW_PHI_ROLES } from '@/src/server/pilot/shadowRoleSets';

export const runtime = 'nodejs';

// Every response can carry a child's injury and the staff note.
const NO_STORE = { headers: { 'cache-control': 'private, no-store' } };

const MAX_ROSTER_IDS = 1000;

/**
 * The coach's injury record (map item 11): read, record, edit, and mark
 * entered in error. Staff only.
 *
 * Who: SHADOW_PHI_ROLES -- coach, organization_admin, admin. An injury names
 * one child's health, so platform_owner and board are refused by the role gate
 * before anything is read. A coach reaches only athletes they coach or cover
 * (assertCoachAssignedToAthlete); an organization admin reaches any live
 * athlete in their organization. For an action on an existing injury, "not
 * yours" and "not real" are the same 404, so a coach cannot probe ids.
 *
 * NOT DIAGNOSTIC: the record holds what a person reported or a clinician
 * stated (reported_by), and nothing here blocks training -- a training hold
 * does that, and an injury only links to one.
 *
 * Athletes and guardians read their own injuries through a separate,
 * staff-note-free projection (PR C, owner decision 2026-10-04). This route
 * serves staff_note and must never be opened to them.
 */

function str(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The recorded fields, picked by name from the request body -- never spread,
 * so a body cannot supply organizationId, athleteId or the recorder.
 *
 * An update REPLACES the record with these fields: the page sends the full
 * record it shows, and a field left out is cleared (an absent staff_note
 * becomes empty, an absent link is unlinked).
 */
function injuryFields(body: Record<string, unknown>): Record<string, unknown> {
  return {
    injuryDate: body.injury_date,
    bodyArea: body.body_area,
    injuryType: body.injury_type,
    context: body.context,
    reportedBy: body.reported_by,
    staffNote: typeof body.staff_note === 'string' ? body.staff_note.trim() : body.staff_note,
    expectedReturnDate: body.expected_return_date,
    returnedOn: body.returned_on,
    linkedRttPlanId: body.linked_rtt_plan_id,
    linkedHoldId: body.linked_hold_id,
    linkedClearanceStatusId: body.linked_clearance_status_id,
    linkedPainReportId: body.linked_pain_report_id,
  };
}

async function assertStanding(principal: PilotPrincipal, athleteId: string): Promise<void> {
  if (principal.role === 'coach') {
    await assertCoachAssignedToAthlete(principal.accountId, athleteId, principal.organizationId);
  } else {
    await assertAthleteBelongsToOrganization(principal.organizationId, athleteId);
  }
}

/** The injury, only if this principal has standing with its athlete; otherwise the same 404 as absent. */
async function injuryWithStanding(principal: PilotPrincipal, injuryId: string) {
  const injury = await getInjuryById(principal.organizationId, injuryId);
  if (!injury) throw new NotFoundError('Injury record not found.');
  try {
    await assertStanding(principal, injury.athlete_id);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Forbidden')) {
      throw new NotFoundError('Injury record not found.');
    }
    throw error;
  }
  return injury;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_PHI_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim() ?? '';
    if (!athleteId) throw new ValidationError('athlete_id is required.');
    await assertStanding(principal, athleteId);

    const [injuries, candidates] = await Promise.all([
      listInjuriesForAthlete(principal.organizationId, athleteId),
      listLinkCandidates(principal.organizationId, athleteId),
    ]);
    return NextResponse.json({ ok: true, injuries, candidates }, NO_STORE);
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_PHI_ROLES]);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') throw new ValidationError('Missing request body.');
    const action = str(body, 'action');

    // Which of the given athletes this principal may open here, so the page
    // offers only those: the roster a coach reads is the whole gym, and this
    // route admits only the athletes they coach or cover. A read, sent as a
    // POST so a long roster never rides in a URL.
    if (action === 'accessible_athletes') {
      const ids = body.athlete_ids;
      if (!Array.isArray(ids) || ids.length > MAX_ROSTER_IDS || !ids.every((id) => typeof id === 'string')) {
        throw new ValidationError(`athlete_ids must be a list of at most ${MAX_ROSTER_IDS} ids.`);
      }
      const accessible = await accessibleAthleteIds(principal, ids as string[]);
      return NextResponse.json({ ok: true, athlete_ids: [...accessible] }, NO_STORE);
    }

    if (action === 'record') {
      const athleteId = str(body, 'athlete_id');
      if (!athleteId) throw new ValidationError('athlete_id is required.');
      await assertStanding(principal, athleteId);
      const injury = await recordInjury({
        ...injuryFields(body),
        organizationId: principal.organizationId,
        athleteId,
        recordedByAccountId: principal.accountId,
        recordedByRole: principal.role,
      });
      return NextResponse.json({ ok: true, injury }, NO_STORE);
    }

    if (action === 'update' || action === 'mark_entered_in_error') {
      const injuryId = str(body, 'injury_id');
      if (!injuryId) throw new ValidationError('injury_id is required.');
      await injuryWithStanding(principal, injuryId);

      if (action === 'update') {
        const injury = await updateInjury({
          organizationId: principal.organizationId,
          injuryId,
          fields: injuryFields(body),
          updatedByAccountId: principal.accountId,
        });
        return NextResponse.json({ ok: true, injury }, NO_STORE);
      }

      await markInjuryEnteredInError({
        organizationId: principal.organizationId,
        injuryId,
        updatedByAccountId: principal.accountId,
      });
      return NextResponse.json({ ok: true }, NO_STORE);
    }

    throw new ValidationError('action must be accessible_athletes, record, update or mark_entered_in_error.');
  } catch (error) {
    return jsonError(error);
  }
}
