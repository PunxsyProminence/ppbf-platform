import { NextResponse, type NextRequest } from 'next/server';

import { getAthletesByOrganization } from '@/src/server/pilot/entities';
import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach', 'athlete']);

    const athletes = await getAthletesByOrganization(principal.organizationId);
    return NextResponse.json({ items: athletes });
  } catch (error) {
    return jsonError(error);
  }
}
