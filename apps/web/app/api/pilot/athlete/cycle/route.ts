import { NextResponse, type NextRequest } from 'next/server';

import { assertAthleteBelongsToOrganization, requireRole } from '@/src/server/pilot/access';
import {
  addCycleEntry,
  cycleDayError,
  getCycleTracking,
  removeCycleEntry,
  turnOffCycleTracking,
  turnOnCycleTracking,
} from '@/src/server/pilot/athleteCycle';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// Cycle tracking (OD-2026-10-17-023 item 4). THE ATHLETE'S ALONE: athlete
// role only, their own record via the athlete id bound to their session --
// there is no athlete_id parameter, and no other role has a path here or
// anywhere else (cycleTrackingAthleteOnly.test.ts). No audit row is written:
// one would itself tell an admin a child logged a period. See athleteCycle.ts.

async function requireOwnAthleteId(principal: { organizationId: string; athleteId?: string | null }): Promise<string> {
  if (!principal.athleteId) throw new ValidationError('This account is not linked to an athlete record.');
  // A session that outlived the athlete's deletion carries the same id; the
  // live row is required too (OD-2026-09-29-002 item 10).
  await assertAthleteBelongsToOrganization(principal.organizationId, principal.athleteId);
  return principal.athleteId;
}

function view(tracking: Awaited<ReturnType<typeof getCycleTracking>>) {
  return { opted_in: tracking.optedIn, entries: tracking.entries };
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['athlete']);
    const athleteId = await requireOwnAthleteId(principal);
    return NextResponse.json(view(await getCycleTracking(principal.organizationId, athleteId)));
  } catch (error) {
    return jsonError(error);
  }
}

/** One action per request: turn_on, turn_off (deletes every date), add (a day, or today), remove. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['athlete']);
    const athleteId = await requireOwnAthleteId(principal);
    const organizationId = principal.organizationId;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    switch (body.action) {
      case 'turn_on':
        if (!(await turnOnCycleTracking(organizationId, athleteId))) return hiddenNotFound();
        break;
      case 'turn_off':
        await turnOffCycleTracking(organizationId, athleteId);
        break;
      case 'add': {
        if (body.day !== undefined) {
          const problem = cycleDayError(body.day);
          if (problem) throw new ValidationError(problem);
        }
        const added = await addCycleEntry(organizationId, athleteId, body.day as string | undefined);
        if (added === null) return hiddenNotFound();
        if (added === 'off') throw new ValidationError('Turn cycle tracking on first.');
        break;
      }
      case 'remove':
        if (typeof body.entry_id !== 'string' || body.entry_id === '') throw new ValidationError('entry_id is required.');
        if (!(await removeCycleEntry(organizationId, athleteId, body.entry_id))) return hiddenNotFound();
        break;
      default:
        throw new ValidationError('action must be turn_on, turn_off, add or remove.');
    }
    return NextResponse.json(view(await getCycleTracking(organizationId, athleteId)));
  } catch (error) {
    return jsonError(error);
  }
}
