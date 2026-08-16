# Module 021 — Adaptation Engine: Unlock-Prerequisite Proposal

| Field | Value |
|-------|-------|
| Status | **PROPOSAL — for owner approval, no code changes** |
| Module stub | `docs/capabilities/modules/021-adaptation-engine.md` |
| Related stub | `docs/capabilities/modules/033-fatigue-decay-monitor.md` (same audit-log constraint, sibling module) |
| Related shipped module | `docs/capabilities/modules/026-intervention-tracking-engine.md` (evidence/causality primitives this proposal depends on) |
| Prepared against | `infra/azure/*.sql` (real schema, cited by file below) |

This document proposes the data-honesty gate that must sit in front of any "Adaptation Engine" surface, per `AGENT_KERNEL.md`'s invariant that claims need evidence and that authority to decide policy/doctrine stays with the owner. It contains no implementation and changes no file except itself.

---

## Governing constraint (read first)

The module's own audit log (`docs/capabilities/modules/021-adaptation-engine.md`, 2026-08-16 entry) already settled one point: *"NO boxing-validated Banister impulse-response decay constants were found, and no youth evidence supports fixed tau values. Fitness-fatigue / impulse-response modeling is RESEARCH_FIRST for this module: never hardcode imported tau1/tau2 constants from adult or non-boxing literature."*

This proposal treats that as binding, not aspirational: **a classic fitness-fatigue/impulse-response "adaptation model" (fitness/fatigue curves, decay-weighted training-load scores, readiness-from-formula) is out of scope for this engine at any unlock tier.** Nothing in the schema below changes that — there is no table anywhere in `infra/azure/*.sql` that stores a validated tau constant, and none should be invented to make this module feel more finished. What follows is the honest alternative: real recorded history, shown as recorded, gated behind enough of it to stop being noise.

---

## (a) WHAT IT COMPUTES / SHOWS

Nothing in this module computes a composite "adaptation score," a dose scalar, a readiness index, or a fitness/fatigue trajectory. Every number shown is either a stored value or simple, transparent arithmetic over stored values (counts, sums, min/max dates) computed at query time and labeled as such. Where a prerequisite (section b) is unmet, the surface shows an explicit `UNKNOWN — insufficient recorded data` state, never a zero, a placeholder average, or an inferred value.

Once unlocked (per athlete, per sub-view — see section d), the engine shows exactly these views, each sourced from one real table:

1. **Failure-edge trend** (per `athlete_id` × `metric_kind`) — from `pilot.training_attempts`: `achieved_value` and `made` plotted against `attempted_at`, restricted to rows where `target_value is not null` (a verdict exists). Labeled as "recorded attempts," never as a modeled capacity curve. `direction` (`at_least`/`at_most`) is shown alongside the value so a viewer never has to guess which way is better.
2. **Assessment trend** (per `athlete_id` × `protocol_id`) — from `pilot.assessments` joined to `pilot.assessment_protocols`: `result` values over `administered_on`, shown with that protocol's own `reliability_status`, `validity_status`, `evidence_class`, and `retest_interval_basis` printed next to every value, not hidden in a tooltip. Where `evidence_class = 'INSUFFICIENT EVIDENCE'` or `reliability_status = 'UNVALIDATED - PPBF MUST ESTABLISH'` (today's defaults for most protocols), that label is shown, not suppressed.
3. **Training exposure** (per `athlete_id`) — from `pilot.activity_log` (`duration_minutes`, `rpe`, `activity_domain = 'boxing_training'`) and `pilot.session_load` (`rpe_physical`, `rpe_cognitive` rated separately) and `pilot.sparring_exposure` (`time_under_impact_sec`, `coach_observed_intensity`): shown as raw weekly sums/counts. Per `session_load`'s own table comment, sRPE × duration is never stored and this engine will not store it either; if shown at all it is computed in the query and labeled "unvalidated in boxing," never presented as a load "score."
4. **Reviewed intervention outcomes** (per `athlete_id`) — from `pilot.intervention_outcome_reviews` (`status = 'active'`) joined through `pilot.intervention_executions.athlete_id`: `performance_result`, `hypothesis_result`, `learning_signal`, and `performance_notes`/`learning_notes` displayed as the human reviewer wrote them. **This engine does not compute, infer, or restate causality.** A review row is the only thing in the platform allowed to say a hypothesis was supported — see the next paragraph.

**On causality specifically:** `pilot.intervention_outcome_reviews` structurally requires a human `reviewed_by_account_id` and enforces two honesty constraints at the database level — a declined/unchanged `performance_result` cannot carry a `supported`/`partially_supported` `hypothesis_result`, and `confounded`/`insufficient_evidence` cannot carry `learning_signal = 'prior_belief_strengthened'`. Those constraints exist so that only a human, working from linked evidence (`pilot.intervention_evidence_links`, typed by `evidence_role` and `source_kind`), gets to declare that an intervention worked. This module may **surface** that verdict; it must never **generate** one, and must never present "attempt improved after intervention X" as its own inference from timing alone (preceding an outcome is not causing it — the same doctrine module 026 already enforces).

## (b) DATA PREREQUISITES

All thresholds below are proposed defaults for owner sign-off (see Open Question 1) — they are concrete so the gate is checkable, not because the specific numbers are final.

### Per athlete (unlocks that athlete's own sub-view)

| Sub-view | Table(s) | Condition | Proposed minimum |
|---|---|---|---|
| Failure-edge trend (per `metric_kind`) | `pilot.training_attempts` | rows for `(organization_id, athlete_id, metric_kind)` with `target_value is not null` (so `made` is populated) | **>= 12 rows**, spanning **>= 42 days** between `min(attempted_at)` and `max(attempted_at)` |
| Assessment trend (per `protocol_id`) | `pilot.assessments` + `pilot.assessment_protocols` | rows for `(organization_id, athlete_id, protocol_id)` with `administered_on is not null` | **>= 2 administrations**, each respecting that protocol's own `retest_interval_days`/`retest_after_training_hours` where non-null (a retest sooner than the protocol's own sensitivity-to-change interval does not count toward the trend, it is measurement noise per the protocol's own design intent) |
| Training exposure | `pilot.activity_log` | rows for `(organization_id, athlete_id)` with `activity_domain = 'boxing_training'` and `duration_minutes` present (`not null` by schema) | **>= 8 rows**, spanning **>= 28 days** |
| Reviewed interventions | `pilot.intervention_outcome_reviews` joined via `execution_id` to `pilot.intervention_executions.athlete_id`, `status = 'active'` | at least one completed human review tied to this athlete | **>= 1 row** (structurally always human-authored; there is no threshold to invent beyond existence) |

Each sub-view unlocks independently on its own prerequisite — an athlete with 15 `training_attempts` rows but zero `assessments` sees the failure-edge trend unlocked and the assessment trend still locked. (Whether that is the right model at all is Open Question 2.)

### Per organization (unlocks the module's existence for that org — an org with zero real data gets no engine at all, not an engine full of invented numbers)

| Condition | Table(s) | Proposed minimum |
|---|---|---|
| Distinct athletes meeting the failure-edge per-athlete prerequisite | `pilot.training_attempts` | **>= 5 athletes** |
| Org-wide attempt volume | `pilot.training_attempts` | **>= 150 rows** total for the org |
| Org history depth | `pilot.training_attempts` (or `pilot.organizations.created_at` as a floor) | **>= 8 weeks** between the org's earliest and latest `attempted_at` |
| Evidence loop actually in use (not just protocols filed) | `pilot.intervention_outcome_reviews`, `status = 'active'` | **>= 3 reviews** org-wide |

An org that has only filed `pilot.intervention_protocols` (stated intent) with zero `pilot.intervention_executions` or zero `pilot.intervention_outcome_reviews` has not demonstrated a working evidence loop, and the org-level gate reflects that: protocol rows alone never count toward org unlock.

## (c) LOCKED STATE

Before a sub-view's prerequisite is met, the engine shows literal progress against the table above — counts and dates, never a percentage-toward-unlock bar styled as a meter, and never framed as something the athlete "should" hit faster (these are minors; no FOMO/urgency framing per the hard walls). Example locked-state text, per sub-view:

- Failure-edge (jab count, this athlete): *"7 of 12 minimum qualifying attempts recorded. Oldest qualifying attempt: 19 days ago (need 42). LOCKED — not enough recorded history yet."*
- Assessment trend (CMJ protocol, this athlete): *"1 of 2 minimum administrations recorded. LOCKED."* If the protocol's `retest_interval_basis = 'TBD - no defensible basis'`, add: *"This protocol has no established retest interval — a second administration may not be interpretable as a trend regardless of count."*
- Training exposure: same shape, counts and date span only.
- Reviewed interventions: *"0 completed outcome reviews recorded for this athlete. LOCKED — this section only ever shows human-reviewed verdicts, never a computed one."*

Org-level admin/board view (aggregate only, never athlete-identifying comparisons — see Boundaries in the stub and the hard walls in this task): *"4 of 5 athletes with sufficient training-attempt history for org-level activation. 112 of 150 qualifying attempts recorded. 1 of 3 completed outcome reviews."* No athlete is named or ranked in this aggregate; it is a single organization-wide countdown, not a leaderboard of who is "ahead."

## (d) WHAT UNLOCKS

**Athlete level** (richer views of that athlete's own record only):
- The four sub-views in (a) become visible, individually, once their own per-athlete prerequisite is met.
- Unlocking never grants cross-athlete comparison, ranking, percentile, or "compared to peers" framing in any form — this is a hard wall, not a phase-2 feature. Every unlocked view is scoped to `where athlete_id = :this_athlete` with no aggregate-across-athletes query path exposed to an athlete-facing or parent-facing surface.
- A coach/admin viewing one athlete's unlocked sub-views sees only that athlete's rows; nothing about unlock state pools athletes into a comparison table anywhere in this module.

**Org level** (an org earns engine activation by accumulating real data, not by owner flip of a flag):
- Below the org-level thresholds in (b), no org-admin or board surface for this module renders at all — it is absent, not present-and-empty, so nobody mistakes silence for "no adaptation happening."
- Above threshold, the org-level surface shows only the aggregate progress counters described in (c) plus links into individually-unlocked athlete sub-views (each still scoped per-athlete as above). The org view itself never becomes a table of athletes sorted by any metric.

## (e) OPEN QUESTIONS FOR THE OWNER

1. **Are the proposed thresholds (12 attempts/6 weeks; 2 assessments respecting protocol retest interval; 8 activity-log rows/4 weeks; 1 reviewed intervention; org: 5 athletes/150 attempts/8 weeks/3 reviews) the right bar, or should they be different?**
   - Option A: adopt as drafted.
   - Option B: raise all counts (e.g., 20 attempts/8 weeks) for a stricter honesty bar before any trend renders.
   - Option C: lower them for the initial pilot cohort (e.g., 8 attempts/4 weeks) given known small squad sizes, with a note that the trend is provisional at the floor.
   - Option D: derive the assessment-trend threshold entirely from each protocol's own `retest_interval_days`/`retest_after_training_hours` (no fixed count of 2 — instead "at least one full retest interval has elapsed since baseline"), letting the science-derived interval be the only gate for that sub-view.

2. **Should unlock be per sub-view (as drafted — failure-edge, assessment, exposure, reviewed-outcomes each gate independently) or monolithic (the whole "Adaptation Engine" is one locked/unlocked unit, gated on the hardest-to-meet prerequisite)?**
   - Option A: per sub-view, as drafted — an athlete with rich attempt data but no assessments sees partial value sooner.
   - Option B: monolithic — simpler mental model ("the engine" is on or off), but likely means most athletes see nothing for a long time since assessment data accrues slowest.

3. **Is the org-level gate meant to be a real additional bar beyond athlete aggregation, or purely derived (org unlocks automatically once N athletes are individually unlocked)?**
   - Option A: as drafted — a distinct set of org-wide conditions (volume + history depth + reviews-in-use), separate from athlete counts, so an org can't unlock by having one very well-tracked athlete.
   - Option B: purely derivative — org view appears the moment >=1 athlete has any unlocked sub-view, with no separate org threshold.
   - Option C: tie org unlock to season/enrollment concepts if the platform has them (out of scope of the tables reviewed here — would need `pilot.organizations`/membership data reviewed separately).

4. **Is any tally of `learning_signal`/`performance_result` values across an athlete's multiple reviewed interventions acceptable, or does even a count cross into "score" territory?** (E.g., "3 of 5 reviewed interventions for this athlete showed `prior_belief_strengthened`.")
   - Option A: never tally — show each review's three answers individually, full stop, no counting across rows.
   - Option B: allow a plain count of `learning_signal` categories only (never `performance_result`, which is closer to an outcome judgment) as a simple frequency table, not a score.
   - Option C: allow tallying both, since both are closed, human-authored vocabularies and a count of categorical labels is arithmetic, not invention.

5. **Should this engine ever display a computed sRPE × duration "load" number (from `pilot.session_load` + `pilot.activity_log`), even labeled unvalidated, given the schema's explicit design choice not to store it?**
   - Option A: never compute or display it here — show only the raw `rpe_physical`, `rpe_cognitive`, and `duration_minutes` fields side by side, and leave any product/derived-load display to a future, separately-approved module.
   - Option B: compute it at query time and display it, but only behind a persistent "unvalidated in boxing" label matching `pilot.session_load`'s own table comment, matching what module 026's related documentation already treats as acceptable ad hoc arithmetic.
   - Option C: defer the whole exposure/load sub-view out of this module entirely into module 033 (Fatigue Decay Monitor), since that stub shares the identical RESEARCH_FIRST constraint and may be the more natural owner for load-over-time displays.

---

### Where the schema cannot support what the stub implies

- The stub's category (`physicalTrainingSystem`) and its name ("Adaptation Engine") both invite a computed adaptation/fitness trajectory. **No table in `infra/azure/*.sql` stores a validated decay/tau constant, and the module's own audit log says none exist for boxing or youth populations.** This proposal treats classic fitness-fatigue modeling as permanently out of scope for this module unless a future, separately-approved research effort establishes PPBF-specific (not imported) constants — which would be a new owner decision, not an unlock tier.
- `pilot.readiness` (`infra/azure/pilot_slice_postgres.sql`, and duplicated in `pilot_slice_postgres_multiorg_migration.sql`) already stores a bare `score numeric` and `category text` with **no formula, provenance, or validation columns in the schema at all** — unlike `pilot.assessment_protocols`, which carries `reliability_status`/`validity_status`/`evidence_class` explicitly. This proposal does **not** treat `pilot.readiness.score`/`category` as an honest input for this module: surfacing it here would inherit an already-invented number this module cannot audit. Recommend excluding `pilot.readiness` from this engine's inputs entirely unless/until its formula is documented and reviewed as its own decision.
- Causality: the schema (via `pilot.intervention_outcome_reviews`) supports **human-declared, constrained** causal judgments — it does not support this module computing or inferring causality itself. Any future request to have this engine "detect" that an intervention worked would require weakening or bypassing the `intervention_reviews_miss_check`/`intervention_reviews_confound_check` constraints, which is a hard safety boundary per `AGENT_KERNEL.md` invariant 4 and must not be done to make this module look more capable.
