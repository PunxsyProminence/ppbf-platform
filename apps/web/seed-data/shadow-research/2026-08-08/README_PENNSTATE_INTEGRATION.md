# Penn State Integration — Package 9

**Status:** PROPOSED. Nothing applied.
**Date:** 2026-08-08

Integrates the 42 verified Penn State claims into the existing work. Four changes plus a bug fix.

---

## 1. Registry merged and re-verified

**1,193 -> 1,235 claims.** Every new identifier was re-resolved independently rather than trusted from
the extraction pass:

| check | result |
|---|---|
| New PMIDs resolved against NCBI | **15/15** |
| New DOIs resolved against Crossref | **14/14** |
| Cited title vs live NCBI record | **0 mismatches** |
| Numeric values traced to source PDF text | **42/42** |

PMID extraction strips DOIs *before* pattern-matching — the guard against the ghost-PMID defect where a
seven-digit fragment inside a DOI suffix resolved cleanly to an unrelated paper.

Overall boxing-specificity holds at 32%; the new material is concentrated rather than spread.

## 2. Conflict ledger: 34 -> 36, one revision

**CT-23 revised — session-RPE.** The prior adjudication said PPBF's internal-load foundation rested
entirely on transfer from karate and taekwondo. That is no longer accurate.

PMID 24570606 is boxing-specific: 8 boxers, matched-pairs randomized, three intensities. Session-RPE at
10 minutes did not differ significantly from 30 minutes at easy (1.3±1.0 vs 1.7±1.0 AU), moderate
(2.7±1.6 vs 2.5±0.9 AU) or hard (5.7±1.0 vs 5.8±1.9 AU).

**What changes:** the app accepts session-RPE anywhere in a 10-30 minute window without down-weighting
late entries. **What does not:** n=8, one squad, adult male, no youth or adaptive participants. The
validation study is re-scoped from "establish this in boxing" to "extend it to the populations PPBF
actually serves."

**CT-35 added — post-activation potentiation, resolved against prescription.** In boxers the effects are
small and individual (worthwhile changes only; RFD gains limited to the cross; 6 boxers responded best to
one protocol). More decisively, the *same* back-squat conditioning activity significantly **increased**
peak torque in one measure and significantly **decreased** peak torque and average power in another.

A single prescribed protocol would help some athletes and degrade others, and nothing here identifies who
is who in advance. PAPE may be a coach-selectable warm-up option with the caveat shown. **SHADOW must not
recommend a potentiation protocol to a named athlete or infer responder status from performance data.**

**CT-36 added — warm-up decay, resolved as an actionable rule.** In elite boxers a standardized warm-up
produced a **4.8% CMJ increase**, and a **25-minute inactive gap** produced decreases in CMJ height and
upper-body power. One of the few findings in this batch that is boxing-specific, directional, and usable
without further validation.

## 3. Warm-up decay is now a real stop rule

Added to **63 of 119 drills** — those involving contact or maximal effort, not every drill:

> Re-warm before contact or maximal effort if more than ~20 minutes of inactivity has passed since the
> warm-up (ring wait, bout delay, late start).

Stop rules 611 -> 674. New `rule_kind` value `warmup_decay`. Bypassable with a note like every other flag.

## 4. Physical test battery: four entries upgraded

| test | was | now |
|---|---|---|
| CMJ height | general test | **state-sensitivity in boxers established** (PMID 27191695) |
| Medicine ball throw | general test | class-level boxing evidence; this test still unvalidated in boxers |
| Landmine punch throw | tested in boxers | **transfer to punch impact quantified**, TEC ~0.80 (PMID 31009434) |
| Instrumented punch force | tested in boxers | **determinants and measurement conditions established** |

The punch-force entry gained a measurement condition that matters operationally: impact was higher at
self-selected than fixed distance for the jab, and higher in males than females. **Distance condition and
sex must be recorded or punch-force scores are not comparable across athletes or sessions.**

## 5. A bug I found and fixed in my own coverage computation

Re-running capability coverage produced an obviously wrong result: five capabilities dropped to zero
claims. The cause was mine — the feeder-track column uses `|` for multi-track entries (`A3|A6`), and my
recompute split on `,` only, producing track literals that matched nothing.

Fixed. **Zero capabilities now compute from an empty claim set**, which is the check that would have
caught it immediately.

Corrected coverage: **20 covered, 10 partial, 0 uncovered.** Eight capabilities changed state — those
changes reflect the corrected parsing, not the new evidence, and are more accurate than the prior values.

The physical-prep capabilities improved on boxing-specificity as expected: physical_preparation 32% ->
42%, load_monitoring 34% -> 42%.

**Still transfer-dependent and correctly flagged partial:** life-skill transfer (1%), psychology (1%),
finance (2%). Those are the state of the field, not a search gap.

## Files

| file | change |
|---|---|
| `evidence_registry_boxing_learning.csv` | 1,193 -> 1,235 claims |
| `cross_track_conflict_ledger.csv` | 34 -> 36; CT-23 revised |
| `seed_drill_stop_rules.csv` | 611 -> 674 |
| `physical_test_battery.csv` | 4 entries upgraded |
| `seed_shadow_library_capability_map.csv` | recomputed, parsing bug fixed |

## Two things I deliberately did not do

**No punch-force prediction model.** The r = 0.67-0.85 correlations are tempting, but CT-24 already
resolved against individual prediction in this domain, and these are small elite adult male samples.
A correlation in 20 elite boxers is not a formula for a community gym.

**Nothing from the heat-training papers.** Repeated sprint training in heat is real evidence, but applying
it to youth athletes is a medical-supervision question rather than a programming one.
