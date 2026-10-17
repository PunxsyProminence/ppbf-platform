# Module 144 — Change Log System

| Field | Value |
|-------|-------|
| Status | **DONE** |
| Status note | Was "DONE (Wave 9 reconciliation)" until 2026-10-16. RoleSessionGate-wrapped /audit page fetches audit events via POST /api/pilot/audit/get (audit/page.tsx) |
| Code | `apps/web/app/audit/page.tsx`, `apps/web/app/api/pilot/audit/get/route.ts`, `apps/web/src/server/pilot/audit.ts` |
| Tests | `apps/web/app/audit/page.test.tsx`, `apps/web/app/api/pilot/audit/get/route.test.ts` |
| Vertical slice | Live UI (RoleSessionGate-wrapped) that fetches and renders pilot.audit_events via POST /api/pilot/audit/get |
| Active | false |
| ManualVerification | PENDING_SIGN_OFF |
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
| 2026-08-15 | wave9-reconciliation | Reconciliation audit: DoD verified in code (route+role gate+org isolation+test). Evidence: apps/web/app/audit/page.tsx; apps/web/app/api/pilot/audit/get/route.ts; apps/web/src/server/pilot/audit.ts. Test: apps/web/app/api/pilot/audit/get/route.test.ts; apps/web/app/audit/page.test.tsx |
| 2026-09-29 | Claude (housekeeping round 3) | ManualVerification row added: PENDING_SIGN_OFF, meaning built, not yet tried by a person (OD-2026-09-29-002, 9a). It moves to SIGNED_OFF only on Jason's word; how to try it is in docs/capabilities/SIGN_OFF_WALKTHROUGH.md. |
| 2026-10-16 | Claude (lane L32) | Status set to **DONE** under the 2026-10-16 status vocabulary (DONE / MAPPED / CLAIMED-NO-CODE / DRAFT; Overwatch GO). Was "DONE (Wave 9 reconciliation)". Code and Tests rows added; the capability status check in CI reads them. ManualVerification unchanged. |
