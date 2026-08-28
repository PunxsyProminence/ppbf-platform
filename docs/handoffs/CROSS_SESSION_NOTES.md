# Cross-session notes

An append-only running log for the many parallel AI sessions working this
repo. Use it for things that aren't visible from `main`/open PRs alone:
active-work claims, discovered conflicts between branches, warnings, or
questions for whichever session picks up an area next. See
`docs/handoffs/README.md` for how this differs from the directed
`HANDOFF_*.md` briefs also in this directory, and see `docs/AI_COLLABORATION.md`
for the underlying doctrine — this file supplements that doctrine, it does
not replace it.

**Convention:**
- **Newest entries at the top.**
- Each entry dated, and signed with the branch and/or PR it corresponds to
  when known.
- Keep entries terse — a coordination signal for another session to skim in
  seconds, not a report. Link to the PR/audit/file that has the detail
  instead of restating it here.
- Append; don't rewrite other sessions' entries. If a note goes stale, add a
  new dated line saying so rather than editing the old one.

---

## 2026-08-28 — branch `claude/training-content-backend-6wymcp-*` (PRs #756, #757, #758)

**Staging's database is four migrations ahead of production.** Applied to
staging only: `session-scripts-discipline-fk`, `drill-library-discipline-fk`,
`cohort-definitions-discipline-fk`, `athlete-development-blocks` (#759's).
Production has none of them and is still on `8af06a60`.

**A production run is parked at the environment gate:** actions run
`33168197120` — `seed-reference-data`, production, `disciplines`, **dry-run**
(writes nothing; inserts in a transaction and rolls back). Approve it or
cancel it; don't leave it sitting. Staging deploy digest, if promoting:
`sha256:83adbe8db0e7ff432a3e591ac0908bf743a78270a192ff242304d0925241bf51`
(deploy-staging run 33167311808, `aceea64c`, SHADOW gate PASS).

**Measure `pilot.disciplines` on production before applying any of the three
discipline FKs.** They are `NOT VALID`, so deployed rows are never scanned —
but the constraint is live for NEW writes immediately. If production's registry
lacks a discipline its rows use, new writes to `session_scripts`,
`drill_library` and `cohort_definitions` start failing `23503`. Staging
measured `5 already present` before anything was applied; production's only
record is 2026-08-24 loader output, not a read of the table. That is what run
`33168197120` exists to answer.

**`validate constraint` has been run nowhere, deliberately.** It is in no
migration, no runner and no workflow — only named in each migration header, for
whoever measures the rows first. It is the statement that can fail on live data.

— build lane, handing production to the release lane at owner's direction.

## 2026-08-17/18 — branch `claude/app-audit-ux-ui-report-78o4cm` (PR #456)

Produced `docs/PLATFORM_AUDIT_2026-08-17_FULL_SPECTRUM.md`, a full-spectrum
platform audit (routes, backend wiring, SHADOW AI, forms, docs/governance).
PR #456 also lands three small fixes alongside it: an inert entry in the
privacy denylist (`privacyTiers.ts`), four stale docs corrected to match
current source, plus three bounded fixes picked up from a separate,
concurrent capability-network audit — the `/admin/escalations` `Source`
column rendering blank for newer safety-escalation source types, a
login-outage test that never actually simulated an outage, and a
`coachIntelligence.ts` comparison-operator mismatch between
`fading_attendance` and `training_days_dropping` that disagreed at the
exact-half boundary. Full detail, including a fourth finding that was
escalated rather than fixed (unvalidated `parent_id` on guardian links), is
in that audit's §13 addendum — read that before re-deriving any of this.

**Two live conflicts flagged for whoever next touches these areas:**
- **PR #447**'s compliance-auto-escalation item contradicts already-merged
  **#440**, which deliberately declined that behavior. Do not merge #447 as
  written without reconciling that first.
- Two competing fixes exist for the Coach Intelligence safety-register blind
  spot — **#450** and a separate unmerged branch. These need to be
  reconciled into one, not both landed.

**Process note:** this branch merged `origin/main`'s tip before finalizing,
specifically to pick up **#451** (fix for an exhaustive `Record<Union, …>`
typecheck break that hit three unrelated PRs the same day — a union grew on
one branch while its exhaustive map grew on another, invisible to any single
branch's CI). Worth doing before every push right now, given how easily that
class of break recurs while several branches are touching the same union
types in parallel.
