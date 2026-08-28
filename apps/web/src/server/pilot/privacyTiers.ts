/**
 * Privacy-Tier System (capability #200) -- the NAMES for rules that already
 * exist, plus the one registry that never existed: field-level sensitivity.
 *
 * WHAT THIS MODULE IS. Six privacy tiers are already enforced across this
 * platform -- in access.ts, profileVisibility.ts, boardSummary.ts,
 * shadowRoleSets.ts, feedback.ts, wallDisplay.ts -- each with its own
 * reasoning, written before anything named the pattern they share. This
 * module gives the pattern a vocabulary so the NEXT consumer (a guardian
 * digest, a donor report, a body-composition tracker) can ask "what tier is
 * this field?" instead of reading twelve modules. It is a registry, not an
 * engine: every `enforcedBy` below names the module that actually refuses,
 * and privacyTiers.test.ts asserts those modules still exist and still hold
 * the invariant each tier claims.
 *
 * WHAT THIS MODULE IS NOT.
 * - Not a database table. Every rule here is a platform invariant, not a
 *   gym policy. pilot.safety_gates earned its per-org table because gyms
 *   genuinely differ on which gates they run; no gym gets to decide that
 *   its minors' photographs leave the minor circle. A configurable tier
 *   would advertise a configurability that must not exist, and the first
 *   admin UI built on it would be a vulnerability.
 * - Not an engine. The tier that decides whether a child's photograph
 *   reaches a screen (profileVisibility.ts) is pure and DB-free on purpose;
 *   putting a lookup in front of it would invert that. Enforcement stays
 *   where it is; this module points at it.
 * - Not middleware. A response-stripping interceptor would be bypassed by
 *   the first route that returns a custom shape while giving everyone false
 *   assurance. The conformance-test approach
 *   (organizationScope.convention.test.ts, wallOfNamesPrivacy.test.ts) has
 *   teeth precisely because it fails loudly at build time.
 * - Not authorization. requireRole tuples decide who may CALL a route;
 *   tiers decide how far a FIELD may travel. Session strength
 *   (requirePrincipal vs the Microsoft gate) is a third axis. Conflating
 *   them is a category error this header exists to prevent.
 *
 * THE TIERS ARE NOT A LADDER. minor_circle is strictly narrower than
 * athlete_record (it sits ON TOP of it -- profileDb calls
 * assertActorCanAccessAthlete first and then narrows), but board_aggregate
 * and deidentified_platform are LATERAL de-identified shapes, not rungs:
 * the board sees k-anonymous counts inside one org, the platform owner
 * sees breadth across orgs at strictly less depth than any org admin
 * ("broader in breadth, strictly narrower in depth" -- shadowRoleSets.ts).
 * Code must never compare tiers numerically.
 */

export type PrivacyTier =
  | 'public'
  | 'deidentified_platform'
  | 'board_aggregate'
  | 'organization'
  | 'athlete_record'
  | 'minor_circle';

export interface TierDoctrine {
  /** The audience shape, in one sentence. */
  readonly audience: string;
  /** The module + symbol that actually refuses. Checked for existence by privacyTiers.test.ts. */
  readonly enforcedBy: readonly string[];
  /** Why the tier is shaped the way it is. */
  readonly reason: string;
}

export const PRIVACY_TIER_DOCTRINE: Readonly<Record<PrivacyTier, TierDoctrine>> = {
  public: {
    audience: 'Unauthenticated surfaces: the gym wall and the wall of names.',
    enforcedBy: ['wallDisplay.ts#resolveDisplayVisibility', 'wallOfNamesPrivacy.test.ts', 'wallDisplayPrivacy.test.ts'],
    reason:
      'Only consent-released identity, defaulting to initials: a dated, guardian-signed waiver row is the '
      + 'sole thing that puts a full first name on a screen, and every unknown (no DOB, future-dated '
      + 'signature, non-guardian signer for a minor) resolves back to initials.',
  },
  deidentified_platform: {
    audience: 'The platform owner, across organizations.',
    enforcedBy: ['shadowRoleSets.ts#SHADOW_PHI_ROLES', 'feedback.ts#PLATFORM_FEEDBACK_SQL', 'omegaPlatformContext.ts'],
    reason:
      'Broader in breadth, strictly narrower in depth than an organization admin: no athlete ids, no '
      + 'names, and a safeguarding disclosure body is nulled even after de-identifying the columns, '
      + 'because a child\'s own words routinely re-identify both the child and the adult they name.',
  },
  board_aggregate: {
    audience: 'The board seat, inside one organization.',
    enforcedBy: ['boardSummary.ts#boardAggregateStatus', 'boardRoleBoundaries.test.ts'],
    reason:
      'Counts only, floored by k-anonymity (BOARD_MINIMUM_COHORT_SIZE distinct athletes) -- never a '
      + 'row, never a name, and a suppressed cohort reads insufficient_data, never a small real number.',
  },
  organization: {
    audience: 'Signed-in staff of one organization, per their role gates.',
    enforcedBy: ['organizationScope.convention.test.ts', 'access.ts#assertAthleteBelongsToOrganization'],
    reason:
      'Tenancy is the floor under every other tier: no route may take organization_id from the caller '
      + 'without a guard tying it to the principal, so one gym\'s data cannot be addressed from another.',
  },
  athlete_record: {
    audience: 'Actors with a per-subject relationship to one athlete.',
    enforcedBy: ['access.ts#assertActorCanAccessAthlete', 'guardianAccess.ts'],
    reason:
      'Role alone is never enough: a coach needs the coach_id of record or a live coverage grant, a '
      + 'parent needs a guardian link, an athlete is self-only -- and platform_owner and board are '
      + 'refused outright, which is what makes the two de-identified tiers lateral rather than above.',
  },
  minor_circle: {
    audience: 'self, coach_of_subject, guardian_of_subject -- nobody else.',
    enforcedBy: ['profileVisibility.ts#MINOR_CIRCLE', 'profileIdentity.privacy.test.ts'],
    reason:
      'The circle a minor\'s face never leaves. Deliberately narrower than athlete_record: an '
      + 'organization admin may read a child\'s record and still gets the brass plate instead of the '
      + 'photograph. Sits on top of athlete_record, never beside it.',
  },
};

export const PRIVACY_TIERS: readonly PrivacyTier[] = [
  'public',
  'deidentified_platform',
  'board_aggregate',
  'organization',
  'athlete_record',
  'minor_circle',
];

export interface FieldTierEntry {
  readonly tier: PrivacyTier;
  /** Where the assignment is enforced today. Checked for existence by privacyTiers.test.ts. */
  readonly enforcedBy: string;
  /** Only where the tier alone under-describes the rule. */
  readonly note?: string;
}

/**
 * Field-level sensitivity -- the registry that did not exist anywhere until
 * #200. Before this map, the platform's only field-level statements were
 * two denylists inside wall test files, scoped to the wall. A guardian
 * digest, a donor report, and the body-composition group each need the same
 * answers, so the assignments live here and the tests read this module.
 *
 * An entry is a CLAIM about current enforcement, not an aspiration: every
 * enforcedBy names real code, and adding a field means naming where its
 * tier is enforced -- if nowhere, the enforcement gap is the work item, not
 * the map entry.
 */
export const FIELD_TIERS: Readonly<Record<string, FieldTierEntry>> = {
  'athletes.full_name': {
    tier: 'organization',
    enforcedBy: 'wallDisplay.ts#resolveDisplayVisibility',
    note: 'Reaches the public tier ONLY through a dated, guardian-signed consent row; defaults to initials.',
  },
  'athletes.dob': {
    tier: 'athlete_record',
    enforcedBy: 'entities.ts#getAthletesForCoach',
    note:
      'Per-relationship for coaches, and now real rather than aspirational: the roster list still names '
      + 'every athlete, but dob comes back only for the coach of record or the holder of an active '
      + 'coverage grant. Every coach-reachable read of this column is scoped -- athletes/list through '
      + 'getAthletesForCoach, athletes/get + athletes/update + intake/domain-get through '
      + 'assertActorCanAccessAthlete. profile/roster selects dob to feed the portrait age gate and never '
      + 'returns it. Organization admins still read it org-wide, which is exactly what keeps this '
      + 'athlete_record rather than minor_circle. Redaction fails safe: a null dob is treated as a minor '
      + 'wherever age gates anything (wallDisplay.ts#isMinor).',
  },
  'athletes.weight_class': {
    tier: 'organization',
    enforcedBy: 'organizationScope.convention.test.ts',
    note:
      'A record about a person\'s body; the public floor is separately held by the wall denylist '
      + '(wallOfNamesPrivacy.test.ts). Org-wide for staff through athletes/list, and left that way on '
      + 'purpose when dob and emergency_contact were narrowed: a coach matching people for sparring or '
      + 'picking up cover needs it across the gym, and it identifies a body far less than a birth date '
      + 'or a guardian\'s phone number does.',
  },
  'athletes.gym_status': {
    tier: 'organization',
    enforcedBy: 'organizationScope.convention.test.ts',
    note:
      'Public floor held by the wall denylist; org-wide for staff through athletes/list, kept that way '
      + 'deliberately in the same field split -- who is active is what a coach plans a floor from.',
  },
  'athletes.emergency_contact': {
    tier: 'athlete_record',
    enforcedBy: 'entities.ts#getAthletesForCoach',
    note:
      'A phone number belonging to somebody who never agreed to appear anywhere; forbidden on every '
      + 'public read (wall denylist). Per-relationship for coaches by the same field split as '
      + 'athletes.dob -- org-wide staff reads through athletes/list ended with it. The roster export '
      + '(admin/export/roster) still carries it and is gated to organization_admin alone.',
  },
  'account_profiles.photo_blob_path': {
    tier: 'minor_circle',
    enforcedBy: 'profileVisibility.ts#decidePortrait',
    note:
      'photo_content_type and photo_review_state travel with it. The circle is applied '
      + 'per-relationship by profileDb.ts, which calls assertActorCanAccessAthlete FIRST and then '
      + 'narrows -- the record tier is the floor, never the ceiling.',
  },
  'account_profiles.display_nickname': {
    tier: 'minor_circle',
    enforcedBy: 'profileVisibility.ts#decideRingName',
    note: 'The ring name travels with the face, so there is one answer to "who can see my kid\'s stuff".',
  },
  'sessions.rpe': {
    tier: 'athlete_record',
    enforcedBy: 'access.ts#assertActorCanAccessAthlete',
  },
  'sessions.notes': {
    tier: 'athlete_record',
    enforcedBy: 'access.ts#assertActorCanAccessAthlete',
    note: 'Free text a coach typed about a child.',
  },
  'waivers.signed_by_name': {
    tier: 'athlete_record',
    enforcedBy: 'wallOfNamesPrivacy.test.ts',
    note: 'The family\'s own paperwork; public gates need only type, status, signer ROLE, and date.',
  },
  'waivers.notes': {
    tier: 'athlete_record',
    enforcedBy: 'wallOfNamesPrivacy.test.ts',
  },
  'medical_intake.clearance_status': {
    tier: 'athlete_record',
    enforcedBy: 'wallOfNamesPrivacy.test.ts',
  },
  'athlete_development_block_objectives.objective': {
    tier: 'athlete_record',
    enforcedBy: 'athleteDevelopmentBlockObjectives.ts#getBlockObjective',
    note:
      'A coach-authored sentence about one athlete\'s development, including -- since the owner '
      + 'decision of 2026-08-28 that admitted the nutrition_body_composition domain -- body-composition '
      + 'objectives about a named minor. This entry read `organization` for exactly as long as that was '
      + 'true: the reads were organization-scoped and nothing narrower was enforced, and the gap was '
      + 'recorded here as the work item. The second owner decision of 2026-08-28 -- reads are for '
      + '"Admin, Coach, Athlete, Guardian" -- closed it BEFORE any read surface shipped, which is the '
      + 'order this registry exists to insist on. Every read now resolves its parent block through '
      + 'getDevelopmentBlock, which calls assertActorCanAccessAthlete, so an org admin reaches their '
      + 'gym, a coach reaches their own and actively covered athletes, an athlete reaches themselves, a '
      + 'guardian reaches their linked child, and platform_owner and board reach none of it. There is '
      + 'still no API route or UI: this is the data layer\'s claim, and the route that ships first must '
      + 'pass a real ActorIdentity rather than reconstruct one. Note also that pilot.goals.category is a '
      + 'SEPARATE surface and still withholds Weight Loss / Weight Gain; the domain decision was about '
      + 'coach-authored objectives and did not reverse that one.',
  },
  'athlete_development_blocks.training_emphasis': {
    tier: 'athlete_record',
    enforcedBy: 'athleteDevelopmentBlocks.ts#getDevelopmentBlock',
    note:
      'The coach\'s own words about what a multi-week block is for, stored verbatim and read back '
      + 'verbatim. Nothing parses, classifies or scores it. Listed separately from the objective field '
      + 'because it is the parent record and the one that carries athlete_id: every athlete-scoped read '
      + 'in this slice resolves through it, so if this entry\'s claim is wrong the objectives entry is '
      + 'wrong too. Reads go through assertActorCanAccessAthlete (owner decision 2026-08-28, "Admin, '
      + 'Coach, Athlete, Guardian"); writes additionally require an active organization_memberships row '
      + 'in a DEVELOPMENT_BLOCK_WRITE_ROLES role ("Admin and coaches", same day). No API route or UI '
      + 'exists yet.',
  },
  'goals.category': {
    tier: 'athlete_record',
    enforcedBy: 'contracts.ts#GOAL_CATEGORIES',
    note:
      'Weight Loss / Weight Gain are withheld from the vocabulary entirely: filing a minor\'s weight '
      + 'intent as a queryable row waits on an explicit owner decision, which this registry makes '
      + 'possible and deliberately does not make.',
  },
  'feedback_submissions.body': {
    tier: 'organization',
    enforcedBy: 'feedback.ts#PLATFORM_FEEDBACK_SQL',
    note:
      'Diverges from the tier in BOTH directions, and both are deliberate. Stricter: a safeguarding '
      + 'body is org-admin triage only, nulled for the platform owner, never quoted outside the queue '
      + '(athleteVoice.ts files a pointer, not text). Looser: a product-routed body travels verbatim, '
      + 'cross-org, to the platform owner via PLATFORM_FEEDBACK_SQL -- de-identified by column, but '
      + 'the text is the text. The route decides which regime applies, frozen at write time.',
  },
  'safety_escalations.source_type': {
    tier: 'athlete_record',
    enforcedBy: 'escalationLadder.ts#listEscalations',
    note:
      'athlete_voice rows are stricter than the tier says: excluded from every coach-scoped read, '
      + 'because their existence alone says a child said something and the coach may be who it is about.',
  },
  'scheduler_attendance.checked_in_by_account_id': {
    tier: 'organization',
    enforcedBy: 'wallDisplayPrivacy.test.ts',
    note: 'Who checked a child in is staff bookkeeping; it never reaches a public surface.',
  },
  'scheduler_attendance.checked_in_by_role': {
    tier: 'organization',
    enforcedBy: 'wallDisplayPrivacy.test.ts',
    note: 'Which KIND of staff checked a child in is the same bookkeeping as who; never public.',
  },
  'training_holds.reason_text': {
    tier: 'organization',
    enforcedBy: '../../../app/api/pilot/training-holds/route.ts#athleteFacing',
    note:
      'Staff-facing detail behind a hold. The athlete and their guardians read the athlete-safe '
      + 'projection (explanation, lift condition, scope) and never this field.',
  },
  'training_holds.athlete_explanation': {
    tier: 'athlete_record',
    enforcedBy: '../../../app/api/pilot/training-holds/route.ts#athleteFacing',
    note: 'Written FOR the athlete: age-appropriate, non-punitive, required at placement.',
  },
  'training_holds.reason_category': {
    tier: 'organization',
    enforcedBy: '../../../app/api/pilot/training-holds/route.ts#athleteFacing',
    note: "A 'medical' category is a health signal; it stays off the athlete-safe projection with the rest.",
  },
  'scheduler_attendance.note': {
    tier: 'organization',
    enforcedBy: 'attendanceReporting.ts#getClassAttendanceRoster',
    note:
      'Free text a coach typed about a child. Honest, not aspirational: reads are bounded to '
      + 'class-owning coaches and org admins today, which is class scope, not per-athlete scope -- '
      + 'so the enforced tier is organization. The public floor is separately held by the wall '
      + 'denylist (bare \'note\' in the forbidden columns).',
  },
};

/**
 * Tables that never appear on an unauthenticated surface: health, safety,
 * clinical, or conduct records. Promoted out of wallOfNamesPrivacy.test.ts
 * and wallDisplayPrivacy.test.ts (which now read this module), so the same
 * denylist governs the NEXT public surface without being rediscovered.
 */
export const PUBLIC_SURFACE_FORBIDDEN_TABLES: readonly string[] = [
  'pilot.readiness',
  'pilot.medical_intake',
  'pilot.coach_observations',
  'pilot.assessments',
  'pilot.emergency_contacts',
  'pilot.shadow_medical',
  'pilot.shadow_near_misses',
  'pilot.feedback',
  'pilot.intake_cases',
  'pilot.documents',
  'pilot.compliance_violations',
  'pilot.training_holds',
];

/**
 * Columns on tables a public surface legitimately reads, which must not be
 * selected from them. Union of both wall tests' lists -- each surface must
 * avoid all of them, whichever tables it happens to join.
 */
export const PUBLIC_SURFACE_FORBIDDEN_COLUMNS: readonly string[] = [
  'weight_class',
  'gym_status',
  'emergency_contact',
  'clearance_status',
  'signed_by_name',
  // Bare 'note', not 'waivers.notes': the wall modules select with
  // UNQUALIFIED column lists, so a qualified string can never match the
  // drift it exists to catch. As a substring, 'note' covers both
  // waivers.notes and scheduler_attendance.note in one entry.
  'note',
  'checked_in_by_account_id',
  'checked_in_by_role',
];

/**
 * Training-log tables the WALL OF NAMES must not read -- not because a
 * check-in is secret (the television reads scheduler_attendance), but
 * because a shared board that shows a per-person count ranks children
 * against each other, which achievementPaths.ts forbids platform-wide.
 * Kept separate from the forbidden tables above because the rule is about
 * RANKING, not sensitivity.
 */
export const PUBLIC_RANKING_FORBIDDEN_TABLES: readonly string[] = [
  'pilot.sessions',
  'pilot.attendance',
  'pilot.scheduler_attendance',
  'pilot.athlete_milestones',
];
