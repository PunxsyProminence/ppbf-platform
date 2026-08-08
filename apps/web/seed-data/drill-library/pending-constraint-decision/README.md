# Held back: two seed files the schema currently rejects

These two CSVs came from the proposed-migrations archive
(`PPBF_Proposed_Migrations_v2_2026-08-08`, folder 01). They are **not** in
`seed-data/drill-library/` because `seed-drill-library.mjs` reads that
directory, and loading either file aborts the whole seeding transaction
against the shipped schema.

They are kept here rather than deleted: the data is real research output and
the mismatch is a decision, not a defect to clean up. `seed-drill-library.mjs`
treats an absent optional CSV as a graceful skip, so with these parked the
loader and its real-Postgres test suite run green.

**Neither the CHECK constraints nor the seed values have been edited.** Which
side is wrong is the drill-library owner's call.

## `seed_drill_scale_levels.csv` — 357 rows, 228 rejected

`drill_scale_levels_authoring_state_check` permits only `authored` and
`scaffold_needs_coach_review`. 228 rows carry `literature_grounded_draft`,
which the archive's own `README_DRILL_LIBRARY_V3.md` documents as the
intended state for the A and C scale rows.

## `seed_drill_stop_rules.csv` — 674 rows, 63 rejected

`drill_stop_rules_rule_kind_check` permits only `technique_degradation`,
`fatigue`, `safety`, `intent_drift` and `coach_judgment`. The 63 new rows
carry `warmup_decay` — the warm-up decay batch backed by PMID 27191695, which
attaches to contact and maximal-effort drills only. Verified against a real
Postgres instance rather than inferred from the SQL: `fatigue` is accepted,
`warmup_decay` is rejected.

The other 611 rows in this file are byte-identical to the v1 archive's and
carry no violation; the file is held back whole because the loader runs all
drill-library CSVs in one transaction.

## Both are the same shape

A CHECK vocabulary that has not caught up with data the archive intends. Two
ways forward, both owner decisions:

1. **Widen the vocabulary** — an additive migration adding
   `literature_grounded_draft` to the authoring-state CHECK and `warmup_decay`
   to the rule-kind CHECK, then move these files back up one directory.
2. **Correct the data** — map the rejected rows onto the existing vocabulary,
   if the archive's values were not meant as new states.

`seed_drill_cues.csv` (258 rows) had no violation and stays in the loader's
directory.
