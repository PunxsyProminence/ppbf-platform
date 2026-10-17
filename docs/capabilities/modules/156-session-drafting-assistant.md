# Module 156 — Session Drafting Assistant

| Field | Value |
|-------|-------|
| Status | **MAPPED** |
| Status note | Was "DRAFT" until 2026-10-16. content-import/route.ts GET returns workoutIntakePrompt (aiPrompt.ts) so an admin can have an external AI draft a workout into the upload CSVs; partial: no in-app drafting of sessions. |
| Code | `apps/web/app/api/pilot/admin/content-import/route.ts`, `apps/web/src/server/pilot/contentImport/aiPrompt.ts`, `apps/web/app/admin/content-import/page.tsx` |
| Tests | `apps/web/src/server/pilot/contentImport/aiPrompt.test.ts`, `apps/web/app/api/pilot/admin/content-import/route.test.ts` |
| Active | false |
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
| 2026-10-16 | Claude (lane L32) | Status set to **MAPPED** under the 2026-10-16 status vocabulary (DONE / MAPPED / CLAIMED-NO-CODE / DRAFT; Overwatch GO). Was "DRAFT". Code and Tests rows added; the capability status check in CI reads them. ManualVerification unchanged. |
