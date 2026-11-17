# Assessment catalog: provenance

Lane CAT (OD-2026-11-15-006 ruling 1; OD-2026-11-16-001: the catalog's `meta` block is kept here as provenance, not loaded).

## Source

- Frozen Backbone file `working/design-2026-10-25/design_catalogs.json`, sha256[:16] `876ac31f5c677584`.
- Listed in `FREEZE_MANIFEST.json`, sha256[:16] `38b52df4c2d8d7a1` when exported.
- The file's own status line, as written: "Status: DRAFT, not app source until handoff (RULES.md)".
- Exported by `apps/web/scripts/backbone-export-assessment-catalog.mjs` (`npm run backbone:export:assessment-catalog -- <backbone-folder>`) into `apps/web/seed-data/assessment-catalog/`. The data is provisional: the exporter regenerates it at the final Backbone hand-off (OD-2026-10-28-002 route A).
- Every committed row carries `backbone_version` `catalogs 876ac31f5c677584` (the file's hash, never a time).

## What was loaded, and what was not

- Loaded:
  - 46 assessment protocols;
  - 2 scales (live_long_road, cue_response_draft);
  - 1 score cap (non_contact_rule, D-Q11);
  - 29 scorecard items;
  - 38 gates with 94 criteria;
  - 105 anchor-clip specs.
- Not carried:
  - `meta` and `status_line`: this page.
  - `default_rules` (2,918): already loaded as pathway stage defaults, lane BB-1c.
  - each protocol's `minted_from` (44): the hand-off placeholder the PP id replaced.
- Licensed excerpts: every `quotes` key is removed (4 keys, 10 passages, all in gate evidence `beside` entries; OD-2026-10-02-013 answer 2A). The citation stays (statement id, source key, location, labels).
- The field mapping is lane CAT's step-1 report, section 1, as Overwatch accepted it. The exporter's header lists it.
- Values the export reads rather than copies are labelled INFERRED in `field_labels`:
  - a scorecard item's `scale_key`, read from its scale text;
  - the cap's scale, protocol and contexts, read from its wording;
  - every protocol's `human_authority_required` (true; the Backbone does not state it per protocol; Backbone RULES section 1).
- Blank loads blank: quality_measured, boxing_specific and evidence_class (Overwatch's CAT ruling Q1).

## The two behavioural KPI lists (lane CAT-d; OD-2026-11-16-003)

- **Room list, DOC-027's 6 core behavioural KPIs:**
  - Exported by the same exporter from the frozen track `data/content/tracks/trk_21ba0c958c98e1.json` (sha256[:16] `4fd51410efa688f8`, listed in the manifest).
  - Source: the owner rule from "DOC-027 (Punxsy Master Source Manual v1, Performance Tracking Source Manual v3, Core Behavioral KPIs)" (D-PK77-1).
  - Its 6 lines and its scoring line are copied as written. The source line rides in each row's field labels, because it holds commas, which a source list refuses.
  - No scoring kind: DOC-027 states only the list-level line.
- **Drill list, DOC-041's 7 drill KPIs:**
  - DOC-041 is Jason's own material and is not in the frozen Backbone. Source: "Drill KPI Scorecards and Evaluation Forms Source Manual v3", Google Drive file `1vg-YDzyHtxVSpf-m1BsbFvp_4hsDF3Jl` (37,790 bytes, modified 2026-06-14), read read-only on 2026-11-16.
  - The 7 names (section "Core Drill KPIs Worth Scoring") and the three lines of section "Scoring Logic Standard", in order, are quoted verbatim (the first is the rule OD-2026-11-16-003 cites; all three carried, Overwatch ruling B, Backbone RULES s0).
  - These rows are committed by hand. The exporter keeps them exactly as written, in their place, and rewrites only the room rows.
- **Drafts:** each drill KPI's scoring kind, and the three-level anchors of Reset quality, Chase control and Composure under disruption, are AI drafts, labelled INFERRED with the draft marker (OD-2026-11-16-003 rulings 2 and 3; OD-2026-11-15-011). Review sheet: `docs/content-review/assessment-catalog/DRILL_KPI_ANCHORS_REVIEW.md`.

## The `meta` block, as written

```json
{
  "generated": "2026-10-25",
  "from": "spine.json draft-1 (2026-10-23, amended 2026-10-24), LR Part 2 section 3, repo ids.ts rule",
  "id_rule": "prefix + '_' + first 14 hex of sha256(NFC-trimmed identity string); see DATA_MODEL.md section 3",
  "counts": {
    "gates": 38,
    "criteria": 94,
    "default_rules": 2918,
    "spine_default_entries": 55,
    "scorecard_items": 29,
    "assessment_protocols": 46,
    "anchor_clip_specs": 105
  },
  "decisions_applied": {
    "folded": "2026-10-24 (US Eastern; decision records labelled 2026-10-25)",
    "entries": [
      {
        "id": "D-Q11",
        "where": "scale_definitions.non_contact_rule (Long Road wording, max 3 in non-contact contexts); draft non-contact wording withdrawn"
      },
      {
        "id": "D-Q15",
        "where": "default_rules: 48 LR-140 rows added (6 each on Y3, Y4, Y5, T1, AM1, AM2, AM3, RC1), split from the composite LR-140 default the spine already carries on those stages (Jason 2026-10-25); all 84 LR-140 rows carry decision D-Q15"
      },
      {
        "id": "D-Q21",
        "where": "gates T2 exit criterion pgc_0c95dcaf36d021: conflict resolved, items 5, 6, 17, 19"
      },
      {
        "id": "D-Q14",
        "where": "default_rules: override.extra_condition on the 36 PR sparring rows; missing_documents_note pro_override_docs"
      },
      {
        "id": "D-Q10",
        "where": "scale_definitions.cue_response_note"
      },
      {
        "id": "D-PK06",
        "where": "default_rules kind owner_rule (8 rows, PR1-PR5 pro_sparring_override_condition, RC1/FT1 recreation_lane_track, FT1 fitness_membership_non_contact): evidence_tier CONVENTION (was null); category stays owner_decision"
      },
      {
        "id": "D-PK61-FR",
        "where": "default_rules dft_b70c39d91a8f3a (display_text, phases months 0-12 and 12-18, sources LR-048 then LR-139) and dft_77ba1e542080f2 (display_text, sources LR-048, LR-139, LR-137; value_text light_technical unchanged, D-PK111-2): LR-048's timing as the T1 default (wording D-PK111-1; sources D-PK112-2; this entry D-PK112-3); 2026-11-08, PPBF Backbone Wave 2 A-60 Edits (wave-2 session 19)"
      },
      {
        "id": "D-PK57-FR",
        "where": "catalog-rows merge (PK-36 and PK-57 option B, D-PK36, D-PK57-FR, D-PK78-3-FR; ACTIONS A-60), 2026-11-09, PPBF Backbone Wave 2 Catalog Rows Merge (wave-2 session 20), A-50 method: 2733 default_rules rows added from the side-job draft (working/catalog-rows-draft-2026-11-09/; batches signed Q-179 to Q-194, register D-OQ179 to D-OQ194, one id in each row's decision field; scope D-PK122; information rows D-PK123; labels D-PK124); 40 gate criteria with criterion ids (pgc = gate_id:ordinal), 11 of them on the new T1 gate kind checkpoint_90_days (D-PK121; a schema P5 change); assessment_protocols list (46 rows: PP-T01 and PP-T02 from YOUTH_GATE_PROTOCOL.md s2, PP-T03 to PP-T46 drafted; D-PK120, D-PK118, D-PK127); one scorecard item from LR-131, not scorable until a scale is set (D-PK119, D-PK128); source_texts on dft_b70c39d91a8f3a and dft_77ba1e542080f2, their PK-61 wording unchanged (D-PK116, D-PK126); 87 existing rows the draft links (covered or agrees) unchanged (D-PK126); write plan D-PK126; register D-PK125 for the record rewordings"
      }
    ]
  },
  "evidence_merge": {
    "date": "2026-10-29",
    "by": "main build session, plan step 'Owner review of minimum done' (D-MRG03)",
    "applied": [
      {
        "id": "D-PK44",
        "where": "every default row, gate and scorecard item carries its tier in an evidence list (category, label, check state); the default rows' evidence_category and evidence_tier fields moved into it"
      },
      {
        "id": "HANDOVER item 2 (D-PN02, D-PN06, D-PN10)",
        "where": "default-row labels from working/evidence/DEFAULTS_TIERING_DRAFT.json rows: 126 CONVENTION, 19 UNTIERED (17 with source note 'Long Road practice'), 1 RULE (usab_bout_format Y5), 6 information rows with no label; add_sources on 6 rows"
      },
      {
        "id": "D-PN03",
        "where": "second RULE evidence entry (USA Boxing 2026 Rule 5.4) on the 15 stop-rule rows"
      },
      {
        "id": "D-PN04",
        "where": "display_text of the 5 pro_practice_sparring_reference rows (the unsourced 16.7 figure dropped); display_change keeps the draft's note"
      },
      {
        "id": "D-PN13, D-PK38",
        "where": "DEI-09 research entry on PR5 medical_trauma_management and AM2/AM3 annual_medical_review"
      },
      {
        "id": "D-PN08, D-PN11, D-PK52",
        "where": "DEI-07 and DEI-08 research entries on the 77 rows of the six sparring-ceiling keys"
      },
      {
        "id": "D-PN17, D-PN18, D-PN20, D-PK47, D-PK50",
        "where": "33 information rows: weight_class_selection_information and fight_week_nutrition_information on Y2-Y5, T1, T2, AM1-AM3, PR1-PR5; youth_weight_making_information on Y1-Y5"
      },
      {
        "id": "Session 6 item 4, D-PK50",
        "where": "gate pgt_dde8879b1fe827 (T2 exit): WCL-057 EMERGING and WCL-058 UNTIERED on criterion pgc_18534192823112"
      },
      {
        "id": "D-PK48",
        "where": "each second line is one more evidence entry carrying the draft's own fields"
      }
    ]
  }
}
```
