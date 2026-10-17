# Module 011 — Goal Management System

| Field | Value |
|-------|-------|
| Status | **DONE** |
| Status note | Was "DONE (slice shipped)" until 2026-10-16. POST /api/pilot/goals (route.ts) upserts goal with category and progress_percent (entities.ts update/insert columns category, progress_percent). |
| Code | `apps/web/app/api/pilot/goals/route.ts`, `apps/web/app/api/pilot/goals/list/route.ts`, `apps/web/app/api/pilot/goals/personal/route.ts`, `apps/web/src/server/pilot/entities.ts`, `apps/web/components/PersonalGoalBoard.tsx` |
| Tests | `apps/web/app/api/pilot/goals/route.test.ts`, `apps/web/app/api/pilot/goals/list/route.test.ts`, `apps/web/src/server/pilot/goalCategoryProgress.pg.test.ts` |
| Active | false |
| ManualVerification | PENDING_SIGN_OFF |
| Promotion required | true |
| Parent original-25 | 4 Goal Intake -> Routing Service |

## Vertical slice completed
persist category + progress on goals

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | wave1-ps | Marked DONE; 006 started |
| 2026-09-28 | Claude (documentation cleanup) | ManualVerification, moved here from the CSV (history, OD-2026-09-28-010 item 17): the CSV's line 12 reads `PASSED`, set in #187 (`876cdb41`, 2026-08-03); in #186 the same morning it read `PENDING_SIGN_OFF`. Nothing records who checked what, and the Wave 1 report of that day counts 0 PASSED and lists this module as PENDING_SIGN_OFF (`docs/archive/2026-09-28_capabilities-work/WAVE1-STATUS-REPORT.md`). Not added as a table row, because the capability evidence guard accepts only PENDING_SIGN_OFF, SIGNED_OFF or NOT_REQUIRED there. This file carried no ManualVerification row, so the 2026-08-28 blanket sign-off (modules that carried PENDING_SIGN_OFF) did not cover it. |
| 2026-09-29 | Claude (housekeeping round 3) | ManualVerification row added: PENDING_SIGN_OFF, meaning built, not yet tried by a person (OD-2026-09-29-002, 9a). It moves to SIGNED_OFF only on Jason's word; how to try it is in docs/capabilities/SIGN_OFF_WALKTHROUGH.md. The CSV's `PASSED` in the row above is not carried over: nothing records who checked. |
| 2026-10-16 | Claude (lane L32) | Status set to **DONE** under the 2026-10-16 status vocabulary (DONE / MAPPED / CLAIMED-NO-CODE / DRAFT; Overwatch GO). Was "DONE (slice shipped)". Code and Tests rows added; the capability status check in CI reads them. ManualVerification unchanged. |
