# Module 143 — Source-Control Dashboard

| Field | Value |
|-------|-------|
| Status | **DRAFT** |
| Active | false |
| Promotion required | true |
| Category | Governance / Admin / Nonprofit (`governanceAdminNonprofit`) |
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
| 2026-08-15 | wave9-reconciliation | Reconciliation audit: PARTIAL coverage — The page literally named for this module is explicitly self-labeled 'PLANNED / FRONT-END PLACEHOLDER / NOT YET. Missing: The /source-control (and /publication-workflow) pages are not wired to any backend, org-scoped or otherwise; they render hardcoded sample arrays and e. Evidence: apps/web/app/source-control/page.tsx; apps/web/app/source-control/publication-workflow/page.tsx. Status stays DRAFT. |
