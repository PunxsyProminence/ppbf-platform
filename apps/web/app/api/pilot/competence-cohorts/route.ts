import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import {
  getAthleteCohortReport,
  listCohortDefinitions,
  listCompetenceLevels,
} from '@/src/server/pilot/competenceCohorts';
import { parseSetAthleteCompetenceBody, setAthleteCompetence } from '@/src/server/pilot/competenceWrite';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// requireRole matches exactly, with no admin/organization_admin aliasing, so
// both spellings are listed. With 'admin' alone an organization admin signed in
// as one (ppbf@) was refused the athlete report its own access guard allows.
const STAFF_ROLES = ['coach', 'admin', 'organization_admin'] as const;

// GET is read-only. Two shapes, gated differently, because they carry different data.
//
// GET without athlete_id returns the gym's competence ladder and its cohort
// rules. That is policy, not athlete data -- any authenticated role may read
// it, and a parent seeing which rooms exist and what each one requires is the
// point of publishing the rules at all.
//
// GET with athlete_id returns one athlete's assessed levels, logged training
// and derived age. That IS athlete data, so it is restricted to coach and
// admin AND to the athletes that particular caller may reach. The role gate
// alone was not enough: athlete_id is caller-supplied, so any coach in the
// organization could read any athlete here -- including age_years, derived
// from the dob that entities.ts deliberately redacts from the same coach's
// roster. A parent-facing view of their own athlete would need its own route
// with a guardian-link check; it is deliberately not bolted on here, because
// widening this handler is exactly how an athlete-data leak gets introduced.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);

    const { searchParams } = new URL(request.url);
    const athleteId = searchParams.get('athlete_id');
    const discipline = searchParams.get('discipline') ?? undefined;

    if (athleteId) {
      requireRole(principal, [...STAFF_ROLES]);
      await assertActorCanAccessAthlete(principal, athleteId);

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

// POST sets one athlete's level in one domain (OD-2026-10-03-002 section 6).
// Body: { athlete_id, domain, level_key, evidence_note? }. The organization is
// the principal's, never the body's. setAthleteCompetence checks the role and
// runs assertActorCanAccessAthlete itself; the role gate here only refuses
// other roles before the body is read. Returns the refreshed report, so the
// screen shows the rooms the new level puts the athlete in.
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...STAFF_ROLES]);

    const body: unknown = await request.json().catch(() => null);
    const input = parseSetAthleteCompetenceBody(body);

    const result = await setAthleteCompetence(principal, input);
    const report = await getAthleteCohortReport(principal.organizationId, input.athleteId);
    return NextResponse.json({ result, report });
  } catch (error) {
    return jsonError(error);
  }
}
