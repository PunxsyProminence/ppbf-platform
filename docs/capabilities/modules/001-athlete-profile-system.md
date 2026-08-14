# Module 001 — Athlete Profile System

| Field | Value |
|-------|-------|
| Status | **DRAFT** |
| Active | false |
| Promotion required | true |
| Category | Core Athlete System (`coreAthleteSystem`) |
| Source | `2.0.0-draft-merged` |
| Parent original-25 | _unmapped_ |

## Intent
Own the organization-scoped read model for one athlete's existing record. The
Passbook slice assembles identity, attendance, sessions, readiness, goals,
corner relationships and coach observations, plus progression gaps, without
creating a second source of truth. It must never infer clinical facts, invent
status values, or expose an individual athlete to board, public, platform-owner,
unassigned-coach, or unlinked-guardian audiences.

## Boundaries
- Does **not** auto-approve progression, medical, or board decisions.
- Does **not** expose athlete-level data to board / public aggregates without suppression rules.
- Does **not** invent metrics that are not stored by the platform.

## Dependencies
- Upstream: `pilot.athletes`, `pilot.attendance`, `pilot.sessions`,
  `pilot.readiness`, `pilot.goals`, `pilot.guardian_links`, `pilot.parents`,
  `pilot.coach_observations`, `pilot.progression_gaps`; existing session and
  athlete-access helpers.
- Downstream: athlete/guardian Passbook surfaces and the coach progression-gap
  queue.
- Related original-25 capability: Athlete profile / roster.

## Acceptance criteria
- [x] Data model / tables named
- [x] API surface listed: `GET /api/pilot/passbook?athlete_id=...` and
  `GET /api/pilot/passbook/gaps`
- [x] Roles named: organization admin, assigned coach, self athlete, and linked
  parent may read one book; organization admin and assigned coach may read the
  open-gap queue; this slice has no write path.
- [x] Safety / refusal cases: authentication and first-PIN gate inherited from
  `requirePrincipal`; individual access inherited from
  `assertActorCanAccessAthlete`; board, public and platform owner receive no
  individual data; every SQL read is organization-scoped.
- [x] Audit events: none. This is a read-only slice and creates no state change
  to audit.
- [x] API-only. Visual surfaces remain separately owned.

## Implementation notes
Passbook v1 read paths are implemented in `apps/web/src/server/pilot/passbook.ts`.
Attendance values are normalized only when they match the canonical
`PRESENT`/`LATE`/`ABSENT` stamp vocabulary; unsupported stored values remain
visible as schema drift and receive no invented stamp. `gym_status` remains the
separate roster-membership vocabulary `active`/`training`/`inactive`.

Governance remains inactive pending promotion review. The tracker CSV was not
updated in this slice because open PR #191 owns that file; it must be sequenced
after that PR.

## Promotion blocker — parent disclosure reconciliation (owner decision, 2026-08-14)

The owner has ruled that no parent-facing Passbook UI ships in this pilot and
the parent experience stays on the ParentDigest disclosure model. That leaves
a standing contradiction to resolve before this module can be declared
promoted: `GET /api/pilot/passbook` names `parent` in its role allowlist and
hands a linked guardian the athlete's full session log and coach
observations, while `ParentDigest` (`apps/web/components/ParentDigest.tsx`)
documents the session log as deliberately withheld from the parent surface.
The API is currently consumed by no page, so nothing discloses today — but
promotion review must either narrow the API's parent access to match
ParentDigest, or explicitly widen the ParentDigest disclosure decision. Do
not build a parent Passbook surface, and do not widen parent access, until
that reconciliation is decided.

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | scaffold-script | Stub created from PPBF_CAPABILITIES.json |
| 2026-08-04 | Codex | Added issue #156 Passbook read-model and API-only slice; governance remains inactive. |
