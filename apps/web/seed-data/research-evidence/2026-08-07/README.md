# PPBF/SHADOW research evidence — peer review package

**Retrieved 2026-08-07.** Research output. Authorizes nothing and changed no production system.

This package exists so that an outside reviewer — a funder, an academic collaborator, a governing
body, or a parent who asks why their child is being taught a particular way — can find the
evidence behind a claim, check it, and re-run the verification themselves.

---

## Start here

**[RESEARCH_METHODS.md](RESEARCH_METHODS.md)** — how the research was conducted, what was verified
and how, and the limitations. Read this before the registry. It states plainly that this is a
structured evidence synthesis rather than a systematic review, and why that distinction matters.

## Contents

| File | What it is |
|---|---|
| `RESEARCH_METHODS.md` | Method, verification procedure, evidence classification, limitations |
| `evidence_registry_boxing_learning.csv` | 1193 claims, 29 columns each |
| `cross_track_conflict_ledger.csv` | 34 documented disagreements with adjudications |
| `track_evidence_summary.csv` | Per-track claim counts and boxing-specificity |

## How to read the registry

One row per claim. The columns that matter most to a reviewer:

- `evidence_class` — how strong the support is. Filter to `CONTESTED PRACTICE` or
  `INSUFFICIENT EVIDENCE` to see what is *not* settled.
- `boxing_specific` and `transfer_status` — whether the evidence is about boxing or transferred
  from another sport or sector. **32% is boxing-specific**; the rest is transfer, and the
  registry says so per row.
- `citation`, `doi_or_pmid`, `url` — the source.
- `independent_verification_status` — whether the identifier was independently resolved by the
  synthesis layer, and not merely asserted by the agent that produced the claim.
- `verified_title` — the title the identifier actually resolved to. Compare it against `citation`.
- `title_consistency_check` — **how** that comparison was made per row: exact title match,
  author-and-year match for author-year citation style, or manual review.
- `limitations` and `ppbf_implication` — what the source does not support, and what was drawn from it.

## Verify it yourself

Neither of the following needs a database, credentials, or any access to PPBF systems.

```
node apps/web/scripts/verify-research-citations.mjs --csv evidence_registry_boxing_learning.csv
node apps/web/scripts/check-source-retractions.mjs  --csv evidence_registry_boxing_learning.csv
```

The first re-resolves every PMID against NCBI E-utilities and every DOI against Crossref, compares
retrieved titles to the citations, and reports any row that does not match. The second screens the
same file for retractions and expressions of concern.

At the time of writing, 542 unique PMIDs and 827 unique DOIs resolve, and the retraction screen
is clear. Do not take that on trust — the scripts are there so you don't have to.

## The conflict ledger

34 disagreements between sources, or between sources and common practice, each with both positions,
an adjudication, and the resulting PPBF action. Several resolved *against* standard coaching
practice.

**Three were escalated as requiring a human decision** — research cannot settle them:

| ID | Topic | Action required |
|---|---|---|
| `CT-11` | AAP/CPS opposition to youth boxing | ESCALATE TO BOARD AND MEDICAL ADVISOR. PPBF must adopt a written, board-approved position that acknowledges the AAP/CPS statement by name, states PPBF |
| `CT-13` | Attendance source of truth | Declare ONE authoritative attendance source in writing before any KPI ships. Recommendation: pilot.attendance as the athlete-day system of record, sch |
| `CT-15` | Emergency contact duplication | Consolidate to pilot.emergency_contacts; deprecate the column with a migration and a read-path audit. Safety-critical, so this ranks above feature wor |

**Five became prohibited claims or prohibited automated decisions:**

| ID | Topic | Adjudication |
|---|---|---|
| `CT-05` | Aggression: does boxing increase or decrease it? | GENUINELY BIDIRECTIONAL. Moderators (traditional vs modern instruction, coach behaviour, climate) are the plausible mechanism but are not established  |
| `CT-07` | Neck strength and concussion risk | RESOLVED AGAINST THE PROTECTIVE CLAIM. Neck training may be justified for other reasons (performance, tolerance of routine loading) but not as concuss |
| `CT-24` | Individual injury prediction | RESOLVED AGAINST. No validated individual injury prediction exists in this domain. |
| `CT-25` | Hand wrapping as injury prevention | CONTESTED. Wrapping rests on mechanical reasoning, governing-body MANDATE and tradition — not trial evidence. The mandate alone is sufficient reason t |
| `CT-27` | Wrap approval authority | RULE-DERIVED HARD BOUNDARY. Not a design preference. |

## What a reviewer should be sceptical about

Stated plainly, because a reviewer will find these anyway and it is better that they are declared:

1. **This is not a systematic review.** No pre-registered protocol, no exhaustive search, no dual
   independent screening, no formal risk-of-bias appraisal. Section 1 of the methods document.
2. **Searches were run by AI agents.** Retrieval coverage is not guaranteed. `INSUFFICIENT
   EVIDENCE` means a structured search found nothing, not that nothing exists.
3. **Evidence classification is qualitative judgement.** Two competent reviewers could place the
   same study in adjacent classes.
4. **Claims built from abstracts are thinner than they look.** Where full text was paywalled,
   sample-size breakdowns, protocol detail and limitations sections were unavailable.
5. **A verification defect was found and corrected.** The first pass mis-extracted PMIDs from
   inside DOI suffixes, contaminating 173 rows. It is documented in section 3 of the methods
   document rather than quietly fixed, because it is the clearest illustration of why identifier
   verification has to be mechanical rather than assumed.

## Provenance

Produced by a 14-track parallel research programme. Each track had the same evidence rules: never
invent a citation, DOI, statistic or effect size; mark unavailable parameters TBD with a validation
method rather than supplying a plausible number; classify every claim by evidence strength; and
state population, competitive level, sex and age range.

Verification was performed independently of the agents that produced the claims. Agent
self-reported citation counts were not used.
