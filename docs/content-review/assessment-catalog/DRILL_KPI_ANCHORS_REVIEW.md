# Drill KPI scoring kinds and three-level anchors (lane CAT-d): review sheet

Status: AI drafts, labelled field by field (`field_labels.scoring_kind` and `field_labels.level_anchors`: status INFERRED, draft "AI draft, lane CAT-d, 2026-11-17 (OD-2026-11-16-003 rulings 2 and 3; OD-2026-11-15-011)").
- They load once the lane's two adversarial reviewers pass this sheet (OD-2026-11-15-011). A miss is fixed by a new version of the KPI row.
- A coach reviews them (OD-2026-11-16-003 ruling 3); this sheet is where that review is recorded.
- Rows: `apps/web/seed-data/assessment-catalog/seed_behavior_kpis.csv`, list `drill`.

## What is drafted, and what is not

- **Quoted, not drafted:**
  - the 7 KPI names, DOC-041 "Core Drill KPIs Worth Scoring";
  - the list's scoring line, DOC-041 "Scoring Logic Standard": "Use simple counts, yes-no marks, or three-level ratings when possible.";
  - DOC-027's 6 room KPIs and their scoring line (frozen track trk_21ba0c958c98e1, owner rule D-PK77-1).
- **Drafted:** each drill KPI's scoring kind. DOC-041 states the three kinds for the list but names no kind for any single KPI (Drive file `1vg-YDzyHtxVSpf-m1BsbFvp_4hsDF3Jl`, read 2026-11-16).
- **Drafted:** the three levels of the three KPIs drafted as three-level. DOC-041 does not word its levels (ruling 3).
- **Not drafted:** the room KPIs carry no scoring kind. DOC-027 states only its list-level line.
- Each list is shown in its own order; no row pairs a drill KPI with a room KPI (OD-2026-11-16-003 ruling 1).

Sources the drafts lean on, all frozen and checked verbatim:
- the DOC-027 glossary, track trk_1f8e1d681bb3ae: "Clean exit = leaving the exchange with posture, vision, and destination intact."; "Reset = restore breath, eyes, base, and decision quality before the next action."; "Chase = following movement with emotional urgency, usually hand-led and structurally weak."; "Composure = the ability to stay usable and decision-capable under pressure, contact, error, or delay."; "Disruption = any event that breaks normal rhythm or shape, such as contact, clinch, interruption, crowding, or timing breaks.";
- DOC-027's room KPIs (above);
- the frozen drill drl_3b1ec1fb7207bc's what-good-looks-like line "Athlete arrives in stance after the reposition." (its DOC-027 passage, "Touch to Reposition").

Level 1 is the lowest, level 3 the highest. A level describes what the coach sees in the set; it moves no one and limits nothing (Backbone RULES section 1).

## The 7 drill KPIs

| # | KPI (DOC-041, quoted) | Scoring kind (draft) | Why that kind |
|---|---|---|---|
| 1 | Clean exits. | count | DOC-041 allows counts; DOC-027 tracks the same behaviour ("Clean exits."). One count per clean exit in the set. |
| 2 | Reset quality. | three_level | A quality, so three levels; DOC-027 tracks "Reset success quality." |
| 3 | Chase control. | three_level | Control is a quality, so three levels. Alternative a coach may prefer: a count of chases, as DOC-027 counts "Chasing instances." |
| 4 | Exchange cap discipline. | yes_no | Kept or not, per exchange; DOC-027 tracks "Exchange cap compliance such as three-and-out when applicable." |
| 5 | Composure under disruption. | three_level | A quality, so three levels; DOC-027 tracks a "Composure rating." |
| 6 | Correct decision branch selection. | count | One count per correct branch chosen in the set. DOC-027 keeps "Decision quality notes under stress." as notes, not a scale. |
| 7 | Arrival in stance after action. | yes_no | Arrived in stance or not, per rep; a frozen drill's what-good-looks-like line says it. |

## The three-level anchors (drafts)

**2. Reset quality.** Built on "Reset = restore breath, eyes, base, and decision quality before the next action."
- 1: Starts the next action with breath, eyes or base still broken.
- 2: Restores breath, eyes and base before the next action, but decision quality lags; or restores all four only after a coach cue.
- 3: Restores breath, eyes, base and decision quality before the next action, without a cue.
- Note: "without a cue" (level 3) and "only after a coach cue" (level 2) are my addition; the glossary does not speak of cues. Level 2 was reworded at review so the three levels do not overlap (an athlete who starts the next action with the base still broken is level 1, not level 2).

**3. Chase control.** Built on "Chase = following movement with emotional urgency, usually hand-led and structurally weak."
- 1: Chases: follows the partner's movement with urgency, hand-led, and the structure breaks.
- 2: Mostly controlled, but chases at least once in the set: the hands lead and the shape slips, then recovers.
- 3: Does not chase: follows or cuts off movement with the feet and the structure intact, hands not leading.
- Note: "at least once in the set" (level 2) and "cuts off ... with the feet" (level 3) are my addition.

**5. Composure under disruption.** Built on the glossary's "Composure" and "Disruption".
- 1: After a disruption (contact, clinch, crowding, a timing break), shape or decisions break down and do not recover in the rep.
- 2: Stays usable after a disruption but with a visible lapse (a late, rushed or skipped decision), then recovers.
- 3: Stays usable and decision-capable through the disruption: shape and decisions hold.
- Note: "a late, rushed or skipped decision" (level 2) and "do not recover in the rep" (level 1) are my addition.

## Flags (for the reviewers and the coach)

- No source states a scoring kind for any one drill KPI. All seven kinds are drafts, and two have a plausible alternative: Chase control as a count of chases, and Correct decision branch selection as three levels.
- "Decision branch" has no definition anywhere in the frozen Backbone (searched; research finding `Documents/PPBF-overwatch/research/claude-research-project/findings/2026-11-16-doc041-kpi-scorecards-and-doc154-weigh-in.md` section 3.2, row K6, NOT APP SOURCE). The count reads it as "the right option among the ones the drill offers".
- Exchange cap discipline and Arrival in stance are yes-no per exchange or per rep. A coach tallies them over a set, which makes them counts in practice; the kind records the mark, not the tally.

## Reviewer verdicts

Recorded in the CAT-d PR.
