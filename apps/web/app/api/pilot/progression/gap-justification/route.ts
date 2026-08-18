import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { getAthleteGapDetectionSources } from '@/src/server/pilot/progression';
import { getGapJustifications } from '@/src/server/pilot/progressionSuggestions';
import { requirePrincipal, requireRole, jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// A narrow, additive slice of the Performance Analytics rollup
// (performanceAnalytics.ts), scoped to exactly the fields that justify a
// progression gap the caller can already see -- see progressionSuggestions.ts
// ("GAP JUSTIFICATION") for the full reasoning and the field allowlist.
//
// This is NOT the staff analytics endpoint (GET /api/pilot/analytics/
// performance, still coach/admin/organization_admin only, unchanged by this
// route). It never returns the rollup itself, never accepts a roster, and
// never accepts a window_days override: one athlete, authorised through the
// same assertActorCanAccessAthlete gate every other progression route uses,
// and only the rule-specific numbers behind their own confirmed gaps.
//
// Role set mirrors GET /api/pilot/progression/gaps deliberately: this
// endpoint answers "why" for gaps that role set can already read "what" for.
// A gap with no deterministic rule behind it (a coach's manual observation)
// contributes nothing here -- there is no analytics to restate.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin', 'athlete', 'parent']);

    const athleteId = request.nextUrl.searchParams.get('athlete_id');
    const status = request.nextUrl.searchParams.get('status');

    if (!athleteId) {
      throw new Error('Missing athlete_id');
    }

    await assertActorCanAccessAthlete(principal, athleteId);

    const sources = await getAthleteGapDetectionSources(principal.organizationId, athleteId, status || undefined);
    const items = await getGapJustifications(principal.organizationId, athleteId, sources);

    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}
