# Module 001 — Athlete Profile System

| Field | Value |
|-------|-------|
| Status | **DONE** (Wave 9 reconciliation) |
| Vertical slice | athlete Passbook read model (identity, attendance, sessions, readiness, goals, observations, progression gaps) plus coach open-gap queue |
| Active | false |
| ManualVerification | PENDING_SIGN_OFF |
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
the parent experience stays on the ParentDigest disclosure model
(`apps/web/components/ParentDigest.tsx`), which withholds the session log.
`GET /api/pilot/passbook` names `parent` in its role allowlist, so the API had
to be reconciled with that model before this module can be declared promoted.
Do not build a parent Passbook surface, and do not widen parent access,
without a new owner decision.

**Reconciled 2026-09-30 (OD-2026-09-30-004 d3, owner chose A: narrow).** A
linked guardian calling `GET /api/pilot/passbook` now receives only
`{ athlete: { athlete_id, full_name }, completed_sessions }`, built by
`getGuardianPassbook` in `apps/web/src/server/pilot/passbook.ts`. No dated
session, attendance, readiness, observation, goal or gap row is read for a
guardian, and the count is `countCompletedSessions`, the same number
ParentDigest shows. Athlete, coach and admin readers still receive the full
book from `getAthletePassbook`, unchanged. Pinned by
`apps/web/app/api/pilot/passbook/route.test.ts` and
`apps/web/src/server/pilot/passbook.test.ts`. `GET /api/pilot/passbook` still
has no page; `/coach/passbook-gaps` reads only `/api/pilot/passbook/gaps`,
which refuses parents.

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | scaffold-script | Stub created from PPBF_CAPABILITIES.json |
| 2026-08-04 | Codex | Added issue #156 Passbook read-model and API-only slice; governance remains inactive. |
| 2026-08-15 | wave9-reconciliation | Reconciliation audit: DoD verified in code (route+role gate+org isolation+test). Evidence: apps/web/src/server/pilot/passbook.ts; apps/web/app/api/pilot/passbook/route.ts; apps/web/app/api/pilot/passbook/gaps/route.ts. Test: apps/web/app/api/pilot/passbook/route.test.ts pins 403 for board and unlinked parent, and 200 with observations+gaps for |
| 2026-09-29 | Claude (housekeeping round 3) | ManualVerification row added: PENDING_SIGN_OFF, meaning built, not yet tried by a person (OD-2026-09-29-002, 9a). It moves to SIGNED_OFF only on Jason's word; how to try it is in docs/capabilities/SIGN_OFF_WALKTHROUGH.md. |
