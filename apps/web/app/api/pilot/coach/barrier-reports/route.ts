import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { listAthletesWithBarrierReports, listBarrierReports } from '@/src/server/pilot/intake';
import { jsonError, parseSafeLimit, requirePrincipal } from '@/src/server/pilot/http';
import { DECISION_LOOP_ROLES } from '@/src/server/pilot/shadowRoleSets';

export const runtime = 'nodejs';

/**
 * Every barrier report the caller is authorized to see, named -- the read
 * side of ParentHub's "Sent to your child's coach", which was a write-only
 * promise until this route existed.
 *
 * Same authorization shape as /api/pilot/coach/pain-reports: a guardian's
 * report that something at home is in the way of a minor's training is
 * family-sensitive information, so the role gate is the decision-loop set
 * and the athlete list is resolved first and filtered per athlete -- an
 * unauthorized coach receives no field of any kind about a report and
 * cannot learn it exists.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DECISION_LOOP_ROLES]);

    const limit = parseSafeLimit(request.nextUrl.searchParams.get('limit'), 25, 50);
    if (limit === null) {
      return NextResponse.json({ ok: false, error: 'limit is invalid.' }, { status: 400 });
    }

    const candidates = await listAthletesWithBarrierReports(principal.organizationId);

    const decisions = await Promise.allSettled(
      candidates.map((athleteId) => assertActorCanAccessAthlete(principal, athleteId)),
    );

    const authorized: string[] = [];
    for (const [index, decision] of decisions.entries()) {
      if (decision.status === 'fulfilled') {
        authorized.push(candidates[index]);
        continue;
      }

      // Only a refusal filters an athlete out. Anything else -- the database
      // failing part-way through the check -- has to surface as a failed
      // read, because a silently shortened list of families asking for help
      // is indistinguishable from no families asking for help.
      const reason: unknown = decision.reason;
      if (!(reason instanceof Error) || !reason.message.startsWith('Forbidden')) {
        throw reason;
      }
    }

    const page = await listBarrierReports(principal.organizationId, authorized, limit);

    return NextResponse.json(
      {
        ok: true,
        truncated: page.truncated,
        barrierReports: page.reports,
      },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
