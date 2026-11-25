# Lane W4-8, TL-3b: drills for the typed steps of the Wednesday Gold Standard Coach Script (review sheet)

Rulings: OD-2026-11-19-030 (OW26-05, Jason: "B: Turn typed lines into library drills"); OD-2026-11-20-001 OW27-09 (Q8.1: "B: A new drill for every line"); Q8.2 (Overwatch on #2050: a heading is a typed line); OD-2026-11-15-011 (AI drafts load once the lane's two adversarial reviewers pass this sheet; fixes by new drill version only). Plan and GO: #2162 (condition 5: sparring steps keep their contact limits; new sparring drills follow the library's authorization setting, as the plan says).

Source: the 7 typed steps of `wtp_9fbf7f8edf5016` (Wednesday – Gold Standard Coach Script, DOC-091 `Wednesday_Gold_Standard_Coach_Script.docx` as committed): each step's typed line (Say, Watch, Fix; quoted word for word in its drill's `source_ref`), its block title and phase, and the template's own opening lines, Core Rules, Global Fix Language, contact intensity line and DOC-027 owner passages (the print-ready layout, DOC-091 `Wednesday_Gold_Standard_Coach_Script_PRINT_READY.docx`, holds the Global Fix Language, step 1's COACH INTENT and WATCH FOR, and the GLOBAL CHAOS RESET). Audience: stage keys Y3, Y4 and Y5 (ages 12-18). Difficulty `intermediate` on all 7 (the template's, a lane YR AI draft).

## What this PR changes

- 7 new library drills, one per typed step, labelled as the earlier steps' (lane W4-8 draft marker on all 14 drafted fields, COACHING-CRAFT DRAFT provenance, evidence UNTIERED/unchecked, blank stage keys); scale levels A, B (start), C; at least one own stop rule each; a cue on each, every one word for word from the sheet.
- The 7 steps link their drills (`drill_id` set, `free_text_drill` cleared); `details` unchanged. The template's own `items` label gains the lane's `drill_id` part. It leaves `TYPED_IN_MIXED`.
- Frozen Backbone: a youth-recreational export; its steps join `LANE_W48_STEPS`. UNVERIFIED where written; App Overwatch runs the frozen case before merging (#2162).
- Default field bases (every drill, unless its section lists another): name: the step's block title and its typed line; discipline: the step's block (the library holds only boxing and conditioning); category: the step's block; target_behavior: AI draft from the typed line (its Say and Fix lines) and the step's block title; purpose: AI draft from the step's block title, phase and the sheet's own opening lines; standard_setup: AI draft; contact as the step's own contact level; execution: AI draft from the typed line, word for word where it gives Say and Fix lines; adds coaching detail it does not give (shown in full on the review sheet); what_good_looks_like: AI draft from the typed line and the sheet's Core Rules; contact_level: the step's own contact level; equipment_needed: none: the sheet names none; difficulty: the template's difficulty (intermediate), itself a lane YR AI draft (OD-2026-11-17-001); scale_levels: AI draft: A simpler, B the step as written (starting point), C harder, same lesson and no more contact; stop_rules: AI draft from the typed line's own Fix lines; cues: the typed line's own Say or Fix words, word for word.

## Flags for the reviewers and for a coach edit

- Steps 6 and 7 are controlled sparring for Y3-Y5 (ages 12-18). Their drills sit at `controlled_sparring`, the steps' own level, at every scale level; nothing is above the step (GO condition 5). `requires_coach_authorization` false, as the Friday sheet's sparring drills and the plan the GO approved. Stop rules: the Friday sheet's sparring drills' two safety rules, the library's 'cannot protect themselves structurally', and the DOC-027 Sparring Standard owner passage on this template ('If chaos rises above the educational value of the round, intensity is reduced or the round is stopped.'), all word for word; step 7 also carries the library's Rope Escape Situation safety stop (word for word) and a pace stop from the print-ready layout's GLOBAL CHAOS RESET. No new warning, gate or disclaimer. Both reviewers: please check the contact limits.
- Step 6's round 3 reads "Open but controlled". The drill states no intensity figure: the template's own contact intensity line ("Technical 30–40% | Controlled 50–60% | Open max 70%") stays on the template for the coach, and the drill keeps round 3 within controlled sparring, the step's level.
- The sheet names no sparring gear; the sparring drills say "in sparring gear" and name none.
- Step 7's "Ropes escape first" is read as an escape from the ropes: one athlete begins near the ropes and athletes switch roles each round, as the library's Rope Escape Situation (`drl_51897d282e13dd`); "Higher pace finish" raises the pace, not the contact.
- The Global Fix Language cues (steps 6 and 7), step 1's COACH INTENT and WATCH FOR, and step 7's pace stop come from the template's print-ready layout (DOC-091 `Wednesday_Gold_Standard_Coach_Script_PRINT_READY.docx`); those drills' labels cite it.
- Step 8 ("Conditioning Finish") names no exercises: the drill leaves the work to the coach (shadow, no contact).
- AI-drafted beyond the steps: every drill's levels A and C; step 1's stop rule ("restart the two minutes"); "shadow" in steps 3 and 8; "nothing is thrown" in step 4; step 6's tools stop rule; the wording of step 7's pace stop.

## The 7 drills

| step | drill_id | name | discipline / category | contact |
|---|---|---|---|---|
| 1 | `drl_26a97e355c0e0a` | Set Tone: Seeing Before Moving | boxing / technical | none |
| 2 | `drl_c7e4c5ae475b65` | Movement in Stance: Small Steps Four Ways | boxing / footwork | none |
| 3 | `drl_1d6dcdeb8b8013` | Jab and Keep Moving | boxing / technical | none |
| 4 | `drl_bae413a2338d17` | Slip on a Visual Cue | boxing / head_movement | none |
| 6 | `drl_13242d8acf3944` | Technical Spar: Jab Only, Jab and Cross, Then Open but Controlled | boxing / sparring | controlled_sparring |
| 7 | `drl_0126497cf4649f` | Situational Spar: Defense Before Score, Ropes Escape, Higher-Pace Finish | boxing / sparring | controlled_sparring |
| 8 | `drl_558fc9e8f7ddc3` | Conditioning Finish: Technique While Tired | conditioning / conditioning | none |

### Step 1. Set Tone: Seeing Before Moving (`drl_26a97e355c0e0a`)

- Typed line: "Say: / "Today is about seeing before moving. No guessing. Stay calm and balanced." / Watch: attention, spacing / Fix: "Eyes here." / "Two steps back.""
- Purpose: The first two minutes of the non-contact hour (4:00-4:02): establish calm, spacing and attention. Target: Start the session calm, spaced and paying attention: seeing before moving.
- Setup: Athletes spread out in their own space, facing the coach; no partner and no contact.
- Execution: The coach says: "Today is about seeing before moving. No guessing. Stay calm and balanced." The coach watches attention and spacing, and fixes with "Eyes here." or "Two steps back."
- Good: Athletes spaced apart, eyes on the coach, calm and still.
- Scale: A: The coach places athletes in their spots before speaking. [Coach-placed.] | B (start): The Say line, then watch and fix, as written. | C: Athletes space themselves and settle with no fix needed. [No fix.]
- Stop: Talking or crowding continues after a fix: stop and restart the two minutes. (intent_drift)
- Cue: "Eyes here."
- Bases: discipline: boxing, technical, as TL-1a's character drills (a coach-led tone set); category: technical, as TL-1a's character drills; purpose: the print-ready layout's 'COACH INTENT: Establish calm, spacing, and attention.'; target_behavior: AI draft from the typed line (its Say, Watch and Fix lines) and the step's block title; stop_rules: AI draft from the print-ready layout's WATCH FOR list ('Talking / distraction', 'Athletes too close'); 'restart the two minutes' is this lane's

### Step 2. Movement in Stance: Small Steps Four Ways (`drl_c7e4c5ae475b65`)

- Typed line: "Say: / "Small steps. Forward, back, left, right." / Non-negotiables: knees bent, hands up, feet do not cross / Fix: "Smaller steps." / "Hands home.""
- Purpose: Non-contact hour (4:02-4:04): movement in stance. Target: Move in stance with small steps forward, back, left and right, keeping the non-negotiables.
- Setup: Each athlete in their own space, in stance, with no partner and no contact.
- Execution: Small steps forward, back, left and right, in stance, for two minutes. Non-negotiables: knees bent, hands up, feet do not cross. Fixes: "Smaller steps." / "Hands home."
- Good: Small, balanced steps every direction; knees bent, hands up, feet never crossing.
- Scale: A: Forward and back only. [Two directions.] | B (start): Four directions, as written. | C: Direction changes on the coach's call. [Called directions.]
- Stop: A non-negotiable breaks (knees straight, hands down, feet cross): fix it before going on ("Smaller steps." / "Hands home."). (technique_degradation)
- Cue: "Small steps. Forward, back, left, right."
- Bases: target_behavior: AI draft from the typed line (its Say, Non-negotiables and Fix lines) and the step's block title

### Step 3. Jab and Keep Moving (`drl_1d6dcdeb8b8013`)

- Typed line: "Say: / "Jab and keep moving." / Fix: "Punch then reset." / "Don’t lean.""
- Purpose: Non-contact hour (4:04-4:06): the jab added to movement. Target: Add the jab to the small-step movement without stopping or leaning.
- Setup: Each athlete in their own space, in stance, with no partner and no contact. Shadow jabs that reach no one.
- Execution: Keep the small-step movement and add the jab, in shadow: jab and keep moving, for two minutes. Fixes: "Punch then reset." / "Don’t lean."
- Good: The jab lands in the air from a balanced stance, the feet keep moving, and the stance resets after each punch.
- Scale: A: Jab and keep moving at a slow walking pace. [Slower.] | B (start): Jab and keep moving, as written. | C: Double jab and keep moving. [Double jab.]
- Stop: The athlete leans into the jab or stops moving to punch: reset before the next jab ("Punch then reset."). (technique_degradation)
- Cue: "Jab and keep moving."
- Bases: name: the typed line's Say line ('Jab and keep moving'); 'Jab While Moving' is an existing library drill's name; standard_setup: AI draft; 'shadow' is this lane's reading (the step is contact none)

### Step 4. Slip on a Visual Cue (`drl_bae413a2338d17`)

- Typed line: "Say: / "Slip is small. Head first." / Fix: "Smaller." / "See it first.""
- Purpose: Non-contact hour (4:06-4:08): seeing before moving, applied to the slip. Target: Slip only when the cue is seen: small, head first.
- Setup: Each athlete in their own space, in stance, with no partner and no contact. The coach stands where every athlete can see the visual cue; nothing is thrown at the athlete.
- Execution: The athlete slips when they see the coach's visual cue: a small slip, head first, then back to stance, for two minutes. Fixes: "Smaller." / "See it first."
- Good: Small slips that start with the head, only after the cue is seen, returning to stance each time.
- Scale: A: A slow, clear cue to one side only. [One side.] | B (start): Slip on the visual cue, as written. | C: The coach varies the side and timing of the cue. [Varied cue.]
- Stop: The athlete slips before the cue (guessing) or the slip grows big: stop and reset ("See it first." / "Smaller."). (technique_degradation)
- Cue: "Slip is small. Head first."
- Bases: standard_setup: AI draft; the coach's visual cue is the step's block title; 'nothing is thrown' is this lane's

### Step 6. Technical Spar: Jab Only, Jab and Cross, Then Open but Controlled (`drl_13242d8acf3944`)

- Typed line: "Round 1: Jab only / Round 2: Jab + cross / Round 3: Open but controlled"
- Purpose: The contact hour's technical spar (5:00-6:00 Contact): sparring that tests decisions, not ego. Target: Three controlled rounds that widen the tools step by step: jab only, then jab and cross, then open but controlled.
- Setup: Ring or open mat. Pairs in stance, in sparring gear. Before each bell the coach names the round's role, purpose and coaching focus.
- Execution: Three rounds in the sheet's format (2-minute rounds, 1-minute reset): round 1 jab only; round 2 jab and cross; round 3 open but controlled. The coach sets the intensity within controlled sparring, the step's contact level; round 3 stays controlled sparring.
- Good: Each round keeps to its tools and stays controlled, defense first, with a reset every rep.
- Scale: A: All three rounds jab only. [Jab only.] | B (start): Jab only, jab and cross, open but controlled, as written. | C: In round 3 the coach calls the tools mid-round (jab only / jab and cross / open but controlled); one coaching focus per round; contact stays controlled sparring. [Tools called mid-round.]
- Stop: Stop the round when punches stop being controlled or emotion takes over the exchanges, and one cue does not bring it back. (safety) | Stop the round when contact rises above the level the coach set for this drill. (safety) | Stop the round when an athlete cannot protect themselves structurally. (safety) | If chaos rises above the educational value of the round, intensity is reduced or the round is stopped. (intent_drift) | Punches outside the round's tools come in (a cross in round 1) and one reset does not stop them: stop the round. (intent_drift)
- Cue: "Defense first." | "Reset every rep."
- Bases: discipline: boxing, sparring, as the Friday sheet's sparring drills; category: sparring, as the Friday sheet's sparring drills; purpose: the step's phase (5:00-6:00 Contact) and the DOC-027 Sparring Standard ('Sparring exists to test decisions, not ego'); standard_setup: AI draft: 'ring or open mat', pairs in stance, as the library's DOC-091 sparring drills; the DOC-027 Sparring Standard ('Every round must have a role, a purpose, and a coaching focus'); the sheet names no gear; execution: the typed line, word for word in substance; the sheet's Format (2:00 rounds / 1:00 reset); the drill states no intensity figure (the template's own contact intensity line stays on the template); 'round 3 stays controlled sparring' keeps the step's contact level; stop_rules: the Friday sheet's sparring drills' two safety rules and the library's 'cannot protect themselves structurally' (as TL-3a's open-sparring drill), word for word; the DOC-027 Sparring Standard owner passage on this template ('If chaos rises above the educational value of the round, intensity is reduced or the round is stopped.'), word for word; the tools rule from the typed line; target_behavior: AI draft from the typed line and the step's block title; equipment_needed: blank: the sheet names no gear; cues: the print-ready layout's GLOBAL FIX LANGUAGE (USE EXACT WORDING), word for word

### Step 7. Situational Spar: Defense Before Score, Ropes Escape, Higher-Pace Finish (`drl_0126497cf4649f`)

- Typed line: "Defense before score / Ropes escape first / Higher pace finish"
- Purpose: The contact hour's situational spar (5:00-6:00 Contact): sparring that tests decisions, not ego. Target: Controlled situational rounds: defense before scoring, escaping the ropes first, finishing at a higher pace.
- Setup: Ring. Pairs in stance, in sparring gear. For the ropes situation one athlete begins near the ropes; athletes switch roles each round. Before each bell the coach names the round's situation, role and coaching focus.
- Execution: Situational rounds in the sheet's format (2-minute rounds, 1-minute reset): defense before score; ropes escape first; a higher-pace finish. The higher pace raises the pace, not the contact: every round stays within controlled sparring, the step's contact level.
- Good: Defense comes before every score, the ropes are left before anything else, and the finish is faster but still controlled.
- Scale: A: Defense before score only, for every round. [One situation.] | B (start): The three situations, as written. | C: The coach calls the next situation mid-round, not only at the bell (a ropes situation starts at the bell or after a stop); contact stays controlled sparring. [Called mid-round.]
- Stop: Stop the round when punches stop being controlled or emotion takes over the exchanges, and one cue does not bring it back. (safety) | Stop the round when contact rises above the level the coach set for this drill. (safety) | Stop the round when an athlete cannot protect themselves structurally. (safety) | If chaos rises above the educational value of the round, intensity is reduced or the round is stopped. (intent_drift) | Stop the round when punches stop being controlled or the escape turns into wrestling or scrambling, and one cue does not settle it. (safety) | When the higher-pace finish turns into rushing: "Freeze." Check stance and spacing, give a one-sentence instruction, take one clean rep, then "Restart slower" (Control > pace > complexity). (intent_drift)
- Cue: "Defense first." | "Eyes up."
- Bases: discipline: boxing, sparring, as the Friday sheet's sparring drills; category: sparring, as the Friday sheet's sparring drills; purpose: the step's phase (5:00-6:00 Contact) and the DOC-027 Sparring Standard ('Sparring exists to test decisions, not ego'); standard_setup: AI draft: 'ring' (the typed line's 'Ropes escape first'), pairs in stance, as the library's DOC-091 sparring drills; 'one athlete begins near the ropes' and 'athletes switch roles each round' from the library's Rope Escape Situation (drl_51897d282e13dd), this lane's reading of the ropes situation; the DOC-027 Sparring Standard ('Every round must have a role, a purpose, and a coaching focus'); the sheet names no gear; target_behavior: AI draft from the typed line and the step's block title; equipment_needed: blank: the sheet names no gear; execution: the typed line, word for word in substance; the sheet's Format (2:00 rounds / 1:00 reset); 'raises the pace, not the contact' is this lane's, keeping the step's controlled sparring; stop_rules: the Friday sheet's sparring drills' two safety rules and the library's 'cannot protect themselves structurally' (as TL-3a's open-sparring drill), word for word; the DOC-027 Sparring Standard owner passage on this template ('If chaos rises above the educational value of the round, intensity is reduced or the round is stopped.'), word for word; the library's Rope Escape Situation (drl_51897d282e13dd) safety stop, word for word; the pace stop from the print-ready layout's GLOBAL CHAOS RESET ('Freeze.', 'Restart slower', 'Control > pace > complexity'); cues: the print-ready layout's GLOBAL FIX LANGUAGE (USE EXACT WORDING), word for word

### Step 8. Conditioning Finish: Technique While Tired (`drl_558fc9e8f7ddc3`)

- Typed line: "Technique while tired / Defense before offense always"
- Purpose: The contact hour's conditioning finish: technique under fatigue, with no contact. Target: Keep technique, and defense before offense, while tired.
- Setup: Each athlete in their own space, in stance, with no partner and no contact. Shadow work, after the sparring.
- Execution: A conditioning finish in shadow, the work the coach sets: technique while tired, defense before offense always.
- Good: Technique holds as fatigue rises; every sequence starts with defense.
- Scale: A: Shorter work periods with longer rests. [More rest.] | B (start): The finish as written. | C: Longer work periods, defense before offense in every one. [Longer work.]
- Stop: Technique breaks down under fatigue (stance lost, guard dropped): stop, rest, then restart at level A. (fatigue)
- Cue: "Defense before offense always"
- Bases: discipline: conditioning: the step's block (finish_block, the conditioning finish); standard_setup: AI draft; 'shadow' and 'after the sparring' are this lane's reading (the step is contact none, in the contact hour); execution: the typed line; the sheet names no exercises, so the work is the coach's; target_behavior: AI draft from the typed line and the step's block title; cues: the typed line's own words, word for word; stop_rules: AI draft from the typed line ('Technique while tired')
