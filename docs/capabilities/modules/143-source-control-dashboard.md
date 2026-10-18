# Module 143 — Source-Control Dashboard

| Field | Value |
|-------|-------|
| Status | **DRAFT** |
| Status note | Was "DRAFT" until 2026-10-16. No source-control screen exists (app/ has no source-control dir; module audit log 2026-10-12 says pages deleted by lane N4-04). Only app/removedMockPages.test.ts mentions it |
| Code | none |
| Tests | none |
| Active | false |
| Promotion required | true |
| Category | Governance / Admin / Nonprofit (`governanceAdminNonprofit`) |
| Source | `2.0.0-draft-merged` |
| Parent original-25 | _unmapped_ |

> **Alias (2026-09-28):** Module 175 has the same name ("Source-Control Dashboard") under Dashboards / Reporting. One capability listed twice; count it once.

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
| 2026-08-15 | wave9-reconciliation | Reconciliation audit: PARTIAL coverage — The page literally named for this module is explicitly self-labeled 'PLANNED / FRONT-END PLACEHOLDER / NOT YET. Missing: The /source-control (and /publication-workflow) pages are not wired to any backend, org-scoped or otherwise; they render hardcoded sample arrays and e. Evidence: the /source-control and /source-control/publication-workflow page files (deleted 2026-10-12, see the next row). Status stays DRAFT. |
| 2026-10-12 | lane N4-04 (issue #1477) | Both pages deleted: they were ungated and showed a made-up approval pipeline (Audit C, C-01). No screen exists for this module; it stays DRAFT, and publication automation stays parked (BACKLOG-publication-automation). The evidence paths in the row above no longer exist and are named in words only. |
| 2026-10-16 | Claude (lane L32) | Status set to **DRAFT** under the 2026-10-16 status vocabulary (DONE / MAPPED / CLAIMED-NO-CODE / DRAFT; Overwatch GO). Was "DRAFT". Code and Tests rows added; the capability status check in CI reads them. ManualVerification unchanged. |
