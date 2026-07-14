import { NextResponse, type NextRequest } from 'next/server';

import { createOrRotateAdminAccount } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const bootstrapKey = process.env.PPBF_PILOT_BOOTSTRAP_KEY?.trim() || '';
    const providedKey = request.headers.get('x-ppbf-bootstrap-key')?.trim() || '';

    if (!bootstrapKey) {
      throw new Error('Missing PPBF_PILOT_BOOTSTRAP_KEY');
    }

    if (!providedKey || providedKey !== bootstrapKey) {
      throw new Error('Forbidden: invalid bootstrap key');
    }

    const body = (await request.json()) as { account_id?: string; pin?: string };
    const accountId = body.account_id?.trim() || '';
    const pin = body.pin?.trim() || '';

    if (!accountId || !pin) {
      throw new Error('Missing account_id or pin');
    }

    await createOrRotateAdminAccount(accountId, pin);

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: accountId,
      actor_role: 'admin',
      entity_type: 'account',
      entity_id: accountId,
      details: { action: 'bootstrap_admin' },
    });

    return NextResponse.json({ ok: true, account_id: accountId });
  } catch (error) {
    return jsonError(error);
  }
}
