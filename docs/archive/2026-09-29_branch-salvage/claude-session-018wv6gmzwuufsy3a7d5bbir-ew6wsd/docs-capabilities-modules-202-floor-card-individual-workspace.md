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
staff-facing view. Framed by the owner as a Fortnite-season model: cosmetic
and functional customization accumulates through a season and mostly stays
out of view day-to-day — "look at all the cool stuff I got," a personal
collection to be proud of, not a comparison tool.

Owner's own framing, kept verbatim because it states the boundary precisely:
"let them earn points to customize their own individual Floor space... EACH
USER HAS THEIR OWN FLOOR CARD FOR INDIVIDUAL STUFF WORKOUTS GOALS SOMETHING
THAT IS JUST THEIR SPACE."

## Boundaries

- Does **not** rank users against each other or expose one user's Floor Card
  to another for comparison. Visibility in this phase is scoped to the user
  themselves plus their coach(es) and guardian(s) — nobody else, no
  cross-athlete view. This keeps the build clear of the platform-wide
  no-ranking rule (`achievementPaths.ts`) without needing an exception,
  because the competition/visibility piece that would touch that rule is
  explicitly parked (see Dependencies).
- Does **not** replace or duplicate an existing per-role workspace
  (`AthleteWorkspace`, coach `FloorOperationsDesk`, etc.) — this is additive,
  a personal corner, not a redesign of an existing surface.
- Does **not** unlock customization via a fluctuating points score in this
  phase (superseded decision — see Implementation notes). Unlocks are tied
  to discrete, one-way accomplishments instead: goal completion, attendance
  milestones, measured improvement, hours-trained thresholds, a new skill
  logged, recognition (e.g., 1% Club nomination). An earned unlock is
  permanent; it does not get taken back because activity later dips.
- Scope of "every user" is stated as-is by the owner; the Fortnite/gear
  framing points toward athlete-first, but which other roles (if any) get a
  Floor Card is still open.

## Dependencies

- **Points/ML-weight-based unlocking is explicitly shelved for now**, not
  merely blocked. Owner's own reasoning: point weight should eventually tie
  to how the AI/ML system weighs an athlete, but that weighting is not
  stable yet (see the Bronze/Silver/Gold activity-based rework, same
  conversation, 2026-08-17) and a value that "can go up and down" is a bad
  basis for something a user is meant to feel they earned and keep. Phase 1
  runs on accomplishment events instead, which are already loggable and
  don't depend on the ML weighting settling first. Point-based unlocking may
  return once the ML weighting stabilizes — an explicit future revisit, not
  a rejected idea.
- **Competition/leaderboard visibility — PARKED, future add-on.** Owner:
  "just park the competition as a future add-on." When it returns, per-event
  visibility is participant-dependent and shaped by whatever the specific
  event is, not a fixed cadence. Do not build any cross-user visibility now;
  this is the piece that would need the no-ranking exception decision when
  it's actually picked back up.
- Downstream: none yet.
- Related original-25 capability: _unmapped_.

## Acceptance criteria

Nothing below is built. Listed as the open questions a real spec needs answered, not as scoped work:

- [ ] Data model / tables named (accomplishment ledger, not a points ledger)
- [ ] API surface listed
- [ ] Which roles get a Floor Card (athlete-first per the framing; others TBD)
- [ ] Visual/interaction design — owned by the separate UI/UX session, not this doc
- [ ] Accomplishment-to-unlock mapping (which events unlock what)
- [ ] Roles that may read / write (user, their coach(es), their guardian(s) — confirm this is exhaustive)
- [ ] Safety / refusal cases
- [ ] Audit events
- [ ] UI surface

## Implementation notes

Captured verbatim from conversation, not yet spec'd to buildable detail.
Superseded: the original capture described point-based unlocking; the owner
walked that back in favor of accomplishment-based unlocking once the
ML-weighting dependency became clear (same conversation, 2026-08-17) —
recorded above rather than silently overwritten.

One open design question remains: which roles beyond athlete (if any) get a
Floor Card.

## Audit log

| Date | Actor | Note |
|------|-------|------|
| 2026-08-17 | Claude | Module captured from owner conversation. DRAFT — no build started, blocked on Bronze/Silver/Gold tier redefinition landing first. |
