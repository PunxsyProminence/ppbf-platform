import { NextResponse, type NextRequest } from 'next/server';

import { logoutWithToken } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { PILOT_SESSION_COOKIE } from '@/src/server/pilot/env';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const token = request.cookies.get(PILOT_SESSION_COOKIE)?.value;

    if (token) {
      await logoutWithToken(token);
    }

    await writePilotAuditEvent({
      event_type: 'logout',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'account',
      entity_id: principal.accountId,
      details: {},
    });

    const response = NextResponse.json({ ok: true });
    response.cookies.set(PILOT_SESSION_COOKIE, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 0,
    });

    return response;
  } catch (error) {
    return jsonError(error);
  }
}
