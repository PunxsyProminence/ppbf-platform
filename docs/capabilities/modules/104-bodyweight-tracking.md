# Module 104 — Bodyweight Tracking

| Field | Value |
|-------|-------|
| Status | **DONE** (Wave 9 slice promotion) |
| Vertical slice | sparring-form body-weight intake -> tested MVP-12 7-day weight-change calculation, org/role-scoped; trend UI is future work |
| Active | false |
| Promotion required | true |
| Category | Body Composition (`bodyComposition`) |
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
| 2026-08-15 | wave9-reconciliation | Reconciliation audit: PARTIAL coverage — sparring form optional body-weight field -> generic formula-observations intake -> MVP-12 7-day weight-change . Missing: A real intake path (sparring form), storage, org-scoped/role-gated API, and a tested 7-day weight-change calculation all exist and are exercised by te. Evidence: apps/web/app/athlete/dashboard/sparring/page.tsx; apps/web/app/api/pilot/shadow/formulas/observations/route.ts. Status stays DRAFT. |
| 2026-08-16 | wave9-reconciliation | Owner decision 2026-08-16: narrow-but-real slices promote per the playbook rule (DONE means slice shipped in code), with the slice line naming exactly what exists. Evidence: apps/web/app/athlete/dashboard/sparring/page.tsx; apps/web/app/api/pilot/shadow/formulas/observations/route.ts. Test: apps/web/src/server/pilot/formulas/mvpFormulaEngine.test.ts (MVP-12 test, line ~406) pins the 7-day weight-cha |
