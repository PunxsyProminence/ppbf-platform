# Module 033 — Fatigue Decay Monitor: Unlock-Prerequisite Proposal

| Field | Value |
|-------|-------|
| Status | **PROPOSAL — for owner approval, no code changes** |
| Module stub | `docs/capabilities/modules/033-fatigue-decay-monitor.md` |
| Related stub | `docs/capabilities/modules/021-adaptation-engine.md` (sibling — same RESEARCH_FIRST audit constraint; its proposal punts exposure/load display ownership toward this module in its Open Question 5) |
| Related shipped module | `docs/capabilities/modules/026-intervention-tracking-engine.md` (evidence-link/causality primitives this module may feed into, never compute) |
| Prepared against | `infra/azure/*.sql` (real schema, cited by file below) |
| Wearables/HR | **PARKED** — `docs/current/ACTIVE_WORK.md` (`BACKLOG-wearables`): owner decision 2026-08-16 deliberately excluded biometric hardware streams for minors pending a consent/privacy/device-ownership decision no code can make. Not proposed here. |

This document proposes the data-honesty gate that must sit in front of any "Fatigue Decay Monitor" surface, per `AGENT_KERNEL.md` invariant 5 (claims need evidence) and invariant 6 (owner policy is not invented by the model). It contains no implementation and changes no file except itself.

---

## Governing constraint (read first)

The module's own audit log (`docs/capabilities/modules/033-fatigue-decay-monitor.md`, 2026-08-16 entry) already settled the central point: *"no boxing-validated Banister impulse-response decay constants were found, and no youth evidence supports fixed tau values. Fitness-fatigue / impulse-response modeling is RESEARCH_FIRST for this module: never hardcode imported tau1/tau2 constants."*

**"Fatigue" is not a stored or computable quantity anywhere in this schema, and this proposal does not create one.** There is no fitness-fatigue curve, no synthetic fatigue index, no dose scalar, and no cumulative-load-to-risk formula in `infra/azure/*.sql`, and none should be invented to make this module feel finished. What follows is the honest alternative: real recorded events, shown as recorded, gated behind enough of them to stop being noise — never labeled "fatigue," always labeled by what was actually observed and by whom.

---

## (a) WHAT IT COMPUTES / SHOWS

Nothing in this module computes a fatigue score, readiness index, load score, or trajectory. Every number is either a stored value or transparent, unlabeled-as-anything-clever arithmetic (counts, sums, min/max, simple deltas) computed at query time. Where a prerequisite (section b) is unmet, the surface shows an explicit `UNKNOWN — insufficient recorded data` state — never a zero, a default "fresh," or an inferred value standing in for a missing one.

Once unlocked (per athlete, per sub-view — see section d), the monitor shows exactly these views, each sourced from one real table, each labeled with who recorded it:

1. **Within-session performance trend** (per `athlete_id` × one training-session grouping) — from `pilot.training_attempts`: `achieved_value` plotted in `attempted_at` order for rows sharing the same `(organization_id, athlete_id, context_type = 'session', context_id, metric_kind)`. Shown as "attempt N of the session, in recorded order" against the raw value — never smoothed, never fit to a curve, never given a "decay rate." `direction` (`at_least`/`at_most`) and `made` are shown alongside so a later, lower number is never silently implied to be worse (a fatigue-appropriate slower time on an `at_most` metric is still `made = true` if it clears the target). Recorded_by is shown (`recorded_by_account_id`'s role), since this is staff-observed data, not self-report.
2. **Cross-session load-history** (per `athlete_id`) — from `pilot.session_load` (`rpe_physical`, `rpe_cognitive` shown **separately, never multiplied or summed into one "load" number**, per that table's own no-derived-column design) and `pilot.activity_log` (`duration_minutes`, `rpe`, `activity_domain = 'boxing_training'`): raw values over `occurred_on`/`rated_at`. `rated_by` (`athlete` vs `coach_proxy`) is shown on every `session_load` row so a viewer never mistakes a coach's proxy rating for the athlete's own report.
3. **Recorded carryover signal** (per `athlete_id`) — from `pilot.session_load.next_session_quality` (`better` / `same` / `slightly_down` / `clearly_down` / `not_assessed`): the categorical, human-recorded answer to "did the *next* session look worse after this one," shown per pair of linked sessions (`activity_id` → `next_session_activity_id`) exactly as recorded. This is the closest honest analogue to "decay" the schema offers, and it is a human's categorical judgment, not a computed one — never converted to a number, never trended as a slope.
4. **Sparring exposure history** (per `athlete_id`) — from `pilot.sparring_exposure`: `time_under_impact_sec`, `coach_observed_intensity`, `coach_observed_head_contact`, `athlete_presentation` shown per segment/session and as plain weekly counts/sums of `time_under_impact_sec`. Per that table's own header comment ("No damage score. No cumulative risk index. No recommended limit"), this monitor inherits the same refusal: a running weekly total is arithmetic on a stored count, never framed as a load score, risk score, or readiness input.
5. **Self-reported wellness, as recorded** (per `athlete_id`) — from `pilot.athlete_check_ins`: `energy`, `soreness`, `focus` (each optional, 1–5, athlete-entered) shown as three **separate** raw series over `checked_in_on`, never averaged or combined into one number. This is self-report **by the athlete, who is very often a minor** — the UI must show it as "what the athlete said," not restate it as an objective measurement, and a missing value stays absent (never defaulted to a midpoint).

**`pilot.readiness` is explicitly EXCLUDED as an input to this module.** The table stores only `score numeric` and `category text` with no formula, provenance, or reporter column (unlike `pilot.assessment_protocols`, which carries `reliability_status`/`validity_status`/`evidence_class` explicitly). Tracing how a `pilot.readiness` row is actually produced shows why: `apps/web/src/server/pilot/intake.ts#createReadiness` is the only write path in application code, called only from the intake review/domain-upsert routes — meaning readiness rows are sparse, staff-entered during intake processing, not a continuous stream, and carry no record of whether the score came from a self-report, a coach observation, or a form filled out weeks earlier. A formula (`readinessMath.ts#calculateReadinessL14`, combining `sleepHours`, `sorenessLevel`, and an unexplained `disciplineScore`) exists in the codebase but is not called from any production write path — it is unwired. Feeding an opaque, provenance-free score into a "fatigue decay" surface would launder an already-invented number through this module; this proposal declines to do that (see also module 021's proposal, which reaches the identical conclusion independently).

## (b) DATA PREREQUISITES

All thresholds below are proposed defaults for owner sign-off (Open Question 3) — concrete so the gate is checkable, not because the specific numbers are final.

### Per athlete (unlocks that athlete's own sub-view, own record only)

| Sub-view | Table(s) | Condition | Proposed minimum |
|---|---|---|---|
| Within-session trend | `pilot.training_attempts` | rows sharing one `(organization_id, athlete_id, context_type='session', context_id, metric_kind)` | **>= 4 attempts** in a single session grouping, **>= 3 such session groupings** for that athlete×metric (so a trend is "this keeps happening," not one session) |
| Cross-session load-history | `pilot.session_load` + `pilot.activity_log` | rows for `(organization_id, athlete_id)` with `duration_minutes` present (schema-guaranteed not null on `activity_log`) | **>= 8 activity_log rows**, spanning **>= 28 days** |
| Recorded carryover signal | `pilot.session_load` | rows with `next_session_quality is not null and next_session_quality <> 'not_assessed'` | **>= 5 rated pairs** |
| Sparring exposure history | `pilot.sparring_exposure` | rows for `(organization_id, athlete_id)` | **>= 6 segments**, spanning **>= 21 days** |
| Self-reported wellness | `pilot.athlete_check_ins` | rows for `(organization_id, athlete_id)` with at least one of `energy`/`soreness`/`focus` non-null | **>= 10 check-ins**, spanning **>= 14 days** (per-field: a field with fewer non-null entries than the row count stays independently `UNKNOWN`, since skipping a field is legal and must not be backfilled by counting the row) |

Each sub-view unlocks independently — an athlete with rich `training_attempts` but no `athlete_check_ins` sees the within-session trend and nothing else.

**Hard schema caveat, verified rather than assumed (see also Open Question 1):** `pilot.training_attempts.context_id` (`infra/azure/pilot_slice_postgres_training_attempts_migration.sql`) carries **no foreign key** to any session/activity table — it is a free-text field the recording module (`apps/web/src/server/pilot/trainingAttempts.ts#recordAttempt`) sets from caller input with no referential check. "Same session" grouping is therefore a convention, not a database-enforced fact: it only holds if whoever is entering attempts consistently uses the same `context_id` for one physical session. Separately, `recordAttempt`'s insert list does not include `attempted_at` at all — every row's timestamp is `now()` at the moment of database insertion (schema default), not a caller-supplied observation time. If attempts are entered live, insertion order approximates performance order closely enough to read as a within-session sequence; if a coach batch-enters a session's attempts afterward from notes, `attempted_at` reflects data-entry order, not the true order performance actually decayed in, and a "trend" built from it would be reading a false signal. **This monitor cannot verify which mode produced any given row's timestamps from the schema alone**, and this is a genuine owner decision (Open Question 1), not something a threshold can fix.

### Per organization (unlocks the module's existence for that org)

| Condition | Table(s) | Proposed minimum |
|---|---|---|
| Distinct athletes meeting the within-session-trend per-athlete prerequisite | `pilot.training_attempts` | **>= 5 athletes** (matches the existing k-anonymity floor, `boardSummary.ts#BOARD_MINIMUM_COHORT_SIZE = 5`, reused rather than inventing a second threshold) |
| Org-wide session-load volume | `pilot.session_load` | **>= 40 rows** total for the org |
| Org history depth | `pilot.activity_log` | **>= 8 weeks** between the org's earliest and latest `occurred_on` |
| Carryover signal actually in use | `pilot.session_load`, `next_session_quality not in ('not_assessed')` | **>= 15 rated pairs** org-wide |

An org that has only `pilot.activity_log` attendance rows with no `session_load` or `athlete_check_ins` participation has not demonstrated the recording habits this module depends on, and the org-level gate reflects that.

## (c) LOCKED STATE

Before a sub-view's prerequisite is met, the monitor shows literal progress against the table above — counts and dates, never a percentage-toward-unlock progress bar, never framed as something the athlete "should" hit faster (hard wall: no FOMO/urgency framing; these are minors). Example locked-state text:

- Within-session trend (jab count, this athlete): *"2 of 3 minimum qualifying sessions recorded (each needs >= 4 attempts sharing one session). LOCKED — not enough recorded sessions yet."*
- Cross-session load-history: *"5 of 8 minimum activity records. LOCKED."*
- Recorded carryover signal: *"2 of 5 minimum rated next-session-quality pairs. LOCKED — this section only ever shows what a human recorded about the following session, never a computed trend."*
- Sparring exposure history: *"3 of 6 minimum segments recorded. LOCKED."*
- Self-reported wellness: *"6 of 10 minimum check-ins. LOCKED. Reminder shown to the athlete only as 'you can check in whenever you want to' — never as a streak, a missed-day count, or a declining number."*

Org-level admin/board view (aggregate only, k-anonymized at >= 5 athletes, never a per-athlete row): *"3 of 5 athletes with sufficient within-session-trend history for org-level activation. 28 of 40 qualifying session-load records. 9 of 15 rated carryover pairs."* No athlete is named, ranked, or compared in this aggregate.

## (d) WHAT UNLOCKS

**Athlete level (their own record ONLY):**
- The five sub-views in (a) become visible, individually, once their own per-athlete prerequisite is met.
- Every unlocked view is scoped to `where athlete_id = :this_athlete`. **Cross-athlete comparison and leaderboards are FORBIDDEN** — no unlock tier, present or future, may add a "compared to your teammates," percentile, or ranking surface on any of these tables. `pilot.training_attempts`'s own migration header is explicit on this point ("NO leaderboard, ranking, or cross-athlete comparison surface may be built on this table") and this proposal extends the same rule to `session_load`, `sparring_exposure`, and `athlete_check_ins`.
- **No declining number is ever shown as personal failure.** A slower time, a lower `energy` self-report, or a `clearly_down` `next_session_quality` is displayed as a recorded fact about a specific day, with neutral framing ("Tuesday's 3rd attempt: 14.2s, target 15s or faster — made"), never as a score trending downward, never with a red/warning color scheme implying the athlete did something wrong.

**Org level:**
- Below the org-level thresholds in (b), no org-admin or board surface for this module renders at all — absent, not present-and-empty, so silence is never mistaken for "no fatigue happening."
- Above threshold, the org-level surface shows only the aggregate progress counters in (c), plus links into individually-unlocked athlete sub-views (each still scoped per-athlete). The org view never becomes a table of athletes sorted by any field from this module — that would recreate the forbidden leaderboard one level up.

## (e) OPEN QUESTIONS FOR THE OWNER

1. **Can `pilot.training_attempts.attempted_at` be trusted as real-time performance order, or does it just reflect data-entry order?** The schema has no field distinguishing live entry from after-the-fact backfill, and `context_id` linking attempts into one session has no FK enforcement (see section b caveat).
   - Option A: treat it as a procedural/training question, not a schema question — instruct coaches that within-session decay only renders meaningfully if attempts are entered in real time on the floor, and ship the sub-view with a persistent disclaimer to that effect.
   - Option B: do not build the within-session trend sub-view at all until a schema change (a new migration, out of scope here) adds an explicit `entry_mode` (`live`/`backfilled`) or a caller-supplied observation timestamp distinct from insertion time.
   - Option C: build it, but require a stricter per-session minimum (e.g., >= 6 attempts within a 90-minute insertion window) as a weak proxy for "probably entered live," accepting it is a heuristic, not a guarantee.
   - Option D: ship it now as drafted with the disclaimer in Option A, and revisit if coaches report the ordering doesn't match what they remember happening.

2. **Should `pilot.readiness` stay fully excluded from this module, or is there a narrower, honest way to include it?** (Section a excludes it outright for lack of provenance.)
   - Option A: exclude permanently, as drafted — it is sparse, intake-only, and provenance-free.
   - Option B: include it only as a raw `score`/`category`/`measured_at` display (no interpretation, no trend line) with a persistent "source and method not recorded — read with caution" label, letting a coach see it exists without this module vouching for it.
   - Option C: revisit only if/when `pilot.readiness` itself gets a provenance migration (reporter role, input fields) — a separate, future decision, not this module's to make.

3. **Are the proposed thresholds (4 attempts/3 sessions; 8 activity rows/4 weeks; 5 carryover pairs; 6 sparring segments/3 weeks; 10 check-ins/2 weeks; org: 5 athletes/40 session-load rows/8 weeks/15 carryover pairs) the right bar?**
   - Option A: adopt as drafted.
   - Option B: raise all counts for a stricter honesty bar before any view renders.
   - Option C: lower them for the initial pilot cohort's known small squad sizes, with a provisional-data label at the floor.

4. **Is a plain weekly sum of `pilot.sparring_exposure.time_under_impact_sec` acceptable to display at all, even unlabeled as a score, or does summing across segments already read as an implied load/risk figure to a coach or parent?**
   - Option A: show the weekly sum, since it is arithmetic on a stored count with no risk framing attached (consistent with how the table's own header treats the count itself).
   - Option B: show only the individual per-segment rows, never a sum — even an unweighted total risks being read as "this week's dose."
   - Option C: show the sum only to staff roles, never on any athlete- or guardian-facing surface, splitting the honesty bar by audience rather than by computation.

5. **Should `next_session_quality` ever be tallied across an athlete's history (e.g., "3 of 10 rated pairs came back `clearly_down`"), or shown only one pair at a time?**
   - Option A: never tally — one categorical answer per pair, full stop, matching the "no invented aggregate" posture used elsewhere in this proposal.
   - Option B: allow a plain frequency count across the fixed five-value vocabulary, since it is a count of a closed categorical field, not a derived score.

---

### Where the schema cannot support what the stub implies

- The stub's title ("Fatigue Decay Monitor") and category (`physicalTrainingSystem`) both invite a computed fatigue trajectory or decay curve. **No table in `infra/azure/*.sql` stores a fatigue score, a decay constant, or a load-to-fatigue formula, and the module's own audit log says no boxing-validated or youth-validated constants exist to import.** This proposal treats any such computed index as permanently out of scope for this module unless a future, separately-approved PPBF-specific research effort (not an imported adult/non-boxing formula) establishes one — a new owner decision, not an unlock tier.
- **Within-session "decay" specifically cannot be verified as real-time-ordered from the schema alone** (see section b caveat and Open Question 1): `attempted_at` is an insertion timestamp, not a guaranteed observation timestamp, and the session grouping (`context_id`) is unenforced free text. The stub's implication that this module can show a reliable within-session decline needs the owner's answer to Question 1 before that sub-view should be considered dependable rather than merely plausible.
- **`pilot.readiness` cannot support an honest "who reported this" answer.** It has no reporter/role column, and its only production write path (`intake.ts#createReadiness`) is staff-entered during intake review, not a recurring self-report or coach-observation stream — the opposite of what a continuous fatigue-adjacent signal needs. This module excludes it rather than presenting it as more than it is.
- Wearable/HR data, which many commercial "fatigue" products treat as their primary input, is out of scope by standing owner decision (`BACKLOG-wearables`) and is not proposed here in any form.
