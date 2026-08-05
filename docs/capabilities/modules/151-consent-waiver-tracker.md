# Module 151 — Consent / Waiver Tracker

| Field | Value |
|-------|-------|
| Status | **DONE** |
| Active | false |
| ManualVerification | PENDING_SIGN_OFF |
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
- [ ] ManualVerification=PASSED

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | wave-ps | DONE; 152 started |
| 2026-08-03 | vscode | Restored Intent/Boundaries/Vertical slice/Checklist, which the DONE write had overwritten. PENDING_SIGN_OFF refers to the checklist above; without it nobody could sign off. |
