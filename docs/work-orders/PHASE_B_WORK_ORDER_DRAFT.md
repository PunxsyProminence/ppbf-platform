PPBF SHADOW — PHASE B WORK ORDER (DRAFT · HOLD)

STATUS: DRAFT. DO NOT EXECUTE.
This order is inert until BOTH are true:
(1) the Phase A PR has passed cross-review and Jason has merged it to main;
(2) Jason explicitly hands this order to the implementation lane.
Possession of this file is not authorization.

Repository:
PunxsyProminence/ppbf-platform

Work from current origin/main in a fresh dedicated branch.

PRECONDITIONS

- Phase A (Stack v1.1 §2.2–2.5) merged to main after algorithm-lane
  cross-review.
- Azure OpenAI resource provisioned in the SPONSORED subscription
  (first-party only, per spec §8): one small chat model deployment with
  structured/JSON-schema output, one small embedding model deployment.
  Model selection at execution time from current Azure availability;
  resource creation is cost-bearing and requires Jason's approval.
- pgvector extension enabled on the Postgres Flexible Server.
- AGENTS.md present with the two-tier scoping preface. This order uses
  its exception mechanism below.

MISSION

Implement Algorithm Stack v1.1 §2.1 (LLM observation structuring,
propose-only) and §2.7 (embedding + kNN lesson retrieval, propose-only)
on top of merged Phase A, with tier discipline enforced in code.

PRE-CHANGE STATEMENT (session protocol, condensed)

Decision modeled: none — Phase B adds no decision logic. It adds two
propose-only producers. Evidence available: Phase A structures plus
recovery packages. Empirical: structured-output extraction and vector
retrieval are established engineering; nothing here validates content.
Policy: tier mapping and confirm-event requirements below. Heuristic:
none — no numeric behavior thresholds are introduced. Abstention:
extraction or retrieval failure yields reason-coded no-ops, never
partial writes. Human ratification: every draft observation requires a
coach confirm event; every retrieval suggestion requires a human apply
event; ingest staging requires owner review.

AUTHORIZED WIDENINGS (explicit exceptions to AGENTS.md default-deny;
everything not listed stays denied)

- HTTP: server-side calls to the provisioned Azure OpenAI endpoints
  ONLY. New internal routes ONLY for: draft-observation submit,
  draft-observation confirm/edit, retrieval-suggest, retrieval-apply,
  recovery-package ingest-to-staging. No other external calls; no
  Marketplace-billed model calls of any kind.
- SCHEMA: additive-only. Tables/columns for: draft observations (tier,
  provenance: model id + prompt version + timestamp, confirm-event
  linkage), lesson/observation embeddings (pgvector column + index),
  ingest staging (source file, tag set, proposed tier, review state).
  No destructive migrations. All migration files itemized in the PR for
  review.
- STILL DENIED: auth/authz changes, deploy/CI-deploy changes, any
  Phase A math modification, any retuning of existing heuristics,
  anything D10-adjacent, anything conditioned on #345 approval state.

BUILD — THREE COMPONENTS

1. Extraction service (spec §2.1)
   JSON-schema-constrained structured output, temperature ~0. Input:
   free-text coach note / voice-memo transcript. Output: DraftObservation
   with tier = AI-interpretation and full provenance. A coach
   confirm/edit event is the ONLY promotion to observation-of-record.
   Unconfirmed drafts are structurally incapable of reaching the
   recurrence engine, strata, or baselines — enforced by type/query
   boundaries, not convention. Prompt templates are versioned artifacts
   committed in the PR; provenance records the version used.

2. Retrieval service (spec §2.7)
   Embed validated lessons and confirmed observations; cosine kNN via
   pgvector. Output: suggestions carrying similarity + provenance.
   A human apply event is the ONLY path by which a suggestion touches
   any athlete overlay. Suggestions never auto-apply, never expire into
   application, and never write anything on their own. Keep Library/RAG
   citation evidence and coaching-observation evidence as distinct
   populations (existing shadowEvidence boundary) — retrieval may span
   both but must label which is which.

3. Recovery-package ingestion (staging only)
   Ingest PPBF Intelligence Recovery packages into a staging area using
   this tag → proposed-tier mapping, implemented as data, not judgment:

   owner_methodology, operational_rule      → owner-methodology (staged)
   external_research, research_synthesis    → research-evidence (cited)
   AI_generated_analysis                    → AI-interpretation
   hypothesis, rabbit_hole,
   partially_supported, evidence_gap,
   needs_verification                       → hypothesis (flagged)
   contradicted, superseded, outdated       → archived-context,
                                              non-recommending
   unsafe_to_operationalize                 → blocked from all
                                              recommendation surfaces;
                                              owner-only visibility
   internal_observation / any identifiable
   athlete material                         → NOT ingested here at all;
                                              route to the controlled
                                              athlete-data lane

   Ambiguous or untagged items default to the lowest applicable tier
   plus needs_verification. EVERYTHING ingests as staged; owner review
   releases items to the Library. Ingest changes zero algorithm
   behavior (#345).

HOUSE RULES

AGENTS.md permanents apply in full. Additionally: propose-only
throughout; no automated medical or sparring/contact clearance;
clearance and the D10 sensitivity path are never read, written,
inferred, or wired by any Phase B code; no blended or universal scores;
no new numeric behavior thresholds; token/cost logging on every model
call with spend visible against the §8 envelope; PR-only — never push
main, never merge, never deploy. Jason merges.

TESTS / ACCEPTANCE (adversarial; abstention-shaped)

- Hallucinated extraction (schema-valid but wrong) → remains a draft;
  a test proves the recurrence engine rejects unconfirmed tiers.
- Tier-stripping attempt (draft posted as confirmed without a confirm
  event) → refused with reason code.
- Retrieval suggestion with no apply event → zero changes anywhere.
- unsafe_to_operationalize content → never surfaces on any coach-facing
  recommendation path.
- Research/hypothesis-tier content in output → always carries tier +
  citation; never phrased as established.
- Prompt-version bump → new drafts carry new version; old drafts keep
  their original provenance.
- Azure outage / model error / malformed model output → reason-coded
  no-op; no partial writes.
- #345 regression: toggling research approval state changes no
  algorithm output.
- D10 firewall: automated check that Phase B code contains no reference
  to the sensitivity-flag path.
- Full gate green — typecheck, lint, complete jest — exact counts
  reported from a fully installed environment and matching CI.

DELIVERABLE

1. Files implemented, mapped to spec sections
2. Itemized migration review section
3. Prompt templates (versioned) included for review
4. Exact test counts matching CI
5. Ambiguities deferred to the owner, not silently resolved
6. Open a PR. Never push main. Never merge. Jason merges after
   algorithm-lane cross-review.

Do not deploy production.
