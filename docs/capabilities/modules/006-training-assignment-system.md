# Module 006 — Training Assignment System

| Field | Value |
|-------|-------|
| Status | **DONE** |
| Status note | Was "DONE" until 2026-10-16. POST /api/pilot/progression/assignments (route.ts) calls assignDrill (progression.ts); coach page posts it (progression-intelligence/page.tsx). |
| Code | `apps/web/app/api/pilot/progression/assignments/route.ts`, `apps/web/app/api/pilot/progression/assignments/cancel/route.ts`, `apps/web/src/server/pilot/progression.ts`, `apps/web/app/coach/progression-intelligence/page.tsx` |
| Tests | `apps/web/app/api/pilot/progression/assignments/route.test.ts`, `apps/web/app/api/pilot/progression/assignments/cancel/route.test.ts`, `apps/web/app/coach/progression-intelligence/page.test.tsx` |
| Active | false |
| ManualVerification | PENDING_SIGN_OFF |
| Parent original-25 | 5/6 Assignment & Skill |

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | wave1-ps | Marked DONE; 008 started |
| 2026-09-29 | Claude (housekeeping round 3) | ManualVerification row added: PENDING_SIGN_OFF, meaning built, not yet tried by a person (OD-2026-09-29-002, 9a). It moves to SIGNED_OFF only on Jason's word; how to try it is in docs/capabilities/SIGN_OFF_WALKTHROUGH.md. |
| 2026-10-16 | Claude (lane L32) | Status set to **DONE** under the 2026-10-16 status vocabulary (DONE / MAPPED / CLAIMED-NO-CODE / DRAFT; Overwatch GO). Was "DONE". Code and Tests rows added; the capability status check in CI reads them. ManualVerification unchanged. |
