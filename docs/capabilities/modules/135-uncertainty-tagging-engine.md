# Module 135 — Uncertainty Tagging Engine

| Field | Value |
|-------|-------|
| Status | **DONE** (Wave 9 slice promotion) |
| Vertical slice | AttributionCertainty uncertainty tagging on research-pattern occurrences feeding the promotion gate; an app-visible surface is future work |
| Active | false |
| ManualVerification | PENDING_SIGN_OFF |
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
| 2026-08-15 | wave9-reconciliation | Reconciliation audit: PARTIAL coverage — AttributionCertainty = 'stated'/'probable'/'uncertain'; ledger reason code ATTRIBUTION_UNCERTAIN. Missing: A real, tested uncertainty-tagging mechanism exists (AttributionCertainty on research-pattern occurrences feeding a promotion gate), but nothing under. Evidence: apps/web/src/server/pilot/patterns/types.ts; apps/web/src/server/pilot/patterns/evidence.ts. Status stays DRAFT. |
| 2026-08-16 | wave9-reconciliation | Owner decision 2026-08-16: narrow-but-real slices promote per the playbook rule (DONE means slice shipped in code), with the slice line naming exactly what exists. Evidence: apps/web/src/server/pilot/patterns/types.ts; apps/web/src/server/pilot/patterns/evidence.ts. Test: apps/web/src/server/pilot/patterns/promotion.test.ts and evidence.test.ts pin uncertainCount/ATTRIBUTION_UNCER |
| 2026-09-29 | Claude (housekeeping round 3) | ManualVerification row added: PENDING_SIGN_OFF, meaning built, not yet tried by a person (OD-2026-09-29-002, 9a). It moves to SIGNED_OFF only on Jason's word; how to try it is in docs/capabilities/SIGN_OFF_WALKTHROUGH.md. |
