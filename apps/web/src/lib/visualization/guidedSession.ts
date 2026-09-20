/**
 * The order a coach delivers one authored scenario in, as a LEVEL 1 GUIDED
 * exposure. That is the whole of what VIZ-1 runs.
 *
 * WHY ONLY LEVEL 1. The manual describes three delivery modes for the whole
 * three-round arc -- 1 Guided, 2 Decision, 3 Adaptive/Scored -- and they are
 * modes, not stages to climb inside one session. VIZ-1's authorized product
 * unit is the guided one: the coach describes the opponent action, leaves a
 * beat, asks the authored question, and offers the lettered options only if the
 * athlete cannot decide unaided.
 *
 * Levels 2 and 3 are NOT implemented here, and this file does not pretend to
 * choose between modes it cannot deliver. Their wording stays in
 * pf001Scenario.ts as source material -- `level2Cues`, `level3Cues`,
 * `deliveryLevels`, `level3Note` -- so the source document is preserved whole
 * and a later slice can build them. Level 3 in particular the manual defines as
 * timed and scored, and VIZ-1 implements neither, so offering it as a runnable
 * choice would have promised behaviour that does not exist.
 *
 * WHY THE ORDER IS DATA. Within a round the curriculum prints a fixed sequence,
 * and it also prints a rule for HOW to deliver it. Modelling that as data lets a
 * test pin it, and a mutation of it fail.
 *
 * NO AUTHORED PROSE IS ADDED OR REWRITTEN. Every `body`, `items`, `note` and
 * `onRequest` string comes from the scenario or from the manual's own delivery
 * rules in pf001Scenario.ts: none is rewritten, none is skipped, and none is
 * invented to fill a gap (Round 3 has no corner note, so it gets no corner
 * segment).
 *
 * WHAT THIS FILE DOES WRITE, and it is worth being exact because the page reads
 * `title` out loud as the prompt: the structural labels. `title` on the
 * non-authored steps ("The opponent acts", "Ask the athlete", "Coach guidance",
 * "Continue the fight", "Corner note", "Key visual cues", "Common athlete
 * mistakes", "Session complete"), `phase` ("Before the bell", "Round 1 of 3 —
 * DISCOVER", "Debrief") and `onRequest.label` ("Offer the response options").
 * The source labels its own steps differently -- "Opponent action / visual
 * problem:", "Round 1 — DISCOVER" -- so these are this file's wording, chosen to
 * be read aloud on a gym floor. Round purposes, cues, mistakes and debrief
 * questions ARE authored and are passed through untouched.
 */

import { MANUAL_DELIVERY_RULES, type ScenarioRound, type VisualizationScenario } from './pf001Scenario';

export type SegmentKind =
  | 'opponent'
  | 'cues'
  | 'mistakes'
  | 'round-purpose'
  | 'opponent-action'
  | 'coach-question'
  | 'coach-guidance'
  | 'continue'
  | 'corner'
  | 'debrief'
  | 'complete';

/** Authored material the coach reveals only if the athlete needs it. */
export interface OnRequest {
  label: string;
  /** The manual's rule for offering this, verbatim. */
  rule: string;
  ruleBullets: string[];
  items: string[];
}

export interface SessionSegment {
  /**
   * Unique within one exposure: a round yields purpose, action, question,
   * guidance, continue and (where the source has one) a corner note. It is what
   * tracks whether the coach asked for that round's options, and what the order
   * tests pin.
   */
  key: string;
  kind: SegmentKind;
  /** Where the coach is: "Before the bell", "Round 1 of 3 — DISCOVER", "Debrief". */
  phase: string;
  title: string;
  /** The authored prose to deliver, paragraph by paragraph. */
  body: string[];
  /** Authored list items (cues, mistakes, debrief questions). */
  items: string[];
  /** An authored delivery rule that applies to this step. */
  note: string | null;
  /** Authored help, hidden until the coach asks for it. */
  onRequest: OnRequest | null;
}

const PHASE_BEFORE = 'Before the bell';
const PHASE_DEBRIEF = 'Debrief';

/** "See the cue before the answer..." -- the rule that governs the action step. */
const BEAT_RULE =
  MANUAL_DELIVERY_RULES.visualizationRules.find((rule) => rule.startsWith('See the cue before the answer'))
  ?? null;

function segment(partial: Omit<SessionSegment, 'note' | 'onRequest'> & Partial<Pick<SessionSegment, 'note' | 'onRequest'>>): SessionSegment {
  return { note: null, onRequest: null, ...partial };
}

function roundSegments(round: ScenarioRound, ordinal: number): SessionSegment[] {
  const phase = `Round ${ordinal} of 3 — ${round.label.replace(/^Round \d+ — /, '')}`;
  const purpose = segment({
    key: `${round.key}-purpose`,
    kind: 'round-purpose',
    phase,
    title: round.purpose,
    body: round.setup,
    items: [],
  });

  const corner = round.cornerNote
    ? [segment({ key: `${round.key}-corner`, kind: 'corner', phase, title: 'Corner note', body: [round.cornerNote], items: [] })]
    : [];

  return [
    purpose,
    segment({
      key: `${round.key}-action`,
      kind: 'opponent-action',
      phase,
      title: 'The opponent acts',
      body: [round.level1.opponentAction],
      items: [],
      note: BEAT_RULE,
    }),
    segment({
      key: `${round.key}-question`,
      kind: 'coach-question',
      phase,
      title: 'Ask the athlete',
      body: [round.level1.coachAsks],
      items: [],
      // The options are coaching resources, not a script: the manual says so
      // in these words, so they stay behind the coach's own decision to use them.
      onRequest: {
        label: 'Offer the response options',
        rule: MANUAL_DELIVERY_RULES.level1OptionsRule,
        ruleBullets: [...MANUAL_DELIVERY_RULES.level1OptionsBullets],
        items: round.level1.options,
      },
    }),
    segment({
      key: `${round.key}-guidance`,
      kind: 'coach-guidance',
      phase,
      title: 'Coach guidance',
      body: [round.level1.coachGuidance],
      items: [],
    }),
    segment({
      key: `${round.key}-continue`,
      kind: 'continue',
      phase,
      title: 'Continue the fight',
      body: [round.level1.continueTheFight],
      items: [],
    }),
    ...corner,
  ];
}

/**
 * One Level 1 Guided exposure of the whole scenario, in the authored order.
 *
 * There is no level parameter, on purpose: VIZ-1 delivers the guided mode and
 * nothing else, and a parameter whose other values are unimplemented would be a
 * promise the code cannot keep.
 */
export function buildGuidedSession(scenario: VisualizationScenario): SessionSegment[] {
  return [
    segment({
      key: 'before-the-bell',
      kind: 'opponent',
      phase: PHASE_BEFORE,
      title: 'Before the Bell — Build the Opponent',
      body: scenario.beforeTheBell,
      items: [],
    }),
    segment({
      key: 'key-visual-cues',
      kind: 'cues',
      phase: PHASE_BEFORE,
      title: 'Key visual cues',
      body: [],
      items: scenario.keyVisualCues,
    }),
    segment({
      key: 'common-mistakes',
      kind: 'mistakes',
      phase: PHASE_BEFORE,
      title: 'Common athlete mistakes',
      body: [],
      items: scenario.commonMistakes,
    }),
    ...scenario.rounds.flatMap((round, index) => roundSegments(round, index + 1)),
    segment({
      key: 'debrief',
      kind: 'debrief',
      phase: PHASE_DEBRIEF,
      title: 'Post-Fight Debrief',
      body: [],
      items: scenario.debriefQuestions,
    }),
    segment({
      key: 'complete',
      kind: 'complete',
      phase: PHASE_DEBRIEF,
      title: 'Session complete',
      body: [],
      items: [],
    }),
  ];
}
