import { NextResponse, type NextRequest } from 'next/server';

import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import { getOrganizationSafetyReview } from '@/src/server/pilot/safetyReview';

export const runtime = 'nodejs';

/**
 * Capability #75: THE ROLLED-UP SAFETY REVIEW, admin-only.
 *
 * See safetyReview.ts's own header for why this is a read-side rollup over
 * four already-existing systems (holds, gates, escalations, compliance
 * violations) rather than a new unified table.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'organization_admin']);

    const review = await getOrganizationSafetyReview(principal.organizationId);

    return NextResponse.json({ ok: true, ...review });
  } catch (error) {
    return jsonError(error);
  }
}
