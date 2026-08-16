# Engine Unlock Proposal — Module 036 Periodization / Block Planning Engine

## Status

PROPOSAL — awaiting owner approval. No code.

The module stub (`docs/capabilities/modules/036-periodization-block-planning-engine.md`) currently says: Status `DRAFT`, Active `false`, Promotion required `true`, Category `physicalTrainingSystem`. Intent is the unfilled placeholder `_One paragraph: what this module owns and what it must never do._`; Dependencies (Upstream/Downstream/Related) are blank; all five Acceptance-criteria boxes are unchecked; Implementation notes says only "Scaffold only. Do not mark active until promotion review." The only substantive content is the inherited scaffold Boundaries block (no auto-approval, no non-suppressed board exposure, no invented metrics) and the 2026-08-03 scaffold-script audit-log entry. Nothing in the stub, and no code anywhere in the repo, currently gives a training block or period any identity.

## (a) What the engine computes and shows

**What "Periodization / Block Planning Engine" conventionally implies, and what this proposal refuses to build:** an engine that generates a periodization plan — computed mesocycle/microcycle lengths, a taper percentage, a volume-ramp curve, or a template borrowed from adult/published training theory and applied to a minor. No such constant is boxing-validated for this population, and per the RESEARCH_FIRST rule a constant does not become valid because a paper exists. This engine will **not** author, suggest, auto-generate, or auto-progress a periodization plan. It will not compute a block length, a taper duration or percentage, a volume-ramp rate, or any adherence score/percentage for a block as a whole.

**What an honest alternative looks like instead:** a **coach-authored container plus a planned-vs-actual read view.** A human coach names a block, gives it a date range and a phase label in their own words, and — inside that window — schedules already-existing coaching content (`pilot.workout_templates`, `pilot.scheduler_classes`). The platform's only computation is comparing what was scheduled to what real rows already exist showing it happened. No number here is derived by the model; every date, label, and template choice is the coach's own decision, stored opaquely.

Concrete outputs, each naming the real source:

- **The plan itself (coach-authored, requires new minimal schema — see (e)(1)):** block name, human-chosen `phase_label` (free text, e.g. "pre-comp sharpening" — never a computed or enumerated phase; the closest existing precedent is `pilot.session_scripts.phase`, itself free text with no enforced vocabulary, and this proposal follows that precedent rather than inventing a phase taxonomy), `start_date`/`end_date` chosen by the coach, an optional free-text goal note. Within the window, the coach schedules existing `pilot.workout_templates` (`.name`, `.session_type`, `.difficulty`, `.duration_minutes`) and/or existing `pilot.scheduler_classes` (`.start_at`, `.end_at`, `.coach_account_id`) rows — content that already exists and is already versioned/constrained by its own migrations.
- **Planned vs actual, for one athlete, inside the block window:**
  - Planned session count (from the block's scheduled templates/classes) vs actually-delivered count from `pilot.session_script_runs.delivered_on` (joined to `script_id`) and/or `pilot.activity_log.occurred_on` where `activity_domain = 'boxing_training'`, `.duration_minutes` — shown as two counts side by side, never collapsed into a percentage.
  - Planned attendance vs actual, from `pilot.scheduler_registrations.status` and `pilot.scheduler_attendance.status`/`.checked_in_at`, or `pilot.activity_log.attendance_status`, restricted to rows whose date falls in `[start_date, end_date]`.
  - Recorded outcomes inside the window: `pilot.training_attempts.metric_kind`, `.target_value`, `.achieved_value`, `.made`, `.attempted_at` — plotted as raw make/fail points restricted to the block's dates, never averaged into a block score.
  - Context that explains gaps: `pilot.training_holds.status`, `.scope`, `.placed_at`, `.lifted_at` overlaid on the same window, exactly as module 021 already does, so a gap in delivered sessions during an active hold reads as "training was paused," not as non-adherence.
  - If the block is linked to an existing hypothesis (see Boundary paragraph below), the linked `pilot.intervention_protocols`/`intervention_executions`/`intervention_outcome_reviews` rows are shown read-only, unedited, exactly as module 026 already records them.

What it explicitly does **not** compute: block length, taper duration or percentage, volume-ramp rate, any single adherence/compliance score for a block, an auto-generated next block, an AI-suggested progression, or any ranking/comparison of one block or one athlete against another.

**Boundary against module 026.** Module 026 already owns the versioned-intent → planned-vs-actual → typed-evidence → human-reviewed-outcome loop for one hypothesis-driven intervention (`pilot.intervention_protocols`/`intervention_executions`/`intervention_evidence_links`/`intervention_outcome_reviews`). Module 036 must not become a second, calendar-shaped copy of that loop. Its scope is narrower and different in kind: it is the coach's **session-delivery calendar** — which already-existing templates/classes are intended on which dates, under a human-chosen label, and whether those specific sessions actually happened — never a hypothesis, never a structured `intended_exposure` dimension, never an `adherence` vocabulary state, never a three-answer outcome review. Where a block exists specifically to test something (e.g., "this 4-week block is testing whether more live rounds improves X"), that hypothesis belongs in `pilot.intervention_protocols`, and a block should carry, at most, a nullable reference to that protocol — never re-authored hypothesis/exposure/review fields of its own. If real usage shows every block is really one intervention, that convergence is a schema decision to fold 036 into 026, not a reason to grow a parallel ledger here.

## (b) Data prerequisites

Because the coach-authored plan is new schema (see (e)(1)), these thresholds gate not "whether a block can be created" (that is a coach action, ungated by data volume) but **whether the platform shows a planned-vs-actual comparison as if it were a meaningful signal** rather than a single anecdote — the same distinction module 021 already draws.

### Per athlete

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| Delivered sessions inside the block's stated window | `pilot.session_script_runs.delivered_on` and/or `pilot.activity_log.occurred_on` (`activity_domain = 'boxing_training'`) for that athlete | ≥ 2 occurrences on 2 distinct dates | must fall within `[start_date, end_date]` of the block | Two points are the mathematical floor before "planned vs actual" is a comparison rather than one data point next to a plan. **OWNER_DECISION**: whether 2 is the right floor, or module 020/021's higher pattern should apply here too (see (e)(3)). |
| Recorded outcome inside the window on at least one metric | `pilot.training_attempts.metric_kind`, `.attempted_at`, `.made` | ≥ 2 attempts sharing one `metric_kind`, on 2 distinct `attempted_at` dates | within the same block window | Same reasoning as module 021: a single attempt has no before/after, and same `metric_kind` is required because different metrics (`reps` vs `time_seconds`) cannot share an axis. |

### Per organization

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| Count of athletes each meeting their own per-athlete floor above | derived count of athletes meeting both per-athlete rows, scoped by `organization_id` | ≥ N athletes | any | The only honest org-level number is "how many athletes currently have enough of their own recorded history to view their own block comparison" — an operational count, never an aggregated outcome. **OWNER_DECISION**: the value of N (small-cell suppression floor); no numeric floor yet exists in modules 147/148 to reuse (same open question module 021 raised). |
| Blocks with any real delivered-session evidence at all | count of blocks (once the schema in (e)(1) exists) with ≥ 1 matching `session_script_runs`/`activity_log` row inside their window, scoped by `organization_id` | ≥ 1 per counted block | any | An operational process-completeness fact ("has anyone actually delivered anything against this plan yet"), not a modeled outcome — requires no invented denominator. |

**Doctrine constants, all marked OWNER_DECISION, none picked here:** block length (no default, no minimum/maximum — the coach's `start_date`/`end_date` choice is opaque to this engine), taper duration or percentage (does not exist as a field or a computation), volume-ramp rate (does not exist), the per-athlete minimum-record floor (2, shown above, is a proposed floor pending owner sign-off, not a shipped constant), the per-org small-cell floor N.

## (c) LOCKED state

**Before a coach has authored any block for an athlete at all**, the athlete and their own coach see a plain state, not a countdown — there is nothing to progress toward until a human coach makes the first authoring decision: "No training block is currently defined for you." No action prompt is directed at the athlete here, because authoring a block is a coach action, not something an athlete's own logging can trigger into existence.

**Once a block exists but its per-athlete data prerequisites in (b) are not yet met**, the athlete and their coach see, on the athlete's own record only:

- "Sessions recorded in this block: **1 of 2** required, between [start_date] and [end_date]" (a real count of matching `session_script_runs`/`activity_log` rows) — action: "Log your next session in this window to complete this count."
- "Outcomes recorded on [metric_kind] in this block: **1 of 2** required, on **1 of 2** required distinct dates" — action: "Log an attempt with a target the next time this metric is trained during this block."

No percentage of an invented denominator, no XP, no points, no levels, no badge, no streak. The two counters are shown independently — meeting one does not imply progress on the other, and copy never blends them into a single "block readiness" figure.

At org level, before the org threshold (N athletes) is met: "**[k] of N** athletes have enough of their own recorded history in an active block to view their own comparison" — a real count over a real, owner-set N.

Engagement doctrine observed: the counters exist so an athlete or coach can watch their own record accumulate against a plan they (or their coach) chose — pride in one's own record — never a reward, streak bonus, or comparison to any other athlete's or block's count.

## (d) What unlocks

### At athlete level (own record only)

Once the per-athlete prerequisites in (b) are met, the athlete (and their coach, under the existing coach-confirmation gating) can view, for that one block:

- The block's own name, phase label, and date range, exactly as the coach entered them.
- The planned template/class list for that window next to the actually-delivered dates (`session_script_runs`/`activity_log`).
- Planned attendance vs actual attendance (`scheduler_registrations`/`scheduler_attendance`/`activity_log.attendance_status`) for that window.
- Recorded attempts (`training_attempts`) inside the window, as raw make/fail points — never smoothed, scored, or trended.
- `training_holds` periods overlaid as shaded gaps, so a pause reads as a pause.
- If the block links to an existing `pilot.intervention_protocols` row, that protocol's already-recorded executions/reviews (026), shown read-only and unedited by this engine.

Nothing here is ranked, scored, or compared to any other athlete's block, any population, or any cohort, at any data volume. It is a richer view of the athlete's own recorded history against a plan a human already chose for them.

### At org / coach level

Once the org threshold (N athletes, per (b)) is met, coaches see the same planned-vs-actual detail for each athlete they coach directly (through that athlete's own record, under existing access rules — never a new cross-athlete list view). Org admins see only:

- "**k of N** athletes have enough recorded history in an active block to view their own comparison" — never which athletes, never any individual chart from this org-level surface.
- "Blocks with at least one delivered session recorded: **x of y**" as an operational process metric, never an outcome metric.

Board and public surfaces receive nothing beyond, at most, that same small-cell-suppressed count — never an individual athlete's block, calendar, or outcome detail, per the playbook rule that board/public never see individual athlete clinical or performance detail.

### What stays locked forever, regardless of data volume

**Any model-generated or model-suggested periodization plan for a minor stays locked permanently, at any data volume, under this proposal.** More rows of `session_script_runs`, `activity_log`, or `training_attempts` — even years of them — never substitute for a qualified human choosing block length, phase sequencing, taper timing, or progression. Those remain OWNER_DECISION / coach-authored inputs forever, never engine outputs. Likewise locked forever: any cross-athlete or cross-block comparison, ranking, or leaderboard of adherence, delivery rate, or outcome; any single adherence/compliance percentage collapsing a block's planned-vs-actual detail into one number; and any auto-progression from one block to the next without a fresh, human, block-by-block authoring decision.

## (e) Open questions for the owner

1. **Does this need a new minimal schema, and what shape?** Nothing in the current schema gives a block/period identity — the closest existing things are `pilot.session_scripts.phase` (a single script's own phase label, not a date-ranged container) and `pilot.scheduler_classes` (a real calendar with no phase/block concept at all).
   - Option A — two new tables: a `training_blocks` header (org, block_id, athlete_id or org-wide, name, phase_label, start_date, end_date, goal note, created_by) plus a `training_block_sessions` join table linking the block to existing `workout_templates`/`scheduler_classes` rows. Cleanest separation, most new surface.
   - Option B — one new header table only (as above) plus a single nullable `block_id` column added to `pilot.scheduler_classes`, reusing the real calendar directly instead of a separate join table. Fewer new objects, follows playbook rule 3 (prefer reuse).
   - Option C — no linking to specific templates/classes at all yet; a block is just a name/date-range/note, and planned-vs-actual is computed purely from date-range overlap against `activity_log`/`training_attempts`, with no explicit "this specific session was planned" claim. Simplest, but "planned" becomes weak — nothing is actually pre-declared.
   - **Recommendation:** Option B — reuses the real, already-constrained calendar table rather than duplicating it, keeping new schema to one header table and one column.

2. **Should a block ever carry hypothesis-shaped fields of its own, or always defer entirely to module 026?**
   - Option A — never: a block gets only a nullable reference to an existing `intervention_protocols` row when a hypothesis exists; no hypothesis/exposure/evidence fields of its own, ever.
   - Option B — allow one plain-language "block goal" free-text note, explicitly informal and never evaluated, kept strictly separate from any hypothesis vocabulary.
   - Option C — require any block whose purpose is diagnostic to link to a real 026 protocol before it can be authored.
   - **Recommendation:** A combined with B — no hypothesis-shaped fields ever appear in 036's schema, but a plain goal note is allowed for ordinary coaching language; real hypothesis testing must go through 026 by reference.

3. **Per-athlete and per-org minimum-record floors** — is 2 sessions / 2 attempts (2 distinct dates) / N athletes the right floor, independent of module 021's still-open version of the same question?
   - Option A — reuse whatever numeric floor 021 (and 020) ultimately adopt, once the owner decides there, for platform-wide consistency.
   - Option B — set 036's floors independently, since a block's bounded date window is a different data shape than 021's open-ended history.
   - Option C — make the floor configurable per organization.
   - **Recommendation:** Option A, but note this genuinely can't be finalized until the owner resolves the same open question already pending in the 021 proposal — sequence behind it rather than deciding it twice.

4. **Should a block's end date be allowed to reference `pilot.external_competitions.competition_date`** (the one real column in that deliberately-skeletal table), so a plan can honestly target a real meet date?
   - Option A — allow a nullable `competition_id` FK, reading only `competition_date`, touching nothing else in that skeleton.
   - Option B — disallow any reference to `external_competitions` from 036 until that module itself is built out, keeping the two fully decoupled.
   - Option C — allow only a free-text target note (e.g., "building toward: County Championships, 3/14"), with no FK at all.
   - **Recommendation:** Option C — gets the real coaching value (a plan anchored to a real date) without creating a structural dependency on a table the owner has already said is deliberately incomplete and not to be built on as if it were finished.
