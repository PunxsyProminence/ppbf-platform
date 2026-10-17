# Module 148 — Program Outcome Reporting

| Field | Value |
|-------|-------|
| Status | **DONE** |
| Status note | Was "DONE" until 2026-10-16. activeAthletes, trainingSessions30Days and goalStatusBuckets counts (boardSummary.ts,151) served via board/summary route and /board/aggregates; counts only, suppressed small cohorts |
| Code | `apps/web/app/api/pilot/board/summary/route.ts`, `apps/web/src/server/pilot/boardSummary.ts`, `apps/web/app/board/aggregates/page.tsx` |
| Tests | `apps/web/app/api/pilot/board/summary/route.test.ts`, `apps/web/src/server/pilot/boardSummary.test.ts`, `apps/web/app/board/aggregates/page.test.tsx` |
| Active | false |
| ManualVerification | SIGNED_OFF |
| Parent original-25 | 17 Grant/Impact Reporting |
| Vertical slice | program outcome counts from sessions/goals aggregates |

## Intent
Outcome counts for program reporting: sessions completed, goals completed, active athletes — from existing stored data only.

## Boundaries
- Does not invent success rates without a real denominator.
- Does not include individual athlete outcome lists on board/public.
- Does not invent dollar ROI.

## Vertical slice
1. Map fields already on board summary (activeAthletes, trainingSessions30Days, goal buckets)
2. Expose the same counts to staff report surface OR document them as the outcome set
3. Keep cohort suppression
4. Test/manual: payload has counts only, no athlete_id

## Checklist (manual) — REQUIRED FOR SIGN-OFF
- [ ] Outcome counts visible to allowed role
- [ ] Match source aggregates
- [ ] No athlete identifiers
- [ ] ManualVerification=SIGNED_OFF

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | wave-ps | DONE; 149 started |
| 2026-08-03 | vscode | Restored Intent/Boundaries/Vertical slice/Checklist, which the DONE write had overwritten. PENDING_SIGN_OFF refers to the checklist above; without it nobody could sign off. |
| 2026-08-28 | owner (Jason Neale) | Manual verification signed off. ONE BLANKET SIGN-OFF covering all 47 modules that carried PENDING_SIGN_OFF, given by the owner on this date -- NOT 47 separate inspections, and this line says so on purpose. What it records is the owner's acceptance of the slices as built; it is not a statement that each module was individually re-verified against the running app, and it does not change `Active`, which stays false. At the time of signing, 59 of the 94 modules claiming DONE cited no checkable path into the codebase -- the capability evidence guard in the web test suite measures that and stops it growing -- deliberately named here without a path, because this note would otherwise read as a citation to the very tooling that counts citations, and make 47 modules look evidenced by their own sign-off line. |
| 2026-10-16 | Claude (lane L32) | Status set to **DONE** under the 2026-10-16 status vocabulary (DONE / MAPPED / CLAIMED-NO-CODE / DRAFT; Overwatch GO). Was "DONE". Code and Tests rows added; the capability status check in CI reads them. ManualVerification unchanged. |
