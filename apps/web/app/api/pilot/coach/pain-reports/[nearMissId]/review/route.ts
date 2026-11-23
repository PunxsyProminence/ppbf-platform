import { NextResponse, type NextRequest } from 'next/server';

import { getStaffDisplayName } from '@/src/server/pilot/achievements';
import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { NotFoundError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { markPainReportReviewed } from '@/src/server/pilot/painReportNotes';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { DECISION_LOOP_ROLES } from '@/src/server/pilot/shadowRoleSets';

export const runtime = 'nodejs';

const REQUIRED_TABLES = ['shadow_near_misses', 'shadow_audit_entries'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteContext {
  params: Promise<{ nearMissId: string }>;
}

/**
 * "Mark reviewed" on one pain report (DR-25; Jason 2026-11-23, DR-25 A, to be recorded).
 *
 * THE SAME GATE AS THE READ (Overwatch GO on #2133, Q1 A): the decision-loop roles (coach,
 * organization_admin, admin), then assertActorCanAccessAthlete for the report's own athlete. A
 * report that does not exist, belongs to another gym, is not a pain report, or is about an athlete
 * the caller may not reach all answer the same 404, so the route cannot be used to learn that a
 * report exists. A failure of the access check itself (the database, not a refusal) surfaces as an
 * error, as on the list.
 *
 * FIRST REVIEW WINS: a second press answers with the first reviewer and time, unchanged. The
 * answer names the reviewer by their staff name at this gym, never by account id.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DECISION_LOOP_ROLES]);

    const { nearMissId } = await context.params;
    if (!UUID.test(nearMissId)) {
      return hiddenNotFound();
    }

    await assertShadowRuntimeReadiness({ requiredTables: REQUIRED_TABLES });

    const result = await markPainReportReviewed({
      organizationId: principal.organizationId,
      nearMissId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      authorize: async (athleteId) => {
        try {
          await assertActorCanAccessAthlete(principal, athleteId);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('Forbidden')) {
            throw new NotFoundError('Pain report not found.', 'PAIN_REPORT_NOT_FOUND');
          }
          throw error;
        }
      },
    });

    const byName = result.reviewedByAccountId === null
      ? null
      : await getStaffDisplayName(principal.organizationId, result.reviewedByAccountId);

    return NextResponse.json(
      { ok: true, reviewed: { at: result.reviewedAt, byName } },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (error) {
    if (error instanceof NotFoundError) {
      return hiddenNotFound();
    }
    return jsonError(error);
  }
}
