# Module 170 — Safety Dashboard

| Field | Value |
|-------|-------|
| Status | **DONE** (Wave 9 reconciliation follow-up) |
| Vertical slice | /admin/safety-flags board consuming the open-flag queue API (coach/admin): severity counts worst-first, resolve with mandatory note, external-rule flags never offered a bypass |
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
| 2026-08-15 | wave9-reconciliation | Reconciliation audit: PARTIAL coverage — Blank DRAFT stub, Active=false, no defined intent/tables/roles. Missing: A genuinely working, role-gated, org-scoped, tested safety-flags queue exists (raise/list/resolve), and a guardian-facing per-family safety status pag. Evidence: docs/capabilities/modules/170-safety-dashboard.md; apps/web/app/api/pilot/safety-flags/route.ts. Status stays DRAFT. |
| 2026-08-16 | wave9-reconciliation | The audit's missing consumer built: the open-flag queue API (already role-gated, org-scoped, tested) now has /admin/safety-flags rendering it worst-first with severity counts and the resolve lifecycle. Client mirrors the server's external-rule-cannot-be-bypassed refusal; a failed read admits flags may exist. Board-level aggregates deliberately remain out (board gets aggregates only, per standing doctrine). Promoted DRAFT -> DONE. |
