# Readiness sweep: every committed workout template against the issue plan

Lane RS, pilot dry-run blocker B3. Sections 1 to 5 are the step 1 report,
measured on `main` at `0752bb485908d259880925521f1a8672a75abe4f` (2026-11-20),
before any data change. Section 6 records step 2, applied in the same PR
(#2008) after Overwatch's GO on the PR (Q1 A: tiers A and B; Q2 A: keep the
draft marker; Q3 A: the 11 mixed templates stay allowlisted as an owner
decision).

Labels: OBSERVED (read in code or data, with file:line), INFERRED (reasoning
past what was read), UNVERIFIED (not checked).

## 1. What the seed loads (OBSERVED)

- Workflow `.github/workflows/seed-reference-data.yml`: datasets `drill-library`
  and `workout-templates` are choices (:101-102). The validate job runs
  `npm run --silent content:validate -- --dataset "$DATASET"` (:205); the load
  goes through the content-import core (`apps/web/scripts/pilot-content-import.ts`).
- Committed files, from the dataset specs (`committedPath`,
  `apps/web/src/server/pilot/contentImport/specs/index.ts`; folders at
  `specs/drills.ts:29` and `specs/templates.ts:30`), under `apps/web/seed-data/`:
  - `drill-library/seed_drill_library.csv` (512 drills),
    `seed_drill_scale_levels.csv`, `seed_drill_stop_rules.csv`,
    `seed_drill_cues.csv` (682 cues), `seed_drill_secondary_skills.csv`
  - `workout-templates/seed_workout_templates.csv` (144 templates),
    `seed_workout_template_items.csv` (665 items, 356 of them typed text)
- Counts are rows as `parseFile` (`contentImport/validate.ts:116`) reads them at
  the SHA above. Every committed drill and template is version 1 of its own
  lineage (drill_id = lineage_id, superseded_at blank), so each step names its
  lineage head; the sweep test asserts this.

## 2. How the check was run (OBSERVED)

`apps/web/src/server/pilot/committedTemplateIssueSweep.test.ts` runs the
server's own `planTemplateIssue` (`apps/web/src/server/pilot/workoutTemplates.ts:594-770`),
the same plan the issue writer (`:866-904`) and the pre-issue list
(`app/api/pilot/workout-templates/route.ts:33-39`, U1-ISSUE #1987) use. No
refusal rule is restated. Only its database reads are answered, from the
committed CSVs, as a load into an EMPTY gym would leave them: every library
drill active, current and not adopted (`available`); no other version adopted;
no gym drill holding a name. The same faking pattern as
`workoutTemplateIssue.test.ts`.

What this does NOT establish: the state of staging or production. A gym that
adopted, retired or edited drills can be refused for reasons an empty gym cannot
show. One known case: OD-2026-10-11-006 records "Technique Hold Under Volume"
as adopted and then left retired in the gym (`docs/current/OWNER_DECISIONS.md:6353`),
which refuses with the retired-adoption reason there, not the cue reason.
A drill whose current version holds a coach's in-app edit is held by a load
(`contentImport/inAppEdits.ts`). Overwatch's dry run sees both; this sweep does not.

Cross-check (INFERRED from the brief's quote): staging said "It has no coaching
cue. A technique drill needs at least one" for "Wrap Under Supervision". That
is the readiness line `NO_CUE_READINESS_MESSAGE` (`apps/web/src/lib/drillCueRule.ts:34`),
the not-adopted path, which is what this sweep models.

## 3. Result (OBSERVED, sweep at the SHA above)

| | Templates |
|---|---|
| Checked | 144 |
| Issue without refusal | 46 |
| Refused | 98 |
| of which: every step typed text (coach-run, OD-2026-11-15-001) | 82 |
| of which: typed steps beside drills (refused for the typed steps only) | 11 |
| of which: a library drill refuses (no typed steps) | 5 |

The cue rule applied is OD-2026-10-06-026 ruling 2 ("technique drills need at
least one coaching cue ... conditioning drills do not"). OD-2026-10-27-001
ruling 1 replaced that entry's ruling 1 (chokes), not ruling 2
(rulings at `OWNER_DECISIONS.md:7322-7323`, status line `:7327`), and OD-2026-11-19-005 keeps "the cue rule
(OD-2026-10-06-026)" (`OWNER_DECISIONS.md:1170`). The code applies it at
`apps/web/src/lib/drillAdoptionReadiness.ts:110`.

### 3a. Drill refusals: 4 drills, 5 templates (every one: no coaching cue)

| Template (step) | Drill | Reason |
|---|---|---|
| Intro to Boxing — Session 1 `wtp_216dfa4227233d` (6) | Wrap Under Supervision `drl_39ed71de8c14cd` | no coaching cue |
| Conditioned Sparring Session `wtp_1123d6411a2e60` (2) | Wrap Under Supervision `drl_39ed71de8c14cd` | no coaching cue |
| Adaptive Session — Seated Base `wtp_f4f4d54c39a219` (5) | Seated Combination Work `drl_af8541eacc70e5` | no coaching cue |
| Non-Contact Fitness Boxing `wtp_cfb86f25abfa16` (3) | Technique-Only Fitness Session `drl_146f4afdc88839` | no coaching cue |
| Intermediate Combinations — Random Practice `wtp_e3c1f50475379b` (6) | Technique Hold Under Volume `drl_b755caac79e37e` | no coaching cue |

Each drill's only missing item is the cue (the refusal reason is exactly
`NO_CUE_READINESS_MESSAGE`; the test pins that).

### 3b. Typed steps beside drills: 11 templates

The typed steps refuse the whole issue (TYPED_STEP_REASON,
`workoutTemplates.ts:422-423, 609-618`). OD-2026-11-15-001's reach: "A template
mixing typed steps with drills is not covered and still reads 'Not ready'"
(`OWNER_DECISIONS.md:2725`). Some typed lines are typed on purpose: Backbone
D-OQ44 makes DOC-151's warm-up, applied-rounds, conditioning and character lines
"verbatim free-text items of the phase template" (`docs/backbone/DECISION_REGISTER.json:1464`).
No cue or drill text fixes these. Template ids and typed steps are in the
test's `TYPED_IN_MIXED` list.

### 3c. Every step typed: 82 templates

Refused at the issue endpoint for every step; Class plans reads them "Coach-run
day: nothing to issue" (OD-2026-11-15-001). No action. Listed in the test's
`COACH_RUN`.

## 4. Fix per refusing drill (proposed in step 1; applied in step 2)

A fix is a new committed cue row for the drill (`seed_drill_cues.csv`; key
drill_id + cue_text, `specs/drills.ts:160-175`) plus a `cues` label on the
drill's root row, the shape lane HW used for `drl_e7587c167c1ebd` (#1980). At
load the drill library engine makes that a NEW drill version and keeps v1
(`contentImport/datasets/drills.ts:19-50`), which is OD-2026-11-15-011 ruling 3
("fixed by a new drill version ... not edited in place"). No coaching text is
written by this lane: every proposed cue is words that already stand in a
committed file. Choosing those words as the cue is INFERRED.

Searches behind "no other source": `git log -S <drill_id> --all -- '*cue*'`
(no cue row for any of the four, in full history); `git grep` for each id and
name on `main`; the grounding claims recorded on each drill, read in
`apps/web/seed-data/research-evidence/2026-08-07/evidence_registry_boxing_learning.csv`
(none carries cue words). The OneDrive Backbone and `C:\Dev` were not
searchable from this container (UNVERIFIED there).

| Drill | Proposed cue_text | Source (file:line) | Source tier |
|---|---|---|---|
| Wrap Under Supervision `drl_39ed71de8c14cd` | `Protect the metacarpals, support the wrist, cushion the knuckles.` (one sentence, verbatim) | The Long Road LR-169 "4.3 Hands and wrists", row "Learn to wrap properly", stored verbatim on track `trk_9529aeb3af7743` "Injury Risk Management and Medical Care" (`apps/web/seed-data/training-tracks/seed_training_tracks.csv:30`, `details`), and in the same record's `drill_refs` as the coach note on the link to this drill. Jason linked that row to this drill: D-OQ111 "the four pairs are the same drill (... 169-01 = drl_39ed71de8c14cd 'Wrap Under Supervision')" (`docs/backbone/DECISION_REGISTER.json:3458`) | A: a committed source document tied to this drill by an owner ruling |
| Seated Combination Work `drl_af8541eacc70e5` | `Seat down` | The drill's own committed corrections: `Coach places a hand on the shoulder or calls "seat down" to cue immediate re-seating.` (`apps/web/seed-data/drill-library/seed_drill_library.csv:1284`) | B: the drill's own text, a verbatim coach call it names as a cue |
| Technique-Only Fitness Session `drl_146f4afdc88839` | `Hands` | The drill's own committed corrections: `Call "hands" the moment the guard drops, wait for it to reset before restarting the drill.` (`apps/web/seed-data/drill-library/seed_drill_library.csv:1339`) | B: the drill's own text, a verbatim coach call |
| Technique Hold Under Volume `drl_b755caac79e37e` | **needs coach text** | None found. Its corrections quote fault names ("hands down," "chin up", `seed_drill_library.csv:789`); used as cues they would tell the athlete to do the fault. OD-2026-10-11-009 item 3 ("3 B") covers this drill: "Overwatch drafts the cues for a coach to approve; they are not put in the app" (`OWNER_DECISIONS.md:6304`); that draft is `C:\Dev\DRAFT-CUES-SIX-DRILLS-2026-10-12.md`, outside the repo | — |

Notes on the three proposals:

- Tier B words come from a field that is itself a draft: all four drills carry
  `field_provenance` "LITERATURE-GROUNDED DRAFT ... REQUIRES FLOOR VALIDATION",
  and the corrections lines cited carry no claim citation. Capitalising the
  first letter is the only change to the source words.
- Tier A: D-OQ111 records the Long Road line as "a coach note on the link, no
  new drill". Using one of its sentences as the drill's cue moves Long Road text
  into the drill. INFERRED as consistent with the Backbone source order ("the
  Long Road fills gaps": OD-2026-10-27-001, `OWNER_DECISIONS.md:4269`, kept by its ruling 3 at `:4299`); Overwatch decides.
- Label on each drill's `field_labels` (mirrors #1980; as applied, each `basis` quotes its own source):
  `{"cues":{"basis":"<source> word for word; added so the drill meets the cue rule (OD-2026-10-06-026 ruling 2; OD-2026-11-15-011 ruling 3: a miss fixed by a new version)","draft":"AI selection, lane RS, 2026-11-20 (OD-2026-11-15-011)","sources":["<file:line>"],"status":"INFERRED"}}`.
  The `draft` marker makes the app show the cue as a draft for coach review.
- Minted ids (`MINT.cue`, `contentImport/ids.ts:166`): `cue_56bb3639abc991`,
  `cue_92e700e6afcebf`, `cue_4367231e5308f9` (in table order). `focus_type`
  `unspecified` (as #1980 wrote it), `cue_family` and `evidence_note` blank,
  `source_ref` the cited passage with "(AI selection, lane RS)".

## 5. Counts (step 1, before the fix)

| | |
|---|---|
| Templates checked | 144 |
| Templates refused | 98 (82 coach-run, 11 typed beside drills, 5 drill) |
| Drills involved | 4 (in 5 templates) |
| Drills fixable from repo sources | 3 (1 tier A, 2 tier B) -> 4 templates issuable on a fresh load |
| Drills needing coach text | 1 (Technique Hold Under Volume) -> 1 template |
| Templates refused for typed steps only | 93 (no drill text can fix them; 82 coach-run by ruling, 11 OWNER DECISION) |

## 6. Step 2, as applied in this PR

1. `apps/web/seed-data/drill-library/seed_drill_cues.csv`: +3 rows (above).
   `seed_drill_library.csv`: the `cues` label in `field_labels` on the same 3
   drill rows. A parse of the file before and after (512 drills, 682 -> 685
   cues) shows no other cell changed. At load the engine makes v2 of each of
   the 3 drills and keeps v1 (INFERRED from `contentImport/datasets/drills.ts:19-50`;
   proven against PostgreSQL by `contentImportDrills.pg.test.ts` "a revised
   drill becomes a new version", which runs in CI, not here).
2. The guard `apps/web/src/server/pilot/committedTemplateIssueSweep.test.ts`:
   `DRILL_REFUSALS` is down from 5 templates to 1 (Technique Hold Under Volume,
   needs coach text). On a fresh load, Intro to Boxing — Session 1,
   Conditioned Sparring Session, Adaptive Session — Seated Base and Non-Contact
   Fitness Boxing now issue: 50 of 144 templates, 94 refused.
3. Row-pinning tests: `scripts/backbone-export-ft1-track.test.ts` pins every
   pre-Backbone drill row to blank label cells, with one exception for lane
   HW's cue. The same exception now covers the three lane RS drills, by id and
   by the lane RS draft marker, and a new check fails if any other row carries
   that marker. The other exporter and drill-draft suites passed unchanged.
4. `npm run content:validate -- --dataset drill-library`: PASS, 0 blocking,
   64 warnings, the same count as on the base; no warning names the three
   drills. `--dataset all`: PASS, 0 blocking.
5. Not touched: any refusal rule, any template, any typed step, any load.

Staging (INFERRED from `workoutTemplates.ts:244-260, 298-346`, not run against a
database): v1 of each drill is already loaded there and not adopted (the
staging refusal was the readiness line), so a step naming v1 is judged as its
head v2, which carries the cue. Whether a coach's in-app edit holds any of the
three drills at load is UNKNOWN here; Overwatch's dry run shows it.

## 7. Allowlist and size

The allowlist lives in the test, in three groups, each with its reason:

| Group | Step 1 | Step 2 (this PR) |
|---|---|---|
| `COACH_RUN` (every step typed; OD-2026-11-15-001) | 82 templates | 82 |
| `TYPED_IN_MIXED` (typed steps beside drills; OWNER DECISION) | 11 templates | 11 |
| `DRILL_REFUSALS` (drills awaiting a cue) | 5 templates | 1 |

Each entry pins the template id and its exact refused steps or drill ids, so a
new typed step or a new drill refusal in an already-listed template also fails.
Step-2 diff: 3 added CSV lines, 3 changed CSV lines, the allowlist group in
the guard, the exception in the FT1 exporter test, this report and the
ACTIVE_WORK row.

## 8. Guard sensitivity (OBSERVED, local runs on this branch)

Step 1:

| Mutant | Result |
|---|---|
| Delete the 3 cue rows of `drl_b37c52526817b7` (used by issuable `wtp_98af8ee68020d0`) | "refuses exactly the allowlisted ..." failed |
| Add a cue row to `drl_af8541eacc70e5` (allowlist entry goes stale) | same test failed |
| `workoutTemplates.ts`: skip the readiness refusal (`if (false && !readiness.ready)`) | 2 tests failed |
| `workoutTemplates.ts`: skip the typed-step refusal | 3 tests failed |

Each mutant was reverted with `git checkout`; `git status` showed only the new
test afterwards. The suite also carries two in-test negative controls (a
technique drill stripped of cues, a step turned to typed text, both in a
template that issues today).

Step 2:

| Mutant | Result |
|---|---|
| Delete the new Wrap Under Supervision cue row (`cue_56bb3639abc991`) | "refuses exactly the allowlisted ..." failed |
| Give a fourth pre-Backbone drill (`drl_b755caac79e37e`) a cue-only label with the lane RS marker | the FT1 exporter test failed |

Each restored from a copy; `git diff --stat` matched before and after.
