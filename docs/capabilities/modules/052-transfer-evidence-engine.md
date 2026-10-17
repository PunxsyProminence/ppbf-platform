# Module 052 — Transfer Evidence Engine

| Field | Value |
|-------|-------|
| Status | **MAPPED** |
| Status note | Was "DRAFT" until 2026-10-16. Partial only: the transfer-check read (route.ts GET, falseProgress.ts classifyTransfer) returns controlled-vs-live make/miss counts per metric as transfer evidence for a coach; it is the same code recorded under module 053, and no separate evidence store or engine exists (intervention_evidence_li... |
| Code | `apps/web/app/api/pilot/coach/transfer-check/route.ts`, `apps/web/src/server/pilot/falseProgress.ts` |
| Tests | `apps/web/app/api/pilot/coach/transfer-check/route.test.ts`, `apps/web/src/server/pilot/falseProgress.test.ts` |
| Active | false |
| Promotion required | true |
| Category | Transfer System (`transferSystem`) |
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
