# Engine-Unlock Proposal — Module 023: Regression Library

Status: PROPOSAL for owner approval. No code changes are included in or
implied by this document.

Stub reviewed: `docs/capabilities/modules/023-regression-library.md`
(Category: Physical Training System; Status DRAFT; Parent original-25
unmapped).

## Zeroth finding: this is a content library, not an engine, and its content
## table does not exist yet

A repo-wide search (`infra/azure/*.sql`, `apps/web/src`) for
`regression_library`, `regression_pathway`, `regression_content`,
`easier_variant`, `regress_to` returns **nothing**. There is no table, no
migration, no API route, no UI surface for module 023 anywhere in the
codebase today. This is not a promotion-pending engine sitting on real data
— it is an empty shelf.

The clearest description of what #23 is supposed to hold comes from a
neighboring migration, `pilot_slice_postgres_training_holds_migration.sql`
(capability #82, Stop/Hold/Regress), which draws the boundary explicitly:

> "REGRESS — scope 'contact_only' or 'conditioning_only': training
> CONTINUES at reduced scope. This is deliberately NOT a demotion of the
> athlete... What regresses is the PERMITTED INTENSITY, never the
> athlete's standing. Skill-content regression belongs to capabilities
> #23/#62."

So #82 owns *whether* an athlete's training is currently scope-restricted
(a safety/administrative state). #23 (this module, physical training) and
#62 Skill Regression Engine (learning/skill acquisition, also stubbed,
also empty) are supposed to own the *content* of what a restricted or
struggling athlete does instead — the documented easier alternative for a
given exercise, drill, or physical test, and the criteria for moving back
up. That content does not exist in this repository in any form.

The closest built analogue is `pilot.drill_library` /
`pilot.drill_scale_levels` (drill library v3), which encodes an A/B/C
*within-drill demand* axis ("same lesson, less/more stress") — explicitly
**not** the same axis as a regression to a *different, easier* drill or
exercise. That migration's own comment draws this line: difficulty is "a
property of the drill, fixed at authoring, mapping to the skill graph";
scale_level is "how much demand is applied within the drill right now."
Neither is a cross-drill regression pathway. Module 23 would be a new
axis, not a restatement of an existing one.

**Conclusion carried through the rest of this document:** module 23 is,
by its own governing comment, a content-authoring problem before it is a
data problem. The honest first prerequisite is that someone (which role,
see Open Questions) writes the regression content down. No amount of
`training_attempts` volume substitutes for that. What follows treats the
module as: (1) a content library that must be authored, and (2) once
authored, a strictly read-only lens that maps an athlete's own real
recorded failures onto that authored content — never a scoring or
recommendation engine.

## (a) What it computes / shows

**Nothing is computed.** This module has no formula, no scalar, no
severity score, and no "readiness to regress" number. Doctrine (per
`intervention_protocols`'s own comment: "STRUCTURED EXPOSURE, NEVER A DOSE
SCALAR... forcing these onto one number would be an invented metric, which
this platform refuses") applies here without modification: a regression
recommendation is either an authored piece of coaching content that exists
in the library, or it does not exist, and the platform must say so plainly
rather than guess.

What the module shows, once built, is two honest things layered together:

1. **Authored content, verbatim.** For a given drill/exercise/physical
   test, the documented easier alternative(s), written by a human, with
   the reasoning for why it is the regression (mirroring the
   `target_behavior` discipline already established in `drill_library`:
   a regression is only valid if the same lesson/quality survives at
   lower demand — that judgment is a human's, recorded, not derived).
2. **The athlete's own real attempt history**, drawn only from rows that
   already exist: `pilot.training_attempts` where `made = false` for the
   relevant `metric_kind`/`context_id`, optionally cross-referenced against
   `pilot.intervention_executions` / `pilot.intervention_evidence_links`
   (`source_kind = 'training_attempt'`) if a formal intervention protocol
   is already tracking that problem, and against `pilot.training_holds`
   where `scope in ('contact_only','conditioning_only')` if the athlete is
   currently under a regress-scope hold.

Where content has not been authored for a given drill/test, or where an
athlete has no qualifying failed attempts, the screen must show an
explicit **UNKNOWN / NOT YET AUTHORED** state — never a blank chart, never
a zero standing in for "no data," and never a default recommendation
invented to fill the gap.

No cross-athlete comparison, ranking, or aggregate ever appears on an
athlete-facing or coach-facing per-athlete view. Org-level views (below)
are about **content coverage**, never about ranking athletes against each
other.

## (b) Data prerequisites

Two independent prerequisite tracks — content and data — both required,
neither substitutes for the other.

### Track 1: Content-authoring prerequisites (the actual blocker)

- A new table (name TBD by the owner/build team — not proposed here as a
  design decision, only as a checkable requirement) must exist to hold
  authored regression pathways: source drill/exercise/test identifier,
  target (easier) drill/exercise/test identifier, the authoring human's
  account, the stated reasoning (why this is a valid regression — same
  lesson at lower demand), and — following the precedent already set by
  `pilot.drill_scale_levels.authoring_state` — an explicit authoring-state
  vocabulary (e.g. `authored` vs `literature_grounded_draft` vs
  `scaffold_needs_coach_review`) so a coach-validated pathway is never
  confused with an unvalidated one.
- **Per org, checkable count:** at least N regression pathways authored
  and in `authored` (coach-validated) state, covering at least M distinct
  entries from whatever drill/exercise catalog the org uses
  (`pilot.drill_library` and/or `pilot.drills`). Concrete N/M are an owner
  call (Open Question 2), not something this proposal invents.
- **Per org, checkable identity:** at least one named human account
  (`created_by_account_id`/`recorded_by_account_id`-equivalent) attached
  to every authored row — an unauthored, unattributed regression is not
  content, it is a guess with a table around it.

### Track 2: Real-event prerequisites (gate the athlete-facing lens once content exists)

- **Per athlete:** at least one row in `pilot.training_attempts` with
  `made = false` and a non-null `target_value` (a real, verdict-bearing
  failed attempt — not an open/no-target measurement, which the schema's
  own check constraint (`pilot_training_attempts_made_check`) forbids from
  carrying a verdict at all) on a `metric_kind` for which Track 1 content
  exists.
- **Per athlete, timespan:** failed attempts must span more than a single
  `attempted_at` day — one bad rep on one day is an event, not a pattern;
  the honest minimum is repeated failure over time, checkable directly
  against `idx_training_attempts_athlete_metric` (already indexed on
  `organization_id, athlete_id, metric_kind, attempted_at desc`).
- **Per org:** at least one athlete meeting the per-athlete bar above,
  so an org-level coverage view has something real to report rather than
  an empty statement dressed as a metric.
- If the athlete's regression is tied to a formal intervention (not just
  an informal drill fallback), the read may also draw on
  `pilot.intervention_executions` (`adherence`, `trained_context`) and
  `pilot.intervention_outcome_reviews` (`performance_result`,
  `learning_signal`) — but a module-23 regression library entry must never
  require an intervention protocol to exist; most day-to-day regressions
  (harder push-up variant failed, fall back to knee push-up) are ordinary
  coaching, not a tracked hypothesis test.

### What is explicitly NOT a prerequisite

- `pilot.readiness` and `pilot.assessments` are cited in the task brief as
  tables to check; they exist (`pilot_slice_postgres.sql:301`,
  `:313`, duplicated verbatim in the multiorg migration) but carry no
  columns relevant to *content* regression — `readiness.score`/`category`
  is a wellness measure, `assessments.result` is a jsonb blob tied to
  `assessment_protocols`, neither encodes "easier version of this drill."
  They may serve as **evidence links** (`intervention_evidence_links`
  already lists `'readiness'` and `'assessment'` as valid `source_kind`
  values) if a formal intervention is in play, but they are not a
  prerequisite for the library itself.
- `pilot.activity_log` is likewise not a prerequisite; it records
  attendance/hours across activity domains, not attempt-level make/miss
  data.

## (c) Locked state

Because Track 1 has zero rows in every environment today, **the module is
locked everywhere, for every org, unconditionally**, until content
authoring begins. The locked screen must say exactly that — not "coming
soon," not a progress bar implying imminent completion, but the plain
fact: *"No regression content has been authored yet. This library will
show documented easier-alternative options for drills and physical tests
once staff have written them; today there are 0."*

Where Track 2 data already exists (real failed `training_attempts` rows
likely already exist in every active pilot org), the locked state may
honestly show, per athlete, staff-facing only (never athlete-facing
comparison-shaped): "N failed attempts recorded on [metric], most recent
[date] — no documented regression option exists for this yet." This is
real, derived-from-real-rows information, not a fabricated readiness
score, and it doubles as the honest case for why authoring matters.

At org level, the locked state is a flat content-coverage fact: "0 of
[catalog size] drills/tests in the library have an authored regression
pathway." No suppression math is needed while the count is zero; once
authoring begins, standard per-athlete small-N suppression rules used
elsewhere in this platform (e.g. board/aggregate views) should apply
before any org-level number derived from athlete-level rows is shown
outside staff roles — but that only becomes a live concern once Track 2
content is non-trivial.

## (d) What unlocks

**Athlete level** (richer view of the athlete's OWN record only —
comparison and leaderboards remain forbidden regardless of unlock state):

- The athlete's own failed-attempt history on a metric, paired with the
  authored regression option(s) for that metric, in plain language: what
  the easier version is, why it exists, who authored/validated it.
- If a formal intervention protocol/execution already covers that
  problem, a link to it (never a duplicate parallel "regression status").
- Explicit, per-metric UNKNOWN state wherever content is missing — the
  unlock does not mean every metric suddenly has an answer; it means the
  answers that exist are now shown instead of suppressed wholesale.
- No numeric "regression readiness score," no streak, no badge, no
  automatic reassignment — a human coach still decides whether/when to
  actually apply a regression in a session; this module only shows them
  what has been documented.

**Org level:**

- Content-coverage reporting only: how many drills/tests have authored
  regressions, in what authoring state, authored by whom, last updated
  when. This is a library-management view for staff, not a performance
  dashboard.
- Aggregate counts of "athletes with at least one unresolved
  documented-regression gap" are permissible only behind the same
  small-N suppression discipline the platform already applies to other
  board/aggregate surfaces — never a ranked list of which athletes are
  struggling most.
- Under no circumstances does org-level unlock produce a cross-athlete
  comparison, a leaderboard, or a ranked "most regressions" list — this is
  a hard wall per the task brief, not a design preference.

## (e) Open questions for the owner

1. **Who authors regression content, and does it need coach validation
   before an athlete ever sees it?** `pilot.drill_scale_levels` already
   distinguishes `authored` (coach-validated) from
   `literature_grounded_draft` (generated from cited research, not yet
   floor-validated). Options: (i) coaches only, `authored` required before
   any athlete-facing display; (ii) allow `literature_grounded_draft` rows
   to display to coaches only, never to athletes, until promoted; (iii)
   allow a research/content team to seed drafts platform-wide (like the
   drill vocabulary widening migration's 228 literature-grounded scale
   rows) with per-org coach review before activation; (iv) require
   organization_admin sign-off in addition to the authoring coach for any
   row that reaches an athlete's own screen.

2. **What are the concrete unlock thresholds (N pathways, M catalog
   coverage, per-athlete failure-count and timespan)?** This proposal
   intentionally does not invent numbers — that would be exactly the kind
   of invented metric the platform's doctrine forbids. Options: (i) tie
   the threshold to a fixed count (e.g. "10 authored pathways covering at
   least 25% of the org's active drill catalog"); (ii) tie it to a
   qualitative milestone instead ("owner/program-director sign-off that a
   first content pass is complete") rather than any number at all; (iii)
   no org-wide gate — unlock per-drill, independently, the moment that one
   drill has an authored pathway, so partial authoring is usable
   immediately rather than waiting for a global threshold.

3. **Does #23 (physical) share one table/schema with #62 (skill)
   Skill Regression Engine, or are they deliberately separate?** Both
   stubs are currently empty scaffolds with no dependencies filled in.
   Options: (i) one `pilot.regression_library` table with a
   `regression_domain` discriminator (`physical` / `skill`), mirroring how
   `pilot.activity_log` unified domains rather than forking tables; (ii)
   two separate tables coordinated only by a shared row-shape convention,
   since physical exercise regressions (push-up variant) and skill/technique
   regressions (simplify a boxing combination) may need different source
   references (`drill_library` row vs. skill-graph node); (iii) fold this
   into `drill_library`/`drill_scale_levels` as a new column rather than a
   new table, if the owner considers cross-drill regression close enough
   to the existing within-drill A/B/C axis to live beside it.

4. **Should the library ever auto-surface a regression suggestion when
   `training_attempts` shows a failure pattern, or must a coach always
   look it up deliberately?** The platform's stated boundary on this
   module family ("does not auto-approve progression... decisions") and
   the `training_holds` migration's insistence that regress-scope changes
   are human-placed cut toward requiring a human lookup, not a push
   notification or an automatic banner. Options: (i) library is
   query-only, a coach must open it and search — no proactive surfacing
   anywhere; (ii) a coach-facing (never athlete-facing) passive flag
   appears next to a drill/metric in the coach's existing workspace views
   once N consecutive misses are logged, linking to the library entry if
   one exists, with no action taken automatically; (iii) tie surfacing
   only to an already-open `intervention_protocols`/`training_holds` record
   for that athlete, so it never appears outside a context a human already
   opened for another reason.
