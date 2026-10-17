# Module 093

| Field | Value |
|-------|-------|
| Status | **DONE** |
| Status note | Was "DONE (Wave 5 tracker)" until 2026-10-16. /parent/dashboard (parent role only) mounts ParentHub: child switcher over linked athletes, tasks, assignments, messages, attendance (page.tsx; ParentHub.tsx). /guardian/dashboard is only a pointer page. No test file sits beside page.tsx; the ParentHub component tests carry it. |
| Code | `apps/web/app/parent/dashboard/page.tsx`, `apps/web/components/ParentHub.tsx`, `apps/web/components/ParentAssignmentList.tsx`, `apps/web/components/ParentProgressSummary.tsx` |
| Tests | `apps/web/components/parentHubChildSwitch.test.tsx`, `apps/web/components/parentHubTasks.test.tsx`, `apps/web/components/parentHubSummary.test.tsx` |
| Active | false |
| ManualVerification | SIGNED_OFF |
| Parent | 15 Guardian Portal |
| Vertical slice | guardian dashboard shows linked athletes + open tasks only |

> **Alias (2026-09-28):** Module 167 has the same name ("Parent / Guardian Dashboard") under Dashboards / Reporting. One capability listed twice; count it once.

## Boundaries
- No invented metrics
- No board individual PII
- No AI auto-approval
- governance.active stays false

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | wave5-ps | Wave 5 batch DONE in tracker |
| 2026-08-28 | owner (Jason Neale) | Manual verification signed off. ONE BLANKET SIGN-OFF covering all 47 modules that carried PENDING_SIGN_OFF, given by the owner on this date -- NOT 47 separate inspections, and this line says so on purpose. What it records is the owner's acceptance of the slices as built; it is not a statement that each module was individually re-verified against the running app, and it does not change `Active`, which stays false. At the time of signing, 59 of the 94 modules claiming DONE cited no checkable path into the codebase -- the capability evidence guard in the web test suite measures that and stops it growing -- deliberately named here without a path, because this note would otherwise read as a citation to the very tooling that counts citations, and make 47 modules look evidenced by their own sign-off line. |
| 2026-10-16 | Claude (lane L32) | Status set to **DONE** under the 2026-10-16 status vocabulary (DONE / MAPPED / CLAIMED-NO-CODE / DRAFT; Overwatch GO). Was "DONE (Wave 5 tracker)". Code and Tests rows added; the capability status check in CI reads them. ManualVerification unchanged. |
