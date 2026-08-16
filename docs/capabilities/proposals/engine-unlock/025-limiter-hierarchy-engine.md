# Engine Unlock Proposal — Module 025 Limiter Hierarchy Engine

## Status

PROPOSAL — awaiting owner approval. No code.

The module stub (`docs/capabilities/modules/025-limiter-hierarchy-engine.md`) currently says nothing concrete: `Status: DRAFT`, `Active: false`, every section (Intent, Dependencies, Acceptance criteria, Implementation notes) is an unfilled placeholder, and the only Audit log entry is the scaffold-creation stub from 2026-08-03. `PPBF_CAPABILITIES.json` supplies nothing beyond the bare name, positioned between "24. Session Outcome Engine" and "26. Intervention Tracking Engine" in the Physical Training System group.

## (a) What the engine computes and shows

**What the name conventionally implies, and what this proposal refuses to build:** a single computed "priority score" or composite weakness index that blends gap type, severity, and evidence into one number and orders an athlete's weaknesses by it. That would invent a metric this platform does not store and would assert a coaching judgment (which weakness matters most) as if it were arithmetic. This engine does not compute that.

**What already exists and this engine reuses rather than duplicates — the gap-suggestion surface (module 171 / `progressionSuggestions.ts`):** `pilot.progression_gaps` already stores, per confirmed gap, `gap_type` (`technique`/`strength`/`endurance`/`skill`/`mental`/`tactical`), `severity` (`critical`/`high`/`medium`/`low`), and `status`. Deterministic rules in `apps/web/src/server/pilot/progressionSuggestions.ts` (`deriveSuggestions`) already surface computed *suggestions* to the coach; nothing reaches an athlete until the coach confirms one through the ordinary `POST /api/pilot/progression/gaps` route, at which point it becomes a normal row with a coach-asserted `severity`. Module 111 (Coach Intelligence Engine) already reads `open_gaps` counts from `performanceAnalytics.ts`. This engine adds no new suggestion rule and no new table for gaps themselves — it only adds an honest *presentation layer* over gaps that already exist and are already coach-confirmed.

**Deterministically derivable from recorded evidence (mechanical, no judgment):**
- **Sort order within severity tiers already asserted by a coach.** `severity` is a coach's own judgment call, entered when the coach confirms a gap (or files one manually). The vocabulary (`critical` > `high` > `medium` > `low`) is a fixed, pre-existing ordinal scale — grouping an athlete's own open `pilot.progression_gaps` rows by their own already-stored `severity` value and listing higher tiers first is sorting, not judging. The engine does not decide which gap is `critical`; the coach already did that.
- **Tie-break signal within a tier, shown as evidence, not folded into a score:** `created_at` (how long a gap has been open — `pilot.progression_gaps.created_at`), whether the gap currently has an active `pilot.drill_assignments` row (`status in ('assigned','in_progress')`) and that assignment's `completion_percentage`, and count/kind of the deterministic evidence that produced the original suggestion, where `detected_from = 'progression_suggestion'` and `detection_data` (jsonb, frozen at confirmation time) carries the rule's own numbers (e.g. `readiness_early_avg`/`readiness_late_avg`, `training_days_early`/`training_days_late`, `stalled_count`) — see `progressionSuggestions.ts` `GapSuggestion.evidence`. These are displayed *beside* each gap as its supporting facts, never combined into a single number that outranks severity.
- **Coverage/recency facts:** count of open gaps by type, oldest open gap's age, whether an athlete currently has zero recorded gaps at all.

**What only a coach may assert (never computed):**
- The `severity` value itself (already true today — this engine changes nothing about who sets it).
- Which gap is "really" the priority when two gaps share the same severity tier. The engine does **not** break a tie by inventing a combined score across `gap_type`s (e.g. deciding `strength` outranks `mental`) — that is exactly the kind of invented cross-domain weighting the platform refuses. A tie is shown as a tied group, not silently resolved into a false total order (see open question 3 for the tie-break presentation choice).
- Any claim that the ordered list predicts future performance, or that resolving the top-ranked gap first is more effective than another order — this module carries no efficacy claim, consistent with module 026's refusal to claim causality from sequence.

**What it explicitly does NOT compute:** no composite/weighted priority score; no cross-`gap_type` importance ranking; no severity value of its own (it only sorts the coach's own); no comparison of one athlete's hierarchy against another athlete's, any cohort, or any team/org aggregate; no automatic re-ranking that overrides a coach's stated severity; no linkage of a limiter to a specific `pilot.intervention_protocols` row beyond what a coach files (module 026 remains the record of what was actually tried about it — this engine does not choose or suggest an intervention).

## (b) Data prerequisites

### Per athlete

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| Open, coach-confirmed gaps to order | `pilot.progression_gaps.status in ('identified','assigned','in_progress')`, `.gap_type`, `.severity`, `.created_at` | ≥ 2 open gaps | current snapshot — no fixed lookback window, since these are live open rows, not a historical trend | A "hierarchy" implies an order among more than one thing. With 0 gaps there is nothing to show but the existing empty state; with exactly 1 open gap there is one focus area, not a hierarchy — showing a "ranked list of 1" would falsely imply comparative judgment occurred. **OWNER_DECISION:** whether 2 is the right floor, or whether a gap must also have "settled" for a minimum number of days before entering the ordered view (see open question 2) to avoid the list visibly reshuffling every time the coach confirms a fresh suggestion the same week. |
| Supporting evidence to display beside each gap (not to rank with) | `pilot.progression_gaps.detection_data` (frozen at confirmation) where `detected_from = 'progression_suggestion'`; live re-read of `pilot.readiness.score`/`.measured_at` and `pilot.activity_log.occurred_on` (boxing_training, present) via the same aggregates `performanceAnalytics.getPerformanceRollup` already computes | Whatever floor `progressionSuggestions.ts` already requires for the rule that produced the gap (`READINESS_MIN_CHECKINS_PER_HALF = 2` per half; `TRAINING_DAYS_MIN_EARLY = 3`) — reused, not reinvented | Same window `performanceAnalytics` already uses (`PERFORMANCE_WINDOW_DAYS_DEFAULT = 28`) | These thresholds already exist and are pinned by tests (`progressionSuggestions.test.ts`); a new engine inventing a second, different threshold for the same underlying signal would let the suggestion surface and the hierarchy surface silently disagree about what counts as "enough data." Reuse is the point (per `CAPABILITY_BUILD_PLAYBOOK.md` rule 3). |
| Active work against each gap, for completeness display | `pilot.drill_assignments.status`, `.completion_percentage` joined by `gap_id` | 0 is a valid, honestly-shown state ("no drill assigned yet") | current snapshot | Not every open gap has an assignment yet; that absence is itself information the athlete/coach should see plainly, not a blocking prerequisite for the gap to appear in its severity tier. |

### Per organization

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| Count of athletes with an ordered hierarchy available | count of athletes per `organization_id` meeting the per-athlete minimum above, derived from `pilot.progression_gaps` | ≥ N athletes meeting the per-athlete minimum before any org-level number is shown | current snapshot | This module carries no per-athlete detail to org/board level under any condition (playbook rule 5), so the only candidate org-level output is a coverage count ("how many athletes on the roster currently have enough confirmed gaps to see their own ordered view"), and even that risks re-identifying individuals in a very small gym or small coach roster. **OWNER_DECISION:** the small-cell suppression floor N — no numeric floor yet exists in modules 147/148 (board aggregates) to reuse (same open point raised in the module 021 proposal); recommend deferring this to whichever of 147/148 sets one first rather than inventing a third suppression convention (see open question 4). |
| Distribution of `gap_type` across the org, if ever shown at all | `pilot.progression_gaps.gap_type`, grouped, `organization_id`-scoped | same N floor as above | current snapshot | Even an aggregate count broken down by `gap_type` (e.g. "40% of open gaps are `mental`") is a step toward implicit cross-athlete comparison in aggregate form and is **not** recommended by default — flagged as its own owner call in open question 4, not assumed here. |

## (c) LOCKED state

Before an athlete's own per-athlete prerequisite in (b) is met, the athlete and their coach see, on the athlete's own record only, real counts over the real threshold — never XP, points, levels, or a synthesized "readiness to unlock" percentage:

- 0 open gaps: the existing empty state already shown today on `/athlete/progression-intelligence` ("No progression gaps assigned... Your coaches will identify gaps and assign drills to help you improve"). No change — this state is not new to this engine.
- 1 open gap: "You have **1** confirmed focus area right now — not yet enough to show an order of priority. A second confirmed focus area unlocks that view." The individual gap itself remains fully visible exactly as it is shown today (severity badge, description, status) — only the *ordered, multi-gap* view stays locked. The single gap is never withheld or hidden to manufacture a "locked" feeling.
- The action that produces the missing data is explicit and, per the existing suggestion doctrine, never fabricated: "Your coach reviews suggested focus areas each session and confirms the ones that fit — ask what's next." Nothing an athlete does directly creates a second gap (only a coach confirms one), so the locked-state copy points at the coach relationship, not at a fake athlete-side task.
- Framing follows the "your edge, found" doctrine already established for `training_attempts` and the suggestion surface: a single open gap is presented as a current focus, never as a deficiency count or a warning. No red flags, no "you are behind" language, no comparison to any benchmark.

At org level, before the N-athlete floor (owner-set, see (b)) is met: "**[k] of N** athletes on the roster have enough confirmed focus areas to view their own ordered priority list" — a real count over a real, owner-set floor, never an organization-wide "readiness" score.

## (d) What unlocks

### At athlete level (own record only)

Once ≥ 2 open gaps exist for that athlete (per (b)), the athlete (and their coach) can view, for that athlete alone:
- Open gaps grouped into their coach-asserted severity tiers, higher tiers listed first (`critical`, then `high`, then `medium`, then `low`) — a sort of existing data, not a new score.
- Within a tier containing more than one gap, the tie-break presentation from open question 3 (recommended: oldest-open-first, shown plainly as "open longest," not as a hidden second ranking).
- Each gap's existing supporting evidence (the frozen `detection_data` from its confirming suggestion, or "manually identified by your coach" where `detected_from` was not a rule) and its current drill-assignment status, exactly as already stored.

**Whether the athlete should see this ordered, multi-gap view at all — as opposed to the individual unordered gap cards already shown today — is deliberately left open, not decided by this proposal.** See open question 1. This is the single largest judgment call in this proposal: an explicit rank order ("this is your #1 weakness") is a heavier claim to place in front of a minor than an unordered badge, even when every input is coach-asserted and honestly sourced.

### At org / coach level

Once the athlete-level prerequisite is met for a given athlete, that athlete's coach sees the same ordered view the athlete would see (coaches already have full access to their own roster's confirmed gaps today — this changes only presentation, not access). Once the org-level N-floor is met (owner-set), org admins see only the coverage count described in (c) — never which athletes, never any individual athlete's ordered list, from the org-level surface itself; an org admin reaches an individual athlete's ordered view only through that athlete's own record page, under the access rules that already govern athlete data today.

Board and public surfaces receive **nothing** from this module, at any data volume — no per-athlete detail (playbook rule 5) and, per the honesty doctrine's explicit ban, no aggregate that could function as a cross-athlete comparison or leaderboard in any form.

### What stays locked forever, regardless of data volume

- **A single composite priority score blending gap type, severity, and evidence into one number** stays locked permanently. More confirmed gaps, more evidence rows, more elapsed time never substitute for the fact that "which weakness matters most" is a coaching judgment this platform has already assigned to the human `severity` field — collapsing it into a machine-computed number would silently overrule that judgment rather than present it.
- **Any cross-athlete or cross-cohort version of this view** (leaderboards, "athletes with the most critical gaps," team-wide limiter distributions ranked by athlete) stays locked forever, at any N, per the standing no-leaderboard rule.
- **Any claim that resolving the top-ranked limiter first produces better outcomes than another order** stays locked forever — that is an efficacy/causality claim this module has no basis to make, consistent with module 026's refusal to infer causality from sequence.

## (e) Open questions for the owner

1. **Should an athlete see a ranked, multi-gap ordering of their own weaknesses at all, or only the individual (already-shown) unranked gap cards?**
   - Option A — Full ranked view: athlete sees gaps grouped by severity tier, tiers ordered, exactly as described in (d). Most informative; also the most direct "here is your #1 weakness" framing for a minor to read.
   - Option B — Coach/staff-only hierarchy: the ordered, multi-gap view exists only on coach-facing surfaces; the athlete continues to see exactly what `/athlete/progression-intelligence` shows today (individual gap cards with severity badges, unordered), unchanged by this module.
   - Option C — Middle ground: athlete sees gaps grouped by tier (so "critical" items are visually distinguished, which the existing `GapBadge` component already does today) but with no explicit rank number and no framing that names one gap as "the" top priority — closer to today's page with better grouping than to a true ranked list.
   - **Recommendation:** Option C as the default if any change ships at all, with Option B as the safe fallback if the owner is not confident even grouping-without-numbering is appropriate for this population. Option A is not recommended as a default given the subjects are minors and severity, while coach-asserted, can still be wrong or stale.

2. **Should a newly confirmed gap "settle" for a minimum period before it enters the ordered view, to avoid the list visibly reshuffling every time a coach confirms a suggestion?**
   - Option A — No settle period: any open gap counts immediately (simplest, matches how gaps already display today).
   - Option B — A fixed settle period (e.g. 7 days) between `created_at` and eligibility for the ordered view, reusing the existing `created_at` column with no schema change.
   - Option C — Settle period applies only to suggestion-confirmed gaps (`detected_from = 'progression_suggestion'`), not to gaps a coach files manually from direct observation, since a manually filed gap already carries more deliberate coach judgment at filing time.
   - **Recommendation:** Option B for simplicity, but this is a coaching-workflow preference with no data-driven right answer — OWNER_DECISION either way.

3. **How should a tie within the same severity tier be presented?**
   - Option A — No further ordering: show tied gaps as a visually flat, unordered set within the tier, labeled as such ("also at this level").
   - Option B — Order by `created_at` ascending (oldest open first) — mechanical, transparent, and reuses a column that already exists with no new judgment.
   - Option C — Order by evidence recency (most recently reaffirmed by new supporting data first) — requires re-deriving live evidence per gap rather than only reading the frozen `detection_data`, and risks looking like the engine is silently re-scoring severity through the back door.
   - **Recommendation:** Option B — mechanical, auditable, and does not risk being read as a second hidden ranking dimension the way Option C could.

4. **Should any org-level surface exist for this module at all, beyond the bare coverage count in (c)?**
   - Option A — No org-level surface at all: this module stays entirely per-athlete/per-coach, deferring even the coverage count until modules 147/148 (board aggregates) exist to host it under their own established suppression rules.
   - Option B — Coverage-only count ("k of N athletes have enough confirmed gaps to view their own ordered priority list"), gated behind an owner-set N floor, and nothing else — as described in (b)/(c).
   - Option C — Coverage count plus an org-wide `gap_type` distribution (e.g. "40% of currently open gaps across the roster are `mental`") — flagged here as a distinct, higher-risk option since an aggregate breakdown by type can still function as an implicit comparison surface even without naming athletes, and it is not clear this data is operationally useful to an org admin the way the intervention-ledger completion count is in module 021's proposal.
   - **Recommendation:** Option A, deferring to whichever of 147/148 sets a reusable small-cell floor first, exactly as recommended in the module 021 (Adaptation Engine) proposal for the same underlying problem — avoids this module inventing a fourth parallel suppression convention in the codebase.
