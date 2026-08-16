import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getTransferReadout } from '@/src/server/pilot/falseProgress';

export const runtime = 'nodejs';

// Transfer check (module 053, false-progress detection). Read-only staff
// surface: deterministic flags over one athlete's own targeted attempts,
// raw counts attached to every flag. Nothing here writes, scores, or
// decides -- a flag is a reason for a coach to look, not a verdict about
// an athlete.

const TRANSFER_ROLES = ['coach', 'organization_admin', 'admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...TRANSFER_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim();
    if (!athleteId) throw new ValidationError('Missing athlete_id.');

    const items = await getTransferReadout(principal.organizationId, athleteId);
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}
