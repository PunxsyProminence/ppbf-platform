# Engine Unlock Proposal — Module 015 Energy System Development Engine

## Status

PROPOSAL — awaiting owner approval. No code.

The current module stub (`docs/capabilities/modules/015-energy-system-development-engine.md`) is an empty scaffold: Status DRAFT, Active false, and every section (Intent, Boundaries beyond the three standard lines, Dependencies, Acceptance criteria) unfilled since the 2026-08-03 scaffold commit. Nothing has been built or specified.

## (a) What the engine computes and shows

**What the module's name implies cannot be honestly built.** "Energy System Development" ordinarily means tracking aerobic/anaerobic/alactic capacity, VO2max, lactate threshold, heart-rate recovery, or work:rest ratios calibrated to a specific energy pathway. None of that exists in this schema: no heart-rate table, no VO2/lactate field anywhere in `infra/azure/*.sql`, no energy-system tag on drills (`pilot.drill_library` disciplines are `boxing|wrestling|combatives|conditioning|general` — a discipline, not a pathway), no seeded assessment protocol for any conditioning test (grepped `beep test|cooper|yo-yo|shuttle run|vo2max|aerobic capacity|anaerobic capacity` across every migration and module doc — zero hits). Module 021's audit log already establishes the rule this module inherits: an algorithm constant (or in this case, a physiological classification) does not appear merely because the module's title implies it should. This engine must not invent a proxy for energy-system development. It can only show real, recorded conditioning-relevant training facts.

**What it CAN honestly compute and show**, all athlete-scoped and read-only against existing tables:

- **Conditioning-relevant attempt trend.** `pilot.training_attempts` filtered to `metric_kind in ('time_seconds', 'hold_seconds', 'rounds')`: a plain series of `achieved_value` over `attempted_at` for one `metric_kind` at a time (never mixed units), using the existing `idx_training_attempts_athlete_metric` index. Shows the recorded made/failed edge (`made`, `target_value`, `direction`) exactly as the table defines it — never a smoothed or extrapolated line.
- **Split training load on conditioning-tagged activity.** `pilot.session_load.rpe_physical` (never merged with `rpe_cognitive`, never multiplied into a stored sRPE×duration figure — that table's own comment forbids storing the derived number because the formula is unvalidated in boxing) joined to `pilot.activity_log.duration_minutes` for the same `activity_id`/`athlete_id`, `rated_by` shown so athlete-reported and coach-proxy ratings are never blended silently.
- **Sparring/live conditioned-round exposure.** `pilot.sparring_exposure` where `sparring_type = 'conditioned'`: `time_under_impact_sec`, `coach_observed_intensity`, `stopped_early`/`stop_reason` per segment — a coach-witnessed exposure log, explicitly not a damage score or cumulative-risk index (the table's own header forbids both).
- **Scripted conditioning-block delivery.** `pilot.session_script_blocks` where `block_kind = 'conditioning'` joined to `pilot.session_script_runs.blocks_completed`/`deviation_note` for the matching `script_id`: whether a planned conditioning block was actually delivered, not a dose or difficulty rating.
- **Cross-domain training-hours context.** `pilot.activity_log.duration_minutes`/`activity_domain`/`activity_type` gives volume and recency of attendance around any of the above, since `activity_type` is free text with no fixed vocabulary — a genuine gap, flagged below.
- **Optional, org-defined test path (inert until an owner acts).** If and only if an organization authors its own `pilot.assessment_protocols` row with `measure_kind = 'physical_test'` naming a conditioning-relevant `quality_measured`, `pilot.assessments` rows against that protocol become a legitimate signal. Today no such protocol is seeded anywhere; this path exists in the schema but has zero rows to read. That table already defaults `reliability_status`/`validity_status`/`evidence_class`/`retest_interval_basis` to explicit unvalidated states — this module would inherit those defaults rather than re-deriving its own.

**What this engine does NOT compute, at any data volume:** VO2max, lactate threshold, heart-rate recovery, an aerobic/anaerobic/alactic split or percentage, a "gas tank" or work-capacity score, an energy-system-specific readiness number, any single composite conditioning index, any dose-response or fatigue-decay model (barred by the module 021 RESEARCH_FIRST precedent — no tau/decay constant from adult or non-boxing literature), and no derived sRPE×duration figure as a stored value.

**A structural safety interaction that must gate every surface this engine renders:** `pilot.training_holds.scope` includes `'conditioning_only'` and `'all_training'`. An athlete under an active hold in either scope has a real, current restriction on conditioning work. This engine must read `pilot.training_holds` (status = 'active', scope in ('conditioning_only','all_training')) before rendering any conditioning view and must never render encouragement, "keep going," or progress-framed language while such a hold is active — see open question 5.

## (b) Data prerequisites

**PER ATHLETE**

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| Repeated conditioning-metric attempts (single `metric_kind`) | `pilot.training_attempts` (athlete_id, metric_kind, attempted_at, achieved_value) | ≥ 6 attempts on the SAME metric_kind | across ≥ 3 distinct calendar weeks | One or two points cannot separate a trend from day-to-day noise (sleep, unrelated fatigue, warm-up state); the assessment-protocol migration already encodes this exact logic for retest intervals ("re-testing CMJ every two weeks produces measurement error that reads as improvement"). This module reuses that reasoning rather than inventing new statistics. **The specific numbers 6/3 encode a judgment call — OWNER_DECISION** (see open question 1). |
| Split-load ratings on conditioning-tagged activity | `pilot.session_load` (rpe_physical, rated_by, rated_at) joined `pilot.activity_log` (activity_id, duration_minutes) | ≥ 8 rated sessions | across ≥ 4 weeks | Same noise argument as above, applied to a self/coach-rated scale rather than a measured attempt — needs more points because subjective ratings carry more day-to-day variance than a timed/counted attempt. **OWNER_DECISION** on the exact count. |
| Sparring/live conditioned-round exposure | `pilot.sparring_exposure` (time_under_impact_sec, sparring_type='conditioned') | ≥ 4 logged segments | across ≥ 2 weeks | This is an exposure log, not a fitness score, so the bar is lower: enough rows that "1 segment = your whole record" isn't misleadingly presented as a pattern. **OWNER_DECISION** — this threshold is about disclosure granularity, not statistical validity. |
| Scripted conditioning-block delivery coverage | `pilot.session_script_blocks` (block_kind='conditioning') × `pilot.session_script_runs` (blocks_completed) | ≥ 3 session_script_runs recording a completed conditioning block | any timespan | Confirms the attempt/exposure log actually has plan coverage (catches under-logging) rather than gating a trend; a count-of-3 is a data-integrity floor, not a coaching threshold, so this one is NOT owner-judgment. |

**PER ORG**

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| Count of athletes with a qualifying per-athlete trend (row 1 above) | Derived count only — no new table | ≥ 5 athletes meeting the per-athlete threshold | n/a | Small-cell aggregates are re-identifiable in a small gym roster. **No existing platform-wide suppression k-value was found** — modules 147 (Board Reporting), 148 (Program Outcome Reporting), and 200 (Privacy Tier System) are the modules whose job this number is, and all three are still empty stubs. This module should not invent its own k when three sibling modules exist to own it — see open question 2. **OWNER_DECISION.** |
| Org-wide conditioning-block delivery rate (planned vs. delivered) | `pilot.session_script_blocks` + `pilot.session_script_runs`, org-scoped | ≥ 10 session_script_runs across ≥ 2 distinct `delivered_by_account_id` values | any timespan | A rate computed from one coach's runs is a coach-comparison-by-proxy wearing an org label; requiring ≥ 2 coaches is a structural floor against exactly that, not a statistical one. |
| Org-defined conditioning `assessment_protocols` administrations | `pilot.assessment_protocols` + `pilot.assessments` | Protocol must exist (currently: none do) + ≥ 1 full administration per athlete counted | n/a | Whether such a protocol is ever defined is entirely the owner's/coaching staff's scientific call, gated by the RESEARCH_FIRST rule — this module has nothing to threshold until that protocol exists. **OWNER_DECISION**, see open question 4. |

## (c) LOCKED state

Athlete/parent view, before per-athlete prerequisites are met, shows real counts against real thresholds — never a percentage bar, never XP/points/levels:

> **Conditioning record: not enough logged yet.**
> - Timed/counted conditioning attempts: **3 of 6** logged for this metric (hold_seconds) — spread across 2 of the needed 3 weeks. *Next: log more hold_seconds attempts during conditioning work.*
> - Session load ratings on conditioning activity: **5 of 8** logged, across 3 of the needed 4 weeks. *Next: rate physical RPE after conditioning-tagged sessions.*
> - Conditioned sparring/live rounds: **1 of 4** segments logged, in the current 2-week window. *Next: log conditioned-round segments as they happen.*

Each line is its own real count over its own real threshold; a locked line never blocks an already-unlocked one (an athlete with 6 attempts logged but 0 sparring segments sees the attempt trend unlocked and the sparring line still locked). No streaks, no timers, no variable reward, no comparison to any other athlete's progress — the locked state names only what this athlete has and needs, matching engagement doctrine (pride in one's own record, never compulsion).

Coach/org view, before org prerequisites are met, shows the same real-count shape: "**3 of 5** athletes have a qualifying conditioning-attempt trend" with no names attached below threshold, and no rate/comparison rendered until both the athlete-count and multi-coach floors are met.

## (d) What unlocks

**At athlete level (own record only)**

- Their own conditioning-metric attempt series (`achieved_value` vs `attempted_at`, one `metric_kind` at a time), shown as recorded facts with made/failed markers exactly as `pilot.training_attempts.made` states them.
- Their own split-load history (`rpe_physical` over time) on conditioning-tagged activities — raw values with dates, `rated_by` visible, never merged into one number.
- Their own conditioned-sparring exposure log (`time_under_impact_sec` per segment over time) — an exposure record, not a fitness score.
- A plain factual notice whenever `pilot.training_holds` shows an active or historical hold with scope `conditioning_only`/`all_training` overlapping the shown window — context, never concealment, and never removed by unlock progress.

**Locked forever, regardless of data volume:**
- Any aerobic/anaerobic/alactic split, VO2/lactate estimate, or "gas tank"/work-capacity score — no stored data source exists for these and none is proposed.
- Any single composite conditioning index or derived sRPE×duration figure as a persisted value.
- Any cross-athlete comparison, ranking, percentile, or leaderboard, at any level, for any signal in this module.
- Any AI-generated interpretation beyond restating the recorded facts (no "your conditioning is improving" sentence — only the data points themselves).
- Any auto-suggested training adjustment, progression, or medical/clinical inference.

**At org / coach level**

- Roster-scoped counts: how many of the coach's own athletes (or org-wide for `organization_admin`/`admin`) currently have a qualifying per-athlete trend, and how many currently have an active conditioning-relevant training hold (a safety-coverage view, not a performance view).
- Delivery-coverage view: planned-vs-actually-run conditioning blocks per `pilot.session_script_runs`, org-scoped, gated by the ≥2-coach floor in (b).
- A single suppressed org-wide count-of-counts ("X of Y athletes trending up / flat / down on their own conditioning-attempt metric") only once the org-level athlete-count floor is met — never a named list, never sorted by magnitude.

**Locked forever at org/coach level regardless of data volume:** individual athlete clinical or medical detail to board/public surfaces (standing platform rule); any coach-vs-coach comparison rendered as a ranked or sorted table (a bare per-coach delivery count next to other coaches' counts is a leaderboard by proxy — see open question 3); any AI auto-approval of a progression, medical, or coaching decision derived from this module's output.

## (e) Open questions for the owner

1. **Per-athlete thresholds (6 attempts/3 weeks; 8 ratings/4 weeks; 4 sparring segments/2 weeks).** These are reasoned defaults, not settled coaching judgment. Options: (a) adopt the proposed defaults platform-wide; (b) lower them to reduce lockout time, accepting a noisier trend line; (c) make them per-org configurable from day one. **Recommend (a)** as the initial default with (c) as a fast-follow if a specific org's coaching staff pushes back.

2. **Org-level suppression floor (k-value for small-cell aggregates).** No existing k-value convention was found anywhere in the repo — modules 147, 148, and 200 exist specifically to own this number and are all still empty stubs. Options: (a) this module picks k=5 as a common small-cell floor; (b) this module picks a stricter k=10; (c) this module ships with NO org-level aggregate in v1 and adopts whatever k modules 147/148/200 eventually define, to avoid a second, possibly conflicting, source of truth. **Recommend (c)** — building a suppression rule here duplicates a decision that belongs to three sibling modules whose entire job it is (playbook rule 3: prefer existing primitives over parallel sources of truth; here, "existing" means "assigned," not yet "built").

3. **Should coach-level delivery counts ever be shown side-by-side across coaches?** A bare per-coach delivery-count table is a leaderboard in substance even without a rank column. Options: (a) never show more than one coach's own count to that coach, org totals only for org_admin/admin; (b) show all coaches' counts to org_admin/admin only, explicitly unsorted and unranked; (c) show nothing coach-specific, org totals only, forever. **Recommend (a)** for coaches and (c) for org_admin/admin — the delivery-coverage signal is useful as a safety/coverage check, not as staff evaluation, and this module should not be the place staff performance gets measured.

4. **Whether to build the optional conditioning `assessment_protocols` path at all.** Defining what a conditioning test IS (a timed interval test, a round-recovery protocol, etc.) is coaching/scientific doctrine gated by the RESEARCH_FIRST rule, not something this module should originate. Options: (a) leave it entirely out of v1, revisit only if/when the owner or coaching staff defines a specific protocol; (b) pre-build the schema hook now (harmless, since the table already exists) so a later protocol addition needs no migration, but surface nothing until a protocol exists; (c) do nothing until modules 021/033 (the Banister RESEARCH_FIRST modules) land, on the theory that any physiological modeling should arrive as one reviewed package. **Recommend (a)** — the table already supports this path with zero code changes; there is nothing to pre-build.

5. **Disclosure behavior while a `conditioning_only`/`all_training` hold is active.** This is a safeguarding-disclosure question, not a statistics question. Options: (a) always show the athlete's historical (pre-hold) conditioning record with a plain hold notice banner — a hold doesn't erase the athlete's own history; (b) suppress the entire conditioning view while a hold is active, to avoid any appearance of the platform encouraging conditioning work during a hold; (c) show the historical record but strip all progress-framed language while the hold is active. **Recommend (a) combined with (c)'s language restriction** — show the facts, add the hold notice, and never add encouragement language regardless of hold status, matching the "pride in one's own record, never compulsion" doctrine without hiding a child's own data from them.
