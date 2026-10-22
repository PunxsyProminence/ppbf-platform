import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { NotFoundError, ValidationError } from '@/src/server/pilot/errors';
import {
  jsonError,
  requireMicrosoftAuthenticatedPrincipal,
  requireMicrosoftOrAttestedLocalPinPrincipal,
} from '@/src/server/pilot/http';
import {
  ORG_ADMIN_INVITABLE_ROLES,
  RoleChangeUnconfirmedError,
  createOrUpdateMicrosoftStaffAccount,
  getOrganizationName,
  listOrganizationGuardianLinks,
  listOrganizationMembers,
  removeGuardianLink,
  requireGuardianLinkForParentInvite,
  type GuardianAthleteLink,
  type InvitableStaffRole,
  type VolunteerRosterAssignment,
} from '@/src/server/pilot/staffProvisioning';
import { setStaffDisplayName } from '@/src/server/pilot/profileDb';
import { STAFF_DISPLAY_NAME_ROLES, normalizeStaffDisplayName } from '@/src/shared/staffDisplayName';

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
    const principal = await requireMicrosoftOrAttestedLocalPinPrincipal(request);
    if (!isOrganizationAdminRole(principal.role)) {
      throw new Error('Forbidden: role not allowed');
    }

    const [members, guardianLinks, organizationName] = await Promise.all([
      listOrganizationMembers(principal.organizationId),
      listOrganizationGuardianLinks(principal.organizationId),
      getOrganizationName(principal.organizationId),
    ]);

    return NextResponse.json({
      ok: true,
      organization_id: principal.organizationId,
      // What the console prints as the gym; the id above stays for callers
      // that key on it and is never printed (F-008).
      organization_name: organizationName,
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
      /** The role this invite is confirmed to change the account from (lane L31). */
      confirm_role_change_from?: string | null;
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
      // A role change from this route needs the confirmation; null means "none given".
      roleChangeConfirmedFrom: body.confirm_role_change_from?.trim() || null,
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
    // The role it would change from goes back with the refusal, so the page can name it and send it.
    if (error instanceof RoleChangeUnconfirmedError) {
      return NextResponse.json(
        { error: error.message, code: error.code, current_role: error.currentRole },
        { status: 409 },
      );
    }
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
      // A guardian with no login (OD-2026-10-07-009) is named by record
      // instead; removeGuardianLink refuses this form for one that has a login.
      parent_id?: string;
      athlete_id?: string;
    };

    const accountId = body.account_id?.trim() || '';
    const parentId = body.parent_id?.trim() || '';
    const athleteId = body.athlete_id?.trim() || '';

    if ((!accountId && !parentId) || !athleteId) {
      throw new Error('Missing athlete_id and one of account_id or parent_id');
    }

    const removed = await removeGuardianLink({
      organizationId: principal.organizationId,
      ...(accountId ? { accountId } : { parentId }),
      athleteId,
    });

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      // A paper-only guardian has no account; the record id is the entity then.
      entity_type: accountId ? 'account' : 'guardian',
      entity_id: accountId || removed.parentId,
      details: {
        action: 'organization_admin_remove_guardian_link',
        guardian_parent_id: removed.parentId,
        guardian_athlete_id: removed.athleteId,
        ...(accountId ? {} : { paper_only: true }),
      },
    });

    return NextResponse.json({
      ok: true,
      account_id: accountId || null,
      parent_id: removed.parentId,
      athlete_id: removed.athleteId,
    });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Sets or clears the name the gym types for a coach or staff member
 * (parent-portal Q1 part B). Blank clears it, and every screen names the
 * person from their login again.
 *
 * Same boundaries as the other writes here: Microsoft session, organization
 * admin, the organization taken from the session. The target must hold a
 * membership in that organization in a role that may carry a name;
 * setStaffDisplayName checks that in the same statement as the write, so an
 * athlete, a guardian or someone in another gym answers 404 and nothing is
 * written.
 */
export async function PATCH(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    if (!isOrganizationAdminRole(principal.role)) {
      throw new Error('Forbidden: role not allowed');
    }

    const body = (await request.json().catch(() => null)) as {
      account_id?: unknown;
      display_name?: unknown;
    } | null;
    const accountId = typeof body?.account_id === 'string' ? body.account_id.trim() : '';
    if (!accountId) throw new ValidationError('Missing account_id');
    if (!body || !('display_name' in body)) throw new ValidationError('Missing display_name (send an empty string to clear it)');

    const input = normalizeStaffDisplayName(body.display_name);
    if (!input.ok) throw new ValidationError(input.error);

    let written: boolean;
    try {
      written = await setStaffDisplayName(
        principal.organizationId,
        accountId,
        input.name,
        STAFF_DISPLAY_NAME_ROLES,
      );
    } catch (writeError) {
      // The database's check has the last word. A name the rule above passed
      // and the check refused (a server whose [[:cntrl:]] class is wider than
      // \p{Cc}) is a name the admin can change, not a server fault.
      const pgError = writeError as { code?: unknown; constraint?: unknown };
      if (pgError.code === '23514' && pgError.constraint === 'pilot_account_profiles_staff_display_name_check') {
        throw new ValidationError('That name cannot be saved. Use letters, numbers, spaces and ordinary punctuation.');
      }
      throw writeError;
    }
    if (!written) {
      throw new NotFoundError('Not found: no coach or staff member with that account in this gym');
    }

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'account',
      entity_id: accountId,
      details: {
        action: input.name === null
          ? 'organization_admin_clear_staff_display_name'
          : 'organization_admin_set_staff_display_name',
        staff_display_name: input.name,
      },
    });

    return NextResponse.json({ ok: true, account_id: accountId, staff_display_name: input.name });
  } catch (error) {
    return jsonError(error);
  }
}
