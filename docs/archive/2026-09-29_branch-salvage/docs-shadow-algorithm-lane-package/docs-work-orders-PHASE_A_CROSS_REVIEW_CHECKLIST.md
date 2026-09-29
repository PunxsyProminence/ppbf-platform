# PHASE A CROSS-REVIEW CHECKLIST (Algorithm Lane)

**Purpose:** the review the Claude lane runs on ChatGPT's Phase A PR before Jason merges. Each item lists the evidence that satisfies it. This file may be committed to docs/work-orders/ so the implementation lane can self-check against the same bar before opening the PR.

**Inputs required for review:** PR description, full diff (or per-file summary), the deliverable report, and CI results. Claimed numbers are checked against CI, not taken from prose.

## 1. Scope and hygiene
- [ ] Branch cut from main **after** #337 merged; #337's module extended, not forked or re-implemented
- [ ] Diff touches only: the new Phase A module, its tests, docs, AGENTS.md — any edit outside that set is individually declared and justified in the report
- [ ] No lockfile or dependency churn beyond what the report declares; `package.json` diff contains **no new runtime math/ML dependencies** (closed-form only)
- [ ] No Phase B/C/D scope creep: zero LLM calls, embeddings, classifiers, or video code anywhere in the diff

## 2. Spec mapping (Stack v1.1)
- [ ] All four components present and mapped file-by-file to §2.2, §2.3, §2.4, §2.5 in the report
- [ ] No redesign of the algorithm math: Beta-Binomial / Dirichlet-Multinomial conjugate updates as specified; empirical-Bayes shrinkage direction correct (thin data → toward gym prior, un-shrinking as n grows)
- [ ] SPRT-style mechanic has exactly three reachable outcomes — promote / reject / continue observing — feeding the existing EpistemicState, not a parallel one
- [ ] Stratified attribution covers the named axes; strata disagreement yields `attribution_unresolved` as a successful output
- [ ] EWMA + CUSUM sit on the existing baseline-history model; change flags feed recency / pattern-fade — no new baseline store invented

## 3. Constants and policy
- [ ] Scan all new source for numeric literals: every number is (a) injected policy, (b) a mathematical constant, or (c) a test fixture — nothing else
- [ ] No default policy values anywhere; absent policy → refusal with a reason code, and a test proves it
- [ ] No unapproved thresholds; any proposed value ships as a **named, versioned policy entry awaiting Jason's signature**, not as live behavior
- [ ] No retuning of existing heuristics (classifier thresholds, complexity weights, learning-loop mappings, confidence constants, promote/demote thresholds)

## 4. Determinism and idiom
- [ ] Same inputs → same outputs; no clock, randomness, or I/O inside logic paths (injected inputs only)
- [ ] Never defaults a missing value; every abstention and refusal emits a reason code
- [ ] formulas/ house idiom followed: injected + version-stamped policy, provenance carried, human review remains a **recorded** gate

## 5. Protected boundaries
- [ ] No automated medical clearance; no automated sparring/contact clearance — grep confirms clearance is only ever read as an external input, never computed, inferred, or written
- [ ] Human-review gates intact: nothing promotes to ValidatedAthleteLesson or organizational learning without the recorded human step
- [ ] `pilot.shadow_decisions` semantics untouched; boxing tactical vocabulary not merged into it
- [ ] No new blended, universal, or readiness score anywhere
- [ ] **D10 firewall:** the medically-sensitive recommendation gating path — the client-provided sensitivity flag surfaced by the #337 audit — is byte-for-byte untouched: no fix, no redefinition, no relocation, no new readers or writers of the flag, no server-side inference added. Any D10-adjacent change fails review outright; D10 is a separate safety-policy decision awaiting its own owner-opened safeguarding lane

## 6. Research-cargo firewall
- [ ] No constant in code traces to the research report — especially its [AI-H] and contested numbers (e.g., ACWR 0.8–1.3, sparring session counts, phase timelines, rep schemes)
- [ ] The research file sits in docs/research/ with **both header banners intact**, referenced by nothing in src/
- [ ] **#345 boundary:** nothing in the diff conditions algorithm behavior on Research Workspace content, upload, or approval state — research being approved never changes thresholds, weights, model validity, youth applicability, or methodology status

## 7. Infrastructure bounds
- [ ] No HTTP/route changes; no schema or migration files; no auth/authz changes; no deploy or CI-deploy config changes
- [ ] Phase A contains **zero AI/model calls of any kind** — any Azure OpenAI, Anthropic, or Marketplace model call in this diff is an automatic fail (grant routing questions cannot even arise until Phase B)

## 8. Tests and acceptance
- [ ] All four components wired into the existing 15 adversarial scenarios; expected result in most remains abstention / continue observing
- [ ] Per-component cases from spec §6 present: wide posterior → insufficient evidence; drill-only recurrence → context-diversity block; fatigue-only breakdown → load stratum, not athlete; fading pattern → chart flag; missing policy → refusal; strata disagreement → attribution_unresolved
- [ ] Full gate green — typecheck, lint, complete jest suite — with **exact counts in the report that match CI**, run from a fully installed environment
- [ ] No existing test weakened, skipped, or deleted to get to green

## 9. Honesty and deferral
- [ ] Ambiguities and spec↔repo conflicts surfaced in the report per the required format — none resolved silently
- [ ] Deliverable report complete per the work order (files, mapping, counts, deferrals)
- [ ] PR opened; main untouched; nothing merged; nothing deployed
- [ ] Step 2 docs committed with banners intact; AGENTS.md created **with the two-tier scoping preface** (permanent rules vs work-order-scoped rules)

**Disposition rule:** any failed item in §3, §5, §6, or §7 blocks merge outright. Failures elsewhere are returned to the implementation lane with the specific item cited. Passing everything = recommend merge to Jason.
