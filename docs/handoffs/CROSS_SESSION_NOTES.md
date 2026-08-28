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

## 2026-08-28 — release lane (correcting the entry below, per this file's stale-note rule)

**Production is NOT four migrations behind. It received `MIGRATION: all` and
the run succeeded.** apply-migrations run `33134522694`, job `98731402084`:
dispatched 01:59:17Z, held at the environment gate, approved and started
11:23:53Z, `Apply Migration` 11:24:30Z–11:25:31Z, conclusion `success`. Its
`Record What Ran` block reads `TARGET: production`, `MIGRATION: all`,
`CONTAINER_APP_NAME: app-ppbf-production`,
`PPBF_EXPECTED_POSTGRES_HOSTNAME: ppbf-pg-195892.postgres.database.azure.com`
— the production host, not `ppbf-pg-staging-7k4m2q`.

So all three discipline FKs and `athlete-development-blocks` ARE on production.
The entry below was written at 14:23Z, after that run had already completed.
The gate delay is how it went wrong: the build lane dispatched to production,
saw it sitting unapproved, stopped, and recorded "none applied" — accurate when
they stopped, false by the time they wrote it. A dispatched production run that
is merely *waiting* is not a run that did nothing; re-read the run before
recording that it did.

**This makes the entry below actively dangerous, not merely stale**: acting on
it means re-applying migrations production already has, or holding a promotion
because production is believed to lack schema it holds.

**The pre-application measurement it asks for can no longer be taken before
the fact** — the FKs are already live. It is still worth taking, and the
harm it guards against did not occur:

- The constraints are `NOT VALID`, so no deployed row was ever scanned.
- Verified against production's own code (`8af06a60`): there is **no runtime
  write path** to `session_scripts`, `drill_library` or `cohort_definitions`.
  `/api/pilot/session-scripts` and `/api/pilot/drill-library` export `GET`
  only; `drillLibraryV3.ts` and `competenceCohorts.ts` contain no writes at
  all; `sessionScriptRuns.ts` writes only `session_script_runs`, which has no
  `discipline` column. No dynamic or bare-table-name SQL either.
- The only writers are the three seed scripts, run by deliberate workflow
  dispatch. Their CSVs carry only `boxing` and `conditioning`, both in the
  seeded registry, and `seed-reference-data.yml` loads `disciplines` first.

So a `23503` on live traffic was not reachable. The measurement still matters
for the next `seed-reference-data` run against production.

**A gap the entry below did not name, and the sharper one:** `pilot.disciplines`
has no seeding migration at all — it is an operator step seeding one
organization per run. A gym created through the app therefore starts with an
EMPTY registry, and once any runtime write path to those three tables exists,
every such write fails for that gym. #760 (merged) makes organization creation
seed the five disciplines. That is the fix; the census in #768 is the
measurement.

`validate constraint` remains run nowhere — that part of the entry below stands.

— release lane. Evidence is the run logs cited above, not this session's memory:
this lane's own prior record also said "staging and production", which was right
about production and would have been believed for the wrong reason.

## 2026-08-28 — branch `claude/training-content-backend-6wymcp-*` (PRs #756, #757, #758)

**Staging's database is four migrations ahead of production.** Applied to
staging only: `session-scripts-discipline-fk`, `drill-library-discipline-fk`,
`cohort-definitions-discipline-fk`, `athlete-development-blocks` (#759's).
Production has none of them and is still on `8af06a60`.

**Production has not been measured, and nothing is queued to measure it.** A
`seed-reference-data` production `disciplines` dry-run was dispatched (run
`33168197120`) and then **cancelled at the owner's direction** — it sat at the
environment gate and never connected, so it read nothing. Whoever takes
production will need to dispatch that measurement themselves. Staging deploy
digest, if promoting:
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
