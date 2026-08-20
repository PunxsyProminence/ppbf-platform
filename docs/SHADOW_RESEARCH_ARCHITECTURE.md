# SHADOW Research Architecture and Archive Contract

**Status:** ACTIVE OWNER DECISION — technical SharePoint target verification pending.  
**Owner:** Jason Neale  
**Decision date:** 2026-08-19  
**Scope:** Research originals, provenance, intake, evidence review, and SHADOW retrieval. This document does not authorize algorithm, medical, safeguarding, contact, sparring, or production-policy changes.

## 1. Governing archive decision

Jason Neale confirmed on 2026-08-19 that the permanent governed research archive is the nonprofit Microsoft SharePoint workspace, not the `admin@punxsyprominence.org` OneDrive.

The exact SharePoint hostname, site path, document library/drive ID, root folder, and stable root item ID have **not yet been verified**. Until those identifiers are verified and recorded, this decision establishes the authority class and destination platform, not an upload path.

The existing OneDrive working tree is a temporary research workbench and migration source:

```text
admin@punxsyprominence.org
└── OneDrive
    └── Library Intake/
```

The tree below was observed through a Microsoft 365 connector on 2026-08-19. It is not the permanent governed archive, and no repository code may treat its path as the production destination.

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
├── R19 - Measurement and Assessment Instruments/
└── R98 - Duplicate Hold/
```

The R01-R19 taxonomy is the current application classification crosswalk, and its folder structure is now physically present in the nonprofit SharePoint library.

### Verified target, 2026-08-20

Measured directly through Microsoft Graph by the primary Claude session, not inferred and not relayed:

| Fact | Value |
|---|---|
| Site | `punxsyprominenceboxing.sharepoint.com` `/sites/PunxsyProminenceClubOperations` |
| Documents drive | `b!-Vo_sgBoOE2exdhUasmD2dxgw3lpD95Ir3in52rLlJkPoxSpVsFoQI_NNbWdKzpJ` |
| Drive root item | `0154YZVW56Y2GOVW7725BZO354PWSELRRZ` |
| Research Archive folder | `0154YZVWYXXDPDFKTSCBA3G2XDFG34WAO7` |
| Lane structure | `_CONTROL`, `R00`, `R01`-`R19`, `R98` -- all present |

### The lanes are prepared and EMPTY

This is the distinction most easily lost, and losing it would assert a migration that has not happened.

Every `R01`-`R19` folder and `R98` in the SharePoint Research Archive reads **0 bytes**. `R01 - Boxing and Athlete Development` was opened directly and returned no children. Only `_CONTROL` (governance artifacts) and `R00` (2,040 bytes) hold anything.

The corpus remains in the OneDrive `Library Intake` working source, where the same lanes hold roughly a gigabyte: `R00` alone is 489,854,741 bytes, `R17` is 138.5 MB, `R18` is 113.3 MB, `R98` is 107.4 MB.

**An inventory count of these lanes is therefore a count of OneDrive, not of SharePoint.** A figure such as "609 items across R01-R19" describes the working source. Read against the archive it would claim a migration that did not occur.

**Structure present is not corpus present. Nothing has been migrated.**

### Still not authorized

No bulk movement, deletion, retirement, permission change, or upload configuration is authorized. Outstanding before any of it:

- current destination contents and naming collisions;
- a timestamped **recursive** inventory -- counts recorded so far are immediate-child counts, not a recursive corpus inventory;
- OneDrive-to-SharePoint comparison and duplicate reconciliation;
- provenance and lineage controls;
- one synthetic, non-licensed pilot handoff, observed end to end.

`R00 - Unsorted Drop` in the working source is **not** a research corpus. Its `PPBF__FROM_DOWNLOADS__UNSORTED` subtree mixes research with personal, financial, medical, identity and survey material, plus installers and partial downloads. It must not be bulk-migrated, and sensitive material within it stays metadata-only -- not opened, not ingested.

A second SharePoint library named `Create the Coaching Library (File Storage` also exists on this site. Its authority is unresolved and it must not be silently selected as the archive.

The OneDrive `Library Intake` anonymous edit/write sharing exposure is **not fixed** and must not be described as fixed.

No bulk movement, deletion, retirement, permission change, or upload configuration is authorized until all of the following are verified:

- exact SharePoint hostname and site path;
- exact document library/drive and root item;
- current contents and naming collisions;
- stable identifiers and a timestamped inventory/manifest;
- OneDrive-to-SharePoint comparison;
- provenance and duplicate/lineage controls;
- one synthetic, non-licensed pilot handoff.

### 1.1 Relationship to issue #345

Issue #345 remains the durable product contract. It correctly identifies SharePoint as the governed original-source archive, but its legacy path — `SHADOW AIML / 02 - Source Materials / Penn State Library Intake / ...` — is not yet verified as the final nonprofit SharePoint destination.

The controlling interpretation is now:

| Record | Store | Status |
|---|---|---|
| Owner decision, 2026-08-19 | Nonprofit Microsoft SharePoint workspace | **Permanent governed archive authority.** Exact site/library/root identifiers pending verification. |
| Issue #345 legacy path | SharePoint `SHADOW AIML / 02 - Source Materials / Penn State Library Intake / ...` | Historical/contract pointer; not yet verified as the final technical destination. |
| OneDrive `Library Intake` | `admin@punxsyprominence.org` OneDrive | Temporary working and migration source only. |
| Current generic ingest default | Configurable SharePoint site drive, default folder `PPBF/Intake` | Existing application upload primitive; not automatically the governed research archive. |

Nothing here authorizes deleting, moving, merging, or retiring any older Microsoft or Google tree. Older trees remain historical/provenance evidence until they are inventoried and separately dispositioned.

## 2. Meaning of the target taxonomy

- `_CONTROL` is the control area for registers, coverage maps, lineage controls, task records, and research-governance artifacts.
- `R00` is a processing state: source not yet confidently classified or cleared for movement.
- `R01` through `R19` are subject classifications.
- `R98` is a processing state: duplicate or lineage hold.

`R00` and `R98` are not subject domains. Folder placement does not establish evidence quality, organizational authority, approval, or operational use.

The taxonomy is approved as a cross-system classification contract, and its folder structure now exists in the permanent SharePoint library. Folders being present says nothing about what they contain, and nothing about evidence quality.

## 3. Source-of-truth boundaries

The Microsoft surfaces below are **separate rows on purpose**. The permanent authority decision, the temporary OneDrive source, the legacy issue path, and the destination used by the current generic uploader are not the same place.

| Layer | Authority and purpose | What it does not do |
|---|---|---|
| **Microsoft — nonprofit SharePoint workspace** | Permanent governed archive authority for durable originals, provenance, and institutional continuity | Exact site, library, root, and stable IDs remain unverified. Does not make a source citable merely because a file exists there. |
| **Microsoft — OneDrive `Library Intake`** | Temporary working and migration source containing the observed R00-R19/R98 structure | Is not the permanent archive and must not become the production upload target by inference. |
| **Microsoft — issue #345 legacy SharePoint pointer** | Historical product-contract pointer to `SHADOW AIML / 02 - Source Materials / Penn State Library Intake / ...` | Does not prove that path is the selected final nonprofit SharePoint root. |
| **Microsoft — configurable SharePoint site drive, default `PPBF/Intake`** | The Microsoft destination currently supported by `apps/web/src/server/document-intake/sharepoint.ts` and `config.ts` | Is a generic ingest destination. It is not the governed research archive unless the exact site/library/root is verified and deliberately configured for that purpose. |
| `/research` | Research requirements, general research registration, source-to-requirement links, answer-state workflow | Does not approve evidence or resolve a gap from submission alone. |
| `/research/review` | Applicability review of a submission against the requirement it was filed against: `responsive`, `partially_responsive`, `not_responsive`, `duplicate` (`apps/web/app/research/review/page.tsx`) | Does not verify, approve, index, or make anything citable — that is `/evidence`. A `responsive` verdict does not resolve the requirement. |
| `/evidence` | Indexing, evidence review, verification, approval, rejection, and retrieval eligibility | Does not replace the original-source archive. |
| `pilot.shadow_library_*` | Reviewed source, document, chunk, embedding, and retrieval records | Does not own licensed original files. |
| `__platform__` SHADOW shelf | Shared platform-wide evidence baseline | Must not contain one gym's private policy as universal evidence. |
| Organization SHADOW shelf | Organization-specific approved evidence and policy | Must not leak to another organization. |
| GitHub | Runtime implementation, contracts, derived evidence packages, import tooling, tests, and reproducible metadata | Must not become the original archive. This is a **private** repository; it holds extensive licensed extracts already (see §9) and that is a content-governance question, not a settled one. |
| Google Drive | Design-lab work, coaching/skill masters where explicitly designated, handoffs, candidate sources, and—when the generic ingest pipeline is configured—parallel copies | Is not a SHADOW evidence authority and is not the permanent nonprofit research archive. |

**"Duplicate" means two unrelated things.** Do not conflate them:

- **`R98 - Duplicate Hold`** is an archive processing state: the file may be the same object as another file and is held pending lineage resolution.
- **`duplicate`** in `/research/review` is a submission applicability verdict on a source-to-requirement link.

A source can be in R98 and never reviewed, or receive a `duplicate` applicability verdict while sitting in a subject folder. Neither implies the other.

**Google Drive may receive originals in parallel.** `apps/web/app/api/document-ingest/route.ts` uploads the same raw buffer to SharePoint and Google Drive in one `Promise.all` whenever both destinations are configured. Google Drive is correctly *not* an evidence authority, but any retention, disposition, or access-review decision about originals must cover both copies. Phase 2 must not preserve that parallel-copy behavior by accident; the approved destination and any optional mirror must be explicit.

Current executable GitHub code describes implementation behavior. The verified nonprofit SharePoint object will describe original-file custody. Human evidence review determines citability. These authority classes must not be collapsed.

## 4. Required research flow

**About half of this ladder is enforced by code and about half is procedure.** An unannotated arrow list reads as though the whole chain is machine-guaranteed; it is not. Each transition below is marked **ENFORCED** or **PROCEDURAL — NOT ENFORCED**.

| # | Transition | Enforcement |
|---|---|---|
| 1 | source acquired -> preserve original and acquisition provenance in the permanent nonprofit SharePoint archive | **PROCEDURAL — NOT ENFORCED.** The permanent SharePoint target is owner-confirmed, but no research-specific code preserves the governed original there yet. |
| 2 | -> R00 intake when classification or lineage is unresolved | **PROCEDURAL — NOT ENFORCED.** R00 is an approved target workflow state, but no code reads, creates, or routes to the SharePoint folder. |
| 3 | -> human subject classification to R01-R19, or R98 duplicate hold | **PROCEDURAL — NOT ENFORCED.** `apps/web/src/shared/researchClassification.ts` constrains the set of application keys, but no code moves archive files. The SharePoint folder implementation is pending verification. |
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

The **PROCEDURAL** rows above are exactly where that list is a promise rather than a guarantee. Treat them as the standing gap, not as background text.

## 5. Controlled subject taxonomy

The application classification taxonomy is defined in `apps/web/src/shared/researchClassification.ts` as `RESEARCH_CLASSIFICATION_DOMAINS`. The table below is the owner-approved target crosswalk for the nonprofit SharePoint archive.

`apps/web/src/shared/researchClassification.test.ts` parses this exact table out of this file and asserts it equals the shipped constant, so the two cannot drift apart. **Keep the table's three-column `| R-code | \`key\` | label |` shape** — the test reads it, and a reformat will fail it.

**The crosswalk is approved; physical archive conformance is not yet verified.** Nothing in the running system currently proves that the corresponding R01-R19 folders exist in the selected nonprofit SharePoint library or routes files into them.

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

Classification is a human-correctable filing label. It is not an authority tier, an evidence grade, a promotion decision, or an instruction to move a file automatically. `R00` and `R98` are deliberately absent: they are processing states, not subject domains, and no key or `archiveCode` in the constant may represent either.

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

Stable archive identifiers belong in protected configuration or stored metadata. Do not make repository paths the only locator for a governed original.

## 7. Google Drive boundary

Google Drive may remain the source of truth for a specific coaching or skill-system artifact when an explicit manifest or owner decision names it. That designation is artifact-specific.

For research evidence, a Google file is a candidate source or handoff until it enters the governed intake workflow. A future Google-origin intake must preserve the Google file identity and acquisition context, then archive or reference the governed original in nonprofit SharePoint before SHADOW evidence registration is treated as complete.

A Google title such as `MASTER`, `CANONICAL`, or `APPROVED` does not by itself grant nonprofit, research, methodology, or algorithm authority.

## 8. GitHub research packages

The repository holds two different research layers:

- `apps/web/seed-data/research-evidence/2026-08-07/` is the reviewer-facing reference layer. It is not loaded into the database.
- `apps/web/seed-data/shadow-research/2026-08-07/` is the deterministic loadable corpus used by the current importer.

The repository also contains `apps/web/seed-data/shadow-research/2026-08-08/`, including Penn State and multidiscipline integration artifacts.

**The research importer cannot load that package.** It supplies only one (`seed_shadow_library_capability_map.csv`) of the five files `import-shadow-research.mjs` requires; `seed_shadow_library_sources.csv`, `..._documents.csv`, `..._chunks.csv`, and `seed_shadow_research_requirements.csv` are all absent. Even with them, `EXPECTED_COUNTS` (`import-shadow-research.mjs:19`) pins the loadable corpus to the 2026-08-07 package's exact row counts and fails `ROW_COUNT_MISMATCH` on anything else. As a SHADOW research corpus, the 2026-08-08 package is unimported and unloadable.

**But one part of it is already in force operationally.** §3 of `README_PENNSTATE_INTEGRATION.md` defines a warm-up-decay stop rule. Its verbatim sentence — "Re-warm before contact or maximal effort if more than ~20 minutes of inactivity has passed since the warm-up (ring wait, bout delay, late start)." — sits in 63 of the 674 rows of `apps/web/seed-data/drill-library/seed_drill_stop_rules.csv`, carrying `rule_kind = warmup_decay`. That file is loaded into `pilot.drill_stop_rules` by `npm run seed:drill-library`, which `.github/workflows/seed-reference-data.yml` dispatches. It is operational drill data, not research reference material.

That crossing was made deliberately and is documented:

- `1b925d65` (2026-08-08) committed the CSV and stated that the 63 `warmup_decay` rows were rejected by `drill_stop_rules_rule_kind_check` and must not be loaded.
- `67bd6cb7` (2026-08-08) parked the file out of the loader path for that reason.
- `52f6afb5` (2026-08-08) widened the constraint via `infra/azure/pilot_slice_postgres_drill_vocabulary_widening_migration.sql` and returned the file to the loader path, recording the basis as an owner decision.

So a research-package finding reached the operational drill seed on a separate, recorded owner decision, through the drill-library seed path rather than the research importer — while the package as a research corpus remains unloadable. Both halves are true.

Presence on `main` does not mean imported, indexed, approved, verified, or retrieval-live for the research corpus. It does not follow that nothing in a package is live: check each artifact's own seed path.

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
- Licensed publisher **content** is governed by what it is, not by file format. No `.pdf` is committed to this repository, and no publisher PDF may be. Extensive licensed extracts are committed — for example `apps/web/seed-data/shadow-research/2026-08-08/evidence_fragment_PS.csv` and claim-level `text_content` in `seed_shadow_library_chunks.csv`. "No PDFs in the tree" must never be read as "no licensed content in the tree". This is a private repository, which is why those extracts are currently tolerable and not why they are unlimited.

## 10. Decision status and remaining work

**Closed — owner decision, 2026-08-19:**

1. The permanent governed research archive is the nonprofit Microsoft SharePoint workspace.
2. The `admin@punxsyprominence.org` OneDrive `Library Intake` tree is a temporary working and migration source.
3. The R01-R19 taxonomy may be retained as the target classification crosswalk; R00 and R98 remain workflow states.
4. SHADOW retrieval remains limited to approved, verified, indexed evidence in `pilot.shadow_library_*`.
5. The `warmup_decay` stop rules described in §8 are confirmed and remain operational drill data.

**Open technical verification items:**

- exact SharePoint hostname and site path;
- exact document library/drive ID and root item ID;
- canonical research root folder;
- current contents and duplicate/collision analysis;
- timestamped SharePoint inventory/manifest;
- OneDrive-to-SharePoint differencing;
- stable source identity and provenance schema;
- explicit disposition of the generic `PPBF/Intake` destination and Google mirror;
- one synthetic, non-licensed pilot handoff.

The next implementation slice is a research-specific, idempotent archive handoff that reuses existing authenticated SharePoint upload primitives but adds source hashing, provenance, duplicate/lineage checks, stable archive identity, SHADOW source registration, and pending-review defaults. It must fail closed if the governed original cannot be preserved.

No bulk file movement, deletion, retirement, permission change, upload configuration, or production action is authorized until the technical target and pilot are verified.
