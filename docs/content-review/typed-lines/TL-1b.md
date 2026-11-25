# Lane W4-8, TL-1b: the typed steps of the three 48-Session Youth Coaching Manuals link their drills (review sheet)

Rulings: OD-2026-11-19-030 (OW26-05, Jason: "B: Turn typed lines into library drills"); OD-2026-11-20-001 OW27-09 ("B: A new drill for every line"); OD-2026-11-15-011 (two adversarial reviewers pass this sheet). Plan and GO: #2162. The drills: TL-1a, `docs/content-review/typed-lines/TL-1a.md`.

## What this PR changes

- 30 steps of `wtp_43c793b8f90e77` (Weeks 1–4), `wtp_ed57bea28de0f7` (Weeks 5–8) and `wtp_d861f584584788` (Weeks 9–12), steps 1, 2 and 7–14 of each: `drill_id` set to the TL-1a drill written for the step's line, `free_text_drill` cleared (the import's rule for a linked step, `contentImport/aiPrompt.ts:136-139`). Block, contact (`none`), coach note, scale and `details` are unchanged. The line stays word for word in the drill's `source_ref`.
- Each of the three templates gains one `field_labels` entry, `items.drill_id`: `INFERRED`, with the lane W4-8 draft marker, naming the linked steps. No other cell of the template rows changes.
- The three manuals leave `TYPED_IN_MIXED` in `committedTemplateIssueSweep.test.ts`: on a fresh load they now plan with no refusal (the sweep's exact allowlist would fail on any new one).
- At load, each changed template becomes its next version (`specs/templates.ts:33-38`). A version holding a coach's in-app edit is `held`, not revised (`contentImport/inAppEdits.ts`): Overwatch's dry run shows that.
- Frozen Backbone: the youth-recreational export would write these 30 typed lines back. Its guard refuses (lane GD), and its frozen-folder case now expects exactly these 30 steps and three templates (`backbone-export-youth-recreational.test.ts`, `LANE_W48_STEPS`). Written where the frozen folder is absent: UNVERIFIED until Overwatch runs it on Jason's PC (GO answer, item 3).

## The 30 steps

| template | step | block | typed line (as committed before this PR) | drill |
|---|---|---|---|---|
| Weeks 1–4 | 1 | warmup | Jump rope progression (rhythm → alternating feet → high knees). | `drl_dce3452a913583` Jump Rope Progression: Rhythm, Alternating Feet, High Knees |
| Weeks 1–4 | 2 | warmup | Dynamic mobility (hips, thoracic rotation, shoulders). | `drl_40f93d01bd4b69` Dynamic Mobility for Hips, Upper Back and Shoulders |
| Weeks 1–4 | 7 | applied_rounds | Round 1: Technical scoring only. | `drl_2bd1d0742ece8d` Applied Round 1: Technical Scoring Only |
| Weeks 1–4 | 8 | applied_rounds | Round 2: Add movement exit. | `drl_8c42877a38946f` Applied Round 2: Add a Movement Exit |
| Weeks 1–4 | 9 | applied_rounds | Round 3: Add defensive trigger. | `drl_5927f2f35347c2` Applied Round 3: Add a Defensive Trigger |
| Weeks 1–4 | 10 | conditioning | 5×20 sec straight punch bursts | `drl_6396e76abea2e0` Straight Punch Bursts, 5 x 20 Seconds |
| Weeks 1–4 | 11 | conditioning | 40 sec controlled footwork between bursts | `drl_ba386c3e7d41e1` Controlled Footwork Between Bursts, 40 Seconds |
| Weeks 1–4 | 12 | character_integration | Character Focus: Discipline – Build routine, follow structure without reminders. | `drl_0ef91e6a066df9` Character Focus: Discipline |
| Weeks 1–4 | 13 | character_integration | 4-sec inhale / 6-sec exhale breathing reset. | `drl_0967cc300cfc5e` Breathing Reset: 4-Second Inhale, 6-Second Exhale |
| Weeks 1–4 | 14 | character_integration | 2-minute life-skill discussion tied to training. | `drl_1e56dfc77428eb` Life-Skill Talk Tied to Training (2 Minutes) |
| Weeks 9–12 | 1 | warmup | Jump rope progression (rhythm → alternating feet → high knees). | `drl_dce3452a913583` Jump Rope Progression: Rhythm, Alternating Feet, High Knees |
| Weeks 9–12 | 2 | warmup | Dynamic mobility (hips, thoracic rotation, shoulders). | `drl_40f93d01bd4b69` Dynamic Mobility for Hips, Upper Back and Shoulders |
| Weeks 9–12 | 7 | applied_rounds | Round 1: Technical scoring only. | `drl_2bd1d0742ece8d` Applied Round 1: Technical Scoring Only |
| Weeks 9–12 | 8 | applied_rounds | Round 2: Add movement exit. | `drl_8c42877a38946f` Applied Round 2: Add a Movement Exit |
| Weeks 9–12 | 9 | applied_rounds | Round 3: Add defensive trigger. | `drl_5927f2f35347c2` Applied Round 3: Add a Defensive Trigger |
| Weeks 9–12 | 10 | conditioning | 5×30 sec bursts | `drl_273f6b1e785e96` Conditioning Bursts, 5 x 30 Seconds |
| Weeks 9–12 | 11 | conditioning | Strict 1-minute rest intervals | `drl_7c236b9eb91129` Strict 1-Minute Rest Intervals |
| Weeks 9–12 | 12 | character_integration | Character Focus: Confidence & Leadership – Execute under fatigue, model standards for peers. | `drl_b6903e7c2c7291` Character Focus: Confidence and Leadership |
| Weeks 9–12 | 13 | character_integration | 4-sec inhale / 6-sec exhale breathing reset. | `drl_0967cc300cfc5e` Breathing Reset: 4-Second Inhale, 6-Second Exhale |
| Weeks 9–12 | 14 | character_integration | 2-minute life-skill discussion tied to training. | `drl_1e56dfc77428eb` Life-Skill Talk Tied to Training (2 Minutes) |
| Weeks 5–8 | 1 | warmup | Jump rope progression (rhythm → alternating feet → high knees). | `drl_dce3452a913583` Jump Rope Progression: Rhythm, Alternating Feet, High Knees |
| Weeks 5–8 | 2 | warmup | Dynamic mobility (hips, thoracic rotation, shoulders). | `drl_40f93d01bd4b69` Dynamic Mobility for Hips, Upper Back and Shoulders |
| Weeks 5–8 | 7 | applied_rounds | Round 1: Technical scoring only. | `drl_2bd1d0742ece8d` Applied Round 1: Technical Scoring Only |
| Weeks 5–8 | 8 | applied_rounds | Round 2: Add movement exit. | `drl_8c42877a38946f` Applied Round 2: Add a Movement Exit |
| Weeks 5–8 | 9 | applied_rounds | Round 3: Add defensive trigger. | `drl_5927f2f35347c2` Applied Round 3: Add a Defensive Trigger |
| Weeks 5–8 | 10 | conditioning | 4×30 sec punch bursts | `drl_4df0b9ab4b632c` Punch Bursts, 4 x 30 Seconds |
| Weeks 5–8 | 11 | conditioning | Add 4th round simulation in Weeks 7–8 | `drl_1508f028c4ce4e` Fourth-Round Simulation (Weeks 7-8) |
| Weeks 5–8 | 12 | character_integration | Character Focus: Composure & Accountability – Stay calm under pressure, accept correction immediately. | `drl_4cc1133e4158e8` Character Focus: Composure and Accountability |
| Weeks 5–8 | 13 | character_integration | 4-sec inhale / 6-sec exhale breathing reset. | `drl_0967cc300cfc5e` Breathing Reset: 4-Second Inhale, 6-Second Exhale |
| Weeks 5–8 | 14 | character_integration | 2-minute life-skill discussion tied to training. | `drl_1e56dfc77428eb` Life-Skill Talk Tied to Training (2 Minutes) |
