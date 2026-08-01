import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import {
  isFeedbackRoute,
  isFeedbackTriageStatus,
  listOrganizationFeedback,
  listPlatformFeedback,
} from '@/src/server/pilot/feedback';
import { jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

/**
 * The triage read, and the only place either queue is served.
 *
 * Two scopes, and which one a caller gets is decided by their session role
 * alone -- there is no organization parameter, and no way to ask for the other
 * shape:
 *
 *   platform_owner   every gym, submitters de-identified by the query itself
 *   organization_admin / admin   their own gym, submitters named
 *
 * Every other role is refused outright. A coach, a parent, an athlete or a
 * board member reading this queue would be reading other people's submissions,
 * and on this platform some of those people are children writing about being
 * hurt.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    const payload = (await request.json().catch(() => ({}))) as {
      route?: unknown;
      triage_status?: unknown;
      limit?: unknown;
    };

    const route = typeof payload.route === 'string' && payload.route ? payload.route : null;
    const triageStatus =
      typeof payload.triage_status === 'string' && payload.triage_status ? payload.triage_status : null;
    const limit = typeof payload.limit === 'number' ? payload.limit : undefined;

    if (route !== null && !isFeedbackRoute(route)) {
      throw new Error('Unsupported route');
    }

    if (triageStatus !== null && !isFeedbackTriageStatus(triageStatus)) {
      throw new Error('Unsupported triage_status');
    }

    if (principal.role === 'platform_owner') {
      const items = await listPlatformFeedback({ route, triageStatus, limit });

      return NextResponse.json({ ok: true, scope: 'platform', items });
    }

    if (!isOrganizationAdminRole(principal.role)) {
      throw new Error('Forbidden: role not allowed');
    }

    const items = await listOrganizationFeedback(principal.organizationId, {
      route,
      triageStatus,
      limit,
    });

    return NextResponse.json({
      ok: true,
      scope: 'organization',
      organization_id: principal.organizationId,
      items,
    });
  } catch (error) {
    return jsonError(error);
  }
}
