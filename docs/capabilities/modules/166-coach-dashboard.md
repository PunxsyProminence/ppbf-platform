# Module 166

| Field | Value |
|-------|-------|
| Status | **DONE** |
| Status note | Was "DONE (Wave 8 tracker)" until 2026-10-16. Coach home (pilotRoleRouting.ts coach destination) mounts CoachWorkspace with coach reviews (coach-reviews/list) and own athletes; no page-level test, component tests cover it. |
| Code | `apps/web/app/coach/environment/intake-router/page.tsx`, `apps/web/components/CoachWorkspace.tsx`, `apps/web/app/api/pilot/coach-reviews/list/route.ts` |
| Tests | `apps/web/components/coachWorkspaceHonesty.test.tsx`, `apps/web/components/coachWorkspaceFailedReads.test.tsx`, `apps/web/app/api/pilot/coach-reviews/list/route.test.ts` |
| Active | false |
| ManualVerification | SIGNED_OFF |
| Parent | 10 Coach |
| Vertical slice | coach dashboard open reviews + assigned athlete count |

> **Alias (2026-09-28):** Module 113 has the same name ("Coach Dashboard") under Coach System. One capability listed twice; count it once.

## Boundaries
- Dashboards show only role-allowed data
- Board stays aggregate-only (not these dashboards)
- AI drafts never set approved_flag / final decisions
- governance.active stays false

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | wave8-ps | Wave 8 batch DONE in tracker |
| 2026-08-28 | owner (Jason Neale) | Manual verification signed off. ONE BLANKET SIGN-OFF covering all 47 modules that carried PENDING_SIGN_OFF, given by the owner on this date -- NOT 47 separate inspections, and this line says so on purpose. What it records is the owner's acceptance of the slices as built; it is not a statement that each module was individually re-verified against the running app, and it does not change `Active`, which stays false. At the time of signing, 59 of the 94 modules claiming DONE cited no checkable path into the codebase -- the capability evidence guard in the web test suite measures that and stops it growing -- deliberately named here without a path, because this note would otherwise read as a citation to the very tooling that counts citations, and make 47 modules look evidenced by their own sign-off line. |
| 2026-10-16 | Claude (lane L32) | Status set to **DONE** under the 2026-10-16 status vocabulary (DONE / MAPPED / CLAIMED-NO-CODE / DRAFT; Overwatch GO). Was "DONE (Wave 8 tracker)". Code and Tests rows added; the capability status check in CI reads them. ManualVerification unchanged. |
