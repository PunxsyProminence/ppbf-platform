import { NextResponse, type NextRequest } from 'next/server';

import { resolvePrincipal } from '@/src/server/pilot/auth';
import { jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function noStoreJson(body: Record<string, unknown>) {
  const response = NextResponse.json(body);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export async function POST(request: NextRequest) {
  try {
    const principal = await resolvePrincipal(request);
    if (!principal) {
      return noStoreJson({ authenticated: false });
    }

    return noStoreJson({
      authenticated: true,
      account_id: principal.accountId,
      role: principal.role,
      organization_id: principal.organizationId,
      athlete_id: principal.athleteId,
      auth_provider: principal.authProvider,
      // Reported so the client can route to /change-pin. This route
      // deliberately uses resolvePrincipal rather than requirePrincipal: if it
      // refused mid-bootstrap sessions the session gate would read the account
      // as signed out and bounce it to /login, which is the one place that
      // cannot resolve the situation.
      must_change_pin: principal.mustChangePin,
    });
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }
}
