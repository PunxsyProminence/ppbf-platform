/**
 * READS AND WRITES FOR pilot.account_profiles.
 *
 * The rules live next door in profileIdentity.ts (what a ring name may be) and
 * profileVisibility.ts (who may see a face). This file does the joins and
 * nothing else, so those two stay testable without a database.
 *
 * THE ONE THING TO UNDERSTAND BEFORE EDITING
 *
 * resolveRelationship() below is the only place that decides how a viewer
 * stands to a subject, and it answers using the same two joins access.ts uses
 * -- pilot.athletes.coach_id for "your coach" and pilot.guardian_links for
 * "your guardian". It does not invent a second definition of either. And every
 * athlete-scoped read in this file calls assertActorCanAccessAthlete FIRST, so
 * the existing child-account boundary is the floor: nothing here can widen what
 * access.ts already refused, only narrow it further.
 *
 * Narrowing further is the point. access.ts lets an organization_admin read any
 * athlete record in their organization, which is right for a record and wrong
 * for a photograph of somebody's twelve-year-old.
 */

import { assertActorCanAccessAthlete, isOrganizationAdminRole, type ActorIdentity } from './access';
import { query, queryOne } from './db';
import {
  normalizeCorner,
  normalizeProgram,
  type CornerChoice,
  type ProgramChoice,
} from './profileIdentity';
import {
  normalizePhotoReviewState,
  type PhotoReviewState,
  type ProfileRelationship,
  type ProfileSubject,
} from './profileVisibility';

export interface AccountProfileRow {
  organization_id: string;
  account_id: string;
  display_nickname: string | null;
  nickname_cleared_at: string | null;
  corner: string;
  program: string;
  photo_blob_path: string | null;
  photo_content_type: string | null;
  photo_review_state: string;
  photo_uploaded_at: string | null;
}

export interface AccountProfile {
  readonly organizationId: string;
  readonly accountId: string;
  readonly nickname: string | null;
  readonly nicknameClearedAt: string | null;
  readonly corner: CornerChoice;
  readonly program: ProgramChoice;
  readonly photoBlobPath: string | null;
  readonly photoContentType: string | null;
  readonly photoReviewState: PhotoReviewState;
}

/**
 * The empty profile. Returned rather than null for an account that has never
 * touched the settings screen, so every caller renders the same object for
 * "has not set anything" as for "set everything back to default". A null here
 * would put a `?.` on every read site and one of them would eventually forget.
 */
export function emptyProfile(organizationId: string, accountId: string): AccountProfile {
  return {
    organizationId,
    accountId,
    nickname: null,
    nicknameClearedAt: null,
    corner: 'none',
    program: 'unstated',
    photoBlobPath: null,
    photoContentType: null,
    photoReviewState: 'pending_review',
  };
}

function toProfile(row: AccountProfileRow): AccountProfile {
  return {
    organizationId: row.organization_id,
    accountId: row.account_id,
    nickname: row.display_nickname,
    nicknameClearedAt: row.nickname_cleared_at,
    corner: normalizeCorner(row.corner),
    program: normalizeProgram(row.program),
    photoBlobPath: row.photo_blob_path,
    photoContentType: row.photo_content_type,
    photoReviewState: normalizePhotoReviewState(row.photo_review_state),
  };
}

const PROFILE_COLUMNS = `organization_id, account_id, display_nickname, nickname_cleared_at,
    corner, program, photo_blob_path, photo_content_type, photo_review_state, photo_uploaded_at`;

export async function getAccountProfile(
  organizationId: string,
  accountId: string,
): Promise<AccountProfile> {
  const row = await queryOne<AccountProfileRow>(
    `select ${PROFILE_COLUMNS}
     from pilot.account_profiles
     where organization_id = $1 and account_id = $2`,
    [organizationId, accountId],
  );
  return row ? toProfile(row) : emptyProfile(organizationId, accountId);
}

export async function getAccountProfiles(
  organizationId: string,
  accountIds: readonly string[],
): Promise<Map<string, AccountProfile>> {
  const found = new Map<string, AccountProfile>();
  if (accountIds.length === 0) return found;
  const rows = await query<AccountProfileRow>(
    `select ${PROFILE_COLUMNS}
     from pilot.account_profiles
     where organization_id = $1 and account_id = any($2::text[])`,
    [organizationId, [...new Set(accountIds)]],
  );
  for (const row of rows) {
    found.set(row.account_id, toProfile(row));
  }
  return found;
}

/* ------------------------------------------------------------- IDENTITY --- */

export interface SubjectIdentity {
  readonly accountId: string;
  readonly fullName: string;
  readonly athleteId: string | null;
  readonly dob: string | null;
  readonly coachAccountId: string | null;
  readonly memberSince: string | null;
}

/**
 * Who this account is, for card purposes only.
 *
 * Names come from pilot.athletes for participants and from the account's login
 * email stem for staff, because the platform has no staff name field. That is
 * an honest gap rather than a papered-over one: the card prints what the
 * platform actually knows, and a coach whose account has no email shows as
 * their account id rather than as a fabricated name.
 *
 * Nothing here reads weight_class, gym_status or emergency_contact even though
 * they sit on the same row. A card carries who somebody is, not a record about
 * their body.
 */
export async function getSubjectIdentity(
  organizationId: string,
  accountId: string,
): Promise<SubjectIdentity | null> {
  const account = await queryOne<{
    account_id: string;
    athlete_id: string | null;
    login_email: string | null;
    created_at: string;
  }>(
    `select account_id, athlete_id, login_email, created_at
     from pilot.accounts
     where organization_id = $1 and account_id = $2`,
    [organizationId, accountId],
  );
  if (!account) return null;

  if (account.athlete_id) {
    const athlete = await queryOne<{
      athlete_id: string;
      full_name: string;
      dob: string | null;
      coach_id: string | null;
      created_at: string;
    }>(
      `select athlete_id, full_name, dob, coach_id, created_at
       from pilot.athletes
       where organization_id = $1 and athlete_id = $2`,
      [organizationId, account.athlete_id],
    );
    if (athlete) {
      return {
        accountId: account.account_id,
        fullName: athlete.full_name,
        athleteId: athlete.athlete_id,
        dob: athlete.dob,
        coachAccountId: athlete.coach_id,
        memberSince: athlete.created_at,
      };
    }
  }

  return {
    accountId: account.account_id,
    fullName: staffDisplayName(account.login_email, account.account_id),
    athleteId: null,
    dob: null,
    coachAccountId: null,
    memberSince: account.created_at,
  };
}

/**
 * A staff member's name, from the only field the platform has. Punctuation
 * becomes spaces and each word is capitalised, so "jane.okafor@..." reads as
 * "Jane Okafor" -- and an address that does not decompose is left alone rather
 * than mangled into something that looks like a name and is not.
 */
export function staffDisplayName(loginEmail: string | null, accountId: string): string {
  const stem = (loginEmail ?? '').split('@')[0]?.trim() ?? '';
  if (!stem) return accountId;
  const words = stem
    .split(/[._-]+/)
    .map((word) => word.trim())
    .filter((word) => /\p{L}/u.test(word));
  if (words.length === 0) return accountId;
  return words
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

/* --------------------------------------------------------- RELATIONSHIP --- */

/**
 * How the viewer stands to the subject.
 *
 * Ordered most specific first, and it returns the FIRST match rather than the
 * strongest: 'self' beats everything, a direct link beats organization
 * membership, and organization membership is the weakest thing that is not
 * 'none'. A viewer who is both an admin and the athlete's coach resolves as the
 * coach, which is the relationship that actually grants the face.
 */
export async function resolveRelationship(
  viewer: ActorIdentity,
  subject: SubjectIdentity,
  subjectOrganizationId: string,
): Promise<ProfileRelationship> {
  // A different organization is a different building. Nothing crosses it.
  if (viewer.organizationId !== subjectOrganizationId) return 'none';
  if (viewer.accountId === subject.accountId) return 'self';

  // The platform owner is excluded by name. access.ts already refuses it every
  // athlete-scoped record ("platform owner cannot access organization-private
  // athlete records by default") and a portrait is not the exception to that.
  if (viewer.role === 'platform_owner') return 'none';
  // Board is restricted to organization-level aggregates. A face is not one.
  if (viewer.role === 'board') return 'none';

  if (subject.athleteId) {
    if (viewer.role === 'coach' && subject.coachAccountId === viewer.accountId) {
      return 'coach_of_subject';
    }
    if (viewer.role === 'parent') {
      const linked = await queryOne<{ athlete_id: string }>(
        `select gl.athlete_id
         from pilot.guardian_links gl
         join pilot.parents p
           on p.organization_id = gl.organization_id and p.parent_id = gl.parent_id
         where gl.organization_id = $1 and gl.athlete_id = $2 and p.account_id = $3`,
        [subjectOrganizationId, subject.athleteId, viewer.accountId],
      );
      // A parent who is not linked to THIS athlete is another family, and
      // another family is 'none' -- not 'organization_staff'. This single
      // return is the cross-family boundary for portraits.
      return linked ? 'guardian_of_subject' : 'none';
    }
    if (isOrganizationAdminRole(viewer.role) || viewer.role === 'coach') {
      return 'organization_staff';
    }
    return 'none';
  }

  // The subject is staff. Is this viewer one of the people they work with?
  if (viewer.role === 'athlete' && viewer.athleteId) {
    const mine = await queryOne<{ athlete_id: string }>(
      `select athlete_id from pilot.athletes
       where organization_id = $1 and athlete_id = $2 and coach_id = $3`,
      [subjectOrganizationId, viewer.athleteId, subject.accountId],
    );
    return mine ? 'subject_is_my_staff' : 'none';
  }
  if (viewer.role === 'parent') {
    const mine = await queryOne<{ athlete_id: string }>(
      `select a.athlete_id
       from pilot.athletes a
       join pilot.guardian_links gl
         on gl.organization_id = a.organization_id and gl.athlete_id = a.athlete_id
       join pilot.parents p
         on p.organization_id = gl.organization_id and p.parent_id = gl.parent_id
       where a.organization_id = $1 and a.coach_id = $2 and p.account_id = $3
       limit 1`,
      [subjectOrganizationId, subject.accountId, viewer.accountId],
    );
    return mine ? 'subject_is_my_staff' : 'none';
  }
  if (isOrganizationAdminRole(viewer.role) || viewer.role === 'coach' || viewer.role === 'staff') {
    return 'organization_staff';
  }
  return 'none';
}

/**
 * The existing boundary, run before anything about a portrait is decided.
 *
 * For an athlete subject this is assertActorCanAccessAthlete -- the same call
 * every other athlete-scoped route in the platform makes -- so a viewer who
 * cannot read the athlete record cannot reach the portrait path either, and the
 * child-account boundary is enforced once, in one place, by the module that
 * owns it.
 */
export async function assertViewerMayReachSubject(
  viewer: ActorIdentity,
  subject: SubjectIdentity,
): Promise<void> {
  if (viewer.accountId === subject.accountId) return;
  if (subject.athleteId) {
    await assertActorCanAccessAthlete(viewer, subject.athleteId);
  }
}

export function toProfileSubject(
  identity: SubjectIdentity,
  profile: AccountProfile,
): ProfileSubject {
  return {
    accountId: identity.accountId,
    isAthlete: identity.athleteId !== null,
    dob: identity.dob,
    hasPhoto: profile.photoBlobPath !== null,
    photoReviewState: profile.photoReviewState,
    nickname: profile.nickname,
    nicknameClearedAt: profile.nicknameClearedAt,
  };
}

/* ------------------------------------------------------------- MUTATIONS -- */

async function ensureProfileRow(organizationId: string, accountId: string): Promise<void> {
  await query(
    `insert into pilot.account_profiles (organization_id, account_id)
     values ($1, $2)
     on conflict (organization_id, account_id) do nothing`,
    [organizationId, accountId],
  );
}

export async function setCorner(
  organizationId: string,
  accountId: string,
  corner: CornerChoice,
): Promise<void> {
  await ensureProfileRow(organizationId, accountId);
  await query(
    `update pilot.account_profiles
     set corner = $3, updated_at = now()
     where organization_id = $1 and account_id = $2`,
    [organizationId, accountId, corner],
  );
}

export async function setProgram(
  organizationId: string,
  accountId: string,
  program: ProgramChoice,
): Promise<void> {
  await ensureProfileRow(organizationId, accountId);
  await query(
    `update pilot.account_profiles
     set program = $3, updated_at = now()
     where organization_id = $1 and account_id = $2`,
    [organizationId, accountId, program],
  );
}

/**
 * Set a ring name. Clears the takedown lock in the same statement, because a
 * successful set is only reachable once the lock has expired -- leaving the
 * timestamp behind would keep the field looking locked forever.
 */
export async function setNickname(
  organizationId: string,
  accountId: string,
  nickname: string,
): Promise<void> {
  await ensureProfileRow(organizationId, accountId);
  await query(
    `update pilot.account_profiles
     set display_nickname = $3,
         nickname_cleared_at = null,
         nickname_cleared_by_account_id = null,
         updated_at = now()
     where organization_id = $1 and account_id = $2`,
    [organizationId, accountId, nickname],
  );
}

/**
 * Take a ring name down.
 *
 * `clearedBy` is null when the member clears their own -- that is a member
 * changing their mind, not a moderation event, and it must not leave a record
 * that reads as staff having intervened. It also does not set the lock: nothing
 * is being enforced.
 */
export async function clearNickname(
  organizationId: string,
  accountId: string,
  clearedByAccountId: string | null,
): Promise<void> {
  await ensureProfileRow(organizationId, accountId);
  await query(
    `update pilot.account_profiles
     set display_nickname = null,
         nickname_cleared_at = case when $3::text is null then null else now() end,
         nickname_cleared_by_account_id = $3,
         updated_at = now()
     where organization_id = $1 and account_id = $2`,
    [organizationId, accountId, clearedByAccountId],
  );
}

export interface StoredPhoto {
  readonly blobPath: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
}

export async function setPhoto(
  organizationId: string,
  accountId: string,
  photo: StoredPhoto,
): Promise<void> {
  await ensureProfileRow(organizationId, accountId);
  await query(
    `update pilot.account_profiles
     set photo_blob_path = $3,
         photo_content_type = $4,
         photo_bytes = $5,
         photo_width = $6,
         photo_height = $7,
         photo_sha256 = $8,
         photo_uploaded_at = now(),
         -- A replacement re-enters review. A released photo whose bytes are
         -- swapped underneath it would be a released photo nobody ever looked
         -- at, which is the whole review defeated in one UPDATE.
         photo_review_state = 'pending_review',
         photo_reviewed_at = null,
         photo_reviewed_by_account_id = null,
         updated_at = now()
     where organization_id = $1 and account_id = $2`,
    [organizationId, accountId, photo.blobPath, photo.contentType, photo.bytes, photo.width, photo.height, photo.sha256],
  );
}

export async function clearPhoto(
  organizationId: string,
  accountId: string,
  reviewState: Extract<PhotoReviewState, 'removed' | 'blocked'>,
  reviewedByAccountId: string | null,
): Promise<void> {
  await query(
    `update pilot.account_profiles
     set photo_blob_path = null,
         photo_content_type = null,
         photo_bytes = null,
         photo_width = null,
         photo_height = null,
         photo_sha256 = null,
         photo_review_state = $3,
         photo_reviewed_at = now(),
         photo_reviewed_by_account_id = $4,
         updated_at = now()
     where organization_id = $1 and account_id = $2`,
    [organizationId, accountId, reviewState, reviewedByAccountId],
  );
}

export async function releasePhoto(
  organizationId: string,
  accountId: string,
  reviewedByAccountId: string,
): Promise<void> {
  await query(
    `update pilot.account_profiles
     set photo_review_state = 'released',
         photo_reviewed_at = now(),
         photo_reviewed_by_account_id = $3,
         updated_at = now()
     where organization_id = $1 and account_id = $2 and photo_blob_path is not null`,
    [organizationId, accountId, reviewedByAccountId],
  );
}
