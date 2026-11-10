Status: DRAFT, not app source until handoff (RULES.md)

# Evidence vocabulary (plan phase 2, step "Reconcile evidence-tier vocabulary")

Draft; the vocabulary was set at checkpoint 1 (Jason, 2026-10-24). One vocabulary for every
backbone claim, merging the Evidence Synthesis tags with the repo's evidence-tier code, with an
explicit UNTIERED label and a separate rule / convention / framework category (change D).
RULES.md section 4 now records it (RC-1, accepted amended: slash labels, all seven categories,
owner decisions shown as CONVENTION; D-RC01). Outside comparison with GRADE and the Oxford CEBM
levels: DESIGN_CHECKS.md section 2. Checkpoint-1 answers D-Q25 (research label words) and
D-PK06 (owner decisions show CONVENTION) are folded in (table at the end).

## 1. Four labels, kept apart

1. Status (RULES section 10): OBSERVED, REPORTED, INFERRED, UNVERIFIED. How well we know
   that a source says it.
2. Evidence category: what kind of support it is (section 3).
3. Evidence label: what the coach sees (section 3). Research tiers only after a check.
4. Check state: unchecked, verified, corrected, not_found (plan step "Verify references").

Authorship stays a fifth, separate field: `field_provenance` and `content_class` on
repo records (for example "LITERATURE-GROUNDED DRAFT ... REQUIRES FLOOR VALIDATION"). An
AI-drafted drill can cite strong research; an owner drill can rest on convention. Mixing
authorship into the evidence label would hide that. INFERRED.

## 2. What was merged

Evidence Synthesis (inputs/, unreviewed AI export, RULES section 4), tag counts in the body
text (vocabulary line excluded), OBSERVED by count:

| Tag | Meaning in the Synthesis | Count |
|---|---|---|
| [SR/MA] | systematic review / meta-analysis backed | 38 |
| [PS] | primary-study backed | 31 |
| [GB] | governing-body guidance | 12 |
| [CC] | coach consensus / practice-based | 10 |
| [AI-H] | AI extrapolation / uncited heuristic | 5 |

Repo evidence code at `6ab8f547` (OBSERVED):

- `shadowEvidenceTier.ts`: client labels PROVEN, EMERGING, EXPERIMENTAL, RESEARCH_NEEDED,
  derived from three inputs: `evidence_class` (VERIFIED EVIDENCE, STRONG EVIDENCE-SUPPORTED
  INFERENCE, CONTESTED PRACTICE, HYPOTHESIS REQUIRING TESTING, COACHING/FILM-STUDY
  INTERPRETATION, INSUFFICIENT EVIDENCE), `authority_tier` 1-5 (lower is stronger), and
  `boxing_specificity` (boxing_specific, partly_boxing_specific, ppbf_specific, transferred).
  PROVEN needs VERIFIED EVIDENCE, tier 1-2, boxing-specific. A contested claim never reads
  PROVEN. Spec: `seed-data/shadow-research/2026-08-07/EVIDENCE_TIER_SPEC.md`.
- Distribution of the 1,193-claim registry under that rule (mapping table):
  PROVEN 122, EMERGING 821, EXPERIMENTAL 195, RESEARCH_NEEDED 55.
- `transfer_claims.evidence_class`: EVIDENCE-SUPPORTED, MECHANISM-THEORISED, COACHING INTENT,
  CONTESTED, INSUFFICIENT EVIDENCE.
- `assessment_protocols`: free-text `evidence_class` (default INSUFFICIENT EVIDENCE),
  `reliability_status` (default UNVALIDATED - PPBF MUST ESTABLISH), `validity_status`
  (default UNKNOWN), `boxing_specific` (default NO - transferred).
- `drill_library.field_provenance`: PPBF source manual v3, PPBF owner-authored,
  LITERATURE-GROUNDED DRAFT, COACHING-CRAFT DRAFT (authorship, not evidence).

## 3. The vocabulary

Evidence category (one per claim):

| Category | Use for | Examples |
|---|---|---|
| `research` | studies and syntheses of studies, including consensus statements and position stands | Ford 2011 on LTAD; Gawad 2019 on rater training; ACSM 2021 weight-loss consensus |
| `rule` | a governing-body rule, regulation or statute in force, with the route it governs | USA Boxing rule book; 58 Pa. Code Chapter 21; owner rules that restate a governing-body rule |
| `convention` | coaching practice: PPBF owner system, Long Road practice numbers, outside practice, coach consensus | sparring ceilings (LR-139, LR-140); pro-practice reference; DOC-023 cautions |
| `framework` | a developmental or conceptual model used as structure | LTAD, Canadian Sport for Life, Boxing Canada LTAD |
| `owner_decision` | a decision Jason made that is not a governing-body rule (defaults catalog rows and recommendation claims); shown with the label CONVENTION (D-PK06) | recreation lane tracks; pro override condition |
| `information` | a factual note shown to humans (insurance reach, membership status) | USA Boxing insurance note |
| `unassigned` | nothing assigned yet | most Long Road numbers until the evidence pass |

Evidence label (what the coach sees, one per claim):

| Label (stored) | Shown as (D-Q25) | When | Shown with |
|---|---|---|---|
| PROVEN | Strong / High | category research, checked, repo rule gives PROVEN | source list |
| EMERGING | Moderate / Moderate | category research, checked, repo rule gives EMERGING | source list |
| EXPERIMENTAL | Limited / Low | category research, checked, repo rule gives EXPERIMENTAL | source list |
| RESEARCH_NEEDED | Not assignable / Very low | category research, checked, and the evidence is insufficient | the gap |
| RULE | RULE | category rule | the governing body, and either "requirement on <route>" or "reference only here" |
| CONVENTION | CONVENTION | category convention, or category owner_decision (D-PK06) | whose practice (PPBF owner decision, PPBF owner system, Long Road, outside practice) and "not research evidence" |
| FRAMEWORK | FRAMEWORK | category framework | "structure, not evidence" |
| UNTIERED | UNTIERED | anything unchecked, unassigned, or [AI-H] without a source | "no checked evidence yet" |

Research label words (D-Q25; spine settled list, Jason 2026-10-25): the four research labels
are shown with both scales and a slash: Strong / High, Moderate / Moderate, Limited / Low,
Not assignable / Very low. The first word is the 2018 US Physical Activity Guidelines Advisory
Committee (PAGAC) grade; the second is GRADE certainty. The pairing is ours and approximate:
no published crosswalk was found (INFERRED; DECISION_CHECKS 18.6 and 18.12), and write-ups must
say so. The four repo values stay underneath and are still computed by the unchanged
`deriveEvidenceTier` rule; only the words shown change (a Claude Code change after handoff).
The app still grades single claims, not bodies of evidence.

Key distinctions:

- UNTIERED is not RESEARCH_NEEDED. UNTIERED means nobody has checked yet. RESEARCH_NEEDED
  is a finding: someone checked and the evidence is insufficient.
- RULE, CONVENTION and FRAMEWORK are never research tiers. A USA Boxing rule is not
  "PROVEN"; it is a rule with a scope. A sparring ceiling is CONVENTION, as the plan
  requires.
- Research tiers are computed with the repo's `deriveEvidenceTier` rule, unchanged, so the
  app and the backbone agree. Only checked items get a research tier (RULES section 4).
- Owner decisions show the label CONVENTION (D-PK06). Their category stays owner_decision
  (rule 5), which tells them apart from Long Road or outside practice.
- A RULE label names its route. USA Boxing rules are a requirement on the USA Boxing
  amateur competition route and a reference elsewhere; a state commission rule is a
  requirement for a pro bout in that state (RULES section 9).

## 4. Mappings

Synthesis tags to the backbone (all tags are AI proposals and start unchecked):

| Tag | Category | Inputs for the repo rule after the check | Label before the check |
|---|---|---|---|
| [SR/MA] | research | study_design systematic review / meta-analysis; authority_tier 2 | UNTIERED |
| [PS] | research | study_design primary study; authority_tier 3 | UNTIERED |
| [GB] | rule if it is a rule in force; research (consensus statement, authority_tier 1) if it is guidance or a position stand | decided per source | UNTIERED (RULE once the rule text is checked) |
| [CC] | convention | none | CONVENTION |
| [AI-H] | unassigned | needs a source first | UNTIERED |

Repo `transfer_claims.evidence_class` (INFERRED mapping, for the merge at handoff):

| Repo value | Category | Repo evidence_class equivalent |
|---|---|---|
| EVIDENCE-SUPPORTED | research | VERIFIED EVIDENCE (registry claim id required) |
| MECHANISM-THEORISED | research | HYPOTHESIS REQUIRING TESTING |
| COACHING INTENT | convention | none |
| CONTESTED | research | CONTESTED PRACTICE |
| INSUFFICIENT EVIDENCE | research | INSUFFICIENT EVIDENCE (RESEARCH_NEEDED once checked) |

`assessment_protocols`: keep the three repo fields as they are; set the backbone
category to research for the measurement claim. `reliability_status` stays UNVALIDATED
until PPBF's own reliability data exist; the youth gate protocol produces that data for
the scorecard.

Spine defaults (design_catalogs.json, 152 records after the 48 LR-140 rows of D-Q15):
convention 104, unassigned 33, owner_decision 8, information 6, rule 1. Every default with a value
is UNTIERED or CONVENTION today; nothing carries a research tier. The 8 owner_decision rows
show CONVENTION (D-PK06).

## 5. One change the repo needs (for Claude Code)

The repo's authority tier 1 covers both governing-body rulebooks and consensus statements
(EVIDENCE_TIER_SPEC.md section 3). A verified, boxing-specific rulebook claim at tier 1
therefore grades PROVEN in SHADOW chat. A text match on the registry's `source_type` and
`study_design` columns finds 94 claims that name a rulebook,
regulation or statute; 90 are VERIFIED EVIDENCE and
67 of those are marked boxing-specific. Provisional: a
keyword match, and the authority tier sits on the source rows, which I did not read. Accepted
(SP-10, D-SP10; schema P18, which also gives each evidence item six provenance fields): add
`evidence_category` to library sources and chunks so rule sources display as RULE. The
derivation rule itself does not change.

## 6. Assignment rules

1. Default label UNTIERED. Nothing gets a research tier it has not earned (RULES section 4).
2. Sparring and hard-round ceilings, pro-practice references and DOC-023 cautions are
   CONVENTION now; their category is known from the source kind, and no check can make them
   research evidence (plan step "Tier the defaults").
3. LTAD and related models are FRAMEWORK. Claims that rely on fixed windows of opportunity
   stay UNTIERED (VALIDATION_REVIEW item 1).
4. Governing-body text is RULE only after the rule text is checked against the edition in
   force (for USA Boxing, the 2026 rule book is still an evidence-pass item).
5. Owner decisions keep their OBSERVED status; their category is owner_decision unless
   they restate a governing-body rule; their label is CONVENTION (D-PK06).
6. Every recommendation shows one label per claim (change B). A claim with no source shows
   UNTIERED, never a blank.

## Decisions applied (checkpoint 1)

Folded 2026-10-24 (US Eastern; decision records labelled 2026-10-25). Register:
working/drift/DECISION_REGISTER.json. D-RC01, D-SP10 and D-PK06 added 2026-10-24 (checkpoint-1
review, register v1.4).

| D-ID | Decision (register wording) | Where applied in this file |
|---|---|---|
| D-Q25 | Research labels show both scales: Strong / High, Moderate / Moderate, Limited / Low, Not assignable / Very low (approximate pairing) | Section 3, label table ("Shown as") and the research label words paragraph |
| D-RC01 | RULES s4 evidence vocabulary set (accept, amended): slash labels, all seven categories, owner decisions shown as CONVENTION | Opening paragraph (RULES section 4 now records the vocabulary) |
| D-SP10 | P18 evidence items with six provenance fields; evidence_category on SHADOW sources | Section 5 |
| D-PK06 | Owner decisions show the label CONVENTION | Section 3 (category and label tables; key distinctions); section 4 (the 8 owner_decision catalog rows); section 6 rule 5 |
