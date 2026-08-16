# Engine Unlock Proposal — Module 030: Cooldown / Recovery Routine Engine

| Field | Value |
|-------|-------|
| Target module | `docs/capabilities/modules/030-cooldown-recovery-routine-engine.md` |
| Status | **PROPOSAL — owner decision required, no code changes** |
| Prepared | 2026-08-16 |
| Scope | Prerequisites and gating logic for unlocking module 030 only |

This document proposes what module 030 may honestly compute/show, what must exist
in the real database before any part of it unlocks, what the locked and unlocked
states look like, and which decisions belong to the owner rather than to this
proposal. It does not modify any table, route, or existing module file.

---

## (a) WHAT IT COMPUTES / SHOWS

**This module computes no recovery score, readiness score, or dose scalar of any
kind.** A composite "recovery" number is the exact invented metric the honesty
doctrine forbids, and the platform already has a coach-facing readiness surface
(`pilot.readiness`, read by `readinessBoard.ts`, GREEN/YELLOW/RED, owned by other
register modules — 019/077/091, not this one). Module 030 must not duplicate,
re-derive, or re-badge that number. If the owner wants this module to reference
readiness state at all, it reads the existing GREEN/YELLOW/RED band as a fact
about another module's output — it never recomputes it.

Also worth the owner's attention while reading this proposal: `pilot.readiness`
rows today are written with a raw `score`/`category` taken directly from a
request body during intake/domain-upsert (`apps/web/app/api/pilot/intake/domain-upsert/route.ts`
lines ~117-124) — a staff member types a number in. A formula does exist
(`calculateReadinessL14` in `apps/web/src/server/pilot/readinessMath.ts`) but it is
called from nowhere in production code, only its own test file. That table's
provenance is weaker than its GREEN/YELLOW/RED presentation suggests. This is not
module 030's problem to fix, but module 030 must not treat `pilot.readiness` as a
validated input either way.

What this module **does** show, once unlocked:

- **A coach/protocol-authored routine, surfaced, never generated.** The engine
  selects among routine content a human already wrote and marked in use — it does
  not sequence exercises, does not pick reps/sets/duration, does not invent a
  progression. See §(e) Q1/Q2 — there is currently no dedicated "cooldown routine"
  content table, so which existing authored content this reads from is an open
  question, not a settled fact.
- **The athlete's own recorded anchor event** the routine is attached to: the most
  recent `pilot.training_attempts` or `pilot.activity_log` row for that
  `athlete_id`, shown as what it is (metric/kind, `attempted_at`/`occurred_on`,
  who recorded it) — not summarized into a load number this module did not exist
  to compute.
- **The athlete's own most recent self-report, if present, exactly as recorded.**
  `pilot.athlete_check_ins.energy` / `.soreness` / `.focus` are optional 1-5
  self-reports (nullable, no default). If the athlete skipped a field, this module
  shows "not reported" — never a substituted 3, never an averaged prior value.
- **Explicit UNKNOWN states**, not defaults, whenever a fact is absent: no fresh
  check-in → "not reported today"; no authored routine on file for the org →
  "no routine on file", not a generic fallback routine invented at render time;
  no recent training/activity record for the athlete → the locked state in §(c),
  not a routine shown against a non-existent session.
- **Nothing cross-athlete.** No team average, no percentile, no rank, no
  leaderboard, no "compared to your teammates" framing of any kind, at any role.

---

## (b) DATA PREREQUISITES

Checked against real tables and real column names, cited from the migrations that
define them (`infra/azure/*.sql`).

### Org-level prerequisite (gates the module for the whole organization)

1. **At least one coach/staff-authored routine exists and is marked in use.**
   Concretely, one of:
   - `pilot.session_scripts` (`pilot_slice_postgres_session_scripts_migration.sql`)
     has >= 1 row for the organization with `authoring_state = 'in_use'`, and
     that script has >= 1 row in `pilot.session_script_blocks` (joined on
     `script_id`) whose `block_label`, `what_to_say`, `what_to_explain`, or
     `what_to_watch` text plausibly identifies a cooldown/recovery segment — **there
     is no `block_type` or similar controlled column**, so today this can only be
     a text match against free-text fields the coach wrote for an entirely
     different purpose (minute-by-minute delivery script, not routine tagging).
     This is flagged as an open question in §(e) Q2, not assumed as a working
     mechanism.
   - OR `pilot.intervention_protocols` (`pilot_slice_postgres_intervention_protocols_migration.sql`)
     has >= 1 row with `status = 'active'`, `athlete_id is null` (org-general,
     per that table's own applicability rule), whose `target_problem` /
     `intervention_description` names recovery/cooldown as the target — again a
     free-text match, since `intervention_protocols` has no problem-domain
     enum. This path also means every surfaced routine actually is one full
     intervention record (hypothesis, expected outcome, evaluation plan) —
     heavier machinery than a simple cooldown routine, discussed in §(e) Q1.
   - **A grep of every `.sql` file under `infra/azure/` for a dedicated
     cooldown/recovery-routine content table found none.** Neither
     `pilot.drills` (free-text `category`, no controlled vocabulary, no
     warm-up/cooldown distinction) nor `pilot.session_scripts` was built for
     this purpose. If neither text-match approach is acceptable to the owner,
     this module has no data prerequisite it can satisfy today and stays locked
     org-wide until a schema decision is made.
2. No timespan requirement on the authored content itself — existence, not
   recency, is what's being checked (a coach can write a routine once and reuse
   it indefinitely).

### Athlete-level prerequisite (gates the surface for one specific athlete, in
addition to the org-level gate above)

1. **>= 1 row in `pilot.training_attempts` or `pilot.activity_log` for that
   `athlete_id`** within a recency window — proposed default **14 days**, but
   this exact number is an owner decision (§(e) Q3), not a fact derivable from
   the schema. This is the anchor event: a cooldown routine attaches to a
   training occurrence that actually happened; without one, there is nothing to
   cool down from.
   - `pilot.training_attempts`: keyed `(organization_id, athlete_id, metric_kind,
     attempted_at)`, indexed for exactly this read
     (`idx_training_attempts_athlete_metric`).
   - `pilot.activity_log`: keyed `(organization_id, person_account_id,
     occurred_on, activity_domain, ...)`; filter `activity_domain =
     'boxing_training'` and join `athlete_id` (nullable on this table when the
     person isn't an athlete, so the filter matters).
2. **No minimum check-in count required.** `pilot.athlete_check_ins` fields are
   explicitly optional by design ("Skipping them is legal... Absent is absent —
   no default is invented", per that migration's own comment). If a fresh
   check-in exists, use it; if not, show "not reported" — never block the
   routine surface on it, and never invent a stand-in value.
3. **Freshness, if reusing an existing pattern rather than inventing a new one:**
   `readinessBoard.ts` already defines `READINESS_FRESHNESS_HOURS = 24` for "is
   this reading today's, or history". Reusing that constant (rather than a new
   one) for "is this check-in fresh enough to show" is the smaller-footprint
   option; a genuinely new window is also possible. Either way this is a
   decision, not a given (§(e) Q3 covers the training-recency window; the
   check-in freshness window could reuse 24h or diverge — the owner should say
   which).

---

## (c) LOCKED STATE

**Org locked** (prerequisite in §(b) org-level not met): coach/admin workspace
shows a literal count against the literal requirement — e.g. "0 of 1 required
in-use routines authored" — never a percentage, spinner, or "coming soon"
marketing copy. No countdown. No implied urgency.

**Athlete locked** (org prerequisite met, but this specific athlete has no
recent training/activity row): the athlete's (or coach's, depending on §(e) Q5)
surface shows their own real count against the real threshold — e.g. "0 training
records in the last 14 days (need at least 1) — a routine will appear after your
next recorded session" — not a synthetic progress bar with an invented weighting
between "some" and "enough". If the athlete has activity but it falls outside
the recency window, show the actual date of their last recorded session, not
just "0".

Neither locked state may show a preview of a routine, a fabricated example
routine, or a "here's what recovery tracking usually looks like" placeholder —
all of that is showing content that either doesn't exist yet or wasn't authored
by staff for this org.

---

## (d) WHAT UNLOCKS

### Athlete level — the athlete's own record only

- Their own most recently authored, in-use routine (per whichever source §(e)
  Q1 resolves to), attached to their own most recent qualifying
  `training_attempts`/`activity_log` row.
- Their own most recent check-in values (`energy`/`soreness`/`focus`), shown
  exactly as recorded, or "not reported" per field.
- **Cross-athlete comparison and leaderboards remain structurally forbidden** —
  no team average, no percentile, no rank, at any role, matching the
  `training_attempts` migration's own stated rule ("NO leaderboard, ranking, or
  cross-athlete comparison surface may be built on this table") and the module
  stub's boundary against exposing athlete-level data without suppression.

### Org level

- Coach/admin visibility into which routines exist and their
  `authoring_state`/`status` (draft vs in_use vs active vs retired) — a
  catalog view, not a per-athlete leaderboard.
- If the `intervention_protocols` path is chosen (§(e) Q1): the existing
  adherence/evidence machinery in `pilot.intervention_executions` and
  `pilot.intervention_evidence_links`/`pilot.intervention_outcome_reviews`
  already exists and is staff-only by that module's own design — module 030
  would read it, not add a parallel one.
- Org-wide **counts only** (e.g., "N athletes have a qualifying recent training
  record and are eligible to see a routine") — never a per-athlete breakdown
  exposed at board/org aggregate level without the suppression rules the module
  stub already requires.

---

## (e) OPEN QUESTIONS FOR THE OWNER

**Q1. Which existing table is the authoritative source of "cooldown routine"
content?**
- (a) `pilot.session_scripts` / `pilot.session_script_blocks` — reuse the
  minute-by-minute script content coaches already author, matched by
  block text.
- (b) `pilot.intervention_protocols` — heavier machinery (hypothesis,
  expected outcome, evaluation plan) designed for named problems, not
  routine session content; using it means every cooldown routine is filed
  as a full intervention.
- (c) A new, dedicated lightweight table/tagging convention built
  specifically for reusable routine content (not proposed here — this would
  be new schema, out of this proposal's no-code-changes scope).
- (d) Do not unlock this module until a dedicated content model exists;
  treat both (a) and (b) as workarounds not worth shipping.

**Q2. Since no column marks a block/protocol as "cooldown" today, how should
the engine identify one?**
- (a) Require coaches to prefix `block_label` (or protocol `title`) with a
  fixed marker string (e.g. `"Cooldown:"`), matched literally.
- (b) Add a nullable `block_type` enum column (`warm_up`/`main`/`cooldown`/
  `other`) via a new migration — schema change, outside this proposal.
- (c) No auto-detection at all: require an explicit join/tag naming which
  script or protocol id counts as "the cooldown routine" for that org,
  maintained by staff.
- (d) Defer this module until module 029 (Warm-Up Prep Engine) ships and
  mirror whatever convention it settles on, since the two modules face an
  identical "how do we mark this segment" problem.

**Q3. What recency window counts as "recently trained, cooldown is relevant"?**
- (a) Same calendar day only.
- (b) 24 hours.
- (c) 14 days (the default this proposal assumed for illustration — not a
  recommendation).
- (d) No fixed window: always show the most recent record regardless of age,
  labeled with its real age ("last recorded 9 days ago"), and let the coach
  judge relevance.

**Q4. Should the athlete's self-reported check-in ever affect *which* routine
is surfaced, or only appear as separate read-only context?**
- (a) Check-in never affects routine selection — display only.
- (b) A coach may author multiple named routine variants (e.g., one for
  reported high soreness), and the engine picks among *coach-authored*
  variants by the athlete's own reported band — never an engine-invented
  threshold or formula.
- (c) Out of scope for v1; revisit once Q1/Q2 are settled and real usage data
  exists.

**Q5. Is athlete-facing surfacing in scope for v1, or is this coach/staff-facing
only (matching module 026's fully staff-only posture)?**
- (a) Coach/staff-facing only; the athlete never sees the routine directly
  through this module.
- (b) Athlete sees it only after a coach has reviewed/assigned it for that
  day — a human stays in the loop before a minor sees an unreviewed
  protocol-authored routine.
- (c) Athlete sees any in-use org routine unconditionally once their own
  anchor training event exists, with no per-instance coach review step.

---

*No file other than this one was created or modified in preparing this
proposal.*
