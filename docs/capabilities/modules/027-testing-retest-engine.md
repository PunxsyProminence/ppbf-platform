# Module 027 — Testing / Retest Engine

| Field | Value |
|-------|-------|
| Status | **DONE** |
| Status note | Was "DONE (Wave 9 slice promotion)" until 2026-10-16. data-collection-requests/route.ts GET queue, POST, PATCH one-tap capture, DELETE decline, over assessmentProtocols.ts (retest_interval_days, listDueAssessments, captureDataCollectionRequest, declineDataCollectionRequest); queue shown on coach/assessments page. |
| Code | `apps/web/app/api/pilot/data-collection-requests/route.ts`, `apps/web/app/coach/assessments/page.tsx`, `apps/web/src/server/pilot/assessmentProtocols.ts` |
| Tests | `apps/web/app/api/pilot/data-collection-requests/route.test.ts`, `apps/web/src/server/pilot/assessmentProtocols.pg.test.ts`, `apps/web/app/coach/assessments/page.test.tsx` |
| Vertical slice | protocol retest_interval config + due-assessment queue + one-tap capture/decline API |
| Active | false |
| ManualVerification | PENDING_SIGN_OFF |
| Promotion required | true |
| Category | Physical Training System (`physicalTrainingSystem`) |
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
| 2026-08-15 | wave9-reconciliation | Reconciliation audit: PARTIAL coverage — protocol retest_interval config + due-assessment queue + one-tap capture/decline API. Missing: Real, tested, role-gated, org-scoped code implements retest-interval scheduling and a due-assessment/capture workflow, matching the testing/retest con. Evidence: apps/web/src/server/pilot/assessmentProtocols.ts; infra/azure/pilot_slice_postgres_assessment_protocols_migration.sql. Status stays DRAFT. |
| 2026-08-16 | wave9-reconciliation | Owner decision 2026-08-16: narrow-but-real slices promote per the playbook rule (DONE means slice shipped in code), with the slice line naming exactly what exists. Evidence: apps/web/src/server/pilot/assessmentProtocols.ts; infra/azure/pilot_slice_postgres_assessment_protocols_migration.sql. Test: apps/web/src/server/pilot/assessmentProtocols.pg.test.ts pins protocol FK enforcement, due-assessment index be |
| 2026-09-29 | Claude (housekeeping round 3) | ManualVerification row added: PENDING_SIGN_OFF, meaning built, not yet tried by a person (OD-2026-09-29-002, 9a). It moves to SIGNED_OFF only on Jason's word; how to try it is in docs/capabilities/SIGN_OFF_WALKTHROUGH.md. |
| 2026-10-16 | Claude (lane L32) | Status set to **DONE** under the 2026-10-16 status vocabulary (DONE / MAPPED / CLAIMED-NO-CODE / DRAFT; Overwatch GO). Was "DONE (Wave 9 slice promotion)". Code and Tests rows added; the capability status check in CI reads them. ManualVerification unchanged. |
