import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { query } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  assessmentColumnsForReader,
  coachObservationNoteTypesForReader,
  emergencyContactColumnsForReader,
  attendanceColumnsForReader,
  guardianColumnsForReader,
  medicalIntakeColumnsForReader,
  readinessColumnsForReader,
  waiverColumnsForReader,
} from '@/src/server/pilot/intake';

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

    // pilot.coach_observations is a shared bus, and this route read all of
    // it. `pilot.coach_observations.note_type` carries guardian-authored
    // 'home_barrier' / 'transportation_barrier' rows written by
    // /api/pilot/parent/barrier-report -- a guardian describing home
    // circumstances to a coach in confidence -- alongside staff notes and
    // 'parent_message'. This route admits the athlete and every linked
    // guardian, so an unfiltered `select *` handed the child, and the other
    // household, a report neither was ever the audience for.
    //
    // Same discipline intake.ts#listParentMessages already applies one
    // filter over: a reader must not receive note types that were never
    // meant for them. The per-role sets, and the reasoning behind each, live
    // next to that one in intake.ts.
    const readableNoteTypes = coachObservationNoteTypesForReader(principal.role);
    const guardianColumns = guardianColumnsForReader(principal.role);
    const emergencyContactColumns = emergencyContactColumnsForReader(principal.role);
    const waiverColumns = waiverColumnsForReader(principal.role);
    const medicalIntakeColumns = medicalIntakeColumnsForReader(principal.role);
    const attendanceColumns = attendanceColumnsForReader(principal.role);
    const assessmentColumns = assessmentColumnsForReader(principal.role);
    const readinessColumns = readinessColumnsForReader(principal.role);

    const [emergencyContacts, medicalIntake, waivers, assessments, attendance, readiness, coachObservations, guardians] = await Promise.all([
      // The other half of the guardian narrowing below, and it has to be here
      // or that narrowing achieves nothing: the other parent is the ordinary
      // emergency contact, so `select *` on this table handed one household
      // the other's NOT NULL phone, their email, and the free-text notes --
      // keyed by a full_name that the guardians list right below supplies.
      // Two fields of one response body reassembled the disclosure. See
      // emergencyContactColumnsForReader for the per-role sets.
      query(
        `select ${emergencyContactColumns.join(', ')} from pilot.emergency_contacts
         where organization_id = $1 and athlete_id = $2 order by created_at desc`,
        [principal.organizationId, athleteId],
      ),
      // The fourth table in this body with a staff free-text `notes`, and the
      // reader here may be the CHILD -- this route admits 'athlete', which
      // access.ts resolves to a strict self-read. See
      // medicalIntakeColumnsForReader for what each role keeps.
      query(
        `select ${medicalIntakeColumns.join(', ')} from pilot.medical_intake
         where organization_id = $1 and athlete_id = $2 order by created_at desc`,
        [principal.organizationId, athleteId],
      ),
      // The third table of this body with a free-text staff note beside a
      // guardian's name. pilot.waivers carries signed_by_name and, since the
      // guardian-media-consent migration, parent_id -- so a note on the other
      // parent's waiver arrived already keyed to them. See
      // waiverColumnsForReader for what each role keeps.
      query(
        `select ${waiverColumns.join(', ')} from pilot.waivers
         where organization_id = $1 and athlete_id = $2 order by created_at desc`,
        [principal.organizationId, athleteId],
      ),
      // The one table in this body whose column count more than doubled AFTER
      // both of its reads were written -- seven columns became eighteen, and
      // both reads were still `select *`. See assessmentColumnsForReader for
      // the four that move to staff and the stated harm for each.
      query(
        `select ${assessmentColumns.join(', ')} from pilot.assessments
         where organization_id = $1 and athlete_id = $2 order by created_at desc`,
        [principal.organizationId, athleteId],
      ),
      query(
        `select ${attendanceColumns.join(', ')} from pilot.attendance
         where organization_id = $1 and athlete_id = $2 order by attendance_date desc`,
        [principal.organizationId, athleteId],
      ),
      // Same shape, a different migration. Only the staff account identifier
      // moves; see readinessColumnsForReader for what is left open and why.
      query(
        `select ${readinessColumns.join(', ')} from pilot.readiness
         where organization_id = $1 and athlete_id = $2 order by measured_at desc`,
        [principal.organizationId, athleteId],
      ),
      query(
        `select * from pilot.coach_observations
         where organization_id = $1
           and athlete_id = $2
           and ($3::text[] is null or note_type = any($3::text[]))
         order by created_at desc`,
        [principal.organizationId, athleteId, readableNoteTypes],
      ),
      // `select p.*` here handed every column of pilot.parents -- phone,
      // email, account_id -- to whoever passed the athlete gate above, and
      // that gate admits the athlete themself and EVERY linked guardian. One
      // household read the other household's contact details, and the child
      // read both. Same crossing the note_type filter above closes, arriving
      // through the column list instead of the row filter. See
      // guardianColumnsForReader for the per-role sets and why staff keep the
      // contact columns.
      query(
        `select ${guardianColumns.join(', ')}, g.relationship_to_athlete
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
