# Lane W4-8, TL-2: drills for the typed steps of the Scripted 60-Minute Class (review sheet)

Rulings: OD-2026-11-19-030 (OW26-05, Jason: "B: Turn typed lines into library drills"); OD-2026-11-20-001 OW27-09 (Q8.1: "B: A new drill for every line"); Q8.2 (Overwatch on #2050: a heading is a typed line); OD-2026-11-15-011 (AI drafts load once the lane's two adversarial reviewers pass this sheet; fixes by new drill version only). Plan and GO: #2162.

Source: the 10 typed steps of `wtp_900c0a3fd4422a` (Scripted 60-Minute Class (test run 4-5), DOC-091 as committed). Their `free_text_drill` is empty; each step's text is its `details`: the block title (the typed line, quoted word for word in the drill's `source_ref`) and its parts (drill, exercises, sequence, coach script, life-skill line). Audience: the template's stage keys Y3, Y4 and Y5 (ages 12-14, 14-16 and 16-18, its age band). Difficulty `intermediate` on all 10: the template's difficulty, itself a lane YR AI draft (OD-2026-11-17-001). On the coach page the step times (e.g. 4:00-4:05) stay in each step's "From the sheet" (reviewer B: a page matter, not changed here).

## What this PR changes

- 10 new library drills, one per typed step, labelled as TL-1a's (lane W4-8 draft marker on all 14 drafted fields, COACHING-CRAFT DRAFT provenance, evidence UNTIERED/unchecked, blank stage keys). Contact `none` on every drill and level; `requires_coach_authorization` false; scale levels A, B (start), C; at least one own stop rule each.
- The 10 steps link their drills (`drill_id` set). Their `free_text_drill` was already empty and stays so; `details` are unchanged, so the step keeps its script. The template's own `items` label gains a `drill_id` part (lane W4-8 draft marker), so the template screen marks the steps as AI draft, as TL-1b's templates. It leaves `TYPED_IN_MIXED`.
- Cues: every drill has one, from its own step: 9 are whole sentences or lines word for word (coach scripts, and the combo shuffle's Structure line, which has no script); step 15's is lifted from its closing script (it drops "Look around and").
- Default field bases (every drill, unless its section lists another): name: the step's block title, without its time; discipline: the step's block (the library holds only boxing and conditioning); category: the step's block; target_behavior: AI draft from the step's own parts (drill, exercises, sequence, coach script) and block time; purpose: AI draft from the step's block and block time; standard_setup: AI draft; contact none, as the step's own contact level; execution: AI draft from the step's own parts; adds coaching detail they do not give (shown in full on the review sheet); what_good_looks_like: AI draft from the step's own parts; contact_level: the step's own contact level (none); equipment_needed: the step's own words, or none; difficulty: the template's difficulty (intermediate), itself a lane YR AI draft (OD-2026-11-17-001); scale_levels: AI draft: A simpler, B the step as written (starting point), C harder, same lesson; stop_rules: AI draft; the class script gives no stop rule; cues: the step's coach script, word for word.
- Frozen Backbone: the template is a youth-recreational export; its frozen-folder case now expects these 10 steps too (`LANE_W48_STEPS`). UNVERIFIED where written; App Overwatch runs it before merging (#2162).

## Flags for the reviewers and for a coach edit

- The source's "Neurological Explanation" lines (e.g. that a drill "activates coordination between both hemispheres of the brain") are not carried into any drill: they stay in the steps' `details`, unchanged.
- "Shadow" for the combo shuffle and the punch burst is this lane's reading: the steps name no partner or target, and every step is contact none.
- Step 10's title "Punch Burst Drill" would be a near-duplicate of the library's "Punch Burst" (`drl_85a93f6757497a`) under the import's rule, so the drill is named from its own sequence: "Ten Fast Punches, Duck and Reset".
- Step 9's level C (one more squat each cycle as well) and the good-form line on the leg lifts ("lower back kept down") are AI-drafted.
- Also AI-drafted, beyond the steps' parts: step 2's level C (a longer shadowboxing finish); step 8's levels A (a move every 30 seconds) and C (a faster last minute); step 10's "bends the knees rather than the back" (its stop rule depends on it); step 15's circle and its athlete-led level C; "standing" in the stretches' setup (the hamstring script says only "Reach toward your toes").
- Step 8 (the combo shuffle) is filed under conditioning like the class's other conditioning-block work, which leaves it outside the cue rule; it carries a cue anyway, its own Structure line word for word.

## The 10 drills

| step | drill_id | name | discipline / category | typed line (block title) |
|---|---|---|---|---|
| 1 | `drl_6a9ba21ab70739` | Jump Rope or Boxer Bounce, Moving Around the Floor | conditioning / warmup | 4:00–4:05 Jump Rope / Boxer Bounce |
| 2 | `drl_03947956e0019b` | Dynamic Mobility With Light Shadowboxing | conditioning / mobility | 4:05–4:10 Dynamic Mobility |
| 8 | `drl_3bfff862173673` | Progressive Combo Shuffle | conditioning / conditioning | 4:35–4:40 Progressive Combo Shuffle |
| 9 | `drl_d8b4d7db05e1f7` | Strength Endurance Circuit: Push-Ups, Squats, Leg Lifts | conditioning / strength | 4:40–4:45 Strength Endurance Circuit |
| 10 | `drl_d7ee1ff332329d` | Ten Fast Punches, Duck and Reset | conditioning / conditioning | 4:45–4:50 Punch Burst Drill |
| 11 | `drl_513c67125a9e62` | Shadowboxing Integration Round | boxing / shadow | 4:50–4:52 Shadowboxing Integration Round |
| 12 | `drl_dfa6361ed26d2a` | Cross-Body Shoulder Stretch With Reflection | conditioning / cooldown | 4:52–4:54 Shoulder Stretch |
| 13 | `drl_2840b7b848ba9a` | Hip Flexor Stretch With Reflection | conditioning / cooldown | 4:54–4:56 Hip Flexor Stretch |
| 14 | `drl_035fbd809c8e13` | Hamstring Stretch With Reflection | conditioning / cooldown | 4:56–4:58 Hamstring Stretch |
| 15 | `drl_478db0c9f74694` | Closing Reflection: Thank Your Teammates | boxing / technical | 4:58–5:00 Closing Reflection |

### Step 1. Jump Rope or Boxer Bounce, Moving Around the Floor (`drl_6a9ba21ab70739`)

- Purpose: Open the class with 5 minutes of light rhythm work (4:00-4:05 warm-up). Target: Light, rhythmic feet with the hands up, moving around the floor.
- Setup: Athletes spread around the floor with clear space all round, those with ropes spaced so no rope can reach another athlete. The coach stands where everyone's feet can be seen. Equipment: jump rope (none for the boxer bounce).
- Execution: Jump rope, or boxer bounce without a rope, while moving around the floor for the 5 minutes: light on the toes, hands up, shoulders relaxed, finding a steady rhythm.
- Good: Light on the toes, hands up, shoulders relaxed, a steady rhythm while moving.
- Scale: A: Boxer bounce on the spot, no rope. [On the spot.] | B (start): Jump rope or boxer bounce around the floor, as written. | C: Change direction or pace on the coach's call, keeping the rhythm. [Called changes.]
- Stop: An athlete trips on the rope or a rope comes near another athlete: stop, re-space, then restart. (safety)
- Cue: "Light on your toes. Hands up."
- Bases: discipline: warm-up skipping is filed under conditioning in the library (as Skipping — Continuous); equipment_needed: the step's own words: jump rope or boxer bounce; name: the step's block title and its Drill part ('while moving around the floor'); purpose: the step's block and block time, and its Coach Instruction Script; cues: the step's Coach Instruction Script, its first two sentences word for word

### Step 2. Dynamic Mobility With Light Shadowboxing (`drl_03947956e0019b`)

- Purpose: Prepare the body to punch safely (4:05-4:10 warm-up). Target: Open the shoulders, hips and torso, then move into light shadowboxing.
- Setup: Athletes in open space with clear space all round, so arm circles and shadow punches reach no one. The coach stands in front and shows each movement.
- Execution: Arm circles, hip rotations and slow torso twists, then light shadowboxing, for the 5 minutes.
- Good: Slow, controlled circles and twists through a comfortable range; light, loose shadowboxing.
- Scale: A: Arm circles, hip rotations and torso twists only, in a smaller range. [No shadowboxing.] | B (start): The four exercises as written. | C: A longer light shadowboxing finish, on the spot. [Longer shadowboxing.]
- Stop: Pain in a joint (more than a stretch): stop that movement and tell the coach. (safety)
- Cue: "Prepare your body to punch safely."
- Bases: discipline: warm-up mobility is filed under conditioning in the library (as Thoracic spine mobility); execution: the step's own Exercises list, in its order; name: the step's block title and its Exercises list ('Light shadowboxing'); category: mobility: what the step's exercises are (the step's block is the warm-up); purpose: the step's Coach Instruction Script ('Prepare your body to punch safely') and block time; cues: the step's Coach Instruction Script, its last sentence word for word

### Step 8. Progressive Combo Shuffle (`drl_3bfff862173673`)

- Purpose: Conditioning block (4:35-4:40): a combination built up step by step while the work continues. Target: Build a seven-move combination one move at a time, restarting from the shuffle each time.
- Setup: Each athlete in their own space, in stance, with no partner and no contact. Shadow work: the sequence names no partner or target. The coach keeps time and calls each new move.
- Execution: Shuffle only for the first 30 seconds, then add one move every 15 seconds, restarting the combination from the beginning each time a move is added: shuffle, jab, cross, slip, jab, pivot, cross. Keep repeating the full combination until time ends.
- Good: Each added move is clean before the next one comes, and the combination restarts from the shuffle every time.
- Scale: A: Add a move every 30 seconds instead of every 15. [Slower build.] | B (start): As written: a new move every 15 seconds. | C: Hold the full seven-move combination at a faster pace for the last minute. [Faster finish.]
- Stop: The combination breaks down (feet cross, the guard stays down): go back to the last clean step of the sequence. (technique_degradation)
- Cue: "Restart combo from the beginning when new move is added"
- Bases: discipline: the step's block is the class's conditioning block (4:35-4:50), as the library's Punch Burst; execution: the step's own Structure and Sequence, in substance; 'shadow' is this lane's reading; what_good_looks_like: AI draft from the step's own Structure (a new move every 15 seconds, restart each time); cues: the step's Structure part, its third line word for word (the step has no coach script)

### Step 9. Strength Endurance Circuit: Push-Ups, Squats, Leg Lifts (`drl_d8b4d7db05e1f7`)

- Purpose: Conditioning block (4:40-4:45): strength endurance with a small increase every cycle. Target: Repeat push-ups, squats and leg lifts, adding one leg lift each cycle, with the form held.
- Setup: Each athlete with floor space to lie down; no equipment and no partner. The coach counts the cycles.
- Execution: Cycles of 5 push-ups, 10 squats and leg lifts, starting at 5 leg lifts and adding one each cycle (5, 6, 7 and on) until time ends.
- Good: A straight body line on the push-ups, full controlled squats, and slow leg lifts with the lower back kept down.
- Scale: A: Push-ups from the knees or against a wall, and the leg lifts held at 5 each cycle. [Easier push-up; no added leg lift.] | B (start): 5 push-ups, 10 squats, leg lifts from 5 adding one per cycle. | C: Add one squat as well as one leg lift each cycle. [Two increases.]
- Stop: Form breaks down (hips sag on the push-ups, the lower back lifts on the leg lifts): stop the cycle and reset, or move to level A (leg lifts held at 5). (technique_degradation)
- Cue: "Each cycle we add one more leg lift."
- Bases: discipline: bodyweight strength is filed under conditioning in the library (as Bodyweight Lower Push); execution: the step's own Exercises, Example progression and Progression, in substance; name: the step's block title and its Exercises list; category: strength: what the step's exercises are (the step's block is the conditioning block); cues: the step's Coach Instruction Script, its second sentence word for word

### Step 10. Ten Fast Punches, Duck and Reset (`drl_d7ee1ff332329d`)

- Purpose: Conditioning block (4:45-4:50): fast punching, then a duck and a clean reset. Target: Ten fast straight punches, a duck, and a clean reset of the stance.
- Setup: Each athlete in their own space, in stance, with no partner and no contact. Shadow punches that reach no one; the duck is under an imaginary punch.
- Execution: Throw 10 fast straight punches, duck under an imaginary punch, then reset the stance; repeat until the block ends.
- Good: Fast straight punches, a duck that bends the knees rather than the back, and the stance and guard reset before the next burst.
- Scale: A: Five punches, then duck and reset, at a steady pace. [Five punches.] | B (start): 10 fast straight punches, duck, reset. | C: The coach calls the duck at a random moment in the burst. [Called duck.]
- Stop: The stance is not reset after the duck, or the duck bends the back instead of the knees: stop and reset before the next burst. (technique_degradation)
- Cue: "Throw ten fast punches, duck under an imaginary punch, then reset your stance."
- Bases: name: the step's own Sequence (10 punches, duck, reset); its title 'Punch Burst Drill' would be a near-duplicate of the library's Punch Burst; discipline: conditioning-block punching is filed under conditioning in the library (as Punch Burst); execution: the step's own Coach Script and Sequence, in substance

### Step 11. Shadowboxing Integration Round (`drl_513c67125a9e62`)

- Purpose: Integration block (4:50-4:52): combine everything practised in the class into complete shadowboxing. Target: Put the class's moves together in one shadowboxing round.
- Setup: Each athlete in their own space, in stance, with no partner and no contact. A shadowboxing round.
- Execution: One 2-minute shadowboxing round combining the class's work: move, jab, slip, pivot and use combinations.
- Good: Every part of the class shows in the round (movement, jab, slip, pivot, combinations) with the guard home.
- Scale: A: The coach calls each move. [Coach-called.] | B (start): A free shadowboxing round, as written. | C: At least three of the class's moves linked in every combination. [Linked moves.]
- Stop: Technique breaks down (the guard drops, the feet cross): stop, reset the stance, then carry on. (technique_degradation)
- Cue: "Move, jab, slip, pivot, and use combinations."
- Bases: discipline: boxing: a shadowboxing round; category: shadow, as the library's shadow drills; execution: the step's own Coach Script; 2 minutes from its block time

### Step 12. Cross-Body Shoulder Stretch With Reflection (`drl_dfa6361ed26d2a`)

- Purpose: Reflection and exit stretching (4:52-5:00): a cool-down stretch with a reflection prompt. Target: Stretch the shoulders, while thinking over the reflection prompt.
- Setup: Athletes standing in their own space; no partner. The coach leads the stretch and reads the prompt.
- Execution: Pull one arm across the chest and hold, shoulders relaxed, then switch arms. While stretching, think about the prompt: "Think about one habit that helps you improve every day."
- Good: A gentle stretch, shoulders relaxed, slow breathing, no bouncing.
- Scale: A: A gentler stretch and a shorter hold. [Gentler.] | B (start): The stretch and prompt as written. | C: A longer, slower hold, breathing slowly throughout. [Longer hold.]
- Stop: Pain in the shoulder (more than a stretch): ease off and tell the coach. (safety)
- Cue: "Pull one arm across your chest. Keep your shoulders relaxed."
- Bases: name: the step's block title and its Coach Script ('Pull one arm across your chest'); 'With Reflection' for its Reflection Prompt; discipline: a cool-down stretch is filed under conditioning in the library (as Post-Session Mobility); purpose: AI draft from the step's phase, 4:52-5:00 Reflection + Exit Stretching, and its Reflection Prompt; standard_setup: AI draft; 'standing' is this lane's reading; contact none, as the step's own contact level; what_good_looks_like: AI draft: 'shoulders relaxed' and 'breathe slowly' come from the class's stretch scripts (steps 12 and 14); 'no bouncing' is this lane's; equipment_needed: none: the step's own words name none

### Step 13. Hip Flexor Stretch With Reflection (`drl_2840b7b848ba9a`)

- Purpose: Reflection and exit stretching (4:52-5:00): a cool-down stretch with a reflection prompt. Target: Stretch the front of the hips, while thinking over the reflection prompt.
- Setup: Athletes standing in their own space, a wall within reach for balance; no partner. The coach leads the stretch and reads the prompt. Equipment: a wall (for balance).
- Execution: Step one foot forward and lower the hips slightly, hold, then switch legs. While stretching, think about the prompt: "What is one disciplined habit you can practice this week?"
- Good: A gentle stretch, shoulders relaxed, slow breathing, no bouncing.
- Scale: A: A gentler stretch and a shorter hold, a hand on the wall for balance. [Gentler.] | B (start): The stretch and prompt as written. | C: A longer, slower hold, breathing slowly throughout. [Longer hold.]
- Stop: Pain in the hip or knee (more than a stretch): ease off and tell the coach. (safety)
- Cue: "Step one foot forward and lower your hips slightly."
- Bases: name: the step's block title; 'With Reflection' for its Reflection Prompt; discipline: a cool-down stretch is filed under conditioning in the library (as Post-Session Mobility); purpose: AI draft from the step's phase, 4:52-5:00 Reflection + Exit Stretching, and its Reflection Prompt; standard_setup: AI draft; 'standing' is this lane's reading; contact none, as the step's own contact level; what_good_looks_like: AI draft: 'shoulders relaxed' and 'breathe slowly' come from the class's stretch scripts (steps 12 and 14); 'no bouncing' is this lane's; equipment_needed: a wall for balance, as the home week names it

### Step 14. Hamstring Stretch With Reflection (`drl_035fbd809c8e13`)

- Purpose: Reflection and exit stretching (4:52-5:00): a cool-down stretch with a reflection prompt. Target: Stretch the back of the legs, while thinking over the reflection prompt.
- Setup: Athletes standing in their own space, a wall within reach for balance; no partner. The coach leads the stretch and reads the prompt. Equipment: a wall (for balance).
- Execution: Reach toward the toes and breathe slowly, hold, then release. While stretching, think about the prompt: "How does discipline help you improve in school, sports, or at home?"
- Good: A gentle stretch, shoulders relaxed, slow breathing, no bouncing.
- Scale: A: A gentler stretch and a shorter hold, a hand on the wall for balance. [Gentler.] | B (start): The stretch and prompt as written. | C: A longer, slower hold, breathing slowly throughout. [Longer hold.]
- Stop: Pain behind the knee or in the lower back (more than a stretch): ease off and tell the coach. (safety)
- Cue: "Reach toward your toes and breathe slowly."
- Bases: name: the step's block title; 'With Reflection' for its Reflection Prompt; discipline: a cool-down stretch is filed under conditioning in the library (as Post-Session Mobility); purpose: AI draft from the step's phase, 4:52-5:00 Reflection + Exit Stretching, and its Reflection Prompt; standard_setup: AI draft; 'standing' is this lane's reading; contact none, as the step's own contact level; what_good_looks_like: AI draft: 'shoulders relaxed' and 'breathe slowly' come from the class's stretch scripts (steps 12 and 14); 'no bouncing' is this lane's; equipment_needed: a wall for balance, as the home week names it

### Step 15. Closing Reflection: Thank Your Teammates (`drl_478db0c9f74694`)

- Purpose: Reflection and exit (4:58-5:00): a structured close that reinforces the class's life skills. Target: Close the class by thanking teammates for helping each other improve.
- Setup: Athletes standing in a circle with the coach; no equipment, no partner work and no contact.
- Execution: The coach says training is complete. Athletes look around and thank their teammates for helping them improve today.
- Good: Every athlete thanks at least one teammate, and the class ends calm and together.
- Scale: A: The coach models the thank-you first. [Coach first.] | B (start): The close as written. | C: One athlete leads the close. [Athlete-led.]
- Stop: The close runs long or drifts: end it on the coach's closing line. (intent_drift)
- Cue: "Thank your teammates for helping you improve today."
- Bases: discipline: boxing, technical, as the Long Road mental-skill drills (e.g. Mindfulness practice); category: technical, as the Long Road mental-skill drills; execution: the step's own Coach Closing Script, in substance; the circle is this lane's; name: the step's block title and its Coach Closing Script ('thank your teammates'); purpose: the step's own Purpose part, in substance; scale_levels: AI draft: A simpler, B as written (starting point), C harder; C's athlete-led close is this lane's; stop_rules: AI draft (intent drift); the class script gives no stop rule; cues: the step's Coach Closing Script, lifted from its second sentence
