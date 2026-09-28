// Single source of truth for SHADOW route authorization sets.
//
// Before this module these lists were copy-pasted across route files --
// DECISION_LOOP_ROLES existed identically in six files and MANUAL_OVERRIDE_ROLES
// in two. Divergence between copies is invisible in review and is exactly how
// platform_owner ended up locked out of routes it was expected to reach, so the
// lists live here and routes spread them rather than restating them.
//
// A note on the shape of Omega (platform_owner) authority, because it is
// counterintuitive and will otherwise get "corrected" later: Omega is BROADER
// IN BREADTH but STRICTLY NARROWER IN DEPTH than an organization admin. It
// reaches across organizations for operational and aggregate data, and it must
// never reach protected health information or SafeSport content in any
// organization. Adding platform_owner to a role list is therefore never
// automatically right -- see SHADOW_PHI_ROLES below.

import type { PilotRole } from './contracts';

// The seven roles that hold a seat inside a single organization. Note that
// 'admin' is a legacy alias for 'organization_admin' (see roleEquals in
// access.ts); both are listed because rows of each still exist.
export const ORGANIZATION_MEMBER_ROLES: readonly PilotRole[] = [
  'organization_admin',
  'admin',
  'coach',
  'athlete',
  'parent',
  'volunteer',
  'staff',
];

// Read-only, organization-scoped projections and event/telemetry timelines.
// Omega is included: reading operational signal across organizations is the
// core of what the platform owner tier is for, and its absence here is what
// made /admin/shadow return 403 for the platform owner on every request.
export const SHADOW_PROJECTION_READ_ROLES: readonly PilotRole[] = [
  ...ORGANIZATION_MEMBER_ROLES,
  'platform_owner',
];

// Routes that read or write clinical/administrative medical state.
//
// platform_owner is deliberately absent and must stay absent. Medical
// clearance is organization-private health information; the platform owner
// tier has no legitimate need for it and including it would put PHI within
// reach of a single cross-organization account. This is a deliberate depth
// restriction, not an oversight -- shadowRoleSets.test.ts asserts it.
export const SHADOW_PHI_ROLES: readonly PilotRole[] = [
  'coach',
  'organization_admin',
  'admin',
];

// Decision-loop routes: recommendations, decisions, outcomes, near misses.
// Authoring a decision is an in-organization act, so Omega is absent here too.
export const DECISION_LOOP_ROLES: readonly PilotRole[] = [
  'coach',
  'organization_admin',
  'admin',
];

// Roles permitted to force a SHADOW tier / session type rather than accepting
// the classifier's routing decision.
export const MANUAL_OVERRIDE_ROLES: readonly PilotRole[] = [
  'coach',
  'admin',
  'organization_admin',
  'platform_owner',
];

// Who may have a board summary GENERATED for them.
//
// This is deliberately NOT MANUAL_OVERRIDE_ROLES, and the difference is the
// defect this set exists to close. Choosing a session type and being allowed to
// run THIS session type are separate permissions -- the same split
// HEAVY_BAG_UNCAPPED_ROLES already makes in the chat route.
//
// MANUAL_OVERRIDE_ROLES includes coach, so a coach could ask for
// sessionType: 'board_summary' and be honored at the request boundary, and the
// executor then refused them with SHADOW_JOB_SCOPE_FORBIDDEN after the job row
// was already written. The authority check happened one process too late: the
// coach got a queued job that could never run, and the refusal arrived as a
// background failure rather than as an answer.
//
// This list is the executor's existing authority, lifted verbatim so the
// request boundary and the executor cannot drift apart. It is NOT a widening:
// coach was never able to execute one. Coach stays in MANUAL_OVERRIDE_ROLES
// because coach legitimately overrides other session types, Heavy Bag among
// them -- removing it there would take away a permission this change is not
// about.
export const BOARD_SUMMARY_ROLES: readonly PilotRole[] = [
  'organization_admin',
  'admin',
  'platform_owner',
];

// Roles permitted to write into the SHADOW Library: register sources and
// documents, add chunks, and define capability coverage rules.
//
// This deliberately matches requireEvidenceReviewer in shadowLibrary.ts, which
// already gates completeShadowLibraryDocumentIndexing -- the step that
// finalizes these same documents. Curating evidence and approving it are the
// same authority, so the write path must not be broader or narrower than the
// approval path it feeds.
//
// platform_owner is present because organization doctrine is operational
// content, not PHI. That is not a general athlete-data grant: a document
// carrying a subject_id is athlete-scoped, and the documents route runs
// assertActorCanAccessAthlete for those, which refuses platform_owner
// outright. Omega can curate an organization's doctrine; it cannot author
// evidence about a named athlete.
export const SHADOW_LIBRARY_CURATOR_ROLES: readonly PilotRole[] = [
  'organization_admin',
  'admin',
  'platform_owner',
];
