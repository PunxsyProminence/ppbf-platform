# Module 114 — Coach Cue Library

| Field | Value |
|-------|-------|
| Status | **DRAFT** |
| Active | false |
| Promotion required | true |
| Category | Coach System (`coachSystem`) |
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
| 2026-08-15 | wave9-reconciliation | Reconciliation audit: PARTIAL coverage — drill cues stored/read as part of the drill library (pilot.drill_cues), no standalone cue-library UI. Missing: no dedicated cue-library browsing/search surface independent of individual drill records. Evidence: infra/azure/pilot_slice_postgres_drill_library_v3_migration.sql; apps/web/src/server/pilot/drillLibraryV3.ts. Status stays DRAFT. |
