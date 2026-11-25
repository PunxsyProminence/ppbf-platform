# Lane W4-8, TL-1a: drills for the typed steps of the three 48-Session Youth Coaching Manuals (review sheet)

Rulings: OD-2026-11-19-030 (OW26-05, Jason: "B: Turn typed lines into library drills"); OD-2026-11-20-001 OW27-09 (Q8.1: "B: A new drill for every line"); Q8.2 (Overwatch on #2050: a heading is a typed line); OD-2026-11-15-011 (AI drafts load once the lane's two adversarial reviewers pass this sheet; fixes by new drill version only). Plan and GO: #2162 (W4_SIZING.md section 8 is the plan of record).

Source: the typed lines of `wtp_43c793b8f90e77` (Weeks 1–4), `wtp_ed57bea28de0f7` (Weeks 5–8) and `wtp_d861f584584788` (Weeks 9–12), DOC-151 as committed, with those templates' own coach notes ("Coaching cue: Posture before speed. Coaching standard: Guard returns after every punch. Rule: Technique breakdown = reset."). Every line is quoted word for word in its drill's `source_ref`.

## What this PR loads, and what it does not

- 16 new library drills, one per unique typed line (30 positions; the 7 lines all three manuals share are one drill each). Version 1, own lineage, `drl_` id = sha256(discipline:name). No step is linked here: TL-1b links the 30 steps and takes the three manuals off `TYPED_IN_MIXED`.
- Every drafted field is labelled `INFERRED` with the draft marker "AI draft, lane W4-8, 2026-11-25 (OD-2026-11-19-030; OD-2026-11-20-001 OW27-09; OD-2026-11-15-011)", a basis and its sources; `content_class` "AI DRAFT - lane W4-8, ...; coach to edit"; `field_provenance` the COACHING-CRAFT DRAFT value; evidence `UNTIERED`, `unchecked`; `stage_keys` blank (as lane HW).
- Each drill: scale levels A, B (starting point), C (`scaffold_needs_coach_review`); at least one own stop rule (`drill_specific`); a cue on every boxing drill (OD-2026-10-06-026 ruling 2). Contact `none` on every drill and level, as every step. `requires_coach_authorization` false. Blank: what bad looks like, common errors, corrections, transfer, exit condition, correction path.
- Cues: "Posture before speed." and "Guard returns after every punch." are the manuals' own coach notes, word for word; five come from the line's own words (the breathing count, the life-skill talk, the three character focuses); two are AI-drafted with no source passage (Rounds 2 and 3). Conditioning drills need no cue; all but one carry one.
- No name is equal to, inside, or contains an existing drill's name (the import's near-duplicate rule, checked by script and by `typedLinesContent.test.ts`).

## The 16 drills

| # | drill_id | name | discipline / category | steps | typed line |
|---|---|---|---|---|---|
| 1 | `drl_dce3452a913583` | Jump Rope Progression: Rhythm, Alternating Feet, High Knees | conditioning / warmup | Weeks 1–4, Weeks 5–8, Weeks 9–12 step 1 | Jump rope progression (rhythm → alternating feet → high knees). |
| 2 | `drl_40f93d01bd4b69` | Dynamic Mobility for Hips, Upper Back and Shoulders | conditioning / mobility | Weeks 1–4, Weeks 5–8, Weeks 9–12 step 2 | Dynamic mobility (hips, thoracic rotation, shoulders). |
| 3 | `drl_2bd1d0742ece8d` | Applied Round 1: Technical Scoring Only | boxing / technical | Weeks 1–4, Weeks 5–8, Weeks 9–12 step 7 | Round 1: Technical scoring only. |
| 4 | `drl_8c42877a38946f` | Applied Round 2: Add a Movement Exit | boxing / footwork | Weeks 1–4, Weeks 5–8, Weeks 9–12 step 8 | Round 2: Add movement exit. |
| 5 | `drl_5927f2f35347c2` | Applied Round 3: Add a Defensive Trigger | boxing / defense | Weeks 1–4, Weeks 5–8, Weeks 9–12 step 9 | Round 3: Add defensive trigger. |
| 6 | `drl_0967cc300cfc5e` | Breathing Reset: 4-Second Inhale, 6-Second Exhale | boxing / technical | Weeks 1–4, Weeks 5–8, Weeks 9–12 step 13 | 4-sec inhale / 6-sec exhale breathing reset. |
| 7 | `drl_1e56dfc77428eb` | Life-Skill Talk Tied to Training (2 Minutes) | boxing / technical | Weeks 1–4, Weeks 5–8, Weeks 9–12 step 14 | 2-minute life-skill discussion tied to training. |
| 8 | `drl_6396e76abea2e0` | Straight Punch Bursts, 5 x 20 Seconds | conditioning / conditioning | Weeks 1–4 step 10 | 5×20 sec straight punch bursts |
| 9 | `drl_ba386c3e7d41e1` | Controlled Footwork Between Bursts, 40 Seconds | conditioning / footwork | Weeks 1–4 step 11 | 40 sec controlled footwork between bursts |
| 10 | `drl_0ef91e6a066df9` | Character Focus: Discipline | boxing / technical | Weeks 1–4 step 12 | Character Focus: Discipline – Build routine, follow structure without reminders. |
| 11 | `drl_4df0b9ab4b632c` | Punch Bursts, 4 x 30 Seconds | conditioning / conditioning | Weeks 5–8 step 10 | 4×30 sec punch bursts |
| 12 | `drl_1508f028c4ce4e` | Fourth-Round Simulation (Weeks 7-8) | conditioning / conditioning | Weeks 5–8 step 11 | Add 4th round simulation in Weeks 7–8 |
| 13 | `drl_4cc1133e4158e8` | Character Focus: Composure and Accountability | boxing / technical | Weeks 5–8 step 12 | Character Focus: Composure & Accountability – Stay calm under pressure, accept correction immediately. |
| 14 | `drl_273f6b1e785e96` | Conditioning Bursts, 5 x 30 Seconds | conditioning / conditioning | Weeks 9–12 step 10 | 5×30 sec bursts |
| 15 | `drl_7c236b9eb91129` | Strict 1-Minute Rest Intervals | conditioning / conditioning | Weeks 9–12 step 11 | Strict 1-minute rest intervals |
| 16 | `drl_b6903e7c2c7291` | Character Focus: Confidence and Leadership | boxing / technical | Weeks 9–12 step 12 | Character Focus: Confidence & Leadership – Execute under fatigue, model standards for peers. |

### 1. Jump Rope Progression: Rhythm, Alternating Feet, High Knees (`drl_dce3452a913583`)

- Purpose: Raise the heart rate and wake up the feet before technical work, in the 0-8 min warm-up. Target: Warm up on the rope in three stages, keeping rhythm and posture as the feet get faster.
- Setup: Each athlete has a rope and clear space all round, spaced so no rope can reach another athlete. The coach stands where every athlete's feet and posture can be seen. Equipment: jump rope.
- Execution: Skip in three stages: an easy rhythm first, then alternating feet, then high knees. Move to the next stage only while the rope keeps turning cleanly. The warm-up's 0-8 minutes are shared with dynamic mobility.
- Good: Tall posture, light and quiet landings on the balls of the feet, and an even rhythm in every stage: posture before speed.
- Scale: A: Rhythm and alternating feet only; a phantom rope (no rope) if the rope keeps catching. | B (start): The three stages as written: rhythm, alternating feet, high knees. | C: A longer high-knee stage with the same clean rhythm.
- Stop: Posture slumps or landings turn heavy and loud: drop back a stage until the rhythm is clean (posture before speed). (technique_degradation) | An athlete trips on the rope or a rope comes near another athlete: stop, re-space, then restart. (safety)
- Cue: "Posture before speed."; basis: the manual's coaching cue 'Posture before speed.' (template coach notes), word for word

### 2. Dynamic Mobility for Hips, Upper Back and Shoulders (`drl_40f93d01bd4b69`)

- Purpose: Prepare the joints boxing uses most, in the 0-8 min warm-up. Target: Move the hips, upper back and shoulders through a comfortable range before boxing.
- Setup: Athletes in open space, an arm's length apart. The coach stands in front and shows each movement first.
- Execution: Controlled moving stretches for the hips, then turning through the upper back (thoracic rotation), then the shoulders. Each movement grows from small to a full, comfortable range; no bouncing at the end of the range.
- Good: Smooth, controlled movement through a comfortable range, posture tall and breathing easy.
- Scale: A: A smaller range and slower, with a hand on the wall for balance if needed. | B (start): Hips, thoracic rotation and shoulders as written. | C: Full comfortable range, finishing each part in boxing stance.
- Stop: Pain in a joint (more than a stretch): stop that movement and tell the coach. (safety) | Movements turn fast and jerky: slow back to a controlled range (posture before speed). (technique_degradation)
- Cue: "Posture before speed."; basis: the manual's coaching cue 'Posture before speed.' (template coach notes), word for word

### 3. Applied Round 1: Technical Scoring Only (`drl_2bd1d0742ece8d`)

- Purpose: Start the applied rounds (20-35 min) by putting the session's technique into a round, judged on form, not speed or volume. Target: Work a round in which only clean technique counts.
- Setup: Each athlete in their own space, in stance, with no partner and no contact. The coach stands where every stance and guard can be seen.
- Execution: Athletes work the round with the session's technical material. The coach scores technique only: stance, straight punches, and the guard returning after every punch. Speed, power and volume do not score. The movement exit and the defensive trigger come in rounds 2 and 3.
- Good: Stance holds, punches go out straight and the guard returns after every punch, for the whole round.
- Scale: A: Fewer, slower actions, each called by the coach. | B (start): The round as written: technical scoring only. | C: Athletes choose their own actions from the session's material, still scored on technique only.
- Stop: Technique breaks down (stance lost, guard not returning): stop and reset before going on (Technique breakdown = reset). (technique_degradation)
- Cue: "Guard returns after every punch."; basis: the manual's coaching standard 'Guard returns after every punch.' (template coach notes), word for word

### 4. Applied Round 2: Add a Movement Exit (`drl_8c42877a38946f`)

- Purpose: Second applied round: add a movement exit to round 1's technique-only work. Target: Finish each action by moving out of range, keeping round 1's technique.
- Setup: Each athlete in their own space, in stance, with no partner and no contact. The coach stands where every athlete's feet can be seen.
- Execution: As round 1, and after each action the athlete moves out of range with a step or a pivot, finishing in stance with the guard up, before the next action. Technique still decides the score.
- Good: An exit after every action, in stance, guard up, feet not crossing.
- Scale: A: Exit with one step back after each action. | B (start): Round 2 as written: technique plus a movement exit. | C: Exit in the direction the coach calls: back, left or right.
- Stop: Feet cross or balance is lost on the exit: stop and reset the stance before the next action (Technique breakdown = reset). (technique_degradation)
- Cue: "Punch, then exit in stance."; basis: AI draft, no source passage

### 5. Applied Round 3: Add a Defensive Trigger (`drl_5927f2f35347c2`)

- Purpose: Third applied round: add a defensive trigger to the technique and movement exit of rounds 1 and 2. Target: React to the coach's trigger with a defensive move, then go back to clean technique.
- Setup: Each athlete in their own space, in stance, with no partner and no contact. The coach stands where every athlete can see the trigger.
- Execution: As round 2, and when the coach gives the trigger (a call or a raised hand), the athlete makes the defensive move the session has taught, resets in stance and carries on. Nothing is thrown at the athlete.
- Good: The defensive move comes straight after the trigger, and the athlete is back in stance, guard up, before the next action.
- Scale: A: Slow triggers, only between actions. | B (start): Round 3 as written. | C: Triggers at unpredictable moments, including in the middle of a combination.
- Stop: The defensive move or the reset breaks down: stop and reset before going on (Technique breakdown = reset). (technique_degradation)
- Cue: "See it, defend, reset."; basis: AI draft, no source passage

### 6. Breathing Reset: 4-Second Inhale, 6-Second Exhale (`drl_0967cc300cfc5e`)

- Purpose: Calm the body after training, in the 50-60 min character block. Target: Settle breathing with an out-breath longer than the in-breath.
- Setup: Athletes standing or seated in their own space; no partner and no contact. The coach leads the count where everyone can see and hear.
- Execution: Breathe in for 4 seconds and out for 6 seconds at the coach's count, for several slow cycles, shoulders low and relaxed.
- Good: Slow, quiet breathing; the out-breath longer than the in-breath; shoulders dropping.
- Scale: A: A shorter count (in for 3, out for 4) if 4 and 6 feel too long. | B (start): In for 4, out for 6, at the coach's count. | C: Athletes keep the 4 and 6 count on their own.
- Stop: Dizziness or light-headedness: stop the count and breathe normally. (safety)
- Cue: "In for 4, out for 6."; basis: the typed line's own numbers

### 7. Life-Skill Talk Tied to Training (2 Minutes) (`drl_1e56dfc77428eb`)

- Purpose: Close the character block with a short talk that ties training to a life skill. Target: Link one lesson from today's training to life outside the gym.
- Setup: Athletes seated or standing in a circle with the coach; no equipment, no partner work and no contact.
- Execution: For about 2 minutes the coach links one moment from today's training to a life skill (the session's character focus), asks one or two athletes to share, and closes on one sentence.
- Good: About 2 minutes, tied to something that happened in training, with athletes speaking, not only the coach.
- Scale: A: The coach makes the link in one or two sentences. | B (start): A 2-minute talk as written. | C: An athlete makes the link, the coach closing.
- Stop: The talk runs well past 2 minutes or drifts away from training: close it and finish the session. (intent_drift)
- Cue: "Tie it to training."; basis: the typed line's own words

### 8. Straight Punch Bursts, 5 x 20 Seconds (`drl_6396e76abea2e0`)

- Purpose: Weeks 1-4 conditioning block (35-50 min): short, fast bursts of straight punches. Target: Fast straight punches in short bursts, the guard returning every time.
- Setup: Each athlete in their own space, in stance, with no partner and no contact. Shadow punches that reach no one. The coach keeps time where every guard can be seen.
- Execution: Five bursts of 20 seconds of fast straight punches, with 40 seconds of controlled footwork between bursts (the next step). Speed comes from snap and return, not from losing the stance.
- Good: Straight punches, the guard back after every punch, the stance held to the end of each burst.
- Scale: A: Five bursts at a steady pace, not fast. | B (start): 5 x 20 s fast straight punch bursts. | C: The same bursts with coach-called straight-punch combinations.
- Stop: Technique breaks down (the guard stays out, the stance is lost, punches swing wide): stop the burst and reset (Technique breakdown = reset). (technique_degradation)
- Cue: "Guard returns after every punch."; basis: the manual's coaching standard 'Guard returns after every punch.' (template coach notes), word for word

### 9. Controlled Footwork Between Bursts, 40 Seconds (`drl_ba386c3e7d41e1`)

- Purpose: Active recovery between the Weeks 1-4 punch bursts. Target: Keep moving in stance, under control, between punch bursts.
- Setup: Each athlete in their own space, in stance, with no partner and no contact. The coach keeps time where every athlete's feet can be seen.
- Execution: After each punch burst, 40 seconds of controlled footwork in stance: small steps in every direction, guard up, breathing settling, ready for the next burst.
- Good: Small, balanced steps, feet not crossing, guard up, breathing slowing.
- Scale: A: Slower: step and hold in stance. | B (start): 40 s of controlled footwork as written. | C: Footwork in the directions the coach calls.
- Stop: Feet cross or the stance is lost: slow down and reset the stance (Technique breakdown = reset). (technique_degradation)
- Cue: "Posture before speed."; basis: the manual's coaching cue 'Posture before speed.' (template coach notes), word for word

### 10. Character Focus: Discipline (`drl_0ef91e6a066df9`)

- Purpose: Open the 50-60 min character block with the Weeks 1-4 character focus. Target: Name the character focus, Discipline: build routine, follow structure without reminders, and tie it to one moment from training.
- Setup: Athletes seated or standing in a circle with the coach; no equipment, no partner work and no contact.
- Execution: The coach names the focus, Discipline: build routine, follow structure without reminders. The coach points to one moment from today's session that shows it, then moves on to the breathing reset and the life-skill talk.
- Good: Athletes can say what the focus means and give one example of it from today's session.
- Scale: A: The coach states the focus and gives the example. | B (start): The focus as written, with one example from today's session. | C: Athletes give the examples themselves, the coach closing.
- Stop: The talk drifts away from the focus or runs long: close it and move to the breathing reset. (intent_drift)
- Cue: "Follow structure without reminders."; basis: the typed line's own words

### 11. Punch Bursts, 4 x 30 Seconds (`drl_4df0b9ab4b632c`)

- Purpose: Weeks 5-8 conditioning block (35-50 min): four 30-second punch bursts. Target: Fast punches in 30-second bursts, the guard returning every time.
- Setup: Each athlete in their own space, in stance, with no partner and no contact. Shadow punches that reach no one. The coach keeps time where every guard can be seen.
- Execution: Four bursts of 30 seconds of fast shadow punches, with the recovery between bursts the coach sets. In Weeks 7-8 a fourth-round simulation is added (the next step).
- Good: Punches stay sharp to the end of each burst; the guard back after every punch; the stance held.
- Scale: A: Four bursts at a steady pace, not fast. | B (start): 4 x 30 s fast punch bursts. | C: The same bursts with coach-called combinations.
- Stop: Technique breaks down (the guard stays out, the stance is lost): stop the burst and reset (Technique breakdown = reset). (technique_degradation)
- Cue: "Guard returns after every punch."; basis: the manual's coaching standard 'Guard returns after every punch.' (template coach notes), word for word

### 12. Fourth-Round Simulation (Weeks 7-8) (`drl_1508f028c4ce4e`)

- Purpose: In Weeks 7-8, extend the conditioning block with a fourth round that simulates working on when tired. Target: Hold technique through an added fourth round.
- Setup: Each athlete in their own space, in stance, with no partner and no contact. Shadow punches that reach no one. The coach keeps time where every guard can be seen.
- Execution: In Weeks 7 and 8 only, add a fourth round to the conditioning block's punch bursts, run like the other three. In Weeks 5 and 6 this step is not run.
- Good: The fourth round looks like the first: the guard returning, the stance held.
- Scale: A: The fourth round at a steady pace. | B (start): A fourth round as written, in Weeks 7-8. | C: The fourth round with coach-called combinations.
- Stop: Technique breaks down in the fourth round: stop and reset (Technique breakdown = reset). (technique_degradation)
- Cue: "Guard returns after every punch."; basis: the manual's coaching standard 'Guard returns after every punch.' (template coach notes), word for word

### 13. Character Focus: Composure and Accountability (`drl_4cc1133e4158e8`)

- Purpose: Open the 50-60 min character block with the Weeks 5-8 character focus. Target: Name the character focus, Composure and Accountability: stay calm under pressure, accept correction immediately, and tie it to one moment from training.
- Setup: Athletes seated or standing in a circle with the coach; no equipment, no partner work and no contact.
- Execution: The coach names the focus, Composure and Accountability: stay calm under pressure, accept correction immediately. The coach points to one moment from today's session that shows it, then moves on to the breathing reset and the life-skill talk.
- Good: Athletes can say what the focus means and give one example of it from today's session.
- Scale: A: The coach states the focus and gives the example. | B (start): The focus as written, with one example from today's session. | C: Athletes give the examples themselves, the coach closing.
- Stop: The talk drifts away from the focus or runs long: close it and move to the breathing reset. (intent_drift)
- Cue: "Stay calm under pressure."; basis: the typed line's own words

### 14. Conditioning Bursts, 5 x 30 Seconds (`drl_273f6b1e785e96`)

- Purpose: Weeks 9-12 conditioning block (35-50 min): five 30-second bursts, for pacing and fatigue discipline. Target: Five hard 30-second bursts, technique held to the end.
- Setup: Each athlete in their own space, in stance, with no partner and no contact. Shadow punches that reach no one. The coach keeps time where every guard can be seen.
- Execution: Five bursts of 30 seconds of fast shadow punches, as in the Weeks 1-8 conditioning blocks, with strict 1-minute rests between them (the next step).
- Good: Technique holds to the end of every burst: the guard back after every punch, the stance held.
- Scale: A: Five bursts at a steady pace, not fast. | B (start): 5 x 30 s bursts as written. | C: The same bursts with coach-called combinations.
- Stop: Technique breaks down (the guard stays out, the stance is lost): stop the burst and reset (Technique breakdown = reset). (technique_degradation)
- Cue: "Guard returns after every punch."; basis: the manual's coaching standard 'Guard returns after every punch.' (template coach notes), word for word

### 15. Strict 1-Minute Rest Intervals (`drl_7c236b9eb91129`)

- Purpose: Weeks 9-12: fixed 1-minute rests between bursts train pacing and fatigue discipline (the template's focus). Target: Recover in exactly one minute between bursts and be ready on time.
- Setup: Athletes in their own space; no partner and no contact. The coach keeps time where everyone can see.
- Execution: Between bursts, rest exactly 1 minute: walk, breathe slowly, hands relaxed, and be back in stance when the coach calls time. The rest is neither cut short nor stretched.
- Good: Every athlete back in stance, guard up, when the minute ends.
- Scale: A: The coach counts the last 10 seconds aloud. | B (start): Strict 1-minute rests as written. | C: Athletes keep their own time and are in stance on the minute without a call.
- Stop: An athlete is still breathing very hard, dizzy or sick when the minute ends: keep them out of the next burst. (fatigue)
- Cue: none (conditioning); basis: none: a conditioning drill needs no cue (OD-2026-10-06-026 ruling 2)

### 16. Character Focus: Confidence and Leadership (`drl_b6903e7c2c7291`)

- Purpose: Open the 50-60 min character block with the Weeks 9-12 character focus. Target: Name the character focus, Confidence and Leadership: execute under fatigue, model standards for peers, and tie it to one moment from training.
- Setup: Athletes seated or standing in a circle with the coach; no equipment, no partner work and no contact.
- Execution: The coach names the focus, Confidence and Leadership: execute under fatigue, model standards for peers. The coach points to one moment from today's session that shows it, then moves on to the breathing reset and the life-skill talk.
- Good: Athletes can say what the focus means and give one example of it from today's session.
- Scale: A: The coach states the focus and gives the example. | B (start): The focus as written, with one example from today's session. | C: Athletes give the examples themselves, the coach closing.
- Stop: The talk drifts away from the focus or runs long: close it and move to the breathing reset. (intent_drift)
- Cue: "Model standards for peers."; basis: the typed line's own words
