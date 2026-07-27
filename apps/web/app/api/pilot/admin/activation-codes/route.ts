import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import { issueActivationCode, listOutstandingActivationCodes } from '@/src/server/pilot/activation';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

export const runtime = 'nodejs';

/**
 * Resolves which organization the caller may act on.
 *
 * Organization admins only, pinned to their own organization.
 *
 * The platform owner is deliberately excluded, even though they outrank an
 * org admin everywhere else. An activation code is a bearer credential for one
 * named athlete: whoever holds it chooses that athlete's PIN and can then sign
 * in as them. Granting the platform owner the ability to mint one would be a
 * route around the boundary that assertActorCanAccessAthlete enforces --
 * platform owners do not reach organization-private athlete records.
 *
 * There is no bootstrap deadlock: a platform owner who needs this done
 * provisions an organization admin through /api/pilot/platform/staff, and that
 * admin issues codes for their own athletes.
 */
function resolveTargetOrganization(principal: PilotPrincipal, requestedOrganizationId: string): string {
  if (!isOrganizationAdminRole(principal.role)) {
    throw new Error('Forbidden: role not allowed');
  }

  if (requestedOrganizationId && requestedOrganizationId !== principal.organizationId) {
    throw new Error('Forbidden: cannot act on another organization');
  }

  return principal.organizationId;
}

// Lists athletes with an unclaimed code so an admin can see who still has not
// activated. Codes themselves are not recoverable -- only their status.
export async function GET(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    const organizationId = resolveTargetOrganization(
      principal,
      request.nextUrl.searchParams.get('organization_id')?.trim() || '',
    );

    const codes = await listOutstandingActivationCodes(organizationId);

    return NextResponse.json({ ok: true, organization_id: organizationId, codes });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Issues a one-time activation code for a pending athlete account.
 *
 * The plaintext code is returned exactly once, in this response, and is not
 * recoverable afterward -- only its hash is stored. Issuing a new code
 * supersedes any code previously handed out for the same athlete, which is
 * also how a mis-delivered code gets revoked.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);

    const body = (await request.json()) as {
      account_id?: string;
      organization_id?: string;
      ttl_hours?: number;
    };

    const accountId = body.account_id?.trim() || '';
    if (!accountId) {
      throw new Error('Missing account_id');
    }

    const organizationId = resolveTargetOrganization(principal, body.organization_id?.trim() || '');

    const issued = await issueActivationCode({
      accountId,
      organizationId,
      issuedByAccountId: principal.accountId,
      issuedByRole: principal.role,
      ttlHours: body.ttl_hours,
    });

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: organizationId,
      entity_type: 'account_activation_token',
      entity_id: accountId,
      details: {
        action: 'issue_activation_code',
        expires_at: issued.expiresAt,
        // The code itself is deliberately absent from the audit trail: an
        // audit reader must not be able to activate someone else's account.
      },
    });

    return NextResponse.json({
      ok: true,
      account_id: issued.accountId,
      organization_id: issued.organizationId,
      activation_code: issued.code,
      expires_at: issued.expiresAt,
      // Reminds the console (and anyone reading the response) that this value
      // is not retrievable again.
      code_is_shown_once: true,
    });
  } catch (error) {
    return jsonError(error);
  }
}
