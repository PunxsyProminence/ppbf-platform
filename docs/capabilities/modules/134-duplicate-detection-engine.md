# Module 134 — Duplicate Detection Engine

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
| 2026-08-15 | wave9-reconciliation | Reconciliation audit: PARTIAL coverage — checkDuplicateGuardians: group-by-email query finding duplicate guardian records across claimed/unclaimed rows. Missing: Real, tested duplicate-detection logic exists but only as a standalone maintenance script (not wired to any API route or UI page), and it is narrowly . Evidence: apps/web/scripts/pilot-check-duplicate-guardians.mjs; apps/web/src/server/pilot/duplicateGuardianCheck.pg.test.ts. Status stays DRAFT. |
