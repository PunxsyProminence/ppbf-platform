# Engine Unlock Proposal — Module 017: Athleticism Engine

| Field | Value |
|-------|-------|
| Status | PROPOSAL (owner approval requested) — no code changes made |
| Module stub | `docs/capabilities/modules/017-athleticism-engine.md` |
| Category | Physical Training System (`physicalTrainingSystem`) |
| Prepared against | current `infra/azure/*.sql` schema, read-only |

This document proposes the honesty gate that must be satisfied before Module 017
is allowed to compute or display anything to a user. It does not propose an
implementation, a UI, or an API. Nothing here is authorization to build; it is
the basis for an owner decision on what the module may and may not do.

---

## Schema reality check (read first)

The module stub's name — "Athleticism Engine" — is exactly the kind of name
that invites a single invented composite score ("athleticism index: 78/100").
**The schema has no table, column, or view that represents "athleticism" as a
measured quantity, and none should be added to serve this module.** There is
no `athleticism_score`, no composite index, and no weighting table anywhere in
`infra/azure/*.sql`. What exists instead is:

- `pilot.training_attempts` — one row per attempt at a concrete, directional
  metric (`metric_kind` in `reps`, `time_seconds`, `distance_m`, `load_kg`,
  `rounds`, `hold_seconds`), with an explicit `made`/failed verdict only when
  a `target_value` was set (`pilot_training_attempts_made_check` enforces
  `(target_value is null) = (made is null)` — an untargeted attempt is a
  measurement, not a verdict).
- `pilot.assessments` (extended by `pilot_slice_postgres_assessment_protocols_migration.sql`)
  — administered results (`result` jsonb) against a named
  `pilot.assessment_protocols` catalog entry, where `measure_kind` includes
  `physical_test`. Every protocol row carries `reliability_status` (default
  `'UNVALIDATED - PPBF MUST ESTABLISH'`), `validity_status` (default
  `'UNKNOWN'`), and `evidence_class` (default `'INSUFFICIENT EVIDENCE'`) —
  the schema itself refuses to assume a physical test means what it claims
  to measure until a human establishes that.
- `pilot.readiness` — `score numeric`, `category text`, `measured_at` — a
  single self-report-style readiness reading, not a physical-quality test.
- `pilot.activity_log` — `duration_minutes`, `rpe`, `activity_domain` —
  training-dose context (hours on the floor), not an outcome measure.
- `pilot.intervention_protocols` / `intervention_executions` /
  `intervention_evidence_links` / `intervention_outcome_reviews` — the
  keystone ledger that can *link* a `training_attempt`, `readiness`,
  `assessment`, `film_study`, or `activity_log` row as evidence for or
  against a specific coaching hypothesis, with human-only outcome review
  (`reviewed_by_account_id` required; nothing computes a verdict).

**Conclusion:** Module 017 cannot be a scoring engine. It can only be an
honest, per-athlete, per-metric *view* of attempts and physical-test results
that already exist in these tables, organized by `metric_kind` /
`assessment_protocols.name`, never combined across metrics into one number.
If the owner wants a single "how athletic is this kid" number, the schema
does not support it and none should be built — that request should be
declined, not routed around.

---

## (a) What it computes / shows

Everything the engine shows is a direct read or a simple, fully-attributed
aggregation (count, min/max, latest-vs-earliest, elapsed time) of rows the
athlete's own coaches already recorded. Nothing is weighted, normalized,
combined across `metric_kind`/protocol, or expressed as a percentile,
grade, or index.

**Shown, unlocked:**
- Per `metric_kind` (reps / time_seconds / distance_m / load_kg / rounds /
  hold_seconds) from `pilot.training_attempts`: the athlete's own
  `achieved_value` history over time (`attempted_at`), each attempt's
  `direction`/`target_value`/`made` verdict exactly as recorded, and the
  `context_type` it came from (`session`, `drill_assignment`, `assessment`,
  `film_study`, `open_floor`).
- Per active `pilot.assessment_protocols` row with `measure_kind =
  'physical_test'`: the athlete's own `pilot.assessments.result` values in
  administration order (`administered_on`), with `retest_of_assessment_id`
  chains shown as chains, not flattened.
- The protocol's own stated `reliability_status`, `validity_status`,
  `evidence_class`, and `boxing_specific` fields displayed alongside every
  result from that protocol — verbatim, not summarized away. A result from
  an `UNVALIDATED` protocol is labeled as such every time it is shown, not
  once in a footnote.
- Elapsed time and attempt/administration counts actually stored (e.g.
  "14 recorded attempts over 61 days"), never a rate the schema doesn't
  store (no derived "improvement rate" unless it is a plain difference
  between two real recorded values with both dates shown).

**Never shown, at any unlock state:**
- A single "athleticism score," index, grade, tier, or percentile.
- Any cross-metric or cross-protocol composite (no averaging reps-based and
  time-based metrics into anything).
- Any cross-athlete comparison, rank, or leaderboard, at any role level.
- Any number not traceable to a specific row's real column value.

**Explicit UNKNOWN states:**
- A `metric_kind` with zero rows: shown as "No data recorded" — not zero,
  not a blank chart.
- An assessment protocol with `reliability_status` still at its unvalidated
  default: results are shown (they are real observations) but flagged
  `MEASUREMENT PROPERTIES NOT ESTABLISHED` — never silently treated as
  precise.
- An attempt with `target_value is null`: shown as a measurement only,
  never coerced into a make/miss the row itself does not carry
  (`made` stays null; the UI must not infer one).
- Any `activity_log` gap (no `boxing_training` rows between two
  assessments): shown as "no recorded training-dose context for this
  interval," since `training_hours_at_administration` on the assessment
  row may itself be null.

---

## (b) Data prerequisites

All thresholds below are counts/spans of *real, already-defined* columns.
No new column is proposed. Per-athlete and per-org gates are separate and
both must hold — an org can have plenty of data concentrated in one athlete
and still not have earned org-wide activation.

### Per athlete (unlocks that athlete's own richer view)

| # | Requirement | Real source |
|---|---|---|
| 1 | ≥ 12 `pilot.training_attempts` rows for the athlete, `achieved_value` non-null (always true by constraint), spanning ≥ 2 distinct `metric_kind` values | `training_attempts.athlete_id`, `.metric_kind`, `.achieved_value` |
| 2 | Of those, ≥ 8 rows carry a non-null `target_value` (i.e., carry a real `made`/failed verdict, not just a measurement) | `training_attempts.target_value`, `.made` (paired by `pilot_training_attempts_made_check`) |
| 3 | The attempts in (1) span ≥ 42 calendar days between `min(attempted_at)` and `max(attempted_at)` | `training_attempts.attempted_at` |
| 4 | ≥ 2 `pilot.assessments` rows with `administered_on is not null` and `protocol_id` referencing a `pilot.assessment_protocols` row where `measure_kind = 'physical_test'`, for the *same* `protocol_id`/`name` (a baseline and at least one retest — a single snapshot has no trend to show) | `assessments.administered_on`, `.protocol_id`; `assessment_protocols.measure_kind` |
| 5 | The two assessments in (4) satisfy the protocol's own stated retest interval where one is set (`retest_interval_days` elapsed, or `retest_after_training_hours` accumulated per `training_hours_at_administration`) — a retest taken sooner is measurement noise per the migration's own comment ("re-testing CMJ every two weeks produces measurement error that reads as improvement") and must not be presented as a trend | `assessment_protocols.retest_interval_days`, `.retest_after_training_hours`; `assessments.training_hours_at_administration` |

Requirement 4/5 is the hardest one in practice: it depends on a coach or
assessor actually re-administering a *named, cataloged* physical test on
the *same athlete* at a defensible interval, which requires an org to have
first populated `pilot.assessment_protocols` at all (see org prerequisite
1 below) — most orgs starting from zero will clear (1)-(3) from ordinary
floor logging long before they clear (4)-(5).

### Per organization (unlocks org-level aggregate view)

| # | Requirement | Real source |
|---|---|---|
| 1 | ≥ 1 active (`active = true`) row in `pilot.assessment_protocols` with `measure_kind = 'physical_test'` — the org must have defined what it is even testing before any aggregate view is meaningful | `assessment_protocols.measure_kind`, `.active` |
| 2 | ≥ 5 distinct `athlete_id` values in the org each independently satisfy the full per-athlete gate above (deliberately not "5 rows total" — this prevents one heavily-tested athlete from unlocking an org-wide view built on N=1) | `training_attempts.athlete_id`, `assessments.athlete_id` grouped by `organization_id` |
| 3 | The org has ≥ 1 `pilot.activity_log` row with `activity_domain = 'boxing_training'` for each qualifying athlete, so aggregate views can show training-dose context rather than results with no denominator | `activity_log.activity_domain`, `.athlete_id`, `.organization_id` |

Requirement 2's minimum-N-of-5 exists only to make small-group
re-identification harder before any aggregate is shown; see Open Question 2
— the actual suppression floor is an owner decision, not an engineering
default, and 5 here is a placeholder pending that decision, not a proposal
to finalize it at 5.

---

## (c) Locked state

Before an athlete's own gate is satisfied, the engine shows only honest
progress toward the stated prerequisites — counts of real rows, not a
teaser, percentage bar framed as achievement, or "almost there" language
aimed at a minor:

> Athleticism Engine — locked for this athlete.
> Recorded so far: 7 of 12 required training attempts (2 of 2 required
> metric types represented); span so far: 19 of 42 required days;
> physical-test retests: 0 of 2 required (protocol: none yet cataloged /
> `<protocol name>`, last administered `<date or "never">`).
> This view unlocks automatically once enough real attempts and tests are
> on record. There is nothing to do differently to "unlock" it faster, and
> no reward for reaching it sooner.

The last two sentences are load-bearing: this is an honesty gate on data
sufficiency, not a target to chase. No streak, countdown, or "X away from
unlocking!" framing is permitted (see Hard Walls — no FOMO/variable-reward
mechanics for minors).

At org level, locked state shows the same kind of factual counts: how many
`assessment_protocols` exist, how many athletes have cleared their
individual gate so far (a number, never a list of *which* athletes — that
would itself leak athlete-level standing into an org-facing surface before
unlock, which the module boundary forbids outright).

---

## (d) What unlocks

**At athlete level** (visible only to the athlete, their guardian, and
staff with existing access to that athlete's record — never to any other
athlete or guardian):
- The full per-`metric_kind` attempt history and per-protocol assessment
  history described in (a), including verdicts (`made`) and elapsed spans,
  strictly for that athlete's own rows.
- Any `intervention_evidence_links` rows where `source_kind` is
  `training_attempt` or `assessment` and the linked `source_id` belongs to
  that athlete, shown as "this result was used as evidence in a coaching
  intervention" — a pointer, not a duplicate of Module 026's own surface
  (see Open Question 4).
- No comparison to any other athlete, cohort average, percentile, or
  benchmark, at any unlock tier. This is a hard wall, not a phased
  rollout — cross-athlete comparison is not a "later tier" of this engine,
  it is permanently out of scope for Module 017 under any unlock state.

**At org level** (visible only to roles already permitted org-wide views —
`organization_admin`/`admin`/`coach` per `pilot.organization_memberships`
role vocabulary):
- Aggregate counts only, suppressed below the owner-decided minimum-N (Open
  Question 2): e.g., "X of Y active athletes have ≥ 2 physical-test
  administrations on file," "Z active physical-test protocols cataloged,"
  never a per-athlete breakdown inside this aggregate.
- Which `assessment_protocols` exist and their own declared
  `reliability_status`/`validity_status` — this is metadata about the
  org's measurement tooling, not about any child, so it is safe to show
  before the athlete-count gate clears.
- An org's aggregate view unlocking is *never* itself a basis for pushing
  individual athletes to "catch up" — this engine has no target-setting or
  notification surface, and this proposal does not create one.

---

## (e) Open questions for the owner

**1. Should Module 017 exist as a distinct engine at all, given 013
(physical capacity), 015 (energy systems), 016 (movement quality), and 018
(strength development) already own the individual physical qualities that
"athleticism" would otherwise re-aggregate?**
- (a) Keep 017, scoped narrowly to a pure per-athlete, per-`metric_kind`
  multi-metric *view* with zero new computation — effectively a
  cross-metric reading room, never a synthesis.
- (b) Retire Module 017 and fold its stub's intent into the existing
  physical-quality engines (013/015/016/018), each of which already has a
  natural home for its own metric.
- (c) Keep the stub open (`Status: DRAFT`, `Active: false`) but do not
  build anything under it until 013/015/016/018 ship first, since their
  outputs may make 017 redundant by construction.

**2. What minimum-N suppression floor applies to org-level aggregate
views, to avoid re-identifying individual minors in a small gym?**
- (a) Fixed floor (e.g., 5 or 10 athletes) below which no org-level
  aggregate is shown at all, regardless of how the count is presented.
- (b) No floor, but aggregates are always ratios/counts, never
  attributable data points (relies on presentation discipline rather than
  a hard block).
- (c) Defer any org-level view entirely until legal/safeguarding review of
  minor-data aggregation is complete, and ship athlete-level-only for now.

**3. Should results from an `assessment_protocols` row still at its default
unvalidated state (`reliability_status = 'UNVALIDATED - PPBF MUST
ESTABLISH'`) be shown to the athlete/guardian at all, or only to staff?**
- (a) Show to everyone with existing access, always paired with a visible
  "measurement properties not yet established" flag.
- (b) Show to staff (`coach`/`admin`) only until the protocol is formally
  validated; athlete/guardian view stays locked for that specific protocol
  even if the athlete's other prerequisites are met.
- (c) Block display entirely for any unvalidated protocol until PPBF
  completes a reliability study, deferring most physical-test content
  indefinitely given every protocol currently defaults to unvalidated.

**4. Should `intervention_evidence_links` rows that reference an
athlete's own `training_attempt`/`assessment` rows be surfaced (as a
pointer) inside Module 017, or does that belong exclusively to Module 026
(Intervention Tracking Engine) to avoid two modules presenting the same
underlying row?**
- (a) Module 017 shows a bare pointer ("used as evidence in an
  intervention — see Module 026") with no outcome detail duplicated.
- (b) Module 017 shows the linked `evidence_role` and the paired
  `intervention_outcome_reviews.performance_result` inline, accepting some
  surface duplication with 026.
- (c) Module 017 excludes intervention linkage entirely; that connection
  is visible only inside Module 026's own surface.
