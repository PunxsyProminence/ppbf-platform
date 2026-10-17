# Module 069 — Behavior Pattern Engine

| Field | Value |
|-------|-------|
| Status | **MAPPED** |
| Status note | Was "DRAFT" until 2026-10-16. SHADOW behavioural pattern formation library (promotion.ts evaluatePatternCandidate, lessons.ts evaluateValidatedAthleteLesson) is pure and tested but imported by no route, page or other server module (index.ts header: wiring is a later slice), so no role can reach it. |
| Code | `apps/web/src/server/pilot/patterns/index.ts`, `apps/web/src/server/pilot/patterns/promotion.ts`, `apps/web/src/server/pilot/patterns/lessons.ts` |
| Tests | `apps/web/src/server/pilot/patterns/promotion.test.ts`, `apps/web/src/server/pilot/patterns/lessons.test.ts`, `apps/web/src/server/pilot/patterns/evidence.test.ts` |
| Active | false |
| Promotion required | true |
| Category | Mental / Emotional / Behavioral (`mentalEmotionalBehavioral`) |
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
| 2026-10-16 | Claude (lane L32) | Status set to **MAPPED** under the 2026-10-16 status vocabulary (DONE / MAPPED / CLAIMED-NO-CODE / DRAFT; Overwatch GO). Was "DRAFT". Code and Tests rows added; the capability status check in CI reads them. ManualVerification unchanged. |
