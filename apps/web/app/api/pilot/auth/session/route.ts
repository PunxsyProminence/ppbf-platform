import { NextResponse, type NextRequest } from 'next/server';

import { resolvePrincipal } from '@/src/server/pilot/auth';
import { jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await resolvePrincipal(request);
    if (!principal) {
      return NextResponse.json({ authenticated: false });
    }

    return NextResponse.json({
      authenticated: true,
      account_id: principal.accountId,
      role: principal.role,
      organization_id: principal.organizationId,
      athlete_id: principal.athleteId,
    });
  } catch (error) {
    return jsonError(error);
  }
}
