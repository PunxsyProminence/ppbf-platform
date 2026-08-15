# Module 095 — Home Barrier Reporting System

| Field | Value |
|-------|-------|
| Status | **DONE** (Wave 9 reconciliation) |
| Vertical slice | parent files home-barrier report -> coach barrier inbox, org+per-athlete scoped, fail-closed on access errors |
| Active | false |
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
| 2026-08-15 | wave9-reconciliation | Reconciliation audit: DoD verified in code (route+role gate+org isolation+test). Evidence: apps/web/app/api/pilot/parent/barrier-report/route.ts; apps/web/app/api/pilot/coach/barrier-reports/route.ts; apps/web/src/server/pilot/intake.ts. Test: apps/web/app/api/pilot/parent/barrier-report/route.test.ts and apps/web/app/api/pilot/coach/barrier-reports/route.test.t |
