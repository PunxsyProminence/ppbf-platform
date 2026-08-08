# Research evidence registry

Where the evidence behind SHADOW's coaching guidance lives, and how to check it.

## The package

`apps/web/seed-data/research-evidence/2026-08-07/`

| File | Contents |
|---|---|
| `README.md` | Start here — how to read the registry, how to verify it |
| `RESEARCH_METHODS.md` | Method, verification, evidence classification, limitations |
| `evidence_registry_boxing_learning.csv` | 1193 claims across 14 research tracks |
| `cross_track_conflict_ledger.csv` | 34 adjudicated disagreements |
| `track_evidence_summary.csv` | Per-track counts and boxing-specificity |

## What it is for

Three audiences, one artefact:

- **A funder or board member** asking what the coaching guidance rests on.
- **A parent** asking why their child is being taught a particular way.
- **An academic reviewer** checking whether a cited paper says what the claim says it says.

The registry is the answer to all three, and the verification scripts mean none of them has to take
it on trust.

## Verifying it

```
npm run verify:research-citations -- --csv apps/web/seed-data/research-evidence/2026-08-07/evidence_registry_boxing_learning.csv
npm run check:retractions        -- --csv apps/web/seed-data/research-evidence/2026-08-07/evidence_registry_boxing_learning.csv
```

Both run without a database or credentials. See `docs/CITATION_VERIFICATION.md` and
`docs/RETRACTION_SURVEILLANCE.md`.

## Relationship to the seeded library

The registry is the **reference layer**; it is not loaded into the database. The corpus that *is*
loaded lives in `apps/web/seed-data/shadow-research/2026-08-07/` and is derived from these same
claims. The registry explains and evidences that corpus, and holds the columns — limitations,
transfer status, verification method — that a reviewer needs and a retrieval system does not.

## Three things a reader should know before using it

1. **32% of claims are boxing-specific.** The rest is transferred from other sports and
   sectors, and the registry marks which per row. Transferred evidence may still be the best
   available, but it is not evidence about boxing.
2. **This is a structured evidence synthesis, not a systematic review.** No pre-registered
   protocol, no exhaustive search, no dual independent screening. Stated in full in the methods
   document.
3. **Three conflicts were escalated as requiring human decisions** and are not resolvable by
   research. See the conflict ledger — `CT-11`, `CT-13`, `CT-15`.
