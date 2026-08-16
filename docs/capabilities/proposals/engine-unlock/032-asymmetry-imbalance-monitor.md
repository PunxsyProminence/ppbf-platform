# Engine Unlock Proposal — Module 032 Asymmetry / Imbalance Monitor

## Status

PROPOSAL — awaiting owner approval. No code.

The module stub (`docs/capabilities/modules/032-asymmetry-imbalance-monitor.md`) currently says almost nothing: Status **DRAFT**, Active `false`, Promotion required `true`, and every content section — Intent, Dependencies, Acceptance criteria, Implementation notes — is empty except boilerplate Boundaries ("does not auto-approve," "does not expose athlete-level data to board/public without suppression," "does not invent metrics not stored by the platform") and a scaffold-script audit row. It is an unfilled placeholder, not a design.

**Headline finding, stated first because it decides everything else: no side-of-body data is recorded anywhere in this schema.** `pilot.training_attempts` — the ledger built specifically to hold "every failure: failed reps, failed time, failed distance" — has no left/right, lead/rear, or limb column at all. `pilot.assessments` / `pilot.assessment_protocols` likewise carry no sidedness field. A repo-wide grep across every file in `infra/azure/*.sql` for stance/orthodox/southpaw/lead/rear/handed/bilateral/unilateral/dominant/asymmetry turns up zero real sided-measurement columns — only unrelated prose uses of those words (curriculum topic `stance_base` in `pilot.athlete_competence`, "side channel," "side by side," grappling `side control`, etc.) and one already-answered decision: `pilot.sparring_exposure` deliberately records `time_under_impact_sec`, not per-limb counts, because round-count was judged too noisy a proxy. This module cannot compute an asymmetry signal today because the platform does not ask coaches to record which side did what.

## (a) What the engine computes and shows

Given the above, in its current schema state the engine computes **nothing**. There is no query that can be written against real columns that would produce a left/right, lead/rear, or affected/unaffected-limb comparison, because no table stores which side an attempt, rep, or assessment result belongs to.

What it explicitly does **not** compute, now or under any future design this proposal would support:

- **Injury risk or pathology.** This platform does not do injury-risk prediction (kernel/doctrine-level boundary, reaffirmed by module 026's sibling doctrine on Banister/quantitative modeling staying RESEARCH_FIRST-gated). An "imbalance flag" that implies elevated injury risk is out of scope regardless of what data exists.
- **A composite asymmetry index/score.** No invented percentage-difference, symmetry ratio, or normalized index derived from adult or non-boxing biomechanics literature. RESEARCH_FIRST applies here exactly as it does to module 032's neighbors: a constant does not change because a paper exists, and no such constant exists for this population regardless.
- **A judgment that stance asymmetry is a problem.** Boxing is asymmetric by design. An orthodox or southpaw athlete's lead/rear difference in jab volume, lead-leg load, or rear-hand power output is technique, not pathology — it is the sport. Any future version of this engine must treat stance-consistent asymmetry as the expected null state, not a deviation to flag. The only thing potentially worth surfacing (once data exists) is a *change in an athlete's own lead/rear pattern relative to their own prior recorded pattern* — never a comparison to a population norm, another athlete, or an imported clinical threshold.
- **Cross-athlete comparison of any kind.** No ranking, no leaderboard, no "more asymmetric than peers" — this is a hard platform-wide rule independent of this module.

## (b) Data prerequisites

### Per athlete

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| Side-tagged training attempts | **MISSING SCHEMA** — `pilot.training_attempts` has no `side`/`limb` column. Would need e.g. `side text check (side in ('lead','rear','left','right','n/a'))` added to `pilot.training_attempts`, populated by whoever logs the attempt (coach, or athlete self-report where permitted) | OWNER_DECISION — needs enough paired lead/rear observations per metric_kind to compare an athlete's own pattern over time, not a single pair | OWNER_DECISION | Cannot be set meaningfully until the column exists and real logging volume is observed; any number picked now would be invented, which the honesty doctrine forbids |
| Side-tagged assessment results | **MISSING SCHEMA** — `pilot.assessments`/`pilot.assessment_protocols` have no side column; `quality_measured` is free text and cannot substitute for a structured field | Same as above | Same as above | Same as above |
| Athlete's own stance (orthodox/southpaw) | **MISSING SCHEMA** — not recorded anywhere in `pilot.athletes` or elsewhere; without it the engine cannot even know which side is "lead" for a given athlete, so a raw left/right split would misclassify orthodox and southpaw athletes identically | N/A until recorded | N/A | Recording stance is a one-time fact, not a threshold — but it is a prerequisite fact this schema also lacks |

### Per org

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| Aggregate rate of side-tagged logging | **MISSING SCHEMA** — depends entirely on the per-athlete columns above existing first; would be a count/percentage of `pilot.training_attempts` rows carrying a non-null side value, org-scoped | OWNER_DECISION | OWNER_DECISION | No org-level number is computable before the underlying per-attempt field exists; and per Boundaries, any org view must stay an aggregate rate of *data completeness*, never a rollup of individual athletes' asymmetry patterns (that would leak athlete-level clinical-adjacent detail into an org view) |
| Per-organization decision on whether sided logging is required or optional | **MISSING SCHEMA / OWNER_DECISION** — no `activity_clearance_requirements`-style policy row exists for this; would need a new org-level toggle if adopted | N/A | N/A | This is a policy fact (does this org's coaching workflow ask for side at all), not a measured signal |

## (c) LOCKED state

What the athlete/coach sees today, and for the foreseeable future until (b) is resolved:

> **Asymmetry / Imbalance Monitor — Not available.**
> This platform does not currently record which side of the body a training attempt or assessment applies to. This view will remain locked until that data exists.
> Progress: **0 of [N] side-tagged attempts recorded** (currently 0 — the field does not exist yet, so the true count is UNKNOWN, not zero-toward-a-goal).
> No action available: there is no data-entry path today that would move this counter, because no schema field exists to write to.

This is a deliberately unusual LOCKED state compared to modules 020/026: those modules were locked behind *volume* of already-collectible data. This module is locked behind an *absent column* — no amount of current coach behavior advances it. The honest LOCKED message must say that plainly rather than implying the athlete or coach can do something today to unlock it (they cannot, until owner decision #1 below is resolved). If the owner adds the column, the LOCKED copy becomes real-count-based: "X of N side-tagged attempts recorded for [metric], across Y sessions" — real counts only, never XP/points/levels, matching the engagement doctrine (pride in one's own record, never compulsion).

## (d) What unlocks

### At athlete level (own record only)

If and only if sided data is added (owner decision #1) and a real volume of an athlete's *own* side-tagged attempts accumulates:

- A view of the athlete's own lead-vs-rear (or left-vs-right, stance-adjusted) attempt outcomes over time, on the same real metrics `pilot.training_attempts` already supports (reps, time, distance, load, rounds, hold time) — never a synthesized "asymmetry score."
- A plain factual statement of an athlete's own pattern change over their own history: e.g., "your rear-leg hold-time attempts have improved faster than your lead-leg ones over your last N sessions" — stated as an observation, not a diagnosis, not a risk flag, and framed explicitly as expected of a stance-based sport rather than a problem.
- Never a numeric index, never a percentage-difference score, never a "your asymmetry is X" statement.

### At org / coach level

- At most, an aggregate count of *how many athletes have any side-tagged data at all* and *how complete* that logging is — a data-completeness metric about the platform's own instrumentation, not about any athlete's body or performance.
- **Never** an org-level roster of "which athletes show asymmetry" — that is individual clinical-adjacent detail and is barred from coach/org aggregate views the same way module 026's evidence stays staff-only-per-athlete rather than rolled into a cross-athlete report.
- **Locked forever, regardless of data volume:** any injury-risk inference, any comparison across athletes, any board/public-facing individual detail, any auto-flagging that triggers a hold or clearance action without a human coach/medical decision in the loop. These are platform-wide boundaries this module cannot request an exception to.

## (e) Open questions for the owner

1. **Should sided (lead/rear or left/right) recording be added to `pilot.training_attempts` (and/or `pilot.assessments`) at all?**
   - Option A: Add a nullable `side` column now, populated opportunistically by coaches who choose to log it (mirrors the `second_rater_result` pattern in `pilot_slice_postgres_assessment_protocols_migration.sql`, which "collects itself from live use rather than requiring a separate research exercise"). Low schema risk, no workflow mandate, but may accumulate too slowly to ever clear a meaningful threshold.
   - Option B: Make it a required field on specific metric_kinds where sidedness is meaningful (e.g., `hold_seconds`, single-limb `reps`), enforced by a CHECK constraint analogous to the existing `made`/`target_value` pairing rule. Faster data accumulation, but adds coach-facing friction to every logged attempt and requires deciding which metric_kinds even have a meaningful "side" (e.g., `distance_m` sprints usually do not).
   - Option C: Do not add it. Retire this module to a permanently out-of-scope / will-not-build state, on the same footing as injury-risk prediction, and remove it from the P3-deferred list rather than carrying it as a perpetually-locked stub.
   - **Recommendation:** Option A. It matches this repo's existing precedent for opportunistic instrumentation (the assessment second-rater pattern), keeps coach workflow friction at zero, and lets the owner observe real accumulation rates before ever committing to a threshold — consistent with RESEARCH_FIRST ("a constant does not change merely because a paper exists," extended here to "a schema requirement does not change merely because a module stub exists").

2. **If sided data is added, must an athlete's stance (orthodox/southpaw) be recorded as a precondition, or can the engine ship on raw left/right without stance context?**
   - Option A: Require stance-on-file before any lead/rear framing is shown; raw left/right-only views are never surfaced without it, to avoid systematically misreading southpaw athletes as "reversed."
   - Option B: Allow raw left/right display with an explicit UNKNOWN-stance disclaimer per athlete, deferring the lead/rear framing until stance is separately captured.
   - **Recommendation:** Option A. The module's own worked doctrine (this proposal, section (a)) treats stance-consistent asymmetry as expected, not exceptional — showing lead/rear framing without knowing stance risks the exact misreading (technique read as problem) the NOTE at the top of this brief was written to prevent.

3. **What volume/timespan threshold clears the athlete-level LOCKED state once the column exists?**
   - Option A: A fixed owner-picked minimum (e.g., N side-tagged attempts per metric over M weeks) treated explicitly as a provisional operating choice, revisited after real usage data comes in — labeled OWNER_DECISION in the UI copy itself, not presented as scientifically derived.
   - Option B: No fixed threshold; show whatever data exists at all times with a per-metric sample-size caveat, and let the coach/athlete judge confidence themselves.
   - **Recommendation:** Option B. This mirrors module 026's stance on abstention as a valid output ("insufficient_evidence" is a first-class answer, not a gate to clear) and avoids the platform inventing a defensible-sounding number for a threshold that, per the honesty doctrine, has no basis to defend.
