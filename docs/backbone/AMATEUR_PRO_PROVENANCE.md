# Amateur + pro stage content: provenance

Lane AP, the second stage lane of OD-2026-11-15-006 ruling 2. Jason started it beside lane YR on 2026-11-17 ("A: Both now", OD-2026-11-17-005); each lane loads when it is ready.

It carries every frozen track, block and session whose stage keys:
- include an amateur stage (T1, T2, AM1 to AM3) or a pro stage (PR1 to PR5);
- are not exactly `["FT1"]`;
- name no youth stage and no RC1.

Records with a youth stage or RC1 went to lane YR: a record that spans groups goes in the first lane that uses it (OD-2026-11-10-003 point 4). Exit EX1 has no records of its own.

## Source

- Frozen Backbone `data/content/tracks`, `data/content/blocks` and `data/content/sessions`. Every file read is checked against `FREEZE_MANIFEST.json`, sha256[:16] `38b52df4c2d8d7a1` when exported.
- Each record's own status line, as written: "Status: DRAFT, not app source until handoff (RULES.md)".
- Exported by `apps/web/scripts/backbone-export-amateur-pro.mjs` (`npm run backbone:export:amateur-pro -- <backbone-folder>`), which reuses lane YR's exporter helpers. The output is new rows in the committed `workout-templates` and `training-tracks` packages. Every other committed row is kept byte for byte.
- The data is provisional: the exporter regenerates it at the final Backbone hand-off (OD-2026-10-28-002 route A; OD-2026-11-08-001 decision 5).
- A rerun is byte-identical, drafts included. It refuses to overwrite a row edited in the repo unless told to (`--allow-overwrite`).

## What was loaded

- **14 tracks** (7 amateur, 7 pro):
  - 7 pro library tracks (manual chapters as `groups`, no weeks);
  - 5 program tracks: Phase 1 Foundation / Novice, Phase 2 Competitive Amateur, Phase 3 Advanced, Phase 4 Elite / Champion-tier and the Eight-week camp;
  - 2 others: The First 90 Days, and Block Templates — Copy and Adapt.
- **16 blocks** on 4 tracks:

  | Track | Blocks |
  | --- | --- |
  | `trk_a5e16184502c0f` | 8 |
  | `trk_2e224d9fc9f63c` | 3 |
  | `trk_eaa2ecb5091bff` | 3 |
  | `trk_89c3ba325a7e0d` | 2 |

  - Two of these tracks, `trk_89c3ba325a7e0d` and `trk_a5e16184502c0f`, carry no `block_ids`. Their blocks are taken by their own `track_id`, and the exporter asserts the count per track (Overwatch, lane AP step 1).
  - Two blocks have no weeks; they load blank, which the table allows.
- **498 block sessions.** Week and day are as written, including one day written "1 (bout day)".
  - `trk_eaa2ecb5091bff` numbers each block's weeks from 1: block 2 lists weeks 1-26 and block 3 weeks 1-39. Class plans groups days by block and week, so each block reads in order.
- **66 session templates** (61 amateur, 5 pro), all `template`, with **162 items**. No script session.
- **Every Backbone field with no column of its own goes into `details`**, whole and by its Backbone name. This covers lane YR's keys plus:
  - 42 new track keys (for example `weekly_template`, `camp_structure`, `sparring_ceilings`, `first_year_by_month`, `taper`);
  - 14 block keys;
  - 6 template keys (`day_role` on 49 templates, `pass_fail`, `source_evidence_grade`, `archetype_role_rule`, `session_rule`, `timing_rule`);
  - 6 item keys (`slot` on 68 items, `time_before`, `long_road_slot`, `long_road_text`, `moved_from`, `order_note`).

  The exporter's `KEYS` lists every key; an unknown key stops the export.
- Stage links come from each record's `stage_keys`, as for FT1 and lane YR.
- References:
  - all 35 drill references are committed drills;
  - all track and block references are in the set;
  - 7 template ids that program tracks name in `example_session_refs` are lane YR's templates, held as text in `details` with no link.

## What was not carried

- `stage_links`: derived from `stage_keys`.
- A template's `session_kind`, `track_id`, `status` and `sources`, as FT1b and lane YR. A drafted field's label names the template's sources.
- A track's `block_ids`: checked equal to its blocks in order where present.
- **Research excerpts:** all 193 `quote` keys, each in an evidence entry, are removed (OD-2026-10-02-013 answer 2A). The citation stays: source id, DOI, PMID, location and labels. No evidence sentence shares an 8-word run with its own entry's quote, so none more is dropped.
- **Owner passages are carried:** 202 passages in 22 lists, every one from DOC-027 (Punxsy Master Source Manual v1, 109) or DOC-072 (Pro Boxing Skill System Master Registry, 93), Jason's own material (Backbone card Q-208, RH-Q02 A).

## Sources, and why nothing is held

Every source of the set is Jason's own:

| Source | Records | Why it is his |
| --- | --- | --- |
| DOC-023 (Adult Pro Boxing Development System, MASTER MERGED v1) | 12 | PPBF owner-authored (PN-10, D-PN10) |
| DOC-022 (Gap-Filled Build v1) | 11 | PPBF owner-authored, as DOC-023 (Q-143) |
| The Long Road (LR-xxx, DOC-001) | most of the rest | co-written by Jason with AI (Backbone RULES s4) |
| his own rulings (D-PK...) | — | — |

Outside material appears only as evidence citations: the USA Boxing 2026 rule book, the USA Boxing Grassroots Training Manual and research papers, all by key and citation. DOC-072 registry rows also name a source title inside owner passages.

**HELD (OD-2026-10-02-013 answers 2A and 4A): none.** The exporter's HELD list is empty, and the export asserts 0.

## Drafted template fields (OD-2026-11-17-001)

- Jason: "B: AI drafts the values". 49 of the 66 templates had blank required fields, 68 values in all:

  | Field | Values |
  | --- | --- |
  | `session_type` | 10 |
  | `difficulty` | 5 |
  | `duration_minutes` | 46 |
  | `intent` | 7 |

- **By Overwatch's order of basis:**
  - 44 values come from the template's own frozen content and are labelled `INFERRED`.
  - 14 durations come from the same document's sheet of the same kind and contact structure and are labelled `UNVERIFIED`, with the sheets and contrary values named. These are the 13 Block Templates days and 1 First 90 Days rest day.
  - The 5 DOC-023 mitt templates' durations come from Jason's owner system (order of basis 3: where neither the template nor its own documents speak to the activity, DOC-072/DOC-027 where it addresses it directly; it leads by source order, OWNER_DECISIONS s3), labelled `UNVERIFIED`.
  - The 5 mitt templates' difficulty is `advanced`, labelled `UNVERIFIED`. Difficulty takes the value the written templates of the same lowest stage carry; no template whose lowest stage is PR1-PR5 writes one, so the nearest written stage below applies (AM1 9 of 9 and AM2 7 of 7 advanced).
- **Overwatch's rulings for this lane:**
  - Q1 A: a multi-slot day takes its longest slot, as the written two-slot day `wtp_d359ba85193b3b` does.
  - Q2: the named Long Road sheets. Q-A: the "Strength B" day takes 70 from the sheet with its own name, "Strength session B" (`wtp_4346e280d811e3`, LR-223); 75 and 55 are its contraries.
  - Q-B (replacing Q3's 18): the mitt templates take 12 minutes, 6 x 2:00 from DOC-072 Workout_Map pad rounds (W-S10-007, an owner passage on `trk_5ca8d83f2a1a66`), with DOC-022's contest round length (6 x 3 = 18) as the contrary and the caveat "pad round length from DOC-072 Workout_Map (W-S10-007); rest between rounds not counted; DOC-022 and DOC-023 state no mitt round length".
  - Q4 A: `rest` for the 9 rest days, a new session_type value; session_type has no vocabulary check.
  - Difficulty, ruling A: mitts A-E `advanced`, UNVERIFIED, from the nearest written stage below (citing `wtp_0b2bb48d17e3be` and `wtp_060d401d23d474`). This corrects the brief's "T2 and up = advanced" line: the written templates whose lowest stage, in the app's STAGE_KEYS order, is T2 are mixed (16 advanced, 4 intermediate).
- The drafts are the exporter's `DRAFTS` table. Each drafted field is labelled in `field_labels` with:
  - the marker "AI draft, lane AP, 2026-11-17 (OD-2026-11-17-001)";
  - its status, basis and sources;
  - the frozen label it replaces, kept as `backbone_label` (58 fields).
- The review sheet is `docs/content-review/amateur-pro/TEMPLATE_DRAFTS_REVIEW.md`. The lane's two reviewers pass it; Jason does not review it (OD-2026-11-15-011). A miss is fixed by a new template version.
- A written value is never drafted over: the exporter stops if a draft names a written field.

## Sparring minutes (OD-2026-11-17-002)

Three items above light technical keep their frozen minutes in `details.duration_minutes`, with the duration column blank:

| Template | Item | Contact | Minutes |
| --- | --- | --- | --- |
| `wtp_25a003f73a472c` | 2 | open_sparring | 55 |
| `wtp_a2d9f97418ec52` | 4 | controlled_sparring | 30 |
| `wtp_bc964fe230d8f3` | 6 | controlled_sparring | 30 |

The template page shows them as information. Timers, issuing and presets never read them. `pilot_wti_no_contact_volume` is unchanged.

## Where it shows

- **Class plans** (tracks with blocks): The First 90 Days, Phase 1 Foundation / Novice, the Eight-week camp, and Block Templates — Copy and Adapt.
- **Library** (`/coach/library`): the 7 pro library tracks and 3 program tracks with no blocks.
  - The 3 program tracks (Phase 2, Phase 3 and Phase 4) have no `groups`. Their fields show through the generic detail lists: readable, not designed (Overwatch, lane AP step 1); not checked on screen.
- No new screen.
- Not verified on the gym floor: nobody has looked at these pages signed in.
