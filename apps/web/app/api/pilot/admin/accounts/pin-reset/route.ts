import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { activateAccountPin, resetAccountPin } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';
import { generateStartingPin } from '@/src/server/pilot/pinPolicy';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    // Athlete credentials sit outside the platform owner tier: Omega's job is
    // to gather data and support organization admins, not to hold the keys to
    // an individual athlete's account. Same boundary as session revocation.
    requireRole(principal, ['organization_admin']);
    if (!isOrganizationAdminRole(principal.role)) {
      throw new Error('Forbidden: role not allowed');
    }

    const body = (await request.json()) as { account_id?: string; pin?: string; mode?: 'activate' | 'reset' };
    const accountId = body.account_id?.trim() || '';
    const suppliedPin = body.pin?.trim() || '';
    const mode = body.mode === 'activate' ? 'activate' : 'reset';

    if (!accountId) {
      throw new Error('Missing account_id');
    }

    // An omitted pin means "issue one for this athlete", which is what the
    // People tab asks for -- it used to send the shared 123456 from the client,
    // and there is no shared value to send any more. The PIN console still sends
    // an explicit pin when an admin has typed one, and that path is unchanged.
    const generated = suppliedPin === '';
    const pin = generated ? generateStartingPin() : suppliedPin;

    if (mode === 'activate') {
      await activateAccountPin(accountId, pin, principal.organizationId);
    } else {
      await resetAccountPin(accountId, pin, principal.organizationId);
    }

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'account',
      entity_id: accountId,
      // Never the PIN itself -- it is a live credential for a child's account,
      // and audit details are mirrored into SHADOW's event stream.
      details: { action: mode === 'activate' ? 'pin_activate' : 'pin_reset', pin_source: generated ? 'issued' : 'chosen_by_admin' },
    });

    // Returned only when this route generated it. An admin who typed their own
    // PIN already knows it, and echoing a credential that did not need to travel
    // back is a second copy for no reason.
    return NextResponse.json({
      ok: true,
      account_id: accountId,
      mode,
      ...(generated ? { starting_pin: pin } : {}),
    });
  } catch (error) {
    return jsonError(error);
  }
}
