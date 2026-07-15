import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { query } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach', 'athlete', 'parent']);

    const body = (await request.json()) as { athlete_id?: string };
    const athleteId = body.athlete_id?.trim() || '';
    if (!athleteId) {
      throw new Error('Missing athlete_id');
    }

    await assertActorCanAccessAthlete(principal, athleteId);

    const [emergencyContacts, medicalIntake, waivers, assessments, attendance, readiness, coachObservations, guardians] = await Promise.all([
      query('select * from pilot.emergency_contacts where organization_id = $1 and athlete_id = $2 order by created_at desc', [principal.organizationId, athleteId]),
      query('select * from pilot.medical_intake where organization_id = $1 and athlete_id = $2 order by created_at desc', [principal.organizationId, athleteId]),
      query('select * from pilot.waivers where organization_id = $1 and athlete_id = $2 order by created_at desc', [principal.organizationId, athleteId]),
      query('select * from pilot.assessments where organization_id = $1 and athlete_id = $2 order by created_at desc', [principal.organizationId, athleteId]),
      query('select * from pilot.attendance where organization_id = $1 and athlete_id = $2 order by attendance_date desc', [principal.organizationId, athleteId]),
      query('select * from pilot.readiness where organization_id = $1 and athlete_id = $2 order by measured_at desc', [principal.organizationId, athleteId]),
      query('select * from pilot.coach_observations where organization_id = $1 and athlete_id = $2 order by created_at desc', [principal.organizationId, athleteId]),
      query(
        `select p.*, g.relationship_to_athlete
         from pilot.guardian_links g
         join pilot.parents p
           on p.organization_id = g.organization_id
          and p.parent_id = g.parent_id
        where g.organization_id = $1 and g.athlete_id = $2`,
        [principal.organizationId, athleteId],
      ),
    ]);

    return NextResponse.json({
      ok: true,
      athlete_id: athleteId,
      emergency_contacts: emergencyContacts,
      medical_intake: medicalIntake,
      waivers,
      assessments,
      attendance,
      readiness,
      coach_observations: coachObservations,
      guardians,
    });
  } catch (error) {
    return jsonError(error);
  }
}
