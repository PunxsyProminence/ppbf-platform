# Module 123 — Station Rotation Engine

| Field | Value |
|-------|-------|
| Status | **DONE** |
| Status note | Was "DONE (slice shipped 2026-08-16)" until 2026-10-16. floor-groups/route.ts validates rotation_minutes (1-120), station_name, rotation_order; floorGroups.ts isCircuit labels the day; same code as module 121. |
| Code | `apps/web/app/api/pilot/coach/floor-groups/route.ts`, `apps/web/app/coach/floor-groups/page.tsx`, `apps/web/src/server/pilot/floorGroups.ts` |
| Tests | `apps/web/app/api/pilot/coach/floor-groups/route.test.ts`, `apps/web/app/coach/floor-groups/page.test.tsx`, `apps/web/src/server/pilot/floorGroups.pg.test.ts` |
| Vertical slice | Circuit stations on the same daily floor plan as module 121: a group with a station name and rotation order is a circuit stop; a group without one is a small group. Plan-level rotation_minutes (1-120, optional). The UI labels the day from what is actually there rather than assuming a shape. `/coach/floor-groups`. |
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
| 2026-08-16 | claude-session | Slice shipped: stations are OPTIONAL by owner answer 2026-08-16 ("some groups work in small groups and we do do circuits") -- neither shape is the default, and a day with no stations reads as a small-group day rather than a broken circuit. Promoted per playbook rule with ManualVerification PENDING_SIGN_OFF. |
| 2026-09-29 | Claude (housekeeping round 3) | ManualVerification row added: PENDING_SIGN_OFF, meaning built, not yet tried by a person (OD-2026-09-29-002, 9a). It moves to SIGNED_OFF only on Jason's word; how to try it is in docs/capabilities/SIGN_OFF_WALKTHROUGH.md. The 2026-08-16 entry above named PENDING_SIGN_OFF but wrote no row, and no SIGNED_OFF was recorded for this module on 2026-08-28. |
| 2026-10-16 | Claude (lane L32) | Status set to **DONE** under the 2026-10-16 status vocabulary (DONE / MAPPED / CLAIMED-NO-CODE / DRAFT; Overwatch GO). Was "DONE (slice shipped 2026-08-16)". Code and Tests rows added; the capability status check in CI reads them. ManualVerification unchanged. |
