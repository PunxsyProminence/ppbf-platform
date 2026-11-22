#!/usr/bin/env node
// BACKBONE -> AMATEUR + PRO STAGE CONTENT (lane AP; OD-2026-11-15-006 ruling 2, OD-2026-11-17-005).
//
//   node scripts/backbone-export-amateur-pro.mjs <backbone-folder> [--out <seed-data folder>] [--allow-overwrite]
//
// The second stage lane: every frozen track, block and session whose stage_keys include an amateur
// (T1, T2, AM1-AM3) or pro (PR1-PR5) stage, are not exactly ["FT1"], and name no youth or RC1 stage
// (those went to lane YR: OD-2026-11-10-003 point 4, a record spanning groups goes in the first lane
// that uses it). Written as NEW rows of the committed packages:
//   workout-templates   66 templates (61 amateur, 5 pro) + 162 items
//   training-tracks     14 tracks (7 amateur, 7 pro) + 16 blocks + 498 block sessions
// --out defaults to apps/web/seed-data. Every committed row outside the set (FT1's, lane YR's, any
// other) is kept byte for byte, and a second run is byte-identical.
//
// The cell rules are lane YR's (backbone-export-youth-recreational.mjs, whose helpers this reuses):
// manifest-hashed reads, copy never reword, every record key to a column, into details or listed
// as not carried, research `quote` keys dropped (OD-2026-10-02-013 2A), owner passages carried
// (Q-208, RH-Q02 A), the overwrite guard. A count different from the brief's exits 2.
//
// HELD: none. Every source of the set is Jason's own (DOC-022, DOC-023 'PPBF owner-authored', D-PN10
// and Q-143; The Long Road; his rulings); outside material appears only as evidence citations.
//
// TWO STOPS NO FLAG PASSES (lane GD; lib/backbone-export-guards.mjs). A row this run would write
// that names a held DOC-136 record, or a committed template step that links a drill written back
// as a typed line, stops the export and nothing is written, with or without --allow-overwrite.
//
// DRAFTS (OD-2026-11-17-001, Jason: "B: AI drafts the values"). A blank session_type, difficulty,
// duration_minutes or intent is filled from DRAFTS below, by Overwatch's order of basis: the
// template's own content (INFERRED), else the same source document's sheet that matches its kind
// and contact structure (UNVERIFIED, naming the sheets and contrary values), else, where neither
// speaks to the activity, Jason's owner system (DOC-072/DOC-027) where it addresses the same activity
// (UNVERIFIED; Overwatch, lane AP Q-B). Difficulty takes the written templates' value at the same
// lowest stage, else the nearest written stage below. Each drafted field is
// labelled with the draft marker; a frozen label it replaces is kept inside as `backbone_label`.
// The export stops on a blank field with no draft, or a draft for a field the Backbone writes.
// Review sheet: docs/content-review/amateur-pro/TEMPLATE_DRAFTS_REVIEW.md (both reviewers, OD-2026-11-15-011).
//
// SPARRING MINUTES (OD-2026-11-17-002). An item above light_technical keeps its frozen minutes in
// details.duration_minutes with the column blank, as lane YR; timers and issuing never read them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CONTENT_DIRS,
  ExportError,
  ORG_PLACEHOLDER,
  boolCell,
  committedRows,
  compare,
  isObject,
  loadManifest,
  numberCell,
  readCsv,
  readDir,
  sha16,
  textCell,
  writeCsv,
} from './backbone-export-ft1-track.mjs';
import {
  FILES,
  HEADERS,
  KEYS as YR_KEYS,
  checkUniqueIds,
  describeOverwrites,
  detailsCell,
  findOverwrites,
  guardId,
  labelCells,
  sameId,
  sourcesCell,
  stripExcerpts,
} from './backbone-export-youth-recreational.mjs';
import { heldTextFindings, stopMessage, typedLineFindings } from './lib/backbone-export-guards.mjs';

export const AMATEUR_STAGES = ['T1', 'T2', 'AM1', 'AM2', 'AM3'];
export const PRO_STAGES = ['PR1', 'PR2', 'PR3', 'PR4', 'PR5'];
const YR_STAGES = ['Y1', 'Y2', 'Y3', 'Y4', 'Y5', 'RC1'];
export const EXPECTED_COUNTS = {
  tracks: 14, amateurTracks: 7, proTracks: 7, blocks: 16, blockSessions: 498, templates: 66, amateurTemplates: 61, proTemplates: 5, items: 162, heldTemplates: 0,
  quoteKeys: 193, ownerPassageLists: 22, ownerPassages: 202, sp10Sentences: 0, sparringMinutes: 3, drafts: 68,
};
// Blocks per track (Overwatch, lane AP step 1): two tracks carry no block_ids, so their blocks are
// taken by their own track_id and counted here.
export const BLOCKS_BY_TRACK = { trk_2e224d9fc9f63c: 3, trk_89c3ba325a7e0d: 2, trk_a5e16184502c0f: 8, trk_eaa2ecb5091bff: 3 };
export const HELD_TEMPLATES = {};

// Record keys by kind: lane YR's, plus the keys this set adds, all into details by Backbone name.
export const KEYS = {
  track: {
    ...YR_KEYS.track,
    details: [...YR_KEYS.track.details, 'alternative_week', 'archetype_block_rule', 'archetypes', 'at_90_days', 'before_training', 'block_use_rule', 'bottlenecks',
      'bout_day_session_ref', 'buffering_condition', 'camp_phase_rule', 'camp_structure', 'camp_track_ref', 'camp_weekly_emphasis_rule', 'competition',
      'conditioning_categories', 'defense_return_rule', 'defensive_layer_order_rule', 'deload_rule', 'example_session_refs', 'exchange_cap_rule', 'feint_rule',
      'first_bout', 'first_year_by_month', 'first_year_by_month_rule', 'lr068_drill_refs', 'phase_headings', 'phase_span', 'physical_training',
      'programming_character', 'score_awareness', 'sparring_by_block', 'sparring_ceilings', 'sparring_progression', 'sparring_progression_rule', 'sparring_rules',
      'taper', 'technical_priorities', 'technical_refinement', 'tier3_items', 'total_hard_rounds_rule', 'video_review_rule', 'weekly_template'],
  },
  block: {
    ...YR_KEYS.block,
    details: [...YR_KEYS.block.details, 'also', 'conditioning_categories', 'example_session_refs', 'expect', 'months_0_3_sessions_track_id', 'owner_passages',
      'pairing_note', 'placement_condition', 'placement_rule', 'plan_items', 'resistance_table', 'sparring_rule', 'taper_days', 'week_row'],
  },
  sessionRef: YR_KEYS.sessionRef,
  template: {
    ...YR_KEYS.template,
    details: [...YR_KEYS.template.details, 'archetype_role_rule', 'day_role', 'pass_fail', 'session_rule', 'source_evidence_grade', 'timing_rule'],
  },
  item: {
    ...YR_KEYS.item,
    details: [...YR_KEYS.item.details, 'long_road_slot', 'long_road_text', 'moved_from', 'order_note', 'slot', 'time_before'],
  },
};

const VOLUME_FREE_CONTACT = ['none', 'light_technical'];
const WRITTEN = [FILES.templates, FILES.items, FILES.tracks, FILES.blocks, FILES.sessions];

// ---- drafts (OD-2026-11-17-001) ----

export const DRAFT_MARK = 'AI draft, lane AP, 2026-11-17 (OD-2026-11-17-001)';
export const REVIEW_SHEET = 'docs/content-review/amateur-pro/TEMPLATE_DRAFTS_REVIEW.md';
export const DRAFT_FIELDS = ['session_type', 'difficulty', 'duration_minutes', 'intent'];
const DIFFICULTIES = ['beginner', 'intermediate', 'advanced', 'elite'];
const DRAFT_STATUSES = ['INFERRED', 'UNVERIFIED'];

// template_id -> field -> { value, status, basis, sheets[, caveat] }. A label's sources are the
// template's own sources, then the sheets, then the review sheet.
export const DRAFTS = {
  wtp_000d2b85b29bbb: {
    duration_minutes: { value: 60, status: "INFERRED", basis: "its own stated minutes: AM '45–60 min' (upper end)", sheets: [] },
  },
  wtp_060d401d23d474: {
    duration_minutes: { value: 90, status: "INFERRED", basis: "its own slot minutes: AM '50 min', PM '90 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 140", sheets: [] },
  },
  wtp_06679961df65bb: {
    duration_minutes: { value: 60, status: "INFERRED", basis: "its own slot minutes: AM '40 min', PM '60 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 100", sheets: [] },
  },
  wtp_10c6082f9d5089: {
    duration_minutes: { value: 75, status: "INFERRED", basis: "its own slot minutes: AM '40 min', PM '75 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 115", sheets: [] },
  },
  wtp_15fd46693aae7e: {
    duration_minutes: { value: 90, status: "INFERRED", basis: "its own stated minutes: AM '90 min'", sheets: [] },
  },
  wtp_1881d8b08576e5: {
    session_type: { value: "rest", status: "INFERRED", basis: "its day_role 'off day' and its own text 'Rest; optional 30 min easy movement | Weekly review with coach; film study 30 min'; no in-use session type fits a rest day, so 'rest' (Overwatch, lane AP Q4 A)", sheets: [] },
    duration_minutes: { value: 30, status: "INFERRED", basis: "its own slot minutes: AM '30 min', Midday '30 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 60", sheets: [] },
  },
  wtp_1e77dabdfa54f8: {
    session_type: { value: "rest", status: "INFERRED", basis: "its day_role 'recovery' and its own text 'Rest or 20 min mobility'; no in-use session type fits a rest day, so 'rest' (Overwatch, lane AP Q4 A)", sheets: [] },
  },
  wtp_23849b29f8592f: {
    session_type: { value: "rest", status: "INFERRED", basis: "its day_role 'off day' and its own text 'Full rest | Film study 45 min; nutrition prep for the week'; no in-use session type fits a rest day, so 'rest' (Overwatch, lane AP Q4 A)", sheets: [] },
    duration_minutes: { value: 45, status: "INFERRED", basis: "its own stated minutes: PM '45 min'", sheets: [] },
  },
  wtp_2759a2e4865091: {
    duration_minutes: { value: 90, status: "INFERRED", basis: "its own slot minutes: AM '45 min', Midday '20–40 min', PM '90 min' (upper end of a range); the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 175", sheets: [] },
  },
  wtp_3ba3110f2428d2: {
    difficulty: { value: "advanced", status: "UNVERIFIED", basis: "no template whose lowest stage is PR1-PR5 writes a difficulty (its own stage PR1 has only mitt templates A-E, all blank), so the nearest written stage below: every written template whose lowest stage is AM1 (9 of 9) or AM2 (7 of 7) is advanced; contrary: none ('elite' is unused) (Overwatch, lane AP: the written-template rule, nearest written stage below)", sheets: ["LR-073 (wtp_0b2bb48d17e3be, Phase 3 — Advanced — Strength session — Phase 3 maintenance, 55 min; lowest stage AM1, written difficulty advanced)", "LR-079 (wtp_060d401d23d474, Phase 4 — Elite / Champion-tier — Mid-camp week Tuesday; lowest stage AM2, written difficulty advanced)"] },
    duration_minutes: { value: 12, status: "UNVERIFIED", basis: "its own items give 6 rounds (Round 1 to Round 6) and no length, and its source documents DOC-023 and DOC-022 state no mitt round length; Jason's owner system DOC-072 Workout_Map runs pad work in 2:00 rounds (W-S10-007, equipment 'mitts or pads'): 6 x 2:00 = 12 (order of basis 3: the owner system where it addresses the same activity, OWNER_DECISIONS s3; Overwatch, lane AP Q-B); contrary: DOC-022's 'Pro contests can extend up to 12 x 3-minute rounds', 6 x 3 = 18. Caveat: pad round length from DOC-072 Workout_Map (W-S10-007); rest between rounds not counted; DOC-022 and DOC-023 state no mitt round length", sheets: ["DOC-072 W-S10-007 via trk_5ca8d83f2a1a66 (owner passage, Workout_Map \"SKILL-10 Body Attack After Defensive Trigger Session\": Equipment \"timer, partner/coach, mitts or pads, legal body target marker, cones/ring line, notebook\"; Rounds \"5-min setup; 3 x 2:00 single straight defend-return; 2 x 2:00 defend or exit; ...\")", "DOC-022 (trk_24e2dcbf4b0edc, group \"DOC-022 lines 123-184\", DIRECT CLAIM LIMITS: \"Pro contests can extend up to 12 x 3-minute rounds\")"], caveat: "pad round length from DOC-072 Workout_Map (W-S10-007); rest between rounds not counted; DOC-022 and DOC-023 state no mitt round length" },
  },
  wtp_43010f10a6b0b3: {
    intent: { value: "Restoration 40 min: low-load movement and aerobic restoration work | Boxing tactical 75 min: constrained live", status: "INFERRED", basis: "its own items' text joined by ' | ', the form its written sibling days use", sheets: [] },
    duration_minutes: { value: 75, status: "INFERRED", basis: "its own slot minutes: AM '40 min', PM '75 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 115", sheets: [] },
  },
  wtp_485b1e28f6cf9a: {
    session_type: { value: "rest", status: "INFERRED", basis: "its day_role 'off day' and its own text 'Full rest; weekly review; film study 20 min'; no in-use session type fits a rest day, so 'rest' (Overwatch, lane AP Q4 A)", sheets: [] },
  },
  wtp_4d509fa48087ab: {
    duration_minutes: { value: 90, status: "UNVERIFIED", basis: "its own items state no minutes ('Boxing + aerobic' -> Boxing skill 90); the same document's (The Long Road) written session sheet of the same kind, of the same contact structure and at T2 where one exists (Overwatch, lane AP Q2) (Boxing skill: the non_contact boxing-skill sheet is LR-051 (wtp_c2c4bec001a56b, T1); the T2 one, LR-218 (wtp_080c41583b3757), is contact; both 90)", sheets: ["LR-051 (wtp_c2c4bec001a56b, Phase 1 — Foundation / Novice — Boxing skill session, 90 minutes (months 3–9); T1/RC1, non_contact, written 90 min)", "LR-218 (wtp_080c41583b3757, Phase 2 — Competitive Amateur — Boxing skill session, 90 min (Phase 2–3, refinement); T2/AM1/RC1, contact, written 90 min)"] },
  },
  wtp_4d5eb0ed94d617: {
    intent: { value: "Strength 70 min: upper explosive + plyos | Boxing skill 75 min: pads, footwork", status: "INFERRED", basis: "its own items' text joined by ' | ', the form its written sibling days use", sheets: [] },
    duration_minutes: { value: 75, status: "INFERRED", basis: "its own slot minutes: AM '70 min', PM '75 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 145", sheets: [] },
  },
  wtp_52f7e4342df818: {
    duration_minutes: { value: 90, status: "UNVERIFIED", basis: "its own items state no minutes ('Buffering' -> Buffering 50, 'Boxing skill + fatigued technique' -> Boxing skill 90); the same document's (The Long Road) written session sheet of the same kind, of the same contact structure and at T2 where one exists (Overwatch, lane AP Q2) (Boxing skill: the non_contact boxing-skill sheet is LR-051 (wtp_c2c4bec001a56b, T1); the T2 one, LR-218 (wtp_080c41583b3757), is contact; both 90); the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 140", sheets: ["LR-061 (wtp_da83ce464ffa96, Phase 2 — Competitive Amateur — Buffering conditioning session, 50 min; T2/RC1, non_contact, written 50 min)", "LR-051 (wtp_c2c4bec001a56b, Phase 1 — Foundation / Novice — Boxing skill session, 90 minutes (months 3–9); T1/RC1, non_contact, written 90 min)", "LR-218 (wtp_080c41583b3757, Phase 2 — Competitive Amateur — Boxing skill session, 90 min (Phase 2–3, refinement); T2/AM1/RC1, contact, written 90 min)"] },
  },
  wtp_5303f3ce867b0c: {
    intent: { value: "Easy run 30–40 min | Strength 60–75 min: upper emphasis + MB ballistics + neck", status: "INFERRED", basis: "its own items' text joined by ' | ', the form its written sibling days use", sheets: [] },
    duration_minutes: { value: 75, status: "INFERRED", basis: "its own slot minutes: AM '30–40 min', PM '60–75 min' (upper end of a range); the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 115", sheets: [] },
  },
  wtp_53b2fb2632b55b: {
    duration_minutes: { value: 90, status: "UNVERIFIED", basis: "its own items state no minutes ('Boxing skill' -> Boxing skill 90); the same document's (The Long Road) written session sheet of the same kind, of the same contact structure and at T2 where one exists (Overwatch, lane AP Q2) (Boxing skill: the non_contact boxing-skill sheet is LR-051 (wtp_c2c4bec001a56b, T1); the T2 one, LR-218 (wtp_080c41583b3757), is contact; both 90)", sheets: ["LR-051 (wtp_c2c4bec001a56b, Phase 1 — Foundation / Novice — Boxing skill session, 90 minutes (months 3–9); T1/RC1, non_contact, written 90 min)", "LR-218 (wtp_080c41583b3757, Phase 2 — Competitive Amateur — Boxing skill session, 90 min (Phase 2–3, refinement); T2/AM1/RC1, contact, written 90 min)"] },
  },
  wtp_588adc80b308df: {
    duration_minutes: { value: 75, status: "INFERRED", basis: "its own slot minutes: AM '75 min', PM '40 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 115", sheets: [] },
  },
  wtp_5df3589b9085d2: {
    session_type: { value: "rest", status: "INFERRED", basis: "its only item is a rest block and its own text 'Rest'; no in-use session type fits a rest day, so 'rest' (Overwatch, lane AP Q4 A)", sheets: [] },
    duration_minutes: { value: 20, status: "UNVERIFIED", basis: "its own items state no minutes ('Rest' -> Rest 20); the same document's (The Long Road) written off days of the same contact structure, which write 20 (Overwatch, lane AP Q2)", sheets: ["LR-050 (wtp_84cb2cf887a94a, Phase 1 — Foundation / Novice — Scenario A Sunday; T1, non_contact, written 20 min)", "LR-050 (wtp_485b1e28f6cf9a, Phase 1 — Foundation / Novice — Scenario C Sunday; T1, non_contact, written 20 min)"] },
  },
  wtp_6664906527b540: {
    intent: { value: "Strength 70 min: lower, heavy | Boxing skill 75 min: refinement, bag", status: "INFERRED", basis: "its own items' text joined by ' | ', the form its written sibling days use", sheets: [] },
    duration_minutes: { value: 75, status: "INFERRED", basis: "its own slot minutes: AM '70 min', PM '75 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 145", sheets: [] },
  },
  wtp_66e85b0fc287ea: {
    duration_minutes: { value: 75, status: "UNVERIFIED", basis: "its own items state no minutes ('Strength A' -> Strength 75); the same document's (The Long Road) written session sheet of the same kind, of the same contact structure and at T2 where one exists (Overwatch, lane AP Q2); contrary: the other Long Road strength sheets, 70 (wtp_4346e280d811e3, \"Strength session B\"; wtp_363e43d4f3f870, T1) and 55 (wtp_0b2bb48d17e3be, AM1)", sheets: ["LR-061 (wtp_7069f515b9b84e, Phase 2 — Competitive Amateur — Strength session — lower-body emphasis, 75 min; T2/RC1, non_contact, written 75 min)", "LR-223 (wtp_4346e280d811e3, Strength session B — upper explosive + power, 70 min; T1/T2/AM1/AM2/AM3/PR1/PR2/PR3/PR4/PR5/RC1, non_contact, written 70 min)", "LR-051 (wtp_363e43d4f3f870, Phase 1 — Foundation / Novice — Strength session, 70 minutes (months 3–9, lower emphasis); T1/RC1, non_contact, written 70 min)", "LR-073 (wtp_0b2bb48d17e3be, Phase 3 — Advanced — Strength session — Phase 3 maintenance, 55 min; AM1, non_contact, written 55 min)"] },
  },
  wtp_6bd117a9ae1263: {
    duration_minutes: { value: 90, status: "INFERRED", basis: "its own slot minutes: AM '40 min', PM '90 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 130", sheets: [] },
  },
  wtp_6bdab8e5169726: {
    duration_minutes: { value: 90, status: "INFERRED", basis: "its own stated minutes: PM '75–90 min' (upper end)", sheets: [] },
  },
  wtp_70dc2415bd2c93: {
    duration_minutes: { value: 100, status: "INFERRED", basis: "its own stated minutes: AM '100 min'", sheets: [] },
  },
  wtp_73621edf20014a: {
    session_type: { value: "rest", status: "INFERRED", basis: "its day_role 'off day' and its own text 'Full rest or 20–30 min walk + mobility; weekly review'; no in-use session type fits a rest day, so 'rest' (Overwatch, lane AP Q4 A)", sheets: [] },
    duration_minutes: { value: 30, status: "INFERRED", basis: "its own stated minutes: AM '20–30 min' (upper end)", sheets: [] },
  },
  wtp_7db7ce1a5c11d8: {
    session_type: { value: "rest", status: "INFERRED", basis: "its day_role 'off day' and its own text 'Rest'; no in-use session type fits a rest day, so 'rest' (Overwatch, lane AP Q4 A)", sheets: [] },
    duration_minutes: { value: 20, status: "UNVERIFIED", basis: "its own items state no minutes ('Rest' -> Rest 20); the same document's (The Long Road) written off days of the same contact structure, which write 20 (Overwatch, lane AP Q2)", sheets: ["LR-050 (wtp_84cb2cf887a94a, Phase 1 — Foundation / Novice — Scenario A Sunday; T1, non_contact, written 20 min)", "LR-050 (wtp_485b1e28f6cf9a, Phase 1 — Foundation / Novice — Scenario C Sunday; T1, non_contact, written 20 min)"] },
  },
  wtp_7e4b1fcacf2a9b: {
    duration_minutes: { value: 100, status: "INFERRED", basis: "its own slot minutes: AM '55 min', Midday '20 min', PM '100 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 175", sheets: [] },
  },
  wtp_84cb2cf887a94a: {
    session_type: { value: "rest", status: "INFERRED", basis: "its day_role 'off day' and its own text 'Rest. 20 min film/mental practice'; no in-use session type fits a rest day, so 'rest' (Overwatch, lane AP Q4 A)", sheets: [] },
  },
  wtp_9cd67911f6c526: {
    session_type: { value: "rest", status: "INFERRED", basis: "its day_role 'off day' and its own text 'Rest | Film'; no in-use session type fits a rest day, so 'rest' (Overwatch, lane AP Q4 A)", sheets: [] },
    duration_minutes: { value: 20, status: "UNVERIFIED", basis: "its own items state no minutes ('Rest' -> Rest 20, 'Film' (no sheet)); the same document's (The Long Road) written off days of the same contact structure, which write 20 (Overwatch, lane AP Q2)", sheets: ["LR-050 (wtp_84cb2cf887a94a, Phase 1 — Foundation / Novice — Scenario A Sunday; T1, non_contact, written 20 min)", "LR-050 (wtp_485b1e28f6cf9a, Phase 1 — Foundation / Novice — Scenario C Sunday; T1, non_contact, written 20 min)"] },
  },
  wtp_a6af9b142437ca: {
    duration_minutes: { value: 90, status: "UNVERIFIED", basis: "its own items state no minutes ('Buffering' -> Buffering 50, 'Boxing tactical' -> Boxing skill 90); the same document's (The Long Road) written session sheet of the same kind, of the same contact structure and at T2 where one exists (Overwatch, lane AP Q2) (Boxing skill: the non_contact boxing-skill sheet is LR-051 (wtp_c2c4bec001a56b, T1); the T2 one, LR-218 (wtp_080c41583b3757), is contact; both 90; 'Boxing tactical' read as boxing work; the Long Road tactical sheets wtp_a2d9f97418ec52 and wtp_bc964fe230d8f3 (contact) also write 90); the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 140", sheets: ["LR-061 (wtp_da83ce464ffa96, Phase 2 — Competitive Amateur — Buffering conditioning session, 50 min; T2/RC1, non_contact, written 50 min)", "LR-051 (wtp_c2c4bec001a56b, Phase 1 — Foundation / Novice — Boxing skill session, 90 minutes (months 3–9); T1/RC1, non_contact, written 90 min)", "LR-218 (wtp_080c41583b3757, Phase 2 — Competitive Amateur — Boxing skill session, 90 min (Phase 2–3, refinement); T2/AM1/RC1, contact, written 90 min)", "LR-219 (wtp_a2d9f97418ec52, Tactical session, 90 min (archetype focus); T2/AM1/AM2/AM3/PR1/PR2/PR3/PR4/PR5, contact, written 90 min)", "LR-061 (wtp_bc964fe230d8f3, Phase 2 — Competitive Amateur — Archetype tactical session — vs. pressure fighter, 90 min; T2, contact, written 90 min)"] },
  },
  wtp_a7b1f9ac59530e: {
    duration_minutes: { value: 70, status: "UNVERIFIED", basis: "its own items state no minutes ('Strength B' -> Strength B 70); the same document's (The Long Road) written session sheet of the same kind, of the same contact structure and at T2 where one exists (Overwatch, lane AP Q2) (Strength B: the sheet with its own name, 'Strength session B' (wtp_4346e280d811e3, LR-223, non_contact, serves T2), 70 (Overwatch, lane AP Q-A)); contrary: the other Long Road strength sheets, 75 (wtp_7069f515b9b84e, T2) and 55 (wtp_0b2bb48d17e3be, AM1); wtp_363e43d4f3f870 (T1) also writes 70", sheets: ["LR-223 (wtp_4346e280d811e3, Strength session B — upper explosive + power, 70 min; T1/T2/AM1/AM2/AM3/PR1/PR2/PR3/PR4/PR5/RC1, non_contact, written 70 min)", "LR-061 (wtp_7069f515b9b84e, Phase 2 — Competitive Amateur — Strength session — lower-body emphasis, 75 min; T2/RC1, non_contact, written 75 min)", "LR-051 (wtp_363e43d4f3f870, Phase 1 — Foundation / Novice — Strength session, 70 minutes (months 3–9, lower emphasis); T1/RC1, non_contact, written 70 min)", "LR-073 (wtp_0b2bb48d17e3be, Phase 3 — Advanced — Strength session — Phase 3 maintenance, 55 min; AM1, non_contact, written 55 min)"] },
  },
  wtp_a97e05c665c596: {
    difficulty: { value: "advanced", status: "UNVERIFIED", basis: "no template whose lowest stage is PR1-PR5 writes a difficulty (its own stage PR1 has only mitt templates A-E, all blank), so the nearest written stage below: every written template whose lowest stage is AM1 (9 of 9) or AM2 (7 of 7) is advanced; contrary: none ('elite' is unused) (Overwatch, lane AP: the written-template rule, nearest written stage below)", sheets: ["LR-073 (wtp_0b2bb48d17e3be, Phase 3 — Advanced — Strength session — Phase 3 maintenance, 55 min; lowest stage AM1, written difficulty advanced)", "LR-079 (wtp_060d401d23d474, Phase 4 — Elite / Champion-tier — Mid-camp week Tuesday; lowest stage AM2, written difficulty advanced)"] },
    duration_minutes: { value: 12, status: "UNVERIFIED", basis: "its own items give 6 rounds (Round 1 to Round 6) and no length, and its source documents DOC-023 and DOC-022 state no mitt round length; Jason's owner system DOC-072 Workout_Map runs pad work in 2:00 rounds (W-S10-007, equipment 'mitts or pads'): 6 x 2:00 = 12 (order of basis 3: the owner system where it addresses the same activity, OWNER_DECISIONS s3; Overwatch, lane AP Q-B); contrary: DOC-022's 'Pro contests can extend up to 12 x 3-minute rounds', 6 x 3 = 18. Caveat: pad round length from DOC-072 Workout_Map (W-S10-007); rest between rounds not counted; DOC-022 and DOC-023 state no mitt round length", sheets: ["DOC-072 W-S10-007 via trk_5ca8d83f2a1a66 (owner passage, Workout_Map \"SKILL-10 Body Attack After Defensive Trigger Session\": Equipment \"timer, partner/coach, mitts or pads, legal body target marker, cones/ring line, notebook\"; Rounds \"5-min setup; 3 x 2:00 single straight defend-return; 2 x 2:00 defend or exit; ...\")", "DOC-022 (trk_24e2dcbf4b0edc, group \"DOC-022 lines 123-184\", DIRECT CLAIM LIMITS: \"Pro contests can extend up to 12 x 3-minute rounds\")"], caveat: "pad round length from DOC-072 Workout_Map (W-S10-007); rest between rounds not counted; DOC-022 and DOC-023 state no mitt round length" },
  },
  wtp_aa6e79d35d0ec7: {
    duration_minutes: { value: 25, status: "INFERRED", basis: "its own stated minutes: conditioning '25 min'", sheets: [] },
  },
  wtp_b368e0355b3bbb: {
    duration_minutes: { value: 75, status: "UNVERIFIED", basis: "its own items state no minutes ('Sparring' -> Sparring 75); the same document's (The Long Road) written session sheet of the same kind, of the same contact structure and at T2 where one exists (Overwatch, lane AP Q2); contrary: the Phase 3 competition-simulation sparring sheet, 100 (wtp_25a003f73a472c, AM1)", sheets: ["LR-220 (wtp_040289603033b6, Phase 1 — Foundation / Novice — Sparring session, 75 min (Phase 1, Stage 5); T1/RC1, contact, written 75 min)", "LR-073 (wtp_25a003f73a472c, Phase 3 — Advanced — Competition-simulation sparring session, 100 min; AM1, contact, written 100 min)"] },
  },
  wtp_b52e6a56afea4b: {
    duration_minutes: { value: 60, status: "INFERRED", basis: "its own slot minutes: AM '45 min', PM '60 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 105", sheets: [] },
  },
  wtp_b604cd74564a8c: {
    intent: { value: "Mobility 10 min | Strength 60–75 min: lower emphasis + neck + carries", status: "INFERRED", basis: "its own items' text joined by ' | ', the form its written sibling days use", sheets: [] },
    duration_minutes: { value: 75, status: "INFERRED", basis: "its own slot minutes: AM '10 min', PM '60–75 min' (upper end of a range); the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 85", sheets: [] },
  },
  wtp_bdb23cdf150b86: {
    duration_minutes: { value: 90, status: "UNVERIFIED", basis: "its own items state no minutes ('Strength (reduced)' -> Strength 75, 'Boxing skill' -> Boxing skill 90); the same document's (The Long Road) written session sheet of the same kind, of the same contact structure and at T2 where one exists (Overwatch, lane AP Q2) (Boxing skill: the non_contact boxing-skill sheet is LR-051 (wtp_c2c4bec001a56b, T1); the T2 one, LR-218 (wtp_080c41583b3757), is contact; both 90); the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 165; the other Long Road strength sheets, 70 (wtp_4346e280d811e3, \"Strength session B\"; wtp_363e43d4f3f870, T1) and 55 (wtp_0b2bb48d17e3be, AM1)", sheets: ["LR-061 (wtp_7069f515b9b84e, Phase 2 — Competitive Amateur — Strength session — lower-body emphasis, 75 min; T2/RC1, non_contact, written 75 min)", "LR-051 (wtp_c2c4bec001a56b, Phase 1 — Foundation / Novice — Boxing skill session, 90 minutes (months 3–9); T1/RC1, non_contact, written 90 min)", "LR-218 (wtp_080c41583b3757, Phase 2 — Competitive Amateur — Boxing skill session, 90 min (Phase 2–3, refinement); T2/AM1/RC1, contact, written 90 min)", "LR-223 (wtp_4346e280d811e3, Strength session B — upper explosive + power, 70 min; T1/T2/AM1/AM2/AM3/PR1/PR2/PR3/PR4/PR5/RC1, non_contact, written 70 min)", "LR-051 (wtp_363e43d4f3f870, Phase 1 — Foundation / Novice — Strength session, 70 minutes (months 3–9, lower emphasis); T1/RC1, non_contact, written 70 min)", "LR-073 (wtp_0b2bb48d17e3be, Phase 3 — Advanced — Strength session — Phase 3 maintenance, 55 min; AM1, non_contact, written 55 min)"] },
  },
  wtp_c0c9286e8bc870: {
    session_type: { value: "warmup", status: "INFERRED", basis: "8 of its 9 items are warm-up blocks (the other is 'Rest, breathe, gloves on') and its name is a competition-day warm-up; no in-use session type fits, so the app's own item block word, as lane YR", sheets: [] },
    duration_minutes: { value: 40, status: "INFERRED", basis: "its name: '35–40 min' (upper end)", sheets: [] },
  },
  wtp_c49ef523671d1d: {
    difficulty: { value: "advanced", status: "UNVERIFIED", basis: "no template whose lowest stage is PR1-PR5 writes a difficulty (its own stage PR1 has only mitt templates A-E, all blank), so the nearest written stage below: every written template whose lowest stage is AM1 (9 of 9) or AM2 (7 of 7) is advanced; contrary: none ('elite' is unused) (Overwatch, lane AP: the written-template rule, nearest written stage below)", sheets: ["LR-073 (wtp_0b2bb48d17e3be, Phase 3 — Advanced — Strength session — Phase 3 maintenance, 55 min; lowest stage AM1, written difficulty advanced)", "LR-079 (wtp_060d401d23d474, Phase 4 — Elite / Champion-tier — Mid-camp week Tuesday; lowest stage AM2, written difficulty advanced)"] },
    duration_minutes: { value: 12, status: "UNVERIFIED", basis: "its own items give 6 rounds (Round 1 to Round 6) and no length, and its source documents DOC-023 and DOC-022 state no mitt round length; Jason's owner system DOC-072 Workout_Map runs pad work in 2:00 rounds (W-S10-007, equipment 'mitts or pads'): 6 x 2:00 = 12 (order of basis 3: the owner system where it addresses the same activity, OWNER_DECISIONS s3; Overwatch, lane AP Q-B); contrary: DOC-022's 'Pro contests can extend up to 12 x 3-minute rounds', 6 x 3 = 18. Caveat: pad round length from DOC-072 Workout_Map (W-S10-007); rest between rounds not counted; DOC-022 and DOC-023 state no mitt round length", sheets: ["DOC-072 W-S10-007 via trk_5ca8d83f2a1a66 (owner passage, Workout_Map \"SKILL-10 Body Attack After Defensive Trigger Session\": Equipment \"timer, partner/coach, mitts or pads, legal body target marker, cones/ring line, notebook\"; Rounds \"5-min setup; 3 x 2:00 single straight defend-return; 2 x 2:00 defend or exit; ...\")", "DOC-022 (trk_24e2dcbf4b0edc, group \"DOC-022 lines 123-184\", DIRECT CLAIM LIMITS: \"Pro contests can extend up to 12 x 3-minute rounds\")"], caveat: "pad round length from DOC-072 Workout_Map (W-S10-007); rest between rounds not counted; DOC-022 and DOC-023 state no mitt round length" },
  },
  wtp_c4ce7036fc104d: {
    intent: { value: "Mobility + neck 25 min | Sparring 75 min: 4–6 rounds Stage 5", status: "INFERRED", basis: "its own items' text joined by ' | ', the form its written sibling days use", sheets: [] },
    duration_minutes: { value: 75, status: "INFERRED", basis: "its own slot minutes: AM '25 min', PM '75 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 100", sheets: [] },
  },
  wtp_ca384cb3b5581a: {
    duration_minutes: { value: 30, status: "INFERRED", basis: "its own stated minutes: conditioning '30 min'", sheets: [] },
  },
  wtp_cfa42f86002f98: {
    duration_minutes: { value: 90, status: "INFERRED", basis: "its own slot minutes: AM '40 min', PM '90 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 130", sheets: [] },
  },
  wtp_d2f730ec22b7fb: {
    difficulty: { value: "advanced", status: "UNVERIFIED", basis: "no template whose lowest stage is PR1-PR5 writes a difficulty (its own stage PR1 has only mitt templates A-E, all blank), so the nearest written stage below: every written template whose lowest stage is AM1 (9 of 9) or AM2 (7 of 7) is advanced; contrary: none ('elite' is unused) (Overwatch, lane AP: the written-template rule, nearest written stage below)", sheets: ["LR-073 (wtp_0b2bb48d17e3be, Phase 3 — Advanced — Strength session — Phase 3 maintenance, 55 min; lowest stage AM1, written difficulty advanced)", "LR-079 (wtp_060d401d23d474, Phase 4 — Elite / Champion-tier — Mid-camp week Tuesday; lowest stage AM2, written difficulty advanced)"] },
    duration_minutes: { value: 12, status: "UNVERIFIED", basis: "its own items give 6 rounds (Round 1 to Round 6) and no length, and its source documents DOC-023 and DOC-022 state no mitt round length; Jason's owner system DOC-072 Workout_Map runs pad work in 2:00 rounds (W-S10-007, equipment 'mitts or pads'): 6 x 2:00 = 12 (order of basis 3: the owner system where it addresses the same activity, OWNER_DECISIONS s3; Overwatch, lane AP Q-B); contrary: DOC-022's 'Pro contests can extend up to 12 x 3-minute rounds', 6 x 3 = 18. Caveat: pad round length from DOC-072 Workout_Map (W-S10-007); rest between rounds not counted; DOC-022 and DOC-023 state no mitt round length", sheets: ["DOC-072 W-S10-007 via trk_5ca8d83f2a1a66 (owner passage, Workout_Map \"SKILL-10 Body Attack After Defensive Trigger Session\": Equipment \"timer, partner/coach, mitts or pads, legal body target marker, cones/ring line, notebook\"; Rounds \"5-min setup; 3 x 2:00 single straight defend-return; 2 x 2:00 defend or exit; ...\")", "DOC-022 (trk_24e2dcbf4b0edc, group \"DOC-022 lines 123-184\", DIRECT CLAIM LIMITS: \"Pro contests can extend up to 12 x 3-minute rounds\")"], caveat: "pad round length from DOC-072 Workout_Map (W-S10-007); rest between rounds not counted; DOC-022 and DOC-023 state no mitt round length" },
  },
  wtp_d6eb362e8eca13: {
    duration_minutes: { value: 90, status: "UNVERIFIED", basis: "its own items state no minutes ('Recovery' (no sheet), 'Boxing skill' -> Boxing skill 90); the same document's (The Long Road) written session sheet of the same kind, of the same contact structure and at T2 where one exists (Overwatch, lane AP Q2) (Boxing skill: the non_contact boxing-skill sheet is LR-051 (wtp_c2c4bec001a56b, T1); the T2 one, LR-218 (wtp_080c41583b3757), is contact; both 90)", sheets: ["LR-051 (wtp_c2c4bec001a56b, Phase 1 — Foundation / Novice — Boxing skill session, 90 minutes (months 3–9); T1/RC1, non_contact, written 90 min)", "LR-218 (wtp_080c41583b3757, Phase 2 — Competitive Amateur — Boxing skill session, 90 min (Phase 2–3, refinement); T2/AM1/RC1, contact, written 90 min)"] },
  },
  wtp_e2302f73a5d19a: {
    difficulty: { value: "advanced", status: "UNVERIFIED", basis: "no template whose lowest stage is PR1-PR5 writes a difficulty (its own stage PR1 has only mitt templates A-E, all blank), so the nearest written stage below: every written template whose lowest stage is AM1 (9 of 9) or AM2 (7 of 7) is advanced; contrary: none ('elite' is unused) (Overwatch, lane AP: the written-template rule, nearest written stage below)", sheets: ["LR-073 (wtp_0b2bb48d17e3be, Phase 3 — Advanced — Strength session — Phase 3 maintenance, 55 min; lowest stage AM1, written difficulty advanced)", "LR-079 (wtp_060d401d23d474, Phase 4 — Elite / Champion-tier — Mid-camp week Tuesday; lowest stage AM2, written difficulty advanced)"] },
    duration_minutes: { value: 12, status: "UNVERIFIED", basis: "its own items give 6 rounds (Round 1 to Round 6) and no length, and its source documents DOC-023 and DOC-022 state no mitt round length; Jason's owner system DOC-072 Workout_Map runs pad work in 2:00 rounds (W-S10-007, equipment 'mitts or pads'): 6 x 2:00 = 12 (order of basis 3: the owner system where it addresses the same activity, OWNER_DECISIONS s3; Overwatch, lane AP Q-B); contrary: DOC-022's 'Pro contests can extend up to 12 x 3-minute rounds', 6 x 3 = 18. Caveat: pad round length from DOC-072 Workout_Map (W-S10-007); rest between rounds not counted; DOC-022 and DOC-023 state no mitt round length", sheets: ["DOC-072 W-S10-007 via trk_5ca8d83f2a1a66 (owner passage, Workout_Map \"SKILL-10 Body Attack After Defensive Trigger Session\": Equipment \"timer, partner/coach, mitts or pads, legal body target marker, cones/ring line, notebook\"; Rounds \"5-min setup; 3 x 2:00 single straight defend-return; 2 x 2:00 defend or exit; ...\")", "DOC-022 (trk_24e2dcbf4b0edc, group \"DOC-022 lines 123-184\", DIRECT CLAIM LIMITS: \"Pro contests can extend up to 12 x 3-minute rounds\")"], caveat: "pad round length from DOC-072 Workout_Map (W-S10-007); rest between rounds not counted; DOC-022 and DOC-023 state no mitt round length" },
  },
  wtp_e3aa9cda9f1675: {
    intent: { value: "Conditioning 40 min: HIIT | Boxing skill 90 min: acquisition", status: "INFERRED", basis: "its own items' text joined by ' | ', the form its written sibling days use", sheets: [] },
    duration_minutes: { value: 90, status: "INFERRED", basis: "its own slot minutes: AM '40 min', PM '90 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 130", sheets: [] },
  },
  wtp_f448464103ec0a: {
    duration_minutes: { value: 75, status: "INFERRED", basis: "its own slot minutes: AM '45 min', Midday '20 min', PM '75 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 140", sheets: [] },
  },
  wtp_f581f36db0076e: {
    duration_minutes: { value: 90, status: "UNVERIFIED", basis: "its own items state no minutes ('Strength (reduced)' -> Strength 75, 'Boxing skill + fatigued technique' -> Boxing skill 90); the same document's (The Long Road) written session sheet of the same kind, of the same contact structure and at T2 where one exists (Overwatch, lane AP Q2) (Boxing skill: the non_contact boxing-skill sheet is LR-051 (wtp_c2c4bec001a56b, T1); the T2 one, LR-218 (wtp_080c41583b3757), is contact; both 90); the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 165; the other Long Road strength sheets, 70 (wtp_4346e280d811e3, \"Strength session B\"; wtp_363e43d4f3f870, T1) and 55 (wtp_0b2bb48d17e3be, AM1)", sheets: ["LR-061 (wtp_7069f515b9b84e, Phase 2 — Competitive Amateur — Strength session — lower-body emphasis, 75 min; T2/RC1, non_contact, written 75 min)", "LR-051 (wtp_c2c4bec001a56b, Phase 1 — Foundation / Novice — Boxing skill session, 90 minutes (months 3–9); T1/RC1, non_contact, written 90 min)", "LR-218 (wtp_080c41583b3757, Phase 2 — Competitive Amateur — Boxing skill session, 90 min (Phase 2–3, refinement); T2/AM1/RC1, contact, written 90 min)", "LR-223 (wtp_4346e280d811e3, Strength session B — upper explosive + power, 70 min; T1/T2/AM1/AM2/AM3/PR1/PR2/PR3/PR4/PR5/RC1, non_contact, written 70 min)", "LR-051 (wtp_363e43d4f3f870, Phase 1 — Foundation / Novice — Strength session, 70 minutes (months 3–9, lower emphasis); T1/RC1, non_contact, written 70 min)", "LR-073 (wtp_0b2bb48d17e3be, Phase 3 — Advanced — Strength session — Phase 3 maintenance, 55 min; AM1, non_contact, written 55 min)"] },
  },
  wtp_fe550473f8a412: {
    duration_minutes: { value: 90, status: "UNVERIFIED", basis: "its own items state no minutes ('Boxing skill' -> Boxing skill 90); the same document's (The Long Road) written session sheet of the same kind, of the same contact structure and at T2 where one exists (Overwatch, lane AP Q2) (Boxing skill: the non_contact boxing-skill sheet is LR-051 (wtp_c2c4bec001a56b, T1); the T2 one, LR-218 (wtp_080c41583b3757), is contact; both 90)", sheets: ["LR-051 (wtp_c2c4bec001a56b, Phase 1 — Foundation / Novice — Boxing skill session, 90 minutes (months 3–9); T1/RC1, non_contact, written 90 min)", "LR-218 (wtp_080c41583b3757, Phase 2 — Competitive Amateur — Boxing skill session, 90 min (Phase 2–3, refinement); T2/AM1/RC1, contact, written 90 min)"] },
  },
};

/** The drafted cell value and its label; throws on a draft the field's checks would refuse. */
function draftCell(template, field, draft, where) {
  if (!isObject(draft) || !DRAFT_STATUSES.includes(draft.status) || typeof draft.basis !== 'string' || !draft.basis || !Array.isArray(draft.sheets)) {
    throw new ExportError(`${where}: the ${field} draft needs value, status (${DRAFT_STATUSES.join(' or ')}), basis and sheets`);
  }
  let value;
  if (field === 'duration_minutes') {
    if (!Number.isInteger(draft.value) || draft.value < 1 || draft.value > 180) throw new ExportError(`${where}: drafted duration_minutes ${JSON.stringify(draft.value)} is not a whole number from 1 to 180`);
    value = String(draft.value);
  } else {
    value = textCell(draft.value, `${where} drafted ${field}`);
    if (!value) throw new ExportError(`${where}: drafted ${field} is blank`);
    if (field === 'difficulty' && !DIFFICULTIES.includes(value)) throw new ExportError(`${where}: drafted difficulty ${value} is not one of ${DIFFICULTIES.join(', ')}`);
  }
  const label = {
    status: draft.status, draft: DRAFT_MARK, basis: draft.basis,
    sources: [...(template.sources ?? []).map((source) => source.normalize('NFC').trim()), ...draft.sheets, REVIEW_SHEET],
  };
  if (draft.caveat !== undefined) label.caveat = draft.caveat;
  return { value, label };
}

// ---- reading the frozen Backbone ----

const inLane = (record) => {
  const keys = Array.isArray(record.stage_keys) ? record.stage_keys : [];
  if (keys.length === 1 && keys[0] === 'FT1') return false;
  if (keys.some((key) => YR_STAGES.includes(key))) return false;
  return keys.some((key) => AMATEUR_STAGES.includes(key) || PRO_STAGES.includes(key));
};
const isAmateur = (record) => record.stage_keys.some((key) => AMATEUR_STAGES.includes(key));

export function readSet(backboneDir) {
  const manifest = loadManifest(backboneDir);
  const hashes = [];
  const tracks = readDir(backboneDir, manifest, CONTENT_DIRS.tracks, hashes).map((entry) => entry.record).filter(inLane);
  const blocks = readDir(backboneDir, manifest, CONTENT_DIRS.blocks, hashes).map((entry) => entry.record).filter(inLane);
  const sessions = readDir(backboneDir, manifest, CONTENT_DIRS.sessions, hashes).map((entry) => entry.record).filter(inLane);
  const other = sessions.find((record) => record.session_kind !== 'template');
  if (other) throw new ExportError(`session ${other.template_id ?? other.script_id}: session_kind ${JSON.stringify(other.session_kind)}; this lane exports templates only`);
  const held = sessions.filter((record) => Object.hasOwn(HELD_TEMPLATES, record.template_id));
  const templates = sessions.filter((record) => !Object.hasOwn(HELD_TEMPLATES, record.template_id));
  return { tracks, blocks, templates, held, hashes };
}

/** Throws unless every key of `record` is known for its kind; tallies the not-carried ones. */
function checkKeys(kind, record, where, tally) {
  if (!isObject(record)) throw new ExportError(`${where} is not an object`);
  if (record.organization_id !== undefined && record.organization_id !== ORG_PLACEHOLDER) {
    throw new ExportError(`${where}: organization_id ${JSON.stringify(record.organization_id)} is not ${ORG_PLACEHOLDER}; the export always writes the placeholder`);
  }
  const { columns, details, checked, notCarried } = KEYS[kind];
  for (const key of Object.keys(record)) {
    if (columns.includes(key) || details.includes(key) || checked.includes(key)) continue;
    if (notCarried.includes(key)) {
      tally[`${kind}.${key}`] = (tally[`${kind}.${key}`] ?? 0) + 1;
      continue;
    }
    throw new ExportError(`${where}: key ${JSON.stringify(key)} has no column, no place in details and is not on the not-carried list; report it, do not drop it`);
  }
}

// ---- building the rows ----

function templateRows(templates, drillIds, dropped, tally, notes, counts, draftTable) {
  const rows = [];
  const items = [];
  const unused = new Set(Object.keys(draftTable));
  for (const template of [...templates].sort((a, b) => compare(a.template_id, b.template_id))) {
    const where = `template ${template.template_id}`;
    checkKeys('template', template, where, tally);
    sameId(template, 'template_id', where);
    const drafts = draftTable[template.template_id] ?? {};
    unused.delete(template.template_id);
    const unknown = Object.keys(drafts).filter((field) => !DRAFT_FIELDS.includes(field));
    if (unknown.length) throw new ExportError(`${where}: drafts for ${unknown.join(', ')}, which is not a drafted field`);
    const cells = {};
    const extraLabels = {};
    const frozenLabels = isObject(template.field_labels) ? { ...template.field_labels } : template.field_labels;
    for (const field of DRAFT_FIELDS) {
      const blank = template[field] === undefined || template[field] === null || template[field] === '';
      if (blank && !drafts[field]) throw new ExportError(`${where}: ${field} is blank and has no draft (OD-2026-11-17-001); report it, do not load it blank`);
      if (!blank && drafts[field]) throw new ExportError(`${where}: ${field} is written in the Backbone (${JSON.stringify(template[field])}); a written value is never drafted over`);
      if (!blank) continue;
      const { value, label } = draftCell(template, field, drafts[field], where);
      cells[field] = value;
      if (isObject(frozenLabels) && frozenLabels[field] !== undefined) {
        label.backbone_label = stripExcerpts(frozenLabels[field], dropped);
        delete frozenLabels[field];
      }
      extraLabels[field] = label;
      counts.drafts += 1;
    }
    const labelled = labelCells({ ...template, field_labels: frozenLabels }, where, dropped, { extraLabels });
    rows.push({
      organization_id: ORG_PLACEHOLDER, template_id: template.template_id, lineage_id: template.lineage_id, version: '1', supersedes_template_id: '', superseded_at: '',
      name: textCell(template.name, `${where} name`),
      session_type: cells.session_type ?? textCell(template.session_type, `${where} session_type`),
      difficulty: cells.difficulty ?? textCell(template.difficulty, `${where} difficulty`),
      age_band: textCell(template.age_band, `${where} age_band`),
      duration_minutes: cells.duration_minutes ?? numberCell(template.duration_minutes, `${where} duration_minutes`),
      intent: cells.intent ?? textCell(template.intent, `${where} intent`),
      coach_notes: textCell(template.coach_notes, `${where} coach_notes`),
      requires_coach_authorization: boolCell(template.requires_coach_authorization, `${where} requires_coach_authorization`),
      active: boolCell(template.active, `${where} active`), created_by_account_id: '',
      details: detailsCell(template, KEYS.template.details, dropped),
      ...labelled,
    });
    const ordinals = (template.items ?? []).map((item) => item.ordinal);
    if (ordinals.some((ordinal, index) => ordinal !== index + 1)) throw new ExportError(`${where}: item ordinals ${JSON.stringify(ordinals)} do not run 1..n`);
    for (const item of template.items ?? []) {
      const at = `${where} item ${item.ordinal}`;
      checkKeys('item', item, at, tally);
      if (item.drill_id && !drillIds.has(item.drill_id)) throw new ExportError(`${at}: drill ${item.drill_id} is not in ${FILES.drills}`);
      const contact = textCell(item.contact_level, `${at} contact_level`);
      let duration = numberCell(item.duration_minutes, `${at} duration_minutes`);
      const extra = {};
      if (duration !== '' && !VOLUME_FREE_CONTACT.includes(contact || 'none')) {
        extra.duration_minutes = item.duration_minutes;
        duration = '';
        counts.sparringMinutes += 1;
        notes.push(`${at}: ${contact} with ${item.duration_minutes} min -> details.duration_minutes (the column takes no minutes above light_technical; OD-2026-11-17-002)`);
      }
      items.push({
        organization_id: ORG_PLACEHOLDER, item_id: textCell(item.item_id, `${at} item_id`), template_id: template.template_id, ordinal: numberCell(item.ordinal, `${at} ordinal`),
        block: textCell(item.block, `${at} block`), drill_id: textCell(item.drill_id, `${at} drill_id`), free_text_drill: textCell(item.free_text_drill, `${at} free_text_drill`),
        duration_minutes: duration, rep_count: '', contact_level: contact, coach_note: textCell(item.coach_note, `${at} coach_note`),
        scale_level: textCell(item.scale_level, `${at} scale_level`), details: detailsCell(item, KEYS.item.details, dropped, extra),
      });
    }
  }
  if (unused.size) throw new ExportError(`DRAFTS names template(s) outside this set: ${[...unused].sort().join(', ')}`);
  return { rows, items };
}

function trackRows({ tracks, blocks, templates }, dropped, tally, blocksByTrack) {
  const templateIds = new Set(templates.map((template) => template.template_id));
  const trackCells = [];
  const blockCells = [];
  const sessionCells = [];
  for (const track of [...tracks].sort((a, b) => compare(a.track_id, b.track_id))) {
    const where = `track ${track.track_id}`;
    checkKeys('track', track, where, tally);
    sameId(track, 'track_id', where);
    const own = blocks.filter((block) => block.track_id === track.track_id).sort((a, b) => a.block_order - b.block_order);
    const ids = own.map((block) => block.track_block_id);
    // block_ids, when the record has it, must list its blocks in order; two tracks carry none, and
    // their blocks are taken by their own track_id (Overwatch, lane AP step 1) and counted below.
    if (track.block_ids !== undefined) {
      const listed = track.block_ids;
      if (!Array.isArray(listed) || listed.length !== ids.length || listed.some((id, index) => id !== ids[index])) {
        throw new ExportError(`${where}: block_ids ${JSON.stringify(listed)} differ from the blocks in block_order ${JSON.stringify(ids)}`);
      }
    }
    if (own.length !== (blocksByTrack[track.track_id] ?? 0)) {
      throw new ExportError(`${where}: ${own.length} blocks, expected ${blocksByTrack[track.track_id] ?? 0} (BLOCKS_BY_TRACK)`);
    }
    trackCells.push({
      organization_id: ORG_PLACEHOLDER, track_id: track.track_id, lineage_id: track.lineage_id, version: '1', supersedes_track_id: '', superseded_at: '',
      name: textCell(track.name, `${where} name`), lane: textCell(track.lane, `${where} lane`), track: textCell(track.track, `${where} track`),
      duration_weeks: numberCell(track.duration_weeks, `${where} duration_weeks`), delivered_to_program_id: textCell(track.delivered_to_program_id, `${where} delivered_to_program_id`),
      age_band: textCell(track.age_band, `${where} age_band`), status: textCell(track.status, `${where} status`), sources: sourcesCell(track.sources, where),
      details: detailsCell(track, KEYS.track.details, dropped), active: boolCell(track.active, `${where} active`), created_by_account_id: '',
      ...labelCells(track, where, dropped),
    });
    own.forEach((block, index) => {
      const at = `block ${block.track_block_id}`;
      checkKeys('block', block, at, tally);
      sameId(block, 'track_block_id', at);
      if (block.active !== true) throw new ExportError(`${at}: active is ${JSON.stringify(block.active)}; a block has no active column, so only an active block can be exported`);
      if (block.block_order !== index + 1) throw new ExportError(`${at}: block_order ${block.block_order} is not ${index + 1} (blocks must run 1..n without gaps)`);
      blockCells.push({
        organization_id: ORG_PLACEHOLDER, track_block_id: block.track_block_id, block_lineage_id: block.lineage_id, track_id: track.track_id,
        block_order: numberCell(block.block_order, `${at} block_order`), title: textCell(block.title, `${at} title`), weeks: numberCell(block.weeks, `${at} weeks`),
        status: textCell(block.status, `${at} status`), sources: sourcesCell(block.sources, at), ...labelCells(block, at, dropped, { stageKeysAsJson: true }),
        details: detailsCell(block, KEYS.block.details, dropped),
      });
      (block.session_refs ?? []).forEach((ref, position) => {
        checkKeys('sessionRef', ref, `${at} session_ref ${position + 1}`, tally);
        if (!templateIds.has(ref.template_id)) throw new ExportError(`${at} session_ref ${position + 1}: template ${ref.template_id} is not in this set`);
        sessionCells.push({
          organization_id: ORG_PLACEHOLDER, block_session_id: '', track_id: track.track_id, block_order: String(block.block_order), ordinal: String(position + 1),
          week: numberCell(ref.week, `${at} session_ref week`), day: textCell(ref.day, `${at} session_ref day`), template_lineage_id: textCell(ref.template_id, `${at} session_ref template_id`),
        });
      });
    });
  }
  const orphan = blocks.find((block) => !tracks.some((track) => track.track_id === block.track_id));
  if (orphan) throw new ExportError(`block ${orphan.track_block_id}: its track ${orphan.track_id} is not in this set`);
  const listedTracks = Object.keys(blocksByTrack).filter((id) => !tracks.some((track) => track.track_id === id));
  if (listedTracks.length) throw new ExportError(`BLOCKS_BY_TRACK names track(s) outside this set: ${listedTracks.join(', ')}`);
  return { trackCells, blockCells, sessionCells };
}

/** Every owner_passages list on a record or its blocks' top level: [lists, passages]. */
function ownerPassageCount(records) {
  let lists = 0;
  let passages = 0;
  for (const record of records) {
    if (Array.isArray(record.owner_passages)) {
      lists += 1;
      passages += record.owner_passages.length;
    }
  }
  return { lists, passages };
}

/**
 * The packages for one Backbone folder: { files, counts, differences, notices, overwrites, backboneVersion }.
 * `existing(name)` returns a committed file's text, or undefined. `drafts` and `blocksByTrack` default to
 * this lane's tables; a test passes its own for a fixture Backbone.
 */
export function exportAmateurPro(backboneDir, existing = () => undefined, { allowOverwrite = false, drafts = DRAFTS, blocksByTrack = BLOCKS_BY_TRACK } = {}) {
  const set = readSet(backboneDir);
  const backboneVersion = `ap ${sha16(Buffer.from([...set.hashes].sort(compare).join('\n')))} (${set.hashes.length} files)`;
  const dropped = {};
  const tally = {};
  const notes = [];
  const counts = { drafts: 0, sparringMinutes: 0 };
  const drillText = existing(FILES.drills);
  if (drillText === undefined) throw new ExportError(`${FILES.drills} is not in the output folder; item drill references are checked against it`);
  const drillIds = new Set(committedRows(drillText, readCsv(drillText).header).map((row) => row.drill_id));

  const templateSet = templateRows(set.templates, drillIds, dropped, tally, notes, counts, drafts);
  const trackSet = trackRows(set, dropped, tally, blocksByTrack);
  const owner = ownerPassageCount([...set.tracks, ...set.blocks, ...set.templates]);

  Object.assign(counts, {
    tracks: trackSet.trackCells.length, amateurTracks: set.tracks.filter(isAmateur).length, proTracks: set.tracks.filter((record) => !isAmateur(record)).length,
    blocks: trackSet.blockCells.length, blockSessions: trackSet.sessionCells.length, templates: templateSet.rows.length,
    amateurTemplates: set.templates.filter(isAmateur).length, proTemplates: set.templates.filter((record) => !isAmateur(record)).length,
    items: templateSet.items.length, heldTemplates: set.held.length, quoteKeys: dropped.quote ?? 0, ownerPassageLists: owner.lists, ownerPassages: owner.passages,
    sp10Sentences: dropped.sp10Sentences ?? 0,
  });
  if (dropped.quotes) counts.quotesKeys = dropped.quotes;
  const differences = Object.entries(EXPECTED_COUNTS).filter(([key, expected]) => counts[key] !== expected).map(([key, expected]) => `${key}: brief ${expected}, observed ${counts[key]}`);

  const templateIds = new Set(templateSet.rows.map((row) => row.template_id));
  const trackIds = new Set(trackSet.trackCells.map((row) => row.track_id));
  const ordinal = (column, order = 'ordinal') => (a, b) => compare(a[column], b[column]) || Number(a[order]) - Number(b[order]);
  const files = {};
  const overwrites = [];
  const stops = [];
  const put = (name, rows, replaces) => {
    const committed = committedRows(existing(name), HEADERS[name]);
    const kept = committed.filter((row) => !replaces(row));
    checkUniqueIds(name, kept, rows);
    overwrites.push(...findOverwrites(name, committed.filter(replaces), rows));
    stops.push(...heldTextFindings(name, HEADERS[name], rows));
    if (name === FILES.items) stops.push(...typedLineFindings(name, committed.filter(replaces), rows));
    // A replaced row keeps its place; new rows follow the kept ones (lane YR's merge).
    const byId = new Map(rows.map((row) => [guardId(name, row), row]));
    const inPlace = committed.map((row) => (replaces(row) ? byId.get(guardId(name, row)) : row)).filter(Boolean);
    const placed = new Set(committed.filter(replaces).map((row) => guardId(name, row)));
    const added = rows.filter((row) => !placed.has(guardId(name, row)));
    files[name] = writeCsv(HEADERS[name], [...inPlace, ...added].map((obj) => HEADERS[name].map((column) => obj[column] ?? '')));
  };
  const ofTemplate = (row) => templateIds.has(row.template_id) || Object.hasOwn(HELD_TEMPLATES, row.template_id);
  const ofTrack = (row) => trackIds.has(row.track_id);
  put(FILES.templates, templateSet.rows, ofTemplate);
  put(FILES.items, templateSet.items.sort(ordinal('template_id')), ofTemplate);
  put(FILES.tracks, trackSet.trackCells, ofTrack);
  put(FILES.blocks, trackSet.blockCells.sort(ordinal('track_id', 'block_order')), ofTrack);
  put(FILES.sessions, trackSet.sessionCells, ofTrack);
  const overwriteLines = describeOverwrites(overwrites);
  const stopText = stopMessage(stops);
  if (overwrites.length && !allowOverwrite) {
    throw new ExportError([
      `refused: this run would change or remove ${overwrites.length} committed row(s): edits made in the repo since the export. Nothing was written.`,
      ...overwriteLines,
      ...(stopText
        ? ['--allow-overwrite would not write this run either.', stopText]
        : ['To write the frozen Backbone\'s rows over them on purpose, run again with --allow-overwrite.']),
    ].join('\n'));
  }
  if (stopText) throw new ExportError(stopText);

  const draftsBy = {};
  for (const fields of Object.values(drafts)) for (const [field, draft] of Object.entries(fields)) draftsBy[`${field} ${draft.status}`] = (draftsBy[`${field} ${draft.status}`] ?? 0) + 1;
  const notCarried = Object.entries(tally).sort(([a], [b]) => compare(a, b)).map(([key, n]) => `${key} x${n}`);
  return {
    backboneVersion,
    counts,
    differences,
    files,
    overwrites,
    notices: [
      `research excerpt keys dropped: quote ${dropped.quote ?? 0}, quotes ${dropped.quotes ?? 0}; sp10 sentences repeating their quote dropped: ${dropped.sp10Sentences ?? 0}; owner passages carried: ${owner.passages} in ${owner.lists} lists`,
      `record keys not carried (kind.key xcount): ${notCarried.join(', ')}`,
      `drafted (OD-2026-11-17-001): ${Object.entries(draftsBy).sort(([a], [b]) => compare(a, b)).map(([key, n]) => `${key} x${n}`).join(', ')}`,
      `HELD, not exported (OD-2026-10-02-013 2A): ${set.held.length ? set.held.map((record) => record.template_id).join(', ') : 'none'}`,
      ...notes,
      ...(overwrites.length ? [`--allow-overwrite: changed or removed ${overwrites.length} committed row(s):`, ...overwriteLines] : []),
      ...(differences.length ? [`COUNTS DIFFER FROM THE BRIEF: ${differences.join('; ')}`] : []),
    ],
  };
}

export { WRITTEN };

const USAGE = 'usage: node scripts/backbone-export-amateur-pro.mjs <backbone-folder> [--out <seed-data folder>] [--allow-overwrite]';

export function parseArgs(argv) {
  const positional = [];
  let out;
  let allowOverwrite = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      out = argv[i + 1];
      if (!out) throw new ExportError(`--out needs a folder\n${USAGE}`);
      i += 1;
    } else if (argv[i] === '--allow-overwrite') allowOverwrite = true;
    else if (argv[i].startsWith('--')) throw new ExportError(`unknown option ${argv[i]}\n${USAGE}`);
    else positional.push(argv[i]);
  }
  if (positional.length !== 1) throw new ExportError(`give exactly one Backbone folder\n${USAGE}`);
  return { backboneDir: positional[0], out, allowOverwrite };
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  try {
    const args = parseArgs(process.argv.slice(2));
    const typedIn = process.env.INIT_CWD ?? process.cwd();
    const out = args.out ? path.resolve(typedIn, args.out) : path.join(here, '..', 'seed-data');
    const existing = (name) => {
      const file = path.join(out, name);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
    };
    const result = exportAmateurPro(path.resolve(typedIn, args.backboneDir), existing, { allowOverwrite: args.allowOverwrite });
    for (const [name, text] of Object.entries(result.files)) {
      fs.mkdirSync(path.dirname(path.join(out, name)), { recursive: true });
      fs.writeFileSync(path.join(out, name), text, 'utf8');
    }
    console.log(`backbone_version: ${result.backboneVersion}`);
    console.log(`counts: ${Object.entries(result.counts).map(([key, n]) => `${key} ${n}`).join(', ')} -> ${out}`);
    for (const notice of result.notices) console.log(notice);
    if (result.differences.length) process.exit(2);
  } catch (error) {
    if (error instanceof ExportError) {
      console.error(`backbone-export-amateur-pro: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
