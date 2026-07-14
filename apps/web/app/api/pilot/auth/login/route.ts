import { NextResponse } from 'next/server';

import { loginWithAccountIdAndPin } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { PILOT_SESSION_COOKIE } from '@/src/server/pilot/env';
import { jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { account_id?: string; pin?: string };
    const accountId = body.account_id?.trim() || '';
    const pin = body.pin?.trim() || '';

    if (!accountId || !pin) {
      throw new Error('Missing account_id or pin');
    }

    const loginResult = await loginWithAccountIdAndPin(accountId, pin);
    if (!loginResult) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    await writePilotAuditEvent({
      event_type: 'login',
      actor_account_id: loginResult.principal.accountId,
      actor_role: loginResult.principal.role,
      entity_type: 'account',
      entity_id: loginResult.principal.accountId,
      details: { athlete_id: loginResult.principal.athleteId },
    });

    const response = NextResponse.json({
      ok: true,
      account_id: loginResult.principal.accountId,
      role: loginResult.principal.role,
      athlete_id: loginResult.principal.athleteId,
    });

    response.cookies.set(PILOT_SESSION_COOKIE, loginResult.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    });

    return response;
  } catch (error) {
    return jsonError(error);
  }
}
