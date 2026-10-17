# Module 034

| Field | Value |
|-------|-------|
| Status | **DONE** |
| Status note | Was "DONE (Wave 5 tracker)" until 2026-10-16. return-to-training/route.ts GET, POST create plan on an injury (medical_clearance_on_file), PATCH advance step, over safetyFlags.ts createReturnToTrainingPlan, addReturnToTrainingStep, advanceReturnToTrainingStep. The 2026-09-28 audit note said no route; one now exis... |
| Code | `apps/web/app/api/pilot/coach/return-to-training/route.ts`, `apps/web/src/server/pilot/safetyFlags.ts` |
| Tests | `apps/web/app/api/pilot/coach/return-to-training/route.test.ts`, `apps/web/src/server/pilot/safetyFlags.pg.test.ts` |
| Active | false |
| ManualVerification | SIGNED_OFF |
| Parent | 11 Safety Gate |
| Vertical slice | return-to-training flag after gate clear |

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
| 2026-09-28 | Claude (documentation cleanup) | Checked for OD-2026-09-28-010 item 18 and NOT relabelled "claimed, no code": return-to-training code exists. Plans and weekly steps are in `apps/web/src/server/pilot/safetyFlags.ts` (createReturnToTrainingPlan, addReturnToTrainingStep, advanceReturnToTrainingStep), over tables created by `infra/azure/pilot_slice_postgres_safety_flags_migration.sql` (added 2026-08-07, c146d289). No API route or page calls it (searched `app/` on 2026-09-28). Whether that is the "flag after gate clear" slice named above is for Jason's walkthrough. |
| 2026-10-16 | Claude (lane L32) | Status set to **DONE** under the 2026-10-16 status vocabulary (DONE / MAPPED / CLAIMED-NO-CODE / DRAFT; Overwatch GO). Was "DONE (Wave 5 tracker)". Code and Tests rows added; the capability status check in CI reads them. ManualVerification unchanged. |
