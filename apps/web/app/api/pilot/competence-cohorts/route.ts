import { NextResponse, type NextRequest } from 'next/server';

import {
  getAthleteCohortReport,
  listCohortDefinitions,
  listCompetenceLevels,
} from '@/src/server/pilot/competenceCohorts';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// Read-only. Two shapes, gated differently, because they carry different data.
//
// GET without athlete_id returns the gym's competence ladder and its cohort
// rules. That is policy, not athlete data -- any authenticated role may read
// it, and a parent seeing which rooms exist and what each one requires is the
// point of publishing the rules at all.
//
// GET with athlete_id returns one athlete's assessed levels, logged training
// and derived age. That IS athlete data, so it is restricted to coach and
// admin. A parent-facing view of their own athlete would need its own route
// with a guardian-link check; it is deliberately not bolted on here, because
// widening this handler is exactly how an athlete-data leak gets introduced.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);

    const { searchParams } = new URL(request.url);
    const athleteId = searchParams.get('athlete_id');
    const discipline = searchParams.get('discipline') ?? undefined;

    if (athleteId) {
      requireRole(principal, ['coach', 'admin']);

      const report = await getAthleteCohortReport(principal.organizationId, athleteId, { discipline });
      if (!report) {
        return NextResponse.json({ error: 'ATHLETE_NOT_FOUND' }, { status: 404 });
      }
      return NextResponse.json({ report });
    }

    const [levels, cohorts] = await Promise.all([
      listCompetenceLevels(principal.organizationId),
      listCohortDefinitions(principal.organizationId, {
        discipline,
        includeInactive: searchParams.get('include_inactive') === 'true',
      }),
    ]);
    return NextResponse.json({ levels, cohorts });
  } catch (error) {
    return jsonError(error);
  }
}
