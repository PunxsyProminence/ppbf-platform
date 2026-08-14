# SHADOW pattern formation contract

Status: **implementation-ready contract, unratified policy.** The algorithm is
implemented and tested at `apps/web/src/server/pilot/patterns/`. The
thresholds it applies are **not** ratified and are not shipped as defaults.

This document covers one algorithmic problem:

```
OBSERVATION
  -> PATTERN CANDIDATE
  -> PATTERN
  -> INTERVENTION
  -> HUMAN-REVIEWED OUTCOME
  -> VALIDATED ATHLETE LESSON
```

The goal is for SHADOW to learn from repeated coaching evidence without
letting one rep, one clip, one model output, or one thumbs-up become athlete
truth.

## 1. Semantic boundary

`pilot.shadow_decisions` is the **human-authorized organizational decision
lifecycle** (`shadowDecisions.ts`: recommendation -> decision -> outcome, each
transition carrying a `decided_by_account_id`).

PPBF's in-ring tactical vocabulary — score / reposition / reset / deny — is a
**different concept**. It shares no type with `shadow_decisions` and none with
this module. Nothing in `patterns/` models a tactical call.

## 2. What this module is, and is not

Pure deterministic TypeScript. No DDL, no queries, no HTTP routes, no
authorization changes, no schema migration. Wiring it to real data is a later,
separately-reviewed slice.

It is the **behavioural** sibling of `apps/web/src/server/pilot/formulas/`,
which owns the **numeric** ladder (`NumericObservation -> FormulaResult`). The
two share `ObservationSource` / `SourceQuality` / `ObservationSourceType` so
that "who saw this, and how well" means exactly one thing across SHADOW. They
deliberately do not share an observation type: a formula observation carries a
number and a unit; a behavioural observation carries a named behaviour and the
context it happened in.

Where it maps onto existing primitives rather than duplicating them:

| New concept | Existing primitive it maps onto |
|---|---|
| `ObservationSource`, `SourceQuality` | `formulas/types.ts` — reused verbatim, re-exported |
| `contextId` / session keying | `sessionScriptRuns.ts`, `formulas` `contextId` |
| `taskContextKey` | session script block / drill identity |
| `InterventionMatchState` | `shadow_decision_outcomes.match_state` (`match`/`partial`/`miss`/`confounded`) — reused verbatim |
| `PatternIntervention.decisionId` | `pilot.shadow_decisions.decision_id` |
| abstention-with-reason-code | `formulas` `ValidationReasonCode` / `unavailableReason` idiom |
| injected, version-stamped policy | `formulas/baseline.ts` `BaselinePolicy` |
| lesson -> methodology promotion | `shadowLibrary` human review queue (**not** automated here) |

## 3. The three properties that shape the design

**Abstention is a success.** `INSUFFICIENT_EVIDENCE`, `CONTINUE_OBSERVING`,
`SINGLE_CONTEXT_ONLY`, `ATTRIBUTION_UNRESOLVED`, `CONTESTED` and `RETIRED` are
correct outputs, not failures to compute. Sixteen of the seventeen scenarios in
the adversarial suite are expected to abstain.

**Evidence is a vector, not a score.** `PatternEvidenceSummary` reports counts
and sets — occurrences, distinct sessions, distinct task contexts, distinct
observers, distinct source types, constraint span, fatigue span, video
corroboration, human vs AI interpretation, counterexamples, span in days. There
is deliberately **no** scalar confidence or pattern score, because blending
those dimensions would require weights nobody has measured. A test asserts the
result object has no `score` or `confidence` property.

**The bar is injected, not invented.** `PatternFormationPolicy` is a required
input carrying `policyVersion`, `ratifiedByAccountId` and `ratifiedAt`. The
module ships **no default policy** — a test asserts no export matches
`/DEFAULT|STANDARD|RECOMMENDED/`. Every threshold is therefore attributable to
a named person, and a change of bar is a versioned event rather than a diff to
a constant. The full bar is stamped into each evaluation's `parameters`, so a
stored result records what it was judged against.

### The one place numbers are hard-coded, and why

`assertPatternFormationPolicy` refuses `minimumOccurrences`,
`minimumDistinctSessions` or `minimumDistinctTaskContexts` below **2**, and
`resolveState` hard-blocks a single occurrence regardless of policy.

These are not calibrated numbers. They are the arithmetic reading of
methodology already stated in prose: *"one dramatic event is not a pattern"*
and *"patterns should appear across more than one context before being locked
into an athlete overlay."* Both sentences mean "more than one", and "more than
one" is 2. A policy may set any bar at or above these floors; it may not set
one below, because that would let a single rep, a single day, or a single drill
become an athlete overlay.

**Nothing here claims 2 is the right bar.** It is the lowest bar that is not
self-evidently wrong. Choosing the real one is owner authority (§7).

## 4. Epistemic states and precedence

| State | Meaning | Abstains |
|---|---|---|
| `INSUFFICIENT_EVIDENCE` | Nothing usable, or a single occurrence | yes |
| `CONTESTED` | Observers/video disagree, or counterexamples rival occurrences | yes |
| `ATTRIBUTION_UNRESOLVED` | May not be the athlete's failure | yes |
| `SINGLE_CONTEXT_ONLY` | Recurs, never outside one drill | yes |
| `RETIRED` | Was established; recent evidence no longer supports it | yes |
| `CONTINUE_OBSERVING` | Real signal, ratified bar not yet met | yes |
| `ESTABLISHED_IN_CONTEXT` | Meets the bar — emits a **proposal**, still human-gated | no |

Precedence, and why:

1. Did we see anything usable? → `INSUFFICIENT_EVIDENCE`
2. Do the sources agree it happened? → `CONTESTED`
3. Whose failure was it? → `ATTRIBUTION_UNRESOLVED`
4. Seen outside one drill? → `SINGLE_CONTEXT_ONLY`
5. Is a previously-held pattern still current? → `RETIRED`
6. Is the ratified bar met? → `CONTINUE_OBSERVING`
7. Otherwise → `ESTABLISHED_IN_CONTEXT`

"Did it happen" precedes "whose fault was it", because attributing an event two
observers cannot agree occurred is a category error. Context breadth precedes
staleness so a one-drill artefact is named as an artefact rather than as a
pattern that faded.

`humanReviewRequired` is the literal `true` on every evaluation; no code path
sets it false. `ESTABLISHED_IN_CONTEXT` yields a `PatternPromotionProposal`
whose `requiresHumanAuthorization` is the literal `true`.

## 5. Evidence dimensions actually implemented

Repeated occurrence · distinct sessions · distinct task contexts ·
controlled vs live constraint span · fatigue context span · observer diversity ·
source-type diversity · video corroboration (`computer_vision`) ·
human vs AI interpretation origin · counterexamples (count, ratio, recency,
breadth) · attribution target and ordinal certainty · recency against a
staleness horizon · observation span · transfer · retention.

Two decisions worth naming:

- **Counterexamples never widen diversity.** A counterexample in a third drill
  is evidence *against*; counting it toward `distinctTaskContexts` would make
  disagreement look like breadth.
- **Absence is not improvement.** Post-intervention improvement must be an
  actively recorded counterexample. Nobody may have been looking, the athlete
  may have been absent, and the drill may never have created the opportunity.
  Silence is not evidence of change.

Attribution certainty is **ordinal** (`stated` / `probable` / `uncertain`), not
a float. A coach can honestly say "I'm fairly sure the cue caused this" and
cannot honestly say "0.72"; storing an invented float would let downstream
arithmetic average and threshold a number nobody measured.

## 6. Existing-algorithm audit

Recorded, **not retuned**. Nothing in this branch changes any value below.

| # | Rule (current behaviour) | Location | Supporting evidence | Class | Data needed to improve |
|---|---|---|---|---|---|
| 1 | Quick/Heavy split at complexity `< 0.4` / `>= 0.6`; the 0.4–0.6 band defaults to Quick and flags override | `shadowClassifier.ts:13-14,194-208` | None found. Exported constants, unit tests pin the arithmetic, no calibration data | **heuristic** | Labelled corpus of requests with human "should this have been Heavy Bag" judgements; measure misroute rate at candidate cut points |
| 2 | Word-count buckets add 0.05 / 0.1 / 0.15 / 0.2 at <20 / <50 / <100 / else | `shadowClassifier.ts:47-53` | None found | **heuristic** | Correlation of message length with human-rated complexity |
| 3 | Each complexity keyword adds 0.05, capped at 0.3 (9 patterns) | `shadowClassifier.ts:56-69` | None found | **heuristic** | Per-keyword lift against human complexity ratings |
| 4 | High-risk topic match adds **0.6** — alone enough to force Heavy Bag | `shadowClassifier.ts:34-42,72-74` | Comment states intent ("elevated to Heavy Bag baseline"); the value is chosen to exceed the 0.6 gate | **policy** (safety escalation) | None — this is a deliberate fail-safe, not a measurement. Worth re-expressing as an explicit boolean escalation rather than a magic number that happens to clear a threshold |
| 5 | Role baseline adjustment: coach +0.15, admin/org_admin +0.1, platform_owner/staff +0.05, parent/board 0, athlete/volunteer −0.05 | `shadowClassifier.ts:79-92` | None found | **heuristic** | Per-role distribution of human-rated complexity |
| 6 | Classification `confidence` = `max(1 − complexity, 0.8)` for Quick, `min(complexity, 1.0)` for Heavy, `0.5` at the boundary | `shadowClassifier.ts:196-206` | None found. This number is *reported to users* | **heuristic** | Calibration study: does reported confidence predict misroute rate? Until then it is a restatement of `complexity`, not a confidence |
| 7 | Outcome→effectiveness map: thumbs_up 1.0, followed_advice 0.9, asked_followup 0.7, session_ended 0.5, ignored_advice 0.3, thumbs_down 0.1, escalated 0.0 | `shadowLearningLoop.ts:578-589` | None found. No test asserts any value in this map | **heuristic** | See **D6** — five of the seven values are unreachable in production, so most of this map has never run |
| 8 | Library proposal: effectiveness `>= 0.75` → promote, `< 0.4` → demote, else retain | `shadowLearningLoop.ts:388-393` | None found. **The code disagrees with the spec**: `SHADOW_ML_ARCHITECTURE_SPEC.md:455-458` specifies promote at `> 80` (0.80), demote at `< 30` (0.30), plus a 30–50 "add context markers" band the code has no equivalent for | **heuristic, spec-divergent** | Reconcile code and spec first — one of them is wrong and nobody has said which. Then measure human agree/override rate on proposals. See **D6**: the `retain` band is structurally unreachable |
| 9 | Profile fact confidences: `engaged_topic_*` 0.8 (followed_advice) / 0.6, `prefers_deep_analysis` 0.75, `asks_follow_up_questions` 0.7 | `shadowLearningLoop.ts:345-374` | None found | **heuristic** | Written as truth into `remembered_facts` and never decayed (**D2**). In production the `engaged_topic_*` ternary **always** yields 0.6 and `asks_follow_up_questions` never fires (**D6**) |
| 10 | Profile keeps the top **20** facts by confidence, pruning the rest | `shadowUserProfile.ts:93-96` | None found | **heuristic** | Prompt-budget measurement; also: pruning by confidence silently deletes low-confidence *disconfirming* facts |
| 11 | Effectiveness category→score: improved 1, neutral 0.5, degraded 0, unknown **null** | `shadowMetrics.ts:42-47` | `unknown → null` is correct and deliberate (no fake zero) | **heuristic** (the 0.5) / **sound** (the null) | Same as #7 |
| 12 | Evidence tier: `VERIFIED EVIDENCE` + `authority_tier <= 2` + boxing-specific → PROVEN; `<= 3` → EMERGING; contested/hypothesis/interpretation → EXPERIMENTAL | `shadowEvidenceTier.ts:64-104` | **Yes** — `EVIDENCE_TIER_SPEC.md`, and the comment records verification against the real 1,193-chunk corpus producing the claimed 115/796/227/55 distribution | **policy, corpus-verified** | Best-evidenced rule in the SHADOW surface. Leave alone |
| 13 | Multi-citation responses graded by the single strongest citation (`EVIDENCE_CLASS_RANK`) | `shadowEvidenceTier.ts:115-143` | Comment explicitly flags this as a **design decision** the spec left open | **policy (declared)** | Whether "best citation carries the tier" matches reviewer judgement on mixed-quality responses |
| 14 | Evidence bundle caps: 4 items, 900 chars/excerpt, 3,200 chars/bundle | `shadowEvidence.ts:8-10` | None found | **heuristic** (prompt budget) | Retrieval recall vs token cost |
| 15 | Provisional recommendations expire after **72h** | `shadowRecommendations.ts:22` | None found; the lazy-expiry-on-read design is well reasoned | **policy** | Observed coach response latency |
| 16 | Personal baseline: window 8–12, `minimumHistory` **4** (literal type), `adequateHistory` 8–window | `formulas/baseline.ts:13-19,78-119` | Spec-derived; **injected and version-stamped**, validated not hard-coded | **policy, injected** | The model the new `patterns/` policy follows |
| 17 | Smallest worthwhile change: `0.2 × between-athlete SD`, `0.3 × within-athlete CV` | `formulas/primitives.ts:132-158` | Standard sports-science constants (Hopkins) | **empirically calibrated (external literature)** | Cite the source in-code; otherwise leave alone |
| 18 | Formula confidence: `invalid/insufficient/unsupported → INSUFFICIENT`; worst source quality `low` → LOW; `moderate`/fallback/warning → MODERATE; else HIGH | `formulas/engine.ts:73-92` | Rule is structural (derived from validation state and source quality), not a magic number | **sound** | — |

### Algorithmic debt discovered

**D1 — The knowledge ladder is currently a string match.**
`getShadowKnowledgeProjection` (`shadowReadModels.ts:473-514`) assigns
`'Observation' | 'Pattern' | 'Finding' | 'Validated Lesson'` by
substring-matching audit **event names** (`includes('PATTERN')`,
`includes('FINDING')`), and labels anything whose review state is
`approved`/`promoted` a **"Validated Lesson"**. No evidence, no counterexample
check, no attribution, no transfer or retention is consulted. This is the exact
surface the new module exists to give a real basis, and the highest-value place
to wire it in next.

**D2 — Profile facts never decay and never supersede.** `upsertRememberedFact`
writes a confidence and an `updatedAt` and nothing ever revisits either.
"Athlete overlays change as evidence changes" is not currently implemented for
`remembered_facts`.

**D3 — Reported `confidence` is a restatement of `complexity`.** Audit item #6:
users see a number that measures nothing independent.

**D4 — `asked_followup` counts as a positive learning signal** (#7). A
follow-up question is at least as plausibly a sign the first answer was
inadequate.

**D6 — Most of the learning loop is unreachable, and that changes what the
reachable part means.** The only writer of an outcome signal is
`app/api/pilot/shadow/feedback/route.ts:152`:

```ts
const outcomeSignal = body.helpful ? 'thumbs_up' : 'thumbs_down';
```

The client sends a boolean; the server derives exactly two of the seven
`OutcomeSignal` values. `followed_advice`, `asked_followup`, `session_ended`,
`ignored_advice` and `escalated_to_human` appear only in SQL `IN (...)` read
filters (`shadowUnlocks.ts:178,197`, `shadowFeedback.ts:359-362`) — never as a
value anything produces. Verified by tracing every non-test occurrence.

Consequences, none of them visible from reading `shadowLearningLoop.ts` alone:

- Effectiveness is only ever **1.0 or 0.1**. The intermediate scores have never run.
- The `retain` band (`0.4 <= score < 0.75`) is **structurally unreachable** — every library proposal is `promote` or `demote`, so the "leave it alone" outcome cannot occur.
- `outcomeToCategory` never yields `neutral`, so `positiveOutcomeRate` (`shadowMetrics.ts:145`) is a binary thumbs split, not a three-way effectiveness measure.
- The `engaged_topic_*` confidence ternary always yields **0.6**; the 0.8 branch is dead.
- `asks_follow_up_questions` never fires.

The audited thresholds in rows 7–9 are therefore not merely uncalibrated — most
of them have never executed. Calibrating them is meaningless until the feedback
surface emits more than a boolean.

**D7 — Three inconsistent definitions of "a positive outcome"** inside one
file: `shadowLearningLoop.ts:172` (`thumbs_up`, `followed_advice`,
`asked_followup`), `:592` (`asked_followup` is **neutral**, not improved), and
`:303` (`thumbs_up` only). The same signal is positive for fact extraction and
neutral for metrics.

**D8 — `learning-${Date.now()}` defeats idempotency.**
`shadowLearningLoop.ts:474` falls back to a timestamped source-entity id when
`messageId` is blank. `createShadowResearchRequirement` is unique on
`(org, event, entity_type, entity_id)`, so every retry mints a new requirement
row instead of colliding with the existing one.

**D9 — `human_review_required` is written two different ways for the same
approval.** `shadowLearningLoop.ts:157` parameterizes it
(`verificationState !== 'human_reviewed'`, so `false` once approved), while
`:543` writes the literal `true` into `shadow_learning_events` in the same
call. No test asserts the column. One of the two is wrong.

**D10 — ESCALATION: the medical gate is armed by the client.**
`assertMedicalStatusAllowsRecommendation` is the fail-closed guard that blocks
medically sensitive recommendations and decisions unless the athlete has an
explicit `cleared` status. It runs only when the caller sets
`isMedicallySensitive: true`, and that flag is taken **verbatim from the HTTP
request body** with a type check and nothing else:

- `app/api/pilot/shadow/decisions/route.ts:57,73`
- `app/api/pilot/shadow/recommendations/route.ts:73,90`

Nothing on the server infers sensitivity from `decisionText` or
`expectedOutcome`. A client that omits the flag skips the gate entirely, even
for a decision whose text is about return-to-play or sparring clearance.
`shadowRecommendations.test.ts:173-187` pins the not-flagged path as
*intentional*, so this is a deliberate design whose consequence may not have
been intended.

Worth noting: the repo already contains the detector this would need —
`HIGH_RISK_MESSAGE_PATTERNS` (`shadowClassifier.ts:34-42`) matches concussion,
medical clearance, return-to-play, surgery, prescription, weight cut, and
mental-health vocabulary. It is simply not wired to this gate.

**Not changed in this branch.** Medical/safeguarding policy is explicitly out
of scope for this sprint. Flagging for owner decision (§7.6).

**D11 — The classifier's stated rationale does not describe its rule.**
`shadowClassifier.ts:48` says *"Quick queries are typically < 100 chars,
complex ones > 300"*, but line 47 counts **words**
(`message.split(/\s+/).length`), and the buckets are 20/50/100 words. Anyone
tuning the buckets against the comment would be tuning against a unit that
isn't there.

**D12 — Topic detection is first-match-wins and the order is load-bearing.**
`shadowClassifier.ts:104-119` tests `recovery` (`/recover|rest|sleep|.../`)
*before* `medical`, so "concussion recovery protocols" classifies as
`recovery`, not `medical`. `shadowClassifier.test.ts:27` accommodates this by
accepting any of `['medical','recovery','safety']` rather than asserting one.
The ordering has no stated justification.

**D13 — Effectiveness is stored 0–1 and specified 0–100.** The DB column is
`numeric(4,3)`; `SHADOW_ML_ARCHITECTURE_SPEC.md:467,1545` defines
`effectiveness_score` as 0–100 with a `> 75` target at :1510;
`app/api/pilot/shadow/metrics/route.ts:147-150` multiplies by 100 at the API
boundary to reconcile them. Two scales, one name.

**D14 — `MANUAL_OVERRIDE_ROLES` is duplicated as an inline literal.**
`shadowRoleSets.ts:64-69` defines the canonical set, and its own header warns
that copy-pasted role lists are how `platform_owner` previously got locked out
of routes. `shadowClassifier.ts:155` and `:207` each inline the disjunction
instead of importing it.

**D5 — Two unrelated meanings of "evidence" in one namespace.**
`shadowEvidence.ts` is Library/RAG citation evidence; the new module is
coaching-observation evidence. They are genuinely different things. The new
module is namespaced under `patterns/` to keep them apart, but the collision is
a live source of confusion when reading the tree.

## 7. What needs Jason/owner authority

1. **Ratify a `PatternFormationPolicy`.** Nothing can promote until one exists.
   The floors of 2 are a lower bound, not a recommendation.
2. **Ratify an `AthleteLessonPolicy`** — transfer contexts, retention window,
   retention observation count.
3. **Decide whether `requireVideoCorroboration` is on for any behaviour class.**
4. **Decide who may ratify.** The type requires an account id; the
   authorization rule for *which* accounts is not modelled here.
5. **Decide the athlete-overlay write path.** This module proposes; nothing
   currently consumes the proposal, deliberately.
6. **D10 — decide whether the medical gate should stay client-armed.** Not a
   pattern-formation question, but it surfaced during this audit and is the
   highest-severity item found. The options are: keep the current explicit-flag
   design; add server-side inference using the existing
   `HIGH_RISK_MESSAGE_PATTERNS`; or require the flag to be present rather than
   optional. This is a safeguarding decision and was deliberately left
   untouched.

## 8. Deterministic vs LLM-proposable

**Must stay deterministic:** admission and scope checks; every count in the
evidence vector; observer-disagreement and video-contradiction detection;
counterexample ratios; all policy comparisons; state resolution; transfer and
retention; every `humanReviewRequired` / `requiresHumanAuthorization` /
`generalizableToMethodology` value.

**An LLM may propose, for human confirmation:** candidate `behaviourKey`
phrasings (behaviour, not personality); a draft `attribution.target` and
`note`; clustering of raw coach notes into candidate behaviours; natural-language
summaries of an evaluation. Every one of these enters as
`interpretation: 'ai_proposed'`, and under `requireHumanObservation` a candidate
evidenced only by AI-proposed observations can never leave abstention.

**Never LLM:** the promotion decision, the outcome match state, the lesson
validation, and any generalization to methodology.

## 9. Evaluation harness

`apps/web/src/server/pilot/patterns/*.test.ts` — 66 tests, 4 suites, all
passing, no database required.

Adversarial scenarios covered: one bad rep · one spectacular success ·
counterexamples only · repeated in exactly one drill · genuinely repeated
across contexts · fatigue-only breakdown · behaviour disappears when the task is
simplified · coach cue drift · partner role failure · evenly split attribution ·
two coaches disagree · video disagrees with the coach · older pattern no longer
appears · counterevidence after formation · AI-only evidence · single observer ·
controlled-only exposure · intervention that improves the drill but does not
transfer · intervention that transfers and retains · unauthorized intervention ·
unreviewed outcome · confounded outcome · missed outcome · post-intervention
regression · retention not yet testable vs tested and absent.

## 10. What remains unvalidated

- No policy is ratified, so nothing has been run against real athlete data.
- Nothing persists. There is no reader, no writer, and no route.
- `behaviourKey` has no controlled vocabulary; "behaviour not personality" is
  stated in the contract and enforced by review, not by the type system.
- The staleness horizon and retention window are shapes, not measured values.
- Observer-disagreement detection assumes two observers logging the same
  `sessionId` + `taskContextKey`. Whether coaches will actually log that way is
  unknown and is the main real-world risk to the `CONTESTED` path.

## 11. Recommended next algorithm sprint

In priority order. Each is independently shippable.

**N1 — Give D1 a real basis (highest value).** Replace the event-name substring
match in `getShadowKnowledgeProjection` with the epistemic state from
`evaluatePatternCandidate`. This is the change that makes the whole ladder
mean something in the UI. It needs a persistence slice first (N2), or an
interim read-through that computes on the fly for a small candidate set.

**N2 — Persistence, read-only first.** A `behaviour_observations` table and a
candidate-evaluation snapshot table, following
`shadow_formula_baseline_snapshots`' immutable-snapshot-keyed-by-calculation-key
pattern (`formulas/baseline.ts`). Write observations before anything reads
them; do not build the writer and the reader in one PR.

**N3 — Capture path.** Observations have to come from somewhere. The natural
source is the existing session-script run surface plus `data_collection_requests`
(`assessmentProtocols.ts`), which already models "go and capture this". The
open design question is how a coach records `taskConstraint`, `fatigueContext`
and `attribution` without adding four fields to every tap.

**N4 — Fix the feedback surface, then calibrate (D6).** Emitting more than a
boolean is a precondition for any calibration of rows 7–9. Until then, do not
tune those numbers — there is nothing to tune against.

**N5 — Athlete overlay supersession (D2).** `remembered_facts` needs decay or
supersession before "overlays change as evidence changes" is true anywhere in
the system. The `RETIRED` state in this module is the behavioural half of that
idea; the profile half does not exist yet.

**N6 — Behaviour vocabulary.** `behaviourKey` is currently free text. A
controlled vocabulary, ideally derived from the drill library's existing
taxonomy, would let counterexamples and occurrences reliably meet on the same
key — which is what the whole counter-evidence path depends on.

Explicitly **not** recommended next: tuning any existing threshold in §6.
Nothing in the audit produced the data required to move one honestly.
