import {
  resolveAdjudicationEligibility,
  resolveAnnotationSetVisibility,
  type BlindingSubjectSet,
} from './blinding';

// The decision table for independent double annotation, tested with no
// database in the way.
//
// WHY THIS FILE IS SEPARATE FROM THE .pg.test.ts. The pg suite proves the
// authorization boundary end to end -- that A really cannot read B's row out
// of a real Postgres. This one proves the RULE, exhaustively and in a
// millisecond, including the combinations that are awkward to stage against a
// live database (an unrecognised status, a sibling belonging to another
// organization, a sibling attached to a different clip). Both are needed: a
// correct rule wired to the wrong query still leaks, and a correct query
// carrying the wrong rule leaks too.
//
// THE THING BEING GUARDED. Every "cannot" below is a case where a naive
// implementation is green. Reading a submitted sibling before you have
// submitted yourself is the most plausible mistake in this file's subject
// matter, and it destroys the study silently -- the numbers still compute,
// they just no longer measure two independent readings.

const ORG = 'org-blind';
const OTHER_ORG = 'org-blind-other';
const CLIP = 'clip-1';
const OTHER_CLIP = 'clip-2';
const A = 'acct-a';
const B = 'acct-b';
const C = 'acct-c';

function setOf(
  annotatorAccountId: string,
  status: string,
  overrides: Partial<BlindingSubjectSet> = {},
): BlindingSubjectSet {
  return {
    organization_id: ORG,
    annotation_set_id: `set-${annotatorAccountId}-${overrides.calibration_clip_id ?? CLIP}`,
    calibration_clip_id: CLIP,
    annotator_account_id: annotatorAccountId,
    status,
    ...overrides,
  };
}

describe('resolveAnnotationSetVisibility', () => {
  test('an annotator always reads their own set, in progress', () => {
    const own = setOf(A, 'in_progress');

    expect(
      resolveAnnotationSetVisibility({
        actorAccountId: A,
        actorOrganizationId: ORG,
        actorRole: 'coach',
        requestedSet: own,
        siblingSets: [own],
      }),
    ).toEqual({ outcome: 'visible', reason: 'own_set' });
  });

  test('an annotator always reads their own set, submitted', () => {
    const own = setOf(A, 'submitted');

    expect(
      resolveAnnotationSetVisibility({
        actorAccountId: A,
        actorOrganizationId: ORG,
        actorRole: 'coach',
        requestedSet: own,
        siblingSets: [own, setOf(B, 'in_progress')],
      }),
    ).toEqual({ outcome: 'visible', reason: 'own_set' });
  });

  test('A cannot read B while B is still working', () => {
    const mine = setOf(A, 'submitted');
    const theirs = setOf(B, 'in_progress');

    expect(
      resolveAnnotationSetVisibility({
        actorAccountId: A,
        actorOrganizationId: ORG,
        actorRole: 'coach',
        requestedSet: theirs,
        siblingSets: [mine, theirs],
      }),
    ).toEqual({ outcome: 'blinded', reason: 'sibling_not_submitted' });
  });

  test("A cannot read B's SUBMITTED set while A has not submitted", () => {
    // The mistake this rule exists to prevent. B finishing first must not
    // hand A an answer key: A's remaining work would be a transcription of
    // B's, and every agreement figure computed later would be measuring one
    // reading against a copy of itself.
    const mine = setOf(A, 'in_progress');
    const theirs = setOf(B, 'submitted');

    expect(
      resolveAnnotationSetVisibility({
        actorAccountId: A,
        actorOrganizationId: ORG,
        actorRole: 'coach',
        requestedSet: theirs,
        siblingSets: [mine, theirs],
      }),
    ).toEqual({ outcome: 'blinded', reason: 'reader_not_submitted' });
  });

  test('both submitted, either may read the other', () => {
    const mine = setOf(A, 'submitted');
    const theirs = setOf(B, 'submitted');

    expect(
      resolveAnnotationSetVisibility({
        actorAccountId: A,
        actorOrganizationId: ORG,
        actorRole: 'coach',
        requestedSet: theirs,
        siblingSets: [mine, theirs],
      }),
    ).toEqual({ outcome: 'visible', reason: 'mutually_submitted' });

    expect(
      resolveAnnotationSetVisibility({
        actorAccountId: B,
        actorOrganizationId: ORG,
        actorRole: 'coach',
        requestedSet: mine,
        siblingSets: [mine, theirs],
      }),
    ).toEqual({ outcome: 'visible', reason: 'mutually_submitted' });
  });

  test('a reader with no set on the clip is not an annotator of it', () => {
    const a = setOf(A, 'submitted');
    const b = setOf(B, 'submitted');

    expect(
      resolveAnnotationSetVisibility({
        actorAccountId: C,
        actorOrganizationId: ORG,
        actorRole: 'coach',
        requestedSet: a,
        siblingSets: [a, b],
      }),
    ).toEqual({ outcome: 'blinded', reason: 'not_an_annotator_of_this_clip' });
  });

  test('an organization admin gets no privilege on this surface', () => {
    // The owner's explicit instruction: admins must not accidentally break
    // blinding through the normal annotator surface. An admin who is not
    // annotating this clip is exactly as blind as any other bystander, and an
    // admin who IS annotating it is bound by the same mutual-submission rule
    // as their counterpart. Reading both raw sets is a different act with a
    // different surface -- see resolveAdjudicationEligibility.
    const a = setOf(A, 'submitted');
    const b = setOf(B, 'in_progress');

    for (const role of ['organization_admin', 'admin', 'platform_owner'] as const) {
      expect(
        resolveAnnotationSetVisibility({
          actorAccountId: C,
          actorOrganizationId: ORG,
          actorRole: role,
          requestedSet: a,
          siblingSets: [a, b],
        }),
      ).toEqual({ outcome: 'blinded', reason: 'not_an_annotator_of_this_clip' });

      expect(
        resolveAnnotationSetVisibility({
          actorAccountId: A,
          actorOrganizationId: ORG,
          actorRole: role,
          requestedSet: b,
          siblingSets: [a, b],
        }),
      ).toEqual({ outcome: 'blinded', reason: 'sibling_not_submitted' });
    }
  });

  test('a set in another organization is refused outright', () => {
    const foreign = setOf(B, 'submitted', { organization_id: OTHER_ORG });

    expect(
      resolveAnnotationSetVisibility({
        actorAccountId: A,
        actorOrganizationId: ORG,
        actorRole: 'coach',
        requestedSet: foreign,
        siblingSets: [setOf(A, 'submitted'), foreign],
      }),
    ).toEqual({ outcome: 'blinded', reason: 'different_organization' });
  });

  test('the reader owning a foreign set does not make it theirs', () => {
    // Account ids are not guaranteed distinct across tenants by anything in
    // this schema; matching on the id alone would be a cross-tenant read
    // dressed up as "your own set".
    const foreign = setOf(A, 'in_progress', { organization_id: OTHER_ORG });

    expect(
      resolveAnnotationSetVisibility({
        actorAccountId: A,
        actorOrganizationId: ORG,
        actorRole: 'coach',
        requestedSet: foreign,
        siblingSets: [foreign],
      }),
    ).toEqual({ outcome: 'blinded', reason: 'different_organization' });
  });

  test('a sibling in another organization cannot make the reader an annotator', () => {
    const theirs = setOf(B, 'submitted');
    const foreignOwn = setOf(A, 'submitted', { organization_id: OTHER_ORG });

    expect(
      resolveAnnotationSetVisibility({
        actorAccountId: A,
        actorOrganizationId: ORG,
        actorRole: 'coach',
        requestedSet: theirs,
        siblingSets: [theirs, foreignOwn],
      }),
    ).toEqual({ outcome: 'blinded', reason: 'not_an_annotator_of_this_clip' });
  });

  test("a set on a different clip does not count as the reader's own", () => {
    // Submitting on clip 2 must not unlock clip 1. Eligibility is per clip,
    // because independence is per clip.
    const theirs = setOf(B, 'submitted');
    const mineElsewhere = setOf(A, 'submitted', { calibration_clip_id: OTHER_CLIP });

    expect(
      resolveAnnotationSetVisibility({
        actorAccountId: A,
        actorOrganizationId: ORG,
        actorRole: 'coach',
        requestedSet: theirs,
        siblingSets: [theirs, mineElsewhere],
      }),
    ).toEqual({ outcome: 'blinded', reason: 'not_an_annotator_of_this_clip' });
  });

  test('an unrecognised status is never read as submitted', () => {
    // Default to less. A status this build does not know is not evidence that
    // anybody finished anything.
    const mine = setOf(A, 'submitted');
    const theirs = setOf(B, 'SUBMITTED');

    expect(
      resolveAnnotationSetVisibility({
        actorAccountId: A,
        actorOrganizationId: ORG,
        actorRole: 'coach',
        requestedSet: theirs,
        siblingSets: [mine, theirs],
      }),
    ).toEqual({ outcome: 'blinded', reason: 'sibling_not_submitted' });

    expect(
      resolveAnnotationSetVisibility({
        actorAccountId: A,
        actorOrganizationId: ORG,
        actorRole: 'coach',
        requestedSet: setOf(B, 'submitted'),
        siblingSets: [setOf(A, 'finished-ish'), setOf(B, 'submitted')],
      }),
    ).toEqual({ outcome: 'blinded', reason: 'reader_not_submitted' });
  });

  test('the requested set need not appear among the siblings', () => {
    // Callers pass whatever the clip query returned. The decision must not
    // depend on the requested row being present in that list a second time.
    const mine = setOf(A, 'submitted');
    const theirs = setOf(B, 'submitted');

    expect(
      resolveAnnotationSetVisibility({
        actorAccountId: A,
        actorOrganizationId: ORG,
        actorRole: 'coach',
        requestedSet: theirs,
        siblingSets: [mine],
      }),
    ).toEqual({ outcome: 'visible', reason: 'mutually_submitted' });
  });
});

describe('resolveAdjudicationEligibility', () => {
  const bothSubmitted = [setOf(A, 'submitted'), setOf(B, 'submitted')];

  test('an organization admin may adjudicate once every set is submitted', () => {
    expect(
      resolveAdjudicationEligibility({ actorRole: 'organization_admin', sets: bothSubmitted }),
    ).toEqual({ outcome: 'eligible', submittedSetCount: 2 });
  });

  test('a legacy admin row is the same person', () => {
    // access.ts treats 'admin' and 'organization_admin' as one role. A gate
    // here that used a bare === would lock every un-migrated admin row out of
    // the review surface while looking correct in a test seeded only with the
    // new spelling.
    expect(
      resolveAdjudicationEligibility({ actorRole: 'admin', sets: bothSubmitted }),
    ).toEqual({ outcome: 'eligible', submittedSetCount: 2 });
  });

  test('nobody else may adjudicate, however finished the clip is', () => {
    for (const role of ['coach', 'athlete', 'parent', 'board', 'staff', 'volunteer'] as const) {
      expect(
        resolveAdjudicationEligibility({ actorRole: role, sets: bothSubmitted }),
      ).toEqual({ outcome: 'refused', reason: 'role_not_permitted' });
    }
  });

  test('the platform owner is not an adjudicator either', () => {
    // Not an oversight. This surface exists so an ORGANIZATION can resolve a
    // disagreement between its own two annotators; a platform-wide role is
    // not a party to that, and admitting it here would be this file inventing
    // a reach into tenant research data that nobody ratified.
    expect(
      resolveAdjudicationEligibility({ actorRole: 'platform_owner', sets: bothSubmitted }),
    ).toEqual({ outcome: 'refused', reason: 'role_not_permitted' });
  });

  test('one unfinished set blocks the whole clip', () => {
    expect(
      resolveAdjudicationEligibility({
        actorRole: 'organization_admin',
        sets: [setOf(A, 'submitted'), setOf(B, 'in_progress')],
      }),
    ).toEqual({ outcome: 'refused', reason: 'annotation_in_progress' });
  });

  test('the role is checked before the state, so a coach learns nothing about progress', () => {
    expect(
      resolveAdjudicationEligibility({
        actorRole: 'coach',
        sets: [setOf(A, 'submitted'), setOf(B, 'in_progress')],
      }),
    ).toEqual({ outcome: 'refused', reason: 'role_not_permitted' });
  });

  test('a clip nobody has annotated is not adjudicable', () => {
    expect(
      resolveAdjudicationEligibility({ actorRole: 'organization_admin', sets: [] }),
    ).toEqual({ outcome: 'refused', reason: 'no_sets_on_clip' });
  });

  test('an unrecognised status blocks adjudication', () => {
    expect(
      resolveAdjudicationEligibility({
        actorRole: 'organization_admin',
        sets: [setOf(A, 'submitted'), setOf(B, 'archived')],
      }),
    ).toEqual({ outcome: 'refused', reason: 'annotation_in_progress' });
  });

  test('a single submitted set is not a pair, and is refused', () => {
    // The regression this exists for. `every` is true of a one-element list,
    // so this returned { eligible, submittedSetCount: 1 } -- promising a
    // caller two raw readings and handing it one. The zero case beside it was
    // already guarded for exactly this reason; one set is the same mistake a
    // step along.
    expect(
      resolveAdjudicationEligibility({
        actorRole: 'organization_admin',
        sets: [setOf(A, 'submitted')],
      }),
    ).toEqual({ outcome: 'refused', reason: 'insufficient_sets_for_comparison' });
  });

  test('a single UNFINISHED set is reported as progress, not as a missing pair', () => {
    // Both refusals would be literally true here, and the order is deliberate:
    // a second reading may still arrive, so the useful thing to tell an
    // adjudicator is that the work is unfinished -- not that the pair is
    // structurally impossible.
    expect(
      resolveAdjudicationEligibility({
        actorRole: 'organization_admin',
        sets: [setOf(A, 'in_progress')],
      }),
    ).toEqual({ outcome: 'refused', reason: 'annotation_in_progress' });
  });

  test('the role is still checked first, so a coach on a one-set clip learns nothing', () => {
    expect(
      resolveAdjudicationEligibility({
        actorRole: 'coach',
        sets: [setOf(A, 'submitted')],
      }),
    ).toEqual({ outcome: 'refused', reason: 'role_not_permitted' });
  });

  test('three submitted sets stay eligible here -- the pair is the caller to choose', () => {
    // This function establishes that there is more than one reading to
    // compare. WHICH pair a study means when there are three is not settled
    // anywhere in the codebase, and inventing an answer here would decide it
    // silently for every caller. The comparison route refuses that case on
    // its own terms and says so in as many words.
    expect(
      resolveAdjudicationEligibility({
        actorRole: 'organization_admin',
        sets: [setOf(A, 'submitted'), setOf(B, 'submitted'), setOf(C, 'submitted')],
      }),
    ).toEqual({ outcome: 'eligible', submittedSetCount: 3 });
  });
});
