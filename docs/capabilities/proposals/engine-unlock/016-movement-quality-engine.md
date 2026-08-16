# Engine Unlock Proposal — Module 016: Movement Quality Engine

| Field | Value |
|-------|-------|
| Status | PROPOSAL — owner approval required, no code changes made |
| Module stub | `docs/capabilities/modules/016-movement-quality-engine.md` |
| Category | Physical Training System (`physicalTrainingSystem`), item 16 of 24 |
| Prepared | 2026-08-16 |
| Related but out of scope | #31 Mobility/ROM Engine, #32 Asymmetry/Imbalance Monitor — separate unbuilt modules, not addressed here |

This proposal follows `AGENT_KERNEL.md`'s invariants: no invented policy, no fabricated data source, claims tied to real schema. All table/column names below were read directly from `infra/azure/*.sql` migrations on this branch; none are invented. Per owner decision, **per-skill AI video scoring of movement is PARKED** — this proposal does not build, imply, or route toward machine-scored movement quality from video.

---

## (a) WHAT IT COMPUTES / SHOWS

**There is no single "movement quality score" anywhere in this platform's schema, and this proposal does not create one.** No table has a movement-quality column, a composite index, or a 0–100/1–10 numeric field for "how well an athlete moves." Building one would mean inventing a metric the platform does not store — forbidden by the module stub's own Boundaries section ("Does not invent metrics that are not stored by the platform") and by the honesty doctrine.

What the engine may honestly compute/show, once unlocked, is a **per-athlete evidence ledger**, assembled entirely from rows a human already recorded, never algebraically combined into a synthetic score:

1. **Structured assessment history** — every `pilot.assessments` row for the athlete that is tied to an adopted `pilot.assessment_protocols` row where `measure_kind` is `'skill_rubric'` or `'physical_test'`. Shown as raw `result` values in protocol-defined units, in chronological order (`administered_on`), never re-scaled or averaged.
2. **The protocol's own stated measurement honesty fields, displayed inline every time a result is shown** — `reliability_status`, `validity_status`, `evidence_class`, `boxing_specific`, `minimal_detectable_change`. These default to `'UNVALIDATED - PPBF MUST ESTABLISH'`, `'UNKNOWN'`, `'INSUFFICIENT EVIDENCE'`, and `null` respectively. The engine must show these defaults verbatim, not suppress them — a rubric score displayed without its own reliability caveat is a false precision claim.
3. **Intervention ledger entries scoped to movement/technique problems** — `pilot.intervention_protocols` → `pilot.intervention_executions` → `pilot.intervention_evidence_links` → `pilot.intervention_outcome_reviews` chains for that athlete, shown as what was intended, what was actually delivered (`adherence`, `trained_context`, `actual_exposure`), and the human reviewer's own three-part verdict (`performance_result`, `hypothesis_result`, `learning_signal`) — never a number the engine derives itself.
4. **Raw coach text** — `pilot.coach_observations.note_text` and, only when the org opts in (see Open Question 3), human-**accepted** `pilot.shadow_film_study_proposals.observation_text` (review_state = `'accepted'`), shown as quoted text with its provenance (who wrote/accepted it, when) — never converted into a number.

Where data for any of the above is absent for an athlete, the engine shows an explicit **UNKNOWN / NOT YET RECORDED** state per category — never a zero, a blank chart, or a default "average" value.

---

## (b) DATA PREREQUISITES

### Per athlete
- At least **one active `pilot.assessment_protocols` row** (`active = true`) with `measure_kind in ('skill_rubric','physical_test')` that the org has authored/adopted. (The base `pilot.assessments` table has no protocol requirement structurally — `protocol_id`/`protocol_version` are nullable columns added by a later migration — so this is a real, checkable gate: an assessment with `protocol_id is null` never counts toward unlock, because it carries no stated reliability/validity at all.)
- At least **4 `pilot.assessments` rows** for that athlete with `administered_on is not null` and a non-null `protocol_id`/`protocol_version` referencing the **same** protocol lineage, so there is more than a single data point to show a trajectory.
- Those 4+ administrations must **span at least the protocol's own `retest_interval_days` (or `retest_after_training_hours`) three times over**, i.e. real elapsed time or training exposure consistent with the protocol's stated retest cadence — not four administrations crammed into one week. Where a protocol's `retest_interval_basis` is still the seed default `'TBD - no defensible basis'`, the engine may show raw results but must not imply any of them are comparable to each other.
- If any qualitative/narrative view is offered: at least **one `pilot.intervention_protocols` row** with `athlete_id` set to that athlete (or an org-general protocol actually executed for them) **and** a linked `pilot.intervention_executions` row with `status in ('completed','stopped')` **and** a `pilot.intervention_outcome_reviews` row (`status = 'active'`) — i.e., decision → plan → actual → human verdict, all four stages present, not just a stated intent.

### Per org
- At least **one org-authored `assessment_protocols` row** with `measure_kind in ('skill_rubric','physical_test')` — the platform ships no built-in movement rubric catalog (see Open Question 2), so an org with zero authored protocols has nothing this engine can read, structurally.
- **At least one protocol whose `reliability_status` has been moved off its default `'UNVALIDATED - PPBF MUST ESTABLISH'`** by a real reliability exercise. The schema's own designed path for this is the `second_rater_account_id`/`second_rater_result` columns on `pilot.assessments`, described in the migration as collected "opportunistically... the raw material for weighted kappa and ICC." Until at least one protocol has enough paired second-rater administrations to compute and record a `minimal_detectable_change`, **no observed change in any athlete's result can be distinguished from measurement noise** — this is the hardest prerequisite in this proposal (see summary).
- Athlete-count threshold for org-level activation: at least a minimum number of athletes (owner to set, see Open Question 1) meeting the per-athlete prerequisites above, so org-level views describe an accumulated practice rather than one early adopter.

---

## (c) LOCKED STATE

Before prerequisites are met, athlete and coach views show a plain, non-alarming, non-gamified status panel per athlete, built only from literal counts against the checklist above — never a synthetic "readiness %" or progress score:

- "Movement Quality Engine: not yet available for [athlete]."
- "Assessments recorded under an adopted skill_rubric/physical_test protocol: **0 of 4 needed**." (or the athlete's real count)
- "Protocol adopted: [name] — reliability status: **UNVALIDATED - PPBF MUST ESTABLISH** (org has not yet run a reliability check)." — shown even at 0 assessments, since this is an org-level fact, not an athlete one.
- "Linked intervention record (protocol → execution → review) for movement/technique: **none yet** / **1 in progress, no review yet** / etc." — using the real `status`/`adherence` vocabulary from the schema, never a paraphrase implying more certainty than recorded.
- No streaks, no "X away from unlocking," no urgency framing, no comparison to any other athlete's progress. Counts are literal ratios of real rows to a stated numeric threshold (e.g., "2 of 4") — this is arithmetic on real data, not an invented score, and is the only numeric display permitted pre-unlock.

If the org itself has zero adopted skill_rubric/physical_test protocols, every athlete in that org shows the same locked message with the org-level reason stated plainly: "Your organization has not yet defined a movement-quality assessment protocol."

---

## (d) WHAT UNLOCKS

### Athlete level (richer view of THEIR OWN record only)
Once an individual athlete's prerequisites are met:
- Full chronological list of that athlete's own protocol-linked assessment results, in the protocol's own units, each result permanently paired with that protocol version's stated `reliability_status`/`validity_status`/`evidence_class`/`minimal_detectable_change` — this disclosure is never later hidden even after "unlock."
- That athlete's own intervention protocol → execution → evidence → outcome-review chains for movement/technique problems, shown as the ledger already designed for it — hypothesis, what was planned, what was actually delivered (including deviations and why), and the human's own three-part verdict.
- That athlete's own coach observation text and (only if the org opts in per Open Question 3) accepted film-study observation text, quoted with provenance.
- **Absolutely no cross-athlete comparison, ranking, percentile, team average, or leaderboard in any form** — not in a chart axis, not in a tooltip, not in an export, not as a "compared to peers" caption. This view only ever reads that one athlete's own rows, scoped by the platform's existing `(organization_id, athlete_id)` access checks.

### Org level (earned by accumulating real data)
Once org-level prerequisites are met, org/board views may show **aggregate counts only**, never any per-athlete ranking:
- "N of M athletes have an unlocked Movement Quality view." (a count, not a ranked list)
- "K assessment protocols in use; J of them have moved past default UNVALIDATED reliability status."
- "R movement/technique intervention outcome reviews completed this period," broken out by the schema's own vocabulary (`improved`/`unchanged`/`declined`/`mixed`/`unknown` counts) — never a single "org movement score."
- This org-level view exists to help the org decide where to invest data-collection effort next (e.g., which protocol needs a reliability study), not to rank athletes or coaches against each other.

---

## (e) OPEN QUESTIONS FOR THE OWNER

**1. Who decides a protocol is "reliable enough" to unlock movement-quality views, and how?**
`reliability_status` and `minimal_detectable_change` currently have no computation path anywhere in the codebase — the schema only stores the paired second-rater columns as raw material. Options:
- (a) Require a formal reliability study (real ICC/kappa computed by a qualified person) before any protocol can leave `'UNVALIDATED'`, gated by owner or a named clinical/technical reviewer.
- (b) Allow unlock once ≥N second-rater-paired administrations exist, showing raw rater agreement instead of a computed statistic.
- (c) Never let the engine claim "quality changed" at all — only ever show raw per-administration values with the standing disclaimer, regardless of how much data accumulates.
- (d) Some other threshold the owner specifies.

**2. What defines "movement quality" content, since the platform ships no rubric catalog?**
`assessment_protocols.name`/`quality_measured`/`source_ref` are free text authored per org — there is no canonical FMS-style or joint-by-joint movement screen anywhere in this schema. Options:
- (a) PPBF publishes a reference movement-rubric catalog orgs can adopt as-is.
- (b) Each org must author its own protocol from scratch before this module can do anything for them (current default if nothing else is decided).
- (c) Leave rubric content entirely to individual coach/org judgment with no platform-provided catalog or guidance at all.

**3. Should human-accepted AI film-study observation text be shown inside this module?**
`pilot.shadow_film_study_proposals` already exists (owner-approved 2026-07-31) as accepted-only text observations about footage, separate from the parked video-scoring capability. Options:
- (a) Include accepted observation text as read-only quoted evidence here, with a mandatory "AI-observed, coach-accepted" banner and no numeric transform of any kind.
- (b) Exclude it entirely — keep it exclusively in the existing Film Study review surface, out of this module.
- (c) Require a separate, module-specific owner sign-off before any film-study text appears here, distinct from the original #103 approval.

**4. How much history is required before any evaluative word ("improved"/"declined") may appear at all?**
Options:
- (a) Never use evaluative language in this engine — show only raw chronological values and let the human coach interpret.
- (b) Allow evaluative language only when an observed delta exceeds that protocol's own recorded `minimal_detectable_change` AND ≥2 administrations exist under the same protocol version.
- (c) Only ever surface evaluative language by directly quoting an existing `pilot.intervention_outcome_reviews.performance_result` value (a human's own recorded verdict, from its fixed vocabulary) — the engine itself never computes or infers the verdict.

---

## Summary of hardest gap

The single hardest prerequisite is **establishing `minimal_detectable_change`** for at least one adopted skill_rubric/physical_test protocol. The schema stores the raw material for this (`second_rater_account_id`/`second_rater_result` on `pilot.assessments`) but has no built computation, no populated value anywhere, and defaults every protocol to `'UNVALIDATED - PPBF MUST ESTABLISH'` / `'INSUFFICIENT EVIDENCE'`. Until that real reliability work happens, any two rubric numbers an athlete produces are indistinguishable from measurement noise, and this engine cannot honestly say anything changed — only that a number was recorded.

The place the schema plainly cannot support the module stub's implied intent: there is **no dedicated "movement quality" table or column anywhere** — no joint/segment score, no canonical rubric, no numeric quality field of any kind. Everything this proposal offers is repurposed from the generic `assessment_protocols`/`assessments` pair (org-authored, currently unvalidated by default) and the intervention ledger — never a purpose-built movement-quality data source, because none exists.
