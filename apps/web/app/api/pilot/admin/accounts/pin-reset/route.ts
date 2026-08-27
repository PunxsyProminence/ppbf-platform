import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { provisionAthleteActivation } from '@/src/server/pilot/activation';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { sanitizedSqlState } from '@/src/server/pilot/db';
import { jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// Reset, revocation and replacement-code issuance have already committed as
// one transaction. A later audit outage cannot turn that into a retry that
// supersedes the only code the admin saw; report success and log no identity.
async function auditReset(event: Parameters<typeof writePilotAuditEvent>[0]): Promise<void> {
  try { await writePilotAuditEvent(event); } catch (error) {
    const raw = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
    const code = sanitizedSqlState(raw);
    console.error({ event: 'pilot-athlete-reactivation-audit-write-failed', ...(code ? { code } : {}) });
  }
}

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

    const body = (await request.json()) as { account_id?: string };
    const accountId = body.account_id?.trim() || '';

    if (!accountId) {
      throw new Error('Missing account_id');
    }

    const activation = await provisionAthleteActivation({ accountId, organizationId: principal.organizationId,
      issuedByAccountId: principal.accountId, issuedByRole: principal.role, mode: 'reset' });

    await auditReset({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'account',
      entity_id: accountId,
      details: { action: 'activation_reissue' },
    });

    return NextResponse.json({ ok: true, account_id: accountId, mode: 'activation_reissue', activation_code: activation.code, expires_at: activation.expiresAt });
  } catch (error) {
    return jsonError(error);
  }
}
