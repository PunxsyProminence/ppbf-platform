# Module 021 — Adaptation Engine

| Field | Value |
|-------|-------|
| Status | **DRAFT** |
| Active | false |
| Promotion required | true |
| Category | Physical Training System (`physicalTrainingSystem`) |
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
| 2026-08-16 | external-research-ingestion | Owner-run external research reconciliation (Round 5, 2026-08-16): boxing-specific literature supports training-load measurement (sRPE/TRIMP in context) but NO boxing-validated Banister impulse-response decay constants were found, and no youth evidence supports fixed tau values. Fitness-fatigue / impulse-response modeling is RESEARCH_FIRST for this module: never hardcode imported tau1/tau2 constants from adult or non-boxing literature. Consistent with issue #345's standing rule that no algorithm constant changes merely because a paper exists. |
