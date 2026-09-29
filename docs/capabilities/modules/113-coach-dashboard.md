# Module 113 — Coach Dashboard

| Field | Value |
|-------|-------|
| Status | **DONE** (Wave 9 reconciliation) |
| Vertical slice | coach workspace dashboard: floor plans, open coach reviews, tasks/goals, pain/barrier reports, escalations |
| Active | false |
| ManualVerification | PENDING_SIGN_OFF |
| Promotion required | true |
| Category | Coach System (`coachSystem`) |
| Source | `2.0.0-draft-merged` |
| Parent original-25 | _unmapped_ |

> **Alias (2026-09-28):** Module 166 has the same name ("Coach Dashboard") under Dashboards / Reporting. One capability listed twice; count it once.

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
| 2026-08-15 | wave9-reconciliation | Reconciliation audit: DoD verified in code (route+role gate+org isolation+test). Evidence: apps/web/app/coach/environment/intake-router/page.tsx; apps/web/components/CoachWorkspace.tsx; apps/web/components/coachWorkspaceHonesty.test.tsx. Test: apps/web/components/coachWorkspaceHonesty.test.tsx exercises rendering against mocked backing routes |
| 2026-09-29 | Claude (housekeeping round 3) | ManualVerification row added: PENDING_SIGN_OFF, meaning built, not yet tried by a person (OD-2026-09-29-002, 9a). It moves to SIGNED_OFF only on Jason's word; how to try it is in docs/capabilities/SIGN_OFF_WALKTHROUGH.md. |
