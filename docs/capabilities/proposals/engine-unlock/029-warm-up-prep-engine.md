# Module 029 — Warm-Up / Prep Engine: Engine-Unlock Prerequisite Proposal

Status: PROPOSAL for owner review. No code, schema, or migration changes were made to produce this document. All column names below are quoted from the real `CREATE TABLE` statements in `infra/azure/*.sql`, read directly for this proposal.

---

## (a) WHAT IT COMPUTES / SHOWS

**The load-bearing distinction for this module, per the honesty doctrine:**

- **SURFACING** a warm-up means displaying a sequence a human already wrote down — a coach's `pilot.workout_template_items` rows, a `pilot.session_scripts` / `pilot.session_script_blocks` sequence, or a `pilot.drill_library` entry a coach tagged as warm-up content. This is safe and already gated by existing mechanisms (`requires_coach_authorization`, `active`/`authoring_state`, contact-volume constraints). This module's job is limited to this.
- **GENERATING** a warm-up means the platform deciding, from an athlete's data, what exercises/durations/reps they should do before training. That is a coaching/sports-medicine prescription decision for minors. **No schema in this repository stores an algorithm, formula, or generation rule for this, and this proposal does not ask the owner to approve one.** If a future ticket wants generation, it needs its own separate, explicit medical/coaching-doctrine review — it is out of scope for 029 as proposed here.

**What the unlocked module may show, and only from real recorded rows:**

1. A coach-authored warm-up sequence for the athlete's next/current session — verbatim `workout_template_items` rows (`block`, `drill_id` or `free_text_drill`, `duration_minutes`, `rep_count`, `scale_level`, `contact_level`) or `session_script_blocks` rows (`block_label`, `what_to_say`/`what_to_explain`/`what_to_watch`/`what_to_fix`, `start_offset_min`/`end_offset_min`, `drill_id`), rendered as-authored.
2. Any `pilot.drill_stop_rules` row of `rule_kind = 'warmup_decay'` attached (via `drill_id`) to a drill in that sequence, shown as a **fact** — "this drill carries a documented warm-up-decay stop condition: `condition_text`" — never as a computed countdown, because no column anywhere records how long this athlete has actually been inactive before this session.
3. The athlete's own most recent `pilot.athlete_check_ins` row for today (`energy`, `soreness`, `focus`, each an explicit 1-5 or absent — absent is absent, never defaulted).
4. The athlete's own fresh `pilot.readiness` reading (`score`, `category`, `measured_at`), using the same freshness rule the existing readiness board already enforces (`READINESS_FRESHNESS_HOURS = 24` in `apps/web/src/server/pilot/readinessBoard.ts`) — this module reads that existing, already-tested formula's output, it does not recompute or re-derive a score of its own.
5. The athlete's own active `pilot.training_holds` state (`scope`, `athlete_explanation`) if one exists, and the relevant `pilot.safety_gate_evaluations` outcome for the `contact_medical_clearance` gate if the surfaced content has `contact_level` above `none`.

**Explicit UNKNOWN states required:**
- No fresh check-in or readiness reading -> `UNKNOWN`, never a default GREEN/neutral value (mirrors the existing readiness-board rule: "never default these to a reassuring value").
- No tagged warm-up content exists for the org/session -> "No warm-up recorded for this session," never a generated placeholder or generic stock warm-up.
- No `warmup_decay` stop rule on a drill -> silence on that point, not "fully warmed up."

**Hard "no" list, restated for this module specifically:** no computed readiness percentage of its own; no dose scalar (rounds/reps/duration) invented beyond what a coach already entered in `workout_template_items`/`session_script_blocks`; no cross-athlete comparison of warm-up completeness; no streaks, points, or badges for "did your warm-up."

---

## (b) DATA PREREQUISITES

### Per athlete
| # | Requirement | Table / column | Notes |
|---|---|---|---|
| 1 | Athlete has an active roster row | `pilot.athletes` | Standard existence check. |
| 2 | No active all-training hold | `pilot.training_holds` where `status='active'` and `scope='all_training'` | Enforced uniquely by `idx_training_holds_one_active`; presence blocks *any* surfacing, warm-up included. |
| 3 | Medical clearance state resolvable for contact content | `pilot.medical_intake.clearance_status`, cross-checked via `pilot.safety_gate_evaluations` for `gate_key='contact_medical_clearance'` | Only required if the content to surface has `contact_level` above `none`/`light_technical`. `clearance_status` defaults to `'pending'` and is free text, not an enum — see Open Question 3. |
| 4 | (Optional, for "today's state" only) A check-in within 24h | `pilot.athlete_check_ins` where `checked_in_on = current_date` | Its absence is legal per the table's own design comment ("an athlete who doesn't want to rate ... still gets to say 'I'm here'"); the UI must show UNKNOWN, never block on this. |

### Per organization
| # | Requirement | Table / column | Notes |
|---|---|---|---|
| 1 | At least one active, coach-authored warm-up sequence exists | `pilot.workout_templates` (`active=true`) + `pilot.workout_template_items`, OR `pilot.session_scripts` (`authoring_state in ('coach_reviewed','in_use')`) + `pilot.session_script_blocks` | **See the schema gap below — this cannot be checked precisely today.** |
| 2 | The `contact_medical_clearance` safety gate is active for the org | `pilot.safety_gates` where `gate_key='contact_medical_clearance'` and `active_flag=true` | Seeded for every org except `__platform__` by the safety-gate-matrix migration; verify it wasn't deactivated. |
| 3 | (Optional) Warm-up-decay stop rules are seeded for contact/maximal-effort drills | `pilot.drill_stop_rules` where `rule_kind='warmup_decay'` | 63 such rows exist in the shared seed archive per `docs/current/WORK_QUEUE.md` (PR-238ac); seeding is per-organization, not automatic — an org must have actually loaded this data. |

### The schema gap that makes prerequisite #1 (org, warm-up content exists) unenforceable as written

There is **no controlled vocabulary anywhere in the schema for "this is a warm-up."** Concretely:
- `pilot.session_script_blocks.block_kind` is a `CHECK` enum: `'arrival', 'instruction', 'demonstration', 'drill_round', 'reset_minute', 'teaching_minute', 'transition', 'conditioning', 'reflection', 'close'`. **`'warm_up'` is not a value.** The closest is `'arrival'`, which is not the same thing (arrival is about starting the room, not about physical preparation).
- `pilot.workout_template_items.block` is free text — a coach *could* type `"Warm-up"` into it, but nothing constrains or requires this, and nothing distinguishes it from any other block label.
- `pilot.drill_library.category` is free text with no `CHECK` constraint at all (confirmed by reading `pilot_slice_postgres_drill_library_v3_migration.sql` — `category text not null` only).
- `pilot.drill_stop_rules.rule_kind = 'warmup_decay'` describes decay of readiness across an *inactive gap before* a drill — it is a stop-condition tag on a drill, not a tag meaning "this drill/block IS a warm-up."

**Consequence:** today, any query for "does this org have tagged warm-up content" can only be a fragile free-text search (e.g. `block ILIKE '%warm%'` or `category ILIKE '%warm%'`), which will both miss real warm-up content authored under a different label and match false positives. **This proposal cannot state a precise, checkable per-org data prerequisite for warm-up-content existence until the owner decides how warm-up content gets tagged** (see Open Question 1). Until then, the honest locked-state message is "warm-up tagging is not yet supported," not a progress bar toward a fake threshold.

---

## (c) LOCKED STATE

Before unlock, the module must show, per athlete, exactly what is missing — never a generic "coming soon":

- If an active `all_training` hold exists: **"Training is currently paused for this athlete — see your coach"** (reusing `training_holds.athlete_explanation`, never `reason_text`, which is staff-only). No warm-up content of any kind renders underneath a full hold.
- If no coach-tagged warm-up content exists for the org at all: **"No warm-up has been recorded for this program yet."** Because prerequisite (b)#1 cannot currently be queried precisely (schema gap above), this message is unconditional today rather than a percentage — e.g. it cannot honestly say "3 of 12 templates have a warm-up block" because nothing marks a block as a warm-up block.
- If tagged content exists but the specific upcoming session/template has none: **"No warm-up recorded for today's session."**
- If content exists and is content-level appropriate, but the athlete's medical clearance is `pending`/`not_started` and the content includes contact above `light_technical`: the contact portion is withheld and flagged (mirrors `contactClearanceGate.ts`'s existing "flag, don't block on a post-action record" behavior — but a *pre-training display* is a pre-action context, so the owner should decide whether this should block display of the contact portion rather than merely flag it; see Open Question 5).
- If no fresh check-in/readiness reading exists: render the check-in/readiness portion as **UNKNOWN**, not blank and not green.

---

## (d) WHAT UNLOCKS

### Athlete level (their own record only — cross-athlete comparison and leaderboards are FORBIDDEN)
- Their own next/current session's coach-authored warm-up sequence, exactly as entered (`workout_template_items` / `session_script_blocks`), respecting `scale_level` (coach picks at delivery, never forced) and `contact_level` gating.
- Their own drill-attached `warmup_decay` stop-rule facts for drills in that sequence.
- Their own most recent `athlete_check_ins` entry and fresh `readiness` reading, displayed with the same GREEN/YELLOW/RED bands the existing readiness board already uses — this module must not invent its own thresholds.
- Their own active `training_holds`/clearance state as it affects what's shown.
- **Never:** a percentile, rank, "compared to teammates," or any other athlete-to-athlete framing. Nothing in `pilot.training_attempts`' governing doctrine ("NO leaderboard, ranking, or cross-athlete comparison surface may be built on this table") is available to this module either, and this module inherits that rule structurally, not just by convention.

### Org level
- A coverage view: how many active templates/scripts have been tagged as containing warm-up content (once tagging exists — see Open Question 1) and how many athletes currently have an active hold that suppresses warm-up display. This is an aggregate operational count, never a per-athlete list ranked or scored against each other.
- Whether the `contact_medical_clearance` and `training_hold` safety gates are active for the org (both already exist in `pilot.safety_gates`; this module only reads their `active_flag`, it does not create or modify gates).

---

## (e) OPEN QUESTIONS FOR THE OWNER

1. **How should warm-up content be identified in the schema, given no controlled vocabulary exists today?**
   - (a) Add `'warm_up'` to the `pilot.session_script_blocks.block_kind` `CHECK` constraint (an additive, non-breaking migration, matching the pattern already used in `pilot_slice_postgres_drill_vocabulary_widening_migration.sql`).
   - (b) Add a `category` value convention (e.g. `'warm_up'`) to `pilot.drill_library`, documented but still unconstrained.
   - (c) Add a new boolean/typed column, e.g. `pilot.workout_template_items.is_warm_up` or `pilot.session_script_blocks.is_warm_up`, rather than overloading an existing enum.
   - (d) Do not build any surfacing query yet; leave this module fully locked until an actual tagging decision is made and applied, and treat that as this proposal's real gate.

2. **Should this module ever be allowed to read `pilot.readiness`, given its formula is not documented in this codebase (it is written by a caller-supplied `score`/`category` via `createReadiness()` in `apps/web/src/server/pilot/intake.ts`, not computed there)?**
   - (a) Yes, read-only, exactly as the existing `readinessBoard.ts` does (same freshness rule, same GREEN/YELLOW/RED bands) — no new computation.
   - (b) No, treat `pilot.readiness` as out of scope for 029 until its formula is documented/validated separately, and show only `athlete_check_ins` (raw self-report) instead.
   - (c) Show both, clearly separated and labeled by source, so a coach/athlete can see "self-reported today" vs. "formula-scored" without conflating the two (matches the existing doctrine in the check-ins migration comment forbidding mixing the two tables).

3. **How should medical clearance interact with display, not just recording?** `pilot.medical_intake.clearance_status` is free text defaulting to `'pending'`, and the one existing gate for it (`contact_medical_clearance`) is deliberately `enforcement='flag'`, not `'block'`, because it guards a *post-action* record write. A warm-up *display* is pre-action.
   - (a) Keep it a flag: show the contact-containing content anyway, with a visible flag/warning banner.
   - (b) Escalate it to a block for this module specifically: never render contact-level-above-`light_technical` warm-up content when clearance is not `'current'`/equivalent — this would be a new, narrower gate row in `pilot.safety_gates`, not a change to the existing shared gate.
   - (c) Withhold only the contact-specific items from the sequence and still show the non-contact items (partial suppression) with a note explaining what's missing and why.

4. **What is the minimum per-org unlock threshold once tagging (Question 1) exists — a count, or presence-only?**
   - (a) Presence-only: unlock as soon as at least one tagged warm-up sequence exists anywhere in the org.
   - (b) A minimum count (e.g. at least one tagged sequence per active `session_type`/`discipline` the org runs) so "unlocked" means broadly usable, not just technically present.
   - (c) Require the tagging to be reviewed/approved by a named human role (e.g. only `authoring_state='coach_reviewed'` or `'in_use'` scripts count, never `'draft'`) before it counts toward unlock — this is already partially expressed in prerequisite (b)#1 above but the owner should confirm `'draft'` explicitly does not count.

5. **Should `warmup_decay` stop-rule facts be shown to the athlete directly, or only to the coach?** The rule text (`condition_text`) is coaching/safety language authored for coach use; showing it verbatim to a minor athlete may or may not be the intended audience.
   - (a) Coach-facing only (surfaced in the coach's session view, not the athlete's own view).
   - (b) Athlete-facing too, in age-appropriate language the coach or protocol author would need to separately provide (a new field, not existing today).
   - (c) Neither — treat `warmup_decay` rules as internal coaching content this module should not touch at all, and drop item 2 from section (a) entirely.
