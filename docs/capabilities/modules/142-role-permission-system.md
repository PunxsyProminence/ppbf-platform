# Module 142 — Role Permission System

| Field | Value |
|-------|-------|
| Status | **DONE** (Wave 9 reconciliation) |
| Vertical slice | Central requireRole()/isOrganizationAdminRole() primitives used by essentially every API route in the platform |
| Active | false |
| Promotion required | true |
| Category | Governance / Admin / Nonprofit (`governanceAdminNonprofit`) |
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
| 2026-08-15 | wave9-reconciliation | Reconciliation audit: DoD verified in code (route+role gate+org isolation+test). Evidence: apps/web/src/server/pilot/access.ts; apps/web/src/server/pilot/staffProvisioning.ts; apps/web/app/admin/people/page.tsx. Test: apps/web/src/server/pilot/access.test.ts ('requireRole', 'isOrganizationAdminRole' describe blocks); [the rest of this cell was cut off; rewritten 2026-09-28 by Claude from the test files, stating only what they assert:] those blocks assert `organization_admin` and legacy `admin` are organization admins and coach, athlete and board are not; `requireRole` admits a listed role, refuses an unlisted one with Forbidden, treats `admin` and `organization_admin` as each other, and never lets board pass as admin or coach. `apps/web/app/api/pilot/admin/staff/route.test.ts` (the staff route behind `/admin/people`) asserts a non-admin caller is refused on GET and DELETE, a parent invite must name an athlete, a guardian link cannot attach to a non-parent role, and an organization admin cannot invite another organization admin. |
