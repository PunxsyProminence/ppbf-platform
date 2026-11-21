STATUS: WAITING-FOR-OVERWATCH

```text
SESSION: TEACH-T (SHADOW build S1.5, Teach Shadow block T; cloud builder; branch claude/awesome-mayer-25fggr)
MIGRATIONS: NONE
STACKED ON: NONE (cites OD-2026-11-21-004/-005, which are in draft #2078, not yet on main)
CONTESTED: none in this PR (one new plan file). Planned build PRs: no open PR touches their files (checked below)
SCOPE: OW28-02 "A: Hard floor first, learning tracks beside (Recommended)" (OD-2026-11-21-005): Teach block T runs beside S1. Step 1 is a plan only; no app code until "OVERWATCH: GO".
```

# TEACH-T plan: block T of Teach Shadow

Three jobs: (a) open body-point marking, (b) fix HF6 in Label Agreement, (c) two-person capture (open mitts and sparring). All findings below were read on `main` at `c73f3d92d8d722dbff1d08ce65c6402ef4614b0f` (2026-11-21). They come from reading the code (CODE_READ). Nothing was run. No app code is in this PR.

## 1. Rulings (quoted)

| Ruling | Words | What it means for block T |
|---|---|---|
| OD-2026-11-20-002 SH-04 | "B: Start now, alongside patterns" | The recognizer work (block T, then gates 1-5) starts beside pattern learning |
| OD-2026-11-20-002 MSG-1 | "we can start it today once we dooble check and validate that this is the best build for shadow" | Start today, once validated |
| OD-2026-11-20-002 SH-07 | "C: Keep from nothing" | "OD-2026-10-02-011 section 2 stands unchanged; no outside model at any step, not even as a yardstick." Block T adds no model, pose tool or pre-fill |
| OD-2026-10-02-011 s2 | "D" ... "The coach's are the one helping build the tool they won't use anything until we develop  it" | Coaches hand-mark every point; no borrowed pose tool, not even as a temporary helper |
| OD-2026-10-02-011 s3a | "C" (all 24) ... "B yes" | All points at three moments (start, contact, end) on every punch and every defence; full extension when a punch has no contact |
| OD-2026-10-02-008 s2 | "Yes" | The 24-point list; it can grow only as a new ontology version |
| OD-2026-10-02-006 s1 | "to in clude but not limited to ellbow shoulder hips knees toes heel, basicallly all the parts of the biomechanicsl of the movements in boxing" | Body points are part of punch-recognition labelling |
| OD-2026-10-03-006 s1 | "It should be on the individuals action" ... "1 and 3" | Body points belong to the person doing that event. The other boxer is marked on their own defence event (the "received punch" class is a separate build row, not in T) |
| OD-2026-10-03-019 | "can we train it on adults only ... add the kids later if we dont think the end product can do it on kids" | Training uses adults only for now |
| OD-2026-11-20-002 SH-05 (record note, not a ruling: "No option picked; no ruling") | "body points on every punch and defence, each person on their own event, adults first" | Block T's target, from the rulings above |
| OD-2026-11-21-004 TS-Q1 (draft #2078) | "A: Open mitts and sparring capture now (Recommended)" | The lane's note in the same row: "Capture gains mitts and sparring, Fighter 1 / Fighter 2 on their own events; adults-only training still applies; the split rule for two-person takes is the architect's" |
| OD-2026-10-08-005 A-Q10a | "Fighter 1 / Fighter 2 (Recommended)" | Ruling 1: "Teach labels the two fighters "Fighter 1" and "Fighter 2"" |
| OD-2026-10-08-005 A-Q10c (the HF6 fix) | "Allow a small window (Recommended)" | Ruling 3: "two coaches' marks within a small window count as the same punch; the lane tunes the number (asked as about 100 ms) and shows it on screen" |
| OD-2026-10-04-024 Q1 | "1A" | "0.4 is not annotatable yet; ANNOTATABLE_ONTOLOGY_VERSIONS and PROJECT_CREATION_ONTOLOGY_VERSION stay 0.1 until the body-point marking screen exists" |
| OD-2026-10-04-024 Q2 | "2A" | Marks made under older versions are kept exactly as made |
| OD-2026-10-02-008 4A | (in "Yes it does") | Old studies finish on old labels; never mixed |
| OD-2026-10-02-016 | "Go with recommendation" ... "stop you are drifting into safety and legal not function" | T4 A: the trained tool is kept behind sign-in. No new safety or legal questions are raised here |
| OD-2026-11-21-005 OW28-02 (draft #2078) | "A: Hard floor first, learning tracks beside (Recommended)" | Block T runs beside S1 (HF1, HF2, HF7) "where no lane owns their files" |

## 2. Findings on main (file:line)

### (a) Body-point marking is closed by two constants
- `apps/web/src/server/pilot/calibration/ontology.ts:95-97`: `ANNOTATABLE_ONTOLOGY_VERSIONS` is `[0.1]` only.
- `ontology.ts:113`: `PROJECT_CREATION_ONTOLOGY_VERSION` is 0.1.
- `ontology.test.ts:379-385` pins both ("until 0.2 can be labelled ...").
- OD-2026-10-04-024 sets the condition for opening: "until the body-point marking screen exists". By code reading, that screen and its backing exist on main:
  - The labelling page marks body points on a set whose version holds them (`app/teach-shadow/annotation/page.tsx:413-416`, `isBodyPointSet`; skeleton for 0.4 at `:423`; body-point reads and writes at `:552-557`, `:925`).
  - It hides the 0.1-only stance and peak fields on those sets (`:2015-2020`).
  - The server enforces the 0.2+ event rules (`src/server/pilot/calibration/annotations.ts:673-687`, `assertVersionEventRules`) and the body-point rules (`bodyPoints.ts:198-214`, `:595-601`, `resolveMomentTiming` at `:282`). Six `.pg.test.ts` suites cover them.
  - Not verified: whether a coach can walk the 0.4 flow end to end on a real screen. That is UNVERIFIED and is Jason's signed-in staging check (see T-1).
- The version to open is 0.4 (23 points, ankles dropped: OD-2026-10-04-021, -024). 0.2 and 0.3 stay closed; their marks stay as made (-024 Q2).
- Opening 0.4 changes what six pg suites create. Each one builds its project with `ontology.PROJECT_CREATION_ONTOLOGY_VERSION` (`calibrationRemarkPass.pg.test.ts:222`, `calibrationEventsFreezeOldParent.pg.test.ts:146`, `calibrationBodyPointRules.pg.test.ts:159`, `calibrationEventInPlaceEdit.pg.test.ts:158`, `calibrationBodyPoints.pg.test.ts:380`, `:1269`, `calibrationBodyPointsModule.pg.test.ts:150`). Each must be pinned to the version it means.

### (b) HF6: Label Agreement reports disagreements that are only spelling or a few ms
- **A few ms, at the edges of an action.** `comparison.ts:353`: any start, end, contact or peak that differs by even 1 ms is pushed as a `BOUNDARY` disagreement.
- **A few ms between actions.** `comparison.ts:107-113`: the pilot policy matches events with `overlapToleranceMs: 0`. Marks of one punch at [1000,1400] and [1420,1800] do not overlap, so they report as two `EVENT_MISSED`, not one punch. The file's own comment (`:96-99`) gives that example. `widenedOverlaps` (`:267-276`) already supports a tolerance.
- **Spelling.**
  - `actor_track` and `opponent_track` are typed as free text on the labelling page (`app/teach-shadow/annotation/page.tsx:1791-1797`, `:1799-1805`). The server checks only that `actor_track` is not empty (`annotations.ts:609`). It stores `opponent_track` with no check at all (`:610`).
  - Matching requires the same actor exactly (`comparison.ts:111`, `:284`). So "Fighter 1" against "fighter 1" makes the event pair fail and reports two `EVENT_MISSED`.
  - `opponent_track` and `combination_group` are compared as raw strings (`comparison.ts:309`, `:311`, `:314-317`), so a case or space difference is reported too.
- **The screen does not show any window.** The QA read model and the report route carry no matching policy (`qaReadModel.ts`, `qaReportLoader.ts`, `qa-report/route.ts`: no "policy"), so `/teach-shadow/agreement` cannot show it. A-Q10c requires that it be shown. Only the admin review page shows the tolerance (`app/admin/calibration/review/page.tsx:319`).
- **The timing figures.** `qaReadModel.ts:394-397` builds the timing medians only from `BOUNDARY` disagreements. Hiding differences inside the window would therefore bias the medians unless the deltas are carried another way.
- Tests that pin the zero window or v0's name: `comparison.test.ts:384-385`, `:390`, `app/api/pilot/calibration/comparison/route.test.ts:496`, `app/admin/calibration/review/page.test.tsx:72`, `:74`, `:189`.
- **Source of HF6's wording.** A search of `main` and #2078 finds "HF6" nowhere; the wording comes from this lane's brief. A-Q10c rules the window. A-Q10a's fixed labels (T-4) stop spelling differences in new labels. Folding spelling in labels already stored is not ruled anywhere, so it is Q5.
- **Finding (not spelling, not fixed here).** `combination_group` is a name each coach makes up for their own combination ("exchange-2", `comparison.test.ts:211`). Like event ids, two coaches' names cannot be expected to match, so any naming difference reads as `COMBINATION`. Fixing it means comparing membership through matched pairs, the way `relationshipAgrees` (`comparison.ts:333-341`) does. That is outside HF6's words. See question Q3.

### (c) Two-person capture is refused in three places
- `src/server/pilot/captureSessions.ts:70`: `SINGLE_SUBJECT_TRAINING_CONTEXTS = ['shadowboxing', 'heavy_bag']`.
- `app/api/pilot/video/capture-session/route.ts:80-98` refuses any other context on the server. Its comment gives the reason that is left: "a take is the unit that groups angles of ONE attempt", and two people in one take would be "two subjects' movement labelled as one".
- `app/teach-shadow/capture/page.tsx:50-51` offers only Shadowboxing and Heavy bag.
- `route.test.ts:332` (`test.each(['sparring','mitts','other'])`) and `:395` pin the refusal.
- The Teach Shadow hub page says so too: `app/teach-shadow/page.tsx:506`, "Shadowboxing and heavy bag only, until a take can name everyone who appears in it."
- One more thing T-1 must fix: the cut page locks a study whose version is not `supported_ontology_version` (`app/teach-shadow/cut/page.tsx:321-325`). Once creation moves to 0.4, that would lock out every running 0.1 study, which breaks 4A.
- The database already accepts all five contexts (`infra/azure/pilot_slice_postgres_capture_sessions_migration.sql:41`), so no migration is needed. The code comment says the same: "lifting it ... is deleting an entry here, not a migration" (`captureSessions.ts:64-68`).
- Teach Shadow footage names nobody. TS-ANON-01: the route refuses an `athlete_id` (`capture-session/route.ts:101-117`), and the upload route refuses one on a take (`upload/route.ts:198-202`). So the older consent reason in the comments at `captureSessions.ts:46-60` and `capture/page.tsx:36-48` is out of date. The route's own comment at `:82-85` says so.
- How "each person on their own event" works: each event row already has one actor (`actor_track`). The OD-2026-10-03-006 rule (no opponent body points inside the puncher's event) is already enforced: #1150 dropped the `subject` column. What is missing is A-Q10a's fixed "Fighter 1 / Fighter 2" labels in place of free text.

## 3. Plan: four build PRs, each about 300 changed lines or fewer outside tests

No migration in any of them. No new role, gate, warning or permission. No model, training, export, spend, footage or member data. Every one waits for `OVERWATCH: GO` on this PR, then for Overwatch's go on that PR. They have no order between them except where stated.

### T-1: open body-point marking (0.4)
- **Change.**
  - `ANNOTATABLE_ONTOLOGY_VERSIONS` becomes `[0.1, 0.4]`, so 0.1 studies still open and finish on 0.1 labels (4A).
  - `PROJECT_CREATION_ONTOLOGY_VERSION` becomes 0.4.
  - The doc comments are updated.
  - The six pg suites are pinned to the version each one tests: 0.1 where it tests 0.1 behaviour, 0.4 where it tests body points.
  - `ontology.test.ts` replaces the "until 0.2" test with: 0.4 is labellable and created; 0.2 and 0.3 are not; 0.1 is still labellable.
  - The cut page checks against `annotatable_ontology_versions`, not `supported_ontology_version` (`cut/page.tsx:321-325`), so running 0.1 studies stay selectable (4A).
  - The agreement page keeps its "body points not included" line (OD-2026-10-02-008 5B). Body-point agreement is not in T.
- **Allowlist.**
  - `apps/web/src/server/pilot/calibration/ontology.ts`
  - `apps/web/src/server/pilot/calibration/ontology.test.ts`
  - `apps/web/src/server/pilot/calibrationRemarkPass.pg.test.ts`
  - `apps/web/src/server/pilot/calibrationEventsFreezeOldParent.pg.test.ts`
  - `apps/web/src/server/pilot/calibrationBodyPointRules.pg.test.ts`
  - `apps/web/src/server/pilot/calibrationEventInPlaceEdit.pg.test.ts`
  - `apps/web/src/server/pilot/calibrationBodyPoints.pg.test.ts`
  - `apps/web/src/server/pilot/calibrationBodyPointsModule.pg.test.ts`
  - `apps/web/src/server/pilot/calibrationBootstrap.pg.test.ts` (`:405` expects 0.1)
  - `apps/web/src/server/pilot/calibration/bootstrap.ts` (comment only, if needed)
  - `apps/web/app/api/pilot/calibration/projects/route.test.ts` (`:83-84`) and `apps/web/app/api/pilot/calibration/annotation-set/route.test.ts` (`:153-154`), which pin 0.1
  - `apps/web/app/teach-shadow/cut/page.tsx` and `page.test.tsx` (`:91`)
- **Size.** About 30-40 lines outside tests.
- **Proof.**
  - Unit: `ontology.test.ts`, the projects and annotation-set route tests, `app/teach-shadow/annotation/page.test.tsx`.
  - pg suites: in CI only (this container has no Postgres).
  - A mutant that puts 0.1 back as the creation version must turn `ontology.test.ts` red.
  - Jason's signed-in staging check: create a study, label one punch with 23 points at three moments, submit. This check is what shows the screen works. CODE_READ does not.

### T-2: HF6, a small window and spelling-proof matching (A-Q10c)
- **Change.**
  - A new policy `pilot-temporal-overlap-v1`, with `overlapToleranceMs: 100` (A-Q10c asked "about 100 ms"; the lane tunes it and shows it on screen). It still says `calibrationState: 'UNCALIBRATED'`, because the number is not measured. v0 stays exported and unchanged, so stored and pasted results still name their rule.
  - `compareAnnotationSets` uses v1 by default.
  - Matching: events whose spans come within the window are candidates, so one punch is no longer two `EVENT_MISSED`. A-Q10c: "within a small window count as the same punch".
  - Edges: a `BOUNDARY` disagreement is reported only when |A - B| is larger than the window. Every two-sided delta is still carried on the pairing as `boundaryDeltas` (not a disagreement), and `qaReadModel.ts:394-397` reads that, so the timing medians keep every observation.
  - Spelling (only if Q5 says yes; built as its own commit so it can be dropped): `actor_track`, `opponent_track` and `combination_group` are compared after folding case and spaces, underscores and hyphens. This is done in comparison only; stored rows are frozen and untouched. If Q5 says no, new labels still stop differing in spelling through T-4.
  - The QA report carries `matchingPolicy`. `/teach-shadow/agreement` shows one plain line, for example "Marks within 100 ms of each other count as the same punch." The exact words are the lane's, and Overwatch reviews them.
  - Comment updated at `comparison.ts:88-100`: the "not to invent a ... rule" line is replaced by A-Q10c.
- **Allowlist.**
  - `apps/web/src/server/pilot/calibration/comparison.ts` and `comparison.test.ts`
  - `apps/web/src/server/pilot/calibration/qaReadModel.ts` and `qaReadModel.test.ts`
  - `apps/web/src/server/pilot/calibration/qaReportLoader.ts` and `qaReportLoader.test.ts`
  - `apps/web/app/api/pilot/calibration/qa-report/route.ts` and `route.test.ts`
  - `apps/web/app/api/pilot/calibration/comparison/route.test.ts`
  - `apps/web/app/teach-shadow/agreement/page.tsx` and `page.test.tsx`
  - `apps/web/app/admin/calibration/review/page.test.tsx`
- **Size.** About 150-220 lines outside tests.
- **Proof.**
  - Tests: [1000,1400] and [1420,1800] match. A 60 ms start difference is not a `BOUNDARY` but its delta is still in the medians. A 150 ms difference is a `BOUNDARY`. With the fold: "Fighter 1" and "fighter_1" match.
  - Mutants: window set to 0, fold removed, threshold `>=` changed to `>`. Each must go red under `npm run mutation:prove`.
  - Known risk, stated once: two same-actor punches less than 100 ms apart now become `MATCH_AMBIGUOUS`, not matched. A test pins this, so it stays visible.

### T-3: open mitts and sparring capture (TS-Q1 A)
- **Change.**
  - `captureSessions.ts`: the capture list becomes shadowboxing, heavy_bag, mitts and sparring. `other` stays withheld, because it promises no subject count. The out-of-date consent comment is corrected to TS-ANON-01.
  - Route: the refusal message and comment are updated; `other` is still refused.
  - Capture page: adds Mitts and Sparring.
  - Tests: `route.test.ts:332` and `:399` now expect mitts and sparring to be accepted and `other` refused.
  - A take stays one take. How two-person takes are split is Q2, and nothing here depends on the answer.
- **Allowlist.**
  - `apps/web/src/server/pilot/captureSessions.ts` (and its test, if one exists)
  - `apps/web/app/api/pilot/video/capture-session/route.ts` and `route.test.ts`
  - `apps/web/app/teach-shadow/capture/page.tsx` and `page.test.tsx`
  - `apps/web/app/teach-shadow/page.tsx` (`:506`) and `page.test.tsx`
- **Size.** About 40-60 lines outside tests.

### T-4: Fighter 1 / Fighter 2 on their own events (A-Q10a, TS-Q1)
- **Change.**
  - `ontology.ts` gains `FIGHTER_TRACKS = ['fighter_1', 'fighter_2']`.
  - `recordAnnotationEvent` and `updateAnnotationEvent` refuse an `actor_track` that is not one of these, and an `opponent_track` that is given but is not one of these, **on a body-point-version set only**. An empty opponent is still allowed: whether to refuse one is not ruled, so this plan adds no such refusal. 0.1 sets keep their free text until they finish (4A). This is a vocabulary rule from A-Q10a, not a new gate.
  - The labelling page's two text inputs become a "Fighter 1 / Fighter 2" choice on those sets. A solo take uses Fighter 1.
  - Each person's punches, defences and body points go on that person's own events (OD-2026-10-03-006). No opponent marking is added.
- **Allowlist.**
  - `apps/web/src/server/pilot/calibration/ontology.ts` and `ontology.test.ts`
  - `apps/web/src/server/pilot/calibration/annotations.ts`
  - `apps/web/src/server/pilot/calibrationAnnotations.pg.test.ts`
  - `apps/web/src/server/pilot/calibrationBodyPoints.pg.test.ts`, `calibrationBodyPointsModule.pg.test.ts` and `calibrationEventInPlaceEdit.pg.test.ts` (they use `'red'`/`'blue'` on body-point sets)
  - `apps/web/app/teach-shadow/annotation/page.tsx` and `page.test.tsx`
  - `apps/web/app/api/pilot/calibration/events/route.test.ts`
- **Order.** Stacked after T-1, because both edit `ontology.ts` and `ontology.test.ts`, and T-4's rule bites only once 0.4 sets exist.
- **Size.** About 80-120 lines outside tests.

**Not in T:** the "received punch" event class (its own build row, `ACTIVE_WORK.md:163`; needs a new ontology version); body-point agreement on the Label Agreement screen; label export; any training, gate 3, model, or spend.

## 4. Open PRs checked against the allowlists

Read 2026-11-21 against `c73f3d92`, from git diffs of each head against `origin/main`. For #2017-#2020, whose branches share no merge base with `main` here, the GitHub file list was used instead.

| PR | Files it touches that matter here | Overlap with T-1..T-4 |
|---|---|---|
| #2078 (Overwatch records) | `docs/current/OWNER_DECISIONS.md` | none (no build PR edits it) |
| #2077, #2076, #2075, #2069, #2062 (HF7), #2060, #2042, #2041 | app files outside calibration, capture and teach-shadow | none |
| #2021, #2020, #2018, #2017 | `docs/current/ACTIVE_WORK.md` | none (T writes no ACTIVE_WORK row; Overwatch does at merge) |
| #2019 | `app/coach/drills/page.test.tsx`, `design-system/current/ppbf-golden-era.css` | none |
| #2046, #2043, #2039, #2037 | empty diff against main | none |

Lane PATTERN-1 (`patterns/`, `learningPolicyApprovedV1.ts`, the learning-policies route) has no open PR in this list. No T allowlist names any of its files. `comparison.ts` keeps a naming guard that it shares in kind with `patterns/policy.test.ts` (`comparison.ts:77-81`). T-2 follows that guard and does not edit `patterns/`.

## 5. QUESTIONS FOR OVERWATCH

- **Q1: how adults-only is enforced at export** (the architect's call, OD-2026-10-02-016). Teach footage names nobody (TS-ANON-01), so no row holds an age to filter on. Block T builds no export. T-3 opens capture without an age step, and no ruling names one (a warning or step there would be a new gate). Nothing in T-1..T-4 depends on the answer.
- **Q2: how a two-person take is split** (one take with both fighters' events, as T-3/T-4 leave it, or split per fighter at cut or export, which also decides which side of a train/test split each lands on). T keeps the take whole and labels each person on their own events, so either answer can be applied later at cut or export.
- **Q3: `combination_group` naming** (finding 2b). Is comparing combination membership through matched pairs inside HF6, or a separate item? T-2 folds case and spaces only.
- **Q5: the spelling fold for labels already stored** (finding 2b). HF6's wording comes from this brief. A-Q10c rules only the window, and A-Q10a's fixed labels cover new labels. Should T-2 also fold case and spaces when comparing labels that are already stored as free text? Yes keeps the fold commit; no drops it.
- **Q4: the window number.** 100 ms is what A-Q10c "asked as". Should it be confirmed on screen at 100, or tuned first on pilot pairs (none submitted under 0.4 yet)?

## 6. Review

One fresh-context adversarial reviewer (no shared context; told "Do not reverse a ruling. If you believe a ruling is wrong or blocks the task, return CONFLICT and stop that part.") re-checked every file:line, quote and claim against `c73f3d92` and draft #2078. It returned no CONFLICT. It found the quotes word-for-word and the code citations correct, and raised 10 items. All 10 are applied:
- allowlist gaps: the cut page locking out 0.1 studies (T-1), the bootstrap pg pin (T-1), the red/blue fighter names in three pg suites (T-4), the hub page text (T-3);
- unruled changes moved: the opponent refusal is dropped (T-4); the spelling fold is now Q5;
- wording fixed: Jason's own words quoted for OD-2026-10-02-006; SH-05 labelled a record note; the `opponent_track` check reworded; corrected pin lines (`:395`, `:72`, `:189`, `:390`).

Its verdict before the fixes: "sound on its facts but not ready for GO".
