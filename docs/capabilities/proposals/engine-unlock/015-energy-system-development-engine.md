# Engine Unlock Proposal — Module 015: Energy System Development Engine

| Field | Value |
|-------|-------|
| Status | PROPOSAL — owner decision requested |
| Module stub | `docs/capabilities/modules/015-energy-system-development-engine.md` |
| Prepared | 2026-08-16 |
| Scope of this document | Unlock-prerequisite proposal only. No code, schema, or module-stub changes. |

## Summary finding (read this before anything else)

"Energy system development" is a physiology term: it means classifying and tracking training as
aerobic/oxidative, anaerobic-glycolytic ("lactic"), or anaerobic-alactic ("phosphagen"), which
requires effort duration **and** rest-interval structure **and** an intensity signal (heart rate,
lactate, power/watts, or a validated proxy).

A repo-wide search of `infra/azure/*.sql` for heart rate, HRV, VO2, lactate, watts, and any
rest-interval / work:rest / interval-structure column found **none**. `conditioning` exists only as
a category label in a handful of check constraints (session-script phase type, training-hold
scope, discipline tag, competence domain) — never as a measured quantity. There is no schema path
by which this engine can ever compute or display a true energy-system classification, a
percent-aerobic/anaerobic split, a training zone, or a VO2/lactate estimate. Section (a) below and
Open Question 1 in section (e) state this plainly rather than routing around it.

Everything this proposal unlocks is therefore a **duration/effort/repetition proxy**, honestly
labeled as such — never a physiological energy-system score.

## (a) What it computes / shows

Consistent with the honesty doctrine (no invented scores, no dose scalars, explicit UNKNOWN where
data is absent), the engine may only ever show data traceable to a real recorded row. Candidate
views, each independently gated (see (b)/(d)):

1. **Timed / held / round-based attempt trend** — from `pilot.training_attempts` rows where
   `metric_kind` is `'time_seconds'`, `'hold_seconds'`, or `'rounds'` and `target_value is not
   null` (so `made` carries a real verdict per the table's own
   `pilot_training_attempts_made_check` constraint). Plotted as `achieved_value` vs `target_value`
   vs `attempted_at`, per metric_kind, for that athlete only. Labeled "duration/repetition-based
   capacity at a timed/held/round task" — **never** "aerobic capacity" or "anaerobic capacity."
2. **Session volume/frequency** — count and total `duration_minutes` from
   `pilot.activity_log` where `activity_domain = 'boxing_training'`, by week, from `occurred_on`.
3. **Perceived-effort trend** — `pilot.session_load.rpe_physical` (CR10 scale per
   `rpe_scale`) over `rated_at`, always displayed with the fixed caveat that sRPE (`rpe_physical x
   duration`) is unvalidated in boxing and is never stored as a derived column (per
   `pilot_slice_postgres_sparring_exposure_and_load_migration.sql`'s own comment) — the engine
   must not silently compute and store it either.
4. **Coach-observed conditioning level** — `pilot.athlete_competence` rows where
   `domain = 'conditioning'`, showing `level_key`, `basis` (`coach_observation` /
   `assessment_result` / `both` / `carried_forward`), `assessed_on`, and `evidence_note` verbatim.
   Displayed as a qualitative coach judgment with its stated basis, never converted to a number.
5. **Conditioning-relevant assessment results** — `pilot.assessments` rows joined to
   `pilot.assessment_protocols` where the protocol's `quality_measured` names a conditioning
   quality. Every such result must be shown alongside that protocol's own
   `reliability_status`, `validity_status`, `evidence_class`, and `minimal_detectable_change`
   columns (which default to `'UNVALIDATED - PPBF MUST ESTABLISH'`, `'UNKNOWN'`,
   `'INSUFFICIENT EVIDENCE'`, and `null` respectively) — the result is never shown as a bare
   number. If no org has configured such a protocol, show **UNKNOWN: no conditioning-specific
   assessment protocol configured** rather than omitting the section silently.
6. **Intervention ledger view** (reuses module 026's tables, scoped to this domain by the
   protocol's own free-text `target_problem`/`hypothesis`) — planned vs actual
   `intended_exposure`/`actual_exposure` (structured jsonb dimensions, never collapsed to one
   number, per `pilot.intervention_protocols`'s own design comment), `adherence`,
   `intervention_outcome_reviews.performance_result` / `hypothesis_result` / `learning_signal`.
   Athlete view is restricted to `intervention_executions.athlete_id` = the viewing athlete.

**Always UNKNOWN, never invented:** energy-system classification (aerobic/glycolytic/alactic
split), VO2max or VO2 estimate, lactate threshold, heart-rate zone time, calories, "conditioning
score," dose scalar, or any single composite index. There is no column anywhere in the schema that
could back these, so the engine must render an explicit `UNKNOWN — not measured by this platform`
state for each, permanently, absent a future schema change the owner authorizes.

## (b) Data prerequisites

Each signal in (a) unlocks independently — this is a bundle of proxies, not one monolithic gate.
All thresholds below are illustrative defaults built only from real columns; the owner should treat
the exact numbers as Open Question 2.

**Per athlete:**

| Signal | Prerequisite (real, checkable) |
|---|---|
| Timed/held/round attempt trend | `>=12` rows in `pilot.training_attempts` for this `athlete_id` with `metric_kind in ('time_seconds','hold_seconds','rounds')` and `target_value is not null`, where `max(attempted_at) - min(attempted_at) >= 42 days`, spread across `>=4` distinct calendar weeks (not a single backfilled burst) |
| Session volume/frequency | `>=8` rows in `pilot.activity_log` for this athlete with `activity_domain = 'boxing_training'` and `duration_minutes is not null`, spanning `>=28 days` |
| Perceived-effort trend | `>=8` rows in `pilot.session_load` for this athlete with `rpe_physical is not null`, spanning `>=28 days` |
| Conditioning competence level | `>=1` row in `pilot.athlete_competence` with `domain = 'conditioning'` for this athlete; rows with `basis = 'coach_observation'` only may show but are flagged "observation only, not assessed"; `basis in ('assessment_result','both')` shows unflagged |
| Conditioning-relevant assessment | `>=1` row in `pilot.assessments` for this athlete with a non-null `protocol_id`/`protocol_version` referencing an **active** `pilot.assessment_protocols` row whose `quality_measured` names a conditioning-relevant quality — always rendered with that protocol's reliability/validity fields regardless of count |
| Intervention ledger view | `>=1` row in `pilot.intervention_executions` for this athlete against a protocol whose `target_problem`/`hypothesis` names a conditioning-relevant goal, AND `>=1` row in `pilot.intervention_outcome_reviews` with `status = 'active'` for that execution |

**Per org** (in addition to the per-athlete gates — an org view never bypasses per-athlete
prerequisites, it aggregates athletes who already independently qualify):

- `>=5` athletes in the organization independently meeting the "timed/held/round attempt trend"
  per-athlete prerequisite above (small-N floor to prevent an org aggregate from functioning as a
  disclosure channel for one or two individual athletes — see Open Question 3 for the exact N).
- The organization's earliest qualifying `training_attempts.attempted_at` to latest spans
  `>=42 days` org-wide (mirrors the per-athlete span so an org cannot "unlock" by importing a
  single day of bulk-backfilled history across many athletes).

## (c) Locked state

Before a signal's prerequisite is met, the engine shows only honest, literal progress toward that
signal's real thresholds — counts and dates from the same queries used to gate it, never a
percentage dressed up as a competency score and never a badge/streak/reward framing:

- "Timed/held/round attempts recorded: 7 of 12. Oldest to newest span: 19 of 42 days needed."
- "Session log entries: 5 of 8. Span: 12 of 28 days needed."
- "Perceived-effort ratings recorded: 3 of 8."
- "Conditioning level: not yet assessed." / "Conditioning level: [level_key], coach-observed only, not yet backed by an assessment."
- "Conditioning-relevant assessment: none recorded." (this signal has no "in progress" state — either a qualifying row exists or it does not)
- "Intervention ledger: no conditioning-related protocol executions recorded for this athlete."

Org-level locked state: "3 of 5 athletes currently qualify for the org conditioning-trend view."
No individual athlete names or counts below the org threshold are surfaced in this locked state to
staff roles that would not otherwise see individual athlete records.

No numeric estimate, projected date-to-unlock, or motivational copy ("almost there!", streaks,
countdowns) is shown — this is an honesty gate on data sufficiency, not a game mechanic, and the
users are minors.

## (d) What unlocks

**Athlete level** — once a signal's per-athlete prerequisite in (b) is met, that signal's full
real trend becomes visible, and only for that athlete's own record:

- Full timed/held/round-based attempt history chart (own history only), including failed attempts
  — per the table's own design intent, a failed attempt is data, not an error state, and must not
  be hidden or softened.
- Session volume/frequency history.
- Perceived-effort trend, permanently paired with the "sRPE unvalidated in boxing, not stored as a
  derived value" caveat.
- Conditioning competence level history (`pilot.athlete_competence`, own record only), including
  superseded levels via `superseded_by` so history is never silently overwritten.
- Conditioning-relevant assessment results, permanently paired with the issuing protocol's
  reliability/validity/evidence-class fields.
- The intervention ledger view (protocol -> execution -> evidence link -> outcome review) scoped
  to `athlete_id` = the viewing athlete.

**Forbidden regardless of unlock state, permanently:** any cross-athlete comparison, ranking,
percentile, benchmark against peers, or leaderboard, in any form, at any unlock tier. This is not a
locked feature waiting on data — it is out of scope for this engine entirely.

**Org level** — an org "earns" an aggregate conditioning-trend view (never a per-athlete
drill-down beyond what staff roles already have standing access to) once the per-org thresholds in
(b) are met. Aggregate content is limited to coverage/count statistics computed across the
qualifying cohort, e.g.:

- "X of Y active athletes have a qualifying timed/held/round attempt history."
- Cohort-level counts of conditioning-relevant assessments administered, filtered to protocols
  above whatever validation bar the owner sets (Open Question 4).

No per-athlete ranking, "most improved," "top performer," or any list orderable by an individual's
number is in scope at org level — that would be the leaderboard this engine is barred from
producing, only relabeled as an aggregate.

## (e) Open questions for the owner

1. **No physiological instrumentation exists in this schema (heart rate, lactate, VO2, power,
   rest-interval structure).** This module's name promises energy-system development tracking that
   the current data cannot support at all — only duration/effort/repetition proxies. Options:
   (a) rename/rescope the module now to a "conditioning-trend proxy engine" using only the
   proxies in this proposal, permanently, with no path to true energy-system classification;
   (b) keep the name, ship only the proxies, and treat true physiological instrumentation as an
   explicitly separate, later, owner-approved phase (e.g., a validated HR-strap ingestion path);
   (c) keep the name and proxies indefinitely, with a permanent "physiological classification: not
   measured by this platform" banner on every screen this engine renders; (d) retire this module
   and fold its proxies into Module 013 (Physical Capacity Engine), since the underlying tables
   (`training_attempts`, `activity_log`, `session_load`) are the same ones that engine would use.

2. **The per-athlete/per-org count-and-span thresholds in (b) are illustrative, drawn only from
   the schema's own units** (rows, days, weeks) — not from any coaching-science minimum-sample
   guidance found in this repo. Options: (a) adopt the numbers above as defaults pending a
   separate sport-science review; (b) commission that review before any threshold ships;
   (c) require ALL five per-athlete signals simultaneously before any part of the engine unlocks,
   rather than gating each independently, to avoid partial/inconsistent-feeling views;
   (d) owner supplies different numbers directly.

3. **Org-aggregate small-N floor.** Proposal sets `>=5` qualifying athletes before any org
   aggregate renders, to keep an org view from functioning as a re-identification channel for one
   or two athletes. No existing suppression-floor constant for this domain was found in the
   schema searched. Options: (a) confirm/reuse a floor already used by another shipped engine, if
   one exists outside the files searched here; (b) accept N=5; (c) set a higher floor (e.g., N=10);
   (d) require the qualifying-athlete count to also be `<50%` of org roster size before rendering,
   so a small org can't trivially clear a flat N.

4. **Low-evidence assessment protocols.** `pilot.assessment_protocols` defaults every new
   protocol's `reliability_status` to `'UNVALIDATED - PPBF MUST ESTABLISH'` and `validity_status`
   to `'UNKNOWN'`. Should a single result recorded against such a protocol be allowed to unlock any
   richer view at all? Options: (a) allow display, always paired with the caveat fields, no
   blocking; (b) block that signal's unlock entirely until a protocol's `reliability_status` is
   changed from its default by a human review; (c) show it to staff roles only until validated,
   withheld from the athlete's own view until then.

5. **Coach free-text "energy system" labeling.** Nothing in the schema has a controlled
   vocabulary for energy-system terms — `intervention_protocols.target_problem`/`hypothesis` and
   `assessment_protocols.quality_measured` are free text, so a coach could type "aerobic base
   work" there today. Should the engine ever surface that free text next to data, where it could
   read as the platform endorsing a physiological claim it never measured? Options: (a) show it
   verbatim with an explicit "coach's own words, not verified by this platform" tag; (b) never
   surface free-text energy-system claims in this engine, only structured numeric fields; (c) hold
   this feature until a controlled vocabulary column is added in a future migration, decided
   separately.
