# Module 111 — Coach Intelligence Engine

| Field | Value |
|-------|-------|
| Status | **DONE** (Wave 9 reconciliation follow-up) |
| Vertical slice | The Morning Read (/coach/intelligence): five deterministic threshold reads of a coach's own athletes (stalled gaps 14d, 3+ RED days/7, attendance half-drop, unreviewed sessions 7d, holds expiring 14d). No ML, no scores, nothing athlete-visible, nothing automatic. |
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
| 2026-08-15 | wave9-reconciliation | Reconciliation audit: PARTIAL coverage — coach-role SHADOW chat adapter (AI Q&A for coaches), no bespoke intelligence/recommendation engine. Missing: no dedicated coach-intelligence data model/decision engine distinct from generic SHADOW chat. Evidence: apps/web/app/api/pilot/coach/chat/route.ts; apps/web/app/api/pilot/coach/chat/route.test.ts. Status stays DRAFT. |
| 2026-08-16 | wave9-reconciliation | Built to the owner-approved v1 definition (2026-08-16, all five items approved). Deterministic only; thresholds are named constants pinned by tests, with the attendance rule IMPORTING the gap-suggestion constants so the two can never drift. Coach reads own roster / admin reads org, same derivation as performance analytics. Clearance-expiry half of item 5 ships as holds-expiring only -- the clearance register has no expiry field to read. Promoted DRAFT -> DONE. |
