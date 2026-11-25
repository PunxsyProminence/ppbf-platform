# Lane W4-8, TL-5a: drills for the typed steps of Conditioning session A (SIT) and the Phase 1 boxing skill session (review sheet)

Rulings: OD-2026-11-19-030 (OW26-05, Jason: "B: Turn typed lines into library drills"); OD-2026-11-20-001 OW27-09 (Q8.1: "B: A new drill for every line"); Q8.2 (Overwatch on #2050: a heading is a typed line); OD-2026-11-15-011 (AI drafts load once the lane's two adversarial reviewers pass this sheet; fixes by new drill version only); D-PK73-3, D-OQ57, D-OQ58 (the owner items these steps carry); App Overwatch's answers on #2201 (comment 7170675682: the issue order and the finisher's dose). Plan and GO: #2162.

Source: the typed steps of `wtp_01de3f48606d4c` (Conditioning session A — SIT, 45 min; LR-225; steps 1, 3, 4, and the owner items 5, 6 from DOC-072 W-PHYS-01-C) and `wtp_c2c4bec001a56b` (Phase 1 — Foundation / Novice — Boxing skill session, 90 minutes; LR-217/LR-051; steps 1, 4, 5, 6 with their plan items, and the owner item 7), as committed: each step's typed line (quoted word for word in its drill's `source_ref`), its details, and the owner passages on each template. Difficulty `beginner` on all 10 (the templates').

## What this PR changes

- 10 new library drills, one per typed step, labelled as the lane's earlier drills (lane W4-8 draft marker on all 14 drafted fields, COACHING-CRAFT DRAFT provenance, evidence UNTIERED/unchecked, blank stage keys); scale levels A, B (start), C; at least one own stop rule each; a cue on every technique drill.
- The 10 steps link their drills (`drill_id` set, `free_text_drill` cleared); `details` unchanged. Each template's own `items` label gains the lane's `drill_id` part. Both leave `TYPED_IN_MIXED`.
- Frozen Backbone: both are youth-recreational exports (their stage keys include RC1); their steps join `LANE_W48_STEPS`. UNVERIFIED where written; App Overwatch runs the frozen case before merging (#2162).
- Default field bases (every drill, unless its section lists another): name: the step's typed line; discipline: the step's block (the library holds only boxing and conditioning); category: the step's block; target_behavior: AI draft from the typed line and the step's own details; purpose: AI draft from the step's phase and time, and the template's name; standard_setup: AI draft; contact none, as the step's own contact level; execution: AI draft from the typed line, word for word in substance; adds coaching detail it does not give (shown in full on the review sheet); what_good_looks_like: AI draft from the typed line; contact_level: the step's own contact level (none); equipment_needed: the typed line's own words, or none; difficulty: the template's difficulty (beginner); scale_levels: AI draft: A simpler, B the step as written (starting point), C harder, same lesson and no contact; stop_rules: AI draft from the typed line; cues: the step's own words or an owner passage on the template, word for word.

## Flags for the reviewers and for a coach edit

- Every step is contact none except Phase 1 step 1, which is light_technical: its plan item names 'one pre-activation cue drill', the drill D-OQ94 (Jason, Q-94 A) rates light_technical, as lane YR rated the permanent circuit's item 1 (App Overwatch on #2201, comment 7176799736; the step was none, inferred from LR-051). Its drill carries the library Pre-activation drill's (drl_4ec23d961e27f7) setup and execution in substance and its three stop rules word for word; level A (holds and bracing on the cue, no push) is none, levels B and C light_technical. The template's own 'items' label gains the lane's 'contact_level' part. Every other drill and scale level is contact none. No new warning, gate or disclaimer.
- Conditioning session A's steps 5 and 6 are the owner's own items (D-PK73-3; DOC-072 W-PHYS-01-C). Their drills carry DOC-072's stop rule word for word; their cues are the typed lines reworded as calls (no committed source gives one).
- Issue order (Codex P1 on #2201; App Overwatch's answer there): the issue path orders steps by ordinal (`workoutTemplates.ts`, `order by i.ordinal asc`) and does not read `details.within_item_id`, where D-PK73-3's placement of steps 5 and 6 is held. Until TL-ORD merges (this lane's next PR, App Overwatch on #2201, comment 7170675682), an issued Conditioning session A lists the fresh check and the after check after the cool-down and the record step; each check's card says when it runs. TL-ORD issues an item with `details.within_item_id` right after its parent (the same comment); App Overwatch releases TL-5a only with TL-ORD merged.
- Phase 1's step 5 (the burst finisher): the plan item's efforts and recoveries take about 4 of the block's 8 minutes either way (8 × (20 s + 10 s), or 4 × (30 s + 30 s)). The drill keeps that dose; no source says what fills the rest of the block (App Overwatch's answer on #2201: keep the source's dose, say what it gives). Level C (both options, about 8 minutes) is the AI draft's way of filling the block, kept unchanged by that answer; a coach may prefer otherwise.
- Phase 1's step 4 keeps the owner's round-focus rule (D-OQ58) and the DOC-027 owner passage beside the block (its stop rules and cue word for word). Round 5 is "Open at 70%" on the bag (contact none).
- Phase 1's step 1: the plan items' headings 'Neuromuscular activation' and 'Cervical activation' stay in the step's details; the drill says 'Activation' and 'Neck'.
- Phase 1's step 7 (Evaluate → Reset): the sources give the step's name and place only (DOC-027's session template; D-OQ57); its content is an AI draft, and what "Reset" covers is a question for Jason in the PR.
- Conditioning session A's template holds an owner's top-level `items.drill_id` label (D-OQ99, the main set's SIT link); this PR leaves it unchanged and adds the lane's part inside the `items` label, as on every lane template.
- AI-drafted beyond the steps: every drill's levels A and C; the stop rules not marked as sourced; the two check cues.

## The 10 drills

| template | step | drill_id | name | discipline / category |
|---|---|---|---|---|
| Conditioning session A | 1 | `drl_db082783ba4f15` | SIT Warm-Up: Easy Minutes, Progressive Builds, Two Maximal Efforts | conditioning / warmup |
| Conditioning session A | 3 | `drl_4f85f40352957b` | SIT Cool-Down: Easy Until Heart Rate Under 120, Then Mobility | conditioning / cooldown |
| Conditioning session A | 4 | `drl_f49dc21b0918ef` | SIT Record: Speed or Power at 7, 17 and 27 Seconds of Each Rep | conditioning / conditioning |
| Conditioning session A | 5 | `drl_b7720d791b970b` | Fresh Technical Check Before the Conditioning Set | boxing / technical |
| Conditioning session A | 6 | `drl_e7279a0244efa5` | Same Technical Check After the Conditioning Set, First-Failure Log | boxing / technical |
| Phase 1 skill session | 1 | `drl_6d21ac893974ec` | Phase 1 Warm-Up: General, Joint Prep, Activation, Neck Holds | conditioning / warmup |
| Phase 1 skill session | 4 | `drl_6529e148d4b491` | Bag Rounds on the Session Focus: Themes With KPIs, 5 × 3 Minutes | boxing / bagwork |
| Phase 1 skill session | 5 | `drl_02c1253c606e21` | Burst Finisher: 20/10 on Bike or Treadmill, or Maximal Shadow Rounds | conditioning / conditioning |
| Phase 1 skill session | 6 | `drl_a5f52ff0aa9d2e` | Phase 1 Cool-Down: Easy Movement, Static Stretching, 4-2-6 Breathing, Log | conditioning / cooldown |
| Phase 1 skill session | 7 | `drl_4845ed05215e9b` | Evaluate → Reset: Close the Session on Its One Focus | boxing / technical |

### Conditioning session A, step 1. SIT Warm-Up: Easy Minutes, Progressive Builds, Two Maximal Efforts (`drl_db082783ba4f15`)

- Typed line: "5 min easy → 5 × 20 s progressive builds with 60 s easy → 2 × 5 s at maximum"
- Purpose: The SIT session's warm-up (15 min): prepare for the all-out 30-second reps of the main set. Target: Reach the main set warm and ready for all-out work: easy minutes, progressive builds, then two short maximal efforts.
- Setup: The machine or track the main set uses (the SIT drill: a curved treadmill, an air bike or Watt bike, or outdoor sprints on grass or a track); no partner and no contact.
- Execution: 5 minutes easy, then 5 progressive builds of 20 seconds, each followed by 60 seconds easy, then 2 efforts of 5 seconds at maximum.
- Good: Each build rises steadily from easy to fast; the two 5-second efforts are truly maximal; the athlete starts the main set warm, not tired.
- Scale: A: 5 minutes easy and the 5 builds; the two 5-second efforts hard but not maximal. [No maximal efforts.] | B (start): The warm-up as written. | C: As written, each build reaching a higher top speed than the last, the last two near maximum. [Steeper builds.]
- Stop: Restart the builds when a build starts at full speed instead of rising from easy. (intent_drift) | Dizziness or light-headedness: slow to an easy walk and breathe normally; the coach checks before the next part. (safety)
- Cue: none (conditioning)
- Bases: name: the typed line's three parts (easy, progressive builds, maximal efforts), and the template's SIT main set; standard_setup: the SIT drill's setup (drl_dbe3f9dd2d62cc), which the main set links; contact none; stop_rules: AI draft: the first from the typed line's 'progressive builds'; the second adapted from the lane's Breathing Reset stop (drl_0967cc300cfc5e, 'Dizziness or light-headedness: stop the count and breathe normally.'); after maximal work the athlete slows to a walk rather than stopping dead, and the coach checks before the next part (both this lane's); cues: none: a conditioning drill needs no cue (OD-2026-10-06-026 ruling 2), and the line gives none

### Conditioning session A, step 3. SIT Cool-Down: Easy Until Heart Rate Under 120, Then Mobility (`drl_4f85f40352957b`)

- Typed line: "Easy until HR <120, then mobility"
- Purpose: The SIT session's cool-down (8 min), after the all-out main set. Target: Bring heart rate down under 120 with easy movement, then move on to mobility.
- Setup: The machine or track at an easy pace, then floor space for mobility; a way to read heart rate (a monitor or a pulse count); no partner and no contact.
- Execution: Keep moving easily until heart rate is under 120, then mobility work the coach sets.
- Good: Heart rate is under 120 before mobility starts; the mobility is slow and relaxed.
- Scale: A: Easy movement until heart rate is under 120, then a short mobility set. [Short mobility.] | B (start): Easy until heart rate is under 120, then mobility, as written. | C: As written, the athlete reading their own heart rate and noting how long it took to fall under 120. [Athlete-read.]
- Stop: Dizziness or light-headedness: slow to an easy walk and breathe normally; the coach checks before the next part. (safety)
- Cue: none (conditioning)
- Equipment: a heart-rate monitor, or a pulse count
- Bases: name: the typed line; equipment_needed: the typed line's 'HR <120' needs a heart-rate reading; 'or a pulse count' is this lane's; execution: the typed line; the mobility is the coach's (the line names none); stop_rules: adapted from the lane's Breathing Reset stop (drl_0967cc300cfc5e, 'Dizziness or light-headedness: stop the count and breathe normally.'); after maximal work the athlete slows to a walk rather than stopping dead, and the coach checks before the next part (both this lane's); cues: none: a conditioning drill needs no cue (OD-2026-10-06-026 ruling 2), and the line gives none

### Conditioning session A, step 4. SIT Record: Speed or Power at 7, 17 and 27 Seconds of Each Rep (`drl_f49dc21b0918ef`)

- Typed line: "Speed or power at 7 s, 17 s, 27 s of each rep"
- Purpose: The SIT session's record: a written trace of each all-out rep, so its decline and progress can be seen. Target: Record speed or power at 7, 17 and 27 seconds of every main-set rep.
- Setup: A way to read speed or power during each rep (the SIT drill: "A way to record speed or power at 7 s, 17 s and 27 s of each rep"), and a sheet or notebook; no partner and no contact.
- Execution: During each 30-second rep of the main set, record speed or power at 7, 17 and 27 seconds; keep the record with the session.
- Good: Three readings for every rep, written down in the same session.
- Scale: A: The coach takes and writes the readings. [Coach-recorded.] | B (start): Speed or power at 7, 17 and 27 seconds of each rep, as written. | C: As written, and the athlete also notes each rep's drop from 7 to 27 seconds. [Decline noted.]
- Stop: Stop the session when the readings show paced reps (flat from 7 to 27 seconds) instead of all-out attacks. (intent_drift)
- Cue: none (conditioning)
- Equipment: a speed or power read-out (or distance markers), and a sheet or notebook
- Bases: name: the typed line, in its phase (Record); category: conditioning: the record belongs to the SIT main set (the step's block, cooldown, is where the template files its Record row); standard_setup: the SIT drill's setup (drl_dbe3f9dd2d62cc), word for word in part; equipment_needed: the SIT drill's setup (drl_dbe3f9dd2d62cc); 'sheet or notebook' is this lane's; stop_rules: the SIT drill's stop 'Stop the session when the reps turn into paced efforts instead of all-out attacks.' (drl_dbe3f9dd2d62cc), read through the record; 'flat from 7 to 27 seconds' is this lane's reading of a paced rep; cues: none: a conditioning drill needs no cue (OD-2026-10-06-026 ruling 2), and the line gives none

### Conditioning session A, step 5. Fresh Technical Check Before the Conditioning Set (`drl_b7720d791b970b`)

- Typed line: "fresh technical check"
- Purpose: The owner's check at the end of the warm-up, before the SIT main set (D-PK73-3): the fresh baseline for whether the conditioning affects position, perception, action, defense, exit or reset. Target: Show the selected boxing skill while fresh, scored so the same check can be repeated after the conditioning.
- Setup: A timer, a bag and a notebook; a partner and mitts optional; video optional; no contact.
- Execution: At the end of the warm-up, before the main set, the athlete performs the technical skill the coach has selected, fresh; the coach notes how it looks so the same check can be repeated straight after the main set.
- Good: A clear note of the skill done fresh: position, perception, action, defense, exit and reset as the coach sees them.
- Scale: A: A few reps of the one selected skill, the coach noting. [A few reps.] | B (start): The fresh technical check as written. | C: As written, and the athlete notes their own check beside the coach's. [Athlete notes too.]
- Stop: Stop/regress when guessing, blind reset, stance collapse, guard abandonment, or target-skill disappearance prevents training transfer (technique_degradation)
- Cue: "Fresh technical check."
- Equipment: timer, bag, notebook; partner/mitts optional; video optional
- Bases: name: the owner's item 'fresh technical check' (DOC-072 W-PHYS-01-C, 'Rounds'; D-PK73-3) and its place, before the main set; discipline: boxing, technical: DOC-072's skill families 'PHYS-01; SKILL-11; selected technical owner'; category: technical: a boxing skill check; purpose: DOC-072 (Pro Boxing Skill System Master Registry, Workout_Map W-PHYS-01-C), column 'Objective' ('Identify whether conditioning exposure affects position, perception, action, defense, exit, or reset'), and the item's timing (D-PK73-3); standard_setup: DOC-072 (Pro Boxing Skill System Master Registry, Workout_Map W-PHYS-01-C), column 'Equipment' ('timer, bag, partner/mitts optional, video optional, notebook'); contact none; equipment_needed: DOC-072 (Pro Boxing Skill System Master Registry, Workout_Map W-PHYS-01-C), column 'Equipment'; execution: the owner item and its timing (D-PK73-3); 'the skill the coach has selected' is DOC-072's 'selected technical owner'; what_good_looks_like: DOC-072 (Pro Boxing Skill System Master Registry, Workout_Map W-PHYS-01-C), column 'Objective'; stop_rules: DOC-072 (Pro Boxing Skill System Master Registry, Workout_Map W-PHYS-01-C), column 'Stop_Rules', word for word; cues: the typed line's own words, reworded as a call (no committed source gives a cue for this check)

### Conditioning session A, step 6. Same Technical Check After the Conditioning Set, First-Failure Log (`drl_e7279a0244efa5`)

- Typed line: "same technical check; first-failure log; regression note"
- Purpose: The owner's check straight after the SIT main set, before the cool-down (D-PK73-3): does the skill hold under fatigue, and what broke first. Target: Repeat the same technical check straight after the conditioning, log the first failure and note the regression.
- Setup: The same timer, bag and notebook as the fresh check; a partner and mitts optional; video optional; no contact.
- Execution: Straight after the main set, repeat the same technical check; log the first failure (which part broke first: position, perception, action, defense, exit or reset) and write a regression note for the next session. Record the conditioning exposure and rest actually used.
- Good: The check is still trainable and measurable after the conditioning, and the first failure and the regression note are written down.
- Scale: A: The coach logs the first failure; the athlete only performs. [Coach-logged.] | B (start): Same technical check, first-failure log and regression note, as written. | C: As written, and the athlete names their own first failure before the coach's note. [Athlete names it.]
- Stop: Stop/regress when guessing, blind reset, stance collapse, guard abandonment, or target-skill disappearance prevents training transfer (technique_degradation)
- Cue: "Same technical check."
- Equipment: timer, bag, notebook; partner/mitts optional; video optional
- Bases: name: the owner's item (DOC-072 W-PHYS-01-C, 'Rounds'; D-PK73-3) and its place, after the main set; discipline: boxing, technical: DOC-072's skill families 'PHYS-01; SKILL-11; selected technical owner'; category: technical: a boxing skill check; purpose: DOC-072 (Pro Boxing Skill System Master Registry, Workout_Map W-PHYS-01-C), column 'Objective', and the item's timing (D-PK73-3); standard_setup: DOC-072 (Pro Boxing Skill System Master Registry, Workout_Map W-PHYS-01-C), column 'Equipment'; contact none; equipment_needed: DOC-072 (Pro Boxing Skill System Master Registry, Workout_Map W-PHYS-01-C), column 'Equipment'; execution: the owner item; the first-failure parts are DOC-072 (Pro Boxing Skill System Master Registry, Workout_Map W-PHYS-01-C)'s 'Objective'; 'Record the conditioning exposure and rest actually used' is its 'Work_Rest' ('No universal dosage in v1; record exposure and rest actually used'); what_good_looks_like: DOC-072 (Pro Boxing Skill System Master Registry, Workout_Map W-PHYS-01-C), column 'Pass_Fail' ('Pass if the post-exposure technical check remains trainable and measurable'); stop_rules: DOC-072 (Pro Boxing Skill System Master Registry, Workout_Map W-PHYS-01-C), column 'Stop_Rules', word for word; cues: the typed line's own words, reworded as a call (no committed source gives a cue for this check)

### Phase 1 skill session, step 1. Phase 1 Warm-Up: General, Joint Prep, Activation, Neck Holds (`drl_6d21ac893974ec`)

- Typed line: "Warm-up — 12 min"
- Purpose: The Phase 1 skill session's warm-up (12 min), before the technical blocks. Target: A 12-minute warm-up in four parts: general, joint prep, activation, neck holds.
- Setup: Floor space for each athlete; a skipping rope, a resistance band and a medicine ball. For the pre-activation cue drill in the neck part: the athlete in stance wearing headgear; the coach stands in front within arm's reach to give a light push on the headgear, or a swinging bag is set to give a light tap; the coach agrees the cue types (visual and auditory) before starting.
- Execution: 1. General (3 min): skipping, or easy movement in stance. 2. Joint prep (4 min): ankle rocks, hip 90/90 transitions, thoracic open-books, band shoulder circuits. 3. Activation (3 min): 3 × 10 s fast feet; 2 × 5 medicine-ball chest passes; 4 × 5 s rapid jab flurries at 50%. 4. Neck (2 min): isometric holds, 3 × 10 s each plane, and one pre-activation cue drill: on the coach's cue (a visual or an auditory cue) the athlete braces the neck, chin tucked, neck firm, eyes forward; the coach then gives a light, controlled push on the headgear (or the swinging bag gives a light tap) and the athlete holds head position.
- Good: Each part in its minutes; fast feet and jab flurries quick but at 50%; the neck holds steady, with no jerking; in the pre-activation cue drill the brace comes on the cue, before the push, and the push stays light and controlled.
- Scale: A: The four parts at an easy pace, the neck holds gentle; in the pre-activation cue drill the athlete braces on the cue with no push. [Easy pace; no push.] | B (start): The warm-up as written. | C: As written, the fast feet and the medicine-ball passes at full speed; the jab flurries stay at 50%. [Faster activation.]
- Stop: Stop any part that hurts; the coach checks before the athlete goes on. (safety) | Stop the set when the push or the bag tap stops being light and controlled; reset the force before continuing. (safety) | Stop the set when the brace comes late (after the push) on repeated reps; go back to level A. (technique_degradation) | Stop and regress when the drill becomes the session goal or leaves posture, guard or footwork worse in the boxing task that follows. (intent_drift)
- Cue: none (conditioning)
- Equipment: skipping rope (optional), resistance band, medicine ball, headgear; a swinging bag (optional)
- Contact: light_technical (the drill, levels B and C, and the step); level A none. light_technical: the step's plan item names 'one pre-activation cue drill', the drill D-OQ94 (Jason, Q-94 A) rates light_technical; the step is light_technical too (App Overwatch on #2201, comment 7176799736); was none, inferred from LR-051.
- Bases: name: the step's four plan items (General, Joint prep, Neuromuscular activation, Cervical activation), in plain words; purpose: the template's structure ('warm-up 12 → acquisition 20 → refinement under variability 20 → specific/bag 20 → conditioning finisher 8 → cool-down 10'); execution: the step's plan items, word for word in substance; the headings 'Neuromuscular activation' and 'Cervical activation' stay in the step's details and are shortened to 'Activation' and 'Neck' here; part 4's pre-activation cue drill is the execution of the library's Pre-activation drill (drl_4ec23d961e27f7), which D-OQ94 (Jason, Q-94 A) rates light_technical; App Overwatch on #2201, comment 7176799736, in substance; equipment_needed: the plan items' skipping, band and medicine ball ('MB'); headgear and the swinging bag from the library's Pre-activation drill (drl_4ec23d961e27f7); what_good_looks_like: AI draft from the plan items' minutes and '50%'; 'no jerking' is this lane's; the pre-activation part from the what-good-looks-like of the library's Pre-activation drill (drl_4ec23d961e27f7), in substance; stop_rules: AI draft (a stop for a part that hurts); ordinals 2 to 4 are the library's Pre-activation drill (drl_4ec23d961e27f7) stop rules, word for word; standard_setup: AI draft for the first three parts; the pre-activation cue drill's setup is the library's Pre-activation drill (drl_4ec23d961e27f7), which D-OQ94 (Jason, Q-94 A) rates light_technical; App Overwatch on #2201, comment 7176799736, in substance; contact_level: light_technical: the step's plan item names 'one pre-activation cue drill', the drill D-OQ94 (Jason, Q-94 A) rates light_technical; the step is light_technical too (App Overwatch on #2201, comment 7176799736); was none, inferred from LR-051; scale_levels: AI draft: A simpler, B the step as written (starting point), C harder, same lesson and no contact; level A has no push (contact none), levels B and C are light_technical (App Overwatch on #2201, comment 7176799736); cues: none: a conditioning drill needs no cue (OD-2026-10-06-026 ruling 2), and the step gives none

### Phase 1 skill session, step 4. Bag Rounds on the Session Focus: Themes With KPIs, 5 × 3 Minutes (`drl_6529e148d4b491`)

- Typed line: "Specific/physical block — 20 min"
- Purpose: The Phase 1 skill session's specific/physical block (20 min): the session's one focus on the bag, the block doubling as aerobic and buffering work. Target: Five 3-minute bag rounds, each a theme that carries the session's one focus, each theme kept to its KPI.
- Setup: A heavy bag per athlete; a heart-rate monitor; no partner and no contact.
- Execution: Bag work, 5 × 3 min with 1 min rest. The coach picks the round themes that carry the session's one focus (the Technical block A item; a theme may repeat) and keeps each theme's KPI: 1. Jab only, all variations (no two consecutive identical jabs). 2. 1-2 and pivots (every combination ends off the line it started on). 3. Defense-to-counter, shadow-and-bag (every defensive action produces a return). 4. Body work (entry, two shots, exit). 5. Open at 70% (maximum 3 punches per sequence, movement after every sequence). One cue, and one correction per round, on that focus. Heart rate monitored.
- Good: Every round serves the one focus and meets its KPI; one cue for the block, and one correction per round; the work stays clean as the rounds go on.
- Scale: A: One theme for every round (a theme may repeat), at a controlled pace. [One theme.] | B (start): Five themed rounds with their KPIs, as written. | C: As written, the coach counting each round's KPI and telling the athlete the count in the rest. [KPI counted.]
- Stop: If fatigue breaks decisions, downgrade before intensity rises further. (fatigue) | If the room loses purpose, simplify before adding. (intent_drift)
- Cue: "One focus."
- Equipment: heavy bag, heart-rate monitor
- Bases: name: the step's block (Specific/physical block — 20 min) and its plan items (5 × 3 min, themes, KPIs) and its round-focus rule (D-OQ58); discipline: boxing, bagwork: the step's block (bagwork) and its plan items; category: bagwork: the step's block; execution: the step's plan items and its round-focus rule (D-PK63-8; D-OQ58), word for word in substance; what_good_looks_like: the round-focus rule (D-OQ58) and the DOC-027 owner passage beside this block ('One cue.'; 'One correction per round or live block.'); equipment_needed: the plan items' bag work and 'Heart rate monitored'; stop_rules: the DOC-027 (Punxsy Master Source Manual v1), owner passage beside the template's Specific/physical block, word for word; cues: the DOC-027 (Punxsy Master Source Manual v1), owner passage beside the template's Specific/physical block, word for word

### Phase 1 skill session, step 5. Burst Finisher: 20/10 on Bike or Treadmill, or Maximal Shadow Rounds (`drl_02c1253c606e21`)

- Typed line: "Conditioning finisher — 8 min"
- Purpose: The Phase 1 skill session's conditioning finisher (8 min, non-strength days only): burst conditioning (Category 3). The plan item's efforts and recoveries, either option, take about 4 of the block's 8 minutes. Target: A burst finisher as the plan item gives it: hard short efforts with organized recovery, about 4 of the block's 8 minutes.
- Setup: A bike or curved treadmill for the first option; floor space in stance for the shadow option; no partner and no contact.
- Execution: Non-strength days only. Either 8 × 20 s hard / 10 s easy on a bike or curved treadmill, or 4 × 30 s maximal shadow with 30 s rest.
- Good: Every effort hard and high quality; the shadow option stays in form at maximal speed; recovery is used, not skipped.
- Scale: A: Fewer efforts of either option (the coach cuts the count), each still hard. [Fewer efforts.] | B (start): Either option as written. | C: Both options in one finisher, the bike or treadmill set then the shadow set; the coach trims either set to fit the 8 minutes. [Both options.]
- Stop: Stop the finisher when the efforts stop being high quality (shadow form breaks, or the hard intervals turn into paced ones); do not add more. (fatigue)
- Cue: none (conditioning)
- Equipment: bike or curved treadmill (first option only)
- Bases: name: the step's plan item's two options; equipment_needed: the step's plan item ('on bike or curved treadmill'); what_good_looks_like: AI draft from the step's plan items and DOC-027's Category 3 ('Short high-quality efforts are followed by organized recovery windows.'); purpose: the template's conditioning category for this item: 'Category 3 is burst conditioning.' (DOC-027, on the template); the plan item's '(non-strength days only)'; 'about 4 of the block's 8 minutes' is arithmetic on the plan item's numbers (8 × (20 s + 10 s), or 4 × (30 s + 30 s)), App Overwatch on #2201; target_behavior: AI draft from the typed line and the step's own details; the minutes are arithmetic on the plan item's numbers, App Overwatch on #2201; execution: the step's plan items, word for word in substance; stop_rules: AI draft from DOC-027's Category 3 standard ('Short high-quality efforts are followed by organized recovery windows.'); cues: none: a conditioning drill needs no cue (OD-2026-10-06-026 ruling 2), and the step gives none

### Phase 1 skill session, step 6. Phase 1 Cool-Down: Easy Movement, Static Stretching, 4-2-6 Breathing, Log (`drl_a5f52ff0aa9d2e`)

- Typed line: "Cool-down — 10 min"
- Purpose: The Phase 1 skill session's cool-down (10 min). Target: Bring heart rate under 120, stretch, breathe 4-2-6 for 2 minutes, and log the session.
- Setup: Floor space for each athlete; a way to read heart rate; a log sheet; no contact.
- Execution: 5 min easy movement, heart rate under 120. Static stretching: hip flexors, adductors, thoracic, calves, shoulders. 2 min diaphragmatic breathing (4-2-6 pattern), treated as mental-skills training, not filler. Log: RPE, rounds, one technical note.
- Good: Heart rate under 120 before stretching; slow, held stretches; calm 4-2-6 breathing; the log written before leaving.
- Scale: A: Easy movement, the breathing and the log; a shorter stretch set. [Shorter stretch.] | B (start): The cool-down as written. | C: As written, the athlete writing their own log line before the coach reads it. [Athlete-logged.]
- Stop: Dizziness or light-headedness: stop and breathe normally; the coach checks before the athlete goes on. (safety)
- Cue: none (conditioning)
- Equipment: a heart-rate monitor, or a pulse count; a log sheet
- Bases: name: the step's plan items; execution: the step's plan items, word for word in substance; equipment_needed: the plan items' 'HR under 120' and 'Log'; 'or a pulse count' is this lane's; stop_rules: the lane's Breathing Reset stop (drl_0967cc300cfc5e, 'Dizziness or light-headedness: stop the count and breathe normally.'); 'the coach checks before the athlete goes on' is this lane's; cues: none: a conditioning drill needs no cue (OD-2026-10-06-026 ruling 2), and the step gives none

### Phase 1 skill session, step 7. Evaluate → Reset: Close the Session on Its One Focus (`drl_4845ed05215e9b`)

- Typed line: "Evaluate → Reset"
- Purpose: The last step of the Phase 1 skill session, inside the cool-down's 10 minutes beside its log line (D-OQ57): the session template's closing Evaluate → Reset (DOC-027). Target: Close the session by evaluating its one focus and setting what resets for next time.
- Setup: Athletes together with the coach after the cool-down's log line; no equipment beyond the log; no contact.
- Execution: The coach and athlete look back at the session's one focus: did it hold, and where did it break? Then they set what resets for the next session, written beside the log line.
- Good: One clear evaluation of the session's focus and one reset written down, inside the cool-down's minutes.
- Scale: A: The coach gives the evaluation and the reset. [Coach-led.] | B (start): Evaluate → Reset, as written. | C: The athlete gives the evaluation and the reset first; the coach adds or corrects. [Athlete-led.]
- Stop: The talk drifts away from the session's one focus or runs past the cool-down's minutes: close it on one reset. (intent_drift)
- Cue: "Evaluate → Reset"
- Bases: name: the typed line, and the session's one focus (D-OQ58); discipline: boxing, technical, as TL-1a's character drills (a coach-led session close); category: technical, as TL-1a's character drills; purpose: D-OQ57 (the last step, inside the cool-down's 10 minutes, beside its log line) and DOC-027's session template block order; execution: AI draft: DOC-027's block order gives the step's name only; what is evaluated (the one focus) is the round-focus rule's (D-OQ58); what_good_looks_like: AI draft; the time is D-OQ57's (inside the cool-down's 10 minutes, beside its log line); stop_rules: AI draft; cues: the DOC-027 (Punxsy Master Source Manual v1, Boxing Workflow v4 Core, 10. Session template) block name, word for word

## Durations (the rule App Overwatch set on #2177; its `details.time` form, App Overwatch on #2162)

- Issuing, timers and presets read `duration_minutes`, never `details`. A linked step whose details state a time of its own (its `block_time` range, the minutes its own `block_title` states, or its `details.time` in whole minutes, "N min"), held by no other step of its template, carries it as its duration, at contact none or light_technical.
- Carried (the template's own `items` label gains a lane `duration_minutes` part naming each step, its stated time and `details.time`; `TIMED_STEPS` and `LANE_W48_DURATIONS` pin them):
  - Conditioning session A, step 1 (Warm-up): "15 min" → 15;
  - Conditioning session A, step 3 (Cool-down): "8 min" → 8.
- Stated but not carried, so blank or unchanged (only a step's own whole minutes fill the column; App Overwatch on #2162):
  - Conditioning session A, step 1's typed line gives its parts ("5 min easy", "5 × 20 s", "60 s easy", "2 × 5 s"), inside its own 15 minutes;
  - Conditioning session A, step 4 (Record): `details.time` is "—"; "7 s, 17 s, 27 s" are reading points in each rep, not a duration;
  - Conditioning session A, steps 5 and 6 (the owner's checks, D-PK73-3): their timing places them ("at the end of the warm-up, before the main set"; "straight after the main set, before the cool-down") and states no minutes; their `within_item_id` places step 5 inside step 1 (so inside its 15 minutes) and step 6 inside step 2 (the main set), so neither adds time;
  - Conditioning session A, step 2 (Main set; linked before this lane, an owner item): "20–24 min" is a range;
  - Phase 1, steps 1, 4, 5 and 6 already carry the template's own durations (12, 20, 8, 10), unchanged; their plan items' inner times (for example "General (3 min)", "5 × 3 min with 1 min rest", "8 × 20 s hard / 10 s easy", "2 min diaphragmatic breathing") are parts of those;
  - Phase 1, step 7 (Evaluate → Reset): no time of its own; it sits inside the cool-down's 10 minutes (D-OQ57).
