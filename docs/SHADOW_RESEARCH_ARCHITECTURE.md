# SHADOW Research Architecture and Archive Contract

**Status:** PROPOSED — awaiting owner confirmation. Phase 1 architecture reconciliation.  
**Owner (proposed):** Jason Neale — this document has not been countersigned; no sign-off artifact for it exists in this repository.  
**Drafted:** 2026-08-19  
**Scope:** Research originals, provenance, intake, evidence review, and SHADOW retrieval. This document does not authorize algorithm, medical, safeguarding, contact, sparring, or production-policy changes.

## 1. Proposed archive baseline (unconfirmed)

> **This section is the sole source of every string it contains.** `git grep` for
> `Library Intake`, `_CONTROL`, or `R98 - Duplicate Hold` across this repository
> returns only this document and `SHADOW_RESEARCH_INTAKE_IMPORT.md`. There is no
> manifest, export, connector record, configuration value, or test fixture that
> corroborates any of it. Until one exists, treat everything below as a
> **proposal**, not as controlling fact. `AGENT_KERNEL.md:31` — "Claims need evidence."

The proposed governed upstream archive baseline for the PPBF research workflow is:

```text
admin@punxsyprominence.org
└── OneDrive
    └── Library Intake/
```

**Attribution and evidence status.** The tree below was reported on 2026-08-19 by an
AI agent reading the `admin@punxsyprominence.org` tenant through a Microsoft 365
connector, and transcribed here by hand. It is an *observation claim*, not an export:
no artifact of that read — no listing, no drive/item identity, no timestamped
manifest — exists anywhere in this repository, so nothing here can be re-verified
from the repository alone. It is recorded so the owner can confirm or correct it.

```text
Library Intake/
├── _CONTROL - Registers and Coverage Maps/
├── R00 - Unsorted Drop/
├── R01 - Boxing and Athlete Development/
├── R02 - AI ML and Data Science/
├── R03 - Strength Conditioning Nutrition and Recovery/
├── R04 - Coaching and Coach Development/
├── R05 - Staff and Volunteer Development/
├── R06 - Parent and Guardian Engagement/
├── R07 - Youth Development and Safeguarding/
├── R08 - Nonprofit Management Governance and Boards/
├── R09 - Fundraising and Donor Development/
├── R10 - Finance and Sustainability/
├── R11 - Community Engagement and Partnerships/
├── R12 - HR and Organizational Culture/
├── R13 - Compliance Risk and Insurance/
├── R14 - Program Evaluation and Outcomes/
├── R15 - Water Safety and Aquatics/
├── R16 - Adaptive and Inclusive Practice/
├── R17 - Multidiscipline Wrestling and Grappling/
├── R18 - Learning Science and Skill Acquisition/
└── R98 - Duplicate Hold/
```

### 1.1 Relationship to issue #345 — this document does not supersede it

An earlier draft of this document claimed to supersede "stale product-documentation
pointers" naming `SHADOW AIML / 02 - Source Materials / Penn State Library Intake / ...`.
That claim was wrong twice over and is withdrawn:

- **That path is not in this repository.** It occurs zero times outside this sentence.
  It comes from [issue #345](https://github.com/PunxsyProminence/ppbf-platform/issues/345),
  which is **open**, **owner-authored**, and states of itself: "This issue should remain
  the durable product reference." A draft PR's markdown cannot supersede an open,
  owner-authored specification.
- **The two records name different stores, not just different paths.** Issue #345 says
  **SharePoint**. This document says **OneDrive**. Those are different Microsoft
  surfaces with different identity, permissioning, and Graph addressing — a store
  change, silently introduced, not a path correction.

| | Store | Path | Evidence status |
|---|---|---|---|
| Issue #345 (owner-authored, open) | SharePoint | `SHADOW AIML / 02 - Source Materials / Penn State Library Intake / ...` | The durable contract. Governs until the owner updates it. |
| This document (proposed) | OneDrive | `admin@punxsyprominence.org / OneDrive / Library Intake/` | Unconfirmed agent-connector observation, 2026-08-19. No repository artifact. |

**Issue #345 remains the durable contract until the owner updates it.** If the owner
confirms the OneDrive tree, the correct remedy is to amend #345 and then align this
document to it — not the reverse.

Nothing here authorizes deleting, moving, merging, or retiring any older Microsoft or
Google tree. Older trees remain historical/provenance evidence until they are
inventoried and separately dispositioned.

## 2. Meaning of the archive structure

- `_CONTROL` contains registers, coverage maps, lineage controls, task records, and research-governance artifacts.
- `R00` is a processing state: source not yet confidently classified or cleared for movement.
- `R01` through `R19` are subject classifications.
- `R98` is a processing state: duplicate or lineage hold.

`R00` and `R98` are not subject domains. Folder placement does not establish evidence quality, organizational authority, approval, or operational use.

## 3. Source-of-truth boundaries

The three Microsoft surfaces below are **separate rows on purpose**. An earlier draft
merged them into one "Microsoft OneDrive / SharePoint" row, which made an unconfirmed
proposal, an owner-authored spec, and the destination the running code actually writes
to look like a single agreed system. They are not the same place.

| Layer | Authority and purpose | What it does not do |
|---|---|---|
| **Microsoft — OneDrive `Library Intake` tree (§1)** | *Proposed* governed archive: durable originals, acquisition provenance, duplicate/lineage preservation | Unconfirmed. No repository artifact corroborates it, and no code reads or writes it. Does not currently govern anything. |
| **Microsoft — SharePoint `SHADOW AIML / 02 - Source Materials / Penn State Library Intake`** | The governed original-source archive named by open owner-authored [issue #345](https://github.com/PunxsyProminence/ppbf-platform/issues/345) | Not addressed by any code in this repository either. Remains the durable contract on paper until the owner updates #345. |
| **Microsoft — SharePoint site drive, `PPBF/Intake`** | The **only** Microsoft destination this repository actually writes to: `apps/web/src/server/document-intake/sharepoint.ts` uploads to `/sites/{SHAREPOINT_SITE_ID}/drives/{SHAREPOINT_DRIVE_ID}/root:/{SHAREPOINT_FOLDER_PATH}` (default `PPBF/Intake`, `config.ts`) | Knows nothing called "Library Intake" and has no R00-R98 structure. It is a flat ingest drop, not the governed archive either document describes. |
| `/research` | Research requirements, general research registration, source-to-requirement links, answer-state workflow | Does not approve evidence or resolve a gap from submission alone |
| `/research/review` | Applicability review of a submission against the requirement it was filed against: `responsive`, `partially_responsive`, `not_responsive`, `duplicate` (`apps/web/app/research/review/page.tsx`) | Does not verify, approve, index, or make anything citable — that is `/evidence`. A `responsive` verdict does not resolve the requirement. |
| `/evidence` | Indexing, evidence review, verification, approval, rejection, and retrieval eligibility | Does not replace the original-source archive |
| `pilot.shadow_library_*` | Reviewed source, document, chunk, embedding, and retrieval records | Does not own licensed original files |
| `__platform__` SHADOW shelf | Shared platform-wide evidence baseline | Must not contain one gym's private policy as universal evidence |
| Organization SHADOW shelf | Organization-specific approved evidence and policy | Must not leak to another organization |
| GitHub | Runtime implementation, contracts, derived evidence packages, import tooling, tests, and reproducible metadata | Must not become the original archive. This is a **private** repository; it holds extensive licensed extracts already (see §9) and that is a content-governance question, not a settled one. |
| Google Drive | Design-lab work, coaching/skill masters where explicitly designated, handoffs, and candidate source material | Is not a SHADOW evidence authority. **But it is not downstream of Microsoft custody either** — see the mirror note below. |

**"Duplicate" means two unrelated things.** Do not conflate them:

- **`R98 - Duplicate Hold`** (§1, §2) is an *archive processing state*: this file may be
  the same object as another file in the archive; hold it pending lineage resolution.
  It is a property of a file's place in the archive tree.
- **`duplicate`** in `/research/review` is a *submission applicability verdict*: this
  source was already submitted against this requirement, or says nothing this
  requirement has not already been given. It is a property of a submission-to-requirement
  link, and it is recorded in the database, not in a folder.

A source can be `R98` in the archive and never reviewed, or `duplicate` at review while
sitting in a subject folder. Neither implies the other.

**Google Drive receives originals in parallel, not downstream.** `apps/web/app/api/document-ingest/route.ts`
(~line 255) uploads the same raw buffer to SharePoint **and** Google Drive in a single
`Promise.all`, whenever both destinations are configured. Google Drive is correctly *not*
an evidence authority — but framing it as merely a "candidate source" understates custody:
for every document that goes through `/api/document-ingest`, Drive holds a full copy of
the original, created at the same instant as the Microsoft copy. Any retention,
disposition, or access-review decision about originals must cover both destinations or it
is incomplete.

Current executable GitHub code describes implementation behavior. Current Microsoft
archive state describes original-file custody. Human evidence review determines
citability. These authority classes must not be collapsed.

## 4. Required research flow

**About half of this ladder is enforced by code and about half is procedure.** An
unannotated arrow list reads as though the whole chain is machine-guaranteed; it is not.
Each transition below is marked **ENFORCED** (with the file that enforces it) or
**PROCEDURAL — NOT ENFORCED** (nothing in this repository stops the step being skipped).

| # | Transition | Enforcement |
|---|---|---|
| 1 | source acquired -> preserve original and acquisition provenance | **PROCEDURAL — NOT ENFORCED.** No code preserves a governed original for research intake; §10 names this as the missing slice. |
| 2 | -> R00 intake when classification or lineage is unresolved | **PROCEDURAL — NOT ENFORCED.** R00 exists only in this document. No code reads or writes it. |
| 3 | -> human subject classification to R01-R19, or R98 duplicate hold | **PROCEDURAL — NOT ENFORCED.** `apps/web/src/shared/researchClassification.ts` constrains the *set* of keys a curator may pick, but nothing requires the step, and `archiveCode` is an unverified documentation crosswalk (§5). |
| 4 | -> register SHADOW Library source as pending review / unverified | **ENFORCED** for the seed path: `apps/web/scripts/import-shadow-research.mjs` (~L398-415) fails `SEED_ROW_CLAIMS_TRUSTED_STATE` / `SEED_ROW_CLAIMS_INDEXED` on any row arriving already approved, verified, or indexed. The importer has no route to a trusted state. |
| 5 | -> optionally link to a research requirement | Optional by design. |
| 6 | -> create/process document and chunks | **PROCEDURAL — NOT ENFORCED** as an ordering constraint. |
| 7 | -> generate current-model embeddings | **PROCEDURAL** to perform, but **ENFORCED** as a retrieval precondition — see row 10. |
| 8 | -> applicability and duplicate review | **PROCEDURAL — NOT ENFORCED.** `/research/review` (`apps/web/app/research/review/page.tsx`) provides the surface; nothing blocks a later step on a verdict having been recorded. |
| 9 | -> index document | **PROCEDURAL** to perform, **ENFORCED** as a retrieval precondition — see row 10. |
| 10 | -> human evidence verification and approval in `/evidence` | **ENFORCED.** `apps/web/src/server/pilot/shadowLibrary.ts`: `requireEvidenceReviewer` (~L241) restricts who may review, and `validateReviewState` (~L237-254) makes approved and verified mutually entailing — "Approved SHADOW evidence must also be verified" — so neither can be set without the other. |
| 11 | -> SHADOW retrieval from organization shelf + `__platform__` shelf | **ENFORCED.** `shadowLibrary.ts` (~L1078-1099) gates every retrieved chunk on `s.status = 'active'`, `s.approval_state = 'approved'`, `s.verification_state = 'verified'`, `not retrieval_suppressed`, `d.ingest_state = 'indexed'`, `d.index_completed_at is not null`, `d.approval_state = 'approved'`, `d.verification_state = 'verified'`, `c.embedding is not null`, and `c.embedding_model = <current model>`. |
| 12 | -> human resolution of the research requirement when evidence actually answers it | **ENFORCED that submission cannot do it.** Resolution lives only in `resolveShadowResearchRequirement` (`apps/web/src/server/pilot/shadowResearch.ts:125`), which requires an explicit `resolvedByAccountId`/`resolvedByRole` and is reached only from the deliberate `PATCH` on `app/api/pilot/shadow/research-requirements/route.ts`. No submission, review, approval, or import path calls it. **Whether the evidence actually answers the gap is PROCEDURAL** — the code enforces that a human acts, never that the human is right. |

No individual transition may be inferred from the previous one. In particular:

```text
file found != archived
archived != registered
registered != verified
verified source != indexed document
indexed != approved
approved != requirement resolved
requirement resolved != PPBF methodology adopted
methodology adopted != algorithm or safety authority
```

The **PROCEDURAL** rows above are exactly where that list is a promise rather than a
guarantee. Treat them as the standing gap, not as background text.

## 5. Controlled subject taxonomy

The application classification taxonomy is defined in `apps/web/src/shared/researchClassification.ts`
as `RESEARCH_CLASSIFICATION_DOMAINS`. The table below is the crosswalk between that constant
and the archive subject folders proposed in §1.

`apps/web/src/shared/researchClassification.test.ts` parses this exact table out of this file
and asserts it equals the shipped constant, so the two cannot drift apart. **Keep the table's
three-column `| R-code | \`key\` | label |` shape** — the test reads it, and a reformat will fail it.

**The `archiveCode` column is an unverified documentation crosswalk.** It maps an application
key onto a folder name from §1, and §1 is an unconfirmed proposal (no manifest, no export, no
connector record in this repository). Nothing in the running system verifies that folder `R16`
exists, that it is named "Adaptive and Inclusive Practice", or that it is where an
`adaptive_inclusive_practice` source ends up. `archiveCode` is a label this repository asserts,
not a fact it has checked.

| Code | Application key | Label |
|---|---|---|
| R01 | `boxing_athlete_development` | Boxing and athlete development |
| R02 | `ai_ml_data_science` | AI / ML / data science |
| R03 | `strength_conditioning_nutrition_recovery` | Strength, conditioning, nutrition, recovery |
| R04 | `coaching_coach_development` | Coaching / coach development |
| R05 | `staff_volunteer_development` | Staff / volunteer development |
| R06 | `parent_guardian_engagement` | Parent / guardian engagement |
| R07 | `youth_development_safeguarding` | Youth development / safeguarding |
| R08 | `nonprofit_management_governance` | Nonprofit management / governance / boards |
| R09 | `fundraising_donor_development` | Fundraising / donor development |
| R10 | `finance_sustainability` | Finance / sustainability |
| R11 | `community_engagement_partnerships` | Community engagement / partnerships |
| R12 | `hr_organizational_culture` | HR / organizational culture |
| R13 | `compliance_risk_insurance` | Compliance / risk / insurance |
| R14 | `program_evaluation_outcomes` | Program evaluation / outcomes |
| R15 | `water_safety_aquatics` | Water safety and aquatics |
| R16 | `adaptive_inclusive_practice` | Adaptive and inclusive practice |
| R17 | `multidiscipline_wrestling_grappling` | Multidiscipline wrestling and grappling |
| R18 | `learning_science_skill_acquisition` | Learning science and skill acquisition |
| R19 | `measurement_assessment_instruments` | Measurement and assessment instruments |

Classification is a human-correctable filing label. It is not an authority tier, an evidence
grade, a promotion decision, or an instruction to move a file automatically. `R00` and `R98` are
deliberately absent: they are processing states (§2), not subject domains, and no key or
`archiveCode` in the constant may represent either.

## 6. Provenance and cross-system identity

Subject classification must never replace acquisition provenance. Before archive handoff automation is considered complete, each source must retain, where available:

- institutional source identifier;
- acquisition provider and channel;
- original repository and original filename;
- content SHA-256;
- archive provider, stable drive/item identity, and archive link;
- DOI, PMID, or other persistent identifier;
- title, authors, year, and publication/source metadata;
- duplicate family and lineage status;
- research design, population, age, sex, and sport specificity;
- transfer/applicability and protected-domain flags;
- application classification domain;
- SHADOW Library source/document identifiers;
- linked research requirement identifiers;
- verification, review, approval, suppression, and retraction status.

Path and timestamp similarity alone are insufficient to establish provenance or duplicate identity.

Stable archive identifiers belong in protected configuration or stored metadata. Do not make
repository paths the only locator for a governed original.

## 7. Google Drive boundary

Google Drive may remain the source of truth for a specific coaching or skill-system artifact when an explicit manifest or owner decision names it. That designation is artifact-specific.

For research evidence, a Google file is a candidate source or handoff until it enters the governed intake workflow. A future Google-origin intake must preserve the Google file identity and acquisition context, then archive or reference the governed original in Microsoft before SHADOW evidence registration is treated as complete.

A Google title such as `MASTER`, `CANONICAL`, or `APPROVED` does not by itself grant nonprofit, research, methodology, or algorithm authority.

## 8. GitHub research packages

The repository holds two different research layers:

- `apps/web/seed-data/research-evidence/2026-08-07/` is the reviewer-facing reference layer. It is not loaded into the database.
- `apps/web/seed-data/shadow-research/2026-08-07/` is the deterministic loadable corpus used by the current importer.

The repository also contains `apps/web/seed-data/shadow-research/2026-08-08/`, including Penn
State and multidiscipline integration artifacts.

**The research importer cannot load that package.** It supplies only one
(`seed_shadow_library_capability_map.csv`) of the five files `import-shadow-research.mjs`
requires; `seed_shadow_library_sources.csv`, `..._documents.csv`, `..._chunks.csv`, and
`seed_shadow_research_requirements.csv` are all absent. Even with them, `EXPECTED_COUNTS`
(`import-shadow-research.mjs:19`) pins the loadable corpus to the 2026-08-07 package's exact
row counts and fails `ROW_COUNT_MISMATCH` on anything else. As a *SHADOW research corpus*, the
2026-08-08 package is indeed unimported and unloadable.

**But one part of it is already in force operationally, and saying the package "remains
proposed/reference material" without qualification is false.** §3 of
`README_PENNSTATE_INTEGRATION.md` defines a warm-up-decay stop rule. Its verbatim sentence —
"Re-warm before contact or maximal effort if more than ~20 minutes of inactivity has passed
since the warm-up (ring wait, bout delay, late start)." — now sits in **63 of the 674 rows** of
`apps/web/seed-data/drill-library/seed_drill_stop_rules.csv`, carrying `rule_kind = warmup_decay`.
That file is loaded into `pilot.drill_stop_rules` by `npm run seed:drill-library`, which
`.github/workflows/seed-reference-data.yml` dispatches. It is operational drill data, not
research reference material.

That crossing was made deliberately and is documented, not smuggled:

- `1b925d65` (2026-08-08) committed the CSV and stated plainly that the 63 `warmup_decay` rows
  were **rejected** by `drill_stop_rules_rule_kind_check` and must not be loaded.
- `67bd6cb7` (2026-08-08) parked the file out of the loader path for that reason.
- `52f6afb5` (2026-08-08) widened the constraint via
  `infra/azure/pilot_slice_postgres_drill_vocabulary_widening_migration.sql` and returned the
  file to the loader path, recording the basis as: "Owner decision, 2026-08-08: accept the
  archive's values as intended new states rather than remap them onto the existing vocabulary."

So a research-package finding reached the operational drill seed on a **separate, recorded owner
decision**, through the drill-library seed path rather than the research importer — while the
package as a research corpus remains unloadable. Both halves are true, and this document must
not state only the second.

Presence on `main` does not mean imported, indexed, approved, verified, or retrieval-live —
for the research corpus. It does not follow that nothing in a package is live: check each
artifact's own seed path.

## 9. Non-negotiable evidence boundaries

- External research is not PPBF methodology.
- Historical PPBF material is not automatically current authority.
- Upload or registration is not verification.
- Duplicate source is not corroboration.
- Adult evidence must not silently become youth evidence.
- Elite evidence must not silently become novice evidence.
- General sport, combat-sport, military, or laboratory evidence must retain transfer limits.
- Association is not causation.
- AI synthesis is not primary evidence.
- Research never creates medical, return-to-play, contact, sparring, safeguarding, weight-management, or eligibility clearance.
- Research never silently creates algorithm constants, thresholds, weights, promotion rules, or readiness logic.
- Licensed publisher **content** is governed by what it is, not by its file format. No `.pdf`
  is committed to this repository, and no publisher PDF may be. That is a weaker guarantee than
  it sounds: extensive licensed *extracts* are committed — for example
  `apps/web/seed-data/shadow-research/2026-08-08/evidence_fragment_PS.csv`, whose rows record
  "Full text supplied by user (Penn State Library). Parsed text extraction", and the
  claim-level `text_content` in `seed_shadow_library_chunks.csv`. "No PDFs in the tree" must
  never be read as "no licensed content in the tree". This is a **private** repository (see
  `docs/EXTERNAL_AUDIT_PROMPTS.md`, `docs/HANDOFF_RESEARCH.md`, `docs/HANDOFF_VISUALS.md`),
  which is why that is currently tolerable and not why it is unlimited.

## 10. Phase 1 changes and remaining work

Phase 1 may:

- correct documentation and record — without resolving — disagreements between archive pointers;
- align the application taxonomy to the R01-R19 crosswalk in §5;
- add deterministic tests for taxonomy completeness, uniqueness, and key/label/code pairing;
- document the required archive-to-SHADOW identity and lifecycle contract.

Phase 1 does not:

- move or delete archive files;
- retire old trees;
- change permissions;
- upload originals;
- backfill cross-system identities;
- import the August 8 package as a research corpus (the importer cannot load it — §8);
- remove, alter, or re-park the `warmup_decay` stop rules already in the drill seed. §8 records
  that they are live; whether they stay is the owner's decision, not this document's;
- confirm the §1 archive tree, or treat it as confirmed;
- deploy or run protected workflows;
- alter SHADOW evidence-tier, algorithm, medical, safeguarding, contact, or sparring behavior.

**Open items this document cannot close.** Two findings above need an owner decision, not a
further documentation pass:

1. **§1 is unconfirmed.** Confirm or correct the OneDrive `Library Intake` tree, and produce
   any artifact of it (an export, a manifest, a connector record) that a later reader can check.
2. **§1 and issue #345 name different stores** — OneDrive vs SharePoint. One of them is wrong.
   Whichever survives, #345 is the durable contract and should be the document that changes.

**Closed — owner decision, 2026-08-19.** The `warmup_decay` stop rules (§8) are **confirmed and
stay**. Jason Neale reconfirmed the 2026-08-08 decision on 2026-08-19, through the primary
working session, after the provenance review in PR #502: the re-warm-before-contact rule on the
63 contact/maximal-effort drills is approved as operational drill data, independent of the
unloadable research-corpus half of the same package. This paragraph is the durable record the
2026-08-08 commit message lacked.

The next implementation slice is a research-specific, idempotent archive handoff that reuses existing authenticated SharePoint upload primitives but adds source hashing, provenance, duplicate/lineage checks, stable archive identity, SHADOW source registration, and pending-review defaults. It must fail closed if the governed original cannot be preserved.
