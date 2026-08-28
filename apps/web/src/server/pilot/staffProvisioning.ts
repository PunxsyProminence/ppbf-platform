import type { AuthProvider } from './authProviders';
import type { PilotRole } from './contracts';
import { query, queryOne, withTransaction } from './db';
// The waiver_type string only, not the readers. Imported rather than
// re-typed because a second copy of 'photo_media' is exactly how one of the
// two later stops matching the other.
import { MEDIA_CONSENT_WAIVER_TYPE } from './guardianConsent';
import { createVolunteer } from './volunteers';

// Roles that can be provisioned as a Microsoft-authenticated account through
// this module.
//
// Deliberately excluded:
//   platform_owner -- provisioned only by the dedicated bootstrap path, which
//                     pins the identity to PPBF_PRIMARY_OWNER_EMAIL. Allowing
//                     it here would let any org-scoped invite escalate to
//                     full platform ownership.
//   athlete        -- athletes authenticate by PIN and are provisioned through
//                     the activation-code flow. Giving an athlete a Microsoft
//                     login would bypass the athlete-only PIN boundary.
//   admin          -- legacy alias retained for existing rows only; new
//                     accounts use organization_admin.
export const INVITABLE_STAFF_ROLES = [
  'organization_admin',
  'coach',
  'board',
  'staff',
  'volunteer',
  'parent',
] as const;

export type InvitableStaffRole = (typeof INVITABLE_STAFF_ROLES)[number];

// Roles an organization_admin may invite within their own organization. They
// cannot mint another organization_admin -- that is a platform_owner action,
// so an org admin can never unilaterally expand the set of people who share
// their authority.
export const ORG_ADMIN_INVITABLE_ROLES: InvitableStaffRole[] = ['coach', 'staff', 'volunteer', 'parent'];

export function isInvitableStaffRole(role: string): role is InvitableStaffRole {
  return (INVITABLE_STAFF_ROLES as readonly string[]).includes(role);
}

/**
 * The athlete an invited guardian is responsible for, and the guardian's own
 * name for the pilot.parents record.
 *
 * Every parent read path resolves a child through pilot.parents joined on
 * account_id and then pilot.guardian_links -- assertAthleteAccessAllowed in
 * access.ts and /api/pilot/athletes/list both do exactly that. An account row
 * on its own therefore signs in successfully and resolves no children at all,
 * with nothing anywhere reporting a fault. That is why the parent role is not
 * provisionable without this: the link is written in the same transaction as
 * the account, so the two cannot exist apart.
 */
export interface GuardianAthleteLink {
  athleteId: string;
  fullName: string;
  relationshipToAthlete: string;
}

/**
 * Optional detail for the volunteer-roster half of a volunteer invite. Every
 * field here is an override, never a gate -- see the roster block inside
 * createOrUpdateMicrosoftStaffAccount for why a volunteer invite creates or
 * links a pilot.volunteers row unconditionally, whether or not any of this
 * is supplied.
 *
 *   - volunteerId set: links the account to that EXISTING, not-yet-linked
 *     pilot.volunteers row -- the path for when the roster row was created
 *     first (e.g. through the volunteer-management console) and this invite
 *     only adds the login.
 *   - volunteerId absent: a new pilot.volunteers row is created via
 *     createVolunteer (reused, not duplicated) and linked to the account.
 *     Every field left unset here is simply left null on that row (nullable
 *     in the base schema for exactly this reason) rather than invented, and
 *     stays editable afterward on the volunteer-management console.
 */
export interface VolunteerRosterAssignment {
  volunteerId?: string;
  fullName?: string;
  roleFocus?: string;
  availability?: string;
  certificationStatus?: string;
  backgroundCheckStatus?: string;
  notes?: string | null;
}

export interface StaffProvisionResult {
  accountId: string;
  organizationId: string;
  role: InvitableStaffRole;
  loginEmail: string;
  created: boolean;
  // The guardian record and link written alongside the account. Null for every
  // role other than parent, which never has one. Optional so a caller that
  // only stubs this result for an unrelated assertion need not restate it.
  guardianLink?: { parentId: string; athleteId: string } | null;
  // The volunteer-roster row created or linked alongside the account. Null
  // for every role other than volunteer, and for a volunteer invite that
  // named no roster detail at all. Optional for the same stubbing reason as
  // guardianLink.
  volunteerLink?: { volunteerId: string } | null;
}

/** One guardian-to-athlete link, as the people console needs to display it. */
export interface OrganizationGuardianLink {
  account_id: string;
  parent_id: string;
  athlete_id: string;
  athlete_full_name: string;
  relationship_to_athlete: string;
}

export interface OrganizationMember {
  account_id: string;
  login_email: string | null;
  auth_provider: AuthProvider;
  role: PilotRole;
  athlete_id: string | null;
  active_flag: boolean;
  has_pin: boolean;
  membership_active: boolean;
  created_at: string;
  updated_at: string;
}

function normalizeEmail(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    throw new Error('Missing login_email');
  }

  // Deliberately permissive but structural: exactly one @, non-empty local
  // part, and a dotted domain. This is an identity mapping key, not a
  // deliverability check -- there is no mail being sent.
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(normalized)) {
    throw new Error('Missing login_email: value is not a valid email address');
  }

  return normalized;
}

function normalizeGuardian(raw: GuardianAthleteLink): GuardianAthleteLink {
  const athleteId = raw.athleteId.trim();
  const fullName = raw.fullName.trim();
  const relationshipToAthlete = raw.relationshipToAthlete.trim();

  if (!athleteId) {
    throw new Error('Missing athlete_id: a parent invite has to name the athlete they are the guardian of');
  }

  if (!fullName) {
    throw new Error("Missing guardian full_name: the guardian's own name is what pilot.parents records");
  }

  if (!relationshipToAthlete) {
    throw new Error('Missing relationship_to_athlete');
  }

  return { athleteId, fullName, relationshipToAthlete };
}

/**
 * Refuses a parent invite that names no athlete.
 *
 * A parent account resolves its children through pilot.parents joined on
 * account_id and then pilot.guardian_links. Without those rows the account
 * signs in perfectly, lists as healthy, and shows the family nothing -- no
 * error is raised anywhere, because from the database's point of view the
 * query simply matched nothing.
 *
 * This lives beside createOrUpdateMicrosoftStaffAccount rather than inside it
 * because one caller legitimately provisions a parent without passing
 * `guardian`: intake promotion writes pilot.parents and pilot.guardian_links
 * itself, from the reviewed intake packet, in the same request. Refusing
 * unconditionally inside provisioning would reject an approved packet.
 *
 * Every OTHER surface that invites a parent has to call this first. A surface
 * that neither passes `guardian` nor writes the link itself is creating the
 * silent failure.
 */
export function requireGuardianLinkForParentInvite(
  role: InvitableStaffRole,
  guardian: GuardianAthleteLink | undefined,
): void {
  if (role === 'parent' && !guardian) {
    throw new Error(
      'Missing guardian link: a parent account is only created together with the athlete they are the guardian of, because a parent with no link signs in successfully and sees no children',
    );
  }

  if (role !== 'parent' && guardian) {
    throw new Error('Forbidden: a guardian link belongs only to the parent role');
  }
}

/**
 * Creates or updates a Microsoft-authenticated staff account and its
 * organization membership.
 *
 * This is the only path by which a coach, organization admin, board member,
 * or other non-athlete role can obtain a working login. Microsoft sign-in
 * resolves an identity purely by `lower(login_email)` + `auth_provider =
 * 'microsoft'`, so an account row written here is what makes an invited
 * person's Entra identity map onto a PPBF role.
 *
 * Provisioning a row here does NOT by itself let someone in: the Microsoft
 * token must still carry the configured tenant claim, so the invitee must
 * also exist in the PPBF Entra tenant (as a member or a B2B guest).
 *
 * `callerInvitableRoles` is the set of roles the caller is authorized to
 * assign. It bounds re-roling as well as creation: an invite may not change
 * the role of an account that currently holds a role the caller could not
 * have assigned in the first place. It defaults to the narrowest caller
 * (ORG_ADMIN_INVITABLE_ROLES) so a caller that forgets to state its authority
 * gets the least of it, never the most.
 *
 * `guardian` is accepted only for the parent role, and when present the
 * account, the pilot.parents record and the pilot.guardian_links row are one
 * transaction -- so a guardian provisioned this way can never sign in without
 * children resolving. Re-inviting the same address with a different athlete
 * adds a second link rather than replacing the first, which is how a guardian
 * of two athletes is built up.
 *
 * A caller inviting a parent must either pass `guardian` or write the
 * pilot.parents and pilot.guardian_links rows itself in the same request; see
 * requireGuardianLinkForParentInvite for why that is enforced by the invite
 * surfaces rather than here.
 */
export async function createOrUpdateMicrosoftStaffAccount(params: {
  loginEmail: string;
  organizationId: string;
  role: InvitableStaffRole;
  accountIdHint?: string;
  callerInvitableRoles?: readonly InvitableStaffRole[];
  guardian?: GuardianAthleteLink;
  volunteer?: VolunteerRosterAssignment;
}): Promise<StaffProvisionResult> {
  const loginEmail = normalizeEmail(params.loginEmail);
  const organizationId = params.organizationId.trim();
  const role = params.role;
  const callerInvitableRoles: readonly string[] = params.callerInvitableRoles ?? ORG_ADMIN_INVITABLE_ROLES;

  if (!organizationId) {
    throw new Error('Missing organization_id');
  }

  if (role !== 'parent' && params.guardian) {
    throw new Error('Forbidden: a guardian link belongs only to the parent role');
  }

  if (role !== 'volunteer' && params.volunteer) {
    throw new Error('Forbidden: a volunteer roster link belongs only to the volunteer role');
  }

  const guardian = params.guardian ? normalizeGuardian(params.guardian) : null;

  // Defense in depth: the type already excludes these, but this module is the
  // privilege boundary, so it re-checks rather than trusting its caller.
  if (!isInvitableStaffRole(role)) {
    throw new Error('Unsupported role');
  }

  const organization = await queryOne<{ organization_id: string }>(
    'select organization_id from pilot.organizations where organization_id = $1',
    [organizationId],
  );

  if (!organization) {
    throw new Error('Missing organization_id: organization does not exist');
  }

  const existing = await queryOne<{
    account_id: string;
    organization_id: string | null;
    role: PilotRole;
    auth_provider: AuthProvider;
    is_platform_owner: boolean;
  }>(
    `select account_id, organization_id, role, auth_provider, is_platform_owner
     from pilot.accounts
     where lower(login_email) = $1`,
    [loginEmail],
  );

  if (existing) {
    // Never let an org-scoped invite touch the platform owner's account. That
    // account is managed solely by the bootstrap path.
    if (existing.is_platform_owner || existing.role === 'platform_owner') {
      throw new Error('Forbidden: cannot modify a platform owner account');
    }

    // Cross-organization takeover guard, matching the athlete create path: an
    // identity already provisioned in one organization cannot be silently
    // re-pointed at another by whoever invites that email next.
    if (existing.organization_id && existing.organization_id !== organizationId) {
      throw new Error('Forbidden: account already exists in another organization');
    }

    // An athlete authenticates by PIN. Converting that row to a Microsoft
    // staff account would clear the PIN and strand the athlete, and would
    // move an athlete-scoped record (athlete_id, session history) onto a
    // privileged role. Require the athlete account be handled explicitly
    // instead of mutating it as a side effect of an invite.
    if (existing.role === 'athlete' || existing.auth_provider === 'ppbf_local') {
      throw new Error('Forbidden: this email is already used by a PIN-based athlete account');
    }

    // Peer protection. Re-inviting an address is how a role gets changed, and
    // without this an invite could silently demote a sitting organization
    // admin or board member -- roles the inviting admin cannot grant and
    // therefore must not be able to take away. Re-inviting at the SAME role
    // stays allowed: that only reactivates the account.
    if (existing.role !== role && !callerInvitableRoles.includes(existing.role)) {
      throw new Error('Forbidden: this account holds a role you cannot assign, so its role cannot be changed by an invite');
    }
  }

  const accountId = existing?.account_id || params.accountIdHint?.trim() || loginEmail;

  if (!existing) {
    // The account_id is a separate primary key from the email. If the caller
    // supplied a hint that collides with an unrelated account, fail rather
    // than overwrite that account's role and organization.
    const accountIdCollision = await queryOne<{ account_id: string }>(
      'select account_id from pilot.accounts where account_id = $1',
      [accountId],
    );

    if (accountIdCollision) {
      throw new Error('Forbidden: account_id is already in use by another identity');
    }
  }

  const { guardianLink, volunteerLink } = await withTransaction(async (client) => {
    await client.query(
      `insert into pilot.accounts (
         account_id,
         login_email,
         auth_provider,
         role,
         organization_id,
         is_platform_owner,
         athlete_id,
         pin_hash,
         active_flag
       )
       values ($1, $2, 'microsoft', $3, $4, false, null, null, true)
       on conflict (account_id) do update set
         login_email = excluded.login_email,
         auth_provider = 'microsoft',
         role = excluded.role,
         organization_id = excluded.organization_id,
         is_platform_owner = false,
         athlete_id = null,
         pin_hash = null,
         active_flag = true,
         updated_at = now()`,
      [accountId, loginEmail, role, organizationId],
    );

    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ($1, $2, $3, true)
       on conflict (account_id, organization_id) do update
         set role = excluded.role,
             active_flag = true,
             updated_at = now()`,
      [accountId, organizationId, role],
    );

    if (existing) {
      // Role or organization may have just changed. resolvePrincipal reads
      // pilot.accounts.role live on every request, so any session minted
      // under the previous configuration must not survive this write.
      await client.query(
        'update pilot.session_tokens set revoked_at = now() where account_id = $1 and revoked_at is null',
        [accountId],
      );
    }

    let guardianLink: { parentId: string; athleteId: string } | null = null;

    if (guardian) {
      // Checked here rather than left to the guardian_links foreign key: a
      // constraint violation surfaces as an opaque 500, and an admin who
      // mistyped a record id needs to be told which id had no athlete behind it.
      // Inside the transaction, so the athlete cannot be removed between the
      // check and the link.
      const athlete = await client.query<{ athlete_id: string }>(
        'select athlete_id from pilot.athletes where organization_id = $1 and athlete_id = $2',
        [organizationId, guardian.athleteId],
      );

      if (athlete.rowCount === 0) {
        throw new Error(`Missing athlete_id: no athlete record "${guardian.athleteId}" in this organization`);
      }

      // One pilot.parents record per account, reused across invites so a
      // guardian of two athletes ends up with two links rather than two
      // guardian records that each resolve half their family.
      //
      // THE ROSTER IMPORT GETS THERE FIRST. scripts/seed-data.ts writes a
      // pilot.parents row per guardian on the roster with a content-hashed
      // parent_id and account_id left NULL -- deliberately, because importing a
      // family must not mint logins. That row already carries a guardian_link per
      // sibling. Matching only on account_id or the derived id therefore missed
      // it entirely: the invite inserted a SECOND row for the same human, the
      // account attached to the new row, and every imported sibling link stayed
      // on the orphaned one. The guardian signed in and saw exactly the one child
      // named in their invite, with no indication the rest existed.
      //
      // So an unclaimed row whose email matches is a candidate to CLAIM rather
      // than an obstacle. Email is the right key: it is what the importer
      // deduplicates guardians on, and it is normalized identically on both sides
      // (trim + lowercase). A row carrying no email cannot be claimed here -- the
      // only thing left to match on would be the name, and merging two families
      // because two adults share a name is worse than the duplicate row.
      const derivedParentId = `par-${accountId}`;
      // email_matches is nullable, not boolean: a row with no email compares
      // NULL against the address, which is neither a match nor a mismatch. The
      // filter below treats it as "not claimable", which is the intended reading.
      const parentRows = await client.query<{
        parent_id: string;
        account_id: string | null;
        email_matches: boolean | null;
      }>(
        `select parent_id,
                account_id,
                (nullif(lower(trim(coalesce(email, ''))), '') = $4) as email_matches
         from pilot.parents
         where organization_id = $1
           and (
             account_id = $2
             or parent_id = $3
             or (account_id is null and nullif(lower(trim(coalesce(email, ''))), '') = $4)
           )
         order by parent_id asc`,
        [organizationId, accountId, derivedParentId, loginEmail],
      );

      const ownRecord = parentRows.rows.find((row) => row.account_id === accountId);

      let parentId: string;
      if (ownRecord) {
        parentId = ownRecord.parent_id;
      } else {
        const claimable = parentRows.rows.filter((row) => row.account_id === null && row.email_matches === true);

        if (claimable.length > 1) {
          // Two unclaimed records for one address means the import ran on a file
          // that disagreed with itself. Picking one would silently strand the
          // other's children, which is the very failure this block exists to fix,
          // so it stops and says so instead.
          throw new Error(
            'Conflict: more than one unclaimed guardian record carries this email address, so the record to claim is ambiguous',
          );
        }

        if (claimable.length === 1) {
          parentId = claimable[0].parent_id;
        } else if (parentRows.rows.length > 0) {
          // Something holds the derived id, or an unclaimed record sits on it
          // under a different address. Either way it is not this guardian's, and
          // linking to it would hand this account that family's children.
          throw new Error('Forbidden: guardian record id is already in use by another guardian');
        } else {
          parentId = derivedParentId;
        }
      }

      await client.query(
        `insert into pilot.parents (organization_id, parent_id, account_id, full_name, email)
         values ($1, $2, $3, $4, $5)
         on conflict (organization_id, parent_id) do update set
           account_id = excluded.account_id,
           full_name = excluded.full_name,
           email = excluded.email,
           updated_at = now()`,
        [organizationId, parentId, accountId, guardian.fullName, loginEmail],
      );

      await client.query(
        `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
         values ($1, $2, $3, $4)
         on conflict (organization_id, parent_id, athlete_id) do update set
           relationship_to_athlete = excluded.relationship_to_athlete,
           updated_at = now()`,
        [organizationId, parentId, guardian.athleteId, guardian.relationshipToAthlete],
      );

      guardianLink = { parentId, athleteId: guardian.athleteId };
    }

    let volunteerLink: { volunteerId: string } | null = null;

    if (role === 'volunteer') {
      // Unconditional -- unlike guardian, this never depends on the caller
      // passing anything. The bug this closes is that a volunteer account and
      // a pilot.volunteers row were two permanently disconnected records with
      // nothing anywhere linking them; making the link opt-in would leave
      // exactly that gap open for every invite that does not know to ask for
      // it (which today is every invite -- neither the org-admin nor the
      // platform-owner staff route sends a `volunteer` field).
      //
      // Re-invites (the account already `existing`) must not spawn a second
      // roster row each time, so an account already carrying one is found and
      // reused before anything is created or linked, mirroring how guardian
      // reuses one pilot.parents record per account rather than minting a new
      // one on every invite.
      const ownVolunteerRow = await client.query<{ volunteer_id: string }>(
        'select volunteer_id from pilot.volunteers where organization_id = $1 and account_id = $2',
        [organizationId, accountId],
      );

      if ((ownVolunteerRow.rowCount ?? 0) > 0) {
        volunteerLink = { volunteerId: ownVolunteerRow.rows[0].volunteer_id };
      } else if (params.volunteer?.volunteerId) {
        const targetVolunteerId = params.volunteer.volunteerId.trim();

        // Same reasoning as the athlete check above: a constraint violation
        // reads as an opaque 500, and inside the transaction so the row
        // cannot be claimed by someone else between the check and the link.
        const targetRow = await client.query<{ volunteer_id: string; account_id: string | null }>(
          'select volunteer_id, account_id from pilot.volunteers where organization_id = $1 and volunteer_id = $2',
          [organizationId, targetVolunteerId],
        );

        if (targetRow.rowCount === 0) {
          throw new Error(`Missing volunteer_id: no volunteer record "${targetVolunteerId}" in this organization`);
        }

        if (targetRow.rows[0].account_id && targetRow.rows[0].account_id !== accountId) {
          throw new Error('Forbidden: this volunteer roster row is already linked to a different account');
        }

        await client.query(
          `update pilot.volunteers
           set account_id = $3, updated_at = now()
           where organization_id = $1 and volunteer_id = $2`,
          [organizationId, targetVolunteerId, accountId],
        );

        volunteerLink = { volunteerId: targetVolunteerId };
      } else {
        // Reuses createVolunteer (volunteers.ts) rather than duplicating its
        // insert here. fullName falls back to the login email -- the same
        // honest-placeholder convention `accountId` above already uses --
        // rather than inventing a name nobody supplied; every field this
        // leaves unset stays editable afterward on the volunteer-management
        // console.
        const newVolunteerId = await createVolunteer(
          {
            organizationId,
            fullName: params.volunteer?.fullName?.trim() || loginEmail,
            roleFocus: params.volunteer?.roleFocus?.trim() || null,
            availability: params.volunteer?.availability?.trim() || null,
            certificationStatus: params.volunteer?.certificationStatus?.trim() || null,
            backgroundCheckStatus: params.volunteer?.backgroundCheckStatus?.trim() || null,
            notes: params.volunteer?.notes ?? null,
            accountId,
          },
          client,
        );

        volunteerLink = { volunteerId: newVolunteerId };
      }
    }

    return { guardianLink, volunteerLink };
  });

  return {
    accountId,
    organizationId,
    role,
    loginEmail,
    created: !existing,
    guardianLink,
    volunteerLink,
  };
}

/**
 * Removes one guardian-to-athlete link.
 *
 * Refuses to remove the last one an account holds. A parent account with no
 * link is precisely the state this module exists to make impossible: it signs
 * in, reads as healthy, and shows an empty list of children. Correcting a
 * mislinked guardian is therefore link-the-right-athlete-then-remove, in that
 * order, and never leaves a family with an account that shows them nothing.
 *
 * ALSO refuses while that guardian's media consent for that athlete stands
 * WITHDRAWN, because this DELETE is the one action that can turn a standing
 * NO into a YES without anybody signing anything. See the comment on the
 * check itself for the mechanism. Owner decision, 2026-08-28.
 */
export async function removeGuardianLink(params: {
  organizationId: string;
  accountId: string;
  athleteId: string;
}): Promise<{ parentId: string; athleteId: string }> {
  const organizationId = params.organizationId.trim();
  const accountId = params.accountId.trim();
  const athleteId = params.athleteId.trim();

  if (!organizationId || !accountId || !athleteId) {
    throw new Error('Missing organization_id, account_id, or athlete_id');
  }

  return withTransaction(async (client) => {
    const parentRows = await client.query<{ parent_id: string }>(
      'select parent_id from pilot.parents where organization_id = $1 and account_id = $2',
      [organizationId, accountId],
    );

    if (parentRows.rowCount === 0) {
      throw new Error('Not found: this account holds no guardian record in your organization');
    }

    const parentIds = parentRows.rows.map((row) => row.parent_id);

    const links = await client.query<{ parent_id: string; athlete_id: string }>(
      `select parent_id, athlete_id
       from pilot.guardian_links
       where organization_id = $1 and parent_id = any($2::text[])`,
      [organizationId, parentIds],
    );

    const target = links.rows.find((row) => row.athlete_id === athleteId);
    if (!target) {
      throw new Error('Not found: that athlete is not linked to this guardian');
    }

    /*
     * A withdrawal is a standing NO, and this DELETE is the one action that
     * can silently turn it into a YES.
     *
     * checkGuardianMediaConsent (guardianConsent.ts) resolves an athlete's
     * guardians from pilot.guardian_links LIVE on every call, then reads each
     * one's current photo_media waiver. Removing this row does not reverse
     * the withdrawal -- it removes the guardian who made it from the set
     * being asked. For an athlete with a second, consenting guardian the
     * answer flips from blocked to allowed. For an athlete whose only
     * guardian this was, perGuardian goes EMPTY, and the video playback gate
     * (api/pilot/video/[videoId]) reads an empty set as "no guardian excluded
     * this" and serves the footage. Either way an administrative click, not a
     * signature, is what restored the media.
     *
     * So the unlink is refused while the withdrawal stands. The way out is
     * the same one that reverses a withdrawal anywhere else on this platform:
     * that guardian signs a fresh consent through their own console
     * (pilot.waivers is append-only and every reader takes the latest row per
     * guardian), and then the link can be removed. An org admin cannot clear
     * it on their behalf, which is the entire point -- if they could, the
     * refusal would only be a speed bump.
     *
     * CHECKED BEFORE THE STRUCTURAL RULE BELOW, deliberately. If the
     * last-link refusal ran first, the "withdrawn AND only link" case would
     * never mention the withdrawal at all, and an admin would work around the
     * structural rule (link another athlete, come back) without ever learning
     * why the removal is actually refused. A safeguarding fact must not be
     * masked by a housekeeping one.
     *
     * SCOPED TO photo_media on purpose, and that scope is a checked claim,
     * not an assumption: it is the only waiver type whose evaluation joins
     * guardian_links. getAthleteWaiverStatus (waiverCompliance.ts) reads by
     * athlete_id alone, so unlinking a guardian moves no travel or
     * medical_release answer. Those two readers were read; the rest of the
     * codebase was not, so this says what was checked and no more.
     */
    const currentConsent = await client.query<{ status: string }>(
      `select status
         from pilot.waivers
        where organization_id = $1 and athlete_id = $2 and parent_id = $3 and waiver_type = $4
        order by created_at desc
        limit 1`,
      [organizationId, athleteId, target.parent_id, MEDIA_CONSENT_WAIVER_TYPE],
    );

    if (currentConsent.rows[0]?.status === 'withdrawn') {
      throw new Error(
        'Forbidden: this guardian has withdrawn media consent for this athlete. Removing the link would '
        + 'drop that withdrawal out of the consent check rather than reverse it, so the athlete\'s media '
        + 'would become usable again without anyone consenting. Only a new signed consent from that '
        + 'guardian clears this, and the link can be removed after that.',
      );
    }

    if (links.rowCount === 1) {
      throw new Error(
        'Forbidden: this is the only athlete this guardian is linked to, and removing it would leave an account that signs in and sees nothing. Link them to the correct athlete first, then remove this one.',
      );
    }

    await client.query(
      'delete from pilot.guardian_links where organization_id = $1 and parent_id = $2 and athlete_id = $3',
      [organizationId, target.parent_id, athleteId],
    );

    return { parentId: target.parent_id, athleteId };
  });
}

/**
 * Lists every account holding a membership in an organization, with enough
 * status detail for the admin people console to show who can actually sign in.
 *
 * `has_pin` is a boolean derived from pin_hash -- the hash itself never leaves
 * the database.
 */
export async function listOrganizationMembers(organizationId: string): Promise<OrganizationMember[]> {
  return query<OrganizationMember>(
    `select
       a.account_id,
       a.login_email,
       a.auth_provider,
       om.role,
       a.athlete_id,
       a.active_flag,
       (a.pin_hash is not null) as has_pin,
       om.active_flag as membership_active,
       a.created_at,
       a.updated_at
     from pilot.organization_memberships om
     join pilot.accounts a on a.account_id = om.account_id
     where om.organization_id = $1
     order by
       case om.role
         when 'organization_admin' then 1
         when 'admin' then 2
         when 'coach' then 3
         when 'board' then 4
         when 'staff' then 5
         when 'volunteer' then 6
         when 'parent' then 7
         else 8
       end,
       a.account_id asc`,
    [organizationId],
  );
}

/**
 * Every guardian-to-athlete link in an organization, keyed by the guardian's
 * account.
 *
 * The people console pairs this with listOrganizationMembers so a parent row
 * can state which children it actually resolves. Without it a stranded parent
 * -- one provisioned before the link became mandatory -- renders as an
 * ordinary healthy Microsoft account.
 *
 * pilot.parents.account_id is nullable, because intake can record a guardian
 * who has no login. Those rows are excluded rather than shown against a blank
 * account.
 */
export async function listOrganizationGuardianLinks(organizationId: string): Promise<OrganizationGuardianLink[]> {
  return query<OrganizationGuardianLink>(
    `select
       p.account_id,
       gl.parent_id,
       gl.athlete_id,
       ath.full_name as athlete_full_name,
       gl.relationship_to_athlete
     from pilot.guardian_links gl
     join pilot.parents p
       on p.organization_id = gl.organization_id and p.parent_id = gl.parent_id
     join pilot.athletes ath
       on ath.organization_id = gl.organization_id and ath.athlete_id = gl.athlete_id
     where gl.organization_id = $1 and p.account_id is not null
     order by p.account_id asc, ath.full_name asc`,
    [organizationId],
  );
}
