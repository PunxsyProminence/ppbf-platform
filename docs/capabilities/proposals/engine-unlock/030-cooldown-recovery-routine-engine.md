# Engine Unlock Proposal — Module 030 Cooldown / Recovery Routine Engine

## Status

PROPOSAL — awaiting owner approval. No code.

The module stub (`docs/capabilities/modules/030-cooldown-recovery-routine-engine.md`) currently says nothing concrete: `Status: DRAFT`, `Active: false`, every section (Intent, Dependencies, Acceptance criteria, Implementation notes) is an unfilled placeholder except the generic scaffold Boundaries block, and the audit log holds only the 2026-08-03 scaffold-creation entry.

## (a) What the engine computes and shows

**AUTHORED CONTENT (already exists in the platform; this engine organizes and displays it, never invents it):**

- `pilot.drill_library` rows with `category = 'cooldown'` — two real rows exist today: `drl_325b6ba2613eb0` ("Cool-Down Walk and Breathe": `purpose`/`execution`/`what_good_looks_like`/`what_bad_looks_like`/`common_errors`/`corrections`, `contact_level = 'none'`) and `drl_786d761c9321c0` ("Post-Session Mobility", `equipment_needed = 'mat'`). `drill_library` is `organization_id`-scoped, so any given org may have zero, some, or different cooldown drills authored — presence must be checked per org, not assumed platform-wide.
- `pilot.workout_template_items.block` values of `'cooldown'` (free text — no CHECK constraint enforces this vocabulary, but it is the value seed content actually uses alongside `'warmup'`, `'technical'`, `'sparring'`, etc.), each carrying `duration_minutes` and a `drill_id` FK into `drill_library`. Seed data shows cooldown blocks of 3–7 minutes, positioned last in the template (highest `ordinal`).
- `pilot.session_scripts.reset_protocol` / `.coach_priorities` and `pilot.session_script_blocks.block_kind = 'reset_minute'` — session-level, human-authored recovery/reset instructions.
- `pilot.session_script_renderings.body` — several existing renderings already narrate a cooldown segment ("Cooldown & exit", "5:50–6:00 Cooldown") in their authored text.

**COMPUTATION (the engine's actual job):** for a specific athlete's specific recorded session, show which authored cooldown content the template/script that generated that session specifies, and whether it was actually recorded as delivered — using only real rows, joined, never scored:

- `pilot.session_script_runs` (`script_id`, `delivered_on`, `blocks_completed`, `reset_protocol_used` — a real boolean column, already present) joined via `script_id` to `pilot.session_script_blocks` where `block_kind = 'reset_minute'`.
- `pilot.activity_log` (`activity_domain = 'boxing_training'`, `occurred_on`, `duration_minutes`, `rpe`) where the session traces to a `pilot.workout_templates`/`workout_template_items` row with `block = 'cooldown'`.
- Per-athlete history is a factual list: date, which authored drill(s) ran, planned `duration_minutes`, and `reset_protocol_used` true/false. Nothing is averaged into a rate, a streak, or a score.
- `pilot.readiness` (`score`, `category`, `measured_at`) is a **pre-existing** platform signal — its `score` is computed by `calculateReadinessL14()` (`apps/web/src/server/pilot/readinessMath.ts`) from self-reported `sleepHours`, `sorenessLevel`, and `disciplineScore`, and `readinessBoard.ts` already bands it GREEN/YELLOW/RED (≥7 / ≥4 / below) for the coach floor within a 24-hour freshness window. This module does not invent that signal and may, at most, show an athlete their own already-recorded readings back to them — it adds no new interpretation, no new composite, and no new sleep/soreness collection surface of its own.
- `pilot.training_holds` where `reason_category = 'fatigue'` — a real, human-placed record (`athlete_explanation`, `lift_condition_text`, `placed_by_role`) of when training was paused or regressed for fatigue reasons. Shown as fact, never reinterpreted.

**What it explicitly does NOT do:**

- No "recovery score," "recovery index," or any composite of sleep + soreness + RPE + cooldown-adherence into one number.
- No sleep-duration targets, hydration guidance, nutrition guidance, or soreness-management advice generated for an athlete or parent — this is a health-guidance-to-minors question, not a coding one, and is deferred to the owner in (e)(1) rather than proposed here.
- No wearable/HR/biometric signal of any kind. `BACKLOG-wearables` is PARKED (`docs/current/ACTIVE_WORK.md`) on an unresolved consent/device-ownership decision; this design assumes no such stream exists or is permitted.
- No cross-athlete comparison, ranking, or "who does their cooldown" surface at any level, at any data volume.
- No AI-authored cooldown drill content or advice text — the engine assembles existing `drill_library`/`session_scripts` rows; it does not generate new recovery instructions itself.
- No AI-driven adjustment of training intensity, plan, or scope from a recovery signal — that authority stays entirely with `pilot.training_holds`, placed only by `coach`/`organization_admin`/`admin`.

## (b) Data prerequisites

### Per athlete

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| At least one recorded session naming a cooldown segment | `pilot.session_script_runs.reset_protocol_used`/`.blocks_completed` (via `script_id` → `pilot.session_script_blocks.block_kind='reset_minute'`), or `pilot.activity_log` linked to a `pilot.workout_template_items.block='cooldown'` row | ≥ 1 | any | Below 1 there is nothing to show but the honest "no cooldown ever recorded" state — this is an existence gate, not a statistical one. |
| Enough history for an own-adherence pattern view (not a single data point read as a trend) | same `session_script_runs.reset_protocol_used` across multiple runs | ≥ 5 (reuses module 020's established "last N sessions" convention) — **OWNER_DECISION** whether 5 is right here too | any | A single boolean is a fact already visible at N=1; framing it as "how often do I…" needs enough rows that one miss or one hit is not misread as a pattern. Reusing the platform's existing N avoids inventing a second threshold philosophy (see 021 §2 for the same reasoning applied there). |

### Per organization

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| Authored-content prerequisite: the org has cooldown content to show at all | `pilot.drill_library.category='cooldown'` (active) **and** ≥1 `pilot.workout_template_items.block='cooldown'` or `pilot.session_script_blocks.block_kind='reset_minute'` referencing it, all scoped to the org's own `organization_id` | ≥ 1 each | n/a | This is the real gate for this module, ahead of any athlete's data: without authored cooldown content in *this* organization's own catalog, there is nothing to surface regardless of how many sessions an athlete has logged. Two rows exist in the seeded content today, but `drill_library` is org-scoped and must be checked per org, not assumed. **OWNER_DECISION** if a newly onboarded org with zero cooldown content should see a locked state pointing coaches at content authoring, rather than at their own athletes' data. |
| Count of athletes with their own per-athlete minimum met | count derived from the per-athlete signal above, per `athlete_id`, scoped by `organization_id` | ≥ small-cell suppression floor N (unset platform-wide; see 021 §3, same unresolved question) | any | Nothing may aggregate cooldown adherence across athletes (banned outright); the only honest org-level number is a suppressed count of "how many athletes have enough of their own record," and even that risks re-identification in a small gym below some floor. **OWNER_DECISION.** |

## (c) LOCKED state

Before the per-athlete existence gate is met, the athlete and their coach see, on the athlete's own record only:

> "Cooldown history: **0 of 1** recorded sessions naming a cooldown segment." — action: "This appears automatically the next time a coach runs a session or logs an activity that includes a cooldown block."

Once ≥1 exists but the pattern-view floor (N=5) is not:

> "Cooldown pattern view: **[k] of 5** sessions with cooldown data recorded." — action: "Keep training — this view opens once 5 sessions with cooldown data exist."

Real row counts against real thresholds only — no percentage of an invented denominator, no XP, no points, no levels, no streak badge (even though "adherence" invites streak framing, the honest unit stays a literal count of real rows, and a miss is shown as a miss, not reset to a broken streak). If content prerequisite (b, org table) is unmet, the coach-facing message names that directly: "No cooldown content is authored in this organization's catalog yet" — pointing at content authoring, not at athlete behavior.

Org level, before the suppression floor is met: no count is shown at all (per the recommendation in (e)(3), deferring to whatever floor 147/148 eventually set, consistent with proposal 021's same open item).

Engagement doctrine observed: counters exist so an athlete can watch their own real history accumulate — pride in one's own record — never a push notification, streak pressure, or comparison to any other athlete's count.

## (d) What unlocks

### At athlete level (own record only)

- A chronological list of the athlete's own sessions that named a cooldown segment: date, the authored drill(s) that ran (`drill_library.name`/`.purpose`/`.execution`/`.what_good_looks_like`, copied verbatim, never rewritten), the template/script's planned `duration_minutes`, and `reset_protocol_used` true/false per session-run.
- The athlete's own `pilot.readiness` history (`score`, `category`, `measured_at`) — the same self-report data already visible on the coach floor board — shown back to the athlete as a plain factual timeline, with no new synthesis against cooldown adherence.
- The athlete's own `pilot.training_holds` history where `reason_category='fatigue'`, shown with the required `athlete_explanation` field exactly as staff wrote it — never with any AI-generated rationale layered on top.

### At org / coach level

- Once the suppression floor is met (open question, (e)(3)): a single suppressed count, "**k of N** athletes have enough recorded cooldown history to view their own pattern" — never which athletes, never individual detail; a coach reaches an individual athlete's own view only through that athlete's own record, under the access rules that already govern it.
- A staff-only **content inventory** view: which `drill_library` rows (`category='cooldown'`) and which `workout_template`/`session_script` cooldown blocks currently exist in the org's own catalog. This is a catalog-completeness view for coaches deciding what to author next, not athlete data, and has no athlete-level gate at all — it is available as soon as staff role access exists.

### What stays locked forever, regardless of data volume

- **Any single "recovery score" or "recovery readiness index"** combining sleep, soreness, RPE, cooldown-completion, or any wearable/biometric signal — permanently. More recorded sessions never substitute for the construct validity such a composite would require; this mirrors proposal 021's identical argument about a modeled fitness-fatigue curve.
- **Any AI-generated sleep, hydration, nutrition, or soreness-management advice surfaced to an athlete or parent** — out of this engine's scope entirely; a health-guidance-to-minors question belongs to the owner/safeguarding decision in (e)(1), not to accumulating row counts.
- **Any cross-athlete comparison** of cooldown adherence, readiness reading, or recovery behavior, at any N.
- **Any wearable/HR-derived input.** `BACKLOG-wearables` is PARKED on an unresolved consent/device-ownership decision; nothing here is designed to consume such a stream if it later arrives without that decision being made first.
- **Any AI auto-adjustment of training intensity, scope, or plan** from a recovery signal — that authority remains exclusively with human-placed `pilot.training_holds`.

## (e) Open questions for the owner

1. **Health-guidance boundary — should the athlete-facing view ever include generic (non-personalized) recovery education text, or facts only?**
   - Option A — Facts only, forever: the engine shows authored drill content and real adherence/readiness/hold history; zero recovery-education prose is generated or selected by the engine itself.
   - Option B — Static, human-authored reference material: a qualified advisor writes generic (not personalized) youth-recovery education content directly into the platform's authored-content tables (same authoring path as any other coaching content), displayed unconnected to any individual athlete's data — added later, as a separate content decision.
   - Option C — The engine personalizes recovery advice from the athlete's own recorded signals (sleep, soreness, RPE).
   - **Recommendation:** A now; B only if the owner commissions specific reviewed content later, through a named qualified advisor; explicitly refuse C. This decision is named here because health guidance to minors is a safeguarding/policy question, not an engineering one.

2. **What should count as "the cooldown was delivered"?** `reset_protocol_used` is a single boolean set at the whole-session-run level, not per drill or per athlete-in-the-room; is that granularity acceptable for what "adherence" should mean, or does the owner want a more granular record (e.g. a future per-drill completion row) before any adherence view ships?
   - Option A — Ship on `reset_protocol_used` as it exists today: real, already-collected, but coarse (one flag per session run, not per athlete).
   - Option B — Wait for a more granular completion record before building any adherence view.
   - **Recommendation:** A — it is a real existing column and finer granularity can be added later without reworking this view, but the owner should confirm session-level (not per-athlete-per-drill) granularity is an acceptable meaning of "adherence" before this ships.

3. **Org-level small-cell suppression floor N** — no numeric floor exists anywhere in the codebase yet for board/org aggregate suppression (the same open item raised in proposal 021 §3).
   - Option A — Pick N=5 for this module specifically, independent of other modules.
   - Option B — Defer the org-level surface entirely until modules 147/148 (board aggregates) set a reusable floor, so no two modules invent divergent suppression numbers.
   - **Recommendation:** B, matching 021's own recommendation on the identical question.
