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

The tree was observed through a Microsoft 365 connector on 2026-08-19. It is not the permanent governed archive, and no repository code may treat its path as the production destination.

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

The R01-R19 taxonomy may be retained in the nonprofit SharePoint library and is the current application classification crosswalk. This does not prove those folders already exist in SharePoint or authorize creating them in this phase.

No bulk movement, deletion, retirement, permission change, or upload configuration is authorized until all of the following are verified:

- exact SharePoint hostname and site path;
- exact document library/drive and root item;
- proposed canonical research root;
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

- `_CONTROL` is the proposed control area for registers, coverage maps, lineage controls, task records, and research-governance artifacts.
- `R00` is a processing state: source not yet confidently classified or cleared for movement.
- `R01` through `R19` are subject classifications.
- `R98` is a processing state: duplicate or lineage hold.

`R00` and `R98` are not subject domains. Folder placement does not establish evidence quality, organizational authority, approval, or operational use.

The taxonomy is approved as a cross-system classification contract. Its physical implementation in the permanent SharePoint library remains pending target verification.

## 3. Source-of-truth boundaries

The Microsoft surfaces below are separate rows on purpose. The permanent authority decision, the temporary OneDrive source, the legacy issue path, and the destination used by the current generic uploader are not the same place.

| Layer | Authority and purpose | What it does not do |
|---|---|---|
| **Microsoft — nonprofit SharePoint workspace** | Permanent governed archive authority for durable originals, provenance, and institutional continuity | Exact site, library, root, and stable IDs remain unverified. Does not make a source citable merely because a file exists there. |
| **Microsoft — OneDrive `Library Intake`** | Temporary working and migration source containing the observed R00-R19/R98 structure | Is not the permanent archive and must not become the production upload target by inference. |
| **Microsoft — issue #345 legacy SharePoint pointer** | Historical product-contract pointer to `SHADOW AIML / 02 - Source Materials / Penn State Library Intake / ...` | Does not prove that path is the selected final nonprofit SharePoint root. |
| **Microsoft — configurable SharePoint site drive, default `PPBF/Intake`** | The Microsoft destination currently supported by `apps/web/src/server/document-intake/sharepoint.ts` and `config.ts` | Is a generic ingest destination. It is not the governed research archive unless the exact site/library/root is verified and deliberately configured for that purpose. |
| `/research` | Research requirements, general research registration, source-to-requirement links, answer-state workflow | Does not approve evidence or resolve a gap from submission alone. |
| `/research/review` | Applicability review of a submission against the requirement it was filed against: `responsive`, `partially_responsive`, `not_responsive`, `duplicate` | Does not verify, approve, index, or make anything citable. A `responsive` verdict does not resolve the requirement. |
| `/evidence` | Indexing, evidence review, verification, approval, rejection, and retrieval eligibility | Does not replace the original-source archive. |
| `pilot.shadow_library_*` | Reviewed source, document, chunk, embedding, and retrieval records | Does not own licensed original files. |
| `__platform__` SHADOW shelf | Shared platform-wide evidence baseline | Must not contain one gym's private policy as universal evidence. |
| Organization SHADOW shelf | Organization-specific approved evidence and policy | Must not leak to another organization. |
| GitHub | Runtime implementation, contracts, derived evidence packages, import tooling, tests, and reproducible metadata | Must not become the original archive. This private repository already contains licensed extracts, so content governance remains necessary. |
| Google Drive | Design-lab work, coaching/skill masters where explicitly designated, handoffs, candidate sources, and—when the generic ingest pipeline is configured—parallel copies | Is not a SHADOW evidence authority and is not the permanent nonprofit research archive. |

**"Duplicate" means two unrelated things.** Do not conflate them:

- **`R98 - Duplicate Hold`** is an archive processing state: the file may be the same object as another file and is held pending lineage resolution.
- **`duplicate`** in `/research/review` is a submission applicability verdict on a source-to-requirement link.

A source can be in R98 and never reviewed, or receive a `duplicate` applicability verdict while sitting in a subject folder. Neither implies the other.

**Google Drive may receive originals in parallel.** `apps/web/app/api/document-ingest/route.ts` uploads the same raw buffer to SharePoint and Google Drive in one `Promise.all` whenever both destinations are configured. Any retention, disposition, or access-review decision about originals must cover both copies. Phase 2 must not preserve that parallel-copy behavior by accident; the approved destination and any optional mirror must be explicit.

Current executable GitHub code describes implementation behavior. The verified nonprofit SharePoint object will describe original-file custody. Human evidence review determines citability. These authority classes must not be collapsed.

## 4. Required research flow

About half of this ladder is enforced by code and about half is procedure. Each transition is marked **ENFORCED** or **PROCEDURAL — NOT ENFORCED**.

| # | Transition | Enforcement |
|---|---|---|
| 1 | source acquired -> preserve original and acquisition provenance in the permanent nonprofit SharePoint archive | **PROCEDURAL — NOT ENFORCED.** The permanent SharePoint target is owner-confirmed, but no research-specific code preserves the governed original there yet. |
| 2 | -> R00 intake when classification or lineage is unresolved | **PROCEDURAL — NOT ENFORCED.** R00 is an approved target workflow state, but no code reads, creates, or routes to the SharePoint folder. |
| 3 | -> human subject classification to R01-R19, or R98 duplicate hold | **PROCEDURAL — NOT ENFORCED.** `researchClassification.ts` constrains the set of application keys, but no code moves archive files. The SharePoint folder implementation is pending verification. |
| 4 | -> register SHADOW Library source as pending review / unverified | **ENFORCED** for the seed path: `import-shadow-research.mjs` refuses rows that arrive approved, verified, or indexed. |
| 5 | -> optionally link to a research requirement | Optional by design. |
| 6 | -> create/process document and chunks | **PROCEDURAL — NOT ENFORCED** as an ordering constraint. |
| 7 | -> generate current-model embeddings | **PROCEDURAL** to perform, but **ENFORCED** as a retrieval precondition. |
| 8 | -> applicability and duplicate review | **PROCEDURAL — NOT ENFORCED.** `/research/review` provides the surface; later evidence steps are not blocked on a verdict. |
| 9 | -> index document | **PROCEDURAL** to perform, **ENFORCED** as a retrieval precondition. |
| 10 | -> human evidence verification and approval in `/evidence` | **ENFORCED.** `shadowLibrary.ts` restricts reviewers and requires approved evidence to be verified. |
| 11 | -> SHADOW retrieval from organization shelf + `__platform__` shelf | **ENFORCED.** Retrieval requires active, approved, verified, non-suppressed sources; indexed, approved, verified documents; and current-model embeddings. |
| 12 | -> human resolution of the research requirement when evidence actually answers it | **ENFORCED that submission cannot do it.** Resolution requires an explicit human action. Whether the evidence actually answers the gap remains procedural. |

No individual transition may be inferred from the previous one:

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

## 5. Controlled subject taxonomy

The application classification taxonomy is defined in `apps/web/src/shared/researchClassification.ts` as `RESEARCH_CLASSIFICATION_DOMAINS`. The table below is the owner-approved target crosswalk for the nonprofit SharePoint archive.

`apps/web/src/shared/researchClassification.test.ts` parses this exact table and asserts it equals the shipped constant. Keep the table's three-column `| R-code | \`key\` | label |` shape.

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

Classification is a human-correctable filing label. It is not an authority tier, an evidence grade, a promotion decision, or an instruction to move a file automatically. R00 and R98 are deliberately absent because they are processing states, not subject domains.

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

**The research importer cannot load that package.** It supplies only one of the five files `import-shadow-research.mjs` requires, and `EXPECTED_COUNTS` pins the loadable corpus to the 2026-08-07 package.

**One part of the package is already in force operationally.** Its warm-up-decay stop rule appears in 63 of the 674 rows of `apps/web/seed-data/drill-library/seed_drill_stop_rules.csv` and is loaded through the drill-library seed path. That crossing was made on a separate recorded owner decision, not through the research importer.

Presence on `main` does not mean a research corpus is imported, indexed, approved, verified, or retrieval-live. Check each artifact's own seed path.

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
- Licensed publisher content is governed by what it is, not by file format. No publisher PDF may be committed to this repository. Existing licensed extracts remain a separate content-governance concern.

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

The next implementation slice is a research-specific, idempotent archive handoff that reuses authenticated SharePoint upload primitives but adds source hashing, provenance, duplicate/lineage checks, stable archive identity, SHADOW source registration, and pending-review defaults. It must fail closed if the governed original cannot be preserved.

No bulk file movement, deletion, retirement, permission change, upload configuration, or production action is authorized until the technical target and pilot are verified.