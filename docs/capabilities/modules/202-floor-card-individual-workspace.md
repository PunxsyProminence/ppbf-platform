# Module 202 — Floor Card / Individual Workspace

| Field | Value |
|-------|-------|
| Status | **DRAFT** (captured, not built) |
| Active | false |
| Promotion required | true |
| Category | Core Athlete System (`coreAthleteSystem`) — closest existing fit; this capability sits outside the original 200-module scaffold and may warrant its own category on review |
| Source | Owner request, captured in conversation 2026-08-17 |
| Parent original-25 | _unmapped_ — post-200 addition, not scaffold-derived |

## Intent

Every user gets their own Floor Card: a personal, individually-owned space for
their own stuff — workouts, goals, whatever is just theirs, not a shared or
staff-facing view. Customization is earned through points tied to the
activity-based Bronze/Silver/Gold system (itself being redefined in the same
conversation this module was captured in — see Dependencies).

Owner's own framing, kept verbatim because it states the boundary precisely:
"let them earn points to customize their own individual Floor space... EACH
USER HAS THEIR OWN FLOOR CARD FOR INDIVIDUAL STUFF WORKOUTS GOALS SOMETHING
THAT IS JUST THEIR SPACE."

## Boundaries

- Does **not** rank users against each other or expose one user's Floor Card
  to another for comparison. This is the same platform-wide rule
  `achievementPaths.ts` already enforces elsewhere (no leaderboard, no
  per-person ranking surface) and it applies here by the same logic, not a
  new invention.
- Does **not** replace or duplicate an existing per-role workspace
  (`AthleteWorkspace`, coach `FloorOperationsDesk`, etc.) — this is additive,
  a personal corner, not a redesign of an existing surface.
- Does **not** invent a points economy independent of the tier system. Point
  accrual should be the same mechanism that drives Bronze/Silver/Gold, not a
  second parallel currency.
- Scope of "every user" is stated as-is by the owner and not narrowed here to
  athlete-only; which roles actually get a Floor Card is an open question
  (see Implementation notes) rather than a decision made in this capture.

## Dependencies

- **Upstream, blocking:** the Bronze/Silver/Gold tier logic must first be
  rebuilt as activity-based and decaying (owner decision, same conversation,
  2026-08-17 — supersedes the shipped `advanceTier`'s lifetime-count-only,
  never-decreasing logic in `SHADOW_ML_ARCHITECTURE_SPEC.md` §2.3). Floor Card
  customization spends points from that system; building the card before the
  points system is redefined would earn against numbers that are about to
  change shape.
- Downstream: none yet.
- Related original-25 capability: _unmapped_.

## Acceptance criteria

Nothing below is built. Listed as the open questions a real spec needs answered, not as scoped work:

- [ ] Data model / tables named
- [ ] API surface listed
- [ ] Which roles get a Floor Card (all roles as stated, or athlete-first?)
- [ ] What "customize" actually means (layout? content modules shown? cosmetic only?)
- [ ] Point-spend mechanism, tied to the redefined tier system above
- [ ] Roles that may read / write
- [ ] Safety / refusal cases
- [ ] Audit events
- [ ] UI surface

## Implementation notes

Captured verbatim from conversation, not yet spec'd to buildable detail. Two
open design questions worth owner attention before this becomes a NOW item:

1. Whether "each user" genuinely means every role (coach, parent, board,
   staff) or whether the workouts/goals framing implies athlete-first, with
   other roles following later.
2. What "customize" spans — cosmetic personalization only, or which content
   the card surfaces — since the boundary against becoming a ranking/compare
   surface depends on knowing what's actually on it.

## Audit log

| Date | Actor | Note |
|------|-------|------|
| 2026-08-17 | Claude | Module captured from owner conversation. DRAFT — no build started, blocked on Bronze/Silver/Gold tier redefinition landing first. |
