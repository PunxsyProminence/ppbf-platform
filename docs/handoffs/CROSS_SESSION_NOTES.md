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

## 2026-08-28 — training-content build lane (RETRACTION + production applied)

**RETRACTING a claim in the entry below.** It said the `all` chain on staging
"ran with the repaired readiness gate in it -- the defect reproduced and fixed
in the environment where it would actually have blocked a dispatch". **That is
not supported by the runs cited**, and the error was caught by the Codex review
bot on #818, not by me.

Why it is wrong: in the `all` loop, `athlete-check-ins` sits at position 86 and
`athlete-check-in-measures` at 113. So within run `33199537359`, the
athlete-check-ins readiness gate was evaluated BEFORE the measures migration
widened the table in that same run -- it counted three constraints and passed,
which the OLD broken gate would have done too. Run `33201656557` targeted only
the measures migration and never invoked that gate at all. Neither run
exercised the repaired gate against a widened table.

The FIX is still correct and still tested: `athleteCheckInMeasures.pg.test.ts`
applies both migrations and then runs the query read out of the shipped runner,
which is a real reproduction. What was wrong was the claim about STAGING
evidence, not the fix.

The distinction matters beyond this note. Both errors in this file today are the
same error: **citing evidence that tests a proxy for the property rather than
the property.** A run that passed is not a run that exercised the thing you
changed.

**Production now HAS the migration.** Run `33202193898`, 19:08Z,
`MIGRATION: athlete-check-in-measures` / `TARGET: production`, head `75cf8bc1`,
host `ppbf-pg-195892`, database `postgres` -- succeeded. Read from the run's own
environment block, not inferred. This supersedes the "believed unapplied" line
below, which was accurate when written.

**The gate IS now proven against a widened table, by a run dispatched for that
purpose.** Run `33202463204`, 19:08Z, `MIGRATION: athlete-check-ins` /
`TARGET: staging`, head `75cf8bc1`, host `ppbf-pg-staging-7k4m2q`, database
`ppbf_staging` -- succeeded. Staging carries all eight 1-5 constraints by then,
so this run evaluated the gate against the widened table: the pre-#802 gate
counted every such constraint and demanded exactly three, so it would have seen
eight and thrown ATHLETE_CHECK_INS_NOT_READY. This is the evidence the retracted
claim needed and did not have. It was produced by targeting the OTHER migration
on purpose, which is the whole point -- the gate belongs to athlete-check-ins,
so only a run that invokes THAT runner can exercise it.

**Note for whoever runs `all` next:** it will exercise the same gate the same
way. If it throws ATHLETE_CHECK_INS_NOT_READY, the fix did not deploy -- check
the ref the workflow was dispatched against, not the migration.

— training-content build lane.

---

## 2026-08-28 — training-content build lane (correcting the entry below, per this file's stale-note rule)

**"Applied NOWHERE" is stale for staging.** It was true when written and stopped
being true about a minute later. `athlete-check-in-measures` IS applied to
staging:

- run `33199537359`, 18:29Z, `MIGRATION: all` / `TARGET: staging`, head
  `98eb3ae1` — the release lane's own `all` dispatch, which carried this
  migration along with everything else. Succeeded.
- run `33201656557`, 18:58Z, `MIGRATION: athlete-check-in-measures` /
  `TARGET: staging`, head `ee5ca8a7` — this lane, re-applying at the owner's
  direction before the overlap was noticed. Also succeeded; its Apply step took
  **one second**, which is what convergence over an already-migrated database
  looks like rather than a create.

**Production is still believed unapplied, and that is an inference, not a read.**
The most recent `all` against production this lane can point to is run
`33089360578` (2026-08-27), which predates this migration. Nobody has queried
production's schema. Treat it as unapplied until someone does.

**Two things this accidentally proved, worth keeping.** The `all` chain ran
against real staging Postgres and passed WITH the repaired
`pilot-apply-athlete-check-ins-migration.mjs` readiness gate in it — the defect
described below reproduced and fixed in the environment where it would actually
have blocked a dispatch, which is stronger than the local embedded-Postgres
evidence the fix originally shipped with. And idempotency here is now
demonstrated rather than assumed.

— training-content build lane.

---

## 2026-08-28 — training-content build lane (#802, #809, #810 merged)

**A migration is merged and applied NOWHERE. `athlete-check-in-measures`**
(#802, main `52991b08`) adds six columns to `pilot.athlete_check_ins`:
`sleep_hours`, `hydration`, `motivation`, `mental_clarity`, `stress`,
`nutrition_compliance`. It is registered on every surface and sits after
`athlete-check-ins` in the `all` chain, but no `apply-migrations` dispatch has
run since it merged, so those columns do not exist in staging or production.

**#810 (main `98eb3ae1`) is the UI that writes them.** Merging it to main was
safe; it reaching a deployed environment ahead of the migration is not — the
athlete Wellness tab would POST fields the table cannot accept. Sequence the
migration before the next deploy that carries `98eb3ae1`.

**A defect this lane fixed, worth knowing if you touch that table.** Adding
those columns broke the PREVIOUS migration's runner:
`pilot-apply-athlete-check-ins-migration.mjs` counted every single-column 1-5
CHECK on the table and demanded exactly three, which silently also meant "and
no other column here is bounded 1-5". Eight constraints made it throw
`ATHLETE_CHECK_INS_NOT_READY` against a correct schema, inside the `all` chain
— a blocked dispatch, not just a red suite. The gate now names its three
columns. The owner's growth model for this table is one migration per measure
decided, so **the next measure migration will not re-trip it, but check the
readiness query of anything else that counts constraints on a table you widen.**

**Deferred by owner decision, not forgotten:** resting heart rate, HRV and
blood pressure. They are biometric readings on minors — a different data class
from a wellness self-report — and were parked pending consent and retention
answers. `docs/design/CHECKIN_API_CONTRACT.md` records this.

**Two findings raised to the owner, unactioned, needing a decision:**
- `/api/pilot/floor-hours/public` is UNAUTHENTICATED and applies no cohort
  floor, returning `distinct_participants` alongside first/last dates.
  Authenticated board members get everything below
  `BOARD_MINIMUM_COHORT_SIZE = 5` suppressed. The public path is more exposed
  than the governance one.
- `/api/pilot/shadow/data` (self-service export/delete) is built and gated but
  reachable from no UI.

**Scoping result available:** 48 of 248 routes under `app/api/pilot/` have no
UI consumer; 13 are referenced by nothing at all, not even a test. #809 closed
three of them (the board aggregates). Triage of the rest — several look like
drift to delete rather than gaps to fill, including three surplus role-scoped
chat endpoints and four by-id/CRUD splits — was in progress at time of writing.

— training-content build lane.

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
