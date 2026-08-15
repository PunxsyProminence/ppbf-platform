# Module 116 — Coach Compliance / Integrity Engine

| Field | Value |
|-------|-------|
| Status | **DONE** (Wave 9 reconciliation) |
| Vertical slice | compliance rule/violation tracking with severity, escalation ladder, coach/admin role gates, org- and athlete-scoped access |
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
| 2026-08-15 | wave9-reconciliation | Reconciliation audit: DoD verified in code (route+role gate+org isolation+test). Evidence: apps/web/src/server/pilot/compliance.ts; apps/web/app/api/pilot/compliance/violations/route.ts; apps/web/app/api/pilot/compliance/violations/route.test.ts. Test: apps/web/app/api/pilot/compliance/violations/route.test.ts: '403 for a role that cannot view violations', '403 when coac |
