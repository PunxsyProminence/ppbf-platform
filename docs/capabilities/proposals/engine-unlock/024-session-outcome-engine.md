# Proposal: Engine Unlock Prerequisites — Module 024, Session Outcome Engine

| Field | Value |
|-------|-------|
| Status | PROPOSAL — owner decision required, no code changes |
| Module stub | `docs/capabilities/modules/024-session-outcome-engine.md` (DRAFT, unfilled) |
| Author | claude-session, 2026-08-16 |
| Reads only | `AGENT_KERNEL.md`, module 024 stub, `infra/azure/*.sql` (cited by filename/line below) |

The module 024 stub carries no Intent, no Dependencies, and no Acceptance criteria — it is an
empty scaffold. This proposal derives what an honest "Session Outcome Engine" can and cannot be,
strictly from tables that already exist, and flags where the stub's implied premise
outruns the schema.

---

## (a) What it computes / shows

**Doctrine constraint first, because it governs everything below:** this platform's honesty
doctrine forbids client-computed verdicts, invented scores, and dose scalars. "Session outcome"
sounds like a pass/fail judgment on a session. **No such judgment may exist anywhere in this
module as a system-generated number or label.** The only things this engine may compute or show
are:

1. **Per-attempt make/miss facts, verbatim from `pilot.training_attempts`.**
   For rows where `context_type = 'session'`, the `made` column is *not* a system verdict — it is
   arithmetic already computed by the writing module from `achieved_value` vs. `target_value` and
   `direction` (`at_least`/`at_most`), and constrained in the database so a target-less attempt
   (`target_value is null`) can never carry `made` (`pilot_training_attempts_made_check`,
   `pilot_slice_postgres_training_attempts_migration.sql:50-51`). The engine surfaces this fact,
   grouped by `metric_kind` (`reps`, `time_seconds`, `distance_m`, `load_kg`, `rounds`,
   `hold_seconds`), never pooled across kinds — a make-rate that mixes reps and load-kg is an
   invented composite metric this platform already refuses to build (see the identical refusal
   for `intended_exposure` dose scalars, `pilot_slice_postgres_intervention_protocols_migration.sql:11-16`).
   Attempts with `target_value is null` show as **UNKNOWN — measurement only, no verdict possible**,
   never coerced to a make or a miss.
2. **Coach narrative fields, verbatim and attributed, never scored.** Where a
   `pilot.session_script_runs` row exists for the same delivery
   (`pilot_slice_postgres_session_scripts_migration.sql:133-151`), its `deviation_note`,
   `what_worked`, `what_did_not`, `reset_protocol_used`, and `blocks_completed` display as the
   coach's own words/counts, quoted and attributed — never converted into a rating.
3. **Recorded load, labeled as load, not outcome.** `pilot.activity_log.rpe` (0–10, nullable) ×
   `duration_minutes` (`pilot_slice_postgres_activity_log_migration.sql:42-72`) can be shown as
   session-RPE load when both fields are present for the matching occurrence — labeled "load
   recorded", never "how well the session went."
4. **Human-reviewed intervention learning, only if a review exists.** If the session's delivery
   is also linked as an `intervention_execution` (`session_run_id`,
   `pilot_slice_postgres_intervention_executions_migration.sql:52`) and that execution has an
   **active** `intervention_outcome_reviews` row, the engine may surface its three
   human-entered answers — `performance_result`, `hypothesis_result`, `learning_signal`
   (`pilot_slice_postgres_intervention_evidence_migration.sql:65-102`) — attributed to
   `reviewed_by_account_id` and `reviewed_at`. These are the **only** sanctioned outcome verdicts
   in the schema, and they are structurally human-authored: the table has no computed-score column,
   and a database constraint already forbids a miss from validating a hypothesis
   (`pilot_intervention_reviews_miss_check`, same file, lines 95-97). The engine must never
   compute its own version of this; it may only display an existing one.
5. **Honest misses, never failure framing.** A miss (`made = false`, or `performance_result` in
   `declined`/`unchanged`) renders as recorded fact — "target not met, here is where the edge sat" —
   never as a red X, a failure badge, or shame copy. This mirrors the `training_attempts` migration's
   own stated design principle: a failed attempt is the most informative row, not an error state
   (`pilot_slice_postgres_training_attempts_migration.sql:1-11`).

**Explicit UNKNOWN states required:** no targeted attempts recorded yet; targeted attempts exist
but no coach narrative recorded; an intervention execution exists but has no active outcome
review yet ("not yet reviewed" — distinct from "reviewed and inconclusive", which is its own
valid `hypothesis_result` of `unresolved`/`insufficient_evidence`/`confounded`).

**What this module must never render:** a single "session score"; a 1–5 or percentage grade; a
pass/fail badge; any pooled make-rate across `metric_kind`s; any comparison to another athlete's
session; any streak, level, badge, or reward copy.

---

## (b) Data prerequisites

Checked per athlete and per organization, against real columns only.

### Athlete level (their own record)

| # | Prerequisite | Table.column | Check |
|---|---|---|---|
| 1 | At least **5** verdict-eligible attempts | `pilot.training_attempts` | `count(*) where organization_id=$org and athlete_id=$athlete and context_type='session' and target_value is not null` ≥ 5 |
| 2 | Spanning at least **2 distinct occurrences**, not one burst | `pilot.training_attempts.context_id` or, absent that, `attempted_at::date` | `count(distinct coalesce(context_id, attempted_at::date::text))` ≥ 2 |
| 3 | Spanning at least **7 calendar days** | `pilot.training_attempts.attempted_at` | `max(attempted_at) - min(attempted_at)` ≥ 7 days |
| 4 | Every counted attempt recorded by staff, not self | `pilot.training_attempts.recorded_by_account_id` | joined to `pilot.accounts` role — **schema does not currently restrict this column to any role**; see Open Question 3 |

All four are mechanically checkable today with one query per athlete. None require a new column.

### Organization level

| # | Prerequisite | Check |
|---|---|---|
| 1 | At least **5 distinct athletes** in the org individually meet the athlete-level prerequisite above (small-cell suppression floor — an org-level view built on fewer named athletes is de-facto individual data) | count of athlete_ids passing the athlete-level test ≥ 5 |
| 2 | Org-level make/miss rollups are computed **per `metric_kind`**, never pooled | structural rule, not a count |
| 3 | Any org rollup is an aggregate count/rate only — **no per-athlete row, name, or rank may appear** in the org view | structural rule enforced by the query shape (aggregate `GROUP BY metric_kind`, never `GROUP BY athlete_id`) |

### Hard schema gap that blocks a clean prerequisite check

`pilot.training_attempts.context_id` (`context_type='session'`) is `text null` with **no foreign
key** to anything (`pilot_slice_postgres_training_attempts_migration.sql:33`). Meanwhile the
schema holds **three independent "session" shaped tables with no FK between any of them**:

- `pilot.sessions` (`organization_id, session_id, athlete_id, date, rpe, notes, completed_flag`,
  `pilot_slice_postgres.sql:91-103`) — one row per athlete per session, the oldest concept, the one
  `pilot.coach_reviews` references (`pilot_coach_reviews_session_fk`, same file, line 116).
- `pilot.session_script_runs` (`organization_id, run_id, script_id, delivered_on,
  athletes_present, blocks_completed, ...`, `pilot_slice_postgres_session_scripts_migration.sql:133-151`)
  — one row per *delivery* of a script to a group, the newer minute-by-minute layer.
- `pilot.training_attempts.context_id` — free text, populated by whichever writing module wrote
  the attempt, with no constraint tying it to either of the above.

There is no query that can reliably answer "which `pilot.sessions` row, or which
`session_script_runs` row, does this `training_attempts.context_id` refer to" unless the writing
UI already disciplines itself to write one specific identifier there — and nothing in the
database enforces that discipline. **This is the single hardest data prerequisite for this
module, and it is not a data-volume problem — it is a missing foreign key / missing canonical
"session" decision.** See Open Question 1.

---

## (c) Locked state

Before an athlete or an org clears the counts in (b), the engine shows only real, checkable
progress toward those counts — never a preview, sample chart, or placeholder number:

- **Athlete locked view:** *"Session outcomes are not shown yet. N of 5 targeted attempts
  recorded (need target + achieved values to compare). Earliest recorded: [date or 'none yet'].
  Span so far: N days (need 7)."* All numbers are live counts against the athlete's own
  `training_attempts` rows — no fabricated trend line, no grayed-out chart with fake data.
- **Org locked view:** *"N of 5 athletes have enough recorded data to include in an organization
  view. Per-athlete detail is never shown here regardless of unlock state — only the org
  threshold count."*
- If prerequisite counts are met but the `context_id` linkage gap (above) means sessions cannot
  be grouped reliably, the engine states that explicitly — *"Attempts are recorded but cannot yet
  be grouped by session"* — rather than silently grouping by date as a guess and presenting it as
  fact.

No countdown, streak, badge, or "almost there!" copy — these are minors on a platform whose
doctrine forbids variable-reward and FOMO mechanics. The locked state is an honest status report,
not a hook.

---

## (d) What unlocks

### Athlete level — their own record ONLY

- A per-`metric_kind` time series of their own targeted attempts: made / missed / (no-target)
  counts and the raw achieved-vs-target values, over time, from `pilot.training_attempts`.
- Coach narrative (`session_script_runs.what_worked` / `what_did_not` / `deviation_note`) attached
  to the same occurrence, quoted and attributed to the delivering coach.
- Any **active, human-reviewed** `intervention_outcome_reviews` result tied to their own
  `intervention_executions`, shown as the coach's/reviewer's stated conclusion, never restated as
  a system score.
- Recorded session load (`activity_log.rpe` × `duration_minutes`) when present, labeled as load.
- **Forbidden absolutely:** any other athlete's data, any rank, percentile, average-vs-peers,
  leaderboard, or team roster comparison. The module boundary already states this
  (`does not expose athlete-level data to board/public aggregates without suppression rules`) and
  this proposal extends it to forbid cross-athlete comparison at the athlete-facing surface
  entirely, not just at the board/public surface.

### Org level

- Aggregate, per-`metric_kind` make/miss rates across all athletes who individually clear the
  athlete-level prerequisite, suppressed below the 5-athlete floor.
- A count of how many athletes/sessions have reviewed intervention outcomes vs. unreviewed, by
  `learning_signal` category (aggregate counts only, e.g. "3 boundary conditions discovered this
  month across the org" — never which athlete).
- **Forbidden absolutely:** any per-athlete row, name, or identifiable subgroup below the
  suppression floor; any ranking of athletes or of coaches; any "top performer" framing.

### Coach confirmation gate — required before anything reaches an athlete

`pilot.coach_reviews` (`organization_id, review_id, session_id, coach_id, decision, notes,
approved_flag`, `pilot_slice_postgres.sql:105-116`) already exists as exactly this kind of gate
for `pilot.sessions` rows, and it is the pattern this module must reuse, not reinvent: **an
athlete-facing session outcome view must not render for a given session until a `coach_reviews`
row for that `session_id` exists with `approved_flag = true`.** Absent a matching review, the
athlete view shows UNKNOWN ("not yet reviewed by your coach"), not the raw attempt data.

This gate has a real gap today, not just a design choice: `coach_reviews.session_id` is
foreign-keyed only to `pilot.sessions`, and (per the section above) there is no guaranteed link
from a `training_attempts.context_id` to a `pilot.sessions.session_id`. Until the canonical
"session" question (Open Question 1) is resolved, this gate cannot be wired end-to-end — it can
only be honestly implemented once attempts, coach review, and the athlete-facing view all agree
on what a "session" is. Building the athlete-facing unlock before that resolution would mean
either skipping the gate (unsafe) or gating on the wrong table (silently broken).

---

## (e) Open questions for the owner

**1. What is the canonical "session" for this engine, given three unlinked candidate tables?**
`pilot.sessions` (old, per-athlete, has the existing `coach_reviews` gate), `pilot.session_script_runs`
(newer, per-delivery, has the coach narrative fields this module wants to show), or
`training_attempts.context_id` treated as its own free-text key (weakest, no FK, no coach-review
attachment today).
- (a) Make `session_script_runs.run_id` the canonical session key; add a real FK from
  `training_attempts.context_id` to it when `context_type='session'`, and extend
  `coach_reviews` (or an equivalent) to reference `session_script_runs` instead of/alongside
  `pilot.sessions`.
- (b) Make `pilot.sessions.session_id` canonical (reuses the existing `coach_reviews` gate
  as-is); add the FK from `training_attempts.context_id` to `pilot.sessions` instead.
- (c) Treat `context_id` as already-authoritative free text and require the writing UI (not the
  database) to discipline it — fastest to ship, weakest guarantee, no enforced integrity.
- (d) Do not build session-level grouping at all yet; ship only per-attempt and per-metric views
  until a canonical session entity is decided elsewhere in the roadmap.

**2. What are the exact prerequisite thresholds?** This proposal recommends 5 verdict-eligible
attempts / 2 distinct occurrences / 7-day span per athlete, and a 5-athlete suppression floor at
org level, as defensible defaults — but these are policy choices, not derivable from the schema.
- (a) Adopt the defaults above as-is.
- (b) Raise them (e.g., 10 attempts / 14-day span) to bias toward fewer false trends.
- (c) Lower them (e.g., 3 attempts / no minimum span) to bias toward showing data sooner.
- (d) Different thresholds per `metric_kind` (a `hold_seconds` test and a `load_kg` test may not
  need the same sample size to be honest).

**3. Should `training_attempts` rows count toward unlock only when staff-recorded?**
`recorded_by_account_id` has no role restriction in the schema — a self-recorded attempt and a
coach-recorded one are indistinguishable today by any column on this table.
- (a) Require a join to `pilot.accounts` confirming a staff role (`coach`/`organization_admin`/`admin`)
  for a row to count; self-recorded rows are visible to the athlete but excluded from unlock math.
- (b) Any recorder counts, no restriction.
- (c) Add a `recorded_by_role` column (mirroring `activity_log.recorded_by_role`, which already
  does this) as a prerequisite fix before this module ships.

**4. Should the coach-confirmation gate (Open Question 1's resolution) block the *entire*
athlete-facing view per session, or only the *narrative/verdict* parts, leaving raw make/miss
counts visible immediately since they are arithmetic, not judgment?**
- (a) Gate everything per session behind `approved_flag = true` — simplest, most conservative.
- (b) Show raw make/miss facts immediately (they are deterministic arithmetic already computed
  and stored, not a verdict); gate only coach narrative and any linked intervention-review
  content behind approval.
- (c) No gate at all — treat all fields here as already-safe recorded facts. (Not recommended:
  this reads against the module boundary's own language about staff review before athlete
  exposure, and against the intent of `coach_reviews` existing at all.)
