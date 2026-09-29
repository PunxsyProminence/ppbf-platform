# SHADOW ML Algorithm Stack — Selection Spec (v1.1)

**Status:** Accepted (owner green-lit Claude to make the calls) · **Date:** 2026-08-14 · **Decider:** Jason Neale
**Implements against:** the pattern-formation contract in PR #337 (`types/policy/evidence/promotion/lessons` + 66 tests) and `SHADOW_ML_ARCHITECTURE_SPEC.md`
**Handoff target:** the app-update lane (ChatGPT) implements; this doc is the algorithm authority.
**v1.1 (2026-08-14):** added §8 Azure deployment map (grant-fit), §9 seed data & priors, §10 force multipliers.

---

## 0. The one design rule

**Multi-type by stage — never all types everywhere.** Every algorithm below is an *evidence producer*. The deterministic promotion contract (PR #337) remains the only decision maker. No model output ever writes athlete truth; it enters as a typed evidence dimension with a tier, provenance, and policy version. That single rule is what makes "use all types" a yes instead of a mess: paradigms don't compete for the verdict, they each light up the dimension they're best at, and the deterministic spine renders judgment — including abstention.

This is also the correct call on pure performance grounds. SHADOW's data regime is small-N (dozens of athletes, per-athlete observation counts in the dozens-to-hundreds per year). At that scale, probabilistic methods with explicit uncertainty beat learned black boxes outright — a deep net trained on this data doesn't just violate the methodology, it *loses*: it memorizes noise, which is precisely the "one dramatic event becomes a pattern" failure.

---

## 1. Paradigm verdicts (the "use all types?" question, answered per type)

| Paradigm | Verdict | Where it lives in SHADOW | Why |
|---|---|---|---|
| **Bayesian / probabilistic** | **CORE SPINE** | Recurrence evidence, baselines, promotion mechanics | Native uncertainty = native abstention. Works from n=1. Conjugate forms are closed-form math → implementable as pure deterministic TypeScript in the `formulas/` idiom. No Python service needed for Phase A. |
| **Supervised learning** | **YES — data-gated** | Quick/Heavy classifier upgrade; future outcome-assist models | Gradient-boosted trees + SHAP once labels cross the gate (§3); logistic regression as the floor below it. Interpretable by requirement — a coach must be able to see *why*. |
| **Unsupervised** | **PARTIAL** | Change-point & anomaly detection: yes. Athlete clustering/archetypes: **no** | Drift detection is unsupervised learning at its best here. Clustering athletes into "types" is the banned personality-labeling rebuilt in math — excluded on methodology, not taste. |
| **Self-supervised / pretrained (deep learning done right at small data)** | **YES** | Text embeddings for lesson retrieval; pose estimation for video | Pretrained models deliver deep-learning capability with **zero** SHADOW training data. This is how a single gym gets neural-net power without the data bill. |
| **Generative / LLM** | **YES — propose-only** | Observation structuring from coach notes; lesson drafting; retrieval explanations | Always enters at the AI-interpretation tier (`shadowEvidenceTier` already has the vocabulary). Never a source of record; a human confirm event is what upgrades it. |
| **Reinforcement learning** | **NO** | — | No simulator, no safe exploration, sample complexity orders of magnitude past gym data. Revisit only if SHADOW someday runs across many organizations. |
| **Deep nets trained on SHADOW tabular data** | **NO (for years)** | — | Data-starved and uninterpretable at this scale. The gate in §3 defines when this ever changes; it won't at single-gym volume. |

---

## 2. The stack, stage by stage

### 2.1 Observation structuring — LLM extraction (propose-only)
- **Algorithm:** LLM with JSON-schema-constrained output, temperature ≈ 0. Parses free-text coach notes / voice memos into structured Observations: behavior, task context, fatigue markers, session linkage.
- **Output contract:** Observation draft, `tier = AI interpretation`, provenance = model + prompt version. A coach confirm/edit event is what makes it an observation of record.
- **Why it wins:** the bottleneck on evidence volume is coach data-entry friction, not math. This multiplies observations without multiplying coach workload.

### 2.2 Recurrence evidence — conjugate Bayesian with hierarchical shrinkage
- **Algorithm:** Beta-Binomial posterior per behavior × athlete ("does this recur beyond chance?"), with empirical-Bayes partial pooling: athlete estimates shrink toward the gym-level prior when individual data is thin, and un-shrink as evidence accumulates. Dirichlet-Multinomial where the behavior has multiple outcomes.
- **Output contract:** posterior mean + credible interval feeding `repeated_occurrence` / `distinct_sessions` dimensions. **Interval width is the mathematics of "insufficient evidence"** — a wide posterior is an abstention signal, not a number to hide.
- **Why it wins:** works honestly from the first observation; closed-form (no sampling, no service); "athlete overlays change as evidence changes" falls out of the update rule for free.

### 2.3 Promotion mechanic — sequential decision (SPRT-style)
- **Algorithm:** Sequential Probability Ratio Test or its Bayesian equivalent. Three outcomes by construction: **promote candidate / reject / continue observing.**
- **Output contract:** feeds the PR #337 promotion module's EpistemicState. All thresholds live in the policy module — named human, versioned, no defaults.
- **Why it wins:** the brief's hardest requirement — "the algorithm must be able to abstain" — is SPRT's *definition*, not a bolt-on. This kills any temptation toward an invented "3 observations = pattern" rule permanently: the stopping boundary is explicit, attributed policy.

### 2.4 Context diversity & attribution — stratified analysis
- **Algorithm:** stratified contingency analysis per context axis (drill type, live vs controlled, fatigue band, partner, coach), Fisher's exact within tiny strata, plus a Simpson's-paradox check across strata.
- **Output contract:** per-stratum results feed `context_diversity` and `attribution`. Strata that disagree → `attribution_unresolved` (already a first-class output). Coach-cue drift and partner-failure cases surface as stratum effects, not athlete effects.
- **Why it wins:** deterministic, explainable, and it operationalizes "separate athlete failure from coach/room/task failure" with arithmetic instead of vibes. Full causal machinery (propensity matching etc.) is overkill at this N; explicit stratification is the honest version.

### 2.5 Baselines & drift — statistical process control + change-point
- **Algorithm:** per athlete-metric EWMA and CUSUM control charts on the existing baseline-history model; Bayesian online change-point detection (Adams–MacKay) as the later upgrade if chart behavior warrants it.
- **Output contract:** in/out-of-control states and detected change-points feed `recency` and drive "older pattern no longer appears" demotion pressure.
- **Why it wins:** SPC was built for exactly this question — *is this within this athlete's normal variation or a real shift?* — and it's small-data-native, deterministic, and chartable in the coach dashboard.

### 2.6 Intervention effect — single-case experimental design (SCED) statistics
- **Algorithm:** the athlete as their own control. Phase A/B comparison with non-overlap effect sizes (NAP or Tau-U); segmented regression (interrupted time series) once series are long enough. **Transfer** is measured as its own stratum contrast (drill vs live, post-intervention). **Retention** is the effect re-measured at lag windows.
- **Output contract:** feeds `intervention_response`, `transfer`, `retention` dimensions on OutcomeEvidence — still gated by human review before anything becomes a ValidatedAthleteLesson.
- **Why it wins:** SCED is the behavioral-science toolkit purpose-built for n=1 questions. Pretending to run population statistics on one athlete is fake precision; this isn't.

### 2.7 Cross-athlete lesson retrieval — embeddings + kNN
- **Algorithm:** text-embedding vectors over validated lessons and observations; cosine-similarity kNN retrieval: "athletes with evidence profiles like this one benefited from lesson X."
- **Output contract:** **proposals only.** Retrieval suggests; a human apply event is the only path onto another athlete's overlay. Plugs into the existing Library/RAG evidence system (`shadowEvidence.ts`) and its tiers — do not conflate retrieval evidence with coaching-observation evidence.
- **Why it wins:** this is where cross-athlete learning happens without violating "validated lessons don't automatically become universal methodology."

### 2.8 Classifier upgrades — gradient-boosted trees, shadow-mode first
- **Algorithm:** keep the existing rule-based Quick/Heavy classifier until labeled data crosses the §3 gate. Then LightGBM (or XGBoost) with SHAP explanations, deployed **shadow-mode**: it runs alongside the rules, disagreements are logged, and it replaces nothing until a human review of the disagreement log says so.
- **Output contract:** classifier outputs carry confidence + SHAP attribution and enter as evidence, same as everything else.
- **Why it wins:** GBTs are the empirically honest winner for small/medium tabular data, and shadow-mode makes the upgrade a measured decision instead of a leap.

### 2.9 Video — pretrained pose estimation (Phase D)
- **Algorithm:** MediaPipe/MoveNet pose estimation → derived kinematic features (guard height, stance width, hip rotation timing) → those features enter §2.2/§2.5 as observations with `source = video`.
- **Output contract:** populates the `video corroboration` dimension already in the contract; "video disagrees with coach interpretation" becomes computable instead of anecdotal.
- **Why it wins:** pretrained, so zero training data needed; video stops being a folder of clips and becomes an independent observer.

---

## 3. Data-volume gates

Registered as **attributed policy entries** (named human, versioned) — engineering rules of thumb, not universal science, consistent with the no-invented-thresholds rule:

| Volume | What earns its keep |
|---|---|
| n ≥ 1 | Conjugate Bayesian updating, control charts, SCED stats |
| n ≥ ~50 per stratum | Stratified tests become meaningful |
| n ≥ ~300–500 labeled rows | Logistic regression floor for learned classifiers |
| n ≥ ~1–5k labeled rows | GBTs (shadow-mode entry point) |
| n ≥ ~10k+ | Deep tabular models — not expected at single-gym scale |

---

## 4. Ensemble semantics

"Ensemble" in SHADOW is **concurrence, never blending.** There is no vote-averaged composite and no universal readiness score (both banned). Promotion requires the *deterministic module* to see concurrent evidence — recurrence posterior AND context diversity AND no unresolved counterexample AND resolved attribution — with the members merely lighting up their dimensions. When members disagree (video vs coach, classifier vs rules, two coaches), the disagreement is **surfaced in layers** per the SHADOW voice spec (data → narrative → evidence → stakes → empowerment), never averaged away.

---

## 5. Build order (for the implementation lane)

- **Phase A — now, zero training data:** §2.2, §2.3, §2.4, §2.5 as pure deterministic TypeScript in the `formulas/` idiom, with tests. These sit directly on the PR #337 contract. No schema migrations required; any new persisted fields go through review.
- **Phase B:** §2.1 LLM extraction and §2.7 retrieval — API-backed, strictly propose-only paths with confirm events.
- **Phase C — data-gated:** §2.8 shadow-mode classifiers; §2.6 formalized SCED reporting in the coach dashboard.
- **Phase D — optional, heavy:** §2.9 video pipeline.

Standing constraints across all phases: every threshold goes through the policy module; reason codes on every abstention; no automated contact/sparring clearance; no automated medical conclusions; the adversarial suite stays green.

---

## 6. Acceptance harness — the safety handle, made portable

The 15 adversarial scenarios in `promotion.test.ts` (one bad rep, one spectacular success, drill-only recurrence, fatigue-only breakdown, coach-cue drift, partner failure, video-vs-coach disagreement, non-transferring intervention, late counterevidence, …) are the acceptance gate for **every component in this spec, regardless of which AI or human wrote it.** Wire each new producer into those cases; the correct answer in most remains abstain / continue observing.

Add per-component cases:
1. Wide posterior → `insufficient evidence` (never a confident dimension value)
2. Drill-only recurrence → context-diversity failure blocks promotion
3. Classifier disagrees with rules → logged for review, never auto-adopted
4. LLM extraction error → AI-interpretation tier prevents it from reaching promotion unconfirmed
5. Retrieval suggests a lesson → nothing changes without a human apply event

A component that passes this harness ships. One that can't, doesn't — that's a safety handle that works identically in either lane, because it's CI, not vigilance.

---

## 7. Routed to the implementation lane

**Medical-gate source of truth.** The audit finding stands: clearance is currently a client-supplied boolean with no server-side verification. Decision and fix now belong to the app-update workflow. The algorithm stack's position is fixed either way: **clearance is an external input; nothing in this spec computes, infers, or overrides it.**

---

## 8. Azure deployment map (grant-fit)

**Routing rule:** the Microsoft nonprofit Azure sponsorship ($2,000/yr, renewable, no rollover) covers **first-party Azure services published by Microsoft only**. Marketplace/partner offerings do not draw from sponsored credits — this includes Claude in Microsoft Foundry, which bills through Azure Marketplace (CCU) and explicitly does not support credit-only sponsored subscriptions. Therefore: **all grant-covered AI calls route to Azure OpenAI.** Anthropic/Foundry remains an out-of-pocket option (a few dollars/month at gym volume) if extraction quality ever warrants it — owner's call, never grant spend.

| Phase | Azure services | Est. run rate | Notes |
|---|---|---|---|
| **A** | App Service (B1) or Container Apps (consumption) for the Next.js app; **Azure Database for PostgreSQL Flexible Server** (Burstable B1ms) with the **pgvector** extension enabled now | ~$15–35/mo | All Phase A math is pure TS in-app — zero ML services. Enable pgvector on day one so Phase B needs no new infra. |
| **B** | **Azure OpenAI**: small chat model with structured/JSON-schema output for note extraction; small embedding model for lesson retrieval. Vectors live in pgvector | ~$1–5/mo | Do **NOT** provision Azure AI Search (~$75/mo standing cost) — pgvector covers kNN at this scale for free. |
| **C** | Train GBTs offline or in an ephemeral Functions/Container Apps job (seconds at this data scale); export **ONNX**; inference via `onnxruntime-node` inside the Next.js server | ~$0 additional | No Azure Machine Learning workspace, no standing compute. The model ships as a file. |
| **D** | **MediaPipe/TF.js pose estimation in the browser**; only derived kinematic features (plus optional short clips) upload; Blob Storage for retained clips | ~$1–5/mo | Raw video of youth athletes never leaves the device by default — privacy posture and budget control in one design. Retention policy required for any stored clips; footage hoarding is the only realistic credit-eater. |

**Budget guardrails:** total realistic run rate ≈ $25–50/mo (~¼ of the grant). Set Cost Management budget alerts at 50% and 80% — the card on file is charged only past the credit, so alerts are the whole defense. Never leave always-on ML compute running. Credits don't roll over; headroom is fine, don't chase spend. Renew the sponsorship annually.

---

## 9. Seed data & priors (cold-start with free/open sources)

**The hard line first:** external data **never becomes a PPBF athlete observation.** It lives in separate reference tables carrying source, license, and retrieval date, and is never joined into athlete truth. Within that line, four legitimate slots:

1. **Priors.** Published youth fitness/athletic norms seed gym-level Bayesian priors, registered through the policy module (named human, versioned, tagged `prior-source: external`). By design these are **self-obsoleting**: empirical-Bayes shrinkage down-weights the seeded prior automatically as real PPBF observations accumulate — the scaffolding removes itself.
2. **Pretrained models — the biggest free databases available.** MediaPipe/MoveNet pose models and text-embedding models carry millions of external training samples imported as frozen capability. Zero SHADOW training data required; this is where "planting" outside data pays off most.
3. **The Library/RAG lane.** Open-access sports science (PubMed Central), NSCA position statements, USA Boxing coaching materials, and LTAD frameworks ingest as **cited, tiered library evidence** through the existing `shadowEvidence` / evidence-tier system. Openly licensed or officially published material only; record citation + license on ingest.
4. **Synthetic golden data.** Generated athlete trajectories with planted ground truth feed the §6 acceptance harness — validation fuel only, never training truth, kept as test fixtures outside production tables.

**Reality note:** boxing-specific open datasets are thin (mostly pro bout records — wrong domain for youth development). Slots 2 and 3 carry the real weight; don't burn time hunting slot-1 boxing data that doesn't exist.

---

## 10. Force multipliers

- **Conformal prediction (Phase C adjunct).** Split-conformal sets wrapped around any learned classifier give distribution-free coverage guarantees; an ambiguous prediction set **is** an abstention, by construction. Cheap, and it extends the abstention ethos into the learned-model era.
- **Active learning (Phase B→C bridge).** An uncertainty-sampling queue surfaces the most informative unlabeled cases for coach labeling first — crosses the §3 data gates several times faster with less coach effort than passive accumulation.
- **Session-RPE load capture (Phase A data capture).** Athlete-rated effort (0–10) × session minutes = session load; free, validated sports-science practice that turns the fatigue stratification axis from a subjective code into a number. Cheap HR straps are a later upgrade, not a prerequisite.
- **Structured entry vocabulary (Phase A/B).** Controlled tags on quick-tap observation forms so data is born analyzable — improves stratification power and embedding quality more than any downstream algorithm change.
- **Per-domain paired ratings (optional, Phase C+).** Glicko/TrueSkill-style opponent-adjusted ratings for sparring/drill outcomes — the only honest way to compare performance across different partners. Evidence dimension only; never clearance, never a blended readiness score.
