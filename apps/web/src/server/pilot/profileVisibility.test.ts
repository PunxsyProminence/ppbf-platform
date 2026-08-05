/**
 * THE PRIVACY SUITE.
 *
 * Everything here is one question asked from many directions: can a photograph
 * or a self-chosen name attached to somebody's child reach a person who has no
 * business with that child. The answer has to be no from every direction, so
 * the awkward directions are the ones spelled out -- another family, an
 * organization admin, a coach who is not this athlete's coach, an athlete whose
 * date of birth was never recorded, and a photograph nobody has looked at yet.
 */

import { queryOne } from './db';
import type { ActorIdentity } from './access';
import {
  decidePortrait,
  decideRingName,
  normalizePhotoReviewState,
  type ProfileRelationship,
  type ProfileSubject,
} from './profileVisibility';
import { resolveRelationship, staffDisplayName, type SubjectIdentity } from './profileDb';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockQueryOne = queryOne as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

const NOW = new Date('2026-08-03T00:00:00Z');

function subject(overrides: Partial<ProfileSubject> = {}): ProfileSubject {
  return {
    accountId: 'acct-child',
    isAthlete: true,
    dob: '2014-05-02', // 12 years old at NOW
    hasPhoto: true,
    photoReviewState: 'released',
    nickname: 'The Groundhog',
    nicknameClearedAt: null,
    ...overrides,
  };
}

const EVERY_RELATIONSHIP: readonly ProfileRelationship[] = [
  'self',
  'coach_of_subject',
  'guardian_of_subject',
  'subject_is_my_staff',
  'organization_staff',
  'none',
];

/* ------------------------------------------------- THE MINOR'S CIRCLE ----- */

describe("a minor's photograph never leaves their own circle", () => {
  it('reaches the child, their coach of record, and their linked guardian', () => {
    for (const relationship of ['self', 'coach_of_subject', 'guardian_of_subject'] as const) {
      expect(decidePortrait(subject(), relationship, NOW).show).toBe('photo');
    }
  });

  it('does NOT reach another family -- the cross-family boundary', () => {
    // A parent who is not linked to this athlete resolves to 'none', and 'none'
    // gets the plate. This is the case the whole feature is built around.
    expect(decidePortrait(subject(), 'none', NOW))
      .toEqual({ show: 'plate', reason: 'minor_outside_own_circle' });
  });

  it('does NOT reach the organization’s own administrators', () => {
    // Stricter than access.ts on purpose: an admin may read a child's record,
    // which is right for a record and wrong for a photograph of a child.
    expect(decidePortrait(subject(), 'organization_staff', NOW))
      .toEqual({ show: 'plate', reason: 'minor_outside_own_circle' });
  });

  it('does NOT reach a coach who is not this athlete’s coach', () => {
    // An unassigned coach resolves to 'organization_staff', never
    // 'coach_of_subject'.
    expect(decidePortrait(subject(), 'organization_staff', NOW).show).toBe('plate');
  });

  it('treats an unrecorded date of birth as a minor', () => {
    const unknownAge = subject({ dob: null });
    expect(decidePortrait(unknownAge, 'organization_staff', NOW).show).toBe('plate');
    expect(decidePortrait(unknownAge, 'coach_of_subject', NOW).show).toBe('photo');
  });

  it('treats an unparseable date of birth as a minor', () => {
    expect(decidePortrait(subject({ dob: 'sometime in 2001' }), 'organization_staff', NOW).show)
      .toBe('plate');
  });
});

/* ----------------------------------------------------- REVIEW STATE ------- */

describe('a photograph nobody has looked at is nobody else’s to see', () => {
  it('shows the plate to everyone except the uploader while it is pending', () => {
    const pending = subject({ photoReviewState: 'pending_review' });
    expect(decidePortrait(pending, 'self', NOW).show).toBe('photo');
    for (const relationship of EVERY_RELATIONSHIP.filter((r) => r !== 'self')) {
      expect(decidePortrait(pending, relationship, NOW))
        .toEqual({ show: 'plate', reason: 'not_released' });
    }
  });

  it('a takedown reaches the uploader too', () => {
    for (const state of ['blocked', 'removed'] as const) {
      expect(decidePortrait(subject({ photoReviewState: state }), 'self', NOW).show).toBe('plate');
    }
  });

  it('treats an unreadable review state as not released', () => {
    expect(normalizePhotoReviewState('approved')).toBe('pending_review');
    expect(normalizePhotoReviewState(undefined)).toBe('pending_review');
    expect(normalizePhotoReviewState('')).toBe('pending_review');
    expect(normalizePhotoReviewState('released')).toBe('released');
  });

  it('shows the plate when there is no photograph at all', () => {
    for (const relationship of EVERY_RELATIONSHIP) {
      expect(decidePortrait(subject({ hasPhoto: false }), relationship, NOW))
        .toEqual({ show: 'plate', reason: 'no_photo' });
    }
  });

  it('gives the same answer for "no photo" and "photo you may not see"', () => {
    // The reasons differ for the developer reading a log; what reaches the
    // client is `show`, and it must be identical -- a viewer told a photograph
    // exists but is withheld has been told something about that child.
    expect(decidePortrait(subject({ hasPhoto: false }), 'none', NOW).show)
      .toBe(decidePortrait(subject(), 'none', NOW).show);
  });
});

/* --------------------------------------------------------- ADULTS --------- */

describe('an adult member', () => {
  const adult = subject({ dob: '1990-01-01' });

  it('is visible to their own coach, their guardianship links, and gym staff', () => {
    for (const relationship of ['self', 'coach_of_subject', 'guardian_of_subject', 'organization_staff'] as const) {
      expect(decidePortrait(adult, relationship, NOW).show).toBe('photo');
    }
  });

  it('is still not visible to somebody with no relationship at all', () => {
    expect(decidePortrait(adult, 'none', NOW)).toEqual({ show: 'plate', reason: 'no_relationship' });
  });

  it('turns eighteen and stops being inside the minor rule', () => {
    const eighteenToday = subject({ dob: '2008-08-03' });
    const seventeen = subject({ dob: '2008-08-04' });
    expect(decidePortrait(eighteenToday, 'organization_staff', NOW).show).toBe('photo');
    expect(decidePortrait(seventeen, 'organization_staff', NOW).show).toBe('plate');
  });
});

describe('a staff member’s face is how "who is in your corner" works', () => {
  const coach = subject({ isAthlete: false, dob: null });

  it('reaches the athletes they coach and those athletes’ guardians', () => {
    expect(decidePortrait(coach, 'subject_is_my_staff', NOW).show).toBe('photo');
  });

  it('reaches their colleagues', () => {
    expect(decidePortrait(coach, 'organization_staff', NOW).show).toBe('photo');
  });

  it('does not reach an account with no relationship', () => {
    expect(decidePortrait(coach, 'none', NOW).show).toBe('plate');
  });

  it('is still gated on review', () => {
    expect(decidePortrait({ ...coach, photoReviewState: 'pending_review' }, 'subject_is_my_staff', NOW).show)
      .toBe('plate');
  });
});

/* ------------------------------------------------------- RING NAME -------- */

describe('the ring name travels with the face', () => {
  it('reaches a minor’s own circle and nobody else', () => {
    expect(decideRingName(subject(), 'self', NOW)).toBe('The Groundhog');
    expect(decideRingName(subject(), 'coach_of_subject', NOW)).toBe('The Groundhog');
    expect(decideRingName(subject(), 'guardian_of_subject', NOW)).toBe('The Groundhog');
    expect(decideRingName(subject(), 'organization_staff', NOW)).toBeNull();
    expect(decideRingName(subject(), 'none', NOW)).toBeNull();
  });

  it('is gone for everyone once staff clear it, including the athlete', () => {
    const cleared = subject({ nicknameClearedAt: '2026-08-02T00:00:00Z' });
    for (const relationship of EVERY_RELATIONSHIP) {
      expect(decideRingName(cleared, relationship, NOW)).toBeNull();
    }
  });

  it('is null when none was ever set', () => {
    expect(decideRingName(subject({ nickname: null }), 'self', NOW)).toBeNull();
  });

  it('does NOT ride on the photograph’s review state -- a name is not a face', () => {
    // Deliberate: a pending photograph is invisible, but a ring name has been
    // set by the member and read by the same three parties either way. Stating
    // it here so a future change to one does not silently move the other.
    expect(decideRingName(subject({ photoReviewState: 'pending_review' }), 'coach_of_subject', NOW))
      .toBe('The Groundhog');
  });
});

/* --------------------------------------------- RELATIONSHIP RESOLUTION ---- */

function viewer(overrides: Partial<ActorIdentity> = {}): ActorIdentity {
  return {
    accountId: 'acct-viewer',
    role: 'parent',
    organizationId: 'org-1',
    athleteId: null,
    ...overrides,
  };
}

function athleteSubject(overrides: Partial<SubjectIdentity> = {}): SubjectIdentity {
  return {
    accountId: 'acct-child',
    fullName: 'Sofia Alvarez',
    athleteId: 'ath-1',
    dob: '2014-05-02',
    coachAccountId: 'acct-coach',
    memberSince: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('resolveRelationship is the cross-family boundary', () => {
  it('gives an unlinked parent "none", not "organization_staff"', async () => {
    // The guardian_links lookup finds nothing: this parent has no link to this
    // athlete. The branch returns 'none' outright rather than falling through
    // to a weaker-but-still-permissive value.
    mockQueryOne.mockResolvedValueOnce(null);
    await expect(resolveRelationship(viewer({ role: 'parent' }), athleteSubject(), 'org-1'))
      .resolves.toBe('none');
  });

  it('gives a linked guardian "guardian_of_subject"', async () => {
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    await expect(resolveRelationship(viewer({ role: 'parent' }), athleteSubject(), 'org-1'))
      .resolves.toBe('guardian_of_subject');
  });

  it('an unlinked parent plus the portrait rule is a plate, end to end', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    const relationship = await resolveRelationship(viewer({ role: 'parent' }), athleteSubject(), 'org-1');
    expect(decidePortrait(subject(), relationship, NOW).show).toBe('plate');
    expect(decideRingName(subject(), relationship, NOW)).toBeNull();
  });

  it('gives the coach of record "coach_of_subject" and any other coach "organization_staff"', async () => {
    await expect(resolveRelationship(
      viewer({ role: 'coach', accountId: 'acct-coach' }), athleteSubject(), 'org-1',
    )).resolves.toBe('coach_of_subject');

    await expect(resolveRelationship(
      viewer({ role: 'coach', accountId: 'acct-other-coach' }), athleteSubject(), 'org-1',
    )).resolves.toBe('organization_staff');
  });

  it('refuses across organizations before it looks anything up', async () => {
    await expect(resolveRelationship(viewer({ organizationId: 'org-2' }), athleteSubject(), 'org-1'))
      .resolves.toBe('none');
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('refuses the platform owner and the board outright', async () => {
    for (const role of ['platform_owner', 'board'] as const) {
      await expect(resolveRelationship(viewer({ role }), athleteSubject(), 'org-1'))
        .resolves.toBe('none');
    }
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('gives a member themselves "self" without a lookup', async () => {
    await expect(resolveRelationship(
      viewer({ accountId: 'acct-child', role: 'athlete' }), athleteSubject(), 'org-1',
    )).resolves.toBe('self');
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('gives an athlete "subject_is_my_staff" only for their own coach', async () => {
    const coachSubject = athleteSubject({
      accountId: 'acct-coach', athleteId: null, dob: null, coachAccountId: null, fullName: 'Ray Nolan',
    });
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    await expect(resolveRelationship(
      viewer({ role: 'athlete', accountId: 'acct-child', athleteId: 'ath-1' }), coachSubject, 'org-1',
    )).resolves.toBe('subject_is_my_staff');

    mockQueryOne.mockResolvedValueOnce(null);
    await expect(resolveRelationship(
      viewer({ role: 'athlete', accountId: 'acct-child', athleteId: 'ath-9' }), coachSubject, 'org-1',
    )).resolves.toBe('none');
  });

  it('gives a volunteer nothing at all', async () => {
    await expect(resolveRelationship(viewer({ role: 'volunteer' }), athleteSubject(), 'org-1'))
      .resolves.toBe('none');
  });
});

describe('staff names come from what the platform actually knows', () => {
  it('reads an address into a name', () => {
    expect(staffDisplayName('jane.okafor@example.org', 'acct-9')).toBe('Jane Okafor');
    expect(staffDisplayName('ray_nolan@example.org', 'acct-9')).toBe('Ray Nolan');
  });

  it('falls back to the account id rather than inventing a name', () => {
    expect(staffDisplayName(null, 'acct-9')).toBe('acct-9');
    expect(staffDisplayName('12345@example.org', 'acct-9')).toBe('acct-9');
  });
});
