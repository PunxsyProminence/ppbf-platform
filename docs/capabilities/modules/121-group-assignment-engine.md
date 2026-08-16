# Module 121 — Group Assignment Engine

| Field | Value |
|-------|-------|
| Status | **DONE** (slice shipped 2026-08-16) |
| Vertical slice | Attendance-driven floor groups: a plan belongs to a DAY (not a permanent roster), athletes are placed into groups for that session only, one group per athlete per plan enforced by primary key, placements carry no level/rank and never carry forward. Shares `pilot.floor_plans_daily` / `floor_plan_groups` / `floor_plan_members` with module 123. `/coach/floor-groups`. |
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
| 2026-08-16 | claude-session | Slice shipped: built to the owner answer 2026-08-16 -- the gym splits the room by who actually shows up, so nothing here pre-assigns rosters or persists a grouping beyond the session. A placement is a fact about one day and implies no level or judgment. Promoted per playbook rule with ManualVerification PENDING_SIGN_OFF. |
