# SHADOW Promotion Policy Sheet — v0 (DRAFT · UNSIGNED)

**Purpose:** the ratification instrument for the injected policy the Phase A promotion mechanic requires. Nothing on this sheet is live until signed. Unsigned policy is not a gap — it is a designed state: the mechanic refuses with `POLICY_ABSENT` and the system abstains, exactly as the contract intends.

**Firewall statement:** no value on this sheet derives from the Elite Boxing research report or any external boxing literature. Provenance for every proposed number is statistical or statistical-process-control convention only. Signing a value converts it into attributable, versioned policy — it does not convert it into science.

---

## Pre-change statement (per session protocol)

1. **Decision being modeled:** whether a PatternCandidate's accumulated evidence justifies promotion to Pattern, rejection, or continued observation. (Downstream gates — intervention-outcome review and ValidatedAthleteLesson creation — remain human-only regardless of anything signed here.)
2. **Evidence available:** none from PPBF production. Zero athlete observations have flowed through this pipeline; only sprint-era test fixtures exist.
3. **Empirically supported:** the *mechanics* — conjugate Bayesian updating, sequential (SPRT-style) decision structure, stratified analysis, EWMA/CUSUM control charts — are established statistics. **No PPBF-specific parameter value is empirically supported yet.**
4. **Policy:** what counts as an observable behavior unit; stopping boundaries; context-diversity floors; counterexample and attribution handling; scope of application.
5. **Heuristic:** every concrete number in Option B below.
6. **Where the algorithm must abstain:** policy unsigned; posterior interval too wide; strata in conflict; counterexample unresolved; attribution unresolved; context-diversity floor unmet.
7. **What requires human ratification:** every parameter on this sheet, by name and date. Lesson validation and anything D10-adjacent are human-only permanently and are not ratifiable here.

---

## Posture Option A — Observe-Only Launch (RECOMMENDED)

**Sign nothing now.** Phase A merges and runs with no promotion policy in force. Every promotion evaluation returns `CONTINUE_OBSERVING` (or `POLICY_ABSENT`) with reason codes, while the system does the real cold-start work: accumulating evidence vectors, per-athlete baselines, context strata, and counterexamples.

Why this is the recommended posture, not a fallback:
- It makes abstention-first a launch condition instead of a slogan.
- It creates zero pressure to invent thresholds "merely to make promotion happen."
- The first signed values then get chosen while looking at real PPBF evidence distributions, which is the only calibration that counts.

**Revisit trigger:** owner-initiated, once real observation flow exists and coaches have reviewed the evidence summaries the system produces. No time-based or count-based trigger is proposed — proposing one would itself be an invented threshold.

---

## Posture Option B — Bootstrap Signature Set

For if/when Jason wants promotion live before local calibration data exists. Each row is a named policy entry; each proposed value is a conservative, convention-borrowed heuristic awaiting signature.

| # | Parameter | Role | Proposed v0 | Class | Provenance | Data that would improve it |
|---|---|---|---|---|---|---|
| P1 | Gym-level prior strength | Shrinkage weight of the gym prior on each athlete posterior | Weak prior ≈ 2 pseudo-observations | Heuristic · unsigned | Small-N statistical practice (weak priors for cold start) | Observed per-behavior base rates once real flow exists |
| P2 | SPRT error tolerances (α, β) | Geometry of promote/reject boundaries | α = 0.05, β = 0.20 | Heuristic · unsigned | Conventional statistical error rates; convention ≠ domain calibration | Observed cost asymmetry of false promotion vs delayed promotion at PPBF |
| P3 | Promotion posterior mass | The "recurs beyond chance" bar | ≥ 0.95 posterior probability of recurrence above baseline | Heuristic · unsigned | Statistical convention | Coach-validated exemplar patterns to calibrate against |
| P4 | Context-diversity floor | Eligibility gate — NOT a sufficiency proof | ≥ 3 distinct sessions AND ≥ 2 distinct task contexts; ≥ 1 controlled and ≥ 1 live context before any overlay-affecting promotion | Heuristic · unsigned | Direct descendant of "one dramatic event is not a pattern" and "patterns should appear across more than one context." **No evidence establishes these counts.** The posterior still governs; meeting the floor proves nothing by itself | Distribution of real context diversity in observed candidates |
| P5 | Counterexample rule | Contested handling | Any unresolved counterexample ⇒ state `CONTESTED`; promotion blocked until human review resolves it or evidence supersedes it | Policy · structural (no number) | Contract requirement | — |
| P6 | Attribution rule | Strata conflict handling | Any stratum disagreement ⇒ `ATTRIBUTION_UNRESOLVED`; promotion blocked | Policy · structural (no number) | Contract requirement | — |
| P7 | EWMA smoothing (λ) | Baseline responsiveness | λ = 0.2 | Heuristic · unsigned | Standard SPC starting value | Per-metric variance from real baselines |
| P8 | CUSUM sensitivity (k, h) | Drift detection | k = 0.5σ, h = 4σ | Heuristic · unsigned | Standard SPC starting values | Per-metric tuning after real data |

**Scope note:** signatures may be scoped. A defensible hybrid: sign P5–P8 everywhere (P5/P6 are structural; P7/P8 only power charts, not promotions) while holding P1–P4 unsigned — which keeps the whole system in Option A posture for promotions but lets baselines and drift detection run warm.

---

## Signature block

- Parameter set version: v0
- Signed by (name): ____________  Date: ____________
- Scope (programs / athlete groups this set governs): ____________
- Entries signed (list parameter #s; unsigned entries remain abstention-forcing): ____________

**Revision rule:** any signed value is revisable at any time; revisions get a new version stamp and the history is kept. Athlete overlays re-evaluate under new policy — evidence is never rewritten to fit it.

**Standing exclusions — not ratifiable on this or any sheet:** intervention-outcome review, ValidatedAthleteLesson creation, lesson→methodology promotion, and the D10 medically-sensitive gating path, which belongs to its own safeguarding lane.
