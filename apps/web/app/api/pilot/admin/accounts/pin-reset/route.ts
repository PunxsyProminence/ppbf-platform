import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { resetAccountPin } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin']);

    const body = (await request.json()) as { account_id?: string; pin?: string };
    const accountId = body.account_id?.trim() || '';
    const pin = body.pin?.trim() || '';

    if (!accountId || !pin) {
      throw new Error('Missing account_id or pin');
    }

    await resetAccountPin(accountId, pin);

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      entity_type: 'account',
      entity_id: accountId,
      details: { action: 'pin_reset' },
    });

    return NextResponse.json({ ok: true, account_id: accountId });
  } catch (error) {
    return jsonError(error);
  }
}
