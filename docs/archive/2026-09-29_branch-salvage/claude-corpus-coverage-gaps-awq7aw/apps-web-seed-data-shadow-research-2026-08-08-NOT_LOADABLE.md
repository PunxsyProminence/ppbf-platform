# This directory is reference data. No loader reads it.

`seed_shadow_library_capability_map.csv` in this directory shares a filename with a file the
importer loads from `2026-08-07/`. It is not a newer version of that file and must not be used
as one. Read this before citing any number in this directory as platform state.

## What is loadable

`apps/web/scripts/import-shadow-research.mjs` requires all five corpus CSVs from a single
directory (`FILES`, and `loadSeedPackage` reads every one of them). This directory has one of
the five. Pointing `PPBF_RESEARCH_SEED_DIR` here throws `ENOENT` on the first read; the
`EXPECTED_COUNTS` guard (1214/14/1193/229) would reject it regardless, and
`.github/workflows/import-shadow-research.yml` exposes no seed-directory input at all.

The loadable corpus is `2026-08-07/`, which the importer hardcodes as `DEFAULT_SEED_DIR`.

What this directory *does* supersede is the evidence registry: `evidence_registry_boxing_learning.csv`
here is a strict superset of `research-evidence/2026-08-07/`'s copy (adds 42 `PS-` and 8 `CB-`
claims; no claim id was dropped). That layer is not loaded into any table either. The commit that
added this directory (`59c8d5f`) says so: "Reference data only -- no migration, no loader,
nothing reads these at runtime." Its supersession sentence is about the registry snapshot, not
the corpus.

## Why the capability map here cannot be compared to 2026-08-07's

Three reasons, each sufficient on its own:

1. **`_boxing_ratio` has a different denominator.** `2026-08-07` computes
   `_boxing_usable / _usable` (matches 30/30 rows). This directory computes
   `_boxing_usable / (_usable + _contested)` (matches 30/30 rows). Any sentence of the form
   "capability X went from N% to M%" across the two files is comparing different quantities.
   Recompute on one convention first.

2. **The decision rule changed.** `2026-08-07` disqualified two capabilities that cleared the
   20% floor on documented gap count (`staffing_supervision_ratios` 32%/12 gaps,
   `capacity_planning` 31%/7 gaps). Here, no `partial` row has a ratio >= 20% and no `covered`
   row is below it — the gap disqualifier is gone. `_coverage_reason` shares no vocabulary
   between the two files ("meets all thresholds" appears on 19 rows there, 0 here). Where a
   verdict differs, that is usually a different evaluator, not new evidence:
   `staffing_supervision_ratios` is `covered` here while its boxing-specific share *fell*
   (7/22 -> 36/131) with the same 12 gaps.

3. **Resolution collapsed to feeder-track aggregates.** In `2026-08-07`, 5 of 9 shared-track
   groups carried distinct per-capability metrics. Here 8 of 9 are identical, so capabilities
   with different `required_source_types` report the same counts — `gym_operations_sop`,
   `emergency_medical_response` and `hygiene_infection_control` (all track B3) read 16/4, 10/1
   and 20/5 there and all read 56/14 here. `emergency_medical_response` reaching `covered` is
   explained by inheriting the B3 aggregate, not by acquiring boxing-specific emergency
   medicine. Relatedly, `skill_assessment_rubrics` (`{peer_reviewed}`) reports a larger usable
   pool than `technical_curriculum` (`{peer_reviewed,governing_body}`) — a narrower type filter
   cannot match more sources, so at least one of that pair is wrong.

`README_PENNSTATE_INTEGRATION.md` states its own status in its first line: `PROPOSED. Nothing
applied.` Its file table also lists `seed_drill_stop_rules.csv`, which is not in this directory.

## The 20% boxing-specificity floor is not enforced anywhere

Both capability maps annotate verdicts with a 20% floor. No code implements it. Coverage is
graded by `recomputeShadowCapabilityCoverage` (`src/server/pilot/shadowLibrary.ts`) on a raw
count of matching sources against `minimum_source_count` — no ratio, no boxing specificity, no
gap or contested count. Only `required_source_types`, `minimum_authority_tier`,
`minimum_source_count` and `feeder_tracks` have runtime meaning, and those four are identical
between the two capability maps. The five other underscore-prefixed columns, including
`_coverage_reason` where the floor prose lives, are dropped by the importer and have no database
column.

`2026-08-07/README_RESEARCH_INTAKE_SEED.md` is explicit that the floor is a
"PROPOSED PPBF PARAMETER — REQUIRES VALIDATION," and that counting sources alone "marked 29 of
30 capabilities `covered`, which is false." That describes the rule the platform actually
applies today.

## Track labels

Both capability maps use exactly 14 feeder tracks: `A1`-`A8` and `B1`-`B6`, enforced by
`researchImportScope.test.ts`. The `R##` folder names in the SharePoint intake tree are not
these tracks and no crosswalk exists between them in this repository. Do not map a capability to
a research folder without one.
