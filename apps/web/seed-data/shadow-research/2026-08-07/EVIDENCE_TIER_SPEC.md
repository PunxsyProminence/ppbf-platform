# SHADOW Evidence Tier — Quality-Weighted Mapping Specification

**Status:** PROPOSED — research output. Authorizes no code change; implementation is your team's call.
**Prepared:** 2026-08-07 · **Target:** `apps/web/src/server/pilot/shadowEvidenceTier.ts`
**Keeps:** the four existing client-facing labels `PROVEN` / `EMERGING` / `EXPERIMENTAL` / `RESEARCH_NEEDED`.
**Changes:** what drives them — study quality and population, instead of citation count.

---

## 1. The problem

The implemented rule grades by how many citations were retrieved:

```
!isAnsweredState || availability === 'unavailable'  -> RESEARCH_NEEDED
citationCount >= 2                                  -> PROVEN
citationCount === 1                                 -> EMERGING
otherwise                                           -> EXPERIMENTAL
```

Citation count measures *retrieval success*, not *evidence strength*. Two cross-sectional studies in adult
male professionals score `PROVEN`. A single Cochrane-grade systematic review scores `EMERGING`. A contested
finding with sources on both sides scores `PROVEN` precisely because it is contested — disagreement produces
more citations, not fewer.

**Measured impact against the 1,193-claim registry: 647 claims the current rule labels `PROVEN` would not
be under the proposed rule.** Of those, 440 are transferred from non-boxing populations and 45 are
contested, insufficient, or untested hypotheses. A coach reading `PROVEN` on any of them is being told
something the evidence does not support.

## 2. The proposed rule

Three inputs, all present in the seeded chunk metadata:

| Input | Source | Values |
|---|---|---|
| `evidence_class` | chunk metadata | VERIFIED EVIDENCE / STRONG EVIDENCE-SUPPORTED INFERENCE / CONTESTED PRACTICE / HYPOTHESIS REQUIRING TESTING / COACHING-FILM-STUDY INTERPRETATION / INSUFFICIENT EVIDENCE |
| `authority_tier` | `shadow_library_sources.authority_tier` | 1–5, **lower = more authoritative** (matches the existing `authority_tier <= minimum_authority_tier` coverage test) |
| `boxing_specificity` | chunk metadata | boxing_specific / partly_boxing_specific / ppbf_specific / transferred |

```
deriveEvidenceTier(claim):

  # Answer-state gate is UNCHANGED — a degraded/filtered/queued response still grades RESEARCH_NEEDED
  if !isAnsweredState or availability == 'unavailable'      -> RESEARCH_NEEDED

  if evidence_class == INSUFFICIENT EVIDENCE                -> RESEARCH_NEEDED
  if evidence_class in (CONTESTED PRACTICE,
                        HYPOTHESIS REQUIRING TESTING,
                        COACHING/FILM-STUDY INTERPRETATION) -> EXPERIMENTAL

  if evidence_class == STRONG EVIDENCE-SUPPORTED INFERENCE:
      authority_tier <= 3                                   -> EMERGING
      else                                                  -> EXPERIMENTAL

  if evidence_class == VERIFIED EVIDENCE:
      authority_tier <= 2 and boxing-specific               -> PROVEN
      authority_tier <= 3                                   -> EMERGING
      else                                                  -> EXPERIMENTAL
```

**Two invariants worth stating explicitly, because they are the point of the change:**

1. **`PROVEN` requires boxing-specific evidence at authority tier 1–2.** Transferred evidence never reaches
   `PROVEN`, however much of it there is. In the registry this leaves 115 of 1,193 claims at `PROVEN` — all
   boxing-specific, none contested.
2. **A contested claim can never read as `PROVEN`.** Under the count rule it frequently would.

## 3. Authority tier scale

Assigned per source; `shadow_library_sources.authority_tier` is a smallint clamped 1–5 by `clampAuthorityTier`.

| Tier | Contents | Rationale |
|---|---|---|
| 1 | Governing-body rulebooks and regulations in force; consensus statements and position stands (IOC, ACSM, ISSN, NATA, AAP) | Rules ARE the ground truth for eligibility, equipment and procedure — not evidence about the world but the authority itself |
| 2 | Systematic reviews and meta-analyses | Strongest synthesis of primary research |
| 3 | Controlled trials, cohort and primary peer-reviewed research; textbooks; internal PPBF policy | Primary evidence, single-study uncertainty |
| 4 | Narrative reviews, opinion, editorials, commentary, preprints; PPBF planning assumptions; labelled inference | Not peer-validated primary evidence |
| 5 | Media, trade press, wiki, vendor and industry-survey material; documented negative findings | Lowest authority; retained for traceability, not for grounding advice |

## 4. Distribution under the proposed rule

| Tier | Claims | Share |
|---|---|---|
| PROVEN | 115 | 10% |
| EMERGING | 796 | 67% |
| EXPERIMENTAL | 227 | 19% |
| RESEARCH_NEEDED | 55 | 5% |

The full input-to-output mapping is in `evidence_tier_mapping_table.csv`.

## 5. Implementation notes for your team

- The **answer-state gate is unchanged** — the existing `isAnsweredState` / `availability` short-circuit
  stays exactly as written, and still resolves to `RESEARCH_NEEDED`.
- The three new inputs are already present on every seeded chunk's `metadata` JSONB, so no schema change
  is required to evaluate this rule.
- The four label values are unchanged, so **no client-facing string or UI component changes.**
- `citationCount` becomes a tiebreak or display detail rather than the grading input. Retaining it as a
  displayed count alongside the tier is reasonable; using it to *set* the tier is what this proposal removes.
- Recommended migration check: run both rules side by side over the seeded corpus and review the 647
  differing rows before switching. The comparison is reproducible from the registry.

## 6. What this does not do

It does not make weak evidence strong. Most of the corpus lands at `EMERGING`, which is the honest answer
for a field where 60% of the evidence is transferred from other populations. The purpose of the change
is to stop `PROVEN` from being reachable by accumulation of weak or contested sources.
