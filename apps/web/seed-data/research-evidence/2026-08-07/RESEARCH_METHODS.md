# Research methods — PPBF/SHADOW evidence registry

**Status:** RESEARCH OUTPUT. This document describes how the evidence registry was produced so
that a reviewer can judge it and, where they wish, reproduce it.
**Registry version:** v3, 1193 claims, 2026-08-07.

---

## 1. What this is, and what it is not

This is a **structured evidence synthesis**, not a systematic review.

That distinction is not modesty, it is a material limitation and it should shape how the registry
is read:

- **No PRISMA protocol.** Searches were not pre-registered, and the search strategy was not fixed
  in advance of looking.
- **No exhaustive search.** Retrieval was carried out by AI agents issuing queries against PubMed,
  OpenAlex, Crossref and web search. Coverage of any given question is not guaranteed to be
  complete, and absence from this registry is weak evidence of absence in the literature.
- **No dual independent screening.** Each research track was executed by a single agent. There was
  no second reviewer independently deciding inclusion.
- **No risk-of-bias instrument** was applied per study (no ROBIS, no Cochrane RoB, no GRADE).
  Evidence classification is a qualitative judgement described in section 4.

What the registry *does* offer is per-claim provenance, independent identifier verification, and
explicit separation of boxing-specific evidence from evidence transferred out of other sports and
sectors. Those properties are what make it auditable.

## 2. How claims were generated

14 research tracks were dispatched in parallel, each covering one domain:

- Finance & sustainability
- Gym craft, wrapping & equipment
- KPIs, retention & dashboards
- Motor learning & practice design
- Operating models & safeguarding
- Operations SOP & incidents
- Ops data crosswalk & authority
- Performance nutrition
- Physical prep, load & risk
- Psychology & life transfer
- Staffing, capacity & station templates
- Stages, pathways & regulation
- Technical curriculum & rubrics
- Video ontology & measurement crosswalk

Each track was given the same evidence rules: never invent a citation, DOI, statistic or effect
size; mark a parameter TBD with a validation method rather than supplying a plausible number;
classify every claim by evidence strength; state the population, competitive level, sex and age
range; and distinguish boxing-specific findings from transferred ones. Each track produced a
registry fragment with a fixed column schema, and the fragments were merged mechanically.

## 3. Verification — what was actually checked

Verification was performed by a synthesis layer **independently of the agent that produced each
claim**. Agent self-reported citation counts were not trusted and were not used.

**542 unique PMIDs** were resolved against NCBI E-utilities. **827 unique DOIs** were
resolved against Crossref. For each, the retrieved title was compared against the citation text on
the row.

| Verification status | Claims |
|---|---|
| `RESOLVED` — PMID and/or DOI resolved | 989 |
| `NON_INDEXED_SOURCE` — governing-body rulebook, statute, regulator or repository document; URL and retrieval date recorded | 163 |
| `NO_IDENTIFIER_BY_DESIGN` — documented negative finding, no source claimed | 41 |

**How each citation was matched** is recorded per row in `title_consistency_check`:

| Method | Claims |
|---|---|
| Title matches citation | 903 |
| Author + year match (author-year citation style) | 70 |
| Manually reviewed — record confirmed | 13 |
| Not applicable (no resolvable identifier) | 204 |

### A defect that was found and corrected

The first verification pass contained a real error, and it is documented here rather than quietly
fixed because it illustrates what this kind of check is for.

PMID extraction used the pattern `\b\d{7,8}\b` against a field that also contained DOIs. That
harvested digit sequences from **inside DOI suffixes**: `10.1080/02640414.2021.2001175` yields
`2001175`, which is a real but entirely unrelated PubMed record. 173 rows were contaminated this
way, and 31 of them had no genuine PMID at all — their "verification" rested on a phantom
identifier that resolved to the wrong paper.

Every one of those rows looked correct in a spreadsheet. The defect was only visible because a
reviewer checked whether a retrieved *title* matched its own citation.

The fix: strip DOIs from the field before looking for PMIDs, re-resolve every identifier from
scratch, run the title-consistency audit that the first pass had skipped, manually review the
residual author-year and multi-source cases, and record per row how each citation was matched.
That is why `title_consistency_check` exists as a column — the claim "no fabricated citations" is
recorded evidence rather than an assertion.

## 4. Evidence classification

Classification is **qualitative**. There are no calibrated percentages anywhere in this registry,
because a confidence percentage that has not been calibrated against outcomes is a false precision.

| Class | Claims | Meaning |
|---|---|---|
| VERIFIED EVIDENCE | 1004 | Supported by a retrievable peer-reviewed source or an authoritative primary document |
| STRONG EVIDENCE-SUPPORTED INFERENCE | 58 | A reasoned step beyond what the source states, with the step named |
| INSUFFICIENT EVIDENCE | 55 | A structured search was run and returned nothing usable. A documented negative finding |
| CONTESTED PRACTICE | 34 | Credible sources disagree; the disagreement is recorded rather than resolved |
| HYPOTHESIS REQUIRING TESTING | 22 | Plausible, untested, stated as a question |
| COACHING/FILM-STUDY INTERPRETATION | 16 | Craft knowledge, labelled as such |

A small number of rows carry compound classes where a rule is verified but a threshold is not
(e.g. "VERIFIED EVIDENCE (for the rule) / INSUFFICIENT EVIDENCE (for a threshold)"). Those splits
are deliberate and are preserved verbatim.

## 5. The most important structural finding

**376 of 1193 claims (32%) are boxing-specific.** The remainder is transferred from other
sports, from general exercise science, or from other sectors entirely — youth-programme delivery,
nonprofit management, out-of-school-time programme quality.

This is the state of the field rather than a gap in the search. Boxing has a thin research base
relative to team sports, and several domains covered here — programme operations, coaching
psychology, nonprofit finance — have essentially no boxing-specific literature at all.

Every row carries `boxing_specific` and `transfer_status` so this is visible per claim, and the
product is required to display it rather than hide it. A finding transferred from collegiate
soccer to a twelve-year-old boxer may still be the best available evidence; it is not the same
thing as evidence about boxing.

## 6. Known limitations

1. **Search is not exhaustive.** See section 1. Treat INSUFFICIENT EVIDENCE as "a structured search
   found nothing", not "nothing exists".
2. **Single-reviewer screening.** No inter-rater agreement was established on inclusion decisions
   or on evidence classification.
3. **Abstract-level extraction for paywalled work.** Where full text was unavailable, claims were
   built from abstracts. Abstracts systematically omit sample-size breakdowns, protocol detail,
   confidence intervals and limitations sections, so those claims are thinner than they appear and
   were classified conservatively.
4. **Classification is judgement.** Two competent reviewers could place the same study in adjacent
   classes. The class is a guide to how much weight to put on a row, not a measurement.
5. **No risk-of-bias appraisal per study.** Study design and sample size are recorded, but no
   formal appraisal instrument was applied.
6. **Currency.** Retrieved 2026-08-07. Literature moves; several claims concern active
   controversies. See the retraction surveillance package for how the corpus is kept honest over
   time.

## 7. Reproducing the verification

`verify-research-citations.mjs` re-runs the identifier verification end to end:

```
node apps/web/scripts/verify-research-citations.mjs --csv evidence_registry_boxing_learning.csv
```

CSV mode requires **no database, no credentials and no access to PPBF infrastructure**. It
re-resolves every PMID against NCBI and every DOI against Crossref, compares retrieved titles
against the citations, and reports any row that does not match.

`check-source-retractions.mjs` screens the same file for retractions and expressions of concern
against PubMed `pubtype` and Crossref's Retraction Watch data. At the time of writing, 542 unique
PMIDs screened clear. That result is only meaningful because the detector was positive-controlled
against a known retracted paper (PMID 9500320) on both services and fired correctly.

An outside reviewer running these does not have to take any claim in this document on trust.

## 8. Registry columns

29 columns per claim: `claim_id`, `track`, `topic`, `claim`, `evidence_class`, `confidence`, `population`, `competitive_level`, `sex`, `age_range`, `study_design`, `sample_size`, `effect_or_estimate`, `boxing_specific`, `transfer_status`, `limitations`, `source_type`, `citation`, `doi_or_pmid`, `url`, `verification`, `ppbf_implication`, `tbd_flag`, `agent`, `independent_verification_status`, `independent_verification_detail`, `verified_title`, `track_name`, `title_consistency_check`.
