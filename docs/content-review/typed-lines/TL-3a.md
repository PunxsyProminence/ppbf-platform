# Lane W4-8, TL-3a: drills for the typed steps of the Friday Sparring Coach Sheet and the Wednesday Coach Sheet Defense Day (review sheet)

Rulings: OD-2026-11-19-030 (OW26-05, Jason: "B: Turn typed lines into library drills"); OD-2026-11-20-001 OW27-09 (Q8.1: "B: A new drill for every line"); Q8.2 (Overwatch on #2050: a heading is a typed line); OD-2026-11-15-011 (AI drafts load once the lane's two adversarial reviewers pass this sheet; fixes by new drill version only); PK-90 A (the Friday sheet's "unsupervised" line stands as written, as information). Plan and GO: #2162 (condition 5: sparring steps keep their contact limits; new sparring drills follow the library's authorization setting).

Source: the typed steps of `wtp_1ad3c846b03ecc` (Friday Sparring Coach Sheet; steps 1, 2, 9, 10, 11) and `wtp_3557c34e022c31` (Wednesday Coach Sheet Defense Day; steps 1, 6, 7, 8, 9, 10), DOC-091 as committed: each step's typed line (quoted word for word in its drill's `source_ref`) and its `details` (block title, block time, parts). Audience: stage keys Y3, Y4 and Y5 (ages 12-14, 14-16 and 16-18). Difficulty `intermediate` on all 11 (the templates', a lane YR AI draft).

## What this PR changes

- 11 new library drills, one per typed step, labelled as TL-1a's (lane W4-8 draft marker on all 14 drafted fields, COACHING-CRAFT DRAFT provenance, evidence UNTIERED/unchecked, blank stage keys); scale levels A, B (start), C; at least one own stop rule each; a cue on each.
- The 11 steps link their drills (`drill_id` set, `free_text_drill` cleared); `details` unchanged. Each template's own `items` label gains the lane's `drill_id` part. Both leave `TYPED_IN_MIXED`.
- Frozen Backbone: both are youth-recreational exports; their steps join `LANE_W48_STEPS`. UNVERIFIED where written; App Overwatch runs the frozen case before merging (#2162).
- Default field bases (every drill, unless its section lists another): name: the typed line and the step's block title; discipline: the step's block (the library holds only boxing and conditioning); category: the step's block; target_behavior: AI draft from the typed line and the step's own parts; purpose: AI draft from the step's block title, phase and own parts; standard_setup: AI draft; contact as the step's own contact level; execution: AI draft from the typed line and the step's own parts; adds coaching detail they do not give (shown in full on the review sheet); what_good_looks_like: AI draft from the step's own parts; contact_level: the step's own contact level; equipment_needed: the step's own words, or none; difficulty: the template's difficulty (intermediate), itself a lane YR AI draft (OD-2026-11-17-001); scale_levels: AI draft: A simpler, B the step as written (starting point), C harder, same lesson and no more contact; stop_rules: AI draft; the sheet gives no stop rule for this step; cues: the step's own words, word for word.

## Flags for the reviewers and for a coach edit

- Friday step 9 is open sparring for Y3-Y5 (ages 12-18). Its drill sits at `open_sparring`, the step's own level; level A drops to `controlled_sparring` (weekday technical intensity, which the step's Intensity line names); no level is above the step. `requires_coach_authorization` false, as the Friday sheet's six sparring drills. Its stop rules carry those drills' two safety rules word for word, the sheet's 'follow coach commands immediately' and the key habit. No new warning, gate or disclaimer. Both reviewers: please check the contact limits.
- Friday step 2's line says non-contact athletes are "unsupervised during the sparring block"; the drill carries it as written, as information, and adds no supervision rule, note or block (PK-90 A).
- The source's "Neuro development" lines are not carried into any drill; they stay in the steps' `details`.
- AI-drafted beyond the steps: the arrival drill's level C; the self-guided drill's levels A and C; the open sparring drill's level C (a named focus); the observation drill's level C; the gym service levels A and C; the defense rounds' levels A and C and "nothing is thrown"; "feet as well as head" for round 2's full movement; "shadow jabs" in round 3; the circuit's levels; the reflection circle's levels.
- The Wednesday sheet is `non_contact`: every Wednesday drill and level is contact `none`.

## The 11 drills

| template | step | drill_id | name | discipline / category | contact |
|---|---|---|---|---|---|
| Friday Sparring Coach Sheet | 1 | `drl_00fb56aab4ee4a` | Arrival and Preparation: Wraps, Headgear, Gloves, Light Movement | conditioning / warmup | none |
| Friday Sparring Coach Sheet | 2 | `drl_005bea3042938a` | Self-Guided Work for Non-Contact Athletes | boxing / technical | none |
| Friday Sparring Coach Sheet | 9 | `drl_7654a30ec2e74c` | Friday Live Rounds, Rotating Partners | boxing / sparring | open_sparring |
| Friday Sparring Coach Sheet | 10 | `drl_c846f6c648b34e` | Observation Training: Track the Sparring | boxing / tactical | none |
| Friday Sparring Coach Sheet | 11 | `drl_83eee740e9f95d` | Gym Service Rotation | boxing / technical | none |
| Wednesday Coach Sheet Defense Day | 1 | `drl_1d5d3c1176e56f` | Box Breathing 4-4-4-4 (Trauma-Informed Option) | boxing / technical | none |
| Wednesday Coach Sheet Defense Day | 6 | `drl_f2ac7bda9131cb` | Defense Round 1: Slip Only on the Coach's Cue | boxing / head_movement | none |
| Wednesday Coach Sheet Defense Day | 7 | `drl_d3ca8b49ec5e5e` | Defense Round 2: Slip and Roll With Full Movement | boxing / head_movement | none |
| Wednesday Coach Sheet Defense Day | 8 | `drl_a5d2a79b8224ab` | Defense Round 3: Slip, Roll, Jab at 50% Speed | boxing / defense | none |
| Wednesday Coach Sheet Defense Day | 9 | `drl_8b5cad86b115a9` | Stay Calm Circuit: Wall Sit, Plank, Jump Rope | conditioning / conditioning | none |
| Wednesday Coach Sheet Defense Day | 10 | `drl_5093325d1b6985` | Reflection Circle: Staying Calm Under Pressure | boxing / technical | none |

### Friday Sparring Coach Sheet, step 1. Arrival and Preparation: Wraps, Headgear, Gloves, Light Movement (`drl_00fb56aab4ee4a`)

- Typed line: "Athletes arrive and prepare for training."
- Purpose: The Friday block's first 10 minutes (3:30 to 3:40): get ready for sparring without being chased. Target: Arrive ready: hands wrapped, headgear on, gloves ready, body moving, before the drill rounds start.
- Setup: Athletes in the gym in their own space. The coach organises sparring partners and the non-contact athletes' tasks while they get ready. Equipment: hand wraps, headgear, gloves
- Execution: Athletes wrap their hands, put on headgear, get gloves ready and begin light movement or shadowboxing. The coach organises sparring partners, reviews sparring expectations, explains the drill rounds and assigns the non-contact athletes their expectations.
- Good: Every athlete wrapped, in headgear, gloves ready and moving lightly before the drill rounds, without being chased.
- Scale: A: Gear on, then light movement only. [Light movement.] | B (start): Gear on, then light movement or shadowboxing, as written. | C: Light shadowboxing rounds on the week's skills once the gear is on. [Shadowboxing on the week's skills.]
- Stop: An athlete's wraps, headgear or gloves are not ready when the drill rounds start: they get ready before joining. (safety)
- Cue: "Follow coach commands immediately."
- Bases: discipline: warm-up and preparation is filed under conditioning in the library (as General Movement Warm-Up); equipment_needed: the step's own Athletes list (wrap hands, put on headgear, gloves ready); execution: the step's own Athletes and Coach lists, in substance; stop_rules: AI draft from the step's Athletes list (the gear it names); cues: the step's Safety reminders, one line word for word

### Friday Sparring Coach Sheet, step 2. Self-Guided Work for Non-Contact Athletes (`drl_005bea3042938a`)

- Typed line: "Non contact athletes are unsupervised during the sparring block. / Athletes are expected to demonstrate: / discipline / integrity / responsibility / initiative / Athletes may choose: / individual workout / shadowboxing rounds / heavy bag rounds / observation training / gym service / Coaches check periodically, but athletes manage their own work."
- Purpose: Non-contact athletes during the Friday sparring block: a character test as much as a training period. Target: Work productively on a chosen task during the sparring block without being prompted.
- Setup: Non-contact athletes during the sparring block, in their own space with no partner and no contact. As the sheet says, they are unsupervised during the block; coaches check periodically, and athletes manage their own work. Equipment: heavy bag (for bag rounds)
- Execution: Athletes choose an individual workout, shadowboxing rounds, heavy bag rounds, observation training or gym service, and keep working until the block ends, showing discipline, integrity, responsibility and initiative.
- Good: A chosen task started and kept going without prompting, and no drifting.
- Scale: A: The coach assigns the task before the block. [Assigned task.] | B (start): Athletes choose from the list, as written. | C: Athletes plan their own block (tasks and order) before it starts and keep to it. [Own plan.]
- Stop: An athlete stops working or drifts: they choose a new task from the list. (intent_drift)
- Cue: "Athletes manage their own work."
- Bases: discipline: boxing, technical, as the Long Road mental-skill drills (a character block, as TL-1a); category: technical, as the Long Road mental-skill drills; standard_setup: the typed line: 'unsupervised during the sparring block' and 'Coaches check periodically', carried as written and as information (PK-90 A: it stands as written; no rule, note or block); purpose: the step's Coaching note ('a character test as much as a training period'); equipment_needed: the typed line's 'heavy bag rounds'; stop_rules: AI draft (intent drift); the sheet gives no stop rule, and no supervision rule is added (PK-90 A); cues: the typed line's last sentence, shortened ('Coaches check periodically, but athletes manage their own work.')

### Friday Sparring Coach Sheet, step 9. Friday Live Rounds, Rotating Partners (`drl_7654a30ec2e74c`)

- Typed line: "Athletes rotate partners."
- Purpose: The Friday open sparring block (4:10 to 5:20): live rounds that look like applied learning, not emotional brawling. Target: Apply the week's skills in live rounds with more freedom and realism, rotating partners, still controlled.
- Setup: Ring or open mat. Pairs the coach organised, in stance, in the gear the Friday sheet names (wraps, headgear, gloves). The coach watches every pair. Equipment: hand wraps, headgear, gloves
- Execution: Open sparring rounds of 2 to 3 minutes, at least 3 rounds per athlete, rotating partners. Intensity slightly higher than weekday technical sparring, but still controlled. Athletes keep soft knees, relaxed shoulders, controlled punching power, a balanced stance and breathing during exchanges; the key habit is punch, move, reset position. The coach watches defensive reactions, foot positioning, balance, clean punches, composure, angle exits and recovery after mistakes, and corrects between rounds.
- Good: Applied learning, not emotional brawling: controlled power, composure under pressure, and punch, move, reset every exchange.
- Scale: A: Rounds at weekday technical sparring intensity, the same rotation and round length. [Weekday technical intensity.] (contact controlled_sparring) | B (start): Open sparring as written: slightly higher than weekday technical sparring, still controlled. | C: 3-minute rounds, each with one of the week's skills named as its focus before the bell. [Named focus.]
- Stop: Stop the round when punches stop being controlled or emotion takes over the exchanges, and one cue does not bring it back. (safety) | Stop the round when contact rises above the level the coach set for this drill. (safety) | Stop the pair when an athlete does not follow the coach's command immediately. (coach_judgment) | Stop the round when the key habit is gone (punching and staying in front instead of punch, move, reset) and a correction between rounds does not bring it back. (technique_degradation)
- Cue: "Punch → move → reset position" | "stay composed when hit"
- Bases: name: the step's block title (Open Sparring) and typed line; named 'Live Rounds' because 'Open Sparring' is an existing library drill's name (the import's near-duplicate rule); discipline: boxing, sparring, as the Friday sheet's own sparring drills (e.g. Jab Only Sparring); category: sparring, as the Friday sheet's own sparring drills; contact_level: the step's own contact level (open_sparring); level A at controlled_sparring, below it; standard_setup: the setup of the Friday sheet's own sparring drills (gear as the sheet names it); 'the coach watches every pair' from the step's Coaching focus; execution: the step's own Round length, Typical format, Intensity, Athlete technical focus, Key habit and Coaching focus, in substance; what_good_looks_like: the step's Coaching note and Key habit; scale_levels: AI draft: A is weekday technical intensity, which the step's Intensity line names; C adds a named focus, no more contact; stop_rules: the Friday sheet's own sparring drills' two safety rules, word for word; the coach's command from the sheet's Safety reminders; the key habit from the step; requires_coach_authorization: false, as the Friday sheet's own sparring drills; cues: the step's Key habit, and one line of the sheet's Safety reminders, word for word

### Friday Sparring Coach Sheet, step 10. Observation Training: Track the Sparring (`drl_c846f6c648b34e`)

- Typed line: "Non contact athletes observing sparring should track: / clean punches landed / defensive reactions used / footwork positioning / control of distance / who exits exchanges well / who stays composed under pressure"
- Purpose: Develop tactical awareness and ring IQ while the non-contact athletes watch the sparring. Target: Watch the sparring actively and track specific things, to build tactical awareness and ring IQ.
- Setup: Non-contact athletes where they can see the sparring, outside the sparring area; no partner and no contact.
- Execution: While the sparring runs, observers track clean punches landed, defensive reactions used, footwork positioning, control of distance, who exits exchanges well and who stays composed under pressure.
- Good: Observers stay engaged and can name a specific example of what they tracked, not passive standing around.
- Scale: A: Track one of the six items for the whole block. [One item.] | B (start): Track the six items, as written. | C: Name one pattern that worked again and again, and tell the coach after the block. [Report a pattern.]
- Stop: Observation turns into passive standing around: the coach gives the athlete one specific thing to watch. (intent_drift)
- Cue: "Smart watching is also training."
- Bases: category: tactical: the step's Purpose ('tactical awareness and ring IQ'); purpose: the step's own Purpose, word for word in substance; stop_rules: the step's Coaching note ('Do not let observation become passive standing around'); cues: the step's Life skill development, its last sentence word for word

### Friday Sparring Coach Sheet, step 11. Gym Service Rotation (`drl_83eee740e9f95d`)

- Typed line: "Athletes rotate through gym service tasks."
- Purpose: Build ownership of the gym and respect for the training space. Target: Contribute to the gym by finishing useful service tasks in rotation.
- Setup: Athletes rotate through the tasks; no partner work and no contact.
- Execution: Athletes rotate through gym service tasks: sweep floors, clean mirrors, take trash out, organise gloves, wipe equipment, reset heavy bags.
- Good: Each task started and finished properly, without being chased; the gym left ready for the next session.
- Scale: A: One task, with the coach showing how. [One task.] | B (start): Rotate through the tasks, as written. | C: An athlete leads a small group through the tasks. [Athlete-led.]
- Stop: Service turns into punishment or horseplay: stop and restate its purpose, culture building. (intent_drift)
- Cue: "Service is not punishment. It is culture building."
- Bases: discipline: boxing, technical, as the Long Road mental-skill drills (a character block, as TL-1a); category: technical, as the Long Road mental-skill drills; purpose: the step's own Purpose, word for word; execution: the step's own Tasks include list, word for word; stop_rules: the step's Coaching note ('Service is not punishment. It is culture building.'); cues: the step's Coaching note, word for word

### Wednesday Coach Sheet Defense Day, step 1. Box Breathing 4-4-4-4 (Trauma-Informed Option) (`drl_1d5d3c1176e56f`)

- Typed line: "4-4-4-4 Box Breathing (Trauma-Informed Option) / Cue Script: / Feet flat / Inhale 4 / Hold 4 / Exhale 4 / Hold 4 / Repeat x4 cycles / Modifications: / Reduce hold to 2 seconds if needed / Eyes open allowed / Standing or seated position / Coaching Focus: Calm tone. No forced breathing."
- Purpose: Arrival and breathing reset (5 minutes) on the Defense Day, whose theme is emotional regulation. Target: A calm start: four slow cycles of inhale, hold, exhale, hold, each for 4.
- Setup: Athletes standing or seated in their own space; no partner and no contact. The coach leads the count in a calm tone.
- Execution: Feet flat. Inhale for 4, hold for 4, exhale for 4, hold for 4. Repeat for 4 cycles. Holds may be reduced to 2 seconds, eyes may stay open, and athletes may stand or sit. Calm tone; no forced breathing.
- Good: Slow, easy cycles at the coach's count; nobody forcing a breath.
- Scale: A: Holds reduced to 2 seconds; eyes open; seated. [Shorter holds.] | B (start): 4-4-4-4 for 4 cycles, as written. | C: Athletes keep the 4-4-4-4 count on their own for the 4 cycles. [Self-counted.]
- Stop: Breathing feels forced or uncomfortable: return to normal breathing (the sheet: no forced breathing). (safety)
- Cue: "Calm tone. No forced breathing."
- Bases: discipline: boxing, technical, as TL-1a's breathing reset and the manual's own breathing drill; category: technical, as TL-1a's breathing reset; execution: the typed line's Cue Script, Modifications and Coaching Focus, in substance; scale_levels: A from the typed line's own Modifications; C AI-drafted; stop_rules: the typed line's Coaching Focus ('No forced breathing'); cues: the typed line's Coaching Focus, word for word

### Wednesday Coach Sheet Defense Day, step 6. Defense Round 1: Slip Only on the Coach's Cue (`drl_f2ac7bda9131cb`)

- Typed line: "Coach cue every 5 seconds / Technical precision"
- Purpose: Structured round 1 of 3 (3 minutes) on the Defense Day: slips only. Target: Slip on the coach's cue every 5 seconds, with technical precision.
- Setup: Each athlete in their own space, in stance, with no partner and no contact. The coach stands where every athlete can see the cue.
- Execution: A 3-minute round: the coach gives a cue every 5 seconds and the athlete slips, with technical precision. Slips only; nothing is thrown at the athlete.
- Good: Small, precise slips right on the cue, returning to stance and guard each time.
- Scale: A: A cue every 10 seconds. [Slower cues.] | B (start): A cue every 5 seconds, as written. | C: The coach varies the side and the timing of the cue. [Varied cue.]
- Stop: Slips lose precision (head drops, stance breaks): stop and reset before the next cue. (technique_degradation)
- Cue: "Technical precision"
- Bases: name: the step's block title (Round 1, Slip Only) and the typed line (the coach's cue); category: head_movement: what the round trains; execution: the step's block title (3 minutes, slip only) and the typed line, in substance; 'nothing is thrown' is this lane's; cues: the typed line's second line, word for word

### Wednesday Coach Sheet Defense Day, step 7. Defense Round 2: Slip and Roll With Full Movement (`drl_d3ca8b49ec5e5e`)

- Typed line: "Add full movement / Moderate tempo"
- Purpose: Structured round 2 of 3 (3 minutes) on the Defense Day: slip and roll. Target: Slip and roll with full movement at a moderate tempo.
- Setup: Each athlete in their own space, in stance, with no partner and no contact. The coach stands where every athlete can be seen.
- Execution: A 3-minute round of slips and rolls, adding full movement (feet as well as head), at a moderate tempo.
- Good: Slips and rolls with the feet moving too, balanced, at an even moderate tempo.
- Scale: A: Slip and roll in place, then add movement for the last minute. [Movement late.] | B (start): Slip and roll with full movement, moderate tempo, as written. | C: Slip and roll to the coach's cues while moving. [Cued.]
- Stop: Balance or stance breaks when moving: slow to the tempo where it holds. (technique_degradation)
- Cue: "Moderate tempo"
- Bases: name: the step's block title (Round 2, Slip + Roll) and the typed line ('Add full movement'); category: head_movement: what the round trains; execution: the step's block title (3 minutes, slip and roll) and the typed line, in substance; 'feet as well as head' is this lane's reading of 'full movement'; cues: the typed line's second line, word for word

### Wednesday Coach Sheet Defense Day, step 8. Defense Round 3: Slip, Roll, Jab at 50% Speed (`drl_a5d2a79b8224ab`)

- Typed line: "50% speed / Controlled breathing"
- Purpose: Structured round 3 of 3 (3 minutes) on the Defense Day: defence into a counter. Target: Slip, roll, then jab at 50% speed with controlled breathing.
- Setup: Each athlete in their own space, in stance, with no partner and no contact. Shadow jabs that reach no one.
- Execution: A 3-minute round: slip, roll, then jab, at 50% speed, breathing under control throughout.
- Good: A clean slip, a clean roll and a jab from a balanced stance, at half speed, breathing steady.
- Scale: A: Slip then jab only, at 50% speed. [No roll.] | B (start): Slip, roll, jab at 50% speed, as written. | C: The coach calls the start of each sequence. [Called start.]
- Stop: Speed creeps above half or breathing is held: stop and reset to 50% speed and steady breathing. (technique_degradation)
- Cue: "Controlled breathing"
- Bases: name: the step's block title (Round 3, Slip, Roll, Jab) and the typed line (50% speed); category: defense: a defensive sequence into a counter; execution: the step's block title and the typed line; 'shadow jabs' is this lane's reading (the step is contact none); cues: the typed line's second line, word for word

### Wednesday Coach Sheet Defense Day, step 9. Stay Calm Circuit: Wall Sit, Plank, Jump Rope (`drl_8b5cad86b115a9`)

- Typed line: "20 sec Wall Sit / 20 sec Plank / 20 sec Jump Rope (or phantom rope) / 60 sec Rest / Repeat x2 rounds. / Coaching Emphasis: Steady breathing. Quality movement only."
- Purpose: The Defense Day's conditioning finisher (5 minutes): stay calm while working. Target: Two rounds of wall sit, plank and jump rope, breathing steadily, quality movement only.
- Setup: Each athlete with a wall nearby, floor space for a plank and room to skip; no partner and no contact. Equipment: jump rope (or none for phantom rope), a wall
- Execution: 20 seconds wall sit, 20 seconds plank, 20 seconds jump rope (or phantom rope), 60 seconds rest; repeat for 2 rounds.
- Good: Steady breathing and quality movement in every station: knees and back set on the wall, a straight plank, light skipping.
- Scale: A: Phantom rope; plank from the knees. [Easier stations.] | B (start): Two rounds as written. | C: A third round, the same stations and rest. [Third round.]
- Stop: Movement quality drops (plank sags, wall sit slips): stop the station and rest (the sheet: quality movement only). (technique_degradation)
- Cue: "Steady breathing. Quality movement only."
- Bases: discipline: conditioning: the sheet's conditioning finisher; execution: the typed line, word for word in substance; equipment_needed: the typed line's jump rope (or phantom rope) and wall sit; stop_rules: the typed line's Coaching Emphasis ('Quality movement only'); cues: the typed line's Coaching Emphasis, word for word

### Wednesday Coach Sheet Defense Day, step 10. Reflection Circle: Staying Calm Under Pressure (`drl_5093325d1b6985`)

- Typed line: "Ask: / What felt difficult today? / When did you feel pressure? / What helped you stay controlled? / Close with: “Defense is staying calm when things feel fast.”"
- Purpose: The Defense Day's reflection circle (5 minutes). Target: Reflect on pressure and control, closing on the day's line.
- Setup: Athletes in a circle with the coach; no equipment, no partner work and no contact.
- Execution: The coach asks: What felt difficult today? When did you feel pressure? What helped you stay controlled? Close with: "Defense is staying calm when things feel fast."
- Good: Athletes answer from today's session, and the circle closes on the line.
- Scale: A: The coach asks one of the three questions. [One question.] | B (start): The three questions and the closing line, as written. | C: An athlete asks the questions and the coach closes. [Athlete-led.]
- Stop: The circle drifts or runs past its 5 minutes: close it on the line. (intent_drift)
- Cue: "Defense is staying calm when things feel fast."
- Bases: discipline: boxing, technical, as TL-1a's character drills; category: technical, as TL-1a's character drills; execution: the typed line, word for word; stop_rules: AI draft (intent drift); the sheet gives no stop rule; cues: the typed line's closing line, word for word
