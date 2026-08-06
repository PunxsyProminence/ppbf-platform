# T-002 — Covering coach cannot access an athlete they don't own

> Status: READY
> Lane: A (git-capable AI) or B (chat-only AI) — either
> Priority: P1 pilot-blocking

<!-- Everything below this line is the prompt. Paste the whole file into the
     builder AI. It must be able to succeed with no other context. -->

## Context you need

You are building one feature for the PPBF platform: a Next.js 16 (App
Router) + PostgreSQL app for a nonprofit youth boxing gym, deployed on Azure
Container Apps. TypeScript strict, tests in Jest (`*.test.ts(x)` colocated),
server logic under `apps/web/src/server/pilot/`.

Non-negotiable conventions:

- Every read/write of organization-owned data is scoped by
  `organization_id` in the SQL itself.
- Auth: role checks from `apps/web/src/server/pilot/auth.ts` at the top of every
  route handler.
- Full rules: `docs/AI_CONTRIBUTOR_GUARDRAILS.md` in the repo. Read it.

## Verified problem

`apps/web/src/server/pilot/access.ts:34-42` (`assertCoachAssignedToAthlete`)
does an exact-match query: `athlete_id = $1 and coach_id = $2 and
organization_id = $3`. There is no concept of a substitute/covering coach
anywhere in this file or its callers (`assertActorCanAccessAthlete`,
line 71). A coach who is not the athlete's `coach_id` of record gets
`Forbidden: coach not assigned to athlete` on every athlete-scoped route,
full stop — including a coach covering a session for the regular coach who
is out sick.

I verified this by reading the function directly; it is not a claim from an
audit doc, it is what the code does today.

## Goal

A coach who has been granted temporary coverage of an athlete can access
that athlete's routes (whatever `assertActorCanAccessAthlete` currently
gates) without becoming the athlete's permanent `coach_id`.

## Decision you must make and state explicitly in your PR

There are at least two reasonable designs:

1. A `pilot.coach_coverage` table: `(organization_id, athlete_id,
   covering_coach_id, granted_by, starts_at, expires_at)`. Coverage is
   time-bounded and someone with authority grants it (organization_admin,
   or the athlete's regular coach).
2. A coverage flag on the organization membership scoped to a whole roster
   rather than per-athlete (a coach substituting for another coach's entire
   group for the day).

Pick one, state why, and say what you rejected. Do not invent a third
scheme without justifying it against these two.

## In scope

- The schema change (additive migration under `infra/azure/`, a
  `pilot:apply-*` runner script, matching entry in
  `apps/web/package.json`) for whichever design you pick.
- Extending `assertCoachAssignedToAthlete` (or adding a sibling function
  called from the same place) to also permit an active, non-expired
  coverage grant.
- A minimal way to grant coverage — this can be an admin-only API route
  with no UI if a full UI is out of scope for the ticket size; say so if
  you cut it there.
- Tests: a coach WITHOUT coverage still gets `Forbidden` (do not weaken the
  existing case — guardrails §4, "never weaken, only extend"); a coach WITH
  active coverage succeeds; a coach with EXPIRED coverage gets `Forbidden`.

## Out of scope

- Do not touch `assertAthleteBelongsToOrganization`,
  `isOrganizationAdminRole` checks, or the board/platform_owner branches in
  `assertActorCanAccessAthlete`.
- Do not build a general permissions/roles system. This is one narrow gap.
- Do not remove or loosen the exact-match check for the primary coach —
  extend it, don't replace it.

## Files allowed

- `infra/azure/*coach_coverage*` (new migration)
- `apps/web/scripts/pilot-apply-*coach-coverage*` (new runner)
- `apps/web/package.json` (one new `pilot:apply-*` script entry only)
- `apps/web/src/server/pilot/access.ts`
- `apps/web/src/server/pilot/access.test.ts`
- One new API route under `apps/web/app/api/pilot/admin/` if you build a
  grant endpoint, plus its test

## Acceptance criteria

- `npm test -- --runTestsByPath apps/web/src/server/pilot/access.test.ts`
  passes, including the three new cases above.
- `access.test.ts:90`'s existing "Forbidden for non-assigned athlete" case
  still passes unmodified in its assertion (you may add setup, not weaken
  the assertion).
- If you add the migration: state in your PR that it was NOT applied to
  any database (migrations are gatekeeper/operator-only, guardrails §7) —
  only that it is syntactically ready for `apply-migrations`.

## Delivery

Lane A: branch `ticket/T-002-covering-coach-access` off current
`origin/main`, run `npm ci && npm run typecheck && npm run lint && npm test`,
push ONCE, open a draft PR with the repo's PR template, fill Evidence with
real command output. You cannot push to a branch twice — revisions are a
new `-v2` branch and PR.

Lane B: output every file COMPLETE (no elisions), each preceded by its full
repo path, plus a MANIFEST.md: ticket id, file list (new vs replaces), what
was not done, assumptions made. The human will place your output in
`intake/drops/T-002/`.
