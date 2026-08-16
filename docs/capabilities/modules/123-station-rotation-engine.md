# Module 123 — Station Rotation Engine

| Field | Value |
|-------|-------|
| Status | **DONE** (slice shipped 2026-08-16) |
| Vertical slice | Circuit stations on the same daily floor plan as module 121: a group with a station name and rotation order is a circuit stop; a group without one is a small group. Plan-level rotation_minutes (1-120, optional). The UI labels the day from what is actually there rather than assuming a shape. `/coach/floor-groups`. |
| Active | false |
| Promotion required | true |
| Category | Class / Program Management (`classProgramManagement`) |
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
| 2026-08-16 | claude-session | Slice shipped: stations are OPTIONAL by owner answer 2026-08-16 ("some groups work in small groups and we do do circuits") -- neither shape is the default, and a day with no stations reads as a small-group day rather than a broken circuit. Promoted per playbook rule with ManualVerification PENDING_SIGN_OFF. |
