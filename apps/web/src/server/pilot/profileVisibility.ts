/**
 * WHO MAY SEE A FACE.
 *
 * This module is pure and it is the whole privacy decision for portraits and
 * ring names. It is separate from profileDb.ts for the same reason
 * wallDisplay.ts is separate from wallDisplayDb.ts: the rule that decides
 * whether a child's photograph reaches a screen has to be testable without a
 * database, and it has to be readable in one sitting.
 *
 * ---------------------------------------------------------------------------
 * THE CONSENT MODEL DOES NOT COVER DISPLAY.
 *
 * wallDisplay.ts already established this and nothing has changed since:
 * pilot.waivers is a freeform document record whose every writer defaults
 * waiver_type to 'general'; public_interest_submissions.consent_to_contact is
 * an adult agreeing to be emailed. Neither is a release to show a child's face
 * to anybody.
 *
 * So this file does not look for consent, because there is none to find. It
 * decides on RELATIONSHIP instead, and the relationship set is deliberately the
 * three parties a child's photograph is already shared with in the physical
 * gym: the child, the coaches who train them, and the guardians who bring them.
 * Everyone else -- including the organization's own administrators, including
 * the board, including the platform owner -- gets the brass plate.
 *
 * That is stricter than the platform's general athlete-record boundary, on
 * purpose. access.ts lets an organization_admin read any athlete record in
 * their organization, and that is right for a record; it is not right for a
 * photograph of somebody's twelve-year-old. This module therefore sits ON TOP
 * OF the existing boundary and never beside it: profileDb.ts calls
 * assertActorCanAccessAthlete first, so nothing here can widen what access.ts
 * already refused, and then narrows further for faces.
 *
 * DEFAULT TO LESS. Every unknown in this file resolves to the plate:
 * unknown age is a minor, an unreadable relationship is 'none', a photo whose
 * review state cannot be read has not been released.
 * ---------------------------------------------------------------------------
 */

import { isMinor } from './wallDisplay';

/**
 * How the viewer stands to the subject. Resolved by profileDb.ts from
 * pilot.athletes.coach_id and pilot.guardian_links -- the same two joins
 * access.ts uses, so there is one definition of "your coach" and one of "your
 * guardian" in the codebase rather than a parallel pair invented here.
 */
export type ProfileRelationship =
  /** The viewer is the subject. */
  | 'self'
  /** The viewer is the coach of record for this athlete. */
  | 'coach_of_subject'
  /** The viewer is a guardian linked to this athlete. */
  | 'guardian_of_subject'
  /** The subject is a staff member in the viewer's own corner -- their coach,
   *  or the coach of a child they are guardian to. */
  | 'subject_is_my_staff'
  /** Same organization, no direct link. An admin, another coach, the board. */
  | 'organization_staff'
  /** No relationship this platform recognises. Another family, another org. */
  | 'none';

/**
 * A photograph's life. Born pending, and it needs a person to move it.
 *
 * The video pipeline shipped a quarantine state with no exit and every upload
 * died in it (see the video-sessions migration). This state machine has an
 * exit that exists in the code: an organization admin or one of the athlete's
 * own coaches releases it. That is a real human looking at a real picture,
 * which is the only review a portrait can honestly get -- the platform cannot
 * tell whether a photograph of a child is an appropriate photograph of a child,
 * and it must not pretend to.
 *
 * The uploader always sees their own pending photo, so the feature gives
 * feedback on day one without anything being released to anyone else.
 */
export type PhotoReviewState = 'pending_review' | 'released' | 'blocked' | 'removed';

export const PHOTO_REVIEW_STATES: readonly PhotoReviewState[] = [
  'pending_review',
  'released',
  'blocked',
  'removed',
];

export function normalizePhotoReviewState(raw: unknown): PhotoReviewState {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  // Anything unrecognised is treated as still pending. An unreadable review
  // state is not a release.
  return (PHOTO_REVIEW_STATES as readonly string[]).includes(value) && value !== ''
    ? (value as PhotoReviewState)
    : 'pending_review';
}

export interface ProfileSubject {
  readonly accountId: string;
  /** True when this account has an athlete record -- a participant, not staff. */
  readonly isAthlete: boolean;
  /** The athlete's date of birth, or null. Null is treated as a minor. */
  readonly dob: string | null;
  readonly hasPhoto: boolean;
  readonly photoReviewState: PhotoReviewState;
  readonly nickname: string | null;
  readonly nicknameClearedAt: string | null;
}

export type PortraitDecision = 'photo' | 'plate';

export type PortraitReason =
  | 'self'
  | 'released_to_own_coach'
  | 'released_to_own_guardian'
  | 'released_to_own_staff'
  | 'released_to_organization_staff'
  | 'no_photo'
  | 'not_released'
  | 'minor_outside_own_circle'
  | 'no_relationship';

export interface PortraitVisibility {
  readonly show: PortraitDecision;
  readonly reason: PortraitReason;
}

/**
 * The circle a minor's face never leaves. Written out rather than derived, so
 * widening it is an edit somebody has to make on purpose.
 */
const MINOR_CIRCLE: readonly ProfileRelationship[] = [
  'self',
  'coach_of_subject',
  'guardian_of_subject',
];

export function decidePortrait(
  subject: ProfileSubject,
  relationship: ProfileRelationship,
  now: Date,
): PortraitVisibility {
  // A member always sees their own picture, including while it is pending, so
  // uploading gives feedback without releasing anything to anybody else. The
  // one thing self does not survive is a staff block or a delete: if a coach
  // took the picture down, it is down for the uploader too, which is what makes
  // a takedown a takedown.
  if (relationship === 'self') {
    if (!subject.hasPhoto) return { show: 'plate', reason: 'no_photo' };
    if (subject.photoReviewState === 'blocked' || subject.photoReviewState === 'removed') {
      return { show: 'plate', reason: 'not_released' };
    }
    return { show: 'photo', reason: 'self' };
  }

  if (!subject.hasPhoto) return { show: 'plate', reason: 'no_photo' };
  if (subject.photoReviewState !== 'released') return { show: 'plate', reason: 'not_released' };

  // A participant with an athlete record. Unknown age is a minor -- a gym whose
  // records are incomplete must not have that read as "adult, publish freely".
  if (subject.isAthlete) {
    if (isMinor(subject.dob, now)) {
      if (!MINOR_CIRCLE.includes(relationship)) {
        return { show: 'plate', reason: 'minor_outside_own_circle' };
      }
      return {
        show: 'photo',
        reason: relationship === 'coach_of_subject'
          ? 'released_to_own_coach'
          : 'released_to_own_guardian',
      };
    }

    // An adult athlete -- the fitness member, the adult recreational class.
    // Their own coaches and guardianship links, plus the organization's staff,
    // and nobody else. Still no cross-family visibility.
    if (relationship === 'coach_of_subject') return { show: 'photo', reason: 'released_to_own_coach' };
    if (relationship === 'guardian_of_subject') return { show: 'photo', reason: 'released_to_own_guardian' };
    if (relationship === 'organization_staff') return { show: 'photo', reason: 'released_to_organization_staff' };
    return { show: 'plate', reason: 'no_relationship' };
  }

  // Staff: a coach, an admin, a volunteer. An adult doing a public-facing job,
  // whose face the platform shows to the people they work with -- that is the
  // whole point of "who's in your corner". Not to strangers: an account with no
  // relationship at all still gets the plate.
  if (relationship === 'subject_is_my_staff') return { show: 'photo', reason: 'released_to_own_staff' };
  if (relationship === 'organization_staff') return { show: 'photo', reason: 'released_to_organization_staff' };
  if (relationship === 'coach_of_subject' || relationship === 'guardian_of_subject') {
    return { show: 'photo', reason: 'released_to_organization_staff' };
  }
  return { show: 'plate', reason: 'no_relationship' };
}

/**
 * The ring name travels with the face.
 *
 * It is a smaller disclosure than a photograph but it is the same kind: a
 * self-written string attached to a child, readable by whoever the platform
 * shows it to. Scoping it identically means there is one answer to "who can see
 * my kid's stuff" rather than two that drift, and it is the mechanism that
 * makes the no-wordlist moderation decision defensible (profileIdentity.ts):
 * an unmoderated string only three named parties can read is a bounded problem.
 *
 * A cleared ring name is nobody's to see, including the athlete's own -- the
 * settings screen tells them it was cleared instead of showing it back.
 */
export function decideRingName(
  subject: ProfileSubject,
  relationship: ProfileRelationship,
  now: Date,
): string | null {
  if (!subject.nickname) return null;
  if (subject.nicknameClearedAt) return null;

  if (relationship === 'self') return subject.nickname;

  if (subject.isAthlete && isMinor(subject.dob, now)) {
    return MINOR_CIRCLE.includes(relationship) ? subject.nickname : null;
  }

  return relationship === 'none' ? null : subject.nickname;
}
