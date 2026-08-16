# Module 169 — Readiness Dashboard

| Field | Value |
|-------|-------|
| Status | **DONE** (Wave 9 reconciliation follow-up) |
| Vertical slice | per-athlete readiness feed (latest fresh check-in only, 24h window) via GET /api/pilot/coach/readiness-board coloring the CoachWorkspace roster dots and Readiness Alerts tile; unknown stays unknown |
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
| 2026-08-15 | wave9-reconciliation | Reconciliation audit: PARTIAL coverage — Blank DRAFT stub, Active=false, no defined intent/tables/roles. Missing: A tested readiness-score formula exists and UI scaffolding to display it exists, but they are not wired together: no API route persists or serves per-. Evidence: docs/capabilities/modules/169-readiness-dashboard.md; apps/web/src/server/pilot/readinessMath.ts. Status stays DRAFT. |
| 2026-08-15 | wave9-reconciliation | The audit's missing wiring built: readinessBoard.ts (fresh-only, bands GREEN>=7 / YELLOW>=4 / RED below, athletes without a fresh reading OMITTED), coach/admin-gated route on the analytics roster derivation, CoachWorkspace merge with UNKNOWN preserved on absence or feed failure. Tests pin bands, freshness SQL, role refusals, and the no-signal/never-zero-flags tile states. Promoted DRAFT -> DONE. |
