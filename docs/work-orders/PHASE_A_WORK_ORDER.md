STATUS (2026-08-15): EXECUTED — Phase A landed as PR #358 (Claude Code implementation lane), cross-reviewed GO by the algorithm lane. Retained verbatim for provenance; the "ChatGPT" addressee reflects the lane assignment at time of writing and is superseded by the Aug 14 pivot.

PPBF SHADOW — PHASE A WORK ORDER (Algorithm Stack v1.1)

Repository:
PunxsyProminence/ppbf-platform

Work from current origin/main in a fresh dedicated branch.

PRECONDITION

PR #337 (pattern-formation contract module: types/policy/evidence/promotion/
lessons + 4 test suites) must be MERGED to main before this work order runs.
If it is not merged, STOP and report — do not re-implement, fork, or build a
parallel version of that module.

TASK ZERO

If docs/SHADOW_ML_ALGORITHM_STACK.md does not exist in the repo, commit the
attached spec file(s) to docs/ verbatim, in their own commit, before any other
work. That doc is the algorithm authority for this order.

MISSION

Implement Algorithm Stack v1.1 sections 2.2–2.5 (Phase A) as pure
deterministic TypeScript on top of the merged PR #337 contract module and the
existing formulas/ engine idiom.

DO NOT START CODING IMMEDIATELY.

READ FIRST

- docs/SHADOW_ML_ALGORITHM_STACK.md (sections 0–6 minimum)
- docs/SHADOW_PATTERN_FORMATION_CONTRACT.md
- the merged PR #337 module and all four of its test suites
- the formulas/ engine: BaselinePolicy injection pattern, ConfidenceState,
  baseline history model, reason-code conventions
- docs/SHADOW_ML_ARCHITECTURE_SPEC.md
- existing test conventions

Search before assuming anything. Current repo code is authoritative for
implementation behavior. If the spec conflicts with repo reality, STOP and
report the conflict instead of improvising.

BUILD — FOUR COMPONENTS

1. Recurrence engine (spec §2.2)
   Beta-Binomial posterior per behavior × athlete; Dirichlet-Multinomial for
   multi-outcome behaviors; empirical-Bayes partial pooling (athlete estimates
   shrink toward gym-level priors, un-shrinking as evidence accumulates).
   Closed-form math only — no sampling libraries, no ML dependencies.
   Outputs: posterior mean + credible interval feeding the
   repeated-occurrence / distinct-sessions evidence dimensions. A wide
   interval is an insufficient-evidence signal with a reason code, never a
   confident value.

2. Sequential promotion mechanic (spec §2.3)
   SPRT-style three-outcome decision — promote candidate / reject / continue
   observing — feeding the existing promotion module's EpistemicState. All
   stopping boundaries come through the policy module: named human, versioned,
   no defaults. The function refuses to run without an injected policy and
   says so with a reason code.

3. Stratified attribution (spec §2.4)
   Per-context-axis contingency analysis (drill type, controlled vs live,
   fatigue band, partner, coach). Fisher's exact within small strata.
   Simpson's-paradox check across strata. Strata disagreement produces
   attribution_unresolved — a successful output, not an error.

4. Baselines & drift (spec §2.5)
   Per athlete-metric EWMA and CUSUM control charts on the existing
   baseline-history model. In/out-of-control states and change flags feed the
   recency dimension and pattern-fade pressure ("older pattern no longer
   appears").

HOUSE RULES (unchanged from the prior sprint)

- pure deterministic functions and tests only
- NO HTTP changes, NO schema migrations, NO auth/authz changes, NO deploy
- never default a missing value; always emit a reason code
- inject and version-stamp all policy; no invented numerical thresholds
  presented as science
- no automated contact/sparring clearance; no automated medical conclusions —
  clearance is an external input this code never computes, infers, or overrides
- no new blended, universal, or readiness scores
- do not retune existing heuristics (classifier thresholds, complexity
  weights, learning-loop mappings, confidence constants, promote/demote
  thresholds) — record concerns, change nothing
- do not build parallel infrastructure — extend the PR #337 module and the
  formulas/ idiom
- do not merge pilot.shadow_decisions (organizational lifecycle) with boxing
  tactical decisions (score / reposition / reset / deny)

TESTS / ACCEPTANCE

- Wire all four components into the existing 15 adversarial scenarios in
  promotion.test.ts. The correct result in most remains abstention or
  continued observation. False promotion is more dangerous than abstention.
- Add per-component cases (spec §6): wide posterior → insufficient evidence;
  drill-only recurrence → context-diversity block; fatigue-only breakdown
  attributed to the load stratum, not the athlete; fading pattern → chart
  flags rather than silent persistence; missing policy → refusal with reason
  code; strata disagreement → attribution_unresolved.
- Full gate green: typecheck, lint, complete jest suite. Report exact counts
  honestly, run from a fully installed environment.

DELIVERABLE

1. What was implemented, file by file, mapped to spec sections
2. Test results with exact counts
3. Anything ambiguous or conflicting, deferred to the owner — not resolved
   silently
4. Open a PR for review. NEVER push to main. NEVER merge. Jason merges.

Do not deploy production.
