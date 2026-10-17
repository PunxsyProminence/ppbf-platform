# Module 086 — At-Home Movement Homework Engine

| Field | Value |
|-------|-------|
| Status | **MAPPED** |
| Status note | Was "DRAFT" until 2026-10-16. Drills the coach assigns (reps, duration, frequency per week, due date) show read-only to the guardian in ParentAssignmentList (mounted ParentHub.tsx, /parent/dashboard). No home-specific movement homework engine; guardian cannot log completion. Partial fit. |
| Code | `apps/web/app/api/pilot/progression/assignments/route.ts`, `apps/web/components/ParentAssignmentList.tsx`, `apps/web/app/parent/dashboard/page.tsx` |
| Tests | `apps/web/app/api/pilot/progression/assignments/route.test.ts`, `apps/web/components/parentAssignmentList.test.tsx` |
| Active | false |
| Promotion required | true |
| Category | At-Home / Parent / Guardian (`atHomeParentGuardian`) |
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
