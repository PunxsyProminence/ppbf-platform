# Module 171 — Progression Dashboard

| Field | Value |
|-------|-------|
| Status | **DONE** (Wave 9 reconciliation) |
| Vertical slice | coach progression-intelligence page: deterministic gap suggestions + confirmed gaps + assignment completion, coach/admin only |
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
| 2026-08-15 | wave9-reconciliation | Reconciliation audit: DoD verified in code (route+role gate+org isolation+test). Evidence: apps/web/app/coach/progression-intelligence/page.tsx; apps/web/app/api/pilot/progression/suggestions/route.ts; apps/web/src/server/pilot/progressionSuggestions.ts. Test: apps/web/src/server/pilot/progressionSuggestions.test.ts pins suggestion rule thresholds; [the rest of this cell was cut off; rewritten 2026-09-28 by Claude from the test files, stating only what they assert:] that file asserts when each of the five rules (readiness falling, training days dropping, assignments stalled, transfer check failed, competition loss unresolved) fires and when it stays silent (below threshold, too little data, no habit to lose); that an open gap of the matching type suppresses the readiness, stalled-assignment, transfer and competition-loss suggestions; and that quiet data produces none. `apps/web/app/api/pilot/progression/suggestions/route.test.ts` asserts athlete, parent, board and volunteer are refused; a coach is scoped to their own athletes, and an athlete outside that set never reaches the suggester or the response; an organization admin reads the whole roster. |
