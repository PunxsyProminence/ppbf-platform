/*
 * HUMAN LABELS FOR THE TEN FULL SPECTRUM DOMAINS.
 *
 * The vocabulary itself is NOT here. The ten values are owned by the CHECK
 * constraint in pilot_slice_postgres_athlete_development_block_objectives_migration.sql
 * and served to clients by the route, so a screen offers exactly what the
 * database will accept and cannot drift into offering an eleventh -- the
 * failure mode SMART_GOAL_CATEGORIES in AthleteWorkspace.tsx has to guard
 * against with a test, avoided here by not holding a copy.
 *
 * What lives here is presentation, and it lives in one file because two
 * surfaces now render these rows: the coach's authoring panel on
 * /coach/development-blocks, and the athlete's and guardian's read-only view
 * of the same plan. A second copy would be a second thing to update when a
 * domain is added, and the two screens would disagree about the same row in
 * front of the same family.
 *
 * developmentBlockDomains.test.ts asserts these keys are exactly
 * FULL_SPECTRUM_DOMAINS, in both directions: a domain added to the migration
 * without a label here fails a test rather than rendering to an athlete as a
 * raw snake_case slug about their own body.
 */
export const DOMAIN_LABEL: Record<string, string> = {
  technical: 'Technical',
  physical: 'Physical',
  conditioning: 'Conditioning',
  mental: 'Mental',
  recovery_load: 'Recovery & load',
  sparring_live_progression: 'Sparring & live progression',
  competition_preparation: 'Competition preparation',
  tactical_film_study: 'Tactical & film study',
  lifestyle_athlete_identity: 'Lifestyle & athlete identity',
  nutrition_body_composition: 'Nutrition & body composition',
};

/** A domain with no label yet reads as itself rather than as nothing. */
export function domainLabel(domain: string): string {
  return DOMAIN_LABEL[domain] ?? domain;
}

/** The four lifecycle states, and how each is named to a reader. */
export const BLOCK_STATUSES = ['draft', 'active', 'completed', 'cancelled'] as const;

export type DevelopmentBlockStatusValue = (typeof BLOCK_STATUSES)[number];

/* The design system's four-rung ladder. A block's status is a PLANNING state,
   not a safety state, so none of these wears a saturated safety rung:
   'cancelled' is filed, not restricted -- a coach abandoning a plan is not a
   participation block, and painting it like one is the Law 2 confusion the
   readiness bands were cleaned up over. Shared for the same reason the labels
   are: an athlete and their coach must not see the same block wearing
   different colours. */
export const STATUS_BADGE: Record<DevelopmentBlockStatusValue, { className: string; label: string }> = {
  draft: { className: 'badge--filed', label: 'Draft' },
  active: { className: 'badge--cleared', label: 'Active' },
  completed: { className: 'badge--monitor', label: 'Completed' },
  cancelled: { className: 'badge--filed', label: 'Cancelled' },
};
