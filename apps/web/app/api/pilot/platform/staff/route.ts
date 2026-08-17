import { NextResponse, type NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requireMicrosoftAuthenticatedPrincipal, requireRole } from '@/src/server/pilot/http';
import {
  createOrUpdateMicrosoftStaffAccount,
  INVITABLE_STAFF_ROLES,
  isInvitableStaffRole,
  listOrganizationMembers,
  requireGuardianLinkForParentInvite,
  type GuardianAthleteLink,
} from '@/src/server/pilot/staffProvisioning';

export const runtime = 'nodejs';

// Lists every member of an organization. Platform-owner scoped, so the
// organization is an explicit parameter rather than the caller's own.
export async function GET(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    requireRole(principal, ['platform_owner']);

    const organizationId = request.nextUrl.searchParams.get('organization_id')?.trim() || '';
    if (!organizationId) {
      throw new Error('Missing organization_id');
    }

    const members = await listOrganizationMembers(organizationId);

    return NextResponse.json({ ok: true, organization_id: organizationId, members });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Provisions a Microsoft-authenticated staff account (coach, organization
 * admin, board, staff, volunteer, parent) in any organization.
 *
 * This does not send anything. It maps an email address onto a role, which is
 * what makes that person's Microsoft sign-in resolve to a PPBF session. The
 * invitee must separately exist in the PPBF Entra tenant -- as a member or a
 * B2B guest -- because the OAuth callback rejects any token whose tenant
 * claim does not match.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    requireRole(principal, ['platform_owner']);

    const body = (await request.json()) as {
      organization_id?: string;
      login_email?: string;
      role?: string;
      guardian?: {
        athlete_id?: string;
        full_name?: string;
        relationship_to_athlete?: string;
      };
      account_id?: string;
    };

    const organizationId = body.organization_id?.trim() || '';
    const loginEmail = body.login_email?.trim() || '';
    const role = body.role?.trim() || '';

    if (!organizationId || !loginEmail || !role) {
      throw new Error('Missing organization_id, login_email, or role');
    }

    if (!isInvitableStaffRole(role)) {
      throw new Error('Unsupported role');
    }

    const guardian: GuardianAthleteLink | undefined = body.guardian
      ? {
          athleteId: body.guardian.athlete_id ?? '',
          fullName: body.guardian.full_name ?? '',
          relationshipToAthlete: body.guardian.relationship_to_athlete ?? '',
        }
      : undefined;

    // The same rule the organization-admin invite holds. A parent account with
    // no guardian link signs in successfully and sees no children, and the
    // People console shows it as healthy -- so it has to be impossible from
    // every surface that can create one, not just the one an admin uses.
    requireGuardianLinkForParentInvite(role, guardian);

    const result = await createOrUpdateMicrosoftStaffAccount({
      loginEmail,
      organizationId,
      role,
      accountIdHint: body.account_id?.trim() || undefined,
      guardian,
      // This route is platform-owner only and provisions every invitable role,
      // including the organization_admin and board seats an org admin may not
      // touch. Stating that authority is required: the peer-protection guard
      // defaults to the org-admin set, which would refuse the owner a re-role
      // of the very accounts only this route can create.
      callerInvitableRoles: INVITABLE_STAFF_ROLES,
    });

    await writePilotAuditEvent({
      event_type: result.created ? 'create' : 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: organizationId,
      entity_type: 'account',
      entity_id: result.accountId,
      details: {
        action: 'platform_owner_provision_staff',
        role: result.role,
        login_email: result.loginEmail,
        auth_provider: 'microsoft',
        ...(result.volunteerLink ? { volunteer_id: result.volunteerLink.volunteerId } : {}),
      },
    });

    return NextResponse.json({
      ok: true,
      account_id: result.accountId,
      organization_id: result.organizationId,
      role: result.role,
      login_email: result.loginEmail,
      created: result.created,
      // Surfaced so the console can tell the operator the invite is only half
      // done until the identity exists in the tenant.
      requires_entra_guest_invite: true,
    });
  } catch (error) {
    return jsonError(error);
  }
}
