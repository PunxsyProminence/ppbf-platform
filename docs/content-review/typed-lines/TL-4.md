# Lane W4-8, TL-4: drills for the typed steps of the Iso + Plyo 60-Minute Boxing Session (review sheet)

Rulings: OD-2026-11-19-030 (OW26-05, Jason: "B: Turn typed lines into library drills"); OD-2026-11-20-001 OW27-09 (Q8.1: "B: A new drill for every line"); Q8.2 (Overwatch on #2050: a heading is a typed line); OD-2026-11-15-011 (AI drafts load once the lane's two adversarial reviewers pass this sheet; fixes by new drill version only). Plan and GO: #2162.

Source: the 13 typed steps of `wtp_456e418b1741b8` (Iso + Plyo 60-Minute Boxing Session – FULL Coach Execution Manual, DOC-089 as committed): each step's typed line (quoted word for word in its drill's `source_ref`), its block title, the template's Session Overview (goal, structure, "Position → Speed → Power"), the coach notes of its linked steps, the template's own DOC-089 library drills, and DOC-089's progression ladder and boxing-specific footwork plyos (held word for word on track `trk_f383dfe66c396d`).

## What this PR changes

- 13 new library drills, one per typed step, labelled as the earlier steps' (lane W4-8 draft marker on all 14 drafted fields, COACHING-CRAFT DRAFT provenance, evidence UNTIERED/unchecked, blank stage keys); scale levels A, B (start), C; at least one own stop rule each; a cue on every technique drill.
- The 13 steps link their drills (`drill_id` set, `free_text_drill` cleared); `details` unchanged. The template's own `items` label gains the lane's `drill_id` part. It leaves `TYPED_IN_MIXED`.
- Frozen Backbone: a youth-recreational export (its stage keys include RC1); its steps join `LANE_W48_STEPS`. UNVERIFIED where written; App Overwatch runs the frozen case before merging (#2162).
- Default field bases (every drill, unless its section lists another): name: the step's typed line (its heading words); discipline: the step's block (the library holds only boxing and conditioning); category: the step's block; target_behavior: AI draft from the typed line and the step's block title; purpose: AI draft from the step's block title and the template's Session Overview ('Goal: Build tension (iso), convert to explosive power (plyo), transfer to boxing'); standard_setup: AI draft; contact none, as the step's own contact level; execution: AI draft from the typed line, word for word in substance; adds coaching detail it does not give (shown in full on the review sheet); what_good_looks_like: AI draft from the typed line and the template's Coaching Rule ('Position → Speed → Power'); contact_level: the step's own contact level (none); equipment_needed: none: the typed line names none; difficulty: the template's difficulty (beginner), itself a lane YR AI draft (OD-2026-11-17-001); scale_levels: AI draft: A simpler, B the step as written (starting point), C harder, same lesson and no contact; stop_rules: AI draft from the typed line, adapted from the stop rules of the template's own DOC-089 library drills; cues: the typed line's own words, or the template's Coaching Rule or a step's coach note, word for word.

## Flags for the reviewers and for a coach edit

- Every step is contact none, and every drill and scale level is contact none. No new warning, gate or disclaimer.
- Audience: stage keys T1, T2, AM1-AM3, PR1-PR5, RC1 and FT1 ("adult stages and FT1 (any age on FT1)"). Difficulty `beginner` on all 13 (the template's, a lane YR AI draft).
- Steps 7-11 also draw on DOC-089's own footwork plyos (`iso_plyo_warmup_system.docx`, '2. Boxing-Specific Footwork Plyos', held word for word on track `trk_f383dfe66c396d`): "Split stance pogo → reset stance", "Lateral shuffle → stick → explode", "Forward/backward reactive step hops", "Pivot hop (rear foot pivot + quick return)", "Slip + hop (defensive movement into reactive step)", and its coaching focus lines (three used as cues). Those drills' labels cite it.
- Step 7: neither the typed line nor DOC-089 says which split stance is meant (a boxing stance, or the long split stance of the template's iso drills); the drill says "split stance" and does not choose.
- Step 6: the typed line puts "(3–5)" after the jump lunges; the burst's "3–5 fast punches" is DOC-089's Punch Burst. DOC-089's progression ladder gives contrast reps by rung (Beginner "Contrast: 2–3 reps after iso"; Intermediate "Contrast: 3–5 reps"); the drill quotes the line as written and sets no rung.
- Step 15 is an instruction line ("Run 3 rounds, rest 45–60 sec"); per Q8.2 it gets its own drill, a circuit format that names the block's three linked exercises. "3 rounds in all" is this lane's reading.
- Steps 16-20 name no target: the drills say shadow or a bag, as the coach sets. Step 11 is shadow (this lane's reading).
- Steps 19 and 20 are alternatives (Option A, Option B); the lines give no repeat count, so the repeats are the coach's.
- Steps 20 and 21 carry no cue: both are conditioning (OD-2026-10-06-026 ruling 2) and their lines give none.
- Step 21's stop rule is the lane's Breathing Reset stop (TL-1a), with "the bounce" for "the count".
- Validator repeated-text warnings: step 6 repeats the DOC-089 iso drills' warm-up stop word for word, on purpose.
- AI-drafted beyond the steps: every drill's levels A and C (sourced where the basis says); every stop rule (adapted from the template's own DOC-089 drills where the basis says so).

## The 13 drills

| step | drill_id | name | discipline / category |
|---|---|---|---|
| 6 | `drl_e42cab40dfabdd` | Contrast Work: Hold Then Explode | conditioning / warmup |
| 7 | `drl_a7f630616234a0` | Split Stance Pogo | boxing / footwork |
| 8 | `drl_a62e2a39fb784b` | Shuffle Then Stop Hard | boxing / footwork |
| 9 | `drl_7aa21f53d3f8dd` | Forward and Back Step: Quick Feet, No Crossing | boxing / footwork |
| 10 | `drl_3b4912298fcc7d` | Pivot Hop: Turn on the Ball of the Foot | boxing / footwork |
| 11 | `drl_c4f3dd04a9b692` | Slip Then Step: Head Then Feet | boxing / footwork |
| 15 | `drl_d549ae9b6275f1` | Power Circuit Format: 3 Rounds, 45–60 Seconds Rest | conditioning / power |
| 16 | `drl_7a54d70d866802` | Power Transfer Round: Pause Then Explode Punches | boxing / power |
| 17 | `drl_f320ba29ee851f` | Reactive Round: Slip, Step, Fire on the Call | boxing / technical |
| 18 | `drl_4f2ac372a75483` | Controlled Round: 70% Power, Clean Technique | boxing / technical |
| 19 | `drl_5ab30784188e04` | Conditioning Option A: Pogos, Fast Punches, Rest | conditioning / conditioning |
| 20 | `drl_3891ec6a6a49f6` | Conditioning Option B: Punch Out, Bounce, Rest | conditioning / conditioning |
| 21 | `drl_15ebfe7736b8eb` | Reset: Light Bounce, Deep Breathing, Relax Arms and Legs | conditioning / cooldown |

### Step 6. Contrast Work: Hold Then Explode (`drl_e42cab40dfabdd`)

- Typed line: "Contrast Work: / - Split squat hold → jump lunges (3–5) / - Push-up hold → explosive push-ups / - Punch hold → fast burst"
- Purpose: The last part of the warm-up (0:00–8:00): pair each iso hold with its plyo, building tension then converting it to speed. Target: Turn each iso hold straight into its explosive move: hold, then explode from the same position.
- Setup: Open floor with room for each athlete to lunge, push up and punch in their own space; no partner and no contact.
- Execution: Three contrast pairs, each explosive move straight after its hold: split squat hold, then jump lunges (3–5); push-up hold, then explosive push-ups; punch hold, then a fast burst (3–5 fast punches, as DOC-089's Punch Burst directs). Hold times and the push-up count are what the coach sets.
- Good: Each explosive move starts from the position its hold built: soft, controlled landings and punches that snap back to the guard.
- Scale: A: Each pair at its own drill's level A: low-amplitude jump lunges with a stick on each landing; push-ups with the hands staying on or only just off the floor; a burst of 3 punches. [Low amplitude.] | B (start): The three pairs as written. | C: Each explosive move at high intent and reactive, from the position its hold built. [High intent, reactive.]
- Stop: Stop the pair when the explosive move loses the position its hold built (knee caves, hips sag, punches turn into pushes), and one cue does not fix it. (technique_degradation) | Stop the set when the work stops sharpening position and only makes the athlete hotter and more tired before the work that follows. (warmup_decay)
- Cue: "Position → Speed → Power"
- Bases: name: the typed line's heading ('Contrast Work'); 'Hold Then Explode' names its pairs (hold → explosive move); discipline: conditioning, as the template's own iso and plyo drills in the same warm-up (steps 1-5); category: warmup: the step's block; standard_setup: AI draft from the three exercises the line names; contact none, as the step's own contact level; execution: the typed line word for word in substance; the line puts '(3–5)' after the jump lunges; '3–5 fast punches' is DOC-089's Punch Burst (drl_85a93f6757497a; step 14's coach note); hold times and the push-up count are not given; what_good_looks_like: AI draft from the cues of the template's own plyo drills, 'Land where you started' (Jump Lunge (after iso)) and 'Snap and back' (Punch Burst); scale_levels: A: each pair at the level A of its own DOC-089 drill (Jump Lunge (after iso), Explosive Push-Ups, Punch Burst); C: DOC-089's ladder words 'Plyo: High intent/reactive' (DOC-089 (iso_plyo_full_directions.docx, Library Intake/R03 - Strength Conditioning Nutrition and Recovery), '1. Progression Ladder (Beginner → Advanced)', on track trk_f383dfe66c396d); stop_rules: the first adapted from the technique stops of the template's own DOC-089 drills; the second the warm-up stop rule of the template's own DOC-089 iso drills (e.g. Split Squat Iso Hold, drl_d75b4c493c3c82), word for word

### Step 7. Split Stance Pogo (`drl_a7f630616234a0`)

- Typed line: "Split stance pogo: / - Stay in stance, small bounce"
- Purpose: Open the movement and footwork block (8:00–18:00): carry the warm-up's springy ankles into the footwork block. Target: Bounce small and quick off the ankles while staying in split stance, then reset stance.
- Setup: Each athlete in their own space with room to bounce, in split stance; no partner and no contact.
- Execution: In split stance, small quick bounces off the balls of the feet, staying in stance throughout; then reset stance.
- Good: Small, springy bounces, not heavy; the stance held throughout, then reset.
- Scale: A: Fewer, lower bounces, checking the stance after each. [Low amplitude, stance checked.] | B (start): Small bounces in stance, then reset stance, as written. | C: Bounces at high intent and reactive, the bounce still small. [High intent, still small.]
- Stop: Stop the set when the athlete comes out of stance or the bounce gets big or heavy, and one cue does not fix it. (technique_degradation)
- Cue: "Stay in stance, small bounce" | "Stay springy, not heavy"
- Bases: discipline: boxing, footwork: the step's block (8:00–18:00 Movement + Footwork); target_behavior: AI draft from the typed line and DOC-089's 'Split stance pogo → reset stance' (DOC-089 (iso_plyo_warmup_system.docx, Library Intake/R03 - Strength Conditioning Nutrition and Recovery), '2. Boxing-Specific Footwork Plyos', on track trk_f383dfe66c396d); execution: the typed line, with DOC-089's matching footwork plyo line ('Split stance pogo → reset stance'), word for word in substance; neither line says which split stance is meant, so the drill does not choose; what_good_looks_like: DOC-089's coaching focus 'Stay springy, not heavy' and 'Maintain stance integrity' (DOC-089 (iso_plyo_warmup_system.docx, Library Intake/R03 - Strength Conditioning Nutrition and Recovery), '2. Boxing-Specific Footwork Plyos', on track trk_f383dfe66c396d); scale_levels: AI draft: A simpler, B the step as written (starting point), C harder, same lesson and no contact; A and C use DOC-089's progression ladder words ('Plyo: Low amplitude'; 'Plyo: High intent/reactive'), iso_plyo_full_directions.docx, '1. Progression Ladder (Beginner → Advanced)', on track trk_f383dfe66c396d; stop_rules: AI draft from the typed line, adapted from the template's Pogo Jumps stop ('the landings get heavy'); cues: the typed line's own words, and DOC-089's coaching focus (DOC-089 (iso_plyo_warmup_system.docx, Library Intake/R03 - Strength Conditioning Nutrition and Recovery), '2. Boxing-Specific Footwork Plyos', on track trk_f383dfe66c396d), word for word

### Step 8. Shuffle Then Stop Hard (`drl_a62e2a39fb784b`)

- Typed line: "Shuffle → Stick: / - Shuffle then stop hard / - No wobble"
- Purpose: Movement and footwork block (8:00–18:00): move, then stop in a balanced stance ready to punch. Target: Shuffle sideways in stance, then stop hard and hold still: no wobble.
- Setup: Each athlete in their own space with room to shuffle sideways, in stance; no partner and no contact.
- Execution: Shuffle laterally in stance, then stop hard and hold the stance still, with no wobble.
- Good: The stop is sudden and the stance is still on landing: no wobble, no extra step.
- Scale: A: Short, slower lateral shuffles, stopping and holding still before the next. [Slower.] | B (start): Shuffle, then stop hard, as written. | C: Lateral shuffle, stick, then explode out of the stick. [Stick, then explode.]
- Stop: Stop the set when the stop turns into a wobble or an extra step, and one cue does not fix it. (technique_degradation)
- Cue: "No wobble" | "Maintain stance integrity"
- Bases: name: the typed line's 'Shuffle then stop hard' ('Shuffle → Stick'); discipline: boxing, footwork: the step's block (8:00–18:00 Movement + Footwork); execution: the typed line, with DOC-089's matching footwork plyo line ('Lateral shuffle → stick → explode'), word for word in substance; 'lateral' is that line's; scale_levels: AI draft: A simpler, B the step as written (starting point), C harder, no contact; C is DOC-089's 'Lateral shuffle → stick → explode' (DOC-089 (iso_plyo_warmup_system.docx, Library Intake/R03 - Strength Conditioning Nutrition and Recovery), '2. Boxing-Specific Footwork Plyos', on track trk_f383dfe66c396d); cues: the typed line's own words, and DOC-089's coaching focus (DOC-089 (iso_plyo_warmup_system.docx, Library Intake/R03 - Strength Conditioning Nutrition and Recovery), '2. Boxing-Specific Footwork Plyos', on track trk_f383dfe66c396d), word for word

### Step 9. Forward and Back Step: Quick Feet, No Crossing (`drl_7aa21f53d3f8dd`)

- Typed line: "Forward/back step: / - Quick feet, no crossing"
- Purpose: Movement and footwork block (8:00–18:00): quick, clean steps in and out. Target: Step forward and back in stance with quick feet that never cross.
- Setup: Each athlete in their own space with room to step forward and back, in stance; no partner and no contact.
- Execution: Step forward and back in stance, quick feet, the feet never crossing.
- Good: Quick, small steps with a controlled upper body; the stance width holds and the feet never cross or come together.
- Scale: A: Slower steps, checking the stance after each. [Slower.] | B (start): Quick forward and back steps, as written. | C: Forward and backward reactive step hops, the feet still never crossing. [Reactive step hops.]
- Stop: Stop the set when the feet cross or come together, and one cue does not fix it. (technique_degradation)
- Cue: "Quick feet, no crossing" | "Quick feet, controlled upper body"
- Bases: discipline: boxing, footwork: the step's block (8:00–18:00 Movement + Footwork); what_good_looks_like: AI draft from the typed line and DOC-089's coaching focus 'Quick feet, controlled upper body' (DOC-089 (iso_plyo_warmup_system.docx, Library Intake/R03 - Strength Conditioning Nutrition and Recovery), '2. Boxing-Specific Footwork Plyos', on track trk_f383dfe66c396d); scale_levels: AI draft: A simpler, B the step as written (starting point), C harder, no contact; C is DOC-089's 'Forward/backward reactive step hops' (DOC-089 (iso_plyo_warmup_system.docx, Library Intake/R03 - Strength Conditioning Nutrition and Recovery), '2. Boxing-Specific Footwork Plyos', on track trk_f383dfe66c396d); cues: the typed line's own words, and DOC-089's coaching focus (DOC-089 (iso_plyo_warmup_system.docx, Library Intake/R03 - Strength Conditioning Nutrition and Recovery), '2. Boxing-Specific Footwork Plyos', on track trk_f383dfe66c396d), word for word

### Step 10. Pivot Hop: Turn on the Ball of the Foot (`drl_3b4912298fcc7d`)

- Typed line: "Pivot hop: / - Turn on ball of foot"
- Purpose: Movement and footwork block (8:00–18:00): a quick pivot on the rear foot and a quick return to stance. Target: Pivot on the rear foot with a small hop, turning on the ball of the foot, and return quickly to stance.
- Setup: Each athlete in their own space with room to pivot, in stance; no partner and no contact.
- Execution: In stance, a small hop that pivots on the rear foot, turning on the ball of the foot, then a quick return to stance.
- Good: A small, quick pivot on the ball of the rear foot and a quick return to a balanced stance, hands where they started.
- Scale: A: A slow rear-foot pivot, checking the stance on the return before the next. [Slower.] | B (start): The pivot hop as written: rear-foot pivot, quick return. | C: Pivot hops on the coach's call, the return still quick. [On the call.]
- Stop: Stop the set when the athlete turns on the heel, does not return to stance or lands off balance, and one cue does not fix it. (technique_degradation)
- Cue: "Turn on ball of foot"
- Bases: discipline: boxing, footwork: the step's block (8:00–18:00 Movement + Footwork); target_behavior: AI draft from the typed line and DOC-089's 'Pivot hop (rear foot pivot + quick return)' (DOC-089 (iso_plyo_warmup_system.docx, Library Intake/R03 - Strength Conditioning Nutrition and Recovery), '2. Boxing-Specific Footwork Plyos', on track trk_f383dfe66c396d); purpose: AI draft from the step's block title and DOC-089's 'Pivot hop (rear foot pivot + quick return)' (DOC-089 (iso_plyo_warmup_system.docx, Library Intake/R03 - Strength Conditioning Nutrition and Recovery), '2. Boxing-Specific Footwork Plyos', on track trk_f383dfe66c396d); execution: the typed line, with DOC-089's matching footwork plyo line ('Pivot hop (rear foot pivot + quick return)'), word for word in substance; what_good_looks_like: AI draft from the typed line and DOC-089's 'Pivot hop (rear foot pivot + quick return)' (DOC-089 (iso_plyo_warmup_system.docx, Library Intake/R03 - Strength Conditioning Nutrition and Recovery), '2. Boxing-Specific Footwork Plyos', on track trk_f383dfe66c396d)

### Step 11. Slip Then Step: Head Then Feet (`drl_c4f3dd04a9b692`)

- Typed line: "Slip → step: / - Head then feet"
- Purpose: Movement and footwork block (8:00–18:00): join head movement to footwork, head first. Target: Slip, then step: the head moves first, then the feet.
- Setup: Each athlete in their own space, in stance, in shadow; no partner and no contact.
- Execution: Slip (the head moves off the line), then step (the feet move), in that order: head then feet.
- Good: The head moves first and the feet follow; the athlete finishes in stance, balanced, hands up.
- Scale: A: Slip, pause, then step, checking the order. [Paused.] | B (start): Slip then step, as written. | C: Slip + hop: the slip goes straight into a reactive step hop. [Slip into a hop.]
- Stop: Stop the set when the feet move before the head or the athlete finishes off balance, and one cue does not fix it. (technique_degradation)
- Cue: "Head then feet"
- Bases: discipline: boxing, footwork: the step's block (8:00–18:00 Movement + Footwork); standard_setup: AI draft; 'shadow' is this lane's reading: the typed line names no bag, pads or other equipment; contact none, as the step's own contact level; scale_levels: AI draft: A simpler, B the step as written (starting point), C harder, no contact; C is DOC-089's 'Slip + hop (defensive movement into reactive step)' (DOC-089 (iso_plyo_warmup_system.docx, Library Intake/R03 - Strength Conditioning Nutrition and Recovery), '2. Boxing-Specific Footwork Plyos', on track trk_f383dfe66c396d)

### Step 15. Power Circuit Format: 3 Rounds, 45–60 Seconds Rest (`drl_d549ae9b6275f1`)

- Typed line: "Run 3 rounds, rest 45–60 sec"
- Purpose: The power block (18:00–35:00): the format for the iso → plyo circuit. Target: Run the power circuit for 3 rounds in all, with 45–60 seconds' rest between rounds.
- Setup: Open floor with room for each athlete to lunge, push up and punch in their own space, the circuit's three stations in order; no partner and no contact.
- Execution: The power block's circuit (in DOC-089: split squat iso → jump lunges, push-up iso → explosive push-ups, punch iso → punch burst), run 3 rounds in all, resting 45–60 seconds between rounds.
- Good: Every round as sharp as the first: holds in position and explosive moves with the same height and snap.
- Scale: A: Three rounds in all with the longer rest (60 seconds), the plyos at low amplitude; the coach may cut a round. [Longer rest, low amplitude.] | B (start): Three rounds, 45–60 seconds rest, as written. | C: Three rounds in all with the shorter rest (45 seconds), the plyos at high intent and reactive. [Shorter rest, high intent.]
- Stop: Stop the circuit when jump height, push-up speed or punch snap drops across the rounds and the rest does not bring it back. (fatigue)
- Cue: "Position → Speed → Power"
- Bases: name: the typed line, and its block title ('Power Block (Iso → Plyo Circuit)'); discipline: conditioning: the circuit's exercises are the template's own DOC-089 conditioning drills; category: power: the step's block; execution: the typed line word for word in substance; the circuit is the block's three linked steps (steps 12-14 of this template); 'in all' is this lane's (the line does not say whether the first pass through steps 12-14 is round 1); scale_levels: AI draft: A simpler, B the step as written (starting point), C harder, same lesson and no contact; A and C use DOC-089's progression ladder words ('Plyo: Low amplitude'; 'Plyo: High intent/reactive'), iso_plyo_full_directions.docx, '1. Progression Ladder (Beginner → Advanced)', on track trk_f383dfe66c396d; the rests are the ends of the line's own 45–60 seconds; stop_rules: adapted from the fatigue stops of the template's own DOC-089 drills ('the moment jump height drops across the reps')

### Step 16. Power Transfer Round: Pause Then Explode Punches (`drl_7a54d70d866802`)

- Typed line: "Round 1: Power transfer / - Pause then explode punches"
- Purpose: Boxing integration round 1 (35:00–50:00): transfer the power work into punches. Target: Pause in stance, then explode the punches, and return to the guard.
- Setup: Each athlete in their own space, in stance, punching in shadow or on a bag, as the coach sets; no partner and no contact.
- Execution: A round of punching from a pause: settle in stance, pause, then explode the punches, returning to the guard.
- Good: A still pause, then fast, sharp punches that snap back to the guard, the stance held.
- Scale: A: Fewer punches after each pause, checking that each snaps back to the guard. [Fewer punches.] | B (start): Pause, then explode punches, as written. | C: Shorter pauses, each burst explosive. [Shorter pauses.]
- Stop: Stop the round when the punches turn into pushes, form goes or the hands drop, and one cue does not fix it. (technique_degradation)
- Cue: "Pause then explode punches"
- Bases: discipline: boxing: the step's block (35:00–50:00 Boxing Integration); category: power: the round's title ('Power transfer'); standard_setup: AI draft: the typed line names no target, so shadow or a bag, as the coach sets; contact none, as the step's own contact level; equipment_needed: blank: the typed line names no equipment; a bag only if the coach uses one; stop_rules: adapted from the template's own Punch Burst stop rule (drl_85a93f6757497a), word for word in part

### Step 17. Reactive Round: Slip, Step, Fire on the Call (`drl_f320ba29ee851f`)

- Typed line: "Round 2: Reactive / - Coach calls: slip, step, fire"
- Purpose: Boxing integration round 2 (35:00–50:00): react to a call with the movement and punches the session built. Target: React at once to the coach's call: slip, step or fire.
- Setup: Each athlete in their own space, in stance, in shadow or at a bag, as the coach sets, the coach calling; no partner and no contact.
- Execution: The coach calls slip, step or fire; the athlete reacts at once: slips, steps, or fires punches, then resets in stance.
- Good: Each reaction starts on the call, not before; the athlete resets in stance after each one.
- Scale: A: One call at a time, slowly, with a reset between. [Slower calls.] | B (start): Coach calls slip, step, fire, as written. | C: Faster calls, the order mixed. [Faster, mixed.]
- Stop: Stop the round when the athlete moves before the call or loses stance on the reaction, and one cue does not fix it. (technique_degradation)
- Cue: "slip, step, fire"
- Bases: discipline: boxing: the step's block (35:00–50:00 Boxing Integration); category: technical: a reaction round, technique only; standard_setup: AI draft: the typed line names no target, so shadow or a bag, as the coach sets; contact none, as the step's own contact level; equipment_needed: blank: the typed line names no equipment; a bag only if the coach uses one; cues: the typed line's own coach call, word for word; execution: the typed line; 'then resets in stance' is this lane's

### Step 18. Controlled Round: 70% Power, Clean Technique (`drl_4f2ac372a75483`)

- Typed line: "Round 3: Controlled / - 70% power, clean technique"
- Purpose: Boxing integration round 3 (35:00–50:00): keep the technique clean with the power held back. Target: Punch at 70% power with clean technique for the round.
- Setup: Each athlete in their own space, in stance, punching in shadow or on a bag, as the coach sets; no partner and no contact.
- Execution: A round of punching at 70% power, every punch clean.
- Good: Clean punches at a steady, held-back 70%: balanced, hands back to the guard.
- Scale: A: Single punches at 70%, checking each. [Single punches.] | B (start): 70% power, clean technique, as written. | C: Combinations at 70%, every punch clean. [Combinations.]
- Stop: Stop the round when technique gets ragged or the punches turn into full-power shots, and one cue does not fix it. (technique_degradation)
- Cue: "70% power, clean technique"
- Bases: discipline: boxing: the step's block (35:00–50:00 Boxing Integration); category: technical: the round is about clean technique; standard_setup: AI draft: the typed line names no target, so shadow or a bag, as the coach sets; contact none, as the step's own contact level; equipment_needed: blank: the typed line names no equipment; a bag only if the coach uses one

### Step 19. Conditioning Option A: Pogos, Fast Punches, Rest (`drl_5ab30784188e04`)

- Typed line: "Option A: / - Pogos x20 / - Fast punches 20 sec / - Rest 20 sec"
- Purpose: Conditioning block (50:00–58:00), option A: pogos and a fast punch burst, then 20 seconds' rest. Target: 20 pogos, 20 seconds of fast punches, 20 seconds of rest.
- Setup: Each athlete in their own space with room to bounce, punching in shadow or on a bag, as the coach sets; no partner and no contact.
- Execution: 20 pogos, then 20 seconds of fast punches, then 20 seconds' rest; the coach sets how many times it repeats in the block.
- Good: Pogos stay quick and low; punches stay fast and snap back; the athlete is ready again after each rest.
- Scale: A: Pogos at low amplitude and punches at a controlled pace. [Low amplitude, controlled pace.] | B (start): Option A as written. | C: Fast reactive pogos and full-speed punches. [High intent, reactive.]
- Stop: Stop the set when the pogos get heavy or slow or the punches lose their snap, and the rest does not bring them back. (fatigue)
- Cue: "Bounce, don’t squat"
- Bases: name: the typed line's 'Option A' and its three parts, in the step's block (Conditioning); discipline: conditioning: the step's block (50:00–58:00 Conditioning); conditioning-block punching is filed under conditioning in the library (as Punch Burst), though 13 boxing drills also carry the category conditioning; standard_setup: AI draft: the typed line names no target, so shadow or a bag, as the coach sets; contact none, as the step's own contact level; equipment_needed: blank: the typed line names no equipment; a bag only if the coach uses one; execution: the typed line; the repeats are the coach's (the block is 50:00–58:00 and the line gives none); scale_levels: AI draft: A simpler, B the step as written (starting point), C harder, same lesson and no contact; A and C use DOC-089's progression ladder words ('Plyo: Low amplitude'; 'Plyo: High intent/reactive'), iso_plyo_full_directions.docx, '1. Progression Ladder (Beginner → Advanced)', on track trk_f383dfe66c396d; cues: the template's step 4 coach note (Pogo Jumps), word for word; stop_rules: adapted from the fatigue stops of the template's own Pogo Jumps and Punch Burst drills

### Step 20. Conditioning Option B: Punch Out, Bounce, Rest (`drl_3891ec6a6a49f6`)

- Typed line: "Option B: / - 30 sec punch out / - 30 sec bounce / - 30 sec rest"
- Purpose: Conditioning block (50:00–58:00), option B: 30-second intervals of punch out, bounce and rest. Target: 30 seconds of punch out, 30 seconds of bounce, 30 seconds of rest.
- Setup: Each athlete in their own space with room to bounce, punching out in shadow or on a bag, as the coach sets; no partner and no contact.
- Execution: 30 seconds of punch out, then 30 seconds of bounce, then 30 seconds' rest; the coach sets how many times it repeats in the block.
- Good: Punches keep their form through the 30 seconds; the bounce stays light; the athlete is ready again after each rest.
- Scale: A: Punch out at a controlled pace, a light bounce. [Controlled pace.] | B (start): Option B as written. | C: The bounce at high intent and reactive, the punches still snapping back. [Reactive bounce.]
- Stop: Stop the set when the punches turn into pushes or the hands drop, and the rest does not bring them back. (fatigue)
- Cue: none (conditioning)
- Bases: name: the typed line's 'Option B' and its three parts, in the step's block (Conditioning); discipline: conditioning: the step's block (50:00–58:00 Conditioning); conditioning-block punching is filed under conditioning in the library (as Punch Burst), though 13 boxing drills also carry the category conditioning; standard_setup: AI draft: the typed line names no target, so shadow or a bag, as the coach sets; contact none, as the step's own contact level; equipment_needed: blank: the typed line names no equipment; a bag only if the coach uses one; execution: the typed line; the repeats are the coach's (the block is 50:00–58:00 and the line gives none); scale_levels: AI draft: A simpler, B the step as written (starting point), C harder, same lesson and no contact; A and C use DOC-089's progression ladder words ('Plyo: Low amplitude'; 'Plyo: High intent/reactive'), iso_plyo_full_directions.docx, '1. Progression Ladder (Beginner → Advanced)', on track trk_f383dfe66c396d; stop_rules: adapted from the template's own Punch Burst stop rule; cues: none: a conditioning drill needs no cue (OD-2026-10-06-026 ruling 2), and the line gives none

### Step 21. Reset: Light Bounce, Deep Breathing, Relax Arms and Legs (`drl_15ebfe7736b8eb`)

- Typed line: "Light bounce / Deep breathing / Relax arms/legs"
- Purpose: The session's last two minutes (58:00–60:00): reset after the conditioning block. Target: Bring the body down: light bounce, deep breathing, relaxed arms and legs.
- Setup: Each athlete standing in their own space, with room for a light bounce; no partner and no contact.
- Execution: A light bounce, deep breathing, and relaxing the arms and legs, for the last two minutes of the session.
- Good: The bounce is light and easy, the breathing slows and deepens, the arms and legs loosen.
- Scale: A: Standing still, deep breathing and relaxing the arms and legs. [No bounce.] | B (start): Light bounce, deep breathing, relax arms and legs, as written. | C: The athlete leads their own reset, breathing slowing throughout. [Self-led.]
- Stop: Dizziness or light-headedness: stop the bounce and breathe normally. (safety)
- Cue: none (conditioning)
- Bases: name: the step's block title ('Reset') and its typed line; discipline: a cool-down is filed under conditioning in the library (as Post-Session Mobility); category: cooldown: the step's block; standard_setup: AI draft; 'standing' is this lane's reading; contact none, as the step's own contact level; stop_rules: the lane's Breathing Reset stop (drl_0967cc300cfc5e, 'Dizziness or light-headedness: stop the count and breathe normally.'), with 'the bounce' for 'the count'; cues: none: a conditioning drill needs no cue (OD-2026-10-06-026 ruling 2)
