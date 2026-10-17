# Module 151 — Consent / Waiver Tracker

| Field | Value |
|-------|-------|
| Status | **DONE** |
| Status note | Was "DONE" until 2026-10-16. waiver-status/route.ts GET gives admin/organization_admin an org-wide waiver rollup (route header names it Capability #151); athlete-consent/route.ts lets staff record/withdraw media consent. |
| Code | `apps/web/app/api/pilot/admin/waiver-status/route.ts`, `apps/web/src/server/pilot/waiverCompliance.ts`, `apps/web/app/admin/waiver-status/page.tsx`, `apps/web/app/api/pilot/admin/athlete-consent/route.ts` |
| Tests | `apps/web/app/api/pilot/admin/waiver-status/route.test.ts`, `apps/web/src/server/pilot/waiverCompliance.test.ts`, `apps/web/app/api/pilot/admin/athlete-consent/route.test.ts` |
| Active | false |
| ManualVerification | SIGNED_OFF |
| Parent original-25 | Compliance / participant record |
| Vertical slice | consent/waiver recorded flag on athlete + coach read |

## Intent
Track whether a consent/waiver is on file for an athlete (boolean + optional timestamp). Not a full e-sign product in this slice.

## Boundaries
- Does not store scanned PDF bodies in this slice unless already present.
- Does not expose waiver text to board.
- Does not auto-block training unless you explicitly wire gate later.

## Vertical slice
1. Find athlete fields or table for consent/waiver
2. Staff set recorded true/false (+ date if column exists)
3. Coach/admin read flag on athlete get
4. Audit on change
5. Tests: athlete cannot clear another athlete flag

## Checklist (manual) — REQUIRED FOR SIGN-OFF
- [ ] Staff can set flag
- [ ] Coach sees flag
- [ ] Persists after refresh
- [ ] ManualVerification=SIGNED_OFF

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | wave-ps | DONE; 152 started |
| 2026-08-03 | vscode | Restored Intent/Boundaries/Vertical slice/Checklist, which the DONE write had overwritten. PENDING_SIGN_OFF refers to the checklist above; without it nobody could sign off. |
| 2026-08-28 | owner (Jason Neale) | Manual verification signed off. ONE BLANKET SIGN-OFF covering all 47 modules that carried PENDING_SIGN_OFF, given by the owner on this date -- NOT 47 separate inspections, and this line says so on purpose. What it records is the owner's acceptance of the slices as built; it is not a statement that each module was individually re-verified against the running app, and it does not change `Active`, which stays false. At the time of signing, 59 of the 94 modules claiming DONE cited no checkable path into the codebase -- the capability evidence guard in the web test suite measures that and stops it growing -- deliberately named here without a path, because this note would otherwise read as a citation to the very tooling that counts citations, and make 47 modules look evidenced by their own sign-off line. |
| 2026-10-16 | Claude (lane L32) | Status set to **DONE** under the 2026-10-16 status vocabulary (DONE / MAPPED / CLAIMED-NO-CODE / DRAFT; Overwatch GO). Was "DONE". Code and Tests rows added; the capability status check in CI reads them. ManualVerification unchanged. |
