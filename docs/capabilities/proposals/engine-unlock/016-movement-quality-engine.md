# Engine Unlock Proposal — Module 016 Movement Quality Engine

## Status

PROPOSAL — awaiting owner approval. No code.

The module stub (`docs/capabilities/modules/016-movement-quality-engine.md`) currently says nothing concrete: `Status: DRAFT`, `Active: false`, `Promotion required: true`, `Category: physicalTrainingSystem`, `Parent original-25: _unmapped_`; `Intent` and `Dependencies` are empty placeholders, and the acceptance-criteria checklist is entirely unchecked. No table, API, role, or audit event has ever been named for this module.

## (a) What the engine computes and shows

**Refused up front:** "movement quality" is precisely the concept BACKLOG-video-skill-scoring already parked. Owner decision 2026-08-15 (recorded in `docs/current/ACTIVE_WORK.md`): per-skill AI video scoring (punch detection, footwork, etc.) is parked for Phase 2+; Human Film Study IS the analysis pathway; shipping machine judgments about a minor's movement quality without proven accuracy is the risk being refused. This proposal builds nothing that scores, tags, or classifies movement from video, and nothing that infers a "quality" value from any other stored field. No table in this schema stores a movement-quality metric, and none is invented here.

**What it can honestly show**, reusing existing recorded facts only, never merged into a score:

- **The athlete's own coach observation feed** — `pilot.coach_observations` (`athlete_id`, `coach_account_id`, `note_type`, `note_text`, `created_at`), shown as a dated free-text list. `note_type` is an open free-text column with no controlled vocabulary (the assessment-protocols/coach_observations design is deliberate — see `apps/web/src/server/pilot/intake.ts` and `apps/web/app/coach/decision-loop/page.tsx`'s comment: *"pilot.coach_observations' note_type column already accepts any free-text value with no taxonomy... picking specific category names... is a coaching-philosophy decision for the gym's own staff, not something to invent here"*). Known values already in production use are `'behavior_standard'` (decision-loop capture) and `'parent_message'` (guardian barrier reports) — neither is movement-specific. The engine therefore cannot filter this feed to "movement" notes; it shows the whole feed, unfiltered, and leaves interpretation to the reader.
- **The athlete's own human-reviewed Film Study observations** — `pilot.shadow_film_study_proposals` where `review_state = 'accepted'` only (`athlete_id`, `video_session_id`, `observation_text`, `reviewed_by_account_id`, `reviewed_by_role`, `reviewed_at`, `frames_analyzed`, `model_deployment`), each linked to its source clip via `pilot.video_sessions.title`/`.blob_path`. `pending_review` and `rejected` proposals are never surfaced here — only what a human coach has already attested to. `observation_text` is displayed verbatim; the engine adds no tag, score, category, or sentiment to it, and `frames_analyzed`/`model_deployment` are shown alongside so the reader knows this originated as an AI proposal a human accepted, never as a coach's own words.
- **The athlete's own skill-rubric assessment history — conditional on a protocol existing.** `pilot.assessment_protocols` supports `measure_kind = 'skill_rubric'` today (`quality_measured`, `protocol_summary`, `retest_interval_days`/`retest_after_training_hours`, `reliability_status`, `validity_status`, `evidence_class`), joined to `pilot.assessments` (`result` jsonb, `administered_on`, `assessor_role`, `second_rater_account_id`/`second_rater_result`, `conditions_note`). If an org has authored one, the engine shows raw recorded rubric results over time next to that protocol's own reliability/validity/evidence-class disclosure strings, never upgraded to look more validated than the protocol itself claims.
- **Drill reference text, shown as reference material, never as a score against the athlete.** `pilot.drill_library.what_good_looks_like` / `.what_bad_looks_like` / `.common_errors` / `.corrections`, and `pilot.drill_scale_levels.coach_watch_point`, can be shown alongside a coach observation about the same drill so a reader has the coaching standard in view next to the human note about the athlete — the text is drill-level content, not an athlete measurement.

**Two findings that bound what exists today:**

- **Zero `skill_rubric` protocols exist anywhere.** Every `pilot.assessment_protocols` row currently live comes from `apps/web/seed-data/shadow-research/2026-08-08/physical_test_battery.csv`, which is 100% `measure_kind = 'physical_test'` (CMJ, IMTP, medicine-ball throw, punch force, etc.) — no row has ever been authored with `measure_kind = 'skill_rubric'`. The skill-rubric output above is real code path, currently empty data, everywhere.
- **No API exists to author a new assessment protocol.** `apps/web/src/server/pilot/assessmentProtocols.ts` exposes `listAssessmentProtocols`, `getAssessmentProtocol`, `listDueAssessments`, `createDataCollectionRequest`, `listOpenDataCollectionRequests`, `captureDataCollectionRequest`, `declineDataCollectionRequest` — nothing that inserts a `pilot.assessment_protocols` row. Every protocol that exists got there by CSV seed, not through the running application. A coach or admin cannot, today, define a movement-quality rubric through the app at all. See open question 1.

**What this engine explicitly does NOT compute:**

- No numeric movement-quality score, index, grade, or composite of any kind, from any source — none of the source tables store one, and this proposal does not create one (module 026's pattern applies: separate typed facts, never one score).
- No AI/machine scoring, tagging, or classification of movement from video. BACKLOG-video-skill-scoring stays parked; `observation_text` is displayed unmodified.
- No inferred trend line, "improving/declining" verdict, or technique-consistency metric synthesized from free-text notes — a human has not verified such a trend, and inferring one from unstructured text is exactly the interpolation the honesty doctrine forbids.
- No technique-degradation frequency count. `pilot.drill_stop_rules` defines `rule_kind = 'technique_degradation'` as a per-drill stop *condition* (a rule that could fire), but no table anywhere in this schema logs an occurrence of a specific stop rule firing for a specific athlete/session — searched across `pilot_slice_postgres_drill_library_v3_migration.sql`, `..._drill_vocabulary_widening_migration.sql`, `..._multidiscipline_migration.sql`, `..._sparring_exposure_and_load_migration.sql`, `..._shadow_filter_reason_migration.sql` (the only files mentioning the term at all). Building "N times a coach stopped this drill for technique degradation" would require inventing that log or approximating it from `coach_observations` free text — both refused.
- No cross-athlete comparison, ranking, or leaderboard at any level, on any signal in this module, at any data volume — standing platform rule.
- If "movement quality" as the module's name implies — a computed judgment of how well an athlete moves — cannot be honestly computed from data as it exists today, and it cannot: the only honest content is (1) what a coach chose to write down, (2) what a coach chose to accept from Film Study review, and (3) whatever a coach chooses to record on a rubric they author themselves. None of these reduce to a quality value the platform itself asserts.

## (b) Data prerequisites

**PER ATHLETE**

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| Any coach observation exists | `pilot.coach_observations.athlete_id`, `.created_at` | ≥ 1 | any | Below 1 there is nothing to show; this is an existence gate on a feed, not a claim about quality. |
| Any accepted Film Study observation exists | `pilot.shadow_film_study_proposals.athlete_id`, `.review_state = 'accepted'` | ≥ 1 | any | Same existence gate; `pending_review`/`rejected` rows never count toward this or appear anywhere in the athlete view. |
| Skill-rubric administrations (only reachable once an org has authored a protocol — see (a) finding and open question 1) | `pilot.assessments.athlete_id`, `.administered_on`, `.result` joined to `pilot.assessment_protocols` where `measure_kind = 'skill_rubric'` | ≥ 2 administrations of the same protocol lineage | spaced at least the protocol's own stored `retest_interval_days` / `retest_after_training_hours` apart (whatever the protocol itself carries — may be null, meaning no comparison can be shown, only the single raw result) | One point in time cannot show change. The spacing is never invented by this module — it is read from the human-authored protocol row, mirroring the assessment-protocols migration's own caution: *"Re-testing CMJ every two weeks produces measurement error that reads as improvement."* |

**PER ORG**

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| At least one `skill_rubric` protocol authored | `pilot.assessment_protocols` where `organization_id = X` and `measure_kind = 'skill_rubric'` and `active` | ≥ 1 | n/a | Org-level rubric content cannot exist at all until a human has defined, in a versioned and reliability-disclosed row, what "movement quality" means for this org. Today this count is zero in every org. |
| Athletes meeting the per-athlete skill-rubric gate, before any org-level coverage view is shown | `count(distinct athlete_id)` meeting the per-athlete rubric gate above, scoped by `organization_id` | OWNER_DECISION (suggested floor: ≥ 5, matching the small-cell-suppression convention already proposed for modules 017/021) | current rolling window | Below a small-N floor, an org-level "N athletes have rubric data" count risks re-identifying a specific athlete in a small gym roster — the same suppression concern the board/public aggregate rules already apply elsewhere in this platform. |

Both the ≥ 5 org floor and whether an org-level view should exist at all are marked OWNER_DECISION and repeated as open question 3 below — they encode a coaching/privacy judgment call, not a mathematical fact.

## (c) LOCKED state

Before the per-athlete thresholds in (b) are met, the athlete and their coach see, on the athlete's own record only:

- "**0 of 1** coach observations logged for [athlete]. Action: a coach records an observation using the existing observation-capture flow (`coach/decision-loop`'s note form, or the equivalent domain-upsert path) during or after a session." Once one exists, the feed itself is the unlock — there is no higher threshold for this signal, since it is a feed, not a comparison.
- "**0 of 1** human-reviewed Film Study observations available. Action: submit game film for Film Study review; a coach must accept the AI's proposal before it appears here — proposals awaiting review or declined stay invisible."
- If no `skill_rubric` protocol exists for the org: "Movement-quality rubric tracking is not available at [Org] — no rubric protocol has been authored yet (see open question 1)." If a protocol exists but this athlete has fewer than 2 administrations: "**1 of 2** recorded administrations of [protocol name]. Next eligible per protocol: [retest_interval_days/retest_after_training_hours, whichever the protocol stores]. Action: schedule the next administration."

Every count above is a real row count over a real, named threshold — never a percentage of an invented denominator, never a progress ring, never XP, points, levels, badges, or a streak counter. No variable reward, no "you're so close" urgency copy, no FOMO timer, no notification cadence engineered to induce compulsive logging. The count exists only so the athlete/coach can see, factually, how far a specific real record is from being interpretable — pride in one's own record, not a game loop, matching modules 020/026/017/021's identical pattern.

## (d) What unlocks

### At athlete level (own record only)

- The athlete's complete, unfiltered coach-observation feed for themselves (all `note_type`s, since no value is reserved for "movement" and inventing a filter would misrepresent what the feed actually contains).
- The athlete's complete accepted Film Study observation history, each entry linked to its source video and carrying its AI-provenance disclosure (`frames_analyzed`, `model_deployment`, who reviewed it and when).
- If, and only if, an org has authored a `skill_rubric` protocol and this athlete has ≥ 2 administrations on it: the athlete's own administration history for that protocol, always shown with the protocol's own reliability/validity/evidence-class strings attached to every comparison — never hidden, never summarized away.
- Drill reference text (`what_good_looks_like`/`what_bad_looks_like`/`coach_watch_point`) shown next to a relevant coach note about the same drill, as coaching-standard context, not as a score against the athlete.

### At org / coach level

- A coach viewing one of their own athletes sees exactly the same content that athlete would see about themselves, through the same existing access rules already governing athlete data elsewhere in this codebase — nothing new is granted, this module inherits the standing gate.
- If, and only if, an org has authored a `skill_rubric` protocol AND met the small-cell floor (open question 3): a roster-level **coverage** list — which athletes have how many rubric administrations on file, a real per-athlete count, never averaged, never converted into a rating or rank.

### Stays locked forever, regardless of data volume

- Any numeric movement-quality score, index, grade, or composite — no volume of coach notes, Film Study observations, or rubric administrations ever becomes an honest single number; more data answers "do we have enough to show honestly," never "should we now invent a metric we refused before."
- Any AI-derived scoring, tagging, category, or sentiment applied to Film Study `observation_text` or to coach-note free text, at any data volume — this is exactly BACKLOG-video-skill-scoring, permanently parked absent a new owner decision that this proposal does not make.
- Any technique-degradation frequency count — the occurrence log this would require does not exist and this proposal does not create one.
- Any cross-athlete comparison, ranking, or leaderboard on any signal in this module, at coach, org, or board level, at any data volume, forever.
- Any individual athlete's observation or rubric detail surfaced to board or public audiences — board/public receive, at most, the same small-cell-suppressed org coverage count already described, never a named athlete's content (standing playbook rule: board/public never receive individual athlete clinical detail).

## (e) Open questions for the owner

1. **Skill-rubric protocol authoring does not exist in the running app.** Every `assessment_protocols` row today came from a CSV seed, not from a coach/admin using the product, and no `measure_kind = 'skill_rubric'` row has ever been authored. Options:
   - **(a)** Build a minimal protocol-authoring API/UI inside this module's scope, so a coach/admin can define a `skill_rubric` protocol (name, `quality_measured`, `protocol_summary`, retest interval) before any rubric-based output can appear.
   - **(b)** Treat protocol authoring as its own separate ticket and scope Module 016's first slice to ONLY the coach-observation and Film Study outputs — the skill-rubric section stays visibly dark ("not available — no protocol authored") until authoring ships elsewhere.
   - **(c)** Do nothing here; let the skill-rubric section stay permanently dark until some future module builds authoring.
   - **Recommendation: (b)** — keeps this module's first PR bounded (playbook rule: one concern per PR, and 026's precedent of shipping vertical slices in numbered stages) while still making the module honest about why that section is empty rather than hiding it.

2. **Does 016 have work distinct from its adjacent `physicalTrainingSystem` siblings, or is this a shared design gap?** Module 017's own engine-unlock proposal (`docs/capabilities/proposals/engine-unlock/017-athleticism-engine.md`, open question 1) already flags that "13. Physical Capacity Engine," "16. Movement Quality Engine," "17. Athleticism Engine," and "18. Strength Development Engine" sit adjacent in the register, all equally DRAFT/`_unmapped_`, with no Intent recorded distinguishing any of them, and recommends a single consolidated design pass across all four before any one is built in isolation (matching the playbook's P3 rule that "advanced engines stay DEFERRED until design review"). Options:
   - **(a)** Build 016 now, scoped narrowly to "coach-observation feed + Film Study review history + optional org-authored skill rubric," accepting some future overlap-risk with 013/17/18 as a known tradeoff.
   - **(b)** Defer 016 alongside 013/17/18 for the single consolidated boundary-setting review 017's proposal already recommends, rather than resolving the same open question twice in two separate proposals.
   - **Recommendation: (b)** — this exact question has already been raised once, by a sibling proposal, and answering it independently here risks the two proposals reaching different boundaries for the same four-module cluster. One owner decision should settle all four at once.

3. **Org-level rubric coverage view: wanted at all, and at what small-cell floor?** This is the only place this module could show any org-level content, and it only exists once a `skill_rubric` protocol has been authored (open question 1). Options:
   - **(a)** Build it once the ≥ 5-athlete floor and a real protocol exist.
   - **(b)** Skip org-level entirely for this module — everything stays athlete/coach-per-athlete only, permanently.
   - **(c)** Defer the specific floor number to whatever modules 147/148 (board aggregates) eventually set, rather than this module inventing its own suppression number in isolation — the same deferral module 021's proposal recommends for its own org-level count.
   - **Recommendation: (c)** — avoids three separate modules each picking their own small-cell number ad hoc; wait for one reusable floor.

4. **`note_type` on `pilot.coach_observations` has no controlled vocabulary**, so Output 1 cannot distinguish "movement/technique" notes from any other coach note (only `'behavior_standard'` and `'parent_message'` exist in production use today, per existing app code comments). Options:
   - **(a)** Leave it as an undifferentiated full observation feed, as this proposal assumes.
   - **(b)** Add a new controlled `note_type` value (e.g. `'technique'`) via its own small, separately reviewed migration, so a coach can tag movement-relevant notes going forward — historical notes stay untagged.
   - **(c)** Do nothing; treat the undifferentiated feed as a permanent characteristic of this output.
   - **Recommendation: (a)** for this module's first slice, with (b) as a future, separately-scoped follow-up — `coach_observations` is a shared table other modules also read, and a new value there is its own reviewed change, not something to bundle into this proposal.

---

**Summary:** Module 016 would give an athlete and their coach an honest "own record" view built from three real sources — the athlete's coach-observation feed, their human-accepted Film Study review history, and (only if an org authors one) their skill-rubric assessment history — with no score, index, or AI judgment of movement quality anywhere, consistent with BACKLOG-video-skill-scoring staying parked. Its hardest prerequisite is that the skill-rubric pathway is schema-real but data-empty everywhere today, and no API exists yet to author a protocol at all — that gap has to be a separate decision (open question 1) before that third source can ever populate. The single most important owner question is whether 016 should be built in isolation at all right now, given that 017's own proposal already asked the owner to first hold one consolidated design review across the four adjacent, equally-undefined `physicalTrainingSystem` engines (013, 016, 017, 018) rather than resolving the same boundary question piecemeal.
