# Engine Unlock Proposal — Module 021 Adaptation Engine

## Status

PROPOSAL — awaiting owner approval. No code.

The module stub (`docs/capabilities/modules/021-adaptation-engine.md`) currently says nothing concrete: `Status: DRAFT`, `Active: false`, and every section (Intent, Dependencies, Acceptance criteria, Implementation notes) is an unfilled placeholder except the Boundaries block inherited from the scaffold template and the 2026-08-16 audit-log entry, which is the operative constraint on everything below: no boxing-validated Banister impulse-response decay constants (tau1/tau2) exist, no youth evidence supports fixed tau values, and fitness-fatigue/impulse-response modeling is RESEARCH_FIRST for this module.

## (a) What the engine computes and shows

**What the name "Adaptation Engine" conventionally implies, and what this proposal refuses to build:** a Banister-style fitness-fatigue model — training load converted to a daily "impulse," passed through two exponential decay functions (fitness time-constant tau1, fatigue time-constant tau2) to produce a predicted performance/adaptation curve. That model requires tau1/tau2 as inputs. The audit log is explicit that no boxing-validated version of those constants exists and none has been validated in youth populations. Per the standing rule from issue #345 ("no algorithm constant changes merely because a paper exists"), this engine will **not** import adult or non-boxing tau values, will **not** invent placeholder tau values, and will **not** produce any single fitness score, fatigue score, "adaptation index," or predicted-readiness number derived from such a model. There is currently no evidence standard under which this platform would compute that curve — see (d) and (e)(1).

**What an honest observational alternative looks like instead:** the engine reads recorded load and recorded outcome from real tables and displays them side by side, on a shared timeline, per athlete. It performs no fitting, no smoothing model, no derived composite. The coach reads the relationship; the platform does not assert one.

Concrete outputs, each naming the real source:

- **Recorded training load, split, never merged into a score:**
  - `pilot.session_load.rpe_physical`, `pilot.session_load.rpe_cognitive` (rated separately by design, `rated_by` = athlete or coach_proxy), joined to `pilot.activity_log.duration_minutes` via `activity_id`. Displayed as two separate time series (physical RPE, cognitive RPE), never multiplied into a session-load number — the header comment on that migration states derived load (sRPE × duration) is deliberately not a stored column because the formula is unvalidated in boxing; this engine will not compute it either, even in a query, without an explicit "unvalidated" label at the point of display if ever shown.
  - `pilot.sparring_exposure.time_under_impact_sec`, `.sparring_type`, `.coach_observed_intensity`, `.coach_observed_head_contact` — displayed as recorded exposure events, never converted into a cumulative risk index or dose (the migration's own header forbids that: "No damage score. No cumulative risk index. No recommended limit.").
- **Recorded outcome, never a modeled trend line:**
  - `pilot.training_attempts.metric_kind`, `.direction`, `.target_value`, `.achieved_value`, `.made`, `.attempted_at` — plotted as make/fail points over time per `metric_kind`, respecting the table's own honesty constraint that a verdict (`made`) only exists where a `target_value` exists.
  - `pilot.assessments` joined to `pilot.assessment_protocols` (`retest_interval_basis`, `reliability_status`, `evidence_class`, `minimal_detectable_change`) — shown with whatever measurement-quality caveats the protocol already carries; this engine adds none of its own and invents no new score.
- **Context that explains gaps, not performance itself:**
  - `pilot.training_holds.status`, `.scope`, `.reason_category`, `.placed_at`, `.lifted_at` — overlaid on the same timeline so a flat or declining outcome line during an active hold reads as "training was paused," not as "adaptation failed."
  - `pilot.intervention_executions` / `pilot.intervention_protocols` / `pilot.intervention_evidence_links` / `pilot.intervention_outcome_reviews` (module 026) — if a protocol targeted the athlete's outcome in that metric, its planned-vs-actual window and its human-reviewed `performance_result`/`hypothesis_result`/`learning_signal` are shown alongside the load/outcome chart, exactly as already recorded; this engine adds no new verdict of its own on top of an existing review.

What it explicitly does **not** compute: any fitness score, fatigue score, adaptation index, predicted-readiness value, recovery-time estimate, or trend-line fit of any kind. It does not smooth, regress, or extrapolate. It does not rank or compare athletes.

## (b) Data prerequisites

### Per athlete

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| Recorded training load | `pilot.session_load.rpe_physical`/`.rpe_cognitive` joined to `pilot.activity_log.duration_minutes` via `activity_id` | ≥ 2 activity occurrences with a matching `session_load` row | no fixed window — any 2 occurrences | Two points are the mathematical floor for a line to exist at all; below that there is nothing to place "side by side" with an outcome, only a single already-visible data point. **OWNER_DECISION:** whether 2 is sufficient or a higher floor (e.g. matching module 020's "last N sessions" pattern) should gate the view, to avoid presenting a two-point line as if it were a meaningful trend to a minor or their coach. |
| Recorded outcome on the same metric | `pilot.training_attempts.metric_kind`, `.target_value`, `.achieved_value`, `.made`, `.attempted_at` | ≥ 2 attempts sharing the same `metric_kind`, on ≥ 2 distinct `attempted_at` dates | must overlap the load window above | A single attempt has no before/after to place next to a load series. Same `metric_kind` is required because a `reps` attempt and a `time_seconds` attempt are not the same quantity and cannot share an axis. Distinct dates (not just distinct rows) stop two attempts logged minutes apart in one sitting from being read as a multi-session trend. **OWNER_DECISION:** the "distinct dates" rule is itself a judgment about what counts as a meaningfully separated observation, not a mathematical fact. |

### Per organization

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| Count of athletes with their own per-athlete minimum met | count derived from the two per-athlete signals above, per `athlete_id`, scoped by `organization_id` | ≥ N athletes meeting the per-athlete minimum before the org view shows even a count | any | Nothing at org level may aggregate load or outcomes across athletes (that would be cross-athlete comparison, which is banned outright). The only honest org-level number is "how many athletes currently have enough of their own record to see their own chart" — and even that count risks re-identifying a small cohort if N is too low. **OWNER_DECISION:** the specific small-cell suppression floor N. No numeric floor exists yet in modules 147/148 (board reporting) to reuse; see open question 3. |
| Intervention ledger completion status | `pilot.intervention_executions.status = 'completed'` joined to `pilot.intervention_outcome_reviews` (any active review) per protocol, scoped by `organization_id` | ≥ 1 completed-and-reviewed execution before a protocol is marked "loop closed" at org level | any | This is an operational fact about process completeness ("has anyone closed the loop on this protocol"), not a modeled outcome — it requires no invented denominator, only a count of rows that already exist. |

## (c) LOCKED state

Before an athlete's own per-athlete prerequisites (b) are met, the athlete and their coach see, on the athlete's own record only:

- "Load data logged: **1 of 2** required sessions with rated effort" (real count of `session_load` rows with matching `activity_log`, over the real threshold above) — action: "Log your effort rating (RPE) after your next session."
- "Outcome data logged on [metric_kind]: **1 of 2** attempts with a target recorded, on **1 of 2** required distinct dates" — action: "Log an attempt with a target the next time this metric is trained."

No percentage of an invented denominator, no XP, no points, no levels, no badge. Progress is always a literal row count against the real minimum in (b). If one signal is met and the other is not, that is shown as two independent counters — meeting the load threshold does not imply anything about the outcome threshold, and the copy does not blend them into one "readiness to unlock" percentage.

At org level, before the org threshold (N athletes) is met: "**[k] of N** athletes have enough of their own recorded history to view their own load/outcome comparison" — again a real count over a real, owner-set N, never a synthesized organization-wide readiness score.

Engagement doctrine observed: the counters exist so an athlete or coach can see their own record accumulate (pride in one's own data), not to gamify completion — there is no reward, streak, or comparison to any other athlete's count.

## (d) What unlocks

### At athlete level (own record only)

Once the per-athlete prerequisites in (b) are met, the athlete (and their coach) can view, for that athlete alone:

- The split load time series (`session_load.rpe_physical`/`.rpe_cognitive`, `sparring_exposure.time_under_impact_sec` by `sparring_type`) plotted against the make/fail outcome series (`training_attempts`) for the same `metric_kind`, on a shared timeline.
- `training_holds` periods overlaid as shaded/annotated gaps.
- Any `intervention_protocols`/`executions`/`evidence_links`/`outcome_reviews` (module 026) touching that athlete and that problem area, shown as already recorded — planned exposure, actual exposure, adherence state, and the human's three-answer review, unedited by this engine.

Nothing here is ranked, scored, or compared to any population, cohort, or other athlete, at any data volume. This is a richer view of the athlete's own recorded history, never a new derived metric.

### At org / coach level

Once the org threshold (N athletes, per (b)) is met, coaches and org admins see only:

- The count "**k of N** athletes have enough recorded history to view their own comparison" (never which athletes, never their individual charts, from this org-level surface — the coach reaches an individual athlete's chart only through that athlete's own record page, under the same access rules that already govern athlete data).
- The intervention-ledger completion count ("protocols with a completed, reviewed execution: **x of y**") as an operational process metric, not an outcome metric.

Board and public surfaces receive **nothing** from this module beyond, at most, the same small-cell-suppressed aggregate count already described — never any individual athlete's load/outcome chart, never any clinical or performance detail, consistent with the playbook rule that board/public never receive individual athlete clinical detail.

### What stays locked forever, regardless of data volume

**The modeled fitness-fatigue adaptation curve (Banister-style, or any equivalent single derived fitness/fatigue/adaptation number produced by fitting decay constants to load history) stays locked permanently, at any data volume, under this proposal.** More rows of `session_load`, `training_attempts`, or `sparring_exposure` — even years of them, even at very large N — never substitute for construct validity. Data volume answers "do we have enough recorded history to show it honestly," never "is the underlying model valid for this population." Unlocking a modeled curve is not a data-threshold question at all; it is a research/evidence-standard question that this module cannot answer for itself. See (e)(1) for what would have to change first, and note that even then, the decision to unlock is an owner/research decision, not something this engine's own accumulating row counts can trigger.

## (e) Open questions for the owner

1. **RESEARCH_FIRST — what evidence standard would ever justify a modeled adaptation output (fitness-fatigue/impulse-response, tau1/tau2 or equivalent) for youth boxers, and who certifies it?**
   - Option A — Never: permanently refuse impulse-response/Banister-style modeling for this population regardless of future published literature, since no youth-boxing-validated constants are likely to ever exist for this specific population at this specific gym. This extends issue #345's rule to its logical end.
   - Option B — Conditional external gate: only if a boxing-specific, youth-population study (peer-reviewed, ideally replicated, reporting tau1/tau2 with confidence intervals for the relevant age band) is published **and** an outside sports-science or sports-medicine advisor engaged directly by the owner reviews it in writing and signs off before any code is written.
   - Option C — Derive-from-PPBF's-own-data: once PPBF's own longitudinal `training_attempts`/`session_load` history is large enough (multi-year, multi-athlete), estimate decay-like parameters empirically from PPBF's own recorded events rather than importing a published constant — this would make the number "derived from recorded events," consistent with the honesty doctrine, but is a serious independent statistical undertaking (single-case/time-series methodology) that belongs in its own future capability proposal, not folded into module 021.
   - **Recommendation:** adopt B as the standing near-term gate (nothing ships without it), and treat C as the only path that would make a future number genuinely non-invented in this platform's own terms — but as a separate future decision and separate proposal, not bundled into this module's build.

2. **Per-athlete minimum-record thresholds** — are 2 load occurrences and 2 same-metric attempts (on 2 distinct dates) the right floor, or should the bar match module 020's existing "last N sessions" pattern (e.g. N=5) so a minor is never shown a two-point line as if it were a trend?
   - Option A — keep the mathematical floor of 2 (fastest to unlock, weakest as a "trend").
   - Option B — require N=5, reusing module 020's established pattern rather than inventing a new threshold philosophy.
   - Option C — make the floor configurable per organization.
   - **Recommendation:** Option B, for consistency with the one threshold this exact house doctrine has already set elsewhere — OWNER_DECISION either way.

3. **Org-level small-cell suppression floor N** — what count of athletes-with-sufficient-data avoids re-identification risk in a small gym before even a count is shown at org level?
   - Option A — N=5, a common small-cell suppression convention.
   - Option B — reuse whatever numeric floor modules 147/148 (board aggregates) eventually set, once they set one (neither currently specifies a number).
   - Option C — no org-level surface at all for this module until 147/148 establish a floor, to avoid this module inventing a parallel suppression policy.
   - **Recommendation:** Option C — defer the org-level count entirely until 147/148 set a reusable floor, rather than having module 021 invent its own suppression number in isolation.
