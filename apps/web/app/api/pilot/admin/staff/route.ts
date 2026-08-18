import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';
import {
  ORG_ADMIN_INVITABLE_ROLES,
  createOrUpdateMicrosoftStaffAccount,
  listOrganizationGuardianLinks,
  listOrganizationMembers,
  removeGuardianLink,
  requireGuardianLinkForParentInvite,
  type GuardianAthleteLink,
  type InvitableStaffRole,
  type VolunteerRosterAssignment,
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
//
// Guardian links ship with the roster rather than behind a second request:
// whether a parent account resolves any children is part of whether that row
// can be described as working at all, and a console that had the members but
// not the links would show a stranded guardian as healthy.
export async function GET(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    if (!isOrganizationAdminRole(principal.role)) {
      throw new Error('Forbidden: role not allowed');
    }

    const [members, guardianLinks] = await Promise.all([
      listOrganizationMembers(principal.organizationId),
      listOrganizationGuardianLinks(principal.organizationId),
    ]);

    return NextResponse.json({
      ok: true,
      organization_id: principal.organizationId,
      members,
      guardian_links: guardianLinks,
    });
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
 *
 * A parent invite additionally carries the athlete the guardian is responsible
 * for. That is what makes the account resolve a child; provisioning refuses
 * the role without it.
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
      guardian?: {
        athlete_id?: string;
        full_name?: string;
        relationship_to_athlete?: string;
      };
      volunteer?: {
        volunteer_id?: string;
        full_name?: string;
        role_focus?: string;
        availability?: string;
        certification_status?: string;
        background_check_status?: string;
        notes?: string | null;
      };
    };

    const loginEmail = body.login_email?.trim() || '';
    const role = body.role?.trim() || '';

    if (!loginEmail || !role) {
      throw new Error('Missing login_email or role');
    }

    assertOrgAdminInvitableRole(role);

    const guardian: GuardianAthleteLink | undefined = body.guardian
      ? {
          athleteId: body.guardian.athlete_id ?? '',
          fullName: body.guardian.full_name ?? '',
          relationshipToAthlete: body.guardian.relationship_to_athlete ?? '',
        }
      : undefined;

    // This route writes no guardian records of its own, so it must not be able
    // to mint a parent account that resolves nobody.
    requireGuardianLinkForParentInvite(role, guardian);

    // Optional -- createOrUpdateMicrosoftStaffAccount creates or links the
    // pilot.volunteers roster row for a volunteer invite regardless of
    // whether this is present, so a caller that sends nothing still gets the
    // account/roster link closed. This just lets a caller name a roster
    // detail, or an existing roster row to attach to, when it has one.
    const volunteer: VolunteerRosterAssignment | undefined = body.volunteer
      ? {
          volunteerId: body.volunteer.volunteer_id?.trim() || undefined,
          fullName: body.volunteer.full_name,
          roleFocus: body.volunteer.role_focus,
          availability: body.volunteer.availability,
          certificationStatus: body.volunteer.certification_status,
          backgroundCheckStatus: body.volunteer.background_check_status,
          notes: body.volunteer.notes,
        }
      : undefined;

    const result = await createOrUpdateMicrosoftStaffAccount({
      loginEmail,
      organizationId: principal.organizationId,
      role,
      accountIdHint: body.account_id?.trim() || undefined,
      guardian,
      volunteer,
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
        // Which minor an adult was given access to, and by whom, is the part
        // of this write a safeguarding review would ask about.
        ...(result.guardianLink
          ? {
              guardian_parent_id: result.guardianLink.parentId,
              guardian_athlete_id: result.guardianLink.athleteId,
            }
          : {}),
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
      guardian_link: result.guardianLink
        ? { parent_id: result.guardianLink.parentId, athlete_id: result.guardianLink.athleteId }
        : null,
      volunteer_link: result.volunteerLink ? { volunteer_id: result.volunteerLink.volunteerId } : null,
      requires_entra_guest_invite: true,
    });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Removes one guardian-to-athlete link, which is how a guardian linked to the
 * wrong child is corrected.
 *
 * Provisioning refuses to remove the last link an account holds, so this can
 * never be the step that strands a family: link the right athlete first, then
 * remove the wrong one.
 */
export async function DELETE(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
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

    const removed = await removeGuardianLink({
      organizationId: principal.organizationId,
      accountId,
      athleteId,
    });

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'account',
      entity_id: accountId,
      details: {
        action: 'organization_admin_remove_guardian_link',
        guardian_parent_id: removed.parentId,
        guardian_athlete_id: removed.athleteId,
      },
    });

    return NextResponse.json({
      ok: true,
      account_id: accountId,
      parent_id: removed.parentId,
      athlete_id: removed.athleteId,
    });
  } catch (error) {
    return jsonError(error);
  }
}
