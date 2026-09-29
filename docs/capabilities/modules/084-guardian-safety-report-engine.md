# Module 084 — Guardian Safety Report Engine

| Field | Value |
|-------|-------|
| Status | **DONE** (slice shipped 2026-08-07; marked DONE 2026-09-29, see audit log) |
| Active | false |
| ManualVerification | PENDING_SIGN_OFF |
| Promotion required | true |
| Category | Safety / Recovery / Health (`safetyRecoveryHealth`) |
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
Built 2026-08-07 (`f15bf0bc`, "feat(#84): guardian safety report"); checked
against code 2026-09-28, corrected 2026-09-29. GET `/api/pilot/parent/safety`
(`apps/web/app/api/pilot/parent/safety/route.ts`, guardian role only) and the
page `/parent/safety` (`apps/web/app/parent/safety/page.tsx`) give a guardian,
for each linked child, the active training hold and gate standing in the same
athlete-safe wording the child reads (getGuardianGateSummary in
`apps/web/src/server/pilot/safetyGateMatrix.ts`). Since #799 (`8362cb1a`,
2026-08-28) the route also returns the child's waiver statuses (`waivers`,
route.ts:136), but no screen shows them: #799 changed only the route and its
test, the page's data type has no waivers field (page.tsx:28-33), and the
Parent Hub's safety card reads only the hold and the gates
(`apps/web/components/ParentHub.tsx`, lines 352-360). Showing them is an
owner decision. Safety escalations are left out on purpose. Tests:
`apps/web/app/api/pilot/parent/safety/route.test.ts` (other roles refused, no
hold reason text leaked, waiver status only) and
`apps/web/app/parent/safety/page.test.tsx`. Do not mark active until promotion
review.

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | scaffold-script | Stub created from PPBF_CAPABILITIES.json |
| 2026-09-28 | Claude (documentation cleanup) | Stub corrected to match the code: it said "Scaffold only" while the slice shipped 2026-08-07. Status left DRAFT, not changed to DONE: a DONE here raises the capability evidence guard's tracker-disagreement count (the 2026-08-03 index, now history, still says DRAFT), and that count may not rise. Jason's call. |
| 2026-09-29 | Claude (housekeeping round 3) | Status DRAFT -> DONE. The one reason it was left DRAFT, the tracker-disagreement check, was removed on Jason's answer "11A" (OD-2026-09-29-002). Evidence: route `apps/web/app/api/pilot/parent/safety/route.ts` (guardian role only, requireRole at line 107) and page `apps/web/app/parent/safety/page.tsx`; tests `apps/web/app/api/pilot/parent/safety/route.test.ts` and `apps/web/app/parent/safety/page.test.tsx`, 24 tests, all passing 2026-09-29 (`npx jest app/api/pilot/parent/safety app/parent/safety --ci`). ManualVerification PENDING_SIGN_OFF: built, not yet tried by a person (OD-2026-09-29-002, 9a); it moves to SIGNED_OFF only on Jason's word (see docs/capabilities/SIGN_OFF_WALKTHROUGH.md). Active stays false. |
| 2026-09-29 | Claude (housekeeping round 3) | Implementation notes corrected: they said the page `/parent/safety` gives a guardian the child's waiver statuses. Only the route returns them; no screen shows them (page.tsx:28-33 and :131-178 render the hold and the gates only). Status left DONE: the route and page tests cover what is built. |
