# Module 172 — Performance Trend Dashboard

| Field | Value |
|-------|-------|
| Status | **DONE** |
| Status note | Was "DONE (Wave 9 reconciliation)" until 2026-10-16. coach/performance-analytics page reads analytics/performance/route.ts GET (RPE/readiness/training-day rollups, early-vs-late trend) from performanceAnalytics.ts. |
| Code | `apps/web/app/coach/performance-analytics/page.tsx`, `apps/web/app/api/pilot/analytics/performance/route.ts`, `apps/web/src/server/pilot/performanceAnalytics.ts` |
| Tests | `apps/web/app/coach/performance-analytics/page.test.tsx`, `apps/web/app/api/pilot/analytics/performance/route.test.ts`, `apps/web/src/server/pilot/performanceAnalytics.test.ts` |
| Vertical slice | coach performance-analytics page: RPE/readiness/training-day rollups with early-vs-late trend direction per athlete |
| Active | false |
| ManualVerification | PENDING_SIGN_OFF |
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
| 2026-08-15 | wave9-reconciliation | Reconciliation audit: DoD verified in code (route+role gate+org isolation+test). Evidence: apps/web/app/coach/performance-analytics/page.tsx; apps/web/app/api/pilot/analytics/performance/route.ts; apps/web/src/server/pilot/performanceAnalytics.ts. Test: apps/web/app/api/pilot/analytics/performance/route.test.ts covers the endpoint's role gate and scoping |
| 2026-09-29 | Claude (housekeeping round 3) | ManualVerification row added: PENDING_SIGN_OFF, meaning built, not yet tried by a person (OD-2026-09-29-002, 9a). It moves to SIGNED_OFF only on Jason's word; how to try it is in docs/capabilities/SIGN_OFF_WALKTHROUGH.md. |
| 2026-10-16 | Claude (lane L32) | Status set to **DONE** under the 2026-10-16 status vocabulary (DONE / MAPPED / CLAIMED-NO-CODE / DRAFT; Overwatch GO). Was "DONE (Wave 9 reconciliation)". Code and Tests rows added; the capability status check in CI reads them. ManualVerification unchanged. |
