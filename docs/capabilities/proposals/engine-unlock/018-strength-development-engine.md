# Engine Unlock Proposal — Module 018: Strength Development Engine

Status: PROPOSAL FOR OWNER REVIEW. No code changes. No schema changes. Nothing in this
document is active. All prerequisite thresholds below are draft numbers for the owner to
accept, adjust, or reject (see Open Questions).

Module stub reviewed: `docs/capabilities/modules/018-strength-development-engine.md` (DRAFT,
Active: false, Category: `physicalTrainingSystem`). The stub's Intent, Dependencies, and
Acceptance Criteria sections are blank in the current repo — this proposal fills the gap
using only tables that actually exist in `infra/azure/*.sql`, and says so explicitly wherever
the stub implies something the schema does not support.

---

## (a) What it computes / shows

Consistent with the platform's honesty doctrine (`AGENT_KERNEL.md` invariant 4 and the
recurring schema comments in `infra/azure/*.sql` — "NO invented metrics", "structured
exposure, never a dose scalar", "no fake percentage"), the Strength Development Engine may
only ever show:

1. **Raw attempt history, per athlete, per metric.** A read of `pilot.training_attempts` rows
   for that athlete where `metric_kind` is one of the load-bearing kinds (`load_kg`, `reps`,
   `hold_seconds`) — `achieved_value`, `target_value`, `direction`, `made`, `attempted_at`,
   `context_type`, `note`, exactly as recorded. No smoothing, no derived "strength score", no
   percentile, no composite index.
2. **Make/miss counts and the failure edge over time**, but only where `made` is non-null
   (i.e., a `target_value` was actually set — the table's own constraint,
   `pilot_training_attempts_made_check`, forbids a verdict without a target). Attempts with no
   target are shown as measurements, never silently scored as makes or misses.
3. **Protocol-anchored physical test results**, where a `pilot.assessments` row carries a
   `protocol_id`/`protocol_version` referencing a `pilot.assessment_protocols` row with
   `measure_kind = 'physical_test'` — shown alongside that protocol's own
   `reliability_status`, `validity_status`, `evidence_class`, and `minimal_detectable_change`
   columns, so a change is only ever described as real movement if it exceeds that protocol's
   own stated measurement error. If `minimal_detectable_change` is null (the schema default —
   "null until the reliability study supplies it"), the engine must say **"minimum detectable
   change: UNKNOWN"** rather than imply any change is meaningful.
4. **Coach-flagged strength gaps**, read-only, from `pilot.progression_gaps` where
   `gap_type = 'strength'` — shown as what a human coach recorded (`gap_description`,
   `severity`, `detected_from`), never re-scored or re-weighted by the engine.
5. **Linked intervention record**, where a strength-targeted `pilot.intervention_protocols` /
   `pilot.intervention_executions` / `pilot.intervention_evidence_links` /
   `pilot.intervention_outcome_reviews` chain exists for that athlete — shown as the
   human-authored hypothesis, planned vs. actual exposure, and the three separate
   human-entered verdicts (`performance_result`, `hypothesis_result`, `learning_signal`).
   Never collapsed into one score; the schema itself forbids a miss (`declined`/`unchanged`
   performance) from carrying a `supported` hypothesis result
   (`pilot_intervention_reviews_miss_check`), and the engine must preserve that distinction
   rather than paper over it.
6. **Explicit UNKNOWN states**, not zeros or blanks, wherever data is absent:
   - No qualifying attempts yet -> "no strength attempt history recorded" (not "0%").
   - `made` is null -> "no target set for this attempt" (not "in progress").
   - `minimal_detectable_change` is null -> "reliability not yet established for this test."
   - No `protocol_id` on an assessment -> "not linked to a standardized protocol."
   - Readiness (`pilot.readiness.score`/`category`) is a pre-computed value from a formula
     this schema does not define or store the derivation of — the engine may display it only
     as a passed-through fact ("readiness board shows: <category>"), never recompute it,
     never blend it into a strength number, and never treat its absence as anything but
     "no readiness reading."

**Explicitly forbidden regardless of what the stub implies:** any single "strength score,"
percentile, 1RM estimate, dose scalar, load recommendation, or prescribed working weight.
Strength testing on minors invites exactly this kind of load-prescription drift, and the
schema gives this engine no mechanism to compute or validate a safe prescribed load (see
Open Question 2). This engine may show *what happened*; it may never tell a coach or athlete
*what weight to load next*.

---

## (b) Data prerequisites

All thresholds below are counts against real columns in the tables read for this proposal.
They are draft numbers — the owner sets the final bar (Open Question 3).

### Per athlete — before any strength-specific view unlocks for that athlete

| # | Prerequisite | Table.column(s) checked |
|---|---|---|
| 1 | >= 12 `pilot.training_attempts` rows for this athlete with `metric_kind` in (`load_kg`,`reps`,`hold_seconds`) and non-null `achieved_value` | `pilot.training_attempts(organization_id, athlete_id, metric_kind, achieved_value)` |
| 2 | Those rows span >= 6 weeks: `max(attempted_at) - min(attempted_at) >= 42 days` | `pilot.training_attempts.attempted_at` |
| 3 | Spread, not a burst: attempts fall on >= 3 distinct ISO weeks, not clustered on a single day/session | `pilot.training_attempts.attempted_at` |
| 4 | At least 4 of the 12 rows carry a real verdict: `target_value is not null` (so `made` is non-null per the table's own check constraint) | `pilot.training_attempts.target_value`, `.made` |
| 5 | `pilot.athletes.dob` is populated for this athlete (required before any load-bearing metric is shown at all — age gates minor-safety framing) | `pilot.athletes.dob` |

Rows recorded with `context_type = 'assessment'` count toward (1)–(4) only when the linked
`pilot.assessments` row has a non-null `protocol_id`; unlinked ad-hoc entries still count but
are shown with the "not linked to a standardized protocol" caveat from (a).

### Per organization — before the engine activates at all for that org

| # | Prerequisite | Table.column(s) checked |
|---|---|---|
| 1 | >= 5 distinct athletes in the org each individually clear the per-athlete bar above | `pilot.training_attempts` grouped by `athlete_id` |
| 2 | Qualifying data exists in >= 2 non-adjacent calendar months (guards against a single retroactive data dump satisfying the letter of the per-athlete bar in one afternoon) | `pilot.training_attempts.attempted_at` |
| 3 | >= 2 distinct `recorded_by_account_id` values across the qualifying rows (guards against one staff member's personal log standing in for organizational practice) | `pilot.training_attempts.recorded_by_account_id` |

If any prerequisite is unmet, the engine reports **which specific one(s)** are unmet and by
how much — never a generic "locked."

---

## (c) Locked state

Before an athlete clears the per-athlete bar, their view shows exact, honest progress toward
each unmet row in the table above — real counts from real queries, not a manufactured percent:

```
Strength Development Engine — not yet available for <athlete>

Attempts recorded:        7 of 12 needed        (load_kg / reps / hold_seconds)
Time span covered:        18 of 42 days needed
Distinct weeks with data: 2 of 3 needed
Attempts with a target:   2 of 4 needed
Date of birth on file:    YES

This is a count of what has been recorded, not a score. Nothing about strength capacity
is displayed until this athlete's own recorded history clears these thresholds.
```

Before the org clears its bar, staff/board-facing surfaces show the same shape at org
granularity ("3 of 5 athletes individually qualified," "data spans 1 of 2 required months,"
"1 of 2 required distinct recorders") — an org-wide readiness-to-activate count, never a
per-athlete ranking of who is closest, which would itself be a cross-athlete comparison.

No placeholder score, no "estimated," no grayed-out number that implies a value exists
underneath. The locked state is a literal, checkable to-do list against real rows.

---

## (d) What unlocks

**Athlete level (their own record only):**
- Full attempt history for that athlete across `load_kg` / `reps` / `hold_seconds`
  `metric_kind`s, plotted over `attempted_at`, with make/miss shown only where `made` is
  non-null.
- Protocol-anchored physical-test trend where `assessment_protocols.measure_kind =
  'physical_test'` links exist, annotated with that protocol's own
  `minimal_detectable_change` / `reliability_status` so the athlete/coach can see whether an
  apparent change is inside or outside measurement noise.
- Linked coach-flagged strength gaps (`progression_gaps` where `gap_type='strength'`) and any
  linked intervention chain, shown as the coach's own recorded hypothesis/outcome — never
  re-scored.
- This is **strictly single-athlete**. Cross-athlete comparison, percentile-within-cohort,
  team averages surfaced to an individual, or any leaderboard-shaped view are forbidden in
  any form, per the hard walls on this proposal and per the schema's own stated intent
  (`training_attempts` migration: "NO leaderboard, ranking, or cross-athlete comparison
  surface may be built on this table").

**Org level:**
- An aggregate, anonymized-by-construction view: total qualifying athletes, total qualifying
  attempts, org-wide time span of coverage, count of strength-linked interventions and their
  `learning_signal` distribution (e.g., how many executions produced
  `intervention_non_response` vs. `prior_belief_strengthened` — organizational learning, not
  individual grading).
- Org activation is earned purely by accumulated real records clearing the per-org bar in
  (b) — never by an admin toggle, and never by cherry-picking the org's strongest athletes'
  data to hit the threshold early (the >=5-distinct-athletes and >=2-distinct-recorder
  prerequisites exist specifically to prevent that).
- Org-level output still never exposes an individual athlete's row to a board/aggregate
  audience without existing suppression rules (per the module stub's own Boundaries section,
  already binding regardless of this proposal).

---

## (e) Open questions for the owner

**1. Movement/exercise identity is not structurally captured anywhere in this schema.**
`pilot.training_attempts` records `metric_kind` (a generic unit: reps / time / distance /
load / rounds / hold time) but has **no column naming which exercise or movement** was
attempted (no `exercise_id`, no `movement`, no FK to `pilot.drills`). The only identity signal
is the free-text `note` column, or an optional, unenforced `context_id` that a coach may or
may not have pointed at a `pilot.drill_assignments` row (which does have a `drill_name`, but
`training_attempts.context_id` carries no foreign-key constraint to it). This means the
schema, as it exists today, **cannot support** a "back squat is improving" or "grip strength
plateaued" view without either trusting untyped free text or leaving movement identity
UNKNOWN. Options:
   - (a) Ship v1 restricted to protocol-anchored `physical_test` assessments only (which do
     have a structured protocol name) and show ad-hoc `training_attempts` load/rep entries as
     an undifferentiated raw log, explicitly labeled "movement not structurally recorded."
   - (b) Request a separate, future schema change (a movement/exercise catalog column on
     `training_attempts`) before any per-lift trend view ships — out of scope for this
     proposal and this engine's unlock gate.
   - (c) Allow a low-confidence, clearly-labeled grouping by matching `note` text, with an
     explicit "coach-entered, unverified" tag on every such view.

**2. Is any load number ever shown as forward guidance, even implicitly?**
The hard wall for this proposal forbids dose scalars and prescribed loads outright, but the
underlying data (`achieved_value` where `metric_kind='load_kg'`) is exactly the kind of number
a coach could read as "so next time load 5kg more." Options:
   - (a) Historical log only, framed strictly in the past tense ("last recorded attempt: 40kg
     x 5"), with no "next" language anywhere in the UI copy, for any role.
   - (b) Same as (a), but visible to coach/staff roles only, never to the athlete directly.
   - (c) Load-bearing metrics are excluded from this engine's unlocked view entirely until a
     separate, explicitly medical/strength-and-conditioning-credentialed review authorizes
     any display of load history to a coaching role — treating load prescription risk as
     categorically separate from every other metric_kind in this table.

**3. What are the actual per-athlete and per-org thresholds?**
Section (b)'s numbers (12 attempts / 6 weeks / 3 distinct weeks / 4 verdicted attempts;
5 athletes / 2 months / 2 recorders) are this proposal's draft starting point, not a
validated standard. Options:
   - (a) Accept the draft numbers as-is.
   - (b) Raise them (e.g., require a full macrocycle — 12+ weeks — before any trend is shown,
     given how noisy strength testing is in youth athletes).
   - (c) Lower the per-athlete bar but raise the per-org distinct-recorder/athlete count, to
     get individual athletes useful feedback sooner while keeping org-level activation
     conservative.
   - (d) Different numbers entirely — owner to specify.

**4. Should this engine reference `pilot.readiness` at all?**
`pilot.readiness` stores a pre-computed `score`/`category`, but nothing in this schema defines
the formula that produces it, and the `athlete_check_ins` migration explicitly warns that
readiness's formula-driven board must not be contaminated by mixing in other data sources.
Options:
   - (a) Never reference `pilot.readiness` from this engine — treat it as out of domain
     entirely.
   - (b) Reference it as a read-only, passed-through contextual fact only (e.g., "readiness
     board currently shows: YELLOW"), with no recomputation and no blending into any strength
     view.
   - (c) Require the readiness formula's derivation to be separately documented and audited
     (by whoever owns it) before this engine may even read it.

**5. Minors and load-bearing metrics — does age gate visibility, not just framing?**
All PPBF athletes are minors. `pilot.athletes.dob` lets the engine compute age, but this
schema has no maturation/training-age or medical-clearance signal to condition strength-metric
display on. Options:
   - (a) Age is display-only context; no additional gating beyond what this proposal already
     specifies.
   - (b) Require a coach/guardian acknowledgment step (recorded somewhere auditable) before
     `load_kg` metrics are shown for any athlete under a specified age, separate from and in
     addition to the data-volume unlock in (b).
   - (c) Exclude `load_kg` metric_kind entirely from this engine's scope until a medical/board
     policy on youth load-bearing strength testing is adopted, showing only `reps` /
     `hold_seconds` / `time_seconds` / `distance_m` in the interim.
