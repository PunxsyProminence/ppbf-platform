import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { provisionAthleteActivation } from '@/src/server/pilot/activation';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { sanitizedSqlState } from '@/src/server/pilot/db';
import { jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// Provisioning and code issuance have already committed together before this
// runs. An audit outage must not hide the only plaintext copy of that code and
// strand the inactive account; log only a sanitized SQLSTATE and return it.
async function auditCreate(event: Parameters<typeof writePilotAuditEvent>[0]): Promise<void> {
  try { await writePilotAuditEvent(event); } catch (error) {
    const raw = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
    const code = sanitizedSqlState(raw);
    console.error({ event: 'pilot-athlete-activation-audit-write-failed', ...(code ? { code } : {}) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    // Athlete credentials sit outside the platform-owner tier, the same
    // boundary session revocation and PIN reset hold: Omega gathers data and
    // supports organization admins rather than holding the keys to a child's
    // account. This route returns every athlete's name in the organization,
    // which is precisely what access.ts refuses that role everywhere else.
    requireRole(principal, ['organization_admin']);
    if (!isOrganizationAdminRole(principal.role)) {
      throw new Error('Forbidden: role not allowed');
    }

    const body = (await request.json()) as {
      account_id?: string;
      athlete_id?: string;
    };

    const accountId = body.account_id?.trim() || '';
    const athleteId = body.athlete_id?.trim() || '';

    if (!accountId || !athleteId) {
      throw new Error('Missing account_id or athlete_id');
    }

    const activation = await provisionAthleteActivation({
      accountId, athleteId, organizationId: principal.organizationId,
      issuedByAccountId: principal.accountId, issuedByRole: principal.role, mode: 'create',
    });

    await auditCreate({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'athlete_account',
      entity_id: accountId,
      details: { athlete_id: athleteId, account_state: 'pending_activation' },
    });

    return NextResponse.json({ ok: true, account_id: accountId, athlete_id: athleteId, account_state: 'pending_activation', activation_code: activation.code, expires_at: activation.expiresAt });
  } catch (error) {
    return jsonError(error);
  }
}
