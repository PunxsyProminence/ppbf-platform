Status: DRAFT, not app source until handoff (RULES.md)

# Pathway schema change proposal

For: Claude Code. Approved by Jason at checkpoint 1 ("Owner review of data model", 2026-10-24)
with the accepted corrections (PROPOSED_CHANGES SP-1 to SP-15; register D-SP01 to D-SP15, D-RV07).
Handoff order (Jason, 2026-10-24): Claude Code first does a read-only check of open pull requests,
reports any conflict with tables this proposal touches, and builds only after that. The docs
revamp stays after the backbone.
Repo state read: `ppbf-platform` at `6ab8f547`. Backbone source: `data/spine/spine.json`
(18 stages, 74 stage-to-stage links, 133 stage defaults after the LR-140 split; SP-6). The
defaults catalog (design_catalogs.json) holds 152 rows: those 133, the 18 stage contact defaults
and one non-contact-lane row.

## In plain terms (for Jason)

The app today knows four adult stages (Foundation, Intermediate, Advanced, Elite) and
is coded as adults-only. The spine has 18 stages from age 5 to retirement, branches
(amateur, pro, recreational, fitness), a non-contact lane, numeric youth gates and
stage defaults. This proposal adds the tables to hold all of that, keeps the app's
good parts (coach-set placement with history, coach-confirmed goals, contact caps,
holds, the sparring exposure log), and changes nothing about who decides: a coach
still sets every placement. Gates and defaults only inform.

**Owner decisions (Jason, 2026-10-24; OBSERVED; recorded in RULES section 9):**
- D1. The spine replaces the four adult stages (supersedes the 2026-10-03 "Use as-is").
- D2. Foundation to T1, Intermediate to T2, Advanced to AM1, Elite to AM2.
- D3. No allowance for youth, fitness and recreational stages; a coach note elsewhere.
- D4. Sparring defaults in rounds, per sparring type, not hard rounds only.
- D5. A short required reason when a coach places against the gate result.

## Principles

1. Backbone leads; changes are additive migrations, existing history is kept.
2. Placement stays coach-set. Nothing computes or changes a stage on its own. The
   rule in `adultPathwayStages.ts` that a stage object holds no thresholds is kept:
   thresholds live in gate tables and produce an indicator a coach sees.
3. Every catalog row carries its status label (OBSERVED, REPORTED, INFERRED,
   UNVERIFIED) and source IDs, per field, in a new `field_labels jsonb` column on
   backbone-seeded catalogs (SP-1). `drill_library.field_provenance` is one text label per
   drill with a check constraint (4 values after the owner-authored migration), not a
   per-field jsonb pattern; it stays as is.
   Status (2026-11-10, PK-200 item 2, D-PK200-2; app crossover drift item 2): the data carries labels at three granularities: each spine stage's 8 text fields carry value, sources and status per field; the 74 next_stages links carry no label (a link's provenance is its backbone_version); the 2,918 default rows carry status and sources at record level, 572 of them also a field_labels object. No label was added.
4. Catalogs are organization-scoped like `competence_levels` and `safety_gates`,
   seeded from backbone files with a `backbone_version`. Personal-use accounts get
   the same seed. (Question for Claude Code: confirm org-scoping over one global catalog.)

## The stages to load

| Key | PPBF name | Descriptor | Segment | Order | Contact default | Defaults | Next stages |
|---|---|---|---|---|---|---|---|
| `Y1` | AURORA | Introduction / Movement & Coordination | youth | 1 | `none` | 1 | Y2, RC1, EX1, FT1 |
| `Y2` | ORIENS | Foundations | youth | 2 | `none` | 1 | Y3, RC1, EX1, FT1 |
| `Y3` | CRESCENS | Technical Development | youth | 3 | `light_technical` | 7 | Y4, RC1, EX1, FT1 |
| `Y4` | LUCENS | Tactical Development | youth | 4 | `conditioned` | 6 | Y5, RC1, EX1, FT1 |
| `Y5` | ARDENS | Competition Readiness | youth | 5 | `controlled_sparring` | 7 | T2, AM1, RC1, EX1, FT1 |
| `T1` | RADIX | Foundation | trunk | 6 | `light_technical` | 10 | T2, RC1, EX1, FT1 |
| `T2` | SURGENS | Competitive Amateur | trunk | 7 | `controlled_sparring` | 9 | AM1, PR1, RC1, AM3, EX1, FT1 |
| `AM1` | EMINENS | National Amateur | amateur | 8 | `open_sparring` | 7 | AM2, EX1, AM3, RC1, FT1 |
| `AM2` | EXCELSIOR | International Amateur | amateur | 9 | `open_sparring` | 8 | AM3, EX1, RC1, FT1 |
| `AM3` | PERENNIS | Masters (USA Boxing definition) | amateur | 10 | `controlled_sparring` | 7 | EX1, RC1, FT1 |
| `PR1` | DIABASIS | Amateur-to-Pro Transition | pro | 11 | `controlled_sparring` | 12 | PR2, RC1, EX1, FT1 |
| `PR2` | AGON | Early Pro / Debut | pro | 12 | `controlled_sparring` | 13 | PR3, RC1, EX1, FT1 |
| `PR3` | KLIMAX | Developmental Pro | pro | 13 | `controlled_sparring` | 11 | PR4, RC1, EX1, FT1 |
| `PR4` | KLEOS | Prospect | pro | 14 | `open_sparring` | 11 | PR5, RC1, EX1, FT1 |
| `PR5` | AKME | Contender | pro | 15 | `open_sparring` | 12 | EX1, RC1, FT1 |
| `RC1` | CONSTANS | Recreational Boxing (Lifelong) | recreational | 16 | `light_technical` | 8 | T1, T2, AM1, PR1, EX1, AM3, FT1 |
| `FT1` | EUEXIA | Fitness (Lifelong, non-contact) | recreational | 17 | `none` | 2 | RC1, T1, EX1 |
| `EX1` | LUMEN | Exit: Retirement & Transition | exit | 18 | `none` | 1 | RC1, FT1 |

All contact defaults use the repo's existing five-level vocabulary
(`none`, `light_technical`, `conditioned`, `controlled_sparring`, `open_sparring`).

## Changes

**P1. Stage catalog: `pilot.pathway_stages` (new).**
`organization_id`, `stage_key` (the spine key, e.g. `Y3`), `segment` (youth, trunk,
amateur, pro, recreational, exit), `ordinal`, `name`, `who_text`, `develops_text`,
`typical_duration_text`, `contact_default` (five-level check), `competition_text`,
`age_band_guide_text` (a guide, never a gate; see the placement rule),
`ppbf_name`, `ppbf_name_meaning`, `ppbf_name_language`, `field_labels` jsonb (SP-1),
`backbone_version`, `active_flag`. PK (`organization_id`, `stage_key`).

**P2. Stage links: `pilot.pathway_stage_links` (new).** (`from_stage_key`,
`to_stage_key`, `link_kind` in progression, branch, lateral, exit). Holds the
74 next-stage links, including branch points such as T2 to AM1, PR1, AM3,
RC1 and FT1. Links describe the map; they do not restrict where a coach places anyone.

**P3. Widen placement: `pilot.athlete_pathway_stages` (change).**
- Drop the four-value check on `stage_key`; add a foreign key to `pathway_stages`.
- Add `lane` (`standard`, `non_contact`), default `standard`, set by coach. The
  non-contact lane holds contact at `none` or `light_technical` at any stage.
- Map existing rows (D2): foundation to `T1`, intermediate to `T2`,
  advanced to `AM1`, elite to `AM2`. All current data is hypothetical.
- Add `end_reason` value `stage_changed` alongside `replaced` if Claude Code prefers
  to distinguish moves from corrections.

**P4. Stage goals catalog: `pilot.pathway_stage_goals` (new);
`athlete_pathway_checkpoints` (change).** Move the 14 hard-coded (stage, goal) pairs
into a catalog and replace the check with a foreign key. Existing goals move with
the D2 mapping. Youth and other stages get goals from the spine's `develops` field
during the wave 1 slice.

**P5. Gates: `pilot.pathway_gates` and `pilot.pathway_gate_criteria` (new).**
One entry and one exit gate per stage. Criteria types: `scorecard_min` (item IDs,
minimum score), `stage_completed`, `text` (prose a coach confirms). The app shows
each criterion as met, not met or not scored. It never moves anyone. Placing an athlete against the gate result opens an override request
(`pilot.progression_decision_requests`, new; kind gate_override): proposing coach; reason (gate preset key,
preset comments, open free-text script); head coach sanity check (approved or returned,
with note); the training meeting it was voted in; blind staff votes (voter, round,
vote, time) with a discussion note; the head coach's final decision, with a required
reason when it differs from the vote. The placement does not change until the final
decision is recorded (D5 as revised by Jason 2026-10-24). New pathway gate ids use `pgt_`;
repo safety gates keep `gate_<org>_<key>`, unchanged (SP-13).

**P6. Scorecard and two-coach scoring (change C): `pilot.scorecard_items`,
`pilot.scorecard_ratings`, `pilot.rater_calibrations` (new).**
- Items: the Long Road 27-item technical scorecard (Part 2 section 3.3), 1-5 scale,
  with an optional anchor clip reference (reuse the existing video clip storage).
- Ratings: `athlete_id`, `item_key`, `score` 1-5, `rater_account_id`,
  `scoring_event_id` (groups one scoring session), `context` (live, constrained_live,
  drill, shadow, partner), `rated_on`, `note`.
- A view pairs two raters on the same athlete, item and event and reports the
  difference. Gate indicators use the decided rule (D-Q03): the mean of the two scores when
  they are within 1 point; otherwise the coaches discuss and re-score (PK-17).
- Calibrations: rater, date, anchor set, agreement with the reference scores.
- Reuse (SP-2): scoring event = `pilot.assessments` (has `protocol_id`,
  `second_rater_account_id`, `second_rater_result`, administration kind `reliability_study`).
  Anchor clips = `video_sessions` + `calibration_projects` / `calibration_clips` (time ranges,
  no copies) + a new `scorecard_anchor_clips` link (anchor_spec_id, calibration_clip_id,
  reference score, status candidate/gold/excluded). `calibration_clips.primary_sampling_reason`
  needs a value such as `scorecard_anchor`, or anchors use `other`. Ratings add
  `after_discussion` and `rater_calibration_current`.

**P7. Stage defaults with overrides: `pilot.pathway_stage_defaults`,
`pilot.athlete_default_overrides` (new).**
Status (2026-11-10, PK-200 item 1, D-PK200-1; app crossover drift item 1): the data is authoritative where this text differs: design_catalogs.json default_rules[] holds 2,918 rows with value_min (505) and value_max (427), not value_number, besides value_text (47) and unit (636), and also window_days (50), sparring_type (92), composite_parent (84) and phases (1). The wording below is unchanged.
- Defaults: `default_key`, `stage_key`, `value_number` or `value_text`, `unit`,
  `field_labels` (SP-1), evidence category and label (EVIDENCE_VOCABULARY.md, set at
  checkpoint 1; sparring ceilings are CONVENTION). Loads the 152 catalog rows: the 133 spine
  stage defaults, the 18 stage contact defaults and the non-contact lane (SP-6).
- Overrides: athlete, default, new value, `reason` (not blank), set by coach,
  parent-facing note optional, history kept like `athlete_contact_caps`. The existing
  per-athlete tables (`athlete_contact_caps`, `athlete_minor_limits`,
  `training_holds`) stay; the override table covers defaults they do not.
- D4 units (decided: rounds, per sparring type). Defaults are written as rounds per
  7 days for each sparring type the app already logs: `hard`, `play`, `technical`,
  `game` and `conditioned` (treated as Jason's "constraint-based sparring"; INFERRED
  match). The comparison uses `sparring_exposure.round_equivalent`, so its comment
  ("never a risk input") changes and the logging screen should ask for rounds.
  `time_under_impact_sec` is still logged alongside, for pattern spotting and research.
  The Long Road numbers cover hard sparring; other types start with no numeric
  default until the defaults step sets one.
- Units (SP-12): `athlete_contact_caps.max_hard_open_sessions_per_7_days` counts sessions;
  the D4 defaults count rounds per sparring type. Both stay; the exposure view shows each
  against its own unit.

**P8. Exposure (change A): keep `sparring_exposure` and `session_load`; add
`pilot.bout_records` (new).** The sparring log already records type, time under
impact, coach-observed intensity and head contact, and presentation. Bouts are not
logged: `external_competition_entries` only records entered or withdrawn. Proposed
fields: athlete, entry (nullable), date, sanctioning body (text), scheduled rounds,
round length, rounds completed, result, method (decision, stoppage, KO, DQ, other),
headgear, glove weight, post-bout presentation, coach note, and any suspension an
outside body issued (date and source, recorded as reported, never set by the app).
Add a per-athlete 7-day and 28-day exposure view (hard sessions, time under impact,
bouts) for the AI and for pattern spotting.

**P9. Sessions and templates linked to stages (change).** A link table
`pilot.content_stage_links` (`target_kind`, `target_lineage_id`, `stage_key`, `role`, `lane`)
links drills, templates, session scripts, tracks and exercises to stages (SP-15, accepted as a
link table). The free-text `phase` and `age_band` stay for display.

**P10. Under-18 placement (D3, decided).** Today any under-18 placement needs a coach
allowance (`athlete_pathway_minor_allowances`). Change: no allowance for youth
stages (Y1-Y5), FT1 and RC1. For other stages, a coach note records the reason,
using the same note as D5. The allowance table stays for history.

**P11. Code that changes with it.** `adultPathwayStages.ts` (rule 1, adults only, is
replaced by the stage catalog; rule 3, no thresholds on a stage, is kept),
`adultPathway.ts`, the coach adult-pathway route and `AdultPathwayPanel`, and their
tests, including `athletePathwayMigration.pg.test.ts`. `privacyTiers.ts` reads the
allowance and should be checked.

**P12. USA Boxing membership and professional status (new columns or table).** PPBF
is a registered USA Boxing club that also runs other programs; USA Boxing members spar
only with USA Boxing members (RULES section 9). Record per athlete: program (USA Boxing
or other), USA Boxing membership type (athlete, non-athlete, junior
fitness, adult fitness), member ID and status (active, or the USA Boxing statuses administrative hold, medical
suspension, in-progress, suspended; Rule 2.2.1, 2026), passbook status, expiry, date of the
last physical, its form type (athlete or Masters), signer credential and clearance (cleared
for contact or not), and whether the athlete has competed as a professional. The app stores
the physical's date and details, not the document image; USA Boxing keeps athlete physicals
out of its own passbook "to comply with federal regulations" (Rule 5.1(4), 2026). Whether any
health-privacy law reaches PPBF is a question for the attorney. The app shows a pairing note when a sparring
entry pairs a USA Boxing member with a non-member (including a professional); the
coach decides. Pro-default
overrides check P14 for a current signed release and risk acknowledgment. Recreation lane: `pilot.athlete_pathway_stages` gains `lane` and `track` columns (RC1 = Recreation/contact, FT1 = Recreation/fitness); the P14 insurance note fires when a fitness-membership athlete is logged for contact work.
Reuse (SP-3): membership type = `club_members.membership_type` (athlete, non_athlete,
junior_fitness_non_contact, adult_fitness_non_contact) plus a `masters` value (D-Q20); add
member id, expiry and passbook status; program = `programs` + `program_memberships`;
`competed_as_professional` is a new column. Physicals (SP-5): new `pilot.athlete_physicals`
(kind usab_athlete | usab_masters | commission_annual; exam date; signer type MD | DO | NP | PA;
graded exercise EKG date). `medical_intake.clearance_status` has no date, and the clearance
register is keyed to accounts, which minors may not have.

**P13. Rank ladder (new).** `pilot.pathway_ranks` (catalog: R1-R6, Latin name,
meaning, develops text, `field_labels` (SP-1)), `pilot.athlete_ranks` (history: rank,
awarded on, decision request id, superseded by), and `pilot.rank_domain_scores`
(athlete, domain, score, rater, scoring event; two raters as in P6). Rank decisions
reuse the override request table, generalized to `pilot.progression_decision_requests`
with a `kind` of gate_override or rank_advancement. A rank never changes a stage and a
stage never changes a rank.

**P14. Member agreements and insurance note (new).** `pilot.member_agreements`
(athlete, kind: release | risk_acknowledgment | research_consent, document version,
signer role: self | parent_1 | parent_2 | guardian, signed on, superseded by). The app
stores that a version was signed, not the document text. Research consent is its own
kind and never shares a document with the release. A derived insurance note uses P12:
it reads "not covered by USA Boxing insurance" when the athlete has no active USA Boxing
membership, has competed as a professional, holds a fitness membership and is logged
for contact work, or the activity is a Commission event. The same pattern gives "no current physical on file" (no physical within 12 months; any
stage) and "under 8" (any stage) when the member is logged for contact work, which for notes
means sparring: a sparring segment, or a session logged as controlled or open sparring (D-Q01,
D-Q02). Each note shows in full once per member per week, then as a badge (D-Q26) (PK-17). Shown notes are logged in
`pilot.app_note_events` (note key, athlete, session, shown at, seen by, seen at); the
one-tap "seen" fills the last two and never holds the save. Every note informs; none
blocks a save (RULES section 9).
Reuse (SP-4): signed documents use `pilot.waivers` (`waiver_type`, `signed_by_role`,
`signed_at`, `consent_version`, `status`) instead of a new `member_agreements` table. Add types
release (or confirm `general` is the release), risk_acknowledgment and research_consent; map
signer roles self, parent_1, parent_2, guardian to `signed_by_role`. Keep `app_note_events` as
proposed. Contact level for notes (SP-14, accepted narrowed): `activity_log.logged_contact_level`
(five-level vocabulary), so notes fire for a session logged as controlled_sparring or
open_sparring without a sparring segment.

**P15. Recommendation fields (change B; SP-7).** Add to `shadow_recommendations`:
`record_status`, `evidence jsonb` (claim, label, category, check state, status, sources),
`reasons jsonb`, `alternatives jsonb`, `default_refs`, `app_note_keys`, `stage_key`. Seeded-error
answer keys never enter the app.

**P16. Contributions (SP-8).** Add `target_kind` to `drill_change_proposals` or create
`content_change_proposals` (Claude Code chooses the shape); add `scope` (core, personal),
`owner_account_id`, `acting_as_proxy`, `proxy_for_account_id`, and `review_state` value
`not_required` for personal versions (D-Q17). A check that the proxy cannot approve their own
submission (D-Q18). The named proxy is the head coach (RULES section 9).

**P17. Training tracks (SP-9).** `training_tracks` (`trk_`), `track_blocks` (`trb_`),
`track_block_sessions`; `athlete_development_blocks.source_track_block_id` (nullable). First
use: the 8-week FT1 class track.

**P18. Backbone evidence items (SP-10).** `backbone_evidence_items` (`evi_`) and
`evidence_links`. Each evidence item carries six provenance fields (Jason, 2026-10-24, from the
claim-level provenance record in inputs/boxing-coach): source version and access date; support
location; population; estimate and uncertainty; limitations; reviewer and date. A seventh field,
inference class (`inference_class`), sits beside them (Jason, 2026-11-08, PK-12 option B,
reopening D-PK16's 'inference class stays out'; D-PK12): its value list is the one in the
Operational Gaps s4.2 'Claim-level provenance record' (inputs/boxing-coach), read and filled for
each checked claim by the evidence side job 'PPBF Side Job Evidence 2 Pass 2'; the app-side
schema change travels with the handoff. Add `evidence_category` to SHADOW library sources and
chunks so rule sources show RULE, not PROVEN; the D-Q25 display words ride on the same change. A
keyword match finds 94 registry claims naming a rulebook, regulation or statute (90 VERIFIED
EVIDENCE, 67 of those boxing-specific); provisional, authority tiers not read.

**P19. Content package contract (SP-11).** Add `field_labels`, `evidence` and `stage_keys`
columns (or a `content_stage_links` file) to each dataset spec; the contract refuses undefined
columns today.

**P20. Sparring hard incidents (new, approved 2026-10-25).** `pilot.sparring_incidents`
(incident id, exposure_id, incident type: H1 harder_than_agreed | H2 knockdown_or_count |
H3 stopped_head_or_suspected_concussion | H4 first_aid_injury | H5 etiquette_breach |
H6 gear_failure, involved athlete: athlete | partner | both, body_area (injuries; IOC 2020
Table 4: head, neck, shoulder, upper arm, elbow, forearm, wrist, hand, chest, thoracic spine,
lumbosacral, abdomen, hip/groin, thigh, knee, lower leg, ankle, foot, region unspecified,
multiple regions), days_lost (filled at follow-up; IOC 2020 time-loss count, same- or
next-day return = 0), coach note, follow-up note, usab_report_filed_on (nullable),
recorded by, recorded at). Adds `mouthpiece_worn` (yes | no | unknown) to the existing
`pilot.sparring_exposure` row, beside `headgear_worn` (USA Boxing insurance covers head and
face injuries only with mouthpiece and headgear). Reuses the segment row for round
(`segment_number`), partner (`partner_athlete_id`) and, for H3, `stopped_early` and
`stop_reason`. Never holds a save. An H3 entry shows the concussion information note (P12
pattern). Feeds override reason R10 and AI job 3.

**P21. Override reason sets (new, approved 2026-10-25).** `override_reason_sets` (set
version, approved by, approved on) and `override_reasons` (set version, key, label,
directions, basis, retired_on). Each override stores the reason keys and the set version.
A later "what actually happened" reason is added as its own row (reason key, set version,
added by, added on), never overwriting the original. Owner edits create a new set version;
retired codes stay readable. Usage review at about 3 months.

**P22. USA Boxing medical restrictions (new, approved 2026-10-25).** `pilot.medical_restrictions`
(restriction id, athlete, source: ringside restriction affidavit | training knockout or
concussion | other, loss of consciousness: none | under 1 minute | over 1 minute | unknown,
start date, minimum end date, physician clearance or medical release signed on, LBC informed
(or release sent to the LBC registration chair) on, linked incident id (P20, nullable), note, recorded by, recorded at).
Drives the `usab_medical_restriction` note (P12 pattern) when the member is logged for training
or sparring during the restriction, or after it with no release on file. P20's
`usab_report_filed_on` is approved (2026-10-25) and drives the `usab_incident_report` note.
Neither note holds a save. Source: USA Boxing Rule Book 2026: Rule 5.4(7) (written clearance from a qualified medical physician;
inform the LBC) and the Restriction Affidavit form in the appendix (personal physician's medical
release sent to the LBC registration chair).

## Not in this proposal

- Core entity and ID scheme for drills, sessions, programs and contributions:
  working/design-2026-10-25/DATA_MODEL.md (approved 2026-10-24).
- Evidence vocabulary: working/design-2026-10-25/EVIDENCE_VOCABULARY.md (set at checkpoint 1;
  RULES section 4).
- App behaviour that conflicts with RULES sections 0 and 1 (weight-cut refusals,
  non-overridable video refusals, unrecorded chokes on minors, block gates without
  override). Listed in RULES section 11, handed off separately.
