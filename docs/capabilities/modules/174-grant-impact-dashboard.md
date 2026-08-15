# Module 174 — Grant / Impact Dashboard

| Field | Value |
|-------|-------|
| Status | **DRAFT** |
| Active | false |
| Promotion required | true |
| Category | Dashboards / Reporting (`dashboardsReporting`) |
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
| 2026-08-15 | wave9-reconciliation | Reconciliation audit: PARTIAL coverage — admin/grants page: internal grant-obligation ledger (deadlines, funders, status workflow), no athlete/impact d. Missing: A real, tested, role-gated, org-scoped grant-obligation tracker exists, but it is explicitly documented (in-code) as only the internal deadline/delive. Evidence: apps/web/app/admin/grants/page.tsx; apps/web/app/api/pilot/admin/grant-obligations/route.ts. Status stays DRAFT. |
