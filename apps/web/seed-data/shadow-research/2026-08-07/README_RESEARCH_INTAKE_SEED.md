# PPBF/SHADOW Research Intake — Seed Package

**Status:** PROPOSED research output. Nothing here was applied to any live system.
**Generated:** 2026-08-07 from the 1,193-claim verified evidence registry.
**Scope:** the research intake lane only — gap generation, seed corpus, coverage detection.

Every file targets a table that already exists in the `pilot` schema. Column names, enum values, FK
relationships and uniqueness constraints were validated against the live DDL before generation.

---

## 1. What is in the package

| File | Target table | Rows |
|---|---|---|
| `seed_shadow_library_sources.csv` | `pilot.shadow_library_sources` | 1214 |
| `seed_shadow_library_documents.csv` | `pilot.shadow_library_documents` | 14 |
| `seed_shadow_library_chunks.csv` | `pilot.shadow_library_chunks` | 1193 |
| `seed_shadow_library_capability_map.csv` | `pilot.shadow_library_capability_map` | 30 |
| `seed_shadow_research_requirements.csv` | `pilot.shadow_research_requirements` | 229 |
| `research_triage_view.sql` | new read-only view | 1 |
| `EVIDENCE_TIER_SPEC.md` | spec for `shadowEvidenceTier.ts` | — |
| `evidence_tier_mapping_table.csv` | supporting table for the spec | 54 |

**Two placeholders must be substituted before loading:** `{{PPBF_ORG_ID}}` in every `organization_id`
column, and `{{SEED_ACCOUNT_ID}}` in every `created_by_account_id` column. They are deliberately not
real values — I have no authority to pick an org or an account.

## 2. Provenance and licensing

Chunk `text_content` is **synthesis text authored by this research program** — the claim, its population,
design, limitations and PPBF implication. It is **not publisher full text**, and no copyrighted article body
was ingested. Each chunk links to a source row carrying the real identifier (PMID/DOI/URL) so a coach or
reviewer can reach the original.

Of 1214 sources, 429 are authority tier 1–2. All PMIDs and DOIs were independently resolved
against NCBI E-utilities and Crossref during the research program.

## 3. Why claims are the chunk unit

Each chunk carries its own quality metadata — `evidence_class`, `authority_tier`, `boxing_specificity`,
`transfer_status`, population, sex, age, design, sample size, limitations, and verification status.

This is the mechanism that stops the corpus from manufacturing false confidence. A retrieval that surfaces
"bout energetics are ~73% aerobic" carries, in the same chunk, that it comes from a small study in adult
males. Chunking whole documents by section would let a finding travel without its caveats — which is the
specific failure this corpus is designed to prevent.

## 4. Coverage detection

`coverage_state` is computed from four tests, not from source volume alone. A capability is `covered` only
when it has ≥3 usable sources at the required authority tier, **at least 20% of them boxing-specific**, and
neither documented gaps nor contested claims outnumbering usable evidence by half.

Counting sources alone marked 29 of 30 capabilities `covered`, which is false — it rewards a large pile of
transferred evidence. With the boxing-specificity floor applied: **19 covered, 10 partial, 1 uncovered.**

Capabilities that are NOT fully covered, and why:

| Capability | State | Usable | Boxing-specific | Gaps | Reason |
|---|---|---|---|---|---|
| `motor_learning_practice_design` | partial | 25 | 8% | 3 | only 8% of usable evidence is boxing-specific (floor 20%) — rests on transfer |
| `coach_cue_feedback` | partial | 39 | 13% | 3 | only 13% of usable evidence is boxing-specific (floor 20%) — rests on transfer |
| `psychology_motivation` | partial | 29 | 7% | 1 | only 7% of usable evidence is boxing-specific (floor 20%) — rests on transfer |
| `life_skill_transfer` | partial | 29 | 7% | 1 | only 7% of usable evidence is boxing-specific (floor 20%) — rests on transfer |
| `injury_head_impact_risk` | partial | 15 | 13% | 2 | only 13% of usable evidence is boxing-specific (floor 20%) — rests on transfer; 10 contested claims against 15 usable sources |
| `performance_nutrition` | partial | 19 | 11% | 2 | only 11% of usable evidence is boxing-specific (floor 20%) — rests on transfer |
| `staffing_supervision_ratios` | partial | 22 | 32% | 12 | 12 documented INSUFFICIENT-EVIDENCE gaps against 22 usable sources |
| `capacity_planning` | partial | 13 | 31% | 7 | 7 documented INSUFFICIENT-EVIDENCE gaps against 13 usable sources |
| `emergency_medical_response` | partial | 10 | 10% | 4 | only 10% of usable evidence is boxing-specific (floor 20%) — rests on transfer |
| `finance_sustainability` | partial | 44 | 2% | 0 | only 2% of usable evidence is boxing-specific (floor 20%) — rests on transfer |
| `operational_data_model` | uncovered | 0 | 0% | 10 | no usable evidence at required authority tier |

The 20% floor is a **PROPOSED PPBF PARAMETER — REQUIRES VALIDATION**. It is a judgment about how much
transfer is tolerable before a capability should warn, not a value derived from evidence. Change it in one
place and re-run.

## 5. Research requirements (229 seeded, all `status='open'`)

Four gap types, each from a documented condition in the registry rather than a guess:

| Gap type | Count | Meaning |
|---|---|---|
| `parameter_undefined` | 118 | A TBD value PPBF must derive from its own data |
| `evidence_absent` | 55 | Structured search found no adequate source |
| `evidence_conflicted` | 34 | Sources genuinely disagree |
| `hypothesis_untested` | 22 | Reasoning, not evidence |

`research_triage_view.sql` ranks them so the backlog is workable:

| Band | Count | Meaning |
|---|---|---|
| 1_BLOCKING_SAFETY | 53 | Under a safety-critical capability |
| 2_BLOCKING_CAPABILITY | 78 | A reason its capability is partial/uncovered |
| 3_CONFLICT_VISIBLE | 16 | Contested evidence a coach could hit in normal use |
| 4_PARAMETER | 54 | TBD value to derive from PPBF data |
| 5_BACKLOG | 28 | Everything else |

The `on conflict do update` in `createShadowResearchRequirement` means re-running the seed is idempotent on
the natural key `(organization_id, source_event_name, source_entity_type, source_entity_id)`.

## 6. Load order

1. Substitute both placeholders.
2. `shadow_library_sources` (nothing depends on it).
3. `shadow_library_documents` (FK to sources).
4. `shadow_library_chunks` (FK to both).
5. Generate embeddings — the `embedding` column is intentionally **not** populated here; that is your
   pipeline's job and its model must match what the retrieval side expects.
6. `shadow_library_capability_map`, then `shadow_research_requirements`.
7. Apply `research_triage_view.sql`.
8. Review `EVIDENCE_TIER_SPEC.md` separately — it proposes a code change and is not part of the data load.

`ingest_state` is set to `indexed` on the document rows. If your pipeline expects to drive that transition
itself, set it to `pending` before loading.

## 7. What this package deliberately does not do

No table is created or altered except the read-only triage view. No embedding is generated. No source is
marked approved — `shadow_library_sources.approval_state` has a `pending_review` default and a
reviewer-role guard (`requireEvidenceReviewer`), and that human review gate is left intact by design.
