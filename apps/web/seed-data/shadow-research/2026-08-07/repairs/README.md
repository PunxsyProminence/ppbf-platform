# Research corpus repairs: the pinned plan for production

Two logs of what was changed in this package's seed CSVs after it was imported
and approved in production (organization `__platform__`, 2026-08-13). They are
the plan the owner-gated production repair tool applies, in this order:

1. `2026-09-28_repair_log.csv` (#1008)
2. `2026-09-29_followup_log.csv` (this follow-up)

**The seed CSVs in this directory hold the target values.** The logs say what
happens to which rows; the value a row ends at (a source's `authority_tier`, a
chunk's `metadata.authority_tier` and `metadata.evidence_tier`, a source's
`metadata`) is the one in `seed_shadow_library_sources.csv` /
`seed_shadow_library_chunks.csv`.

**Production is repaired only by the owner-gated tool, never by re-running the
importer.** `import-shadow-research.mjs` upserts `approval_state`, so a re-import
would reset every approved row to `pending_review` and switch SHADOW's evidence
off. Owner rulings 2026-09-29: retire with `status = 'archived'` and leave
`approval_state` untouched (Q2); set tiers by EVIDENCE_TIER_SPEC.md section 3
(Q3). Chunks are repointed before their old source is retired.

## 2026-09-28_repair_log.csv

The algorithm lane's `research_batch_repair_log.csv` exactly as validated,
without its line 245 (the `MERGE_DUPLICATE` of `src_6dd70cf8a54ca4c8` into
`src_65e2511c755a594e`, which was wrong and was reverted in #1008). Every other
byte is the handoff's, CRLF line endings included; only a trailing `chunk_id`
column is added.

- handoff file: 244 rows, sha256 `d1d6c887d1cc65287bf41282a52496c1c3eca690cb9ad659ecbd372b631f0382`
- its first 244 lines (header + 243 rows): sha256 `6e3c3a5c963286173b10f2e3c127ce77cb6ae8349c05f81a1689edb95b765de7`
  -- this file with its last column removed is byte-identical to that.

`chunk_id` was added because the production update targets `chunk_id` (the
primary key); matching on `metadata->>'claim_id'` would assume production still
holds exactly one chunk per claim. Values: `REPOINT_MISRESOLVED` = the one chunk
carrying `claim_id`; `MERGE_DUPLICATE` = every chunk on `source_id` before
#1008, `|`-separated (empty when none); `DELETE_DEAD_BOGUS_SOURCE` = empty.
Checked: those 213 (chunk, source) pairs are exactly the precondition list in
the lane's `PRODUCTION_REPAIR_research_baseline_2026-09-28.sql`, and applying
this log to the pre-#1008 seed reproduces #1008's chunk placement exactly.

This log changes no tier. The lane SQL's step that lowered 8 merged rows to the
weaker tier is superseded by the follow-up's `SET_TIER_BY_SPEC` rows.

## 2026-09-29_followup_log.csv

| action | rows | what |
|---|---|---|
| `SET_TIER_BY_SPEC` | 29 | the 25 tier-conflict groups #1008 recorded and the 4 merge targets below: the source row and every listed chunk go to `tier_to` |
| `MERGE_DUPLICATE` | 4 | a PMID row whose own PubMed record carries the DOI of `target_source_id`: move the listed chunks, then retire `source_id` |
| `DELETE_DEAD_BOGUS_SOURCE` | 37 | a wrong-paper row from a DOI fragment read as a PMID, referenced by nothing: retire |
| `CLEAR_MISRESOLVED_VERIFIED_TITLE` | 149 | `metadata.verified_title` is provably another paper's title: move it to `misresolved_verified_title`, set `verification_status` to `MISRESOLVED` |

Columns: `chunk_id` / `claim_id` are `|`-separated lists; `tier_from` is the
seed value this follow-up replaced; `tier_before_1008` is the value in the seed
production was imported from; `verified_title_from` is the exact value being
cleared (the precondition). `evidence` states the proof for each row.

Production still holds the pre-#1008 tiers, so the tool applies all 29
`SET_TIER_BY_SPEC` rows with `tier_before_1008` as the precondition, not
`tier_from`. 11 of them change production's value (`tier_before_1008` differs
from `tier_to`), including `src_9fe2690355aaa819` (2 -> 4) and
`src_eacdd76be260882e` (3 -> 4), which #1008 lowered; the other 18 already hold
`tier_to` in production.

`src_00c5cf14f2692175`, `src_9b44730ebb92f513` and `src_b6292c09e6883927` carry
`provisional: true` in `metadata.tier_conflict`: set by the spec, owner may
override.

Not changed, because not provable from PubMed (only PubMed was consulted): the
`verified_title` of `src_c9a9a3616bd67d7b`, `src_d0cb241ea3b8da99`,
`src_920662617554b807`, `src_2172bfa496248f59`, `src_15be4a7b82a44e78`,
`src_7897d71c0b325fec`, `src_71efc90a9c8269e4`, `src_4e7b16e450d24c9c` and
`src_617353438eedc2ad` (each is the title of another corpus DOI row that PubMed
does not index).

Not changed, because the title is the same work published elsewhere:
`src_55c7d2ce4895507d` (the MMWR title of the CDC report this JAMA reprint
carries) and `src_ad951938a95719ec` (the Med Sci Sports Exerc title, PubMed
26891166, of the joint Academy of Nutrition and Dietetics / Dietitians of Canada
/ ACSM position statement this J Acad Nutr Diet row, PubMed 26920240, carries:
same first author, same date, same opening sentence of the abstract).

## pre_repair_values.csv

The value every field the repair changes held in the seed production imported
(commit `95f3c79e`, the last seed before #1008; `a6378b52` parses to the same
values): one row per `(table, row_id, field)`, `before_json` the value as JSON,
empty when the metadata key was absent. It is the "before" half of the tool's
state check -- the lane SQL's preconditions, made exact for every field -- so a
production dry run can say PRE_REPAIR, PARTIAL, REPAIRED or DRIFTED rather than
guess. It holds only fields that change (1,205 rows: 221 chunk `source_id`, 213
source `status`, 11 source `authority_tier`, and the managed metadata keys);
every other managed field of a listed row is expected to already hold the seed
value. `researchRepairPlan.test.ts` re-derives it from `95f3c79e` on every CI run
and fails if any difference between that seed and today's is not in the plan
(the two chunk sentences #1003 corrected are the only exception: text, not
citation or tier data, and not written by the tool).

The tool is `apps/web/scripts/pilot-repair-research-baseline.mjs`, dispatched by
the `repair-research-baseline` workflow; the order of runs is in
`docs/SHADOW_RESEARCH_IMPORT_RUNBOOK.md`.
