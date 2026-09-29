# Module 095 — Home Barrier Reporting System

| Field | Value |
|-------|-------|
| Status | **DONE** (Wave 9 reconciliation) |
| Vertical slice | parent files home-barrier report -> coach barrier inbox, org+per-athlete scoped, fail-closed on access errors |
| Active | false |
| ManualVerification | PENDING_SIGN_OFF |
| Promotion required | true |
| Category | At-Home / Parent / Guardian (`atHomeParentGuardian`) |
| Source | `2.0.0-draft-merged` |
| Parent original-25 | _unmapped_ |

## Intent
_One paragraph: what this module owns and what it must never do._

## Boundaries
- Does **not** auto-approve progression, medical, or board decisions.
- Does **not** expose athlete-level data to board / public aggregates without suppression rules.
- Does **not** invent metrics that are not stored by the platform.

## Dependencies
- Upstream: 
- Downstream: 
- Related original-25 capability: 

## Acceptance criteria
- [ ] Data model / tables named
- [ ] API surface listed (or explicitly none)
- [ ] Roles that may read / write
- [ ] Safety / refusal cases
- [ ] Audit events
- [ ] UI surface or "API-only"

## Implementation notes
_Scaffold only. Do not mark active until promotion review._

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | scaffold-script | Stub created from PPBF_CAPABILITIES.json |
| 2026-08-15 | wave9-reconciliation | Reconciliation audit: DoD verified in code (route+role gate+org isolation+test). Evidence: apps/web/app/api/pilot/parent/barrier-report/route.ts; apps/web/app/api/pilot/coach/barrier-reports/route.ts; apps/web/src/server/pilot/intake.ts. Test: apps/web/app/api/pilot/parent/barrier-report/route.test.ts and apps/web/app/api/pilot/coach/barrier-reports/route.test.ts [the rest of this cell was cut off; rewritten 2026-09-28 by Claude from the test files, stating only what they assert:]. The parent test asserts a parent files a home barrier report for their own child; `transportation` is stored as `transportation_barrier`; a missing description, a missing athleteId, an invalid barrier type or malformed JSON is a 400; a child outside the guardian's access is refused (403) before writing; and every other role (coach, admins, athlete, board, platform_owner, volunteer, staff) is refused. The coach test asserts a coach gets reports only for athletes they are authorized for, with no sign that others exist; an access-check error fails the read (500) rather than shortening the list; a capped list says it is truncated; a malformed limit is refused before reading, and the limit is capped at 50; and athlete, parent, board, volunteer, staff and platform_owner are refused (403). |
| 2026-09-29 | Claude (housekeeping round 3) | ManualVerification row added: PENDING_SIGN_OFF, meaning built, not yet tried by a person (OD-2026-09-29-002, 9a). It moves to SIGNED_OFF only on Jason's word; how to try it is in docs/capabilities/SIGN_OFF_WALKTHROUGH.md. |
