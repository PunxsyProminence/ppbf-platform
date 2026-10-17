# Module 012

| Field | Value |
|-------|-------|
| Status | **DONE** |
| Status note | Was "DONE (Wave 5 tracker)" until 2026-10-16. GET /api/pilot/athletes/list returns the org roster (getAthletesByOrganization, entities.ts); /admin/athletes lists, filters and edits gym_status (page.tsx). |
| Code | `apps/web/app/api/pilot/athletes/list/route.ts`, `apps/web/app/admin/athletes/page.tsx`, `apps/web/app/api/pilot/athletes/update/route.ts`, `apps/web/src/server/pilot/entities.ts`, `apps/web/app/api/pilot/coach/athletes/route.ts` |
| Tests | `apps/web/app/api/pilot/athletes/list/route.test.ts`, `apps/web/app/admin/athletes/page.test.tsx`, `apps/web/app/api/pilot/athletes/update/route.test.ts` |
| Active | false |
| ManualVerification | SIGNED_OFF |
| Parent | 2 Participant master |
| Vertical slice | active roster list for org with gym_status filter |

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
