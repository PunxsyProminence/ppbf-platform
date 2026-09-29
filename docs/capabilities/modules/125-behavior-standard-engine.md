# Module 125 — Behavior Standard Engine

| Field | Value |
|-------|-------|
| Status | **DONE** (backend slice shipped 2026-08-16) |
| Vertical slice | `pilot.behavior_standards`: the gym posts its expectations, each mapped onto the EXISTING recognition vocabulary. Meeting one writes an ordinary `pilot.recognitions` row with a typed `standard_id` link (kind supplied by the standard, so it cannot be mislabelled). A conduct CONCERN is not recorded here at all -- it files into the existing safety-escalation ladder as an incident with an acknowledge/resolve lifecycle. Backend + migration; coach UI is follow-up work. |
| Active | false |
| ManualVerification | PENDING_SIGN_OFF |
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
| 2026-08-16 | claude-session | Built to the owner answer "both, with escalation separate". The asymmetry is the design: there is NO per-athlete conduct table, no behavior score, and no discipline note field anywhere -- a concern about a child either matters enough to be handled through the safeguarding queue (where an org admin sees it and it is acknowledged and resolved) or it does not get written down about them. Recognition reuses the platform's existing human vocabulary (helped_someone, showed_up_hard_day, back_after_a_loss, took_the_correction, ...) rather than inventing a parallel taxonomy. A pg test asserts no conduct/discipline table is created. Promoted per playbook rule with ManualVerification PENDING_SIGN_OFF. |
| 2026-09-29 | Claude (housekeeping round 3) | ManualVerification row added: PENDING_SIGN_OFF, meaning built, not yet tried by a person (OD-2026-09-29-002, 9a). It moves to SIGNED_OFF only on Jason's word; how to try it is in docs/capabilities/SIGN_OFF_WALKTHROUGH.md. The 2026-08-16 entry above named PENDING_SIGN_OFF but wrote no row, and no SIGNED_OFF was recorded for this module on 2026-08-28. |
