# Engine Unlock Proposal — Module 017 Athleticism Engine

## Status
PROPOSAL — awaiting owner approval. No code.

The module stub (`docs/capabilities/modules/017-athleticism-engine.md`) currently says only: Status DRAFT, Active false, Promotion required true, Category `physicalTrainingSystem`; the `Intent` and `Dependencies` sections are empty, `Parent original-25` is `_unmapped_`, and the acceptance-criteria checklist is entirely unchecked. No table, API, role, or audit event has ever been named for this module.

## (a) What the engine computes and shows

**Refused up front:** this module must never compute a single "athleticism score," index, percentile, or any weighted composite across physical qualities (explosiveness, speed, strength, endurance, etc.). "Athleticism" is precisely the word that invites collapsing heterogeneous, incommensurable measurements into one invented number — the same failure mode module 026 refuses for interventions ("does not produce effectiveness scores... or collapse performance/hypothesis/learning into one number") and module 021 refuses for load ("an algorithm constant does not change merely because a paper exists"). No stored table in this platform holds anything resembling an athleticism score, and this proposal does not create one.

**What it can honestly compute**, reusing existing recorded facts only, per metric/test — never merged across them:

- **Attempt-based capacity edges**, one line per `(athlete_id, metric_kind)`, from `pilot.training_attempts`: `metric_kind` (`reps|time_seconds|distance_m|load_kg|rounds|hold_seconds`), `direction` (`at_least|at_most`), `achieved_value`, `target_value`, `made`, `attempted_at`. For each metric, the engine can show the attempt history (a scatter/list, not a curve fit), the most recent made attempt at each target, and — descriptively only, the way `performanceAnalytics.ts` already splits a window in half — whether the achieved values in the newer half of a window sit above or below the older half. It cannot fit a trend line, project a future value, or claim direction is "improvement" in any causal sense.
- **Physical-test administrations**, one line per `(athlete_id, protocol lineage)`, from `pilot.assessments` (extended by the assessment-protocols migration: `protocol_id`, `protocol_version`, `administered_on`, `training_hours_at_administration`, `result` jsonb) joined to `pilot.assessment_protocols` (`quality_measured`, `measure_kind = 'physical_test'`, `retest_interval_days` / `retest_after_training_hours`, `reliability_status`, `evidence_class`, `minimal_detectable_change`). The engine shows the raw recorded results over time for that specific test only, and must display the protocol's own `reliability_status`/`evidence_class`/`minimal_detectable_change` next to any two results it compares — most protocols today default to `'UNVALIDATED - PPBF MUST ESTABLISH'` / `'INSUFFICIENT EVIDENCE'` / `null`, so the honest state for most tests is "cannot say whether this changed beyond measurement error," and the engine must say that rather than imply progress.
- **Context flags only**, never folded into a number: whether an active `pilot.training_holds` row (`scope`, `reason_category`) exists for the athlete (so a capacity dip during a documented hold is never misread as decline), and whether `pilot.sparring_exposure` / `pilot.session_load` rows exist for the same window (so physical output is never read in a vacuum — the module surfaces "a hold was active" or "N sparring-exposure segments logged this window," not a corrected/adjusted score).

**What it explicitly does NOT compute**, because the data or an honest method for it does not exist:

- No single "athletic ability" number, no percentile, no ranking, no "athletic ceiling" or projection.
- No normative comparison. `physical_test_battery.csv` (research seed data, not live data) carries `normative_data_available`/`normative_data_source` fields for some tests, but those norms are adult/non-boxing or general-population literature; importing them as a comparison point is exactly the "imported constant" module 021's audit log forbids. This engine reads only PPBF's own recorded rows.
- No cross-quality synthesis (e.g., "explosiveness" or "speed-strength" derived from combining a jump test and a sprint test) — each recorded metric/test stays a separate line, forever.
- No claim that a change in one metric was *caused* by training, a hold, an intervention, or anything else — module 026's principle ("preceding an outcome is not causing it") applies here identically; this engine has no causal-inference layer at all.
- If a quality the module's name implies — general "athleticism" as a unified trait — cannot be honestly computed from stored data (it cannot: no table stores it, and no defensible method combines heterogeneous units per module 021's own reasoning for refusing `derived load` as a stored column), the engine states that as its own on-screen fact rather than approximating it with a proxy.

## (b) Data prerequisites

**PER ATHLETE**

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| Attempt history for one `metric_kind` | `pilot.training_attempts.athlete_id`, `.metric_kind`, `.achieved_value`, `.target_value`, `.made`, `.attempted_at` | OWNER_DECISION (proposed floor: 6 attempts on the same `metric_kind`) | OWNER_DECISION (proposed floor: within a rolling 90-day window, so a stale attempt from a year ago isn't read as current capacity) | A single attempt is a data point, not an edge — one lucky or unlucky rep tells you nothing about where the athlete's capacity actually sits. `performanceAnalytics.ts` already refuses to read a direction into "halves that are too thin to carry one" (`training_days_early`/`_late`, `readiness_early_count`/`_count`); this engine needs the same floor-on-both-sides discipline before showing any before/after split. The exact count is coaching judgment about noise tolerance per metric, not something this proposal should fix. |
| Physical-test administrations for one protocol lineage | `pilot.assessments.protocol_id`, `.protocol_version`, `.administered_on`, `.result`; `pilot.assessment_protocols.retest_interval_days` / `.retest_after_training_hours` | 2 administrations of the same protocol lineage, spaced at least the protocol's own stored `retest_interval_days`/`retest_after_training_hours` apart | Since the athlete's enrollment or first administration, whichever is later | The assessment-protocols migration header states the reason directly: "Re-testing CMJ every two weeks produces measurement error that reads as improvement." The spacing threshold is not invented here — it is read from whatever the protocol itself already carries (which may be `null`, meaning no defensible interval exists yet; in that case the engine cannot show a comparison at all, only the raw single result). |
| Any qualifying signal present at all | existence check across both tables above | 1 row | any | Distinguishes "no data yet" from "engine ran and found nothing" — the LOCKED state (below) needs to know which case it's in to point the athlete/coach at the right action. |

**PER ORG**

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| Count of athletes with at least one qualifying attempt/test row | `pilot.training_attempts`, `pilot.assessments` grouped by `organization_id` | 1 athlete meeting the per-athlete floor above | current rolling window | Tells coaches/admins whether this engine is usable yet for their org at all — a coverage fact, not a performance fact. |
| Count of qualifying attempts/tests logged per period | same tables, counted, not scored | OWNER_DECISION — is org-level rollout count wanted at all pre-launch, or is athlete-level the only P0 surface (see open question 3) | rolling period, e.g. 28 days to match `PERFORMANCE_WINDOW_DAYS_DEFAULT` in `performanceAnalytics.ts` | Reuses the window convention already established for the coach analytics surface rather than inventing a new one; still a raw count, never averaged into a rating. |
| — no per-athlete detail rolls up past this | — | — | — | Per the playbook ("Board / public never get individual athlete clinical detail") and module 026's boundary ("does not expose anything to athletes or parents [beyond their own]; every [aggregate] surface is staff-only"), org-level output here is strictly a count of *how much data exists*, never any athlete's value, direction, or test result. |

## (c) LOCKED state

Before an athlete/metric meets the per-athlete threshold, the athlete and their coach see:

- **What's missing, named specifically per metric/test** — e.g. "Push-up reps (at_least): 3 of 6 logged attempts in the last 90 days" or "Countermovement jump: 1 of 2 administrations recorded — a comparison needs a second test at least [protocol's stored retest interval] after the first." The denominator is always a real, stored threshold (once the owner sets it), never a percentage bar over a made-up scale.
- **How far along, as a real count over a real threshold** — "3 of 6," never "50%," never a progress ring implying continuous completion of an invented scale.
- **The specific action that produces the missing data** — "Log the next attempt during a session" (points at the existing attempt-recording flow) or "This test is due for retest on [date/training-hours]" (points at the existing `pilot.data_collection_requests` capture-prompt flow already built for exactly this purpose in the assessment-protocols migration).
- If NO qualifying data exists at all for a metric/test, the state is an explicit **UNKNOWN — insufficient data**, never a zero, a blank chart pretending to be empty-by-choice, or a guessed value.

**Engagement doctrine, enforced:** no XP, levels, points, badges, or streak counters attach to this progress count. No variable reward, no "you're so close!" urgency framing, no FOMO timer, no notification cadence designed to induce compulsive logging. The count exists solely so the athlete/coach can see, factually, how far a specific real measurement is from being interpretable — pride in one's own record, not a game loop. This mirrors the doctrine already recorded against gamified framing elsewhere in this codebase (training-holds migration: "a greyed-out rung is how a system tells somebody they are the incomplete version of somebody else" — this module must not create a new greyed-out rung under the athleticism name).

## (d) What unlocks

### At athlete level (own record only)

- Per-metric attempt history: achieved values over time for that one `metric_kind`, each marked made/failed against its own target, plus the current best made value in that metric's direction (heaviest `load_kg` ever made, fastest `time_seconds` ever made, etc.) — framed as "your recorded best," never as a rank or percentile, and never compared to any other athlete.
- Per-test administration history for protocols the athlete has been tested on: raw results over time, the protocol's own reliability/evidence-class caveat shown alongside any two-point comparison, and — only when the per-athlete threshold above is met — the same before/after half-split framing `performanceAnalytics.ts` already uses (directional, not a slope, not a percentage, not a claim of causation).
- Context flags: whether a training hold was active during any shown window, whether sparring-exposure/session-load rows exist for the same window — shown as facts adjacent to the data, not used to silently adjust it.

### At org / coach level

- Coverage-only aggregates: how many athletes have qualifying data logged, how many qualifying attempts/tests were recorded in the current window — for programming and rollout awareness (e.g., "we need more retests scheduled"), never a ranked list of athletes and never an org-wide "average athleticism."
- A coach's own athlete roster can link into each athlete's individual view (identical to the athlete-level view above) under the existing coach-athlete access rule already enforced elsewhere in this codebase — nothing new is granted here; this module inherits the standing role gate rather than defining its own.

### Stays locked forever, regardless of data volume

- Any single composite "athleticism" number, index, percentile, or letter grade — no volume of real data makes a fabricated composite honest; the fix for "not enough data" is never "combine what little exists into one number instead."
- Cross-athlete comparison, ranking, or leaderboard, at athlete, coach, org, or board level, in any form, at any data volume — this is a standing platform-wide rule (training-attempts migration: "NO leaderboard, ranking, or cross-athlete comparison surface may be built on this table"), not a temporary gap.
- Predictive or prognostic claims ("will make X by date Y," "ceiling," "potential") — this module records what happened, never what will happen.
- AI-generated training prescriptions or auto-approved progression/medical decisions derived from this module's output — those remain human coaching decisions per the standing boundary ("Does not auto-approve progression, medical, or board decisions").
- Individual athlete clinical/performance detail surfaced to board or public audiences — board only ever sees the org-level coverage counts above, never a named athlete's value.

## (e) Open questions for the owner

1. **Does 017 have a distinct job separate from its physicalTrainingSystem siblings?** The category list places "13. Physical Capacity Engine," "16. Movement Quality Engine," "17. Athleticism Engine," and "18. Strength Development Engine" adjacent to each other, all equally DRAFT/unmapped, with no distinguishing Intent recorded anywhere for any of them. Building 017 in isolation risks exactly what kernel invariant #2 warns against ("search before creating... check current source and open PRs before adding a table, route, module"). Options:
   - **(a)** Build 017 now, scoped narrowly to "a per-metric/per-test attempt-and-assessment dashboard, general-purpose across qualities not yet claimed by a more specific named engine" — accept some future overlap with 013/16/18 as a known risk to be resolved when those are designed.
   - **(b)** Defer 017 (and flag 013/016/018 for the same review) until a single consolidated design pass draws the boundaries between all four physicalTrainingSystem "quality" engines at once — consistent with the playbook's P3 rule that "advanced engines stay DEFERRED until design review."
   - **(c)** Keep 017 scaffold-only and ask the owner to first name the concrete physical qualities this specific engine must cover that 013/016/018 do not.
   - **Recommendation: (b).** The stub's total absence of an Intent paragraph, combined with three adjacent same-status engines with the same gap, is itself the signal that this needs one boundary-setting decision, not four separate ad hoc scopes.

2. **Minimum-record thresholds for the LOCKED→unlocked transition** (attempts per `metric_kind`, spacing/count for test administrations). Proposed floors above (6 attempts / 90-day window; 2 test administrations spaced by the protocol's own stored interval) are defensible starting points reasoning from noise tolerance, but the exact numbers encode coaching judgment about how much noise is acceptable per metric type — a fast rep count and a max-load lift do not have the same variance. Options:
   - **(a)** Adopt the proposed floors as a uniform starting default across all `metric_kind`s, revisit per-metric after real usage data exists.
   - **(b)** Set per-`metric_kind` thresholds now, before any code ships, based on the owner's own coaching experience with each test type.
   - **(c)** Make the threshold itself a stored, editable-by-admin org setting rather than a hardcoded constant, so different programs can tune it without a code change.
   - **Recommendation: (c)**, with (a)'s numbers as the shipped default — this keeps the number out of application code as a magic constant (matching this codebase's general refusal to hardcode research-borrowed numbers) while still shipping something usable immediately.

3. **Is an org-level coverage aggregate wanted at all in the first slice, or athlete/coach-individual-view only?** Aggregates are where suppression-rule complexity concentrates (module boundary: "Does not expose athlete-level data to board / public aggregates without suppression rules"), and the playbook's P2 priority tier ("Board aggregates only") is explicitly a later wave than P0/P1 individual-athlete value. Options:
   - **(a)** Ship athlete + coach individual-view only in the first slice; add the org coverage count as a separate, later vertical slice once suppression rules for small-N orgs are designed.
   - **(b)** Ship both in the same slice, since the org aggregate here is a count of *data volume*, not of any athlete's values, and arguably carries no suppression risk.
   - **Recommendation: (a)** — smaller first slice, and it avoids having to solve small-org suppression math (an org with two athletes logging data makes "2 athletes have qualifying data" nearly as identifying as naming them) before any athlete-level value has shipped at all.

---

**Summary:** Module 017 would give an athlete and their coach an honest, per-metric/per-test view of that athlete's own recorded training-attempt and physical-test history — explicit capacity edges and raw test trends, never combined into an "athleticism score," ranking, or projection. Its hardest prerequisite is that most physical-test protocols in `pilot.assessment_protocols` today default to `'UNVALIDATED - PPBF MUST ESTABLISH'` reliability and a null `minimal_detectable_change`, so for most tests the honest answer to "did this improve?" is currently "cannot say beyond measurement error" until PPBF establishes its own reliability data. The single most important owner question is whether 017 has any distinct scope at all separate from its three adjacent, equally-undefined physicalTrainingSystem siblings (013 Physical Capacity, 016 Movement Quality, 018 Strength Development) — building it alone risks creating exactly the kind of parallel/duplicate implementation the kernel's "search before creating" invariant exists to prevent.
