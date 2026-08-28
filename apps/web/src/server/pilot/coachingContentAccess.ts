// Who may READ gym-wide coaching content: drills, the cues that belong to
// them, and the session scripts and workout templates built out of them.
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
//
// EXTENDED (owner ruling, 2026-08-28). The decision above was issued against
// three routes, and the question left over was whether those three were its
// subject or merely its occasion. Put to the owner as exactly that -- does the
// policy govern the CONTENT CLASS, or only the routes it named -- he answered
// the content class.
//
// So `/api/pilot/session-scripts` and `/api/pilot/workout-templates` come under
// it too. A session script is the gym's own teaching plan and a workout
// template is the gym's own catalogue: both are coaching craft, both carry no
// athlete data, and both were reachable by every authenticated role because
// each route answered the question alone and answered it the same way the
// other two ungated ones had. Five surfaces now hold one posture instead of
// two-and-three.
//
// Nothing in the ruling above moves. `board` is DENIED on the two new
// surfaces, which is read access it previously had and now loses; the other
// eight roles are preserved exactly, on all five. The list itself is
// unchanged -- this is a decision about which routes reach the policy, not
// about who is in it.
//
// NOT extended to it: `/api/pilot/session-scripts/runs/**`. What happened on a
// given night is athlete data, it is already gated to
// ['coach','admin','organization_admin','platform_owner'], and it is a
// different class under a decision of its own. Sharing a path prefix with a
// script is not sharing its content class.
//
// Where the gate goes is part of the decision, not an implementation detail.
// It runs immediately after requirePrincipal and BEFORE any query parsing on
// all five routes. Measured on cue-library: with the gate below the focus_type
// check, a board caller sending an unknown focus_type received a 400 instead
// of a 403 -- "may I read this?" answered differently depending on how
// well-formed the request was, and the existence of the parameter disclosed to
// a caller who may not read the resource at all. The two new routes validate
// no parameter today, so nothing there can produce that 400 yet; the ordering
// is held anyway, because the defect arrives with the first validating parse
// somebody adds and not with a decision to allow it.

import type { PilotRole } from './contracts';

/**
 * The eight roles that may read gym-wide coaching content: drills, cues,
 * session scripts and workout templates.
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
