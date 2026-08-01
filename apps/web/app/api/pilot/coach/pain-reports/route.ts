import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import {
  PAIN_REPORT_ALERT_WINDOW_DAYS,
  listAthletesWithRecentPainReports,
  listPainReportsForAthletes,
} from '@/src/server/pilot/formulas/painReportAlert';
import { jsonError, parseSafeLimit, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { DECISION_LOOP_ROLES } from '@/src/server/pilot/shadowRoleSets';

export const runtime = 'nodejs';

const REQUIRED_TABLES = ['shadow_near_misses'];

/**
 * Every recent pain report the caller is authorized to see, named.
 *
 * This is one minor's identifiable health information, so the role gate is the
 * decision-loop set -- board and platform_owner are absent by construction, and
 * assertActorCanAccessAthlete refuses them a second time below. The athlete
 * list is resolved first and filtered per athlete, so an unauthorized coach
 * receives no field of any kind about a report and cannot learn it exists.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DECISION_LOOP_ROLES]);

    const limit = parseSafeLimit(request.nextUrl.searchParams.get('limit'), 25, 50);
    if (limit === null) {
      return NextResponse.json({ ok: false, error: 'limit is invalid.' }, { status: 400 });
    }

    await assertShadowRuntimeReadiness({ requiredTables: REQUIRED_TABLES });

    const candidates = await listAthletesWithRecentPainReports(
      principal.organizationId,
      PAIN_REPORT_ALERT_WINDOW_DAYS,
    );

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
      // failing part-way through the check -- has to surface as a failed read,
      // because a silently shortened list of children in pain is
      // indistinguishable from no children in pain.
      const reason: unknown = decision.reason;
      if (!(reason instanceof Error) || !reason.message.startsWith('Forbidden')) {
        throw reason;
      }
    }

    const page = await listPainReportsForAthletes(principal.organizationId, authorized, {
      windowDays: PAIN_REPORT_ALERT_WINDOW_DAYS,
      limit,
    });

    return NextResponse.json(
      {
        ok: true,
        windowDays: PAIN_REPORT_ALERT_WINDOW_DAYS,
        truncated: page.truncated,
        painReports: page.reports,
      },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
