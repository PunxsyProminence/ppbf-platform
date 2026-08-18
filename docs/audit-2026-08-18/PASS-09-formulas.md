# Pass 9 — Formulas & thresholds

Scope: `apps/web/src/server/pilot/formulas/*`, every hardcoded number that changes
what a child is told, shown, prescribed or flagged, and every screen that describes
one of those numbers to a person.

Pinned to `origin/main` at `04dd116b`, the same commit as the rest of this audit.
Read-only. Nothing in this pass changed a coefficient, a threshold, or any
application code.

---

## Method

1. **Registry first.** Every one of the 39 entries in
   `apps/web/src/server/pilot/formulas/registry.ts` was read, then its declared
   `implementation` string was grepped for real callers across the repository,
   excluding `*.test.ts`. "Caller" here means *a path a running request can take*,
   not *a symbol that is imported somewhere*.
2. **Reachability, not existence.** For each entry I traced outward to the API
   route, and from the route to a UI that calls it. A formula with an
   implementation, a route and no UI is recorded as reachable-by-API-only, which
   is a different fact from "live".
3. **Constants.** `grep -rnE "^(export )?const [A-Z][A-Z_0-9]+(: *number)? = -?[0-9]"`
   across `apps/web/src`, `apps/web/app`, `apps/web/components`, then every hit
   triaged for whether it decides something about a child. Bare numeric literals
   inside decision functions were then hunted separately, because the grep above
   cannot see them — that is how the pain-severity bands and the athlete-facing
   readiness bands were found.
4. **Provenance.** For each surviving constant: is there a comment, a doc, a
   migration header or a row in the platform's own evidence registry
   (`apps/web/seed-data/research-evidence/2026-08-07/evidence_registry_boxing_learning.csv`,
   1,193 claims) that states where the number came from? A comment explaining what
   a number *means* is recorded as "rationale only" — it is not a basis.
5. **Refutation.** Every finding below carries the attempt I made to kill it and
   the result. Two candidate findings died this way and are recorded under
   *Checked and found sound* rather than deleted.
6. **De-duplication.** Checked against `docs/capabilities/NETWORK_STATUS.md` (read
   from `origin/docs/agent-handoff-briefs`, since it is not on `main`),
   `docs/HANDOFF_RESEARCH.md` (same branch), `docs/audit-2026-08-18/PASS-04-safety-gates.md`
   — whose *Safety constants* table already covers much of this ground — and
   `git log --oneline origin/main -40`. Anything those already record is cited,
   not re-reported.

**A correction to my own first pass, recorded because the audit's standard says
to.** My initial sweep concluded that the claim on `/operations` — *"Any readiness
score below 5.0 triggers protective route and drill constraints"* — described
nothing that exists, because no server-side module gates anything on a readiness
number. That conclusion was wrong. The constraint exists; it lives in a React
component, at a different threshold, on a number the server never validates. It is
[F-9-02](#f-9-02-high--the-one-readiness-number-that-actually-changes-a-childs-training-is-a-client-side-constant-defaulting-to-green), and it is the most important thing in this pass.

---

## Registry inventory

39 entries. `support` takes four values: `implemented`, `primitive_only`,
`unsupported`, `experimental_unsupported`.

**The only execution path into the engine is two routes.**
`POST /api/pilot/shadow/formulas/results` runs a formula
(`app/api/pilot/shadow/formulas/results/route.ts:135`), and its input validator is
`isMvpFormulaId` (`route.ts:100`), which accepts only `MVP-01`…`MVP-12`
(`runner.ts:38-50`). `POST /api/pilot/shadow/formulas/observations` stores an
observation and runs a formula only on the supersede path
(`observations/route.ts:197`). **Nothing else in the repository imports the engine,
the runner, the repository or the registry** except `rabbitHoleAnchorLabels.ts`,
which reads it for display names only.

So: **12 of 39 entries are executable through any route. 27 are not.**

| ID | Name | Declared `support` | Implementation symbol | Callers | Declared status vs. actual use |
|---|---|---|---|---|---|
| CORE-01 | Session Load (sRPE) | `implemented` | `calculateSessionLoad` | reachable — `runner.ts:335` dispatches it as MVP-01 | agrees; CORE-01 and MVP-01 are the same function under two ids |
| CORE-02 | Attendance Rate | `implemented` | `calculateAttendanceRate` | **none** — `engine.ts:346` is the only non-test occurrence outside the registry string | `implemented` is literally true (the function exists); it is unreachable |
| CORE-03 | Arithmetic Mean | `primitive_only` | `mean` | internal only (`engine.ts:1221`, `baseline.ts:121`) | agrees |
| CORE-04 | Sample SD | `primitive_only` | `sampleStandardDeviation` | internal only | agrees |
| CORE-05 | Data Completeness | `unsupported` | — | none | agrees |
| CORE-06 | Training Monotony | `unsupported`, `humanReviewRequired` | — | none | agrees |
| CORE-07 | Training Strain | `unsupported`, `humanReviewRequired` | — | none | agrees |
| CORE-08 | Smallest Worthwhile Change | `primitive_only`, `humanReviewRequired` | `smallestWorthwhileChange*` | **none** — `primitives.ts:132`/`:148` have no callers at all | `primitive_only` is accurate; note the coefficients 0.2/0.3 are unsourced and the second carries a unit trap (F-9-13) |
| CORE-09 | Typical Error | `unsupported`, `humanReviewRequired` | — | none | agrees |
| CORE-10 | Standardized Change | `primitive_only`, `humanReviewRequired` | `standardizedChange` | internal (`engine.ts:1241`) | agrees |
| CORE-11 | Rolling Mean | `implemented` | `calculateRollingLoad` | **none** | unreachable |
| CORE-12 | EWMA | `implemented` | `calculateEwmaLoad` | **none**. The *primitive* `ewma` is used by `patterns/inference/drift.ts:27`, but not this formula | unreachable |
| CORE-13 | **Acute:Chronic Workload Ratio** | `implemented`, `humanReviewRequired` | `calculateAcuteChronicWorkloadRatio` | **none** — not in `runner.ts`'s import list (`runner.ts:1-18`) and not dispatched | unreachable. See [F-9-12](#f-9-12-low--core-13-carries-no-trace-of-the-three-evidence-rows-that-forbid-building-a-gate-on-it) — and note this contradicts `docs/HANDOFF_RESEARCH.md` §6, which says the engine "already computes and stores per-athlete … acute:chronic workload ratio" |
| MVP-01 | Session Load | `implemented` | `calculateSessionLoad` | reachable by API; **no UI calls the results route** | agrees as a claim about implementation |
| MVP-02 | Punch Output | `implemented` | `calculatePunchOutput` | reachable by API only | agrees |
| MVP-03 | Accuracy by Punch Type | `implemented` | `calculateAccuracyByPunchType` | reachable by API only | agrees |
| MVP-04 | Connect Differential | `implemented` | `calculateConnectDifferential` | reachable by API only | agrees |
| MVP-05 | Offensive Efficiency | `implemented` | `calculateOffensiveEfficiency` | reachable by API only | agrees |
| MVP-06 | **Contact Exposure** | `implemented`, `humanReviewRequired` | `calculateContactExposure` | reachable by API only; observations are written by `app/athlete/dashboard/sparring/page.tsx:69` | agrees as a status claim. But it computes a cumulative exposure index the sibling subsystem's migration forbids — [F-9-06](#f-9-06-medium--two-subsystems-take-opposite-doctrinal-positions-on-the-same-two-quantities) — and multiplies an ordinal — [F-9-07](#f-9-07-medium--contact-level-is-an-ordinal-multiplied-as-a-ratio-and-a-second-incompatible-contact-level-vocabulary-exists) |
| MVP-07 | Work-Rate Consistency | `implemented` | `calculateWorkRateConsistency` | reachable by API only | agrees |
| MVP-08 | Round-to-Round Change | `implemented` | `calculateRoundToRoundChange` | reachable by API only | agrees |
| MVP-09 | Personal Baseline Comparison | `implemented`, `humanReviewRequired` | `calculatePersonalBaselineComparison` | reachable by API only | agrees |
| MVP-10 | Data Completeness and Confidence | `implemented` | `calculateDataCompleteness` | reachable by API only | agrees |
| MVP-11 | Focus Attainment Rate | `implemented` | `calculateFocusAttainmentRate` | reachable by API only | agrees |
| MVP-12 | Seven-Day Weight Change | `implemented`, `humanReviewRequired` | `calculateSevenDayWeightChange` | reachable by API only | agrees |
| BF-01 … BF-09, BF-11, BF-12, BF-13 | (12 entries) | `unsupported` (BF-11 also `humanReviewRequired`) | — | none | agrees |
| BF-10 | Recommendation Priority | `unsupported`, `humanReviewRequired` | — | none | agrees |
| **LEGACY-READINESS** | Legacy Readiness Equation | `experimental_unsupported`, `humanReviewRequired` | **no `implementation` field at all** | **none.** `readinessMath.ts`'s three exports are imported only by `readinessMath.test.ts` | **The registry entry agrees with reality. The `/operations` screen does not** — see [F-9-01](#f-9-01-high--operations-presents-legacy-readiness-as-a-signed-certified-active-mathematical-gate-to-every-role-in-the-gym) |

**The headline result of this inventory is that the registry is honest.** No entry
marked `unsupported` or `experimental_unsupported` has a live caller. There is no
instance of the serious shape the scope named — experimental status with live
callers. The softer shape is present in five places (CORE-02, CORE-08, CORE-11,
CORE-12, CORE-13 declared `implemented`/`primitive_only` with zero callers), and
`support: 'implemented'` is a defensible word for "the function is written", so
those are recorded as facts rather than as defects. **The problem is not in
`registry.ts`. It is on the screen that describes it.**

One structural note: `formulaEngine.test.ts:82-107` pins the registry's size, id
list, frozen-ness, and specifically that `LEGACY-READINESS` stays
`experimental_unsupported` with `humanReviewRequired: true`. That test is the
reason the registry has not drifted. **Nothing pins the `/operations` copy to it.**

---

## Every constant that gates a decision about a child

"Gates a decision" is read strictly: the number changes what a person is told,
shown, prescribed, or flagged. Timeouts, byte ceilings, page limits and rate limits
are excluded.

`PASS-04-safety-gates.md` already tabulated the safety-gate constants. Rows it
already covered are marked **[P4]** and are not re-argued here; they are present so
this table is complete.

**Stated basis** is scored strictly. *none* = no comment, doc, or citation says
where the number came from. *rationale* = a comment explains why a number of that
shape is wanted, but names no source. *sourced* = a citation or a legal/statutory
basis.

| Constant | Value | Defined at | Read at | All readers agree? | Stated basis? |
|---|---|---|---|---|---|
| Athlete-facing GREEN band | `7` | `components/AthleteWorkspace.tsx:270` | `:1194` → `buildWorkoutFloorTasks` (`:301`) → persisted at `:1234` | **no** — a second GREEN/YELLOW/RED band exists server-side | **none** |
| Athlete-facing YELLOW band | `5` | `components/AthleteWorkspace.tsx:271` | same | **no — disagrees with `READINESS_YELLOW_MIN = 4`** | **none** |
| `readinessToTrain` initial value | `8` | `components/AthleteWorkspace.tsx:577` | `getReadinessLevel` | n/a | **none** — and it defaults to the GREEN band |
| `READINESS_GREEN_MIN` | `7` | `readinessBoard.ts:24` | `:37` | yes **[P4]** | **none** — the comment gives meaning, not source |
| `READINESS_YELLOW_MIN` | `4` | `readinessBoard.ts:25` | `:38`; imported by `coachIntelligence.ts:4`, used `:80` | yes server-side **[P4]**; disagrees with the client band above | **none** |
| `READINESS_FRESHNESS_HOURS` | `24` | `readinessBoard.ts:19` | `:58` | yes **[P4]** | rationale ("yesterday's body is not today's"), no source |
| `READINESS_RED_DAYS` | `3` | `coachIntelligence.ts:21` | `:80` | yes **[P4]** | **none** |
| `READINESS_RED_WINDOW_DAYS` | `7` | `coachIntelligence.ts:22` | `:80` | yes **[P4]** | **none** |
| `STALLED_GAP_DAYS` | `14` | `coachIntelligence.ts:19` | `:62` | yes **[P4]** | **none** |
| `UNREVIEWED_SESSION_DAYS` | `7` | `coachIntelligence.ts:26` | `:99` | yes **[P4]** | **none** |
| `HOLD_EXPIRY_DAYS` | `14` | `coachIntelligence.ts:28` | `:110` | yes **[P4]** (query has no lower bound — P4 F-07) | **none** |
| `ATTENDANCE_WINDOW_DAYS` | `28` | `coachIntelligence.ts:24` | `:83` | **no — restates `PERFORMANCE_WINDOW_DAYS_DEFAULT`** ([F-9-09](#f-9-09-medium--attendance_window_days-restates-performance_window_days_default-in-the-module-whose-header-says-equivalents-are-imported-not-restated)) | **none** |
| `PERFORMANCE_WINDOW_DAYS_DEFAULT` | `28` | `performanceAnalytics.ts:80` | `progressionSuggestions.ts:357`, `:512`; `analytics/performance/route.ts` | yes among its own readers | **none** |
| `PERFORMANCE_WINDOW_DAYS_MAX` | `365` | `performanceAnalytics.ts:81` | `clampWindowDays` | yes | **none** |
| `TRAINING_DAYS_MIN_EARLY` | `3` | `progressionSuggestions.ts:41` | `:142`; `coachIntelligence.ts:126` | yes | **none** |
| `TRAINING_DAYS_DROP_RATIO` | `0.5` | `progressionSuggestions.ts:42` | `:143` (`<=`); `coachIntelligence.ts:127` (`<`) | **no — operator disagreement, known** | **none** |
| `READINESS_DROP_POINTS` | `1.0` | `progressionSuggestions.ts:39` | `:115` | yes **[P4]** | **none** |
| `READINESS_MIN_CHECKINS_PER_HALF` | `2` | `progressionSuggestions.ts:40` | `:113-114` | yes | rationale ("a direction read into two check-ins … is noise"), no source |
| `TRANSFER_WINDOW_DAYS` | `60` | `falseProgress.ts:23` | `:78`; UI copy `coach/transfer-check/page.tsx:111` says "last 60 days" | yes, including the UI | **none** |
| `MIN_ATTEMPTS_PER_SIDE` | `3` | `falseProgress.ts:28` | `:59`, `:64` | yes | rationale, no source |
| `CONTROLLED_STRONG_RATE` | `0.7` | `falseProgress.ts:29` | `:61` | yes | **none** |
| `LIVE_WEAK_RATE` | `0.3` | `falseProgress.ts:30` | `:68` | yes | **none** |
| pain-report `critical` band | `>= 7` | `formulas/painReportAlert.ts:57` — bare literal | same function | yes **[P4]** | **none** |
| pain-report `high` band | `>= 4` | `formulas/painReportAlert.ts:58` — bare literal | same function | yes **[P4]** | **none** |
| `PAIN_REPORT_ALERT_WINDOW_DAYS` | `7` | `formulas/painReportAlert.ts:43` | module + `coach/pain-reports/route.ts:40`, `:65`, `:72` | yes **[P4]** — and surfaced to the coach rather than restated in copy | rationale, no source |
| contact-exposure acute window | `7` days | `formulas/engine.ts:874`, enforced `:905` | `:966` | yes | **none** |
| contact-exposure chronic window | `4` weeks | `formulas/engine.ts:875`, enforced `:906` | `:988` | yes | **none** |
| contact-level ordinal used as a multiplier | `0`–`3` | `formulas/engine.ts:971` | same | n/a | **none** — see [F-9-07](#f-9-07-medium--contact-level-is-an-ordinal-multiplied-as-a-ratio-and-a-second-incompatible-contact-level-vocabulary-exists) |
| SWC between-athlete coefficient | `0.2` | `formulas/primitives.ts:141` | zero callers | n/a | **none** |
| SWC within-athlete coefficient | `0.3` | `formulas/primitives.ts:157` | zero callers | n/a | **none** (a *unit* note exists, `:144-146`) |
| LEGACY-READINESS coefficients | `1.25`/`0.45`/`0.3` | `readinessMath.ts:16` (as `125`/`45`/`30` per 100) | zero callers; **displayed** at `app/operations/page.tsx:112` | three textual copies, all currently agreeing | **none** — and the registry says so in as many words |
| LEGACY-READINESS clamp | `1`–`10` | `readinessMath.ts:17` | zero callers | the *stored* readiness score is unclamped — [F-9-08](#f-9-08-medium--pilotreadinessscore-has-no-clamp-no-check-constraint-and-no-declared-scale-yet-the-bands-assume-1-10) | **none** |
| delta-RPE lock threshold | `2` | `readinessMath.ts:26` | zero callers; **displayed** at `app/operations/page.tsx:130` | n/a — no "intended RPE" is stored anywhere in the schema, so it is not merely uncalled, it is uncallable | **none** |
| `ADULT_AGE_YEARS` | `18` | `wallDisplay.ts:120` | `:201`; `profileVisibility.ts:162`, `:218` | value yes; **clock no** — [F-9-11](#f-9-11-low--the-18th-birthday-is-computed-in-utc-while-every-other-date-decision-is-computed-in-the-gyms-zone) | sourced-by-nature (legal majority), not cited |
| `DISPLAY_CONSENT_MAX_AGE_DAYS` | `365` | `wallDisplay.ts:118` | `:262` | yes | **rationale, and a good one** — "One year matches the registration cycle a gym already runs" (`:115-116`) |
| `DEFAULT_COVERAGE_TTL_HOURS` / `MAX_COVERAGE_TTL_HOURS` | `24` / `336` | `access.ts:95`, `:101` | `resolveCoverageTtlHours` | yes **[P4]** | **none** |
| `BOARD_MINIMUM_COHORT_SIZE` | `5` | `boardSummary.ts:3` | `escalationLadder.ts:587`, compliance summary | yes **[P4]** | **none** (k-anonymity convention, uncited) |
| `INCIDENT_DEDUP_WINDOW_SECONDS` | `30` | `escalationLadder.ts:208` | `:277`, `:322` | yes **[P4]**, bypassed by writer 8 (P4 F-04) | **none** |
| `DEFAULT_PATTERN_WINDOW_DAYS` / `DEFAULT_PATTERN_THRESHOLD` | `30` / `3` | `escalationLadder.ts:452-453` | `:481-482` | yes **[P4]** | **none** |
| `NOMINATION_WINDOW_DAYS` | `30` | `onePercentClub.ts:32` | expiry sweep; UI copy `coach/one-percent-club/page.tsx:135` | yes, including UI | sourced — owner design decision, quoted verbatim at `onePercentClub.ts:9-10` |
| majority rule | `yes × 2 > eligible` | `onePercentClub.ts:385` | `:352` | yes | sourced — owner design, quoted `:9-10`, `:301-302` |
| sparring contact limit | **does not exist** | — | — | n/a | **deliberate and sourced** — see *Checked and found sound* |

**Count: 41 rows. 28 have no stated basis at all.** Six carry a rationale but no
source; three are sourced (two to an owner decision, one to legal majority); the
remaining four are duplicates/disagreements counted once. The three constants the
`/operations` screen advertises to the whole gym — the readiness coefficients, the
clamp, and the delta-RPE lock — are all in the "no stated basis" set, and all three
have zero callers.

**One number in this table has a basis the code does not carry.** The platform's own
evidence registry, row `A6-063`, states its implication as:

> `PPBF readiness threshold must be derived from PPBF's own longitudinal data and labelled PROPOSED PPBF PARAMETER - ASSUMPTION`

`READINESS_GREEN_MIN` and `READINESS_YELLOW_MIN` carry no such label, and neither do
the client-side bands.

---

## Duplicate definitions and boundary disagreements

### Duplicate definitions

1. **Readiness triage bands — 2 independent definitions, and they disagree.**
   `readinessBoard.ts:37-39` (GREEN ≥ 7, YELLOW ≥ 4, else RED) and
   `AthleteWorkspace.tsx:270-272` (GREEN ≥ 7, YELLOW ≥ 5, else RED). Same
   vocabulary, same 1–10 range, both rendered to a human as a readiness colour,
   neither imports the other. See [F-9-04](#f-9-04-medium--a-fourth-readiness-pipeline-with-its-own-band-thresholds-that-disagree-with-the-servers).
2. **The `GREEN | YELLOW | RED` union itself — 6 definitions.**
   `readinessBoard.ts:27`, `AthleteWorkspace.tsx:74`, `CoachWorkspace.tsx:34` and
   `:64` (the latter adds `UNKNOWN`), `RoleSummaryPanels.tsx:8`,
   `rabbitHoles.ts:59` / `rabbitHoleAnchorLabels.ts:85-89`. All currently agree on
   members. This is the same shape as the `TrainingHoldScope` ×5 finding in
   `PASS-04`.
3. **The LEGACY-READINESS coefficients — 3 textual copies.** `readinessMath.ts:16`
   (as integers over 100), `registry.ts:315` (an expression string),
   `app/operations/page.tsx:112` (a display string). All three agree today. None is
   derived from another; a change to the code would leave two stale strings, one of
   which is shown to parents.
4. **The delta-RPE lock threshold — 2 copies.** `readinessMath.ts:26` (`< 2`) and
   `app/operations/page.tsx:130` ("2 or greater"). Agree today.
5. **The readiness clamp — 3 copies.** `readinessMath.ts:17`, `registry.ts:315`,
   `app/operations/page.tsx:112`. Agree with each other and with nothing that runs;
   the score that is actually stored is unclamped ([F-9-08](#f-9-08-medium--pilotreadinessscore-has-no-clamp-no-check-constraint-and-no-declared-scale-yet-the-bands-assume-1-10)).
6. **The 28-day analytics window — 2 definitions.** `ATTENDANCE_WINDOW_DAYS = 28`
   (`coachIntelligence.ts:24`) and `PERFORMANCE_WINDOW_DAYS_DEFAULT = 28`
   (`performanceAnalytics.ts:80`), feeding the same function for the same rule.
   [F-9-09](#f-9-09-medium--attendance_window_days-restates-performance_window_days_default-in-the-module-whose-header-says-equivalents-are-imported-not-restated).
7. **"Contact level" — 2 mutually unmappable vocabularies.** A numeric `level_0_3`
   in the formula engine (`formulas/types.ts:93`, used at `engine.ts:924`) and a
   five-member text vocabulary `('none','light_technical','conditioned','controlled_sparring','open_sparring')`
   in three migrations (`pilot_slice_postgres_drill_library_v3_migration.sql:214`,
   `pilot_slice_postgres_workout_templates_v2_migration.sql:114`,
   `pilot_slice_postgres_session_scripts_migration.sql:89`) and in
   `safetyFlags.ts:259` (`RttPermittedContact`). Four numeric positions cannot
   carry five categories; no mapping exists anywhere.
   [F-9-07](#f-9-07-medium--contact-level-is-an-ordinal-multiplied-as-a-ratio-and-a-second-incompatible-contact-level-vocabulary-exists).
8. **RPE — 3 scales, one of them unbounded.** `pilot.sessions.rpe` is
   `numeric not null` with **no CHECK** (`infra/azure/pilot_slice_postgres.sql:96`)
   and its validator is `requireNumber` (`validation.ts:61-66`), which enforces only
   "is a number"; `pilot.session_load.rpe_physical` is
   `check (… between 0 and 10)` with an explicit `rpe_scale text not null default 'CR10'`
   (`pilot_slice_postgres_sparring_exposure_and_load_migration.sql:123-125`); the
   formula engine requires `unit === 'rpe_0_10'` (`engine.ts:265-267`). See
   [F-9-03](#f-9-03-high--readiness-to-train-is-stored-in-a-column-named-rpe-and-displayed-to-the-child-as-effort).

### Comparison-operator and boundary disagreements

| # | Pair | Disagreement | Status |
|---|---|---|---|
| A | `progressionSuggestions.ts:143` `training_days_late <= early * 0.5` vs `coachIntelligence.ts:127` `training_days_late < early * 0.5` | Exact half. `early = 4, late = 2`: the gap engine suggests, the Morning Read is silent | **Known** — `NETWORK_STATUS.md` ("a comment claims an invariant the code does not hold") and `PASS-04`. Cited, not re-reported |
| B | `readinessBoard.ts:38` YELLOW floor `4` vs `AthleteWorkspace.tsx:271` YELLOW floor `5` | A score of 4: the coach's board says YELLOW ("check in with the athlete first"), the child's own screen says RED | **New** — [F-9-04](#f-9-04-medium--a-fourth-readiness-pipeline-with-its-own-band-thresholds-that-disagree-with-the-servers) |
| C | `/operations` "readiness score **below 5.0** triggers protective route and drill constraints" (`operations/page.tsx:129`) vs the actual trigger, `readinessToTrain < 7` (`AthleteWorkspace.tsx:270`) | The documented threshold and the running one differ by two whole points, in the direction that makes the running rule *more* protective than advertised | **New** — [F-9-02](#f-9-02-high--the-one-readiness-number-that-actually-changes-a-childs-training-is-a-client-side-constant-defaulting-to-green) |
| D | `wallDisplay.ts:186-190` computes the 18th birthday from `getUTCFullYear/Month/Date` while `gymTime.ts:15-17` states "wallDisplay.ts does all of its day arithmetic in that zone" and the module itself carries `gymDayBounds`/`formatYmdInZone`/`zonedMidnightUtc` (`:339`, `:374`, `:385`) | A minor becomes an adult up to 5 hours (EST) before the gym's own calendar says so | **New** — [F-9-11](#f-9-11-low--the-18th-birthday-is-computed-in-utc-while-every-other-date-decision-is-computed-in-the-gyms-zone) |
| E | `falseProgress.ts:61` `controlledRate < CONTROLLED_STRONG_RATE` (strict) vs `:68` `liveRate <= LIVE_WEAK_RATE` (inclusive) | Asymmetric operators on the two sides of the same classification | **Not a defect** — see *Checked and found sound* |
| F | `coachIntelligence.ts:110` `expires_at <= now() + 14 days` with no lower bound | A hold that lapsed months ago still lists under "Holds expiring within 14 days" | **Known** — `PASS-04` constants table |
| G | `coach/intelligence/page.tsx:112` "3+ RED readiness days **this week**" vs `:117` "in the last 7" vs the query's rolling `now() - 7 days` (`coachIntelligence.ts:80`) | "This week" reads as a calendar week; the rule is a rolling window. Two lines of the same page describe it two ways | **New, LOW** — recorded here rather than as its own finding |

---

## Findings

### F-9-01 [HIGH] — `/operations` presents LEGACY-READINESS as a signed, certified, active mathematical gate, to every role in the gym

**What is wrong.** `registry.ts` registers the readiness equation
`experimental_unsupported` with `humanReviewRequired: true` and a written
prohibition. `apps/web/src/server/pilot/formulas/registry.ts:315-319`:

> ```
>     expression: 'clamp(1, 10, sleep × 1.25 − soreness × 0.45 + discipline × 0.3)',
>     support: 'experimental_unsupported',
>     outputUnit: 'unitless',
>     humanReviewRequired: true,
>     unsupportedReason: 'Coefficients, input scales, fairness, and clinical/safety validity are unproven. It must not clear, restrict, or prescribe training.',
> ```

The `/operations` screen renders the same equation under a heading that says the
opposite. `apps/web/app/operations/page.tsx:112`:

> ```
> const shadowReadinessEquation = 'Readiness = max(1, min(10, (Sleep x 1.25) - (Soreness x 0.45) + (Discipline x 0.3)))';
> ```

It is rendered at `operations/page.tsx:256` inside an article headed **"Mathematical
Gate Validation"**, in a section introduced at `:242` as

> `SHADOW v21.1 seed is ingested, stress-validated, and sealed for development deployment. This build section mirrors the certified guardrails used for floor safety, role isolation, and audit integrity.`

and stamped at `:304` with a green `Signed & Active` stamp reading

> `Certification Status: Signed and Active. Logical paths, equations, role boundaries, and sandbox behavior are aligned for SHADOW core build execution.`

Beneath the equation sit four "boundary checks" (`operations/page.tsx:127-130`).
Two are false as stated:

> ```
>   'Any readiness score below 5.0 triggers protective route and drill constraints.',
>   'Delta RPE lockout engages when discrepancy is 2 or greater until rationale is provided.',
> ```

- The 5.0 constraint does not exist at 5.0. The real trigger is `< 7`, in a React
  component ([F-9-02](#f-9-02-high--the-one-readiness-number-that-actually-changes-a-childs-training-is-a-client-side-constant-defaulting-to-green)).
- The delta-RPE lockout does not engage anywhere. `isDeltaRPELocked`
  (`readinessMath.ts:25-31`) has no caller outside its own test, and it is not merely
  uncalled but **uncallable**: `grep -rni "rpe_intended\|intendedRpe\|target_rpe\|planned_rpe\|prescribed_rpe"`
  across `infra/azure/*.sql` and `apps/web/src/server/pilot/*.ts` returns nothing.
  No "intended RPE" is stored anywhere in the schema, so the second operand of
  `calculateDeltaRPE(rpeObserved, rpeIntended)` has no source.

The screen is gated by `RoleSessionGate allowedRoles={operationsRoles}`
(`operations/page.tsx:207`), and `operationsRoles` is
`[...roleRoutes.map((route) => route.role), 'platform_owner']` (`:203`) —
`roleRoutes.ts` lists `athlete`, `coach`, **`parent`**, `admin`, `staff`,
`volunteer` and eight board seats. **An athlete or a guardian who opens
`/operations` is shown a formula about that child's readiness, presented as a
certified, signed, active mathematical gate.** The registry says the same formula
must not prescribe training and that its coefficients are unproven.

**Refutation attempted.** Three ways.
(1) *Is the section hidden?* It sits inside a `<details>` element
(`operations/page.tsx:234-236`) labelled "System Diagnostics and SHADOW
Certification" — collapsed by default, but reachable by one click by every listed
role. That is a mitigation, not a defence.
(2) *Does "certified" refer to something narrower than the equation?* No. The
`Signed & Active` stamp's own copy names "equations" explicitly (`:304`), and the
equation is the first thing inside the "Mathematical Gate Validation" article.
(3) *Is this already recorded?* `docs/HANDOFF_RESEARCH.md` §3 says the formula "is
displayed on the operations page as a 'certified' live equation" — so the display
itself is **known**. What is new here is (a) the two boundary-check strings, one
false and one describing an uncallable function, (b) that the audience includes
athletes and parents, and (c) that the `/operations` copy is three hardcoded
strings with no import from the registry, so nothing would catch the drift. Those
three are reported; the display alone is cited.

**Consequence.** The repository's central stated principle is that a formula must
*earn* authority. This screen grants authority to the one formula the registry
explicitly denies it to, and grants it in front of the children and guardians the
principle exists to protect. Separately, anyone reading the boundary checks — a
board member, a funder, an auditor — is told two safety behaviours are in force that
are not.

---

### F-9-02 [HIGH] — The one readiness number that actually changes a child's training is a client-side constant, defaulting to GREEN

**What is wrong.** There *is* a readiness threshold that changes what a child is
told to do. It is not on the server, it is not the number `/operations` names, and
it is not the one the coach's board uses.

`apps/web/components/AthleteWorkspace.tsx:269-273`:

> ```
> function getReadinessLevel(readinessToTrain: number): ReadinessLevel {
>   if (readinessToTrain >= 7) return 'GREEN';
>   if (readinessToTrain >= 5) return 'YELLOW';
>   return 'RED';
> }
> ```

That band drives the child's prescribed session. `AthleteWorkspace.tsx:316-318`:

> ```
>       description: readiness === 'GREEN'
>         ? 'Footwork progression + combination reps at normal intensity.'
>         : 'Controlled technical reps with clean form and reduced impact output.',
> ```

and `:331-333` / `:342-344`:

> ```
>             title: 'Conditioning Finisher',
> ...
>             description: 'High-output intervals: 6 rounds x 90s on / 60s active recovery.',
> ```
> ```
>             title: 'Recovery Conditioning',
> ...
>             description: 'Low-impact aerobic work and breath control. Keep intensity below threshold.',
> ```

This is not a local UI nicety. The plan is persisted: `handleCheckIn` builds the
tasks at `:1196`, packs them with the band into `floorPlanPayload` at `:1210-1220`,
and `POST`s them to `/api/pilot/floor-plans` at `:1234`. The route stores the whole
object as `jsonb` (`app/api/pilot/floor-plans/route.ts:11-13`) and serves it back to
the athlete, their coach, and org admins (`route.ts:37-80`).

Three things make this the most serious item in this pass.

1. **The threshold has no stated basis and no server-side existence.** `7` and `5`
   appear once each, in a React component, with no comment, no test pinning them,
   and no import from `readinessBoard.ts`.
2. **The default is the most demanding option.** `AthleteWorkspace.tsx:577`:
   > ```
   >   const [readinessToTrain, setReadinessToTrain] = useState(8);
   > ```
   `getReadinessLevel(8)` is `GREEN`. A child who taps check-in without moving the
   slider is prescribed normal-intensity technical work plus "High-output intervals:
   6 rounds x 90s on / 60s active recovery." This is the exact failure mode the same
   codebase names and forbids elsewhere: `readinessBoard.ts:8-9` quotes the coach
   workspace's own safety comment, *"never default these to a reassuring value"*, and
   `CoachWorkspace.tsx:1635` refuses to render zero flags when there is no signal.
   The athlete's own screen defaults to the reassuring value.
3. **Nobody with medical or coaching standing sees the number.** The value goes to
   `pilot.sessions.rpe` (F-9-03), not to `pilot.readiness`, so the coach's readiness
   board — the GREEN/YELLOW/RED triage surface — never sees it. The coach can see the
   band string on a stored floor plan, computed by a different rule from the one
   their own board uses.

**Refutation attempted.** Four ways.
(1) *Is the failure direction safe?* Mostly. A child who reports low readiness gets a
lighter session — that is the right direction. The unsafe direction is narrow: a
child who does not touch the slider, or who over-reports, gets the hardest option.
The default makes that narrow case the common one, which is why the finding stands.
(2) *Is this a real prescription or decoration?* It is persisted and coach-readable,
which is more than decoration; it is also a task checklist on a kiosk rather than a
gate, which is less than a prescription. Recorded as "changes what the child is told
to do", which is what the evidence supports.
(3) *Does a server-side check re-derive it?* No. `floor-plans/route.ts` types the
payload (`route.ts:15-27`) and stores it whole; it does not recompute the band or
validate the readiness value.
(4) *Is it already recorded?* No. `HANDOFF_RESEARCH.md` §3 enumerates three readiness
pipelines and this is not among them; `PASS-04`'s constants table does not contain
`getReadinessLevel`; `NETWORK_STATUS.md` does not mention floor plans.

**Why not CRITICAL.** The audit's bar is a number that gates a *training or safety*
decision and is wrong in a way that could harm a child. This one gates a training
decision and its default is wrong. But it clears no safety gate, lifts no hold,
authorises no contact, and is a task list on a screen with a coach standing on the
floor. I am recording HIGH and stating the grounds rather than reaching for the
headline. If a reviewer decides that "a child who feels unwell is prescribed six
rounds of high-output intervals by default" meets the CRITICAL bar, the facts above
support that call and I would not argue against it.

**Consequence.** The only readiness threshold in this platform that changes a child's
training is undocumented, unsourced, client-side, absent from every audit table
including this audit's own, documented publicly at the wrong value, and defaulted to
the most demanding band.

---

### F-9-03 [HIGH] — "Readiness to Train" is stored in a column named `rpe` and displayed to the child as "effort"

**What is wrong.** The athlete's slider is labelled
`Readiness to Train (1-10)` (`AthleteWorkspace.tsx:1772`). Its value is written
into `pilot.sessions.rpe` — Rate of Perceived Exertion —
(`AthleteWorkspace.tsx:1266`, and again on update at `:1282`):

> ```
>           rpe: readinessToTrain,
> ```

and posted to the formula engine as an RPE observation
(`AthleteWorkspace.tsx:383-385`):

> ```
>       kind: 'session_rpe' as const,
>       value: input.rpe,
>       unit: 'rpe_0_10' as const,
> ```

fed from `:1311`, `rpe: readinessToTrain`.

Corroboration that this is readiness and not exertion is written into the row
itself. `AthleteWorkspace.tsx:227-229`:

> ```
> function autoCheckInNote(readiness: ReadinessLevel): string {
>   return `Auto check-in readiness ${readiness}`;
> }
> ```

That note is stored on the same session record as the `rpe` value (`:1255`, `:1267`).

The consequences are all on live screens:

- The child's own training card renders it as effort.
  `apps/web/components/TrainingCard.tsx:186-188`:
  > ```
  >           const ink = Math.min(Math.max((s.rpe || 0) / 10, 0), 1);
  >           const label = done
  >             ? `Session ${formatDate(s.date)}, effort ${s.rpe} of 10`
  > ```
  The stamp's ink density scales with the number, so **"I feel great today" prints a
  darker, harder-looking session than "I feel rough."**
- Coaches and admins see it averaged under a column headed `Avg RPE`
  (`app/coach/performance-analytics/page.tsx:137`, over `avg(rpe)` at
  `performanceAnalytics.ts:110`).
- It is the RPE half of Session Load. `calculateSessionLoad` multiplies it by
  duration (`engine.ts:255-267`, registry expression `'session RPE × duration minutes'`,
  `registry.ts:62`). Since readiness and exertion run in opposite directions, the
  computed "training load" **rises as the athlete reports feeling better.**

**Refutation attempted.** Three ways.
(1) *Could `readinessToTrain` be an idiosyncratic label for a genuine RPE input?* No.
It sits in the "Daily Biological Check-In" group beside Sleep, Energy, Motivation
and Soreness (`:1760-1775`), it is collected **before** the session at check-in
(`handleCheckIn`, `:1181`), and its own band function returns GREEN/YELLOW/RED. RPE
is rated after work is done; `pilot.session_load.rated_at` exists for exactly that.
(2) *Is there a second, real RPE writer that dilutes this?* Coaches can `POST
/api/pilot/sessions` directly, so the column is mixed rather than uniformly wrong —
which makes `avg(rpe)` an average over two different constructs, not merely an
inverted one. That is worse, not better.
(3) *Is the column constrained so a scale error would be caught?*
`infra/azure/pilot_slice_postgres.sql:96` is `rpe numeric not null` — no CHECK — and
`validation.ts:61-66`'s `requireNumber` enforces only that the value is a number.
Nothing would catch it.

**Consequence.** A number meaning "I feel ready" is stored, displayed and computed
with as a number meaning "that was hard". The coach's `Avg RPE` column reads high for
the athletes who feel best, and the platform's flagship load formula
(sRPE × duration, CORE-01/MVP-01) inverts if it is ever run on this data.

---

### F-9-04 [MEDIUM] — A fourth readiness pipeline, with its own band thresholds that disagree with the server's

**What is wrong.** `docs/HANDOFF_RESEARCH.md` §3 describes three disconnected
readiness pipelines. There are four. The fourth is the athlete workspace's
`readinessToTrain`, which has its own band function
(`AthleteWorkspace.tsx:269-273`, quoted in F-9-02) that **disagrees with the
server's at the YELLOW floor**.

`apps/web/src/server/pilot/readinessBoard.ts:36-40`:

> ```
> export function readinessStatusForScore(score: number): ReadinessBoardStatus {
>   if (score >= READINESS_GREEN_MIN) return 'GREEN';
>   if (score >= READINESS_YELLOW_MIN) return 'YELLOW';
>   return 'RED';
> }
> ```

with `READINESS_YELLOW_MIN = 4` (`readinessBoard.ts:25`) against the client's `5`.
At a score of 4 the coach's board says YELLOW — whose documented meaning is "check in
with the athlete first" (`readinessBoard.ts:22-23`) — and the child's own screen says
RED. Neither module imports the other.

**Refutation attempted.** *Are these the same quantity, so that a disagreement is
meaningful?* They are not the same *row* — the client band reads a slider that lands
in `pilot.sessions.rpe`, the server band reads `pilot.readiness.score` — which is
precisely the finding: the same 1–10 scale, the same three-colour vocabulary, the
same word "readiness", two sources and two rules. The disagreement is real whichever
number is put through them. *Is it already recorded?* The three-pipeline finding is
known and cited; the fourth pipeline and the band disagreement are not in
`NETWORK_STATUS.md`, `HANDOFF_RESEARCH.md` or `PASS-04`.

**Consequence.** A child and their coach can be looking at the same readiness value
and reading two different colours off it, with the child's screen the more alarming
of the two. If the fourth pipeline were ever wired to the third — the obvious
"improvement" — the bands would silently reclassify a band of scores.

---

### F-9-05 [MEDIUM] — The Daily Biological Check-In collects four wellness inputs from children and persists none of them, under copy telling them to answer honestly

**What is wrong.** `AthleteWorkspace.tsx:2309-2331` renders a panel headed
`Daily Biological Check-In` with four sliders — Sleep (4–12 h), Hydration (1–10),
Motivation (1–10), Soreness (0–10). The help panel directly above it says
(`:2296-2299`):

> ```
>                   'Complete check-in every morning before training',
>                   'Answer honestly for accurate coaching guidance',
>                   'Expand for detailed metrics if you have time',
>                   'Flag injuries immediately'
> ```

`grep -n "sleepHours\|energyLevel\|motivation\|hydrationStatus\|soreness"` over the
whole file returns only `useState` declarations (`:572-576`) and the slider bindings.
**None of the four values appears in any `fetch` body.** They are discarded when the
component unmounts.

The panel is honest about the *unbuilt* fields — `:2343`, "None of this is built yet.
Here is what is coming:" — which makes the silence about the four visible sliders
sharper, not softer: the screen distinguishes built from unbuilt and puts these on the
built side.

Two of the four discarded inputs — **Sleep and Soreness** — are exactly two of
LEGACY-READINESS's three inputs. The gym is already collecting the formula's data
from children, daily, and throwing it away, while `/operations` shows the formula to
those same children as a signed and active gate ([F-9-01](#f-9-01-high--operations-presents-legacy-readiness-as-a-signed-certified-active-mathematical-gate-to-every-role-in-the-gym)).

A safety-adjacent corollary sits in the same card. `AthleteWorkspace.tsx:1799-1806`
is headed `Pain/Soreness Report` and offers an `Injury or Pain Flag` checkbox and a
`Soreness Level (1-10)` slider. The checkbox reaches the server only as a *dimension*
on the session RPE observation (`:386`, `dimensions: { painFlag: input.painFlag, … }`),
and `alertCoachToPainReport` fires only when `kind === 'pain_report'`
(`formulas/painReportAlert.ts:45`, `:114`). **A child who ticks "Injury or Pain Flag"
and slides soreness to 9 on this panel reaches no coach.**

**Refutation attempted.** *Is there a working path in the same card?* Yes, and it
matters: the `Report Pain` button at `:1827-1834` opens a modal that posts a real
`pain_report` observation (`:1414-1431`), which does reach a coach and tells the child
so (`:1444-1446`). That is a genuine mitigation and the reason this is MEDIUM rather
than higher. But the button is disabled until a body location is chosen
(`:1831`, `disabled={!selectedPainLocation}`), and the checkbox above it gives no
indication that ticking it does nothing.
*Is the slider label right?* No — it says `(1-10)` while the control is
`min="0" max="10"` (`:1805`). Minor, recorded for completeness.

**Consequence.** Children are instructed to check in every morning and answer honestly
"for accurate coaching guidance" into controls that store nothing, in a card headed
"Report", one of whose controls is an injury flag. Pass 3's and pass 7's lanes overlap
here (`covers_video` is the same shape: a control collected and enforced by nothing);
this instance is on the athlete's own daily surface.

---

### F-9-06 [MEDIUM] — Two subsystems take opposite doctrinal positions on the same two quantities

**What is wrong.** The sparring-exposure migration states a prohibition in its header.
`infra/azure/pilot_slice_postgres_sparring_exposure_and_load_migration.sql:24-29`:

> ```
> -- WHAT pilot.sparring_exposure REFUSES TO DO. No damage score. No
> -- cumulative risk index. No recommended limit. No clearance. The acute
> -- dose-response relationship between head impact exposure and concussion
> -- remains unresolved, so any number this system produced would be
> -- invention wearing a decimal point. It counts and it displays. A
> -- qualified human reads it.
> ```

and, at `:37-41`:

> ```
> -- DELIBERATELY NOT a stored column -- it is arithmetic on two fields that
> -- are both present, and storing it would freeze a formula that has not
> -- been validated in boxing. Compute it in the query that needs it, and
> -- label it unvalidated where it is displayed.
> ```

(referring to sRPE × duration). The prohibition is even carried into the database as
a table comment, `:153`: *"No damage score, cumulative risk index, or recommended
limit -- no validated safe sparring dose exists for any population this platform
serves."* `sparringExposure.ts` honours it: `deriveUnvalidatedSessionLoad` (`:299-308`)
computes the product, returns it under a key beginning `unvalidated_`, and stores
nothing.

The formula engine does both forbidden things, for the same children, from a
different capture surface:

- **A cumulative exposure index.** `formulas/engine.ts:967-971`:
  > ```
  >   const weeklyTotals = [0, 0, 0, 0];
  >   for (const session of input.sessions) {
  >     const ageMs = asOfMs - Date.parse(session.level.observedAt);
  >     const weekIndex = Math.min(3, Math.floor(ageMs / windowMs));
  >     weeklyTotals[weekIndex] += session.level.value! * session.rounds.value!;
  > ```
  producing `acute_7_day` and `chronic_4_week` outputs (`registry.ts:222-225`) — a
  cumulative contact index in acute/chronic form.
- **A stored sRPE × duration.** `runStoredMvpFormula` persists every result inside a
  transaction, `runner.ts:560-566`:
  > ```
  >   const persisted = await withTransaction(async (client) => {
  > ...
  >     const results = await saveFormulaResultsWithClient(client, calculated.results);
  > ```
  and MVP-01 is `'session RPE × duration minutes'` (`registry.ts:172`).

**Refutation attempted.** Three ways.
(1) *Are they about different facts?* They are about the same facts — how much contact
a child took, and how hard a session was — captured through two surfaces (coach-logged
sparring segments vs. athlete-posted formula observations from
`app/athlete/dashboard/sparring/page.tsx:69`).
(2) *Does the migration's prohibition bind the formula engine?* Textually it is scoped
to `pilot.sparring_exposure`. So this is a doctrinal collision rather than a rule
violation, and it is reported as such. The reason it still matters is the reasoning
the migration gives — "no validated safe sparring dose exists for any population this
platform serves" — which is a claim about the world, not about a table.
(3) *Is anything harmed today?* No. No UI calls `POST /api/pilot/shadow/formulas/results`
(`grep` for the path over `apps/web/components` and `apps/web/app` outside `app/api`
returns only observation writes), so no exposure index is currently being produced
unless someone calls the API directly. This is a latent contradiction, which is why it
is MEDIUM.

**Consequence.** Two capabilities in one platform have reached opposite conclusions
about whether a cumulative contact-exposure figure for a child may exist, and the one
that says yes is `support: 'implemented'` with `humanReviewRequired: true` and no
human-review surface reading it.

---

### F-9-07 [MEDIUM] — Contact level is an ordinal multiplied as a ratio, and a second, incompatible contact-level vocabulary exists

**What is wrong.** The athlete's contact control is an ordinal.
`app/athlete/dashboard/sparring/page.tsx:220`:

> ```
>   const contactLevelLabel = ['None', 'Light', 'Moderate', 'Heavy'][contactLevel] ?? 'Unknown';
> ```

posted as `unit: 'level_0_3'` (`page.tsx:69`). `engine.ts:971` (quoted above)
multiplies that ordinal by a round count, so **"Heavy" contributes exactly three times
"Light" and exactly 1.5 times "Moderate"** — a ratio-scale operation on a four-point
labelled scale. Nothing in `engine.ts`, `registry.ts` or `types.ts` states a basis for
those spacings.

The same codebase demonstrates it knows this problem exists. `registry.ts:311`, BF-13:

> ```
> unsupported('BF-13', 'Ring Control', 'center-time ratio or separately labeled coach ordinal observation', 'ratio', 'Center-zone tracking is unavailable and coach ordinal ratings must remain separately labeled observations.'),
> ```

Separately, "contact level" has a **second, five-member vocabulary** in the schema
(`pilot_slice_postgres_drill_library_v3_migration.sql:214`):

> ```
>       check (contact_level in ('none','light_technical','conditioned','controlled_sparring','open_sparring'));
> ```

repeated in `pilot_slice_postgres_workout_templates_v2_migration.sql:114`,
`pilot_slice_postgres_session_scripts_migration.sql:89`, and as
`RttPermittedContact` in `safetyFlags.ts:259`. Four numeric positions cannot represent
five categories; no mapping function exists anywhere in the repository.

**Refutation attempted.** Two ways.
(1) *Is the multiplication defensible as an arbitrary index nobody reads as
proportional?* Possibly — but the registry publishes it as `'Σ(contact level × rounds)'`
with `outputUnit: 'au'` (`registry.ts:222`, `:224`), and `au` (arbitrary units) is the
same unit CORE-01 gives to sRPE × duration, which *is* read proportionally. The scale
assumption is not disclosed anywhere.
(2) *Do the two vocabularies ever meet?* Not today — the numeric one is confined to
the formula engine and the text one to the planning tables. That is why this is MEDIUM
and not higher, and it is also the reason to record it: the obvious future
integration (compute exposure from planned sessions) has no lossless path.

**Consequence.** The only cumulative contact figure the platform computes rests on an
undisclosed and unsourced assumption that the gaps between None, Light, Moderate and
Heavy are equal, and it cannot be reconciled with the contact vocabulary the rest of
the platform uses.

---

### F-9-08 [MEDIUM] — `pilot.readiness.score` has no clamp, no CHECK constraint, and no declared scale, yet the bands assume 1–10

**What is wrong.** `readinessBoard.ts:21-25` describes its thresholds as

> ```
> /** Score bands over the check-in formula's 1-10 range. Operational triage
>  * colors for a coach's glance, not clinical judgments: GREEN = train as
>  * planned, YELLOW = check in with the athlete first, RED = adjust the plan. */
> export const READINESS_GREEN_MIN = 7;
> export const READINESS_YELLOW_MIN = 4;
> ```

Nothing enforces that 1–10 range at any point on the write path.

- The column: `infra/azure/pilot_slice_postgres_multiorg_migration.sql:65` is
  `score numeric not null` with no CHECK, and `grep -n "readiness" infra/azure/*.sql`
  finds no later migration adding one.
- The domain function takes the number as given: `intake.ts:561-576`, `createReadiness`,
  binds `params.score` straight into the INSERT.
- The route takes it from the request body:
  `app/api/pilot/intake/domain-upsert/route.ts:121`:
  > ```
  >         score: Number(body.payload.score || 0),
  > ```

`PASS-04` recorded the *module* half of this ("the stored readiness score is taken raw
from the request body", F-08). The schema half is new: there is no clamp in the
database either, so a `score` of `70` renders GREEN and a `score` of `-3` renders RED,
and the clamp that would have prevented it lives in `readinessMath.ts:17`, in a module
with no callers.

`category` is likewise free text defaulting to `'general'`
(`domain-upsert/route.ts:122`) and is read by nothing — `readinessStatusForScore`
re-derives the band from `score` and ignores it.

**Refutation attempted.** *Does `Number(body.payload.score || 0)` fail closed?* Partly.
A non-numeric string yields `NaN`, which the numeric column rejects, so the request
errors — that is fine. A missing value yields `0`, which stores and renders RED — also
the safe direction. The unsafe case is an out-of-range **high** value, which stores and
renders GREEN with no complaint. *Is the writer trusted?* The route requires coach or
admin (`domain-upsert/route.ts`), so this is a typo/import-error risk rather than an
attack. MEDIUM on that basis.

**Consequence.** The one server-side readiness triage a coach relies on applies 7/4
bands to a number that no layer constrains to the range those bands were drawn for.

---

### F-9-09 [MEDIUM] — `ATTENDANCE_WINDOW_DAYS` restates `PERFORMANCE_WINDOW_DAYS_DEFAULT`, in the module whose header says equivalents are imported, not restated

**What is wrong.** `apps/web/src/server/pilot/coachIntelligence.ts:13-16`:

> ```
> // Thresholds are named constants pinned by tests. Where an equivalent
> // threshold already exists elsewhere it is IMPORTED, not restated, so the
> // two rules can never drift apart (attendance reuses the gap-suggestion
> // constants; the RED band reuses the readiness board's).
> ```

The module does import two of the three attendance inputs —
`TRAINING_DAYS_MIN_EARLY` and `TRAINING_DAYS_DROP_RATIO` (`coachIntelligence.ts:3`).
It restates the third. `coachIntelligence.ts:24`:

> ```
> export const ATTENDANCE_WINDOW_DAYS = 28;
> ```

against `performanceAnalytics.ts:80`:

> ```
> export const PERFORMANCE_WINDOW_DAYS_DEFAULT = 28;
> ```

which is what the sibling rule passes (`progressionSuggestions.ts:357`). Both are then
handed to the same `getPerformanceRollup`, whose halves are derived from the window it
is given (`performanceAnalytics.ts:99-101`). Change one and the two "same" attendance
rules split their windows at different midpoints, and their `training_days_early` /
`training_days_late` counts stop being comparable.

This is the **second** defect in the invariant that comment claims. The first — the
`<=` / `<` operator split at `progressionSuggestions.ts:143` vs
`coachIntelligence.ts:127` — is already recorded in `NETWORK_STATUS.md` and `PASS-04`
and is not re-reported. Two of the four inputs to "the same rule" therefore fail the
comment's promise: one by operator, one by restatement.

**Refutation attempted.** Two ways.
(1) *Is the restatement deliberate — different rules wanting different windows?* If so
the comment is still wrong, and nothing says so; the two constants have the same value
and the same purpose, and the Morning Read's own copy calls the late half "this
fortnight" (`coach/intelligence/page.tsx:133`), which is only true while the window is
28.
(2) *Is it already recorded?* `PASS-04`'s constants table lists `ATTENDANCE_WINDOW_DAYS`
as "yes" (agreeing), because it only checked internal consistency within
`coachIntelligence.ts`. The cross-module duplication is new.

**Consequence.** The invariant a comment promises is broken in two of four places, and
a reader who trusts the comment will not grep for the third definition.

---

### F-9-10 [MEDIUM] — The rabbit-hole authoring picker offers all 39 registry entries as anchorable formulas, with no support status

**What is wrong.** `apps/web/components/rabbitHoleAnchorLabels.ts:75-78`:

> ```
>   formula_id: SHADOW_FORMULA_REGISTRY.map((formula) => ({
>     key: formula.id,
>     label: `${formula.id} - ${formula.name}`,
>   })),
> ```

under the anchor-type label `formula_id: 'SHADOW formula'`
(`rabbitHoleAnchorLabels.ts:49`). The projection keeps `id` and `name` and drops
`support`, `unsupportedReason` and `humanReviewRequired`. So a coach authoring a
teaching lesson is offered `LEGACY-READINESS - Legacy Readiness Equation` alongside
`MVP-01 - Session Load`, indistinguishable, and can publish a gym-visible lesson
anchored to a formula the registry forbids from prescribing training — plus 16
`unsupported` entries that compute nothing at all.

**Refutation attempted.** Two ways.
(1) *Does the surface disclose status elsewhere?* The file's own header is careful
about a different problem — that keys are stable and labels are display-only
(`:1-8`) — and about not enumerating row-backed vocabularies whose keys cannot be
listed (`:16-22`). It says nothing about support status.
(2) *Is sourcing labels from the registry wrong?* No — it is right, and the header says
so at `:56-58` ("the formula names are the registry's, so a renamed seat or formula
reads correctly here without being retyped"). The defect is that it takes the name and
leaves the disclaimer.

**Consequence.** The registry's central safety property — that an entry's status
travels with it — survives the server and is dropped at the one place a person picks
a formula by hand.

---

### F-9-11 [LOW] — The 18th birthday is computed in UTC while every other date decision is computed in the gym's zone

**What is wrong.** `apps/web/src/server/pilot/wallDisplay.ts:186-190`:

> ```
>   let age = now.getUTCFullYear() - year;
>   const monthNow = now.getUTCMonth() + 1;
>   const dayNow = now.getUTCDate();
>   if (monthNow < month || (monthNow === month && dayNow < day)) {
>     age -= 1;
>   }
> ```

feeding `isMinor` (`:199-201`), which gates guardian-signature requirements for name
display (`:266`) and portrait/profile visibility (`profileVisibility.ts:162`, `:218`).

`apps/web/src/lib/gymTime.ts:15-17` states the platform's rule and asserts this very
module follows it:

> ```
>  * The server already settled this question: env.ts resolves PPBF_WALL_TIMEZONE
>  * and defaults to America/New_York, and wallDisplay.ts does all of its day
>  * arithmetic in that zone. This is the client-side half of the same rule.
> ```

The module does carry that toolkit — `gymDayBounds` (`:339`), `formatYmdInZone`
(`:374`), `zonedMidnightUtc` (`:385`) — and uses it everywhere except here. In
`America/New_York` the UTC date rolls over 4–5 hours before the gym's, so a
17-year-old is classified as an adult for the final 4–5 hours of the evening before
their birthday. In that window the guardian-signature requirement at `:266` no longer
applies and the profile-visibility path treats them as staff-visible.

**Refutation attempted.** Three ways.
(1) *Direction?* Toward disclosure, which is the wrong direction — but by hours, once
per athlete, self-correcting.
(2) *Is the whole gate UTC?* No, and this matters for scoping: the consent-staleness
check uses absolute milliseconds (`:261-263`), which is timezone-independent and
correct. Only the birthday comparison is affected.
(3) *Is the fail-closed default intact?* Yes — `isMinor` returns `true` for a missing
or unparseable dob (`:200-201`), and the comment at `:196-198` says why. That is sound
and is recorded under *Checked and found sound*.

**Consequence.** A safeguarding classification flips up to five hours early, and a
doc file asserts the opposite of what the code does.

---

### F-9-12 [LOW] — CORE-13 carries no trace of the three evidence rows that forbid building a gate on it

**What is wrong.** `registry.ts:160-170` registers CORE-13 Acute:Chronic Workload Ratio
as `support: 'implemented'` with `humanReviewRequired: true` and no `unsupportedReason`
(that field exists only for unsupported entries). The platform's own evidence
registry contains three verified rows whose stated implications are:

- `A3-103`: *"PPBF must NOT build an injury-risk gate on the acute:chronic workload ratio."*
- `A3-104`: *"Log load, show trends, do not compute a ratio implying a risk threshold."*
- `A5-045`: *"PPBF MUST NOT ship a coupled ACWR as a risk indicator. If any ratio is displayed at all it must be uncoupled and labelled CONTESTED, with no threshold-based action attached."*

(all in `apps/web/seed-data/research-evidence/2026-08-07/evidence_registry_boxing_learning.csv`).

Nothing in `registry.ts`, `engine.ts:522-573` or `primitives.ts:160-174` references
any of them, and no output of CORE-13 carries a CONTESTED label.

**Refutation attempted.** Three ways, and they are why this is LOW and not higher.
(1) *Is a gate being built on it?* No. CORE-13 has zero callers; it is not in
`runner.ts`'s dispatch. **The platform is currently obeying its own evidence base.**
(2) *Is the implementation coupled, which A5-045 specifically forbids?* No — the engine
takes `acute_load` and `chronic_load` as two independent observations
(`engine.ts:522-526`), so coupling would be a property of how a caller derived them,
and there is no caller.
(3) *Does `humanReviewRequired: true` already carry the warning?* It carries *a*
warning, but no reason and no CONTESTED label, and it does not reach any surface.

**Consequence.** The strongest evidence the platform holds about one of its formulas
lives in a CSV that the formula's registry entry does not cite. `support: 'implemented'`
plus a `humanReviewRequired` flag reads as "ready, with a checkbox" to the next
engineer, when the correct reading is "three verified sources say do not gate on this".
This is a wiring hazard, not a live defect.

---

### F-9-13 [LOW] — The smallest-worthwhile-change unit trap is enforced only by a comment

**What is wrong.** `apps/web/src/server/pilot/formulas/primitives.ts:144-146`:

> ```
> /**
>  * The coefficient is applied to a CV ratio (for example, 0.08 for 8%), not a
>  * percentage number. Callers must label the input accordingly.
>  */
> ```

The function that follows accepts any non-negative finite number (`:148-158`). A caller
passing `8` where `0.08` is meant gets an answer 100× too large, with no validation
state and no warning. The sibling `coefficientOfVariationPercent` (`:120-128`) returns a
**percentage**, so the most natural in-repo input to this function is already in the
wrong unit.

**Refutation attempted.** *Is anything exposed?* No — both SWC functions have zero
callers anywhere (`primitives.ts:132`, `:148` are their only non-test occurrences), and
CORE-08 is `primitive_only`. LOW on that basis; recorded because the trap is one import
away and the comment is the only guard.

**Consequence.** A documented unit contract with no type or runtime enforcement, sitting
next to a function that produces the wrong unit.

---

### F-9-14 [LOW] — Two coach-facing screens call staff-typed intake scores the child's "check-ins"

**What is wrong.** `pilot.readiness` is not the athlete's check-in table, and a
migration says so explicitly.
`infra/azure/pilot_slice_postgres_athlete_check_ins_migration.sql:10-13`:

> ```
> -- and never double-counts a day. And it is NOT pilot.readiness: that table
> -- carries formula scores read by the readiness board with GREEN/YELLOW
> -- thresholds -- mixing self-reports in would contaminate it (the board
> -- reads the table unfiltered). Self-report lives here, under its own name.
> ```

The athlete's own self-report goes to `pilot.athlete_check_ins`
(`athleteCheckIns.ts:8`, `api/pilot/athlete/check-in/route.ts:20-21`), and
`pilot.readiness` is written only by the two intake routes
(`intake/domain-upsert/route.ts:118`, `intake/review-action/route.ts:435`) — staff
keying numbers during intake.

Two coach surfaces label the second as the first:

- `app/coach/performance-analytics/page.tsx:155`: `({item.readiness_count} check-ins)`,
  over `avg(score) … from pilot.readiness` (`performanceAnalytics.ts:126`).
- `app/coach/intelligence/page.tsx:117`: `— {item.red_days} RED check-in days in the last 7`,
  over the same table (`coachIntelligence.ts:69`).

**Refutation attempted.** Two ways.
(1) *Is it minor-facing?* No — `analytics/performance/route.ts:27` restricts to
coach/admin/organization_admin with a comment saying why. The athlete/parent
justification slice (`progressionSuggestions.ts:426-433`, PR #446) does allowlist
`readiness_early_avg` etc. through `/api/pilot/progression/gap-justification`, but no
`.tsx` in the repository calls that route, so nothing renders it to a family today.
(2) *Is the underlying provenance problem already known?* Yes — `HANDOFF_RESEARCH.md`
§3 records that the triage board reads "a table populated **only** by staff manually
re-keying numbers during intake". What is new is that two screens put the word
"check-in" on it, which is the specific wording that tells a coach the child said this.

**Consequence.** A coach reading "3 RED check-in days in the last 7" believes the child
reported feeling bad three times. The child may have reported nothing; the number was
typed by staff.

---

## Checked and found sound

Recorded because a pass that reports only defects gives a false picture of the
codebase, and because two of these were candidate findings I killed.

- **The registry is honest.** No `unsupported` or `experimental_unsupported` entry has
  a live caller. `formulaEngine.test.ts:100-106` specifically pins LEGACY-READINESS's
  status, `humanReviewRequired` flag, and the word "unproven" in its reason. That test
  is why the registry has not drifted, and it is the right test to have written.
- **The platform refuses to define a sparring limit, and its own evidence supports the
  refusal.** `sparringExposure.ts:10-13` and the migration header at
  `pilot_slice_postgres_sparring_exposure_and_load_migration.sql:24-29` refuse a damage
  score, a risk index, a recommended limit and a clearance. The evidence registry backs
  this in its own words: *"PPBF must NOT derive a sparring head-impact threshold from
  this literature. Sparring exposure is captured for coach review only. TBD parameter."*
  A refusal, sourced. This is the standard the rest of the constants table should be
  held to.
- **`falseProgress.ts`'s asymmetric operators are not a defect (candidate finding,
  killed).** `:61` uses `controlledRate < CONTROLLED_STRONG_RATE` and `:68` uses
  `liveRate <= LIVE_WEAK_RATE`. Both boundaries resolve toward raising the
  `not_transferring` flag — exactly 0.7 counts as strong practice, exactly 0.3 counts
  as weak live — so the asymmetry is consistent, not accidental. The classifier also
  defaults to `insufficient_evidence` (`:59`, `:65`) rather than to a verdict, and the
  UI shows the raw counts with every flag (`coach/transfer-check/page.tsx:126-131`,
  "practice: N of M made · live: N of M made"), so a coach can disagree with the rule
  by looking at the same numbers. Retracted.
- **`pilotOpsReadiness.ts` is the right pattern.** `:22` imports
  `QUICK_ROUND_COMPLEXITY_THRESHOLD` and `HEAVY_BAG_COMPLEXITY_THRESHOLD` rather than
  restating them, with the comment "an ops-readiness report is a mirror, not a dial"
  (`:18`). This is precisely what `/operations` does not do with the readiness
  equation, and it shows the codebase already knows how.
- **`PAIN_REPORT_ALERT_WINDOW_DAYS` is surfaced, not restated.**
  `formulas/painReportAlert.ts:36-41` explains that callers "surface it to the coach
  rather than writing the number into copy that can drift away from it", and
  `app/api/pilot/coach/pain-reports/route.ts:40`, `:65`, `:72` do exactly that.
- **The pain-report path is genuinely wired end to end.** Athlete modal
  (`AthleteWorkspace.tsx:1414-1431`) → `POST /api/pilot/shadow/formulas/observations`
  → `alertCoachToPainReport` (`observations/route.ts:155`) → near miss + shadow event
  → `/api/pilot/coach/pain-reports`. The response tells the child whether a coach was
  actually flagged (`:1444-1446`), including the negative case. Of everything in this
  pass, this is the path that works the way the documentation says.
- **`isMinor` fails closed on unknown age.** `wallDisplay.ts:196-201`: a missing or
  unparseable dob returns `true`. `contracts.ts:40` and `privacyTiers.ts:159` both
  point at it as the canonical age gate.
- **The 1% Club majority rule is integer-safe and sourced.**
  `onePercentClub.ts:385`, `yesCount * 2 > eligibleCount` — a strict majority of
  everyone eligible, not of votes cast — matching the owner design quoted verbatim at
  `:9-10` and restated at `:301-302`. The UI states the same rule
  (`coach/one-percent-club/page.tsx:173-174`) and reports the raw tally rather than a
  percentage (`:145`).
- **`contactClearanceGate.ts` explains why it flags rather than refuses**
  (`:88-100`) and fails closed on a missing clearance record (`:135-137`). Its
  reasoning — that refusing the write "does not un-spar the athlete, it destroys the
  only record that it occurred" — is the clearest piece of safety reasoning in the
  formulas area.
- **`packages/` is dead and knows it.** `packages/execution/safetyGate.ts`'s
  `runSafetyGate` hardcodes a youth-contact refusal and has no callers;
  `packages/governance/featureFlags.ts:11` says so in a comment
  ("runSafetyGate, the only caller, is itself never invoked"). Self-documented, not a
  finding.
- **`/admin/macro-analytics` and `/admin/retro-lab` are fabricated prototypes** —
  `MacroCommandCenter.tsx:57-62` hardcodes a readiness distribution and `:126-129` a
  contact-lock "deload recommendation" — but the repository has already classified
  them, deliberately withheld a door, and written down why
  (`components/buildingMapCoverage.test.ts:52-53`). Cross-referenced for pass 7; not
  re-reported.

---

## Could not establish

Recorded as holes rather than guessed, per rule 2 of this pass's brief.

1. **Whether any MVP formula has ever actually run in production.** No UI calls
   `POST /api/pilot/shadow/formulas/results`, so every stored `FormulaResult` would
   have to come from a direct API call. Whether `pilot.shadow_formula_results` has any
   rows needs database access this session does not have. This bounds F-9-06 and F-9-07
   in either direction and is the single most useful question anyone with production
   access could answer for this pass.
2. **Where `1.25 / 0.45 / 0.3` came from.** `readinessMath.ts` has no module header, no
   citation, and no scale declaration for any of its three inputs; the registry says the
   coefficients are unproven; the evidence registry contains no row supporting them.
   `docs/HANDOFF_RESEARCH.md` §3 says "Assume invented until proven otherwise". I could
   not prove otherwise and did not try to supply a plausible source. **"No stated basis"
   is the answer.**
3. **What input scale LEGACY-READINESS's `sorenessLevel` and `disciplineScore` expect.**
   The tests exercise soreness at `0`–`10` (`readinessMath.test.ts:14`, `:22`, `:25`),
   while the athlete's own persisted self-report constrains soreness to `1`–`5`
   (`pilot_slice_postgres_athlete_check_ins_migration.sql:27`) and the workspace's
   discarded slider runs `0`–`10` (`AthleteWorkspace.tsx:1805`). No `discipline` input
   is collected anywhere in the platform. Which scale the coefficients were fitted to
   cannot be established from the repository.
4. **Whether `READINESS_GREEN_MIN = 7` / `YELLOW_MIN = 4` predate or postdate the
   evidence registry's `A6-063` instruction** to label such a threshold
   `PROPOSED PPBF PARAMETER - ASSUMPTION`. Establishing that needs the history of a file
   whose relevant commits predate this branch's window; I did not chase it, and the
   finding (the label is absent today) does not depend on the answer.
5. **Whether `docs/capabilities/READINESS_PROVENANCE_FACTS.md` — cited by
   `HANDOFF_RESEARCH.md` §3 as documenting the readiness situation "in full" — contains
   anything this pass duplicates.** It is on branch `fix/ct-readiness-provenance`, which
   is not among this session's remotes: `git show origin/docs/agent-handoff-briefs`
   resolves, that branch does not. **F-9-02, F-9-03 and F-9-04 have not been
   de-duplicated against it.** Anyone who can fetch that branch should check them
   before acting.

---

## De-duplication summary

Cited, not re-reported: the `<=` / `<` attendance operator split
(`NETWORK_STATUS.md`, `PASS-04`); `readinessMath.ts` having zero callers and the stored
score being taken raw from the request body (`PASS-04` F-08); the three-readiness-
pipeline problem and the `/operations` "certified" display (`HANDOFF_RESEARCH.md` §3);
the `HOLD_EXPIRY_DAYS` query's missing lower bound (`PASS-04`); the unnamed
pain-severity literals (`PASS-04`); LEGACY-READINESS being deliberately unwired
(`NETWORK_STATUS.md`, "Parked by owner decision"). `git log --oneline origin/main -40`
contains no commit touching `formulas/`, `readinessMath.ts`, `readinessBoard.ts`,
`AthleteWorkspace.tsx`'s check-in path, or `app/operations/page.tsx` after the pinned
commit.
