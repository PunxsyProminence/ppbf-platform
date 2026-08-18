// GET /api/pilot/shadow/film-study/validation — how often coaches actually
// accept what the Film Study vision model proposes.
//
// The proposals table has been recording both halves of a measurement since it
// shipped -- the model's claim and the coach's verdict -- and nothing ever
// divided one by the other. This is that division. Every settled proposal is a
// labelled example produced by this gym's coaches on this gym's footage, which
// is a better validation set than any published benchmark: a paper's accuracy
// figure describes somebody else's athletes, camera and room.
//
// It reports on the MODEL, never on an athlete. No athlete id is read, no
// per-athlete breakdown is offered, and nothing here is a skill score. A low
// accept rate means the queue wastes a coach's time; a high one means it is
// worth opening.
//
// Read-only, and organization-scoped from the session rather than the query
// string, so there is no shape of request that reaches another gym's numbers.
import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import {
  describeFilmStudyValidation,
  getFilmStudyValidation,
} from '@/src/server/pilot/filmStudyValidation';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// The same roles that can settle a proposal can see how the settling has gone.
// A coach clearing this queue is the one producing the measurement, so keeping
// the result from them would be perverse. platform_owner stays absent for the
// same reason it is absent on the proposals route itself.
const VALIDATION_READER_ROLES = ['coach', 'organization_admin', 'admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...VALIDATION_READER_ROLES]);

    const report = await getFilmStudyValidation(principal.organizationId);

    return NextResponse.json({
      ok: true,
      validation: report,
      // The one-line reading, built server-side so every surface says the
      // sample size in the same breath as the rate rather than each client
      // re-deciding how to phrase a thin sample.
      summary: describeFilmStudyValidation(report),
    });
  } catch (error) {
    return jsonError(error);
  }
}
