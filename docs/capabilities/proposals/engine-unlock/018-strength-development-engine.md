# Engine Unlock Proposal — Module 018 Strength Development Engine

## Status

PROPOSAL — awaiting owner approval. No code.

The current module stub (`docs/capabilities/modules/018-strength-development-engine.md`) is scaffold-only: Status DRAFT, Active false, and every section (Intent, Dependencies, Acceptance criteria, Implementation notes) is either blank or generic boilerplate copied to every module ("Does not auto-approve progression, medical, or board decisions" / "Does not invent metrics not stored by the platform"). No table, column, API route, role, or threshold has ever been named for this module. `PPBF_CAPABILITIES.json` carries only the name and category (`physicalTrainingSystem`); there is no seeded intent text anywhere in the repo.

## (a) What the engine computes and shows

The only tables in the schema that unambiguously carry strength-relevant, non-invented facts are `pilot.training_attempts` (failure-first attempt ledger) and, as a secondary cross-reference, `pilot.progression_gaps` (existing coach-authored gap flags, already read by module 001's Passbook — no new table needed).

**Scope finding, stated up front:** `pilot.training_attempts.metric_kind` has six values: `reps, time_seconds, distance_m, load_kg, rounds, hold_seconds`. Only **`load_kg`** (external/resistance load) and **`hold_seconds`** (isometric holds — plank, wall-sit, dead-hang) unambiguously denote strength work. `reps` is used platform-wide for any countable drill (footwork reps, technique reps, strength reps alike) with no category column on the attempt row itself to disambiguate, and `pilot.drill_library.category`/`pilot.drills.category` are free-text with no CHECK-constrained vocabulary and no seed data — nothing in any migration establishes a controlled "this drill is a strength drill" tag. **This engine's honest scope is therefore `metric_kind IN ('load_kg', 'hold_seconds')` only; `reps`/`time_seconds`/`distance_m`/`rounds` are out of scope** because a "strength" attempt cannot be reliably distinguished from a skill/conditioning attempt sharing the same metric_kind. (See open question 1.)

What it computes, per athlete, per `metric_kind` (`load_kg` and `hold_seconds` shown and reasoned about **separately**, never blended):

1. **Attempt ledger** — every row from `pilot.training_attempts` for that athlete/metric_kind: `attempted_at`, `direction`, `target_value`, `achieved_value`, `made`, `context_type`/`context_id` (which session, drill assignment, assessment, or open-floor entry produced it), `recorded_by_account_id`. Raw and chronological, no aggregation.
2. **Capacity edge** — the athlete's highest `achieved_value` among rows where `made = true`, paired with the lowest `target_value` among rows where `made = false` that exceeds it (same `metric_kind`). This is exactly the schema's own design language ("the edge where an athlete fails IS their current capacity") rendered as a UI fact, not a computed model. Labeled **"highest recorded made attempt"**, never "max" or "1RM" — it is a floor-observed value bounded by what has actually been attempted, not an estimate of true capacity.
3. **Attempt-count summary** — `count(*)` grouped by `made` over a selected window: how many attempts were made vs. not-made. A plain tally, not a percentage.
4. **Trend view** — `achieved_value` plotted against `attempted_at` for made attempts. No trendline, no regression, no percent-improvement figure computed by the platform — the coach/athlete reads the plotted points themselves.
5. **Cross-reference to `pilot.progression_gaps`** where `gap_type = 'strength'` for that athlete: `gap_description`, `severity`, `status`, and any linked `pilot.drill_assignments`/`pilot.assignment_completions` rows. Displayed verbatim as an existing coach observation, not scored or weighted by this engine.

**What it does NOT compute** (explicit, because the module's name implies more than the data supports):
- No estimated one-rep max (no Epley/Brzybycki/Lombardi or any adult-literature formula applied to `load_kg`/`achieved_value`).
- No age-, weight-, or sex-normalized strength score, percentile, or "standard" (no such reference table or protocol exists in `pilot.assessment_protocols` today — nothing seeds a strength-testing protocol, so there is no validated instrument to compare against even if one wanted to).
- No composite "strength score" merging `load_kg` and `hold_seconds` into one number — they are physically incomparable and the schema keeps them as separate dimensions on purpose (same design principle as `intervention_protocols.intended_exposure`).
- No load recommendation, next-target suggestion, or training-max prescription of any kind.
- No rate-of-adaptation, no fitness-fatigue modeling (that is module 021/033's explicit RESEARCH_FIRST territory — no boxing-validated constants exist, and this module inherits that refusal by not attempting anything adjacent).
- No cross-athlete comparison, ranking, or leaderboard in any form, at any level.
- If asked "how strong is this athlete" in an absolute, validated sense: the honest answer is **UNKNOWN** — the platform has never run a standardized max-testing protocol, only field attempts against coach-set targets.

## (b) Data prerequisites

### PER ATHLETE

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| Raw ledger exists at all | `pilot.training_attempts.attempt_id` where `athlete_id` = self and `metric_kind IN ('load_kg','hold_seconds')` | 1 | none | A single logged attempt is a real, non-invented fact — "this is what was attempted." Nothing is claimed at n=1 beyond the row itself, so no floor is needed to show it. |
| Capacity edge shown | same table: `made`, `target_value`, `achieved_value` | 1 row with `made = true` **and** 1 row with `made = false` at a higher `target_value`, same `metric_kind` | none | The "edge" concept requires both a make and an adjacent miss to exist. With only makes recorded, there is no edge yet — only a floor with no failure boundary observed. |
| Trend line shown (vs. a bare scatter of dots) | same table: `count(*)` grouped by `metric_kind` | **OWNER_DECISION** (recommended starting default: 6 attempts) | **OWNER_DECISION** (recommended starting default: spanning ≥14 days / ≥3 distinct session dates) | How many data points justify a "trend" framing versus over-reading normal session-to-session noise is a coaching judgment about legibility, not something derivable from the schema. |
| Progression-gap cross-reference shown | `pilot.progression_gaps.gap_id` where `gap_type = 'strength'` and `athlete_id` = self | 1 | none | Surfacing an existing coach-authored row invents nothing at n=1 — it is not this engine's data, only a reference to it. |

### PER ORG

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| Org-level coverage count exists | `count(distinct athlete_id)` from `pilot.training_attempts` where `metric_kind IN ('load_kg','hold_seconds')`, scoped `organization_id` | 1 qualifying athlete | none | A plain completeness count ("N athletes in this org have any strength data") is not a comparison between athletes, so no suppression floor is needed for this single aggregate figure. |
| Org-level roster view becomes visible to staff (any per-athlete-adjacent breakdown, e.g. by coach or team) | same table, broken out by any subgroup | **OWNER_DECISION** — small-cell suppression floor (recommended starting default: do not show any subgroup with fewer than 5 distinct athletes) | none additional | Below a small-N floor, an "aggregate" is functionally identifiable to one or two children. This is exactly the privacy-tier judgment call the playbook assigns to P2 (privacy tiers / write-note limits, #200/#150) — not a number this engine should pick for itself. |
| Open strength-gap queue count | `count(*)` from `pilot.progression_gaps` where `gap_type = 'strength'` and `status != 'completed'`, scoped `organization_id` | 0 (zero is a valid, honest answer) | none | This is an operational triage count for coaches, not a score — showing "0 open" is itself informative and requires no floor. |
| Any org-level "typical range" or distribution framing | — | **Not applicable — see (d): this never unlocks regardless of volume.** | — | Distribution framing is one step from a percentile, which becomes cross-athlete comparison. |

## (c) LOCKED state

Before the per-athlete thresholds in (b) are met, the athlete/coach view for that athlete shows:

- **What's missing, named plainly**: e.g. "No load or hold attempts logged yet" (n=0), or "2 load_kg attempts logged — no failed attempt above your last made weight yet, so no capacity edge to show" (edge prerequisite unmet), or once an owner threshold is set: "4 of 6 logged load_kg attempts — trend view unlocks at 6."
- **Progress is always a real count over a real threshold** drawn straight from `count(*)` in (b) — never a percentage bar, never framed against an invented denominator, and never XP/points/levels/streaks.
- **The specific action that produces the missing data**: "Log your next load_kg or hold_seconds attempt through the existing attempt-recording flow, ideally at or slightly above your last made target, to give the edge a chance to move" — pointing at the real write path into `pilot.training_attempts`, not a vague "keep training" nudge.
- **Engagement doctrine held to exactly**: no variable rewards, no countdown/FOMO timers, no "don't break your streak" language, no comparison to any other athlete's progress. The tone is "here is your own record and what would extend it," never a game state.
- Until an owner sets the OWNER_DECISION thresholds in (b), the trend-line and org-subgroup views stay locked with the copy "not yet configured by your organization" rather than silently picking a number.

## (d) What unlocks

### At athlete level (own record only)

Unlocks, in order, exactly as (b)/(c) describe: raw ledger for `load_kg`/`hold_seconds` → capacity edge → trend view (once owner threshold met) → progression-gap cross-reference. All scoped to the athlete's own `athlete_id`; a coach viewing an athlete sees the same content for that one athlete, never a multi-athlete view from this screen.

**Stays locked forever, regardless of data volume:**
- Any estimated 1RM, strength-standard percentile, or age/weight-normalized score — no amount of logged attempts manufactures a validated testing protocol or an adult-literature formula's applicability to a minor.
- Any load recommendation or "suggested next target" — a human coach sets the next target; this engine never proposes one.
- Any comparison to another athlete, anonymized or not, at any volume of data.
- Any blended `load_kg` + `hold_seconds` composite figure.

### At org / coach level

Unlocks once the PER ORG thresholds in (b) are set and met: a plain coverage count ("N athletes with any strength data"), an open strength-gap queue count from `pilot.progression_gaps`, and — only above the owner-set small-cell floor — subgroup breakdowns (e.g., by coach or team) that never resolve to an individual athlete's figures.

**Stays locked forever, regardless of data volume:**
- Any roster sorted or filterable by strength figures (a leaderboard by any other name).
- Any team/board-level "our athletes are weak/strong in X" narrative generated by this engine — the only such statements the platform ever shows are the ones a coach already wrote into a `progression_gaps.gap_description`.
- Any individual athlete's capacity edge, attempt ledger, or trend surfaced to board/public views — board and public never receive individual athlete detail, full stop, matching the doctrine already enforced in module 026.
- Any AI-generated or AI-approved coaching recommendation about what load, hold time, or progression an athlete should attempt next.

## (e) Open questions for the owner

1. **Should `reps`-metric attempts ever enter this engine's scope?** Today `reps` is shared across all drill types with no controlled category to identify strength-specific ones. Options: (a) keep scope permanently to `load_kg`/`hold_seconds` only (recommended — no schema change, no ambiguity); (b) widen to `reps` only when `context_id` resolves to a `drill_assignment` whose drill has been explicitly coach-tagged as strength (requires adding a controlled vocabulary to `drill_library.category` first — a separate, out-of-scope schema change); (c) never widen, treat bodyweight-rep strength work as permanently unrepresentable until a dedicated exercise/category schema exists. Recommendation: (a) now, revisit (b) only as its own proposal if the owner wants bodyweight strength coverage.

2. **What are the numeric thresholds for the OWNER_DECISION rows in (b)** — per-athlete trend-line minimum (recommended default 6 attempts / 14 days) and per-org small-cell suppression floor (recommended default 5 distinct athletes)? Options: (a) accept the recommended defaults as a conservative starting point, adjustable later; (b) set organization-configurable thresholds (more flexible, more to build/maintain); (c) show every view at any n with no floor (rejected — conflicts with the honesty doctrine's warning against over-reading sparse data as signal). Recommendation: (a).

3. **Should any estimated one-rep max, load-projection, or "for reference only, not a target" figure ever be shown to an athlete or coach**, even clearly labeled as non-prescriptive? This is precisely the adult-literature-import/load-prescription-for-minors line the honesty doctrine forbids, and it is the single most consequential question for this module. Options: (a) never, permanently out of scope for minors — full stop (recommended); (b) allow only behind a per-organization sign-off by a named licensed strength & conditioning professional, with the platform explicit that it generated no part of the number (still carries real risk, still an owner-only call); (c) revisit only if a future, separately-approved research module establishes boxing-youth-validated normative data — and even then, note that 1RM-estimation literature is a distinct body of evidence from the Banister/fitness-fatigue literature module 021 already flagged RESEARCH_FIRST, so that gate lifting would not automatically clear this one. Recommendation: (a).

4. **Should the org-level subgroup-suppression rule in (b) also gate by coach**, i.e., should a single coach ever see a strength-coverage or gap-count breakdown for only the athletes they personally coach, even below the org-wide small-cell floor? This interacts with existing privacy-tier work (playbook P2, #200/#150) that this proposal does not resolve. Options: (a) apply the same org-wide floor uniformly to any subgroup, coach-scoped or not (simplest, most conservative — recommended); (b) let a coach's own-roster view bypass the floor since it's already visible to them through other roster screens; (c) defer this entirely to the existing privacy-tier design work rather than deciding it here. Recommendation: (a) or (c); this should not be decided inside a single-module proposal.

