# Engine Unlock Proposal — Module 024 Session Outcome Engine

## Status

PROPOSAL — awaiting owner approval. No code.

The module stub (`docs/capabilities/modules/024-session-outcome-engine.md`) currently says nothing beyond a DRAFT/inactive header and generic boilerplate boundaries ("no invented metrics," "no board PII," "no AI auto-approval"); every content section — Intent, Dependencies, Acceptance criteria, Implementation notes — is empty, and the Audit log has only the scaffold-creation row.

## (a) What the engine computes and shows

Module 024 owns one thing: an honest, per-session read of what happened at an ordinary practice session, reusing rows that already exist. It computes nothing new — it correlates and displays.

**Real sources, real columns:**

| What it shows | Table.column(s) |
|---|---|
| Whether this session happened / was marked complete | `pilot.sessions.completed_flag`, `.date`, `.notes` |
| RPE as the athlete/coach actually recorded it | `pilot.sessions.rpe` (shown as the stored number for that one row — never averaged into a cross-signal index) |
| Coach review status for this exact session | `pilot.coach_reviews.session_id = pilot.sessions.session_id`, `.decision`, `.approved_flag`, `.notes` — shown verbatim, or "not yet reviewed" when no row exists |
| Attempts logged inside this session | `pilot.training_attempts` where `context_type = 'session'` and `context_id = <the session's key>`, split into literal counts: `made = true`, `made = false`, `made is null` (a target-less measurement) — real counts, never a make-rate percentage or accuracy score |
| Independent same-day corroboration | `pilot.activity_log` rows for the same `athlete_id`, `occurred_on = sessions.date`, `activity_domain = 'boxing_training'` — shown alongside, e.g. its own `duration_minutes` and `rpe`, never merged into the `pilot.sessions` row's numbers even when both exist |

**What it explicitly does NOT compute:** no session grade, quality score, adherence percentage, or any single number blending completion + RPE + attempts + review into one figure. No "improving/declining" verdict across sessions — sequential values may be listed side by side, but the engine draws no trend conclusion. No cross-athlete anything, at any level.

**A real linkage gap the engine must surface, not paper over:** `pilot.training_attempts.context_id` is an unconstrained `text` column (no FK) when `context_type = 'session'`. There is no code path today that writes it, and there are structurally *two* different "session" identifiers in the schema — `pilot.sessions.session_id` (an athlete's own per-session log row) and `pilot.session_script_runs.run_id` (a class-level script delivery, no `athlete_id` column at all). Until the owner decides which one `context_id` means (see 3(e)), the engine cannot safely auto-join attempts to a session and must show "no attempts linked to this session" rather than guess.

**Boundary against module 026:** 026 (`pilot.intervention_protocols` / `_executions` / `_evidence_links` / `_outcome_reviews`) is the record of a *deliberate, diagnosed* intervention — planned-vs-actual exposure, a five-state adherence vocabulary, and a human three-answer outcome review, staff-only, never athlete-visible. Module 024 is the *ordinary* session record every athlete has regardless of whether any intervention is active — athlete-visible (own record only), carrying no adherence vocabulary, no hypothesis, no evidence-role taxonomy, and no outcome-review workflow. `pilot.intervention_executions.session_run_id` already has a composite FK into `pilot.session_script_runs`; when a session a 024 view is showing turns out to be linked from an active execution, 024 must not re-derive its own adherence/dose reading of that night — it shows a plain pointer ("this session is part of a tracked intervention — see coach workspace") and defers entirely to 026's record. 024 never reads or writes any of the four `pilot.intervention_*` tables. It is one of 026's *evidence sources* (session references, training attempts, activity log — all already named as 026 dependencies), never a competing ledger.

## (b) Data prerequisites

**PER ATHLETE**

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| Any session exists at all | `pilot.sessions` row for `athlete_id` | 1 | ever | Below 1, there is nothing to render but the locked state; showing a single real row is a fact, not an invented pattern. |
| A completion picture is meaningful | `pilot.sessions.completed_flag` | 3 rows (**OWNER_DECISION**) | rolling 30 days | One row can only ever show "1 of 1" — true but not a picture. Three lets the athlete see more than a single point without the engine asserting a trend. |
| Review coverage is meaningful | `pilot.coach_reviews` joined by `session_id` | 1 reviewed session | ever | A single reviewed session is a real, literal fact ("reviewed: yes/no" per row); no threshold needed beyond existing. |
| Attempt counts inside a session are meaningful | `pilot.training_attempts` (`context_type='session'`) | 1 | ever | Cannot show made/missed counts before at least one attempt is linked — and see the linkage-gap note in (a): this signal is currently unreachable until `context_id` semantics are fixed. |
| Same-day corroboration exists | `pilot.activity_log` (`occurred_on` = session date, `activity_domain='boxing_training'`) | 1 | same day as the session shown | Shows only "corroborated / not corroborated," never a percentage across days. |

**PER ORG**

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| Any usage exists | distinct `athlete_id` count in `pilot.sessions` | 1 athlete with ≥1 session | ever | Below this the org-level coverage view has nothing to count. |
| Review-coverage count is stable enough to show at org level | completed `pilot.sessions` rows matched against `pilot.coach_reviews.session_id` | 10 completed sessions (**OWNER_DECISION**) | rolling 28 days (reuses `coachIntelligence.ts`'s `UNREVIEWED_SESSION_DAYS = 7` window logic rather than inventing a second threshold) | Under ~10 sessions, "N of M reviewed" swings wildly from a single coach's timing and reads as a judgment on that coach, not a real coverage measure. Reusing the existing per-athlete unreviewed-session rule (module 111 / `coachIntelligence.ts`) rather than a new number satisfies playbook rule 3. |
| Attempt-linkage coverage is stable enough to show at org level | count of `pilot.training_attempts` with `context_type='session'` across the org | 20 (**OWNER_DECISION**) | rolling 28–90 days | Needed before any org-level "sessions carrying attempt evidence" indicator is shown, so the count is not just one coach's personal habit of logging attempts. |

Org-level output is **coverage-only** (process compliance counts — "how many completed sessions in the window have a coach review," never "how are our athletes doing"), per the honesty doctrine's ban on cross-athlete comparison and board/public individual clinical detail.

## (c) LOCKED state

**Athlete, before any session exists:** "No sessions logged yet." Real count: `0 sessions logged`. Action: "Ask your coach to log your next session" — never XP, points, or a level. No RPE/attempts/review sub-panels render at all; there is nothing honest to say about them yet.

**Athlete, 1–2 sessions logged (below the 3-session completion-picture threshold):** shows the real session(s) that exist in full (date, completed_flag, RPE, review status if any) — those are facts about specific rows, not a pattern claim. A plain line states the count toward the threshold: "2 of 3 sessions logged — one more shows your completion pattern." Misses are shown exactly as recorded (`completed_flag = false`, or `made = false` attempts) with no softening and no hiding; framed as "your edge, found" — this is where the current capacity boundary sits, never a failure grade.

**Coach/org, below the org coverage threshold:** shows the real running count ("6 of the 10 completed sessions needed to show org review coverage this window") rather than any placeholder percentage.

Engagement doctrine held throughout: every number on this page is a literal, dated count of the athlete's own recorded rows. Nothing compounds, levels up, streaks, or badges achievement — the only thing "badged" is an honest miss, presented as information about where the edge currently is, never as a shortfall to feel bad about.

## (d) What unlocks

### At athlete level (own record only)

- A sequential list of the athlete's own sessions: date, `completed_flag`, `rpe`, `notes`.
- Coach review status per session, read verbatim from `pilot.coach_reviews` — already athlete-readable today (`app/api/pilot/coach-reviews/list/route.ts` grants role `athlete` through `assertActorCanAccessAthlete`, the same own-record gate this engine must reuse, not reinvent).
- Attempt counts linked to a session (made / missed / no-target-measurement), once the `context_id` linkage question in (e) is resolved.
- Same-day `activity_log` corroboration (duration, domain, verified status) shown next to, never folded into, the session row.
- **Never unlocks, ever:** a computed score, an adherence label, a trend verdict, or any comparison to another athlete. Those stay out of scope for this module permanently — not a future tier, a hard boundary matching 026's and the kernel's non-negotiables.

### At org / coach level

- Coverage counts only: completed-sessions-with-a-review count/window, sessions-with-linked-attempts count/window — reusing `coachIntelligence.ts`'s existing unreviewed-session detection (item 4, `UNREVIEWED_SESSION_DAYS`) as the review-lateness signal rather than restating it.
- **Never unlocks:** any per-athlete detail rolled into a board/public view, any ranking or "which coach reviews fastest" comparison, any auto-flagging that reads as an AI verdict on a coach or athlete. Individual session content (RPE, notes, review decision text) stays behind the same staff/own-athlete access gate `pilot.coach_reviews` already enforces — org level sees counts, never content.

## (e) Open questions for the owner

1. **What does `training_attempts.context_id` mean for `context_type = 'session'`?** Options: (a) `pilot.sessions.session_id` — the athlete's own log row; (b) `pilot.session_script_runs.run_id` — the class delivery record; (c) both, disambiguated by a second column. **Recommendation:** (a), because `pilot.sessions` is the only one of the two that already carries `athlete_id` and is what `pilot.coach_reviews` and the passbook already key on — reusing it needs no schema change, only a written convention plus (ideally) a validating check in the writing module. This is the single hardest prerequisite in this proposal: without an answer, the attempts-per-session signal in (a)/(b) cannot ship at all.
2. **Athlete-facing surface or API-only for v1?** Options: (a) ship as a read-only API only, UI later; (b) ship a minimal read-only page reusing the passbook's session list styling; (c) fold directly into the existing passbook page rather than a new route. **Recommendation:** (c) — the passbook (`apps/web/src/server/pilot/passbook.ts`) already renders the athlete's own `pilot.sessions` and `pilot.readiness` rows; adding review-status and attempt-count columns there is smaller and avoids a second athlete-facing "sessions" surface, per playbook rule 3 (reuse over new schema/routes).
3. **Org coverage thresholds (10 completed sessions / 20 linked attempts) — are these the right floors, or should they scale with roster size?** Options: (a) fixed floors as proposed; (b) a floor as a function of active-athlete count; (c) no org-level surface in v1, athlete-level only. **Recommendation:** (c) for the first slice — ship the athlete own-record view first (smallest, least ambiguous vertical slice per the playbook), defer the org coverage rollup to a second slice once the `context_id` question is settled and real usage volume exists to sanity-check any threshold choice.

---

**Summary:** Module 024 is an honest, per-session read of an athlete's own ordinary practice record (completion, RPE, review status, linked attempts, same-day corroboration) with zero invented scores — pure correlation of rows that already exist across `pilot.sessions`, `pilot.coach_reviews`, `pilot.training_attempts`, and `pilot.activity_log`. Its boundary against module 026 is clean: 026 owns deliberate, staff-only intervention tracking with adherence/hypothesis/evidence-review machinery; 024 owns the routine, athlete-visible, own-record-only session log and is one of 026's evidence sources, never a parallel ledger. Its hardest data prerequisite is that `pilot.training_attempts.context_id` has no enforced meaning for `context_type='session'` today — there are two candidate "session" identifiers in the schema and no code links either. The single most important owner question is 3(e)#1: which identifier `context_id` should mean, since the attempts-per-session feature cannot exist honestly until that's decided.
