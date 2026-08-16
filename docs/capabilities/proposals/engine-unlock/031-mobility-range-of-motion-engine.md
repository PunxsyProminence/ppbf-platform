# Engine Unlock Proposal — Module 031 Mobility / Range-of-Motion Engine

## Status

PROPOSAL — awaiting owner approval. No code changes accompany this document.

The module stub (`docs/capabilities/modules/031-mobility-range-of-motion-engine.md`) currently says: Status **DRAFT**, Active **false**, Promotion required **true**; Intent is an empty placeholder paragraph; Boundaries repeat the three platform-wide defaults verbatim (no auto-approval, no board PII, no invented metrics); every Acceptance-criteria checkbox is unchecked; there is no schema, no API surface, and no role list on record anywhere for this module. This proposal is the first attempt to fill that in.

## (a) What the engine computes and shows

Module 031 is a **read/organize layer over existing assessment-shaped rows**, not a new measurement instrument and not a scoring engine. It has no table of its own to compute from; it computes from:

- `pilot.assessment_protocols` — the catalog row a human authors for a specific mobility/ROM check: `protocol_id`, `protocol_version`, `name`, `measure_kind` (must be `'physical_test'`), `quality_measured` (e.g., "shoulder flexion ROM", authored text — this engine never invents the quality being measured), `protocol_summary`, `equipment_needed`, `time_to_administer_min`, `retest_interval_days` / `retest_after_training_hours` / `retest_interval_basis`, and the honesty-default columns `reliability_status` ('UNVALIDATED - PPBF MUST ESTABLISH'), `validity_status` ('UNKNOWN'), `evidence_class` ('INSUFFICIENT EVIDENCE'), `minimal_detectable_change` (null until a reliability study supplies it).
- `pilot.assessments` — the recorded observation, extended by the same migration: `assessment_id`, `athlete_id`, `assessor_account_id`, `assessor_role`, `result` (jsonb, whatever the protocol defines), `protocol_id`/`protocol_version`, `administration_kind` (constrained to `scheduled_interval | scheduled_training_hours | ad_hoc | baseline | retention_test | transfer_test | reliability_study`), `due_on`, `administered_on`, `retest_of_assessment_id`, `training_hours_at_administration`, `second_rater_account_id`/`second_rater_result`, `conditions_note`.
- `pilot.data_collection_requests` — the open capture prompt (`request_kind = 'physical_test'`, `reason_code`, `due_on`, `status`) for a mobility protocol that is due.
- `pilot.training_holds` — read-only, displayed as a fact next to an athlete's mobility history (`scope`, `reason_category`, `athlete_explanation`, `status`), because a coach reviewing mobility data needs to know training is currently paused or reduced. The engine never writes to this table.

What it shows, per athlete: the literal chronological list of recorded observations against a given protocol (value as stored in `result`, `administered_on`, who recorded it and in what role, `conditions_note`), the protocol's own measurement-quality fields shown *alongside every value, every time* (reliability/validity/evidence_class/MDC — reusing the assessment-protocols doctrine that a result is never displayed detached from what is known about the measurement itself), the retest chain via `retest_of_assessment_id`, and any open/overdue capture request for that athlete on that protocol.

What it shows, at org/coach level: which protocols exist and are active, and an operational queue of who is due/overdue (`pilot.data_collection_requests` rows, `pilot_assessments_due` index) — a worklist, never a table of values.

**What it does not compute, ever:**
- No composite "mobility score," "flexibility index," or single ROM number aggregated across joints or athletes — `assessment_protocols` holds no such column and none is added.
- No normative reference range ("should be X° for a 14-year-old") — the schema's own doctrine is that `retest_interval_basis` defaults to `'TBD - no defensible basis'` and `minimal_detectable_change` defaults to null; this engine displays that honesty state, it does not paper over it with adult/non-boxing literature values.
- No injury-risk number. That is module 22 (Injury-Risk Engine), a separate, unbuilt module. 031 supplies raw historical facts that a future statistical module could read; it does not itself infer risk.
- No clearance and no diagnosis. Clearance lives in exactly two places, neither touched by this module: `pilot.medical_intake.clearance_status` (medical, physician-facing) and `pilot.person_clearances` / `pilot.v_clearance_status` (safeguarding, background-check facing — an explicitly advisory, read-only view per its own migration comment: "authorizes nothing"). 031 has no clearance column and proposes none.
- No cross-athlete comparison, ranking, or leaderboard, at any level, per standing doctrine.

**The clinical boundary, stated plainly:** A *coach-recorded mobility observation* is a `pilot.assessments` row filed against a `measure_kind = 'physical_test'` protocol by an `assessor_role` such as `coach`, using a plain-language capture (a position achieved, a timed hold, a tape-measure or app-based angle reading) — the same mechanism the platform already uses for any other physical test. A *clinical measurement* — a credentialed goniometric assessment used to diagnose a joint pathology, clear or restrict an athlete medically, or drive a treatment plan — has no table, no role, and no credentialing concept anywhere in this schema. The platform's only clinical-adjacent record is `pilot.medical_intake` (physician name/phone, `clearance_status`), which this engine does not read or write. Where the two could be confused — an ROM value that looks concerning — the correct system response is a referral prompt to a human (parent/coach contacts the physician of record), never an in-app diagnostic label or auto-generated hold.

## (b) Data prerequisites

**PER ATHLETE**

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| A mobility/ROM protocol exists to measure against | `pilot.assessment_protocols` (`measure_kind='physical_test'`, `active=true`, `quality_measured` names a mobility/ROM quality) | ≥1 org-wide | N/A — one-time authoring | Without an authored protocol there is nothing to attach a number's meaning to; per the protocols migration, a result with no protocol is unusable by design. |
| Baseline observation recorded | `pilot.assessments` (`protocol_id` set, `administration_kind='baseline'` or first `administered_on` on that protocol, `athlete_id`) | 1 | N/A | A single point is a baseline, never a trend; showing anything trend-shaped from one point would be an invented signal. |
| Retest recorded, correctly spaced | `pilot.assessments` (`retest_of_assessment_id` set, `administered_on`, `training_hours_at_administration`) | 1 additional row (2 total) | ≥ the protocol's own `retest_interval_days` **or** `retest_after_training_hours` — never a platform-wide constant | The assessment-protocols migration is explicit that intervals are per-test, derived from sensitivity to change, and that testing too soon reads measurement error as improvement. 031 must inherit the protocol's own interval, not impose one. |
| Which trigger actually fired is knowable | `pilot.assessments.training_hours_at_administration` populated on both rows | OWNER_DECISION — required vs. optional | — | Needed to show *why* a retest counted as due (elapsed time vs. training hours) rather than silently picking one. |

**PER ORG**

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| At least one active mobility/ROM protocol authored | `pilot.assessment_protocols` (`measure_kind='physical_test'`, `active=true`) | ≥1 | N/A | No org-level rollup can exist before a human has defined what "mobility" means for this program — authoring is a human act this engine never performs. |
| Roster coverage before any org rollup displays | `pilot.assessments` distinct `athlete_id` with ≥1 recorded observation ÷ roster size (`pilot.athletes`) | OWNER_DECISION (e.g., some minimum coverage fraction) | current roster snapshot | Guards against one athlete's data reading as an organizational pattern; this is a coverage denominator only — never a per-athlete comparison. |
| Reliability self-collection has actually started | `pilot.assessments.second_rater_result` populated | OWNER_DECISION minimum count | — | `reliability_status` should only ever leave `'UNVALIDATED - PPBF MUST ESTABLISH'` once PPBF has real dual-rater data from its own population — never imported from outside literature (RESEARCH_FIRST). Absent this, the org view keeps showing UNVALIDATED, which is correct, not a bug. |

Every OWNER_DECISION cell above is a coaching/data-governance judgment call, not a number this proposal picks on its own.

## (c) LOCKED state

**Before any protocol is authored (org-wide):** Coach/admin sees a plain statement — "No mobility/range-of-motion protocol is configured for this program yet" — with the action pointing at the existing protocol-authoring surface (`pilot.assessment_protocols`), not at this module. No progress bar, because there is nothing yet to make progress toward. Athletes/parents see nothing (no locked card at all) — there is no feature to gesture at.

**Once a protocol exists, before the athlete has a baseline:** "0 of 1 baseline mobility check recorded for [protocol name / quality_measured]." Action: "Ask your coach to record a baseline mobility check" — this creates the `pilot.assessments` row (or, if the coach isn't present, a `pilot.data_collection_requests` row of `request_kind='physical_test'`, `reason_code='baseline_missing'`, which already exists in schema for exactly this).

**Once baseline exists, before a valid retest:** "Baseline recorded on [administered_on]." Retest opens [due_on] or after [N] more training hours, per this protocol's own retest guidance — pulling `due_on`/`retest_interval_days`/`retest_after_training_hours` verbatim, never a generic countdown. No chart, no delta, no "improving/declining" language — one point cannot show change.

All counts shown are real row counts against real thresholds (1 baseline, 2 for a trend) — never XP, points, streaks, or levels. The framing throughout is pride in one's own completed record ("your baseline is on file") rather than any compulsion mechanic ("you're missing out," badges, unlocked levels).

## (d) What unlocks

**At athlete level (own record only)**

Once ≥2 rows exist on a lineage with a valid retest gap: the athlete/coach see their own literal timeline — baseline value, retest value(s), as recorded, with units/format exactly as the protocol defines them; the protocol's `reliability_status`/`validity_status`/`evidence_class`/`minimal_detectable_change` shown next to every pair, not hidden in a tooltip; and — because `minimal_detectable_change` will be null for essentially every protocol until PPBF runs its own reliability study — an explicit, unavoidable caveat that an observed difference may be within measurement error whenever MDC is null or `reliability_status` is still at its unvalidated default. Also shown: any open capture request for that athlete/protocol, and the athlete's own current `training_holds` status (display of fact only, sourced from `pilot.training_holds`, never derived or recommended by this engine).

**At org / coach level**

Coaches get an operational due/overdue worklist (who needs a mobility check, by protocol, from `pilot.data_collection_requests` and the `pilot_assessments_due` partial index) — a queue to act on, not a data table to browse. Org admins/board get counts only: number of protocols configured, number of athletes with any recorded baseline, number of overdue retests. No individual value, no per-athlete breakdown, no percentile, no "team average ROM" ever reaches this tier — per the playbook rule that board/public never receive individual athlete clinical detail, and per the standing no-comparison rule.

**Stays locked forever, and why**

- Clinical interpretation or diagnosis of any recorded value — this platform has no clinical role or credentialing concept; that judgment belongs to the athlete's physician of record via `pilot.medical_intake`, a table this engine never touches.
- Injury-risk inference — module 22's explicit, separate, unbuilt domain.
- Automatic placement or lifting of a `pilot.training_holds` row — hold authority is explicitly coach/org_admin only, by owner decision recorded in that migration; 031 may display a hold, never create, modify, or suggest one.
- Any clearance decision — both clearance concepts in this schema (medical `clearance_status`; safeguarding `pilot.v_clearance_status`) are human-authored/human-verified by their own migrations' explicit doctrine, and 031 proposes no clearance field of its own.
- Any cross-athlete comparison, ranking, percentile, or normative reference range not authored by a credentialed human specifically for PPBF's own population.

## (e) Open questions for the owner

1. **Who may record a mobility/ROM observation?**
   - (A) Any coach, via `assessor_role='coach'`, identical to how every other `physical_test` protocol is captured today. Lowest friction, zero new schema; risk: not every coach has movement-screening training.
   - (B) Restrict capture to accounts carrying a new credential/role flag that does not exist in the schema today. Most protective of the clinical boundary, but is new authorization work outside this proposal's scope.
   - (C) Same as (A), but every mobility protocol's `protocol_summary`/`quality_measured` text must state plainly that this is a non-clinical coach observation, and `human_authority_required` stays enforced at capture time.
   - **Recommendation:** (A) combined with (C)'s labeling discipline — it reuses the existing protocol/assessment mechanism exactly and keeps the clinical disclaimer textual and mandatory rather than inventing a new authorization layer inside this one module.

2. **Does the athlete see their own recorded ROM values directly, or only a coach-mediated summary?**
   - (A) Full, direct access to their own raw recorded values and protocol context — matches the standing doctrine that athlete-level unlocks give richer views of the athlete's own record, nothing more.
   - (B) Coach-gated: a coach must review/release a value before the athlete sees it — more cautious given the clinical-adjacent subject matter, but adds a workflow/state this schema does not currently have.
   - (C) Athlete sees that a check happened (date, protocol name) but not the numeric value, which the coach discusses in person.
   - **Recommendation:** (A), as the doctrine's plain default — but flagging this explicitly for owner sign-off given how close ROM data sits to clinical territory; a decision to depart from (A) here would be a deliberate, recorded exception, not an oversight.

3. **What are the actual OWNER_DECISION thresholds in (b) — per-athlete and per-org minimums?**
   - (A) Minimal: 1 baseline / 2-with-valid-retest per athlete, 1 active protocol org-wide before any rollup — mirrors the pattern other shipped engines (e.g., 020's "last N sessions") use.
   - (B) Add a floor on `second_rater_result` count before any reliability claim ever displays as anything other than the unvalidated default.
   - (C) Add a roster-coverage percentage before the org rollup counts display at all, so a single early-adopting athlete's data can't read as "the program tracks this."
   - **Recommendation:** (A) + (B) — cheapest path to a working engine, and (B) costs nothing because the honest default (UNVALIDATED) is what would display anyway absent real dual-rater data; (C)'s exact percentage is a program-management call this proposal should not set unilaterally.

4. **Should a mobility/ROM `pilot.assessments` row be linkable as evidence into the module 026 intervention ledger** (`pilot.intervention_evidence_links.source_kind` already includes `'assessment'`)?
   - (A) Yes — zero new schema, the evidence-link table already supports `assessment` as a typed source kind (baseline/retention/transfer roles all fit a mobility retest naturally).
   - (B) Not yet — keep 031 and 026 unconnected until 031 ships and is stable.
   - **Recommendation:** (A) is essentially free once 031 exists, but the sequencing relative to 026's own pending release wave is the owner's call, not this proposal's.
