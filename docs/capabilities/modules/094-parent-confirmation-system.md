# Module 094 — Parent Confirmation System

| Field | Value |
|-------|-------|
| Status | **DRAFT** (code exists; see Implementation notes and audit log) |
| Active | false |
| Promotion required | true |
| Category | At-Home / Parent / Guardian (`atHomeParentGuardian`) |
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
Checked against code 2026-09-28. A parent can confirm their own child's class
registration: the `parent_review_registration` action of POST
`/api/pilot/scheduler` (`apps/web/app/api/pilot/scheduler/route.ts`) admits a
parent or organization admin, checks a parent's access to that athlete, and
sets `parent_reviewed` / `parent_reviewed_at` on `pilot.scheduler_registrations`
(markSchedulerRegistrationReviewed in `apps/web/src/server/pilot/schedulerDb.ts`).
The `/schedule` page shows a "Mark Parent Reviewed" button for it. That this is
what "parent confirmation" means (event/session RSVP) is recorded as an owner
call of 2026-08-07 only in `docs/CAPABILITY_BUILD_PLAN_2026-08-03.md` (row 94),
not in `docs/current/OWNER_DECISIONS.md`. No test exercises the action's
behaviour; `apps/web/src/design/goldenEraSchedulerScope.test.ts` only checks the
action and its button still exist. Do not mark active until promotion review.

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | scaffold-script | Stub created from PPBF_CAPABILITIES.json |
| 2026-09-28 | Claude (documentation cleanup) | Stub corrected to match the code: it said "Scaffold only" while a parent registration review exists (see Implementation notes). Status left DRAFT, not changed to DONE: a DONE here raises the capability evidence guard's tracker-disagreement count (the 2026-08-03 index, now history, still says DRAFT), and that count may not rise. It would also not meet the playbook's Definition of done: no automated test exercises the action and no live smoke steps are written. Jason's call. |
| 2026-09-29 | Claude (housekeeping round 3) | Stays DRAFT under Jason's answer "11A" (OD-2026-09-29-002 item 11): no automated test exercises the action. The tracker-disagreement check named in the row above was removed the same day, so that reason no longer applies; the missing behaviour test is the reason now. |
