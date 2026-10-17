# Module 120 — Class Control Engine

| Field | Value |
|-------|-------|
| Status | **DONE** |
| Status note | Was "DONE" until 2026-10-16. scheduler/route.ts POST create_class (:697), cancel_class (:770), cover_class; cancel authority in schedulerCancelRule.ts; surfaced at /schedule. |
| Code | `apps/web/app/api/pilot/scheduler/route.ts`, `apps/web/app/schedule/page.tsx`, `apps/web/src/server/pilot/schedulerCancelRule.ts`, `apps/web/src/server/pilot/schedulerDb.ts` |
| Tests | `apps/web/app/api/pilot/scheduler/route.test.ts`, `apps/web/src/server/pilot/schedulerCancelRule.test.ts`, `apps/web/app/schedule/cancelClass.test.tsx` |
| Active | false |
| ManualVerification | SIGNED_OFF |
| Parent original-25 | Class / Program |

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | wave4-ps | DONE; 122 started |
| 2026-08-28 | owner (Jason Neale) | Manual verification signed off. ONE BLANKET SIGN-OFF covering all 47 modules that carried PENDING_SIGN_OFF, given by the owner on this date -- NOT 47 separate inspections, and this line says so on purpose. What it records is the owner's acceptance of the slices as built; it is not a statement that each module was individually re-verified against the running app, and it does not change `Active`, which stays false. At the time of signing, 59 of the 94 modules claiming DONE cited no checkable path into the codebase -- the capability evidence guard in the web test suite measures that and stops it growing -- deliberately named here without a path, because this note would otherwise read as a citation to the very tooling that counts citations, and make 47 modules look evidenced by their own sign-off line. |
| 2026-10-16 | Claude (lane L32) | Status set to **DONE** under the 2026-10-16 status vocabulary (DONE / MAPPED / CLAIMED-NO-CODE / DRAFT; Overwatch GO). Was "DONE". Code and Tests rows added; the capability status check in CI reads them. ManualVerification unchanged. |
