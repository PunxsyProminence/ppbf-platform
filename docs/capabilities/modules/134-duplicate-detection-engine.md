# Module 134 — Duplicate Detection Engine

| Field | Value |
|-------|-------|
| Status | **DONE** |
| Status note | Was "DONE (Wave 9 reconciliation follow-up)" until 2026-10-16. findDuplicateGuardianGroups (duplicateGuardians.ts, maskEmail :28) served by admin route and /admin/data-quality page, report-only |
| Code | `apps/web/app/api/pilot/admin/data-quality/duplicate-guardians/route.ts`, `apps/web/app/admin/data-quality/page.tsx`, `apps/web/src/server/pilot/duplicateGuardians.ts` |
| Tests | `apps/web/app/api/pilot/admin/data-quality/duplicate-guardians/route.test.ts`, `apps/web/app/admin/data-quality/page.test.tsx`, `apps/web/src/server/pilot/duplicateGuardians.test.ts` |
| Vertical slice | guardian-record duplicate detection surfaced org-scoped at /admin/data-quality (masked emails, athlete ids only, report-only -- merging stays a human decision); other entity classes are future slices |
| Active | false |
| ManualVerification | PENDING_SIGN_OFF |
| Promotion required | true |
| Category | Data Quality / Trust (`dataQualityTrust`) |
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
| 2026-08-15 | wave9-reconciliation | Reconciliation audit: PARTIAL coverage — checkDuplicateGuardians: group-by-email query finding duplicate guardian records across claimed/unclaimed rows. Missing: Real, tested duplicate-detection logic exists but only as a standalone maintenance script (not wired to any API route or UI page), and it is narrowly . Evidence: apps/web/scripts/pilot-check-duplicate-guardians.mjs; apps/web/src/server/pilot/duplicateGuardianCheck.pg.test.ts. Status stays DRAFT. |
| 2026-08-16 | wave9-reconciliation | The audit's missing API/UI built: findDuplicateGuardianGroups (org-scoped variant of the CI check's query, emails masked server-side), admin-only route, /admin/data-quality page separating hidden-children findings from harmless splits. Tests pin masking, org scoping, role refusals, report-only UI, and failed-check honesty. Promoted DRAFT -> DONE as the guardian-duplicates slice. |
| 2026-09-29 | Claude (housekeeping round 3) | ManualVerification row added: PENDING_SIGN_OFF, meaning built, not yet tried by a person (OD-2026-09-29-002, 9a). It moves to SIGNED_OFF only on Jason's word; how to try it is in docs/capabilities/SIGN_OFF_WALKTHROUGH.md. |
| 2026-10-16 | Claude (lane L32) | Status set to **DONE** under the 2026-10-16 status vocabulary (DONE / MAPPED / CLAIMED-NO-CODE / DRAFT; Overwatch GO). Was "DONE (Wave 9 reconciliation follow-up)". Code and Tests rows added; the capability status check in CI reads them. ManualVerification unchanged. |
