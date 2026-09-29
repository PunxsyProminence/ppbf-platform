# Module 042 — Round Performance Engine

| Field | Value |
|-------|-------|
| Status | **DONE** (Wave 9 slice promotion) |
| Vertical slice | tested work-rate-consistency and round-to-round-change formulas behind the role/org-gated formula API; display UI is future work |
| Active | false |
| ManualVerification | PENDING_SIGN_OFF |
| Promotion required | true |
| Category | Combat / Boxing System (`combatBoxingSystem`) |
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
| 2026-08-15 | wave9-reconciliation | Reconciliation audit: PARTIAL coverage — tested work-rate-consistency and round-to-round-change formula backend, reachable via role/org-gated API, no d. Missing: Round output consistency and round-to-round change are real, tested formulas served through the same role/org-gated API as the punch formulas, but as . Evidence: apps/web/src/server/pilot/formulas/registry.ts; apps/web/src/server/pilot/formulas/engine.ts. Status stays DRAFT. |
| 2026-08-16 | wave9-reconciliation | Owner decision 2026-08-16: narrow-but-real slices promote per the playbook rule (DONE means slice shipped in code), with the slice line naming exactly what exists. Evidence: apps/web/src/server/pilot/formulas/registry.ts; apps/web/src/server/pilot/formulas/engine.ts. Test: apps/web/src/server/pilot/formulas/mvpFormulaEngine.test.ts pins MVP-07/MVP-08 golden values; [the rest of this cell was cut off; rewritten 2026-09-28 by Claude from the test files, stating only what they assert:] that file asserts MVP-07 (round outputs 10, 12, 8: 20% variation; a single round returns no value, INSUFFICIENT_ROUNDS) and MVP-08 (10 then 8: -2 raw, -20%; a zero previous round keeps the raw change and refuses the percentage, DIV_BY_ZERO). `apps/web/app/api/pilot/shadow/formulas/formulaRoutes.test.ts` covers the formula routes these are served through (its examples use MVP-01 and MVP-02): an observation takes its organization and source from the session, not the request; nothing is stored when athlete access is refused; a formula runs only on stored observation ids; a parent may read results; an athlete asking for a calculation gets 403. |
| 2026-09-29 | Claude (housekeeping round 3) | ManualVerification row added: PENDING_SIGN_OFF, meaning built, not yet tried by a person (OD-2026-09-29-002, 9a). It moves to SIGNED_OFF only on Jason's word; how to try it is in docs/capabilities/SIGN_OFF_WALKTHROUGH.md. |
