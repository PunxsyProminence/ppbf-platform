Status: DRAFT, not app source until handoff (RULES.md)

# Backbone data model (plan phase 2, step "Define core entities and ID scheme")

Draft for checkpoint 1. Written 2026-10-25 overnight; checkpoint-1 answers folded 2026-10-24
(US Eastern; table at the end). Approved by Jason at the checkpoint-1 review, 2026-10-24, with
entities.schema.json (D-RV06).
Repo read: `ppbf-platform` mirror at `6ab8f547` (read-only). Inputs: RULES.md, spine.json,
SCHEMA_PROPOSAL.md (P1-P14), REPO_INVENTORY.md, VALIDATION_REVIEW.md, DECISION_CHECKS.md.
Outside checks for every choice here are in DESIGN_CHECKS.md (section 1).
Machine-readable companion: entities.schema.json. Minted catalogs: design_catalogs.json.

## 1. What this file decides and what it does not

- It defines the core entities, their IDs and their links to the 18 spine stages.
- It reuses repo tables wherever they fit (RULES section 9, "backbone leads the app").
- It makes no owner decision. Checkpoint-1 answers (RULES section 9) are folded in; points
  found during the fold are parked in working/PARKING_LIST.md, not decided.
- Nothing here gates, blocks or moves a member. Gates and defaults inform; humans decide
  (RULES sections 0 and 1).

## 2. File format

- The repo's settled hand-off format is the content package contract
  (`docs/CONTENT_PACKAGE_CONTRACT.md`, generated from `contentImport/specs/`): one CSV per
  dataset, UTF-8, `|` inside list cells, `{{PPBF_ORG_ID}}` and `{{SEED_ACCOUNT_ID}}` placeholders,
  `new:<short-name>` for new items, ids minted by `content:prepare`. OBSERVED (read from the file).
- The contract refuses any column it does not define. Per-field status labels and sources
  (RULES section 10) therefore cannot travel in today's CSVs.
- Draft: backbone master files are JSON, one record per item, with labelled fields
  (`value`, `status`, `sources`), the same shape as spine.json. The hand-off step generates
  contract CSVs from them. The label columns the contract lacks are a proposed contract
  change (PROPOSED_CHANGES SP-11). INFERRED (our choice).
- No video, photo or audio goes into the repo or the backbone files (contract rule).
  Anchor clips live in the app's `video_sessions` (YOUTH_GATE_PROTOCOL.md section 6).

## 3. ID rule

### 3.1 The rule

R-ID-1. Catalog records use `<prefix>_<14 lowercase hex>`. The hex is the first 14
characters of SHA-256 over the record's identity string, after Unicode NFC and trimming.
This is the repo's own rule (`apps/web/src/server/pilot/contentImport/ids.ts`, `hex14`).
I re-ran it against the committed seed rows: drills 119/119, workout templates 12/12,
template items 82/82 match. OBSERVED.

R-ID-2. Version 1's id is the lineage id. Version n (n >= 2) is
`<prefix>_` + hex14(lineage_id + '#v' + n), with `supersedes_<entity>_id` pointing to the
previous version and `superseded_at` set on it (repo `drillVersion` rule). OBSERVED in code.

R-ID-3. A revised item keeps its id, even if renamed. A new item enters a hand-off as
`new:<short-name>`; `content:prepare` mints it. Ids are never reused or deleted; a retired
item is set `active = false`. OBSERVED (contract "Identity").

R-ID-4. App-created event rows (activities, exposure segments, load ratings, placements,
waivers, assessments, recommendations, notes) keep the repo's practice: random UUIDs, or
`propchg_<uuid>` for drill change proposals. OBSERVED (`activityLog.ts`,
`sparringExposure.ts`, `drillVersioning.ts`).

R-ID-5. Backbone fixture files (test athletes) must be reproducible, so their event rows use
UUIDv5: `uuid5(FIXTURE_NS, '<kind>:<label>')` with
`FIXTURE_NS = uuid5(NAMESPACE_DNS, 'fixtures.backbone.ppbf')`; test athletes use
`tat_` + hex14('test athlete:' + label). INFERRED (our choice).

R-ID-6. Every record carries `organization_id` (org-scoped like `competence_levels`).

R-ID-7. Stage keys (`Y1` ... `EX1`), rank keys (`R1`-`R6`), assessment protocol ids
(`A5-T01` shape) and research claim ids (`A1-001` shape) keep their existing human-readable
forms. They carry meaning; the hash ids do not. Mixed on purpose: stage keys are owner
decisions (RULES section 9). INFERRED.

### 3.2 Prefixes

Reused (OBSERVED in `ids.ts` and the contract):

| Prefix | Entity | Identity string |
|---|---|---|
| `drl` | drill (and exercise, D-Q19) | discipline + ':' + name |
| `wtp` | workout template (session plan) | name |
| `wti` | template item | template_id + ':' + ordinal |
| `scr` | session script | discipline + ':' + name (new items) |
| `blk` | session script block | script_id + block_order |
| `rnd` | script rendering | script_id + format |
| `scl`, `stp`, `cue` | drill scale level, stop rule, cue | drill_id + ':' + level / ordinal / cue text |
| `ust` | universal stop rule | condition text |
| `txf` | transfer claim | target id + ':' + claim_kind + ':' + statement |
| `coh` | cohort | cohort_name |

New (proposed; none of these appears as an id prefix in the mirror: regex scan of 3864 code, SQL,
CSV, JSON and Markdown files; OBSERVED):

| Prefix | Entity | Identity string |
|---|---|---|
| `trk` | program / track | name |
| `trb` | training block (multi-week unit in a track) | track_id + ':' + block_order |
| `sci` | scorecard item | protocol_id + ':' + two-digit item number |
| `pgt` | phase gate | stage_key + ':' + gate_kind |
| `pgc` | gate criterion | gate_id + ':' + ordinal |
| `dft` | default rule | scope + ':' + default_key (scope = stage key or `lane:non_contact`) |
| `evi` | evidence item | source_key + ':' + statement |
| `acs` | anchor clip spec | scorecard_item_id + ':' + level + ':' + context class |
| `ctb` | contribution recorded in backbone files | target_kind + ':' + target + ':' + submitted_by + ':' + submitted_at |
| `tat` | test athlete (fixtures only) | 'test athlete:' + label |

Not used: `gate_` (repo safety gates use `gate_<org>_<key>`), `blk_` for training blocks
(taken by script blocks), `ath_` (test fixtures in repo unit tests use `ath_1`). OBSERVED.

New assessment protocols follow the repo's only protocol id shape (`[A-Z][A-Z0-9]-T\d{2}`).
Draft series `PP`: `PP-T01` Long Road 27-item technical scorecard, `PP-T02` DOC-027 cue
response and coachability rating. INFERRED; Claude Code confirms the series is free.

### 3.3 Collision risk (INFERRED arithmetic)

14 hex characters are 56 bits. Birthday bound for n records under one prefix:
10,000 records about 6.9e-10; 100,000 about 6.9e-08;
1,000,000 about 6.9e-06. `content:prepare` already refuses a new item whose
minted id equals a committed one (contract "Blocking problems"), so a collision is caught,
not silent.

## 4. Fields every record carries

| Field | Meaning | Source of the rule |
|---|---|---|
| `organization_id` | owning gym; `{{PPBF_ORG_ID}}` in files | repo contract |
| `<entity>_id` | id per section 3 | R-ID-1 to R-ID-7 |
| `lineage_id`, `version`, `supersedes_<entity>_id`, `superseded_at` | versioning where the repo versions the record | repo drill, template, script, protocol tables |
| `active` | retired items stay, set false | repo |
| `status` | OBSERVED / REPORTED / INFERRED / UNVERIFIED for the record | RULES section 10 |
| `sources` | source keys (DOC-, LR-, EXT-, Jason date) | RULES section 10 |
| `field_labels` | per-field status and sources (jsonb) | RULES section 10; proposed column (SP-1) |
| `field_provenance` | how the content was authored (repo label; drill_library allows 4 values) | repo |
| `source_ref`, `content_class` | free-text origin and content class | repo |
| `contact_level` | most contact involved (5-level repo vocabulary) | repo |
| `stage_keys` | spine stages the item serves (link table, section 6) | this model |
| `evidence` | category, label, check state, evidence item ids | EVIDENCE_VOCABULARY.md |
| `backbone_version` | the backbone release that seeded it | SCHEMA_PROPOSAL principle 4 |

Correction found while checking: SCHEMA_PROPOSAL principle 3 says `field_provenance` is a
jsonb per-field pattern. In the migrations it is one text label per drill with a check
constraint (`drill_library_v3`, `drill_owner_authored_label`). OBSERVED. Per-field labels
need the new `field_labels` column (PROPOSED_CHANGES SP-1).

## 5. Core entities

Each entry: what it is, where it lives, its id, the links it carries.

1. Exercise. A single strength, conditioning or movement exercise (deadlift, chin-up,
   30-15 IFT run). Decided (D-Q19): a `drill_library` row with discipline `conditioning` or
   `general` and category `exercise` (the discipline check already allows both); no separate
   exercise table. Id `drl_`. Links: stage keys, assessment protocols it feeds.
2. Drill. `drill_library` v3 with cues, scale levels A/B/C and stop rules, reused as is.
   Id `drl_`, versioned. Adds: stage links, scorecard item ids it trains, `field_labels`,
   evidence ids beside `grounding_claim_ids`. The 114 AI-drafted seed drills keep their
   rank below owner content (RULES section 9).
3. Session. Two reused shapes: a plan (`workout_templates` + items, `wtp_`/`wti_`) and a
   scripted delivery (`session_scripts` + blocks + renderings, `scr_`/`blk_`/`rnd_`).
   Adds a stage link (P9). Delivered sessions stay events: `activity_log`,
   `session_script_runs`.
4. Training block. New `pilot.track_blocks` (`trb_`): an ordered multi-week unit inside a
   track, listing sessions by week and day. A member's instance reuses
   `athlete_development_blocks` with a new nullable `source_track_block_id` (SP-9). The
   repo's block table stores a coach's plan and computes nothing; that is kept.
5. Program / track. New `pilot.training_tracks` (`trk_`): name, lane, recreation track
   (contact or fitness), duration, stage links. The 8-Week Non-Contact Program becomes the
   first track (FT1, all ages; Jason 2026-10-24). Enrollment groups stay in `programs` and
   `program_memberships` (they are groups such as "Junior Boxing", not curricula).
6. Assessment / test. `assessment_protocols` reused; results in `pilot.assessments`, which
   already has `protocol_id`, `second_rater_account_id`, `second_rater_result` and the
   `reliability_study` administration kind. OBSERVED. Ids `A5-T01` shape.
7. Scorecard item. New `pilot.scorecard_items` (P6), `sci_`. The 27 Long Road items
   (Part 2 section 3.2) plus the DOC-027 cue-response rating. Each item lists the contexts
   it can be scored in. Full list with ids: YOUTH_GATE_PROTOCOL.md section 2.
8. Phase gate. New `pilot.pathway_gates` and `pathway_gate_criteria` (P5), `pgt_`/`pgc_`.
   One entry and one exit gate per stage, plus a Y2 contact-readiness gate taken from the
   Y2 exit text (D-Q23). Criterion kinds: `scorecard_min`, `stage_completed`, `gate_met`,
   `bout_count`, `assessment_min`, `text`. The app shows met, not met, not scored, single
   rater, scored in another context, or consensus re-score needed (D-Q03). It never moves
   anyone. 37 gates and
   54 criteria are minted in design_catalogs.json
   (Appendix A).
9. Evidence item. New `pilot.backbone_evidence_items` (`evi_`): one statement from one
   source, with category, repo evidence class, authority tier, boxing specificity, study
   design, the Synthesis tag if any, and the check state (unchecked, verified, corrected,
   not found). Six provenance fields (SP-10; D-PK16): source version and access date,
   support location, population, estimate and uncertainty, limitations, and reviewer and date
   (the date is the check date); inference class is not included. Links to the records it supports. The
   repo's `shadow_evidence_*` tables hold
   per-chat citation bundles keyed by conversation; they are not a claim catalog, so they
   are not reused for this (OBSERVED from the migration; this refines REPO_INVENTORY's
   "Good" fit). Research registry claim ids (`A1-001`) stay as links.
   Status (2026-11-10, D-PK12; ACTIONS A-74): a seventh provenance field, inference class (`inference_class`: descriptive, associative, causal, theoretical or proposed), is added (Jason 2026-11-08, PK-12 option B, reopening D-PK16 on that point); entities.schema.json evidence_item carries it.
10. Default rule. New `pilot.pathway_stage_defaults` (P7), `dft_`. Scope (stage or lane),
    key, kind (default rule, reference, owner rule, rule reference, information), value
    fields (number, min, max, text, unit, window, sparring type), display text, evidence
    category, override rule. 152 records: 104 minted from the 55 spine default entries, the
    18 stage contact defaults and the non-contact lane, plus 48 LR-140 ceiling rows on the 8
    stages D-Q15 added (DEFAULTS_AND_CONTRIBUTIONS.md).
    Overrides: `athlete_default_overrides` (P7); only `default_rule` rows can be overridden
    per athlete (D-Q24).
11. Contribution. Drills reuse `drill_change_proposals` (`propchg_<uuid>`; states proposed,
    under_review, adopted, declined, superseded). Other content needs the same shape with a
    `target_kind`, plus `acting_as_proxy` and `proxy_for_account_id` for the approval proxy
    (SP-8). Personal versions (D-Q17): `scope` personal, `review_state` `not_required` (no
    approval), `owner_account_id` the member, or the coach for a coach's own version; visible
    to the member and their coaches; the AI uses a member's personal version only for that
    member. Workflow: DEFAULTS_AND_CONTRIBUTIONS.md part B.

Supporting entities used by the model and the test athletes:

- Stage, stage link, rank, rank history, decision request: P1, P2, P13, P5. Decision
  requests cover every direction: moving up early, holding back after a gate is met, moving
  back down a stage, rank award and rank demotion (D-Q12). Each stores the pick-list reason
  keys R01-R16 or R99 and their directions UP, HOLD, DOWN, MOVE (D-Q13).
- Override reason sets (D-X02; schema P21): `override_reason_sets` (set version, approved by,
  approved on) and `override_reasons` (set version, key, label, directions, basis,
  retired_on). The list is editable by the owner and versioned; retired codes stay readable;
  each override stores the set version it used; a later "what actually happened" reason is a
  separate row and never overwrites the original; usage review at about 3 months.
- Placement: `athlete_pathway_stages` widened (P3) with `lane` and `track`.
- Membership and program: reuse `club_members.membership_type`, whose four values already
  match USA Boxing membership types (athlete, non_athlete, junior_fitness_non_contact,
  adult_fitness_non_contact), plus a new `masters` value that the Masters check reads
  directly (D-Q20; SP-3). USA Boxing membership for club training and sparring is Rule 1.2
  in the 2026 rule book (D-X04). Also reuse `programs`/`program_memberships` for "USA Boxing program"
  versus other programs (SP-3, replaces most of P12's new columns). OBSERVED that the table
  exists; the reuse is INFERRED.
- Signed documents: reuse `pilot.waivers` (`waiver_type`, `signed_by_role`, `signed_at`,
  `consent_version`, `status`; today general, medical_release, photo_media, travel) with
  added types for release, risk acknowledgment and research consent (SP-4, replaces P14's
  new table).
- Physicals: new `athlete_physicals` (kind usab_athlete, usab_masters, commission_annual;
  exam date; signer type; graded exercise EKG date). The app stores the physical's details,
  not the document (USA Boxing Rule 5.1(4), 2026; D-X04). `medical_intake.clearance_status`
  has no exam date; the clearance register is keyed to accounts, which minors may lack
  (SP-5). INFERRED.
- App note events: P14 `app_note_events`, for the eight note keys in spine.json
  (`no_current_physical`, `under_8_contact`, `not_covered_usab`, `usab_pairing`,
  `masters_check`, `pro_override_docs`, `usab_incident_report`, `usab_medical_restriction`).
- Hard incidents (D-X01; schema P20): `pilot.sparring_incidents`, one row per incident on a
  sparring segment: incident type H1 harder_than_agreed, H2 knockdown_or_count, H3
  stopped_head_or_suspected_concussion, H4 first_aid_injury, H5 etiquette_breach, H6
  gear_failure; involved (athlete, partner, both); body_area (IOC 2020 categories); days_lost
  (filled at follow-up); coach note; follow-up note; `usab_report_filed_on` (nullable, filled
  by the one tap on the `usab_incident_report` note, D-X03); recorded by, recorded at. Round,
  partner and, for H3, `stopped_early` and `stop_reason` come from the existing segment row.
  `mouthpiece_worn` (yes, no, unknown) is added to `pilot.sparring_exposure` beside
  `headgear_worn`. Never holds a save (D-Q16: hard incidents recorded).
- Medical restrictions (D-X03; schema P22): `pilot.medical_restrictions` (restriction id,
  athlete, source: ringside restriction affidavit, training knockout or concussion, or other;
  loss of consciousness: none, under 1 minute, over 1 minute, unknown; start date; minimum
  end date; physician clearance or medical release signed on; LBC informed on; linked
  incident id, nullable; note; recorded by, recorded at). Drives the
  `usab_medical_restriction` note. Never holds a save.
- Recommendation: reuse `shadow_recommendations` (status provisional, accepted, rejected,
  expired, superseded) and add the change B fields (section 8, SP-7).

## 6. Links to the spine

- Every content record links to one or more stage keys through
  `content_stage_links(target_kind, target_lineage_id, stage_key, role, lane)`, with role
  `core`, `optional` or `remedial`. A link table, not a column, because one drill serves many
  stages (P9 allows the same choice for sessions). INFERRED.
- Links name the lineage id, so a new version keeps its links (repo rule: packages name the
  lineage).
- Links describe the map. They never restrict where a coach places a member or what a
  coach runs (P2 principle).

| Stage key | PPBF name | Descriptor | Segment |
|---|---|---|---|
| `Y1` | AURORA | Introduction / Movement & Coordination | youth |
| `Y2` | ORIENS | Foundations | youth |
| `Y3` | CRESCENS | Technical Development | youth |
| `Y4` | LUCENS | Tactical Development | youth |
| `Y5` | ARDENS | Competition Readiness | youth |
| `T1` | RADIX | Foundation | trunk |
| `T2` | SURGENS | Competitive Amateur | trunk |
| `AM1` | EMINENS | National Amateur | amateur |
| `AM2` | EXCELSIOR | International Amateur | amateur |
| `AM3` | PERENNIS | Masters (USA Boxing definition) | amateur |
| `PR1` | DIABASIS | Amateur-to-Pro Transition | pro |
| `PR2` | AGON | Early Pro / Debut | pro |
| `PR3` | KLIMAX | Developmental Pro | pro |
| `PR4` | KLEOS | Prospect | pro |
| `PR5` | AKME | Contender | pro |
| `RC1` | CONSTANS | Recreational Boxing (Lifelong) | recreational |
| `FT1` | EUEXIA | Fitness (Lifelong, non-contact) | recreational |
| `EX1` | LUMEN | Exit: Retirement & Transition | exit |

## 7. Per-athlete exposure record (change A)

Reuses the two existing tables without change, adds bouts, and reads them through one view.

`pilot.sparring_exposure` (one row per sparring segment; columns verbatim): organization_id,
exposure_id, activity_id, athlete_id, segment_number, sparring_type (hard, play, technical,
game, conditioned), time_under_impact_sec (1-1800), round_equivalent, partner_athlete_id,
headgear_worn, glove_oz (8-20), coach_observed_intensity (light, moderate, firm, unclear),
coach_observed_head_contact (none, incidental, regular, frequent, unclear),
athlete_presentation, coach_note, supervising_coach_account_id, stopped_early,
stop_rule_id, stop_reason, device_type, device_event_count, device_note, created_at.
OBSERVED (`pilot_slice_postgres_sparring_exposure_and_load_migration.sql`). Schema P20 adds
`mouthpiece_worn` (D-X01).

`pilot.session_load` (one row per athlete per session per rater): load_id, activity_id,
athlete_id, rpe_physical, rpe_cognitive (0-10, CR10), rated_by (athlete, coach_proxy),
minutes_at_rating, next_session_quality, next_session_activity_id, note. OBSERVED.

`bout_records` (P8, new): athlete, entry (nullable), date, sanctioning body, scheduled
rounds, round length, rounds completed, result, method, headgear, glove weight, post-bout
presentation, coach note, outside suspension (recorded as reported).

Exposure view (derived, never stored), per athlete, for the last 7 and 28 days:
rounds by sparring type (sum of `round_equivalent`; play, technical, game and conditioned
rounds are counts with no numeric default, D-Q16), hard rounds, time under impact by type,
sparring sessions (distinct activities with a segment), sparring on consecutive days,
bouts and bout rounds, last hard sparring date, next bout date and the days between.

Comparison lines. The view sets each count beside the matching default for the athlete's
stage, as text with the default's category ("Hard rounds, last 7 days: 7 against a default
of at most 8 (coaching convention, untiered)"). The test athletes show real output
(TEST_ATHLETES.md).

Kept from the repo: no damage score, no cumulative risk index, no clearance, derived load
(sRPE x minutes) computed in queries only. The table comment "round_equivalent ... never a
risk input" changes under D4 (P7 already says so). The logging screen should ask for rounds
so `round_equivalent` is filled. OBSERVED / REPORTED from P7.

Contact work for notes (D-Q01): notes fire on sparring only: a sparring segment, or an
activity logged at contact level `controlled_sparring` or `open_sparring`. A light
partner-touch drill (`light_technical`) fires no note. `activity_log` has no contact level,
so a session logged as controlled or open sparring without a segment still needs
`logged_contact_level` (SP-14, accepted narrowed at the checkpoint-1 review: only for sessions
logged as controlled or open sparring without a sparring segment; D-SP14).

## 8. Recommendation record (change B)

Every recommendation the AI shows carries: the text; the record status; one evidence line
per claim (claim, evidence label, category, check state, status, sources); reasons;
alternatives; the defaults it touches with their values and categories; the app notes that
apply; and the line "The coach decides." Stored in `shadow_recommendations` with added
columns (SP-7). The test athletes use exactly this shape (test_athletes.json).

## 9. Status labels on records

- Catalog records take the status of their source field in spine.json or the source file.
- Hypothetical fixtures are INFERRED with the source "hypothetical fixture (RULES section 8)".
- Owner decisions copied from RULES section 9 are OBSERVED only where RULES marks them as
  Jason's direct decisions; citations of RULES text stay REPORTED until checked (RULES 10).

## Appendix A. Gates minted

| gate_id | Stage | Kind | Criteria | Criterion kinds | Status |
|---|---|---|---|---|---|
| `pgt_b545a5ba64f114` | Y1 | entry | 1 | text | REPORTED |
| `pgt_944bba61650719` | Y1 | exit | 2 | scorecard_min | INFERRED |
| `pgt_b8bd3b54a6ac7c` | Y2 | entry | 2 | stage_completed, text | INFERRED |
| `pgt_34a117b8a5d5fe` | Y2 | contact_readiness | 3 | scorecard_min, text | INFERRED |
| `pgt_4f54f18d29e3f0` | Y2 | exit | 2 | scorecard_min | INFERRED |
| `pgt_6a69c6ebbcca7e` | Y3 | entry | 2 | stage_completed, text | REPORTED |
| `pgt_8c36593d24ce64` | Y3 | exit | 2 | scorecard_min | INFERRED |
| `pgt_fcf8442ea42591` | Y4 | entry | 2 | stage_completed, text | REPORTED |
| `pgt_729acfc334f86d` | Y4 | exit | 1 | scorecard_min | INFERRED |
| `pgt_db9ff260c79eba` | Y5 | entry | 2 | stage_completed, text | REPORTED |
| `pgt_7c36e2b11e5881` | Y5 | exit | 2 | scorecard_min | REPORTED |
| `pgt_31286d5a015512` | T1 | entry | 1 | text | REPORTED |
| `pgt_b2023fc2fea6e0` | T1 | exit | 5 | bout_count, scorecard_min, text | REPORTED |
| `pgt_22d5c42259c035` | T2 | entry | 1 | gate_met | REPORTED |
| `pgt_dde8879b1fe827` | T2 | exit | 4 | bout_count, scorecard_min, text | REPORTED |
| `pgt_32830be780e897` | AM1 | entry | 1 | text | REPORTED |
| `pgt_3d70f81db05948` | AM1 | exit | 1 | text | REPORTED |
| `pgt_03b1e6d84022f0` | AM2 | entry | 1 | text | REPORTED |
| `pgt_fc23e8f3d2438e` | AM2 | exit | 1 | text | REPORTED |
| `pgt_22e07cfc6ca66b` | AM3 | entry | 1 | text | REPORTED |
| `pgt_f59213c42cb258` | AM3 | exit | 1 | text | REPORTED |
| `pgt_c1e76b857144e8` | PR1 | entry | 1 | text | REPORTED |
| `pgt_3da54d27baa705` | PR1 | exit | 1 | text | REPORTED |
| `pgt_11353fdd16de6c` | PR2 | entry | 1 | text | REPORTED |
| `pgt_5ac542ea85c284` | PR2 | exit | 1 | text | REPORTED |
| `pgt_767a2551063b1e` | PR3 | entry | 1 | text | REPORTED |
| `pgt_d163a7906eaf4f` | PR3 | exit | 1 | text | REPORTED |
| `pgt_d22ec5282fe33e` | PR4 | entry | 1 | text | REPORTED |
| `pgt_3af9ebeb3574b3` | PR4 | exit | 1 | text | REPORTED |
| `pgt_072faca036fe4a` | PR5 | entry | 1 | text | REPORTED |
| `pgt_ba40a12c3f4949` | PR5 | exit | 1 | text | REPORTED |
| `pgt_cd9bac1b542694` | RC1 | entry | 1 | text | INFERRED |
| `pgt_6db54ae7a3cf0c` | RC1 | exit | 1 | text | REPORTED |
| `pgt_9363bdf87a20d8` | FT1 | entry | 1 | text | INFERRED |
| `pgt_d37ccf02ad0a29` | FT1 | exit | 1 | text | INFERRED |
| `pgt_6de35e8f137a8f` | EX1 | entry | 1 | text | REPORTED |
| `pgt_38a860c063cdb7` | EX1 | exit | 1 | text | INFERRED |

## Decisions applied (checkpoint 1)

Folded 2026-10-24 (US Eastern; decision records labelled 2026-10-25). Register:
working/drift/DECISION_REGISTER.json. Machine-readable changes are in entities.schema.json.
D-SP14, D-RV06 and D-PK16 added 2026-10-24 (checkpoint-1 review and follow-ups, register v1.4
and v1.5).

| D-ID | Decision (register wording) | Where applied in this file |
|---|---|---|
| D-Q12 | Override process applies in every direction: move early, hold back, stage regression, rank demotion | Section 5, supporting entities (decision request) |
| D-Q13 | Standard pick-list R01-R16 plus R99 (GATE_OVERRIDE_PICKLIST.md) | Section 5, supporting entities (decision request) |
| D-Q16 | No numbers for non-hard types; counts; hard-incident log; etiquette doc | Section 5 (hard incidents); section 7 exposure view |
| D-Q17 | Personal versions need no approval; coaches may keep them too | Section 5 entity 11 |
| D-Q19 | Exercises are drill-library rows, category exercise | Section 3.2 prefixes; section 5 entity 1 |
| D-Q20 | Add a masters membership value | Section 5, membership |
| D-X01 | Hard-incident log H1-H6 with body area, days lost, mouthpiece worn, report-filed date (schema P20) | Section 5 (hard incidents); section 7 |
| D-X02 | Pick-list editable and versioned; original reason kept; 3-month review (schema P21) | Section 5 (override reason sets) |
| D-X03 | USA Boxing incident-report note on H2-H4 and medical-restriction note with records (schema P22) | Section 5 (app note events, hard incidents, medical restrictions) |
| D-X04 | USA Boxing 2026: membership is Rule 1.2; physicals stored as details, not documents | Section 5 (membership, physicals) |
| D-SP14 | activity_log.logged_contact_level, accepted narrowed | Section 7 (contact work for notes) |
| D-RV06 | Data model approved (DATA_MODEL.md, entities.schema.json) | Opening paragraph |
| D-PK16 | Evidence item carries the six SP-10 provenance fields; inference class stays out | Section 5 entity 9 |
| D-PK12 | Evidence item adds inference_class, reopening D-PK16 on that point (recorded here 2026-11-10) | Section 5 entity 9 |
