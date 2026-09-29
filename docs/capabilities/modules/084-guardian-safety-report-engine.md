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
route.ts:187). Since 2026-09-29 (OD-2026-09-29-003, Jason: "all recommended",
question 4 answer A) the page shows them for each child under "Waivers"
(page.tsx:255): the four tracked types (General, Medical release, Photo &
media, Travel), each with a glyph and an uppercase label -- Signed ✓;
Declined, Withdrawn or Missing ▲; Unknown ◌ for any value outside that
vocabulary, and for a tracked type the response leaves out. A type the route
returns beyond the four is listed under its own name rather than dropped.
General, Medical release and Travel are the newest row for the type
(getAthleteWaiverStatus, the reading the competition gate uses). Photo & media
is read through the media consent check that media approval and
`/parent/consent` use (checkGuardianMediaConsent in
`apps/web/src/server/pilot/guardianConsent.ts`; route.ts:112-128): Signed only
when every guardian linked to the child has their own latest photo_media row
signed; otherwise this guardian's own Withdrawn or Declined, else Missing. A
row with no guardian on it (a paper form entered at `/admin/consent`) does not
count, as in the gate. The header names the four tracked types, says Photo &
media is signed or withdrawn on `/parent/consent`, and keeps "the same
information your child can see" to the hold and the checks: no athlete screen
shows waivers. Production's waiver rows are all type `program_consent`
(OD-2026-09-29-002 item 8a, REPORTED), which the route does not read, so there
every child reads Missing on all four until rows of these types exist
(INFERRED). The Parent Hub's safety card still reads only the hold and the
gates (`apps/web/components/ParentHub.tsx`, lines 352-360). Safety escalations
are left out on purpose. Tests:
`apps/web/app/api/pilot/parent/safety/route.test.ts` (other roles refused, no
hold reason text leaked, waiver status only; Photo & media follows the consent
check, so a staff-entered form with no guardian on it, or one of two
guardians signed, does not read Signed) and
`apps/web/app/parent/safety/page.test.tsx` (hold, gates, header wording, and
the waiver list: Missing reads Missing and never Signed; unrecognised or
absent values read Unknown). Do not mark active until promotion review.

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | scaffold-script | Stub created from PPBF_CAPABILITIES.json |
| 2026-09-28 | Claude (documentation cleanup) | Stub corrected to match the code: it said "Scaffold only" while the slice shipped 2026-08-07. Status left DRAFT, not changed to DONE: a DONE here raises the capability evidence guard's tracker-disagreement count (the 2026-08-03 index, now history, still says DRAFT), and that count may not rise. Jason's call. |
| 2026-09-29 | Claude (housekeeping round 3) | Status DRAFT -> DONE. The one reason it was left DRAFT, the tracker-disagreement check, was removed on Jason's answer "11A" (OD-2026-09-29-002). Evidence: route `apps/web/app/api/pilot/parent/safety/route.ts` (guardian role only, requireRole at line 107) and page `apps/web/app/parent/safety/page.tsx`; tests `apps/web/app/api/pilot/parent/safety/route.test.ts` and `apps/web/app/parent/safety/page.test.tsx`, 24 tests, all passing 2026-09-29 (`npx jest app/api/pilot/parent/safety app/parent/safety --ci`). ManualVerification PENDING_SIGN_OFF: built, not yet tried by a person (OD-2026-09-29-002, 9a); it moves to SIGNED_OFF only on Jason's word (see docs/capabilities/SIGN_OFF_WALKTHROUGH.md). Active stays false. |
| 2026-09-29 | Claude (housekeeping round 3) | Implementation notes corrected: they said the page `/parent/safety` gives a guardian the child's waiver statuses. Only the route returns them; no screen shows them (page.tsx:28-33 and :131-178 render the hold and the gates only). Status left DONE: the route and page tests cover what is built. |
| 2026-09-29 | Claude (parent waivers) | The page now shows the waiver statuses the route returns (OD-2026-09-29-003, Jason: "all recommended", question 4 answer A). Change: `apps/web/app/parent/safety/page.tsx` and its test; and the route now reads photo_media through checkGuardianMediaConsent, because the newest row from anyone let the page read Signed while `/parent/consent` read "Consent needed" and media approval refused (review finding, read in code, not run). Tests: `npx jest app/api/pilot/parent/safety app/parent/safety --ci`, 42 passing 2026-09-29. ManualVerification stays PENDING_SIGN_OFF: not yet seen on a signed-in screen (UNVERIFIED). |
