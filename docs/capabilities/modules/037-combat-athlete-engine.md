# Module 037

| Field | Value |
|-------|-------|
| Status | **MAPPED** |
| Status note | Was "claimed, no code (relabelled 2026-09-28; see audit log)" until 2026-10-16. Coach writes per-athlete sparring limits (highest_allowed_stage, max hard/open sessions per 7 days) via athlete-contact-caps/route.ts POST (athleteContactCaps.ts), warn-only; there is no literal 'sparring allowed' boolean, so it is a partial fit to the slice wording. |
| Code | `apps/web/app/api/pilot/coach/athlete-contact-caps/route.ts`, `apps/web/app/coach/sparring-caps/page.tsx`, `apps/web/src/server/pilot/athleteContactCaps.ts` |
| Tests | `apps/web/app/api/pilot/coach/athlete-contact-caps/route.test.ts`, `apps/web/app/coach/sparring-caps/page.test.tsx`, `apps/web/src/server/pilot/athleteContactCaps.pg.test.ts` |
| Active | false |
| ManualVerification | SIGNED_OFF |
| Parent | Combat / boxing |
| Vertical slice | sparring allowed boolean on athlete; coach write |

## Boundaries
- No auto safety gate changes (use 003)
- No invented sensor metrics
- No board individual rows
- governance.active stays false

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | wave6-ps | Wave 6 batch DONE in tracker |
| 2026-08-28 | owner (Jason Neale) | Manual verification signed off. ONE BLANKET SIGN-OFF covering all 47 modules that carried PENDING_SIGN_OFF, given by the owner on this date -- NOT 47 separate inspections, and this line says so on purpose. What it records is the owner's acceptance of the slices as built; it is not a statement that each module was individually re-verified against the running app, and it does not change `Active`, which stays false. At the time of signing, 59 of the 94 modules claiming DONE cited no checkable path into the codebase -- the capability evidence guard in the web test suite measures that and stops it growing -- deliberately named here without a path, because this note would otherwise read as a citation to the very tooling that counts citations, and make 47 modules look evidenced by their own sign-off line. |
| 2026-09-28 | Claude (documentation cleanup) | Status relabelled from **DONE** (Wave 6 tracker) to **claimed, no code** under OD-2026-09-28-010 item 18. Basis: this file names no code, route or table; the sign-off walkthrough guide's route check (2026-08-18) found nothing in code for this module; and a search of the web app and the SQL migrations on 2026-09-28 found no code for a sparring-allowed field. ManualVerification SIGNED_OFF (the 2026-08-28 blanket sign-off) is left as recorded. Stays so until Jason walks through it. |
| 2026-10-16 | Claude (lane L32) | Status set to **MAPPED** under the 2026-10-16 status vocabulary (DONE / MAPPED / CLAIMED-NO-CODE / DRAFT; Overwatch GO). Was "claimed, no code (relabelled 2026-09-28; see audit log)". Code and Tests rows added; the capability status check in CI reads them. ManualVerification unchanged. |
