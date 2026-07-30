import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';
import {
  ORG_ADMIN_INVITABLE_ROLES,
  createOrUpdateMicrosoftStaffAccount,
  listOrganizationMembers,
  type InvitableStaffRole,
} from '@/src/server/pilot/staffProvisioning';

export const runtime = 'nodejs';

function assertOrgAdminInvitableRole(role: string): asserts role is InvitableStaffRole {
  if (!(ORG_ADMIN_INVITABLE_ROLES as string[]).includes(role)) {
    throw new Error('Unsupported role: organization admins can invite coach, staff, volunteer, or parent');
  }
}

// Lists the caller's own organization. The organization is taken from the
// session, never from the request, so an org admin cannot read another
// organization's roster by changing a parameter.
export async function GET(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    if (!isOrganizationAdminRole(principal.role)) {
      throw new Error('Forbidden: role not allowed');
    }

    const members = await listOrganizationMembers(principal.organizationId);

    return NextResponse.json({ ok: true, organization_id: principal.organizationId, members });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Lets an organization admin provision staff within their own organization.
 *
 * Two boundaries distinguish this from the platform route: the organization is
 * bound to the session, and organization_admin is not an invitable role here,
 * so an org admin can never unilaterally create another account holding their
 * own authority. Promoting someone to organization_admin remains a
 * platform_owner action.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    if (!isOrganizationAdminRole(principal.role)) {
      throw new Error('Forbidden: role not allowed');
    }

    const body = (await request.json()) as {
      login_email?: string;
      role?: string;
      account_id?: string;
    };

    const loginEmail = body.login_email?.trim() || '';
    const role = body.role?.trim() || '';

    if (!loginEmail || !role) {
      throw new Error('Missing login_email or role');
    }

    assertOrgAdminInvitableRole(role);

    const result = await createOrUpdateMicrosoftStaffAccount({
      loginEmail,
      organizationId: principal.organizationId,
      role,
      accountIdHint: body.account_id?.trim() || undefined,
    });

    await writePilotAuditEvent({
      event_type: result.created ? 'create' : 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'account',
      entity_id: result.accountId,
      details: {
        action: 'organization_admin_provision_staff',
        role: result.role,
        login_email: result.loginEmail,
        auth_provider: 'microsoft',
      },
    });

    return NextResponse.json({
      ok: true,
      account_id: result.accountId,
      organization_id: result.organizationId,
      role: result.role,
      login_email: result.loginEmail,
      created: result.created,
      requires_entra_guest_invite: true,
    });
  } catch (error) {
    return jsonError(error);
  }
}
