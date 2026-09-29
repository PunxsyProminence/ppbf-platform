# Module 084 — Guardian Safety Report Engine

| Field | Value |
|-------|-------|
| Status | **DRAFT** (code shipped 2026-08-07; see Implementation notes and audit log) |
| Active | false |
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
against code 2026-09-28. GET `/api/pilot/parent/safety`
(`apps/web/app/api/pilot/parent/safety/route.ts`, guardian role only) and the
page `/parent/safety` (`apps/web/app/parent/safety/page.tsx`) give a guardian,
for each linked child, the active training hold and gate standing in the same
athlete-safe wording the child reads (getGuardianGateSummary in
`apps/web/src/server/pilot/safetyGateMatrix.ts`), plus, since #799 (`8362cb1a`,
2026-08-28), the child's waiver statuses. Safety escalations are left out on purpose. Tests:
`apps/web/app/api/pilot/parent/safety/route.test.ts` (other roles refused, no
hold reason text leaked, waiver status only) and
`apps/web/app/parent/safety/page.test.tsx`. Do not mark active until promotion
review.

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | scaffold-script | Stub created from PPBF_CAPABILITIES.json |
| 2026-09-28 | Claude (documentation cleanup) | Stub corrected to match the code: it said "Scaffold only" while the slice shipped 2026-08-07. Status left DRAFT, not changed to DONE: a DONE here raises the capability evidence guard's tracker-disagreement count (the 2026-08-03 index, now history, still says DRAFT), and that count may not rise. Jason's call. |
