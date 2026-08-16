# Module 129 — Program Phase Engine

| Field | Value |
|-------|-------|
| Status | **DONE** (slice shipped 2026-08-16) |
| Vertical slice | `pilot.program_phases`: human-declared blocks per program (name, focus, start, optional end) with ONE OPEN PHASE per program enforced by partial unique index; starting a new phase closes the previous the day before, keeping history intact. Staff read, admin declares; audited. `/admin/program-phases`. Phases carry no athlete ids and change nothing about any athlete. Future work: surfacing the active phase as context on session and planning surfaces. |
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
| 2026-08-16 | claude-session | Slice shipped: a phase is a STATED intent, never computed or recommended -- nothing here infers a block from data or applies one to an athlete. One open phase per program is a database fact; closed phases keep their dates so past sessions retain the context they actually happened in; a new phase cannot begin before the phase it replaces. Promoted per playbook rule with ManualVerification PENDING_SIGN_OFF. |
