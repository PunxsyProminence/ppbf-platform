// POST /api/pilot/admin/accounts/repair-auth-provider — the remediation arm
// of the stranded-guardian finding.
//
// The pre-#46 intake path provisioned guardians as ppbf_local PIN accounts,
// which for a non-athlete is no login at all (PIN login is athlete-only,
// Microsoft login matches only provider 'microsoft', and any pre-existing
// local session is revoked on first use). #46 fixed provisioning going
// forward; the read-only check (check-database.yml → stranded-guardians)
// reports the rows still affected. This endpoint performs the repair the
// check's own notes prescribe: one account at a time, by explicit operator
// decision, flipping the provider so the account's login_email becomes
// matchable by the Microsoft callback. All the eligibility guards live in
// the SQL itself (repairStrandedGuardianAuthProvider) so an ineligible
// account refuses instead of half-repairing.
import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { repairStrandedGuardianAuthProvider } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    requireRole(principal, ['organization_admin', 'platform_owner']);

    const body = (await request.json().catch(() => ({}))) as { account_id?: string };
    const accountId = body.account_id?.trim() || '';
    if (!accountId) {
      throw new Error('Missing account_id');
    }

    const repaired = await repairStrandedGuardianAuthProvider(accountId, principal.organizationId);

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'account',
      entity_id: accountId,
      details: {
        action: 'auth_provider_repair',
        from_provider: 'ppbf_local',
        to_provider: 'microsoft',
        repaired_role: repaired.role,
      },
    });

    return NextResponse.json({
      ok: true,
      account_id: repaired.account_id,
      role: repaired.role,
      login_email: repaired.login_email,
      auth_provider: 'microsoft',
    });
  } catch (error) {
    return jsonError(error);
  }
}
