/**
 * PF-001 "The Ring-Cutter", copied verbatim from the authored visualization
 * curriculum. THIS FILE IS SOURCE CONTENT, NOT AUTHORING: every string below
 * is the coach-approved wording, and nothing here may be rewritten, summarized
 * or extended in code. If the curriculum changes, re-copy it; do not edit the
 * prose to suit the screen.
 *
 * SOURCE DOCUMENT: Adaptive_Amateur_Boxing_Visualization_Curriculum_100_Scenarios.docx
 *   ("ADAPTIVE AMATEUR BOXING / Visualization Manual / Six Opponent Types -
 *   100 Complete Shadowboxing Fight Scenarios - Three Development Levels /
 *   Coach's Edition"), the readable Content V4.1 content bank, dated
 *   2026-09-15. The handoff also names a cleaned Content V4.1 JSON and six
 *   field guides; neither is present on this machine, so they are not used.
 *
 * WHAT THIS IS NOT: not a drill. The drill system (reference drill ->
 * operational drill -> assignment -> completion) keeps every technique,
 * safety and scaling instruction, and nothing here copies from it. A scenario
 * owns the imagined opponent, the tactical problem and the authored prompts.
 */

export const VISUALIZATION_CONTENT_SOURCE = {
  document: 'Adaptive_Amateur_Boxing_Visualization_Curriculum_100_Scenarios.docx',
  version: "Content V4.1 content bank - Six Opponent Types, 100 Complete Shadowboxing Fight Scenarios, Three Development Levels, Coach's Edition",
  dated: '2026-09-15',
} as const;

/** One authored round of the three-round arc, in the order the source prints it. */
export interface ScenarioRound {
  key: 'discover' | 'solve' | 'adapt';
  label: string;
  purpose: string;
  setup: string[];
  level1: {
    opponentAction: string;
    coachAsks: string;
    options: string[];
    coachGuidance: string;
    continueTheFight: string;
  };
  level2Cues: string;
  level3Cues: string;
  /** Rounds 1 and 2 carry one; Round 3 has none in the source. */
  cornerNote: string | null;
}

export interface VisualizationScenario {
  id: string;
  positionInFamily: string;
  title: string;
  tacticalProblem: string;
  difficulty: string;
  opponentFamily: string;
  profile: {
    subtype: string;
    stance: string;
    heightReach: string;
    preferredRange: string;
    difficulty: string;
    secondaryProblem: string;
    prerequisiteSkills: string;
  };
  beforeTheBell: string[];
  keyVisualCues: string[];
  commonMistakes: string[];
  rounds: ScenarioRound[];
  debriefQuestions: string[];
  appTags: string;
}

/**
 * The manual's front-matter rules for DELIVERING a scenario, copied verbatim.
 *
 * These matter as much as the scenario: the three levels are alternative ways
 * to run the whole three-round arc (the coach picks one for the athlete's
 * stage), not steps to walk through in a single exposure, and the lettered
 * Level 1 options are explicitly not a list to read aloud.
 */
export const MANUAL_DELIVERY_RULES = {
  "visualizationRules": [
    "No empty offense: every punch has a target, purpose, and imagined reaction.",
    "No empty defense: do not slip, roll, block, or parry punches that the athlete has not visualized.",
    "Keep continuity: the opponent does not teleport. If the boxer pivots away, the opponent must turn and reacquire them.",
    "See the cue before the answer: allow a brief beat after describing the opponent’s action so the athlete can create the picture.",
    "Finish the exchange: after scoring, defend or exit, then visually find the opponent again.",
    "The opponent learns too: by Round 2 and Round 3, the imaginary opponent changes behavior in response to what has worked."
  ],
  "deliveryLevels": [
    {
      "level": "1 — Guided",
      "coachGivesTiming": "Untimed. Full opponent action + a suggested boxer response. Pause, repeat, and rebuild the picture as needed.",
      "purpose": "Build visualization, basic recognition, and technically sound options."
    },
    {
      "level": "2 — Decision",
      "coachGivesTiming": "Untimed by default. Give the opponent action or problem; the boxer chooses the response. Use fewer explanations as skill improves.",
      "purpose": "Develop independent choices without forcing fight-speed processing."
    },
    {
      "level": "3 — Adaptive / Scored",
      "coachGivesTiming": "Timed when ready. Use short cues only—no fed solutions. Default app mode: 3 × 3-minute rounds with 1-minute breaks.",
      "purpose": "Test continuous visualization, self-management, realistic decisions, and adaptation under pace."
    }
  ],
  "level3Note": "Level 3 is not a command-response drill. Leave stretches with no cue so the boxer must keep the opponent alive in their own mind. A cue changes the fight; it does not tell the boxer what punch to throw.",
  "level1OptionsRule": "At Level 1, each round includes potential athlete responses. These are coaching resources, not a multiple-choice test and not a list the coach must read aloud. Offer options only when a beginner cannot yet generate a decision independently. If the athlete proposes a different technically sound response that fits the imagined distance and position, accept it.",
  "level1OptionsBullets": [
    "Describe the opponent action and give the athlete enough time to see it.",
    "Ask the coach question before offering answers.",
    "Offer response options only if the athlete needs help generating a decision.",
    "Explain why an option fits the tactical problem rather than simply naming a punch.",
    "Continue after mistakes: recover, reset, and keep the same opponent in the same believable location."
  ]
} as const;

export const PF001_RING_CUTTER: VisualizationScenario = {
  "id": "PF-001",
  "positionInFamily": "1 OF 17",
  "title": "The Ring-Cutter",
  "tacticalProblem": "Recognize the difference between being followed and being cut off.",
  "difficulty": "Foundation",
  "opponentFamily": "Pressure Fighter",
  "profile": {
    "subtype": "patient ring-cutter",
    "stance": "Orthodox",
    "heightReach": "similar height/reach",
    "preferredRange": "mid to close",
    "difficulty": "Foundation",
    "secondaryProblem": "Recover center before the ropes become part of the problem.",
    "prerequisiteSkills": "Balanced stance; basic jab; basic guard; forward/back/lateral steps; safe shadowboxing mechanics. Ability to move under pressure without crossing the feet."
  },
  "beforeTheBell": [
    "Picture a patient ring-cutter in a orthodox stance. The physical relationship is similar height/reach, and the opponent prefers mid to close range. He gives up a little speed to step diagonally across your escape lane before he punches. Do not reveal the adjustment yet. Let the athlete discover the first version of the opponent."
  ],
  "keyVisualCues": [
    "Lead foot crossing your escape lane.",
    "Short diagonal steps.",
    "Attack begins after space disappears."
  ],
  "commonMistakes": [
    "Circling automatically.",
    "Looking only at the gloves.",
    "Escaping the ropes without recovering center."
  ],
  "rounds": [
    {
      "key": "discover",
      "label": "Round 1 — DISCOVER",
      "purpose": "What am I fighting?",
      "setup": [
        "Build the picture slowly. He gives up a little speed to step diagonally across your escape lane before he punches. Do not name the answer yet. Let the athlete experience the pattern once, reset, and experience it again.",
        "Let the opening pattern happen twice. On the first pass, do not rescue the athlete with the answer. On the second, emphasize that lead foot crossing your escape lane. Then change one small detail so they must confirm the read rather than memorize it. Keep the visual problem specific to the ring-cutter rather than drifting into generic shadowboxing."
      ],
      "level1": {
        "opponentAction": "Lead foot crossing your escape lane; short diagonal steps; and whether attack begins after space disappears.",
        "coachAsks": "“What changed first—the feet, the shoulders, the distance, or the pace?”",
        "options": [
          "A. Use the jab as a range and information tool—touch, see the response, recover, then decide whether to add more.",
          "B. Use a short controlled step to change the distance or line without letting the feet outrun the stance.",
          "C. Hold your ground for a beat behind a compact guard or straight jab; give space only when you have a reason."
        ],
        "coachGuidance": "Several answers may be sound, but the athlete must first identify what is changing. Primary problem: Recognize the difference between being followed and being cut off. Stop the round briefly if this mistake becomes automatic: circling automatically.",
        "continueTheFight": "Continue with one exchange where the chosen answer works, one where the opponent blocks or escapes, and one where no clean score appears. Each time, the athlete must reset the picture. Preserve this cue: short diagonal steps."
      },
      "level2Cues": "Lead foot crossing your escape lane.  •  Short diagonal steps.  •  He repeats it—solve the problem.",
      "level3Cues": "He presses.  •  Lead foot crossing your escape lane.  •  Ropes getting close.  •  Short diagonal steps.",
      "cornerNote": "The athlete should now be able to describe the primary problem in their own words: Recognize the difference between being followed and being cut off. Round 2 tests whether that information can produce a sound decision."
    },
    {
      "key": "solve",
      "label": "Round 2 — SOLVE",
      "purpose": "How can I use what I discovered?",
      "setup": [
        "Use the Round 1 read instead of starting over. Primary problem: Recognize the difference between being followed and being cut off. Keep the secondary problem in view as well: Recover center before the ropes become part of the problem.",
        "Ask the athlete to create the condition they want instead of waiting for it. After one success, change the distance by half a step and see whether they still choose an appropriate tool. Keep the visual problem specific to the ring-cutter rather than drifting into generic shadowboxing."
      ],
      "level1": {
        "opponentAction": "Keep tracking this cue: lead foot crossing your escape lane. Now add this cue: attack begins after space disappears. The athlete should also know where the imagined ropes and center are before committing.",
        "coachAsks": "“Which part of the problem matters most right now: the punch, the distance, or the ring position?”",
        "options": [
          "A. Use a short controlled step to change the distance or line without letting the feet outrun the stance.",
          "B. Take a small balanced angle with the feet, make him turn or reset, and add offense only after you are stable.",
          "C. Hold your ground for a beat behind a compact guard or straight jab; give space only when you have a reason."
        ],
        "coachGuidance": "Do not reward the athlete only because the imagined counter landed. Reward a logical setup and control of the secondary problem: Recover center before the ropes become part of the problem. Correct: looking only at the gloves.",
        "continueTheFight": "After the decision, make the opponent move or answer so the athlete cannot freeze in the successful position. The sequence ends only when stance, guard, and visual contact are rebuilt. Preserve this cue: short diagonal steps."
      },
      "level2Cues": "Attack begins after space disappears.  •  He changes the timing.  •  Your first answer only partly works.",
      "level3Cues": "He pauses.  •  Same problem—different timing.  •  Attack begins after space disappears.  •  Keep the picture alive.",
      "cornerNote": "The athlete has tested a solution. Warn only that the opponent will adjust; do not reveal this in advance. Planned opponent adjustment: Once you escape twice, he starts punching during the cut instead of waiting until you reach the ropes."
    },
    {
      "key": "adapt",
      "label": "Round 3 — ADAPT",
      "purpose": "Can I solve an opponent who is now trying to solve me?",
      "setup": [
        "Give the opponent a believable adjustment. Once you escape twice, he starts punching during the cut instead of waiting until you reach the ropes. If the athlete keeps using the old answer, let them get touched lightly in the visualization and require a calm recovery.",
        "Alternate one old pattern with one new pattern. The athlete has to decide which fight is happening on each exchange rather than assuming the adjustment is permanent. Keep the visual problem specific to the ring-cutter rather than drifting into generic shadowboxing."
      ],
      "level1": {
        "opponentAction": "New priority cue: attack begins after space disappears. Keep the earlier reads in memory, but do not assume they still lead to the same follow-up.",
        "coachAsks": "“Where is your safe exit if the first idea fails?”",
        "options": [
          "A. Take a small balanced angle with the feet, make him turn or reset, and add offense only after you are stable.",
          "B. Hold your ground for one beat behind balance and defense; make him prove he can take the space before you give it.",
          "C. Use the jab as a range and information tool—touch, see the response, recover, then decide whether to add more."
        ],
        "coachGuidance": "Look for independent problem solving: see the change, choose a proportionate response, recover, and continue. Correct this without over-narrating: escaping the ropes without recovering center.",
        "continueTheFight": "Use the next exchange to test continuity: the opponent is still where the last movement put him. Do not teleport him to a convenient spot for the next cue. Preserve this cue: short diagonal steps."
      },
      "level2Cues": "He adjusts—do not solve the old problem.  •  Find him again and continue.",
      "level3Cues": "Once you escape twice, he starts punching during the cut…  •  He comes again.  •  He may return to the old pattern.  •  Solve what is actually there.",
      "cornerNote": null
    }
  ],
  "debriefQuestions": [
    "What was the first reliable cue that helped you identify this primary problem: Recognize the difference between being followed and being cut off.",
    "Which response worked because it fit the actual distance and position—not simply because it was one of the coach's options?",
    "The opponent's major adjustment was: Once you escape twice, he starts punching during the cut instead of waiting until you reach the ropes. What visual cue told you the fight had changed?",
    "If you made a mistake, did you recover stance, guard, and the opponent/ring picture without mentally restarting the entire scenario?"
  ],
  "appTags": "between, difference, foundation, mid to close, orthodox, patient ring-cutter, pressure fighter, recognize"
};
