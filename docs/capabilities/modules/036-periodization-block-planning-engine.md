# Module 036 — Periodization / Block Planning Engine

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
| 2026-08-28 | foundation slice | `pilot.athlete_development_blocks` shipped: the coach-authored plan record the engine-unlock proposal found missing. Parent planning object only — no objectives, no comparison surface, no API, no UI. Status stays **DRAFT** and Active stays **false**; a parent table is not a module. See the proposal's "Implementation status" section. |
| 2026-08-28 | objectives slice | `pilot.athlete_development_block_objectives` shipped: the Full Spectrum child rows, nine of ten domains. `nutrition_body_composition` withheld pending an owner decision (proposal Open Question 6). Still no comparison surface, no API, no UI. Status stays **DRAFT**, Active stays **false**. |
| 2026-08-28 | owner decision | Jason: "admit nutrition_body_composition — module 200 is done." Vocabulary is now all ten; the field is registered in `FIELD_TIERS`. `pilot.goals.category` and SHADOW's `weight_cut` refusal are unchanged. Owed: narrow the field to `athlete_record` in the slice that builds the first read surface. Status stays **DRAFT**, Active stays **false**. |
| 2026-08-28 | owner decision | Jason: "Admin and coaches" may author blocks and objectives (proposal Open Question 5). Enforced as `DEVELOPMENT_BLOCK_WRITE_ROLES` in the data layer, shared by both modules; `platform_owner`, `athlete`, `parent` and `volunteer` excluded. Closed a real gap: the shipped floor accepted any active membership. READ access for athlete/guardian remains open. Status stays **DRAFT**, Active stays **false**. |
