# pilot.readiness: what it actually is

Established 2026-08-16, by reading current source on `origin/main` before any
change was made. This document is the factual basis for the provenance
migration that accompanies it; it exists because three engine proposals
independently refused to consume this table and the reason deserved to be
written down rather than re-derived.

## The trigger

Modules 021 (Adaptation), 029 (Warm-Up/Prep) and 033 (Fatigue Decay), in
`docs/capabilities/proposals/engine-unlock/`, each independently recommended
EXCLUDING `pilot.readiness` as an engine input. None of them coordinated. The
shared reason: the table stores a bare `score numeric` and `category text`
with no formula, no provenance, and no validation columns, so a consumer
cannot audit the number it is being handed.

## What the table holds

`pilot.readiness`, defined identically in TWO places -- `pilot_slice_postgres.sql`
(base schema) and `pilot_slice_postgres_multiorg_migration.sql` -- so any
change must touch both or a rebuilt environment diverges from a migrated one:

| column | type | notes |
|---|---|---|
| `organization_id` | text not null | FK to organizations |
| `readiness_id` | uuid not null | |
| `athlete_id` | text not null | FK to athletes |
| `score` | numeric not null | **no scale, no formula, no bounds** |
| `category` | text not null | **no vocabulary constraint** |
| `measured_at` | timestamptz not null | |
| `created_at` | timestamptz not null | |

Nothing records what produced `score`, on what scale, or whether the producing
method was ever established.

## Who writes it

**Exactly one production write path**: `intake.ts#createReadiness`
(`apps/web/src/server/pilot/intake.ts:561`). It computes nothing. It inserts
whatever `score` and `category` its caller hands it.

Two callers, both staff-driven intake surfaces:

1. **`POST /api/pilot/intake/domain-upsert`** with `entity_type: 'readiness'`
   (`route.ts:118`). The score is `Number(body.payload.score || 0)` -- an
   arbitrary caller-supplied number, with a silent `0` default when the field
   is absent or unparseable. `0` is below every band threshold, so an omitted
   score becomes the most alarming possible reading rather than an absent one.
   The category is `asString(body.payload.category, 'general')`.

2. **`POST /api/pilot/intake/review-action`** promotion (`route.ts:435`),
   taking `promotion.readiness.{score,category,measured_at}` from a payload an
   administrator hand-types as JSON in `admin/shadow/page.tsx`.

No self-service athlete path writes here. `athleteCheckIns.ts` deliberately
writes its own table instead (see the false claims below).

## The formula that does not run

`readinessMath.ts#calculateReadinessL14(sleepHours, sorenessLevel, disciplineScore)`
computes `((sleep * 125) - (soreness * 45) + (discipline * 30)) / 100`, clamped
to 1-10.

Two facts about it:

- **The coefficients 125 / 45 / 30 carry no citation, no derivation, and no
  validation status anywhere in the repository.** Nothing states where they
  came from or whether the weighting was ever established for anyone, let
  alone for minors in boxing.
- **It is dead code.** Its only caller is its own unit test
  (`readinessMath.test.ts`). It never executes in production and it never
  writes to `pilot.readiness`.

## Two false claims currently in the source

Both should be read as evidence of how easily an unauditable number acquires
assumed authority -- these comments were written by people who believed the
table was formula-backed:

- `readinessBoard.ts:4-6` -- "the tested check-in formula whose scores land in
  `pilot.readiness`". **False.** The formula never runs; the scores are typed
  in by staff during intake.
- `athleteCheckIns.ts:8` -- "NOT `pilot.readiness` (formula scores; the
  readiness board reads that table unfiltered, so self-reports there would
  contaminate it)". **The parenthetical is false** -- they are not formula
  scores. The *decision* it justifies (keep self-reports in their own table)
  is still sound, and is not changed here.

## Who reads it, and what turns on it

Six consumers. Ranked by how much authority the number acquires:

1. **`interventionEvidence.ts:39`** -- `readiness` is an admissible
   `EvidenceSourceKind` for intervention outcome review. An unauditable number
   is currently admissible as evidence that an intervention on a child worked.
   This is the sharpest edge.
2. **`readinessBoard.ts` -> `/api/pilot/coach/readiness-board` -> `CoachWorkspace`**
   -- maps `score` to GREEN/YELLOW/RED at thresholds 7 and 4 and renders it as
   a status dot and badge on the coach floor. The workspace's own guidance
   tells coaches to "Use readiness color to adjust coaching intensity" and
   lists "Ignoring RED readiness plans during live coaching" as a mistake. The
   thresholds assume a 1-10 scale that nothing enforces at write time.
3. **`coachIntelligence.ts:69`** -- counts days whose latest reading fell below
   the YELLOW threshold and flags athletes exceeding a RED-day count.
4. **`performanceAnalytics.ts:126`** -- averages the score and splits it
   early-vs-late to report a trend direction.
5. **`passbook.ts:189`** -- lists readings on the athlete's own passbook.
6. **`/api/pilot/intake/domain-get`** -- returns raw rows to the intake review
   surface.

`privacyTiers.ts:292` already lists `pilot.readiness` among
`PUBLIC_SURFACE_FORBIDDEN_TABLES`, so none of this reaches a public surface.
That is the one protection already in place, and it is about disclosure, not
about trustworthiness.

## The contrast that makes this a defect

`pilot.assessment_protocols` carries `reliability_status`, `validity_status`
and `evidence_class`, defaulting to `'UNVALIDATED - PPBF MUST ESTABLISH'`,
`'UNKNOWN'` and `'INSUFFICIENT EVIDENCE'`. Its own table comment says: "this
platform does not fabricate measurement properties it has not established."

That honesty is precisely why an assessment result is usable -- a consumer
knows exactly how much weight it bears. `pilot.readiness` makes no such
statement, so a GREEN dot and a validated measurement are indistinguishable at
the point of use.

## Conclusion: repair, not deprecate

The task asked whether deprecation is the better answer, given three proposals
recommend exclusion. It is not, for three reasons:

1. **The consumers are real and partly protective.** The RED-day flag in
   `coachIntelligence` and the coach-floor board may be the only standing
   signal that a particular child keeps arriving in poor shape. Deleting the
   table removes that signal without replacing it.
2. **The proposals reject the number's UNAUDITABILITY, not the concept.** They
   say they cannot inherit a number they cannot audit. Provenance columns
   answer exactly that objection: an engine can then filter to rows whose
   method is known and validated, and exclude the rest -- which is what those
   proposals actually want to be able to express.
3. **Deprecation destroys the ability to distinguish.** Today every row is
   equally unauditable. After this change, a row written by a future validated
   method is distinguishable from one typed during intake in 2026. Removing
   the table forecloses that.

What this change does NOT do, deliberately:

- It does not invent a formula to justify existing scores. Existing rows
  record `UNKNOWN`, because that is the true answer.
- It does not compute a new readiness score. `calculateReadinessL14` stays
  dead code; wiring it would require establishing its coefficients first,
  which is a research decision and an owner decision, not a migration.
- It does not touch the engines. They remain unbuilt proposals; this is the
  thing that unblocks them.
