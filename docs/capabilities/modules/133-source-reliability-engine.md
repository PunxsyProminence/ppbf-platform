# Module 133 — Source Reliability Engine

| Field | Value |
|-------|-------|
| Status | **DRAFT** |
| Active | false |
| Promotion required | true |
| Category | Data Quality / Trust (`dataQualityTrust`) |
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
| 2026-08-15 | wave9-reconciliation | Reconciliation audit: PARTIAL coverage — PATCH/POST sets authority_tier (1-5) on shadow_library_sources, requireRole(SHADOW_LIBRARY_CURATOR_ROLES), uni. Missing: A genuine source-reliability classification (authority_tier) exists with a curator-role-gated write API, org isolation, and tests, but it is scoped en. Evidence: apps/web/app/api/pilot/shadow/library/sources/route.ts; apps/web/src/server/pilot/shadowEvidenceTier.ts. Status stays DRAFT. |
