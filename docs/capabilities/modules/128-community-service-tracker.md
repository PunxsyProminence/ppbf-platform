# Module 128 — Community Service Tracker

| Field | Value |
|-------|-------|
| Status | **DONE** (slice shipped 2026-08-16) |
| Vertical slice | Read-only tracker over the `community_service` rows already in `pilot.activity_log` (a verifier-required domain): per-person totals with verified and unverified minutes kept structurally separate, entries listed with their own verification state, hours floored. `/admin/community-service` + read route. No new table and no new write path -- recording stays on the activity log. Future work: exportable verified statements once a disclosure policy exists. |
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
| 2026-08-16 | claude-session | Slice shipped: verified and unverified service minutes are never merged into one figure (an external reader -- school, court, scholarship -- needs the verified number alone), there is deliberately no combined total field, and displayed hours floor rather than round up. Promoted per playbook rule with ManualVerification PENDING_SIGN_OFF. |
| 2026-09-29 | Claude (housekeeping round 3) | ManualVerification row added: PENDING_SIGN_OFF, meaning built, not yet tried by a person (OD-2026-09-29-002, 9a). It moves to SIGNED_OFF only on Jason's word; how to try it is in docs/capabilities/SIGN_OFF_WALKTHROUGH.md. The 2026-08-16 entry above named PENDING_SIGN_OFF but wrote no row, and no SIGNED_OFF was recorded for this module on 2026-08-28. |
