# Module 170 — Safety Dashboard

| Field | Value |
|-------|-------|
| Status | **DONE** |
| Status note | Was "DONE (Wave 9 reconciliation follow-up)" until 2026-10-16. admin/safety-flags/page.tsx (header names module 170) consumes safety-flags/route.ts GET open queue and PATCH resolve with mandatory note. |
| Code | `apps/web/app/admin/safety-flags/page.tsx`, `apps/web/app/api/pilot/safety-flags/route.ts`, `apps/web/src/server/pilot/safetyFlags.ts` |
| Tests | `apps/web/app/admin/safety-flags/page.test.tsx`, `apps/web/app/api/pilot/safety-flags/route.test.ts`, `apps/web/src/server/pilot/safetyFlags.pg.test.ts` |
| Vertical slice | /admin/safety-flags board consuming the open-flag queue API (coach/admin): severity counts worst-first, resolve with mandatory note, external-rule flags never offered a bypass |
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
| 2026-08-15 | wave9-reconciliation | Reconciliation audit: PARTIAL coverage — Blank DRAFT stub, Active=false, no defined intent/tables/roles. Missing: A genuinely working, role-gated, org-scoped, tested safety-flags queue exists (raise/list/resolve), and a guardian-facing per-family safety status pag. Evidence: docs/capabilities/modules/170-safety-dashboard.md; apps/web/app/api/pilot/safety-flags/route.ts. Status stays DRAFT. |
| 2026-08-16 | wave9-reconciliation | The audit's missing consumer built: the open-flag queue API (already role-gated, org-scoped, tested) now has /admin/safety-flags rendering it worst-first with severity counts and the resolve lifecycle. Client mirrors the server's external-rule-cannot-be-bypassed refusal; a failed read admits flags may exist. Board-level aggregates deliberately remain out (board gets aggregates only, per standing doctrine). Promoted DRAFT -> DONE. |
| 2026-09-29 | Claude (housekeeping round 3) | ManualVerification row added: PENDING_SIGN_OFF, meaning built, not yet tried by a person (OD-2026-09-29-002, 9a). It moves to SIGNED_OFF only on Jason's word; how to try it is in docs/capabilities/SIGN_OFF_WALKTHROUGH.md. |
| 2026-10-16 | Claude (lane L32) | Status set to **DONE** under the 2026-10-16 status vocabulary (DONE / MAPPED / CLAIMED-NO-CODE / DRAFT; Overwatch GO). Was "DONE (Wave 9 reconciliation follow-up)". Code and Tests rows added; the capability status check in CI reads them. ManualVerification unchanged. |
