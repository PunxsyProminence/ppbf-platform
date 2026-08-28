// Who may READ gym-wide coaching content: drills, and the cues that belong to
// them.
//
// This is one owner decision (2026-08-27), written once, because it was
// previously three answers. `/api/pilot/drills` gated to seven roles with a
// written rationale; `/api/pilot/drill-library` and
// `/api/pilot/coach/cue-library` gated to nothing at all, each with a written
// rationale of its own, and neither citing the other. All three serve the same
// class of content -- gym-wide coaching craft, carrying no athlete data -- so
// they cannot correctly hold three postures. The disagreement was recorded as
// an open question in those routes' tests before it was settled here.
//
// THE DECISION, in the terms it was issued:
//
//   board            DENIED. The board remains an oversight / aggregate-
//                    governance role, not an operational coaching-content
//                    role. This is what /api/pilot/drills already did; the
//                    other two surfaces now agree with it rather than the
//                    reverse.
//
//   platform_owner   ALLOWED, ORGANIZATION-SCOPED -- only through the
//                    organization carried by the authenticated principal.
//                    This is NOT a cross-organization wildcard: every read
//                    below still passes principal.organizationId to the data
//                    layer, which has no other way to be reached. It grants
//                    no access to athlete-private data, because none of these
//                    surfaces expose any.
//
//   the seven        PRESERVED exactly. No organization member who could read
//   org members      coaching content before this can read less after it.
//
// This is the shape shadowRoleSets.ts already describes for Omega: broader in
// breadth, strictly narrower in depth. Gym-wide drill text is operational
// content, so breadth reaches it; it is not PHI or SafeSport content, so the
// depth limit is not engaged.
//
// READ ONLY. Authoring is a separate, narrower question with a separate answer
// (DRILL_AUTHOR_ROLES in the drills route). platform_owner receiving read
// access here does not widen it, and deliberately did not.

import type { PilotRole } from './contracts';

/**
 * The eight roles that may read gym-wide drill and cue content.
 *
 * Written as an explicit list rather than derived from ORGANIZATION_MEMBER_ROLES
 * ON PURPOSE, even though it is exactly that set plus platform_owner today.
 * Deriving it would mean a change made to SHADOW's authorization set for
 * SHADOW's reasons silently changed who may read the drill library -- the
 * precise class of invisible coupling that produced three disagreeing postures
 * in the first place. coachingContentAccess.test.ts asserts the relationship
 * instead, so divergence surfaces as a failing test and a decision rather than
 * as a quiet change in who can read a gym's drills.
 */
export const COACHING_CONTENT_READER_ROLES: readonly PilotRole[] = [
  'platform_owner',
  'organization_admin',
  'admin',
  'coach',
  'athlete',
  'parent',
  'volunteer',
  'staff',
];
