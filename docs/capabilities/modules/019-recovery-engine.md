# Module 019

| Field | Value |
|-------|-------|
| Status | **MAPPED** |
| Status note | Was "DONE (Wave 6 tracker)" until 2026-10-16. No 'recovery status tag' exists. Recovery-related data is served: athlete check-in captures sleep/soreness/energy (wellnessScales.ts), coach reads sleep trend (athlete-sleep-trend/route.ts) and a wellness-decline suggestion (wellnessTrend.ts). Judgment call: partial coverage. |
| Code | `apps/web/app/api/pilot/coach/athlete-sleep-trend/route.ts`, `apps/web/src/server/pilot/athleteCheckIns.ts`, `apps/web/src/server/pilot/wellnessTrend.ts`, `apps/web/components/AthleteCheckInPanel.tsx`, `apps/web/components/SleepTrend.tsx` |
| Tests | `apps/web/app/api/pilot/coach/athlete-sleep-trend/route.test.ts`, `apps/web/src/server/pilot/wellnessTrend.test.ts`, `apps/web/src/server/pilot/athleteCheckIns.pg.test.ts` |
| Active | false |
| ManualVerification | SIGNED_OFF |
| Parent | Recovery |
| Vertical slice | recovery status tag on session or athlete update allowlist |

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
| 2026-10-16 | Claude (lane L32) | Status set to **MAPPED** under the 2026-10-16 status vocabulary (DONE / MAPPED / CLAIMED-NO-CODE / DRAFT; Overwatch GO). Was "DONE (Wave 6 tracker)". Code and Tests rows added; the capability status check in CI reads them. ManualVerification unchanged. |
