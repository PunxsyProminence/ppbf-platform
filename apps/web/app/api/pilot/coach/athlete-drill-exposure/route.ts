import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { getAthleteDrillExposure, resolveExposureWindow } from '@/src/server/pilot/athleteDrillExposure';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// One athlete's drill exposure totals over a chosen window. Read-only staff surface; the totals
// themselves are documented in athleteDrillExposure.ts.
//
// TWO GATES, IN ORDER, same as coach/athlete-intelligence. The role list says staff may read
// exposure; assertActorCanAccessAthlete says WHICH athlete -- a coach reaches only athletes they
// coach or cover, an organization admin only live athletes in their own gym, and a deleted athlete
// is refused for everyone. It runs before the window is parsed so a refused caller learns nothing,
// not even whether their dates were valid.
//
// The organization is the principal's own; there is no organization_id parameter.

const DRILL_EXPOSURE_ROLES = ['coach', 'organization_admin', 'admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DRILL_EXPOSURE_ROLES]);

    const params = request.nextUrl.searchParams;
    const athleteId = params.get('athlete_id')?.trim();
    if (!athleteId) throw new ValidationError('Missing athlete_id.');
    await assertActorCanAccessAthlete(principal, athleteId);

    const window = resolveExposureWindow({ from: params.get('from'), to: params.get('to') });
    const exposure = await getAthleteDrillExposure({
      organizationId: principal.organizationId,
      athleteId,
      window,
    });
    return NextResponse.json(exposure);
  } catch (error) {
    return jsonError(error);
  }
}
