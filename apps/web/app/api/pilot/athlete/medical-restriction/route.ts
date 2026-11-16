import { NextResponse, type NextRequest } from 'next/server';

import { assertAthleteBelongsToOrganization, requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { familyMedicalRestriction } from '@/src/server/pilot/medicalRestrictions';

export const runtime = 'nodejs';

// The member's own USA Boxing medical restriction (lane P22c; Jason's card
// OW25-06 A): on file, minimum end date, release needed -- nothing else
// (familyMedicalRestriction builds exactly those three fields). SELF ONLY:
// the athlete id is the one bound to the session; there is no athlete_id
// parameter, and no other role has a path here (staff read the full record
// on /coach/medical-restrictions; a guardian reads it on /parent/safety).
// `medical_restriction` is null when nothing blocks today -- lifted, voided,
// not yet started or none -- and the member's screen then shows nothing.

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['athlete']);
    if (!principal.athleteId) {
      // An athlete login not linked to an athlete record has no restriction
      // to show (the same answer the training-holds route gives).
      return NextResponse.json({ ok: true, medical_restriction: null });
    }
    // A session that outlived the athlete's deletion carries the same id; the
    // live row is required too (OD-2026-09-29-002 item 10).
    await assertAthleteBelongsToOrganization(principal.organizationId, principal.athleteId);
    const restriction = await familyMedicalRestriction(principal.organizationId, principal.athleteId);
    return NextResponse.json({ ok: true, medical_restriction: restriction });
  } catch (error) {
    return jsonError(error);
  }
}
