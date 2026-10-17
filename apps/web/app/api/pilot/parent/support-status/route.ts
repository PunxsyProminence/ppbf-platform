// GET /api/pilot/parent/support-status?athlete_id -- one child's membership,
// scholarship and community-support standing, for the Parent Hub (PH-13).
// Parent only; the organization and account come from the session, never the
// request. The guardian link is checked on every request
// (parentSupportStatus.getSupportStatusForGuardian): a child not linked to
// this guardian now, 18 or older, deleted, or in another gym is the same 404.
// Never the scholarship percent or any note (Q-D A). Read only.
import { NextResponse, type NextRequest } from 'next/server';

import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import { getSupportStatusForGuardian } from '@/src/server/pilot/parentSupportStatus';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['parent']);

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim();
    if (!athleteId) throw new ValidationError('Missing athlete_id.');

    const status = await getSupportStatusForGuardian(principal.organizationId, principal.accountId, athleteId);
    return NextResponse.json({ ok: true, ...status });
  } catch (error) {
    return jsonError(error);
  }
}
