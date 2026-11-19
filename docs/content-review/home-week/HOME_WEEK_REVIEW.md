# Lane HW: six PPBF home sessions (review sheet)

Rulings: OD-2026-11-19-005 (OW25-49, Jason: "(c) PPBF writes its own six (Recommended)"); Backbone ACTIONS A-112 (load the six on track `trk_55480ac4429113` in place of the held six; drafted fields labelled AI draft; report the 17 linked drills whose stage tags omit youth stages and change no tags); OD-2026-11-15-011 (AI drafts load once the lane's two adversarial reviewers pass this sheet; Jason does not review them). OW25-50 "D: Defer": no spot-check now.

Source: research finding `2026-11-19-ppbf-home-week-six-sessions-draft.md` (Claude research project, sha256[:16] `0e9c638e5f8ba8e9`), section 3a. It is NOT app source until loaded under the rulings above. Every cue, safety line, amount, rest, intent, warm-up, cool-down and stop-rule line below is the draft's text, carried word for word by script (markdown emphasis dropped). The six held DOC-136 sessions are not loaded, not quoted and not named here.

## What is drafted, and how it is labelled

- Six new workout templates (names below), stage_keys blank (Overwatch Q1 = A): they sit on the track, not on the stage map.
- Every template field (name, session_type, difficulty, age_band, duration_minutes, intent, details, items) is labelled in `field_labels` as `INFERRED`, with `draft: "AI draft, lane HW, 2026-11-19 (OD-2026-11-19-005; OD-2026-11-15-011)"`, a `basis` and sources (the finding, its principles P1-P17, this sheet). `details.field_provenance` reads "AI draft — coach to edit". Every item's `details` carries the same `draft` marker.
- evidence: one entry, `UNTIERED`, `unchecked`, basis "AI draft from the finding's principles P1-P17, mostly transferred from non-boxing research; U12 interval amounts and all set, rep, hold and rest amounts are inferred".
- Primers (Overwatch Q5): the five primers that name no drill are folded into the warm-up item (`details.primer`) and shown in coach_notes with the warm-up line; Day 4's primer, which names Neck Preparation, stays its own step. 50 items.
- Every step names a library drill, so all six can be issued (OD-2026-09-18-001: only an operational drill is assigned; OD-2026-10-07-012 ruling 2: a template issues whole). The six typed steps link six drills lane HW wrote (below); every linked drill passes the adoption-readiness check from the seed files (hwContentPackage.test.ts).
- Item shape (first version, before the two lines above): 1 home warm-up item (drill `drl_dbb0347500e7eb`, second drill `drl_0eaa11e875ffef` in details), 1 session-primer item, the draft's 6 (Day 6: 7) items, 1 home cool-down item (drill `drl_325b6ba2613eb0`, second drill `drl_786d761c9321c0` in details). Amounts for U12 / 12–17 / Adult, rest, cue and safety are in item details; the duration_minutes and rep_count columns are blank because the amounts differ by band. contact_level none on every item.
- duration_minutes column = the draft's Adult total (Overwatch Q3); all three band totals in `details.duration_minutes_by_band`.
- session_type: the in-use word nearest the draft's Focus. Day 4 (Focus "Core and trunk; mobility") is `strength`; no in-use value names core or mobility. **Flag** for the reviewer.
- coach_notes (shown on the coach screen) carries the draft's before-every-session lines and stop rule word for word, and on Day 6 its Day 7 rest line: the coach screen does not show template details (reviewer 2, finding 1). Labelled like every other drafted field.
- The two partial-match items (Day 2 floor Y and T raises; Day 6 towel squeeze and wring) name their related library drill in `details.related_drill` and do not link it: both library drills call for bands, dumbbells, carry weights or a wrist roller (reviewer 2, finding 3).
- Day 7 (rest) is not a template: its line is in Day 6's `details.rest_day_after`.
- The track row `trk_55480ac4429113`: `details.groups` orders 2-7 and `details.session_refs` entries 2-7 now name the six templates below; the row's `sources` gain the OD-2026-11-19-005 ruling; `field_labels.groups` and `field_labels.session_refs` become `INFERRED` with the draft marker for entries 2-7. Orders 1 and 8 are unchanged. The track has no blocks or block sessions, before or after.

## Backbone's check and its declared limits (REPORTED, Backbone ACTIONS A-111)

- 0 shared 8-word runs between the draft and the six DOC-136 records; no held titles reused.
- Limits it declared: 4 sources were read as abstract or registry entry only (the 2014 International Consensus on youth resistance training, the AAP 2020 resistance-training report, the Amsterdam 2022 concussion consensus and the CRT6); the under-12 interval amounts have no study behind them (INFERRED).

## The six templates

| Day | template_id | name | session_type | minutes U12 / 12–17 / Adult |
|---|---|---|---|---|
| 1 | `wtp_2e9f95389e272c` | PPBF Home Day 1 — Stance, Feet and Straight Punches | technical | 21 / 31 / 38 |
| 2 | `wtp_63b76f6dabefae` | PPBF Home Day 2 — Legs, Push, Pull and Trunk | strength | 20 / 31 / 38 |
| 3 | `wtp_84364c8b8e0462` | PPBF Home Day 3 — Rope and Shadow Rounds | conditioning | 22 / 32 / 40 |
| 4 | `wtp_467ce0ee20e65f` | PPBF Home Day 4 — Trunk, Balance and Easy Mobility | strength | 18 / 28 / 37 |
| 5 | `wtp_cfb6c367c54a6a` | PPBF Home Day 5 — Move and Punch | technical | 22 / 32 / 39 |
| 6 | `wtp_09bba17fb68e8d` | PPBF Home Day 6 — Strength B and Recovery Flow | strength | 21 / 35 / 41 |

### Shared by all six (in every template's details)

Before every session:

- Bands: U12 = under 12; 12–17; Adult = 18 and over. Do only your own band's amounts.
- Under 12: an adult is at home and in the room for the whole session, and reads the stop rule first. No sets to failure and no added weight.
- 12–17: tell a parent before you start and when you finish, with an adult at home. No maximal efforts or added weight (no loaded backpacks, nobody on your back). No weight cutting.
- Adults: if you have a heart, lung, metabolic or kidney condition, or symptoms when you exercise, check with your doctor before harder sessions (P14).
- Space and floor: an arm's length of clear space all round, plus room for three steps each way. Use a dry, non-slip floor, bare feet or trainers (not socks), and check the ceiling before skipping.
- Effort words: Easy = you can chat in full sentences; Steady = short sentences; Hard = only a few words. Under-12s stay Easy to Steady except in the short bursts. (A plain guide, not a validated scale.)
- Heat and water: train in a cool, airy room. Drink water before and after, with sips between items. No hoodies, extra layers or plastic suits. If the room is hot, do Day 4 instead or skip the session.
- No weight cutting: these sessions are for fitness and skill, not for making weight. Never skip water or meals to train.
- Gym days: on a day with a gym class, skip the home session or do Day 4 only. Your coach decides how many of the six you do each week.
- Pain: muscle effort and burn are normal. Sharp pain, joint pain, or pain that changes how you move means stop.

Home warm-up (6 / 8 / 8 min):

- March or jog on the spot with arms swinging: 1 / 2 / 2 min.
- Arm circles forward and back: 10 each way.
- Leg swings holding the wall, front-to-back and side-to-side: 8 each leg.
- Slow squat to stand: 6 / 8 / 10.
- Small, quiet ankle bounces: 2 × 10 s / 2 × 15 s / 2 × 20 s.
- Easy shadowboxing, building speed: 1 / 2 / 2 min.
- Then the session's own primer, listed under each day.

Home cool-down (3 / 4 / 5 min; a towel replaces the mat):

- Walk slowly around the room with long out-breaths until your breathing settles.
- Easy holds of 20–30 s each, on the towel: calves at the wall, front of the hip (half-kneeling), hamstrings (lying, towel round the foot), chest at the wall.

Stop rule (every template): stop and tell an adult (adults: your coach) if dizzy or faint, chest pain or tightness, breathing much harder than the effort, a racing or skipping heartbeat, or sharp joint pain. Not today after any knock to the head, with a fever or feeling ill, or in a hot room. Chest pain or fainting: call 911.

### Day 1: PPBF Home Day 1 — Stance, Feet and Straight Punches (`wtp_2e9f95389e272c`)

- Intent: Find your stance without looking down, and make straight punches come back fast.
- Focus: Footwork and shadowboxing technique
- Warm-up: Home warm-up (6 / 8 / 8 min), then: 3 slow walks into stance, freeze and check feet.
- Cool-down: Home cool-down (3 / 4 / 5 min).

| # | block | drill | item | U12 | 12–17 | Adult | rest | cue | safety |
|---|---|---|---|---|---|---|---|---|---|
| 1 | warmup | `drl_dbb0347500e7eb` General Movement Warm-Up + `drl_0eaa11e875ffef` Hip and Ankle Preparation | Home warm-up | | | | | | |
| 2 | technical | `drl_9de5719225a39c` Base Find and Freeze | Find your stance | 2 × 5 | 3 × 6 | 3 × 8 | 20 s | Walk, stop, land in stance in one step — then check your feet. | Clear the floor of toys, rugs and cords first. |
| 3 | technical | `drl_7e09f9990ea721` Guard Set and Hold | Guard set and hold | 2 × 15 s | 3 × 20 s | 3 × 30 s | 20 s | Hands at the cheekbones, elbows in, chin down. | Shoulders loose between holds; keep breathing. |
| 4 | technical | `drl_bf062f758ca6d2` Line work | Step and slide along the towel | 3 × 30 s | 3 × 45 s | 3 × 1 min | 30 s | Going forward the front foot moves first; going back, the back foot. | Bare feet or trainers on a non-slip floor; socks slip. |
| 5 | technical | `drl_a8fcfc8f0a4c63` Jab Return Under Count | Jab and snap back | 2 × 10 | 3 × 12 | 3 × 15 | 30 s | Back to your face faster than it went out. | Stop just short of a locked elbow. |
| 6 | technical | `drl_7288d58dc1ed47` Slow-motion cross | Slow-motion back-hand straight | 2 × 5 | 3 × 6 | 3 × 8 | 30 s | Foot, hip, shoulder, hand — in that order, 5 seconds per punch. | Turn the back heel; never twist the knee on a planted foot. |
| 7 | technical | `drl_e7587c167c1ebd` Shadow With an Imagined Opponent | Shadow round: jab, one-two, move | 2 × 1 min | 2 × 2 min | 3 × 2 min | 60 s | Picture an opponent walking at you: punch, then step off the line. | An arm's length of clear space all round you. |
| 8 | cooldown | `drl_325b6ba2613eb0` Cool-Down Walk and Breathe + `drl_786d761c9321c0` Post-Session Mobility | Home cool-down | | | | | | |

### Day 2: PPBF Home Day 2 — Legs, Push, Pull and Trunk (`wtp_63b76f6dabefae`)

- Intent: Whole-body strength with clean form; finish every set with 2–3 good reps still in the tank.
- Focus: Bodyweight strength
- Warm-up: Home warm-up (6 / 8 / 8 min), then: 2 × 5 slow squats to a comfortable depth.
- Cool-down: Home cool-down (3 / 4 / 5 min).

| # | block | drill | item | U12 | 12–17 | Adult | rest | cue | safety |
|---|---|---|---|---|---|---|---|---|---|
| 1 | warmup | `drl_dbb0347500e7eb` General Movement Warm-Up + `drl_0eaa11e875ffef` Hip and Ankle Preparation | Home warm-up | | | | | | |
| 2 | strength | `drl_7b05e2c6d49010` Bodyweight Lower Push | Bodyweight squat | 2 × 8 | 3 × 10 | 3 × 12–15 | 45 s / 60 s / 60 s | Sit back between your heels; knees follow your toes. | Pain at the front of the knee: squat less deep. |
| 3 | strength | `drl_edb69a2d822df7` Bodyweight Upper Push | Push-up, scaled | 2 × 6 (wall or knees) | 3 × 6–10 (knees or full) | 3 × 8–15 | 60 s | Move as one straight plank, chest to the floor or wall. | Hips sagging: switch to the wall or knee version. |
| 4 | strength | `drl_8549299fc8d8c7` Hinge Pattern | Hip hinge to the wall | 2 × 8 | 3 × 10 | 3 × 12 | 45 s | Push your hips back to touch the wall behind you; back stays long. | No rounding the lower back; stop if it pinches. |
| 5 | strength | `drl_d75b4c493c3c82` Split Squat Iso Hold | Split-squat hold | 2 × 15 s each leg | 3 × 20 s each leg | 3 × 30 s each leg | 30 s | Front heel heavy; back knee hovers above the floor. | A hand on the wall for balance is fine. |
| 6 | strength | `drl_7bcdd061b3f789` Floor Y and T raises (related, not linked: `drl_d0d14430bb0ddb` Face pulls, external rotation at multiple angles, prone Y/T/W, serratus work) — new PPBF drill (lane HW, Overwatch Q4); the related library drill in related_drill uses bands or weights and is not linked | Floor Y and T raises (on the towel) | 2 × 6 (3 Y + 3 T) | 2 × 8 | 3 × 10 | 30 s | Thumbs up; draw the shoulder blades down and back. | Small lifts; forehead rests on the towel, neck long. |
| 7 | strength | `drl_2d3741d101a571` Dead bug, bird dog | Bird dog | 2 × 5 each side | 2 × 8 each side | 3 × 8 each side, 3 s hold | 30 s | Keep your back still enough to balance a cup on it. | Move slowly; stop if the lower back aches. |
| 8 | cooldown | `drl_325b6ba2613eb0` Cool-Down Walk and Breathe + `drl_786d761c9321c0` Post-Session Mobility | Home cool-down | | | | | | |

### Day 3: PPBF Home Day 3 — Rope and Shadow Rounds (`wtp_84364c8b8e0462`)

- Intent: Repeat hard-but-clean efforts with short rests, the way rounds feel.
- Focus: Conditioning intervals
- Warm-up: Home warm-up (6 / 8 / 8 min), then: 1 minute of easy skipping (or bouncing on the spot without a rope).
- Cool-down: Home cool-down (3 / 4 / 5 min).

| # | block | drill | item | U12 | 12–17 | Adult | rest | cue | safety |
|---|---|---|---|---|---|---|---|---|---|
| 1 | warmup | `drl_dbb0347500e7eb` General Movement Warm-Up + `drl_0eaa11e875ffef` Hip and Ankle Preparation | Home warm-up | | | | | | |
| 2 | conditioning | `drl_40acc6820f5df6` Skipping — Continuous | Easy rope | 3 × 30 s | 3 × 1 min | 3 × 2 min | 30 s | Quiet feet; turn the rope with your wrists, not your arms. | Check ceiling height and lights; skip on a firm, non-slip floor. |
| 3 | conditioning | `drl_b67ee94d958d32` Skipping — Varied | Rope changes | 2 × 30 s | 3 × 45 s | 3 × 1 min | 30 s | Switch every 10 turns: two feet, boxer skip, one foot at a time. | Sore shins: swap to bouncing without the rope. |
| 4 | conditioning | `drl_6bd0ad1ffb7a50` Shadow boxing intervals | Shadow bursts | 4 × 15 s fast | 6 × 20 s fast | 8 × 30 s fast | 45 s / 40 s / 30 s | Fast hands, but every punch comes back to your face. | End the burst if form falls apart or you feel light-headed. |
| 5 | conditioning | `drl_39ec154e04cb95` Lateral Line Hops | Towel line hops | 3 × 10 s | 4 × 15 s | 4 × 20 s | 30 s | Small, quick, quiet — land on the balls of your feet. | Hop over the towel, never onto it. |
| 6 | conditioning | `drl_85a93f6757497a` Punch Burst | Straight-punch bursts in stance | 3 × 5 s | 4 × 8 s | 5 × 10 s | 25 s / 25 s / 20 s | Snap, don't shove. | Elbows soft; no locking out at speed. |
| 7 | conditioning | `drl_03b9c6da4f9fe9` Diaphragmatic breathing | Breathing reset | 1 minute | 1 minute | 1 minute | no rest needed | Make each breath out longer than the breath in. | Breathing still hard after the cool-down: stop and tell someone. |
| 8 | cooldown | `drl_325b6ba2613eb0` Cool-Down Walk and Breathe + `drl_786d761c9321c0` Post-Session Mobility | Home cool-down | | | | | | |

### Day 4: PPBF Home Day 4 — Trunk, Balance and Easy Mobility (`wtp_467ce0ee20e65f`)

- Intent: A steady trunk and good balance for stance and pivots; an easier day in the week.
- Focus: Core and trunk; mobility (the lighter day)
- Warm-up: Home warm-up (6 / 8 / 8 min), then: Easy neck and shoulder range: look left, right, up, down, slowly, 3 each.
- Cool-down: Home cool-down (3 / 4 / 5 min).

| # | block | drill | item | U12 | 12–17 | Adult | rest | cue | safety |
|---|---|---|---|---|---|---|---|---|---|
| 1 | warmup | `drl_dbb0347500e7eb` General Movement Warm-Up + `drl_0eaa11e875ffef` Hip and Ankle Preparation | Home warm-up | | | | | | |
| 2 | warmup | `drl_25e4934a3ab2ab` Neck Preparation | Session primer: Easy neck and shoulder range: look left, right, up, down, slowly, 3 each. | | | | | | |
| 3 | strength | `drl_2d3741d101a571` Dead bug, bird dog | Dead bug | 2 × 5 each side | 2 × 8 each side | 3 × 8 each side | 30 s | Lower back stays heavy on the floor. | Breathe out as the arm and leg reach away. |
| 4 | strength | `drl_f5d68d0b9b4be7` Side plank variants | Side plank | 2 × 10–15 s each side, knees bent | 2 × 20–30 s each side | 3 × 30–45 s each side | 30 s | Straight line from head to knees (or feet). | Shoulder hurts: drop to the bent-knee version. |
| 5 | strength | `drl_563b857233c3ee` Forearm plank — new PPBF drill (lane HW, Overwatch Q4): no library drill matched | Forearm plank | 2 × 15 s | 3 × 20–30 s | 3 × 30–45 s | 30 s | Squeeze your glutes and push the floor away. | Stop the hold when the hips sag. |
| 6 | strength | `drl_ed59c17ae9a3b1` Single-Leg Stability | One-leg stance with punches | 2 × 15 s each leg (punches optional) | 3 × 20 s each leg | 3 × 30 s each leg | 20 s | Eyes forward, standing knee soft, slow one-twos. | Stand within reach of the wall. |
| 7 | strength | `drl_09e85ad8df9c95` Thoracic spine mobility | Open book | 1 × 5 each side | 2 × 6 each side | 2 × 8 each side | 0 / 15 s / 15 s | Eyes follow the top hand as it opens. | Only as far as is comfortable; never force it. |
| 8 | strength | `drl_0eaa11e875ffef` Hip and Ankle Preparation | Ankle rocks and hip switches | 1 × 6 each side | 2 × 8 each side | 2 × 10 each side | 0 / 15 s / 15 s | Knee travels over the little toes; heel stays down. | Ease off at any pinch in the hip or ankle. |
| 9 | cooldown | `drl_325b6ba2613eb0` Cool-Down Walk and Breathe + `drl_786d761c9321c0` Post-Session Mobility | Home cool-down | | | | | | |

### Day 5: PPBF Home Day 5 — Move and Punch (`wtp_cfb6c367c54a6a`)

- Intent: Join feet and hands: punch, then move off the line.
- Focus: Footwork and shadowboxing technique, with moderate conditioning
- Warm-up: Home warm-up (6 / 8 / 8 min), then: 1 minute of small step-and-slides on the spot.
- Cool-down: Home cool-down (3 / 4 / 5 min).

| # | block | drill | item | U12 | 12–17 | Adult | rest | cue | safety |
|---|---|---|---|---|---|---|---|---|---|
| 1 | warmup | `drl_dbb0347500e7eb` General Movement Warm-Up + `drl_0eaa11e875ffef` Hip and Ankle Preparation | Home warm-up | | | | | | |
| 2 | technical | `drl_eaf0e3cba383bf` Box drill | Four-side square | 2 × 30 s each direction | 2 × 45 s each direction | 2 × 60 s each direction | 30 s | Face the same way the whole time: forward, side, back, side. | Size the square to your room — towel as one side. |
| 3 | technical | `drl_f0156a0b5388f7` Pivot circuit | Pivot | 2 × 5 each way | 3 × 6 each way | 3 × 8 each way | 30 s | Turn on the ball of the front foot; the back foot swings round. | Pivot on the ball of the foot, not the heel, to spare the knee. |
| 4 | technical | `drl_c933404c933b35` Jab with step | Jab with a step | 2 × 8 | 3 × 10 | 3 × 12 | 30 s | Hand and front foot land together. | Small steps indoors. |
| 5 | technical | `drl_5ff7db8ae359c1` Combination 1 – 2 – pivot (for U12 in Y1–Y2: `drl_bbf178262859b4` Pivot after every 2 punches) | One-two, then pivot | 2 × 6 | 3 × 8 | 3 × 10 | 30 s | Punch, punch, turn — finish facing your target. | Guard stays up through the turn. |
| 6 | technical | `drl_0f284bce7c9171` Shadow with direction calls | Shadow with direction changes | 2 × 1 min | 2 × 2 min | 3 × 2 min | 60 s | Change direction on each timer beep (or each third combination) and keep punching. | Never move backwards towards stairs or furniture. |
| 7 | technical | `drl_43da0d1ce221fe` Recovery Step Reset | Step and reset | 2 × 5 | 2 × 8 | 3 × 8 | 30 s | One step, then straight back to your stance. | Controlled steps on a dry floor. |
| 8 | cooldown | `drl_325b6ba2613eb0` Cool-Down Walk and Breathe + `drl_786d761c9321c0` Post-Session Mobility | Home cool-down | | | | | | |

### Day 6: PPBF Home Day 6 — Strength B and Recovery Flow (`wtp_09bba17fb68e8d`)

- Intent: A second strength day, then a slow flow that leaves the week loose.
- Focus: Bodyweight strength; mobility and recovery
- Warm-up: Home warm-up (6 / 8 / 8 min), then: 2 × 5 glute bridges.
- Cool-down: Home cool-down (3 / 4 / 5 min).
- Day 7, Rest: No session. Easy walking or play is fine. Sleep well. If anything still hurts from the week, tell your coach.

| # | block | drill | item | U12 | 12–17 | Adult | rest | cue | safety |
|---|---|---|---|---|---|---|---|---|---|
| 1 | warmup | `drl_dbb0347500e7eb` General Movement Warm-Up + `drl_0eaa11e875ffef` Hip and Ankle Preparation | Home warm-up | | | | | | |
| 2 | strength | `drl_aeb2cbd5cc593d` Reverse lunge — new PPBF drill (lane HW, Overwatch Q4): no library drill matched | Reverse lunge | 2 × 5 each leg, hand on wall | 3 × 8 each leg | 3 × 10 each leg | 45 s / 60 s / 60 s | Step back long; front knee stays over the front foot. | Hand on the wall if wobbly. |
| 3 | strength | `drl_8ca8814b596907` Push-Up Iso Hold | Push-up hold | 2 × 10 s (wall or knees) | 3 × 15 s | 3 × 20–30 s | 45 s | Elbows about 45° from the body; body straight. | Stop the hold when the hips drop. |
| 4 | strength | `drl_cbc25e710fb3e3` Glute bridge — new PPBF drill (lane HW, Overwatch Q4): no library drill matched | Glute bridge | 2 × 8 | 3 × 10 | 3 × 10 each leg (single-leg) or 3 × 15 | 30 s / 45 s / 45 s | Push through the heels; squeeze 2 seconds at the top. | Ribs down; don't arch the lower back. |
| 5 | strength | `drl_83057d7afff22a` Punch Iso Hold + `drl_85a93f6757497a` Punch Burst | Punch hold, then snap | 2 × (5 s hold + 3 snaps) each hand | 3 × (10 s hold + 5 snaps) each hand | 3 × (15 s hold + 5 snaps) each hand | 30 s | Wrist, elbow and shoulder in one line — then 3–5 fast snaps. | Arm long but never locked. |
| 6 | strength | `drl_564171b28b3667` Towel squeeze and wring (related, not linked: `drl_179419bceeab59` Grip, forearm and wrist strengthening) — new PPBF drill (lane HW, Overwatch Q4); the related library drill in related_drill uses bands or weights and is not linked | Towel squeeze and wring | 2 × 10 s squeeze | 3 × (15 s squeeze + 5 wrings each way) | 3 × (20 s squeeze + 8 wrings each way) | 30 s | Squeeze with the whole hand; keep the wrist straight. | Stop if the wrist or knuckles hurt. |
| 7 | strength | `drl_35aac3b481205b` Wall calf raise — new PPBF drill (lane HW, Overwatch Q4): no library drill matched | Wall calf raise | 2 × 10 | 3 × 12 | 3 × 15 | 30 s | Up for 1 count, down for 3. | Keep a hand on the wall. |
| 8 | strength | `drl_44173cce2543ae` Progressive muscular relaxation | Tighten and let go (lying on the towel) | 2 minutes | 3 minutes | 3 minutes | no rest needed | Tighten hands, shoulders, jaw for a moment — then let go and feel the difference. | Skip any area that hurts. |
| 9 | cooldown | `drl_325b6ba2613eb0` Cool-Down Walk and Breathe + `drl_786d761c9321c0` Post-Session Mobility | Home cool-down | | | | | | |

## The six drills lane HW wrote, and the cue it added (Overwatch GO: Q4 A, Q6)

Each is discipline `conditioning` (as the library files Bodyweight Lower Push), category `strength`, difficulty `beginner`, contact `none`, no coach authorization, blank stage keys, provenance "COACHING-CRAFT DRAFT ... REQUIRES FLOOR VALIDATION", content class "AI DRAFT - lane HW". Every field is labelled INFERRED with the lane HW marker. Purpose (and target behaviour), setup and what-good-looks-like are the lane's wording from the draft (the day's Intent; the item's cue, safety line and the space line), not the draft's words, and their labels say so. Execution, the cue and the stop rules are the draft's words. All 18 scale rows carry authoring_state `scaffold_needs_coach_review`; the rows marked "AI-drafted" have no basis in the draft (Overwatch Q4 A).

### Floor Y and T raises (`drl_7bcdd061b3f789`)

- Source: research finding 2026-11-19-ppbf-home-week-six-sessions-draft.md, Day 2 item 5 (Floor Y and T raises (on the towel))
- Purpose (lane wording): Upper-back and shoulder strength with clean form, without equipment.
- Setup (lane wording): Lying face down on the towel, forehead resting on it and the neck long, with an arm's length of clear space all round. Equipment: a towel.
- Execution (draft): U12: 2 × 6 (3 Y + 3 T) · 12–17: 2 × 8 · Adult: 3 × 10 · rest 30 s. Thumbs up; draw the shoulder blades down and back.
- What good looks like (lane wording): Thumbs up and the shoulder blades drawn down and back; small lifts, the forehead on the towel and the neck long.
- Cue (draft): Thumbs up; draw the shoulder blades down and back.
- Stop rule 1 (safety): Stop and tell an adult (adults: your coach) if dizzy or faint, chest pain or tightness, breathing much harder than the effort, a racing or skipping heartbeat, or sharp joint pain. Not today after any knock to the head, with a fever or feeling ill, or in a hot room. Chest pain or fainting: call 911.
- Scale A (AI-drafted): One arm at a time, small lifts; the same reps.
- Scale B (as the draft writes it, starting point): The drill as the draft writes it, at your band's amount (U12: 2 × 6 (3 Y + 3 T) · 12–17: 2 × 8 · Adult: 3 × 10 · rest 30 s).
- Scale C (AI-drafted): A 2-second hold at the top of each Y and T; the same reps.

### Forearm plank (`drl_563b857233c3ee`)

- Source: research finding 2026-11-19-ppbf-home-week-six-sessions-draft.md, Day 4 item 3 (Forearm plank)
- Purpose (lane wording): A steady trunk for stance and pivots, held on the floor at home.
- Setup (lane wording): On the floor, with an arm's length of clear space all round, on a dry, non-slip floor. Equipment: none.
- Execution (draft): U12: 2 × 15 s · 12–17: 3 × 20–30 s · Adult: 3 × 30–45 s · rest 30 s. Squeeze your glutes and push the floor away.
- What good looks like (lane wording): Glutes squeezed and the floor pushed away; the hips stay level, not sagging, for the whole hold.
- Cue (draft): Squeeze your glutes and push the floor away.
- Stop rule 1 (technique_degradation): Stop the hold when the hips sag.
- Stop rule 2 (safety): Stop and tell an adult (adults: your coach) if dizzy or faint, chest pain or tightness, breathing much harder than the effort, a racing or skipping heartbeat, or sharp joint pain. Not today after any knock to the head, with a fever or feeling ill, or in a hot room. Chest pain or fainting: call 911.
- Scale A (AI-drafted): Plank on the knees: forearms and knees on the floor, the same hold times.
- Scale B (as the draft writes it, starting point): The drill as the draft writes it, at your band's amount (U12: 2 × 15 s · 12–17: 3 × 20–30 s · Adult: 3 × 30–45 s · rest 30 s).
- Scale C (AI-drafted): Forearm plank with one foot lifted a few centimetres for part of each hold, switching feet; the same hold times.

### Reverse lunge (`drl_aeb2cbd5cc593d`)

- Source: research finding 2026-11-19-ppbf-home-week-six-sessions-draft.md, Day 6 item 1 (Reverse lunge)
- Purpose (lane wording): Leg strength without equipment, for a second strength day in the week.
- Setup (lane wording): Near a wall, with an arm's length of clear space all round and room for three steps, on a dry, non-slip floor. Equipment: a wall (for balance).
- Execution (draft): U12: 2 × 5 each leg, hand on wall · 12–17: 3 × 8 each leg · Adult: 3 × 10 each leg · rest 45 s / 60 s / 60 s. Step back long; front knee stays over the front foot.
- What good looks like (lane wording): A long step back; the front knee stays over the front foot on every rep.
- Cue (draft): Step back long; front knee stays over the front foot.
- Stop rule 1 (safety): Stop and tell an adult (adults: your coach) if dizzy or faint, chest pain or tightness, breathing much harder than the effort, a racing or skipping heartbeat, or sharp joint pain. Not today after any knock to the head, with a fever or feeling ill, or in a hot room. Chest pain or fainting: call 911.
- Scale A (from the draft): A hand on the wall for balance (the draft's U12 amount, and its safety line: hand on the wall if wobbly).
- Scale B (as the draft writes it, starting point): The drill as the draft writes it, at your band's amount (U12: 2 × 5 each leg, hand on wall · 12–17: 3 × 8 each leg · Adult: 3 × 10 each leg · rest 45 s / 60 s / 60 s).
- Scale C (AI-drafted): Slower lowering, 3 counts down and 1 count up, with no hand on the wall; the same reps.

### Glute bridge (`drl_cbc25e710fb3e3`)

- Source: research finding 2026-11-19-ppbf-home-week-six-sessions-draft.md, Day 6 item 3 (Glute bridge)
- Purpose (lane wording): Hip strength without equipment, for a second strength day in the week.
- Setup (lane wording): Lying on your back on the floor, knees bent, with an arm's length of clear space all round. Equipment: none.
- Execution (draft): U12: 2 × 8 · 12–17: 3 × 10 · Adult: 3 × 10 each leg (single-leg) or 3 × 15 · rest 30 s / 45 s / 45 s. Push through the heels; squeeze 2 seconds at the top.
- What good looks like (lane wording): Push through the heels and squeeze 2 seconds at the top, with the ribs down and the lower back not arched.
- Cue (draft): Push through the heels; squeeze 2 seconds at the top.
- Stop rule 1 (safety): Stop and tell an adult (adults: your coach) if dizzy or faint, chest pain or tightness, breathing much harder than the effort, a racing or skipping heartbeat, or sharp joint pain. Not today after any knock to the head, with a fever or feeling ill, or in a hot room. Chest pain or fainting: call 911.
- Scale A (AI-drafted): A smaller lift with no pause at the top; the same reps.
- Scale B (as the draft writes it, starting point): The drill as the draft writes it, at your band's amount (U12: 2 × 8 · 12–17: 3 × 10 · Adult: 3 × 10 each leg (single-leg) or 3 × 15 · rest 30 s / 45 s / 45 s).
- Scale C (from the draft): Single-leg bridge, each leg (the draft's Adult option: 3 × 10 each leg).

### Towel squeeze and wring (`drl_564171b28b3667`)

- Source: research finding 2026-11-19-ppbf-home-week-six-sessions-draft.md, Day 6 item 5 (Towel squeeze and wring)
- Purpose (lane wording): Grip and forearm strength with a towel, for a second strength day in the week.
- Setup (lane wording): A towel held in both hands. Equipment: a towel.
- Execution (draft): U12: 2 × 10 s squeeze · 12–17: 3 × (15 s squeeze + 5 wrings each way) · Adult: 3 × (20 s squeeze + 8 wrings each way) · rest 30 s. Squeeze with the whole hand; keep the wrist straight.
- What good looks like (lane wording): The whole hand squeezes and the wrist stays straight.
- Cue (draft): Squeeze with the whole hand; keep the wrist straight.
- Stop rule 1 (safety): Stop if the wrist or knuckles hurt.
- Stop rule 2 (safety): Stop and tell an adult (adults: your coach) if dizzy or faint, chest pain or tightness, breathing much harder than the effort, a racing or skipping heartbeat, or sharp joint pain. Not today after any knock to the head, with a fever or feeling ill, or in a hot room. Chest pain or fainting: call 911.
- Scale A (from the draft): Squeeze only, no wrings (the draft's U12 amount: 2 × 10 s squeeze).
- Scale B (as the draft writes it, starting point): The drill as the draft writes it, at your band's amount (U12: 2 × 10 s squeeze · 12–17: 3 × (15 s squeeze + 5 wrings each way) · Adult: 3 × (20 s squeeze + 8 wrings each way) · rest 30 s).
- Scale C (AI-drafted): Slower wrings, 3 counts each way; the same reps.

### Wall calf raise (`drl_35aac3b481205b`)

- Source: research finding 2026-11-19-ppbf-home-week-six-sessions-draft.md, Day 6 item 6 (Wall calf raise)
- Purpose (lane wording): Lower-leg strength without equipment, for a second strength day in the week.
- Setup (lane wording): Facing a wall with a hand on it, on a dry, non-slip floor. Equipment: a wall.
- Execution (draft): U12: 2 × 10 · 12–17: 3 × 12 · Adult: 3 × 15 · rest 30 s. Up for 1 count, down for 3.
- What good looks like (lane wording): Up for 1 count and down for 3, with a hand on the wall throughout.
- Cue (draft): Up for 1 count, down for 3.
- Stop rule 1 (safety): Stop and tell an adult (adults: your coach) if dizzy or faint, chest pain or tightness, breathing much harder than the effort, a racing or skipping heartbeat, or sharp joint pain. Not today after any knock to the head, with a fever or feeling ill, or in a hot room. Chest pain or fainting: call 911.
- Scale A (AI-drafted): Both hands on the wall and a smaller rise; the same reps.
- Scale B (as the draft writes it, starting point): The drill as the draft writes it, at your band's amount (U12: 2 × 10 · 12–17: 3 × 12 · Adult: 3 × 15 · rest 30 s).
- Scale C (AI-drafted): One foot at a time, a hand on the wall; the same reps each foot.

### Cue added to Shadow With an Imagined Opponent (`drl_e7587c167c1ebd`)

- New cue (the draft's Day 1 item 6 cue, word for word): Picture an opponent walking at you: punch, then step off the line.
- The drill had no cue, so it failed the cue rule and Day 1 could not be issued. It loads as a new version; only its cue and its field_labels (the cue's AI-draft label) change (OD-2026-11-15-011 ruling 3: a miss fixed by a new version). If a coach has edited this drill in the app, content import holds it (lane IG) and Overwatch reports it.

## Drills the six name whose stage tags omit youth stages (report only; no tag changed)

The track serves Y1, Y2, Y3, Y4, Y5, T1, T2, AM1, AM2, AM3, PR1, PR2, PR3, PR4, PR5, RC1, FT1, EX1. A coach decides whether to retag each drill or swap the item.

"Used in" gives Day and template ordinal: ordinal 1 is the home warm-up (its primer folded in), so the draft's item N is ordinal N+1; on Day 4, whose primer is its own step (ordinal 2), it is N+2.

| drill | name | stage_keys | omits | used in |
|---|---|---|---|---|
| `drl_0f284bce7c9171` | Shadow with direction calls | T1|T2|AM1|AM2|AM3|PR1|PR2|PR3|PR4|PR5|RC1 | Y1 Y2 Y3 Y4 Y5 FT1 EX1 | D5#6 |
| `drl_2d3741d101a571` | Dead bug, bird dog | T1|T2|AM1|AM2|AM3|PR1|PR2|PR3|PR4|PR5|RC1 | Y1 Y2 Y3 Y4 Y5 FT1 EX1 | D2#7, D4#3 |
| `drl_39ec154e04cb95` | Lateral Line Hops | T1|T2|AM1|AM2|AM3|PR1|PR2|PR3|PR4|PR5|RC1|FT1 | Y1 Y2 Y3 Y4 Y5 EX1 | D3#5 |
| `drl_5ff7db8ae359c1` | Combination 1 – 2 – pivot | T1|T2|AM1|AM2|AM3|PR1|PR2|PR3|PR4|PR5|RC1 | Y1 Y2 Y3 Y4 Y5 FT1 EX1 | D5#5 |
| `drl_6bd0ad1ffb7a50` | Shadow boxing intervals | T1|T2|AM1|AM2|AM3|PR1|PR2|PR3|PR4|PR5|RC1 | Y1 Y2 Y3 Y4 Y5 FT1 EX1 | D3#4 |
| `drl_7288d58dc1ed47` | Slow-motion cross | T1|T2|AM1|AM2|AM3|PR1|PR2|PR3|PR4|PR5|RC1 | Y1 Y2 Y3 Y4 Y5 FT1 EX1 | D1#6 |
| `drl_83057d7afff22a` | Punch Iso Hold | T1|T2|AM1|AM2|AM3|PR1|PR2|PR3|PR4|PR5|RC1|FT1 | Y1 Y2 Y3 Y4 Y5 EX1 | D6#5 |
| `drl_85a93f6757497a` | Punch Burst | T1|T2|AM1|AM2|AM3|PR1|PR2|PR3|PR4|PR5|RC1|FT1 | Y1 Y2 Y3 Y4 Y5 EX1 | D3#6, D6#5 |
| `drl_8ca8814b596907` | Push-Up Iso Hold | T1|T2|AM1|AM2|AM3|PR1|PR2|PR3|PR4|PR5|RC1|FT1 | Y1 Y2 Y3 Y4 Y5 EX1 | D6#3 |
| `drl_bbf178262859b4` | Pivot after every 2 punches | Y1|Y2 | Y3 Y4 Y5 T1 T2 AM1 AM2 AM3 PR1 PR2 PR3 PR4 PR5 RC1 FT1 EX1 | D5#5 |
| `drl_bf062f758ca6d2` | Line work | T1|T2|AM1|AM2|AM3|PR1|PR2|PR3|PR4|PR5|RC1 | Y1 Y2 Y3 Y4 Y5 FT1 EX1 | D1#4 |
| `drl_c933404c933b35` | Jab with step | T1|T2|AM1|AM2|AM3|PR1|PR2|PR3|PR4|PR5|RC1 | Y1 Y2 Y3 Y4 Y5 FT1 EX1 | D5#4 |
| `drl_d0d14430bb0ddb` | Face pulls, external rotation at multiple angles, prone Y/T/W, serratus work | T1|T2|AM1|AM2|AM3|PR1|PR2|PR3|PR4|PR5|RC1 | Y1 Y2 Y3 Y4 Y5 FT1 EX1 | D2#6 |
| `drl_d75b4c493c3c82` | Split Squat Iso Hold | T1|T2|AM1|AM2|AM3|PR1|PR2|PR3|PR4|PR5|RC1|FT1 | Y1 Y2 Y3 Y4 Y5 EX1 | D2#5 |
| `drl_eaf0e3cba383bf` | Box drill | T1|T2|AM1|AM2|AM3|PR1|PR2|PR3|PR4|PR5|RC1 | Y1 Y2 Y3 Y4 Y5 FT1 EX1 | D5#2 |
| `drl_f0156a0b5388f7` | Pivot circuit | T1|T2|AM1|AM2|AM3|PR1|PR2|PR3|PR4|PR5|RC1 | Y1 Y2 Y3 Y4 Y5 FT1 EX1 | D5#3 |
| `drl_f5d68d0b9b4be7` | Side plank variants | T1|T2|AM1|AM2|AM3|PR1|PR2|PR3|PR4|PR5|RC1 | Y1 Y2 Y3 Y4 Y5 FT1 EX1 | D4#4 |

The six name 43 library drills, warm-up and cool-down drills included: 41 linked (drill_id, or the second drill of a warm-up, cool-down or two-drill item, or the U12 alternative) and 2 related but not linked (the two partial matches). Of the 43, 17 omit youth stages, 22 have no stage tags and 4 cover every track stage.

Every step links a drill. The four new items and the two partial matches link the six drills lane HW wrote; the two partial matches still name their related library drill (bands or weights) without linking it. No existing drill's stage tags change; the one existing drill lane HW changed gains only a cue.

## Open for a coach edit (the draft's own text, carried unchanged)

- Heat: the before-every-session line says "If the room is hot, do Day 4 instead or skip the session"; the stop rule says "Not today ... in a hot room". One wording should replace both.
- The adults line ends "(P14)", a pointer to the research finding's principle list, which the app does not show.
- Day 3 breathing reset (ordinal 7) says "Breathing still hard after the cool-down: stop and tell someone"; it comes before the cool-down, and the stop rule says "an adult".
- Block words are the lane's, not the draft's: every main item takes its day's session_type, so Day 4's mobility items (open book, ankle rocks) and Day 6's tighten-and-let-go sit under `strength`, and Day 3's breathing reset under `conditioning`.
- Linked library drills whose own text goes beyond the home amounts (the item text is what the athlete does): `drl_6bd0ad1ffb7a50` Shadow boxing intervals (maximal-velocity intervals; 12–17 do no maximal efforts), `drl_5ff7db8ae359c1` Combination 1-2-pivot (shadow, bag or pads; the U12 Y1–Y2 alternative is only in details), `drl_8549299fc8d8c7` Hinge Pattern (loaded once the unloaded pattern is consistent; home is unloaded).

## Reviews

Two adversarial reviewers, fresh context, Opus, read-only; each was given the draft and this sheet (OD-2026-11-15-011).

- Reviewer 1 (fidelity to the draft; no DOC-136 text). First pass at d708e663: PASS, 5 minor findings. A script compared every template, item and the track edit with the draft: no mismatch; no added line carries a held title, held id or DOC-136 source line; the track row differs from main only in sources, details and field_labels. Minor findings: the session_refs label became INFERRED for the whole field (kept, cautious); a forced Backbone re-export would restore the held refs (stated in the PR); "(P14)", block words and the ordinal numbering (all on this sheet). Re-check at ff41d307: PASS; coach_notes is the draft's text word for word; one wording note on counts, fixed here.
- Reviewer 2 (youth safety: amounts, contact, stop rules). First pass at d708e663: FINDINGS. 1 blocking: the coach screen never shows template details, so the draft's stop rule and band lines would not reach a coach; fixed by carrying them word for word in coach_notes. Minor: the heat wording conflict, the two partial-match drills needing bands or weights (now not linked), library text beyond the home amounts, and the breathing-reset line (on this sheet as open for a coach edit). No amount, contact or band defect: U12 <= 12–17 <= Adult on every item, every item and linked drill is non-contact, and the draft's limits are all kept. Re-check at ff41d307: PASS; one wording note on counts, fixed here; coach_notes capitalises the stop rule's first letter.

Round 2, the six drills, the primer fold and the added cue (Overwatch GO: Q4 A, Q5, Q6): PENDING.
