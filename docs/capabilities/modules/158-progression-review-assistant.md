# Module 158 — Progression Review Assistant

| Field | Value |
|-------|-------|
| Status | **DONE** |
| Status note | Was "DRAFT" until 2026-10-16. progression/suggestions/route.ts GET returns deterministic gap suggestions (progressionSuggestions.ts) that a coach confirms or dismisses; rule-based, not AI, shares code with module 171. |
| Code | `apps/web/app/api/pilot/progression/suggestions/route.ts`, `apps/web/src/server/pilot/progressionSuggestions.ts`, `apps/web/app/coach/progression-intelligence/page.tsx` |
| Tests | `apps/web/app/api/pilot/progression/suggestions/route.test.ts`, `apps/web/src/server/pilot/progressionSuggestions.test.ts`, `apps/web/app/coach/progression-intelligence/page.test.tsx` |
| Active | false |
| ManualVerification | PENDING_SIGN_OFF |
| Promotion required | true |
| Category | AI / Automation Support (`aiAutomationSupport`) |
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
| 2026-10-16 | Claude (lane L32) | Status set to **DONE** under the 2026-10-16 status vocabulary (DONE / MAPPED / CLAIMED-NO-CODE / DRAFT; Overwatch GO). Was "DRAFT". Code and Tests rows added; the capability status check in CI reads them. ManualVerification row added: PENDING_SIGN_OFF, built, not yet tried by a person (OD-2026-09-29-002 item 9a). |
