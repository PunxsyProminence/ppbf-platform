# Youth + recreational stage content: provenance

Lane YR, the first stage lane of OD-2026-11-15-006 ruling 2 (OW25-14 A). It carries every frozen track, block and session whose stage keys include a youth stage (Y1 to Y5) or RC1 and are not exactly `["FT1"]`. A record that spans groups goes in the first lane that uses it (OD-2026-11-10-003 point 4).

## Source

- Frozen Backbone `data/content/tracks`, `data/content/blocks`, `data/content/sessions` and `data/spine/spine.json`. Every file read is checked against `FREEZE_MANIFEST.json`, sha256[:16] `38b52df4c2d8d7a1` when exported.
- Each record's own status line, as written: "Status: DRAFT, not app source until handoff (RULES.md)".
- Exported by `apps/web/scripts/backbone-export-youth-recreational.mjs` (`npm run backbone:export:youth-recreational -- <backbone-folder>`). The output is new rows in the committed `workout-templates`, `training-tracks` and `session-scripts` packages.
- The data is provisional: the exporter regenerates it at the final Backbone hand-off (OD-2026-10-28-002 route A; OD-2026-11-08-001 decision 5). A rerun is byte-identical and refuses to overwrite a row edited in the repo unless told to (`--allow-overwrite`).

## What was loaded

- 53 tracks: 34 youth and 19 recreational. 52 are library tracks (manual chapters, sheets and checklists, with no weeks). One is a class track: "48-Session Fully Scripted Youth Coaching Manual", `trk_c517c15740fb41`, with 3 blocks and 48 block sessions.
- 27 session templates with 240 items. Six more are held out (see HELD).
- The 13 blocks of the session script `scr_e2ed38b1a19670`, "Week 2 Monday". Its script row and 4 renderings were already committed and match the frozen record; the renderings match once CRLF is read as LF. The blocks make it version 2 where version 1 is loaded (R2), as the record's review note planned (R-ID-2).
- Every Backbone field with no column of its own goes into `details`, whole and by its Backbone name:
  - tracks: `part_heading`, `chapter_heading`, `groups`, `session_refs`, `subtitle`, `publisher_line`, `differences`, `field_provenance`, `owner_passages`, and the class track's own fields;
  - blocks: `description`, `optional_drill_refs`, `week_1_check`;
  - templates and items: the `details` column added by migration `workout-template-details` (lane YR-a; Overwatch's step-1 ruling Q3 A).
  - The field mapping is lane YR's step-1 report, section 1, as Overwatch accepted it. The exporter's `KEYS` list it.
- Stage links come from each record's `stage_keys`, as for FT1.

## What was not carried

- `stage_links`: derived from `stage_keys`.
- A template's `session_kind`, `track_id`, `status` and `sources`; the script's `session_kind`, `active`, `status` and `sources` (as FT1b).
- A track's `block_ids`: checked equal to its blocks in order.
- Research excerpts: all 469 `quote` keys, each in an evidence entry, are removed (OD-2026-10-02-013 answer 2A). The citation stays: source id, DOI, PMID, location and labels.
- One more sentence is removed: in `trk_d8b8995ec83114`, a sentence in an evidence entry's `sp10.limitations` repeated the cited paper's abstract. The rule: an `sp10` sentence that shares an 8-word run of words with its own entry's quote is dropped. The rest of that note and the citation stay. Found by the lane's fidelity review, ruled by Overwatch ("keep the citation by key and drop the run").
- Owner passages are carried: 354 passages, every one from DOC-027 (Punxsy Master Source Manual v1) or DOC-072 (Pro Boxing Skill System Master Registry), Jason's own material (Backbone card Q-208, RH-Q02 A; Overwatch, lane YR step 1).

## Drafted template fields (OD-2026-11-17-001)

- Jason: "B: AI drafts the values". 17 of the 27 loaded templates had blank fields: `session_type` 17, `difficulty` 17, `duration_minutes` 7, `intent` 2. These 43 values are drafted by Overwatch's order of basis and stay required: from the template's own frozen content (41, labelled `INFERRED`), otherwise from the same source document's sheet that matches its contact structure (2 durations of records that state no minutes, labelled `UNVERIFIED`, with the sheets used and the contrary values named).
- Each drafted field is labelled `INFERRED` or `UNVERIFIED` in `field_labels`, with the draft marker "AI draft, lane YR, 2026-11-17 (OD-2026-11-17-001)", its basis and its sources. The review sheet is `docs/content-review/youth-recreational/TEMPLATE_DRAFTS_REVIEW.md`.
- The lane's two reviewers pass the sheet; Jason does not review it (OD-2026-11-15-011). A miss is fixed by a new template version.
- The exporter's overwrite guard keeps the drafts: a rerun names the 17 drafted templates and writes nothing, unless `--allow-overwrite`.
- A written value is never drafted over. The ~10-minute "permanent circuit" keeps its 10; YR-a widens the check to 1-180.
- Three controlled-sparring items carry their sheet's minutes in `details.duration_minutes`, because the duration column takes none above light technical. The template page shows them as information. Issuing, timers and presets never read them (OD-2026-11-17-002; tested).

## HELD: not in this repository

- The six DOC-136 home-program days are held out: "Daily Boxing Training Program — Home Monday" to "Saturday", Days 1/7 to 6/7. Their ids are `wtp_40b6956ea37245`, `wtp_0f42c41a78dea4`, `wtp_fb399b5d31e70d`, `wtp_35c593e3b96cdf`, `wtp_b965c8174bd41a` and `wtp_f20745471ef7c4`, with 42 items in all.
- They are printed from USA Boxing High-Performance Coach Education (Rev. 03/23/2020): outside copyrighted material, neither PPBF-owned nor open-licence. OD-2026-10-02-013 answers 2A and 4A keep such text private, "in the database only, never in the public code repository", and no private load path exists for templates.
- Applied, not asked, by Overwatch (option B); Jason was told and may reverse it.
- The exporter lists them by id as HELD and counts them. A committed row of theirs is removed.
- The Personal and Home Training track (`trk_55480ac4429113`) still names them in its `session_refs`, as text. No draft was made for them.

## The fight-week weigh-in line (OD-2026-11-16-004)

- The frozen DOC-154 track `trk_98f1b755dce913` holds two sheets: `Fight_Week_Checklist_USA_Boxing.pdf` and `Fight_Week_One_Page_USA_Boxing.pdf`. Each prints a Thursday "REST / WEIGH-IN" line, the day before "FRIDAY – FIGHT DAY".
- Ruling 1 (OW25-23 A) puts the USA Boxing day-of weigh-in line beside each of those two lines. The sheet itself is not edited.
- The line is held in the track's `details.beside_lines`. That is an app key, not a Backbone field, labelled in `field_labels.beside_lines`. Each entry carries:
  - the sheet line;
  - the line, in the Backbone's own wording from the frozen spine (already in the repo in the pathway stage defaults);
  - its key, USAB-R11 / EXT-USAB-RB2026;
  - the caveat as OWNER_DECISIONS words it: the research session read the USA Boxing rule only in search-result excerpts.
- No rule-book sentence is quoted (Overwatch, lane YR Q6 A).
- Ruling 2 (OW25-24 A) covers the 5-days and 6-days weigh-in sheets. Those sheets are not in the frozen Backbone, so ruling 2 waits for the lane that loads them (Overwatch, lane YR Q5 A).
- CD-Q07 (the youth round length) stays where the Backbone holds it: `groups[].backbone_differences` on both sheets.
