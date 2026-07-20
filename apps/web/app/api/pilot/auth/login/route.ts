import { NextResponse } from 'next/server';

import { loginWithAccountIdAndPin } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { PILOT_SESSION_COOKIE } from '@/src/server/pilot/env';
import { jsonError } from '@/src/server/pilot/http';
import type { PilotRole } from '@/src/server/pilot/contracts';

export const runtime = 'nodejs';

function mapAccountTypeToRole(accountType: string): PilotRole | null {
  switch (accountType?.toLowerCase()) {
    case 'admin':
      return 'admin';
    case 'coach':
      return 'coach';
    case 'athlete':
      return 'athlete';
    case 'parent':
      return 'parent';
    default:
      return null;
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { account_id?: string; pin?: string; account_type?: string };
    const accountId = body.account_id?.trim() || '';
    const pin = body.pin?.trim() || '';
    const requestedAccountType = body.account_type?.trim() || '';

    if (!accountId || !pin) {
      throw new Error('Missing account_id or pin');
    }

    const loginResult = await loginWithAccountIdAndPin(accountId, pin);
    if (!loginResult) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    // If account_type is specified, use it to override the role
    let finalRole = loginResult.principal.role;
    if (requestedAccountType) {
      const mappedRole = mapAccountTypeToRole(requestedAccountType);
      if (mappedRole) {
        finalRole = mappedRole;
      }
    }

    await writePilotAuditEvent({
      event_type: 'login',
      actor_account_id: loginResult.principal.accountId,
      actor_role: finalRole,
      organization_id: loginResult.principal.organizationId,
      entity_type: 'account',
      entity_id: loginResult.principal.accountId,
      details: { athlete_id: loginResult.principal.athleteId, requested_type: requestedAccountType },
    });

    const response = NextResponse.json({
      ok: true,
      account_id: loginResult.principal.accountId,
      role: finalRole,
      organization_id: loginResult.principal.organizationId,
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
