# Engine Unlock Proposal — Module 029 Warm-Up / Prep Engine

## Status

PROPOSAL — awaiting owner approval. No code in this proposal.

The module stub (`docs/capabilities/modules/029-warm-up-prep-engine.md`) currently says nothing: Status DRAFT, Active false, and every section (Intent, Boundaries beyond the three generic ones, Dependencies, Acceptance criteria) is the unfilled scaffold template from the 2026-08-03 stub-creation script; the only audit-log entry is that same scaffold note.

## (a) What the engine computes and shows

**This module computes almost nothing.** Like module 023 (Regression Library), "Warm-Up / Prep" names coaching *content* — what to do before training and how to prepare the body for contact or maximal effort — not a formula over accumulated athlete records. That split is stated up front because it governs everything below.

**What is authored content** (must be written by a human, or by an AI draft explicitly labeled unvalidated — never generated at read time):

- `pilot.drill_library` rows with `category in ('warmup', 'mobility')` — currently 5 seeded rows: *General Movement Warm-Up*, *Shoulder Preparation*, *Hip and Ankle Preparation*, *Neck Preparation* (`category='warmup'`), and *Thoracic Rotation* (`category='mobility'`), plus 2 `category='cooldown'` rows (*Cool-Down Walk and Breathe*, *Post-Session Mobility*) as the session's bookend. Each carries `purpose`, `standard_setup`, `execution`, `what_good_looks_like`, `what_bad_looks_like`, `contact_level='none'`, and a `field_provenance` tag — 3 of the 5 warm-up/mobility rows are `'LITERATURE-GROUNDED DRAFT — ... REQUIRES FLOOR VALIDATION'`, one is `'COACHING-CRAFT DRAFT — ... REQUIRES FLOOR VALIDATION'`; none is yet the validated `'PPBF source manual v3'` state.
- `pilot.drill_cues` rows keyed to those `drill_id`s (`cue_text`, `cue_family`, `focus_type`) — the coaching language for delivering the warm-up.
- `pilot.drill_scale_levels` rows (A/B/C) for those drills — authored demand descriptions, not computed.
- `pilot.drill_stop_rules` where `rule_kind='warmup_decay'` — 63 seeded rows, attached to **contact and maximal-effort drills** (not to the warm-up drills themselves). This vocabulary value exists specifically because "in elite boxers a standardized warm-up produced a 4.8% CMJ increase and a 25-minute inactive gap erased it" (PMID 27191695, per `pilot_slice_postgres_drill_vocabulary_widening_migration.sql`). It is authored caution text with a citation, not a live timer.
- `pilot.workout_templates` / `pilot.workout_template_items` where `block='warmup'` — a coach-authored, gym-wide sequencing of specific warm-up drills into a session template (per that migration's own doctrine: "no athlete identifier, no completion state, no effectiveness score").
- `pilot.session_scripts` / `pilot.session_script_blocks` — the minute-by-minute delivery layer. Note: `block_kind`'s current vocabulary (`arrival, instruction, demonstration, drill_round, reset_minute, teaching_minute, transition, conditioning, reflection, close`) has **no explicit `warmup` value**. A warm-up in a script today is only implicit — early blocks whose `drill_id` happens to reference a `drill_library` row with `category='warmup'`. Flagged as a real gap, not assumed away.

**What is genuinely data-driven** (small, and all reused from existing modules, none new):

- `pilot.readiness` (`score`, `category`, `measured_at`) — the athlete's most recent *fresh* reading (reusing module 169's own 24-hour freshness rule and GREEN/YELLOW/RED bands from `readinessBoard.ts`) can be displayed **next to** whatever warm-up a coach is about to run, as a fact ("last reading: RED, 3h ago"), never as an input to an algorithm that picks or lengthens the warm-up.
- `pilot.training_holds` (`getActiveTrainingHold` / `findRegistrationBlockingHold`, already built) — an active hold with `scope in ('all_training','contact_only')` must suppress any warm-up content that leads into contact/maximal-effort work for that athlete. This is real, existing, reused gating — not new computation.
- `pilot.session_script_runs` + the `session_run_state` columns (`run_state`, `started_at`, `current_block_id`) — whether a warm-up block in a **live** run has actually been reached, and `blocks_completed` on a settled run — a completion fact, not a benefit score.

**What it does NOT do:**

- Does not compute a "readiness-adjusted warm-up." No formula converts a `pilot.readiness.score` into a chosen warm-up length, intensity, or drill selection. Any such adjustment is a human coach's in-person call, gated by the existing `requires_coach_authorization` flag already present on both `pilot.drill_library` and `pilot.workout_templates` — never automatic, never AI-selected.
- Cannot reconstruct the *actual* elapsed gap between a completed warm-up and the start of contact work for a **past** session. `session_script_runs`/`session_run_state` store only an aggregate `started_at`/`paused_seconds` and the *current* cursor of a live run — there is no per-block start/end timestamp log. So the `warmup_decay` 25-minute threshold can, at best, be checked **live** (comparing "now" against when the room's cursor entered the warm-up block) but cannot be verified retrospectively from any column that exists today. This is a genuine schema gap (open question 1), not a threshold to wait out.
- Does not invent warm-up content. Every drill/cue/stop-rule shown is an already-authored row (several explicitly marked "REQUIRES FLOOR VALIDATION" via `field_provenance`) — never fabricated by a model at render time.
- Does not compare, rank, or aggregate warm-up completion or readiness across the roster. Single-athlete view only, or an org-wide content browse with no athlete names attached.
- Does not auto-approve or auto-assign a warm-up to a named athlete. `requires_coach_authorization` is read and enforced, never bypassed.

## (b) Data prerequisites

**PER ORG — content prerequisite (the real gate)**

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| Authored warm-up/mobility content exists | `pilot.drill_library.category in ('warmup','mobility')` AND `active=true` | ≥ 1 | N/A — content state | An engine with zero warm-up-categorized drills has nothing to select from. Currently satisfied in seed data (5 rows: 4 `warmup` + 1 `mobility`, plus 2 `cooldown`). |
| Those drills carry delivery cues | `pilot.drill_cues.drill_id` matching a warmup/mobility drill | ≥ 1 per drill shown | N/A | Purpose text without a cue is half the authored content the schema already provides for delivery; showing one without the other is an incomplete read, not a data gap. |
| Contact/maximal-effort drills carry the decay caution | `pilot.drill_stop_rules.rule_kind='warmup_decay'` linked to the specific contact drill about to be run | ≥ 1 per contact drill shown alongside its own warm-up | N/A | Content prerequisite for showing the decay-gap warning at all (63 of these exist today, one per qualifying contact/maximal-effort drill). OWNER_DECISION: whether a contact drill with **no** authored `warmup_decay` rule simply shows no caution (honest absence) or blocks the drill from this surface entirely — recommend the former; absence of a caution is not the same claim as "no gap risk exists." |
| Content has cleared floor validation | `pilot.drill_library.field_provenance = 'PPBF source manual v3'` (vs. either DRAFT string) | OWNER_DECISION — see (c) | N/A | 4 of 5 current warmup/mobility rows are still DRAFT and explicitly marked "REQUIRES FLOOR VALIDATION." Showing them as settled coaching doctrine rather than labeled drafts is the exact overclaim the honesty doctrine forbids. |

**PER ATHLETE — data prerequisite**

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| A fresh readiness reading exists (display-only, never a gate) | `pilot.readiness.score`, `.category`, `.measured_at` | ≥ 1 row within the last 24h (module 169's own freshness window, `READINESS_FRESHNESS_HOURS`) | rolling 24h | Reused verbatim from `readinessBoard.ts`'s own doctrine: "a GREEN from three days ago shown as today's state is false reassurance." Older readings are simply absent, never defaulted. |
| No active training hold blocks the relevant scope | `pilot.training_holds` where `organization_id`/`athlete_id` matches and `status='active'` | 0 matching rows (absence is the pass state) for `scope in ('all_training','contact_only')` before showing a warm-up that leads into contact work | evaluated live, not accumulated | Reuses `getActiveTrainingHold`/`findRegistrationBlockingHold` exactly as `pilot.training_holds` already enforces elsewhere; a warm-up engine that ignored an active hold would violate the kernel's own "preserve hard safety boundaries" invariant. |
| Own-history tab has something real to show | `pilot.session_script_runs` (`run_state`, `blocks_completed`) joined via `activity_id` to `pilot.activity_log` where `activity_domain='boxing_training'`, or `pilot.session_script_runs` alone | ≥ 1 settled (`completed`) run whose script included a `warmup`-category drill | any — existence, not a trend | Like module 023, this is a content-lookup surface, not a statistical claim: one completed run is enough for "your last warm-up" to mean something. Recommend **not** gating the warm-up *content itself* behind this — only the "your own history" tab needs it; its absence should read as an honest empty state (see (c)), not a locked feature. |

Per-athlete accumulated volume (attempt counts, RPE history, weeks-of-attendance) plays **no role** in unlocking this module's core content view — flagging that explicitly so a reviewer does not import module 020's data-threshold pattern here by habit. The org-level authored-content gate is the real one.

## (c) LOCKED state

**Org / coach level.** Before the content prerequisites in (b) are met for a given drill:

> "Warm-Up Library — 4 of \[N\] active drills carry an authored warm-up entry; 1 of 4 has cleared floor validation."

Real counts only, computed live from `pilot.drill_library` — no XP, no levels, no percentage bar implying inevitable completion. The specific unblocking action is authoring: a coach or curriculum author moves a drill's `field_provenance` from a DRAFT string to `'PPBF source manual v3'` after floor validation, or inserts a new `pilot.drill_library` row with `category='warmup'`. That authoring surface already exists in the schema (`drillLibraryV3.ts`); only a dedicated warm-up-scoped browse/search surface is genuinely missing today — this is closer to module 114's starting position (content already sitting in the database, unread by any page) than to module 020's (waiting for events to accumulate).

**Athlete level.** An athlete only ever sees a warm-up that has already passed the existing `requires_coach_authorization` gate for its session/template. Before a coach has confirmed a specific warm-up for the athlete's next session, the athlete's screen states plainly:

> "No warm-up confirmed for your next session yet."

Not a countdown, not a partial-progress bar. If the athlete has zero settled runs to show in an own-history tab, that tab says "No warm-up history recorded yet" — an honest empty state, not a locked-feature teaser implying an athlete should train more to "earn" it.

Engagement doctrine followed: no streaks, no gamified unlock meter tied to warm-up completion. Pride in one's own record (real history when it exists) — never compulsion to generate more of it just to clear a threshold.

## (d) What unlocks

### At athlete level (own record only)

Once a coach has confirmed a warm-up (via the existing `requires_coach_authorization` gate on the relevant `drill_library`/`workout_templates` rows) for the athlete's upcoming or in-progress session, the athlete may see: the confirmed warm-up drills' `purpose`, `execution`, `what_good_looks_like`, and cues — filtered strictly to what a coach actually assigned to them, never a gym-wide browse. Separately, an athlete may see their own **history** of completed warm-up-inclusive session runs (from `pilot.session_script_runs`/`blocks_completed`) and, if fresh, their own most recent `pilot.readiness` reading shown as a fact alongside — never combined into a derived "prep score."

**Never unlocks for the athlete, at any level:**
- A system-generated claim that *they specifically* need a longer/different warm-up right now. That inference — if it is ever built at all — belongs to a coach's in-person judgment, gated exactly as `requires_coach_authorization` already gates drill/template use; this module has no write path and makes no such suggestion.
- Any reconstruction of "how long ago your warm-up ended," since (per (a)) that per-block timing is not stored for settled runs. The module will not approximate this from `blocks_completed`/aggregate duration; it will show UNKNOWN rather than a guess.
- Any cross-athlete comparison of readiness, warm-up completion, or prep consistency, in any form.

### At org / coach level

A read-only, org-scoped browse/search over warm-up/mobility/cooldown content (mirroring module 114's `listCueLibrary` shape): grouped by drill category, filterable, each row showing its `field_provenance`/floor-validation state plainly rather than hidden, plus the linked `warmup_decay` stop-rule text for any contact drill selected alongside it. Live display (not stored) of an athlete's fresh readiness reading and active-hold status when a coach is about to confirm a warm-up for that specific athlete's session — read-only fact display, gating nothing new beyond what `pilot.training_holds` already enforces.

**Stays locked forever, regardless of data or content volume:**
- No AI-authored warm-up content reaches an athlete-facing surface without clearing `field_provenance = 'PPBF source manual v3'` or an explicit human floor-validation step — draft stays labeled draft.
- No model ever proposes or auto-confirms a warm-up, a warm-up length, or a "you should extend your warm-up because of your readiness score" message for a named athlete. That crosses directly into the no-AI-auto-approval-of-progression/medical/coach-decision rule, and this module has no write path to circumvent it.
- No cross-athlete "who is under-prepared" list, at any role — board, coach, or otherwise.
- No effectiveness score attached to a warm-up (echoing `pilot.drill_version_outcomes`'s own refusal to hold an effectiveness score for drill versioning generally).
- Active `pilot.training_holds` scoped `all_training`/`contact_only` are respected unconditionally; this module cannot surface, confirm, or suggest a warm-up that leads into a scope a hold currently blocks.

## (e) Open questions for the owner

1. **Should the actual warm-up-to-contact gap ever be tracked historically, closing the schema gap noted in (a)?** Today only the live cursor (`session_run_state.current_block_id`) can be compared to "now" in real time; nothing persists a per-block start/end timestamp once a run settles, so the `warmup_decay` 25-minute finding can never be checked after the fact.
   - **Option A — leave it live-only.** No new schema; the engine can show a real-time "gap growing" indicator to a coach mid-session but can never answer "did we violate this last Tuesday." Cheapest, honest about the limit.
   - **Option B — add per-block actual-start/actual-end timestamps to a new table** (not altering `session_script_runs`, which the header explicitly designed as aggregate-only) so the decay window becomes verifiable retrospectively. Real schema work, out of scope for this proposal.
   - **Option C — defer entirely**, treating warm-up timing as coach judgment the same way sparring dose is (per `workout_templates`' own "no prescribed sparring volume" doctrine: no default here would appear authoritative in the UI while resting on nothing).
   - **Recommendation:** Option A for v1 (live-only, explicitly labeled as such), revisit Option B only if the owner wants historical decay-compliance auditing as a distinct future capability.

2. **How much of the current DRAFT warm-up/mobility content (4 of 5 rows) may reach a coach or athlete screen before floor validation?**
   - **Option A — hard-gate:** only `field_provenance='PPBF source manual v3'` content is ever shown anywhere. Safest, but leaves the org-level content prerequisite in (b) nearly unmet today (only 1 of 5 rows qualifies).
   - **Option B — visibly-labeled soft gate:** DRAFT content is shown to coaches with its DRAFT/floor-validation label rendered inline, never to athletes until validated.
   - **Recommendation:** Option B, matching module 023's same recommendation for its own regression content — coaches are the intended reviewers of DRAFT material; athletes should only ever see validated content.

3. **Should `pilot.session_script_blocks.block_kind` gain an explicit `'warmup'` value**, so a script's warm-up segment is a first-class fact rather than inferred from `drill_id → drill_library.category`?
   - **Option A — leave the inference in place.** No schema change; the join already works today (`session_script_blocks.drill_id → drill_library.drill_id`, filter `category='warmup'`). Slightly fragile if a future warm-up block has no `drill_id` (e.g., a free-text warm-up instruction).
   - **Option B — widen the `block_kind` CHECK to add `'warmup'`**, following the exact precedent of `pilot_slice_postgres_drill_vocabulary_widening_migration.sql` (a widen-never-narrow migration, additive only). Makes the minute-by-minute script explicitly self-describing.
   - **Recommendation:** Option B is small and low-risk (same pattern already used twice in this codebase), but is still new schema and therefore outside this proposal's no-code scope — recommend approving it as the first implementation slice if this module proceeds, rather than working around the gap with a fragile join indefinitely.
