import { NextResponse, type NextRequest } from 'next/server';

import { resolvePrincipal } from '@/src/server/pilot/auth';
import { jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

async function handleSession(request: NextRequest) {
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
      auth_provider: principal.authProvider,
      authProvider: principal.authProvider,
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  return handleSession(request);
}

export async function GET(request: NextRequest) {
  return handleSession(request);
}
