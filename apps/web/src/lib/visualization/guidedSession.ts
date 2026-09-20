/**
 * The order a coach delivers one authored scenario in, at one delivery level.
 *
 * THE LEVELS ARE NOT STEPS. The manual's Levels 1, 2 and 3 are three ways to
 * run the WHOLE three-round arc -- Guided, Decision, Adaptive -- and the coach
 * picks the one that fits the athlete's stage ("When the athlete reaches Level
 * 3 and the coach is using short cues only..."). Walking them one after another
 * inside a single exposure would feed the athlete the answer and then pretend
 * the cue-only version came next, which is the opposite of what the levels are
 * for. So a level is chosen for the exposure, and every round is delivered at
 * that level.
 *
 * WHY THE ORDER IS DATA. Within a round the curriculum prints a fixed sequence,
 * and at Level 1 it also prints a rule for HOW to deliver it: describe the
 * opponent action and leave a beat, ask the question, and offer the lettered
 * options only if the athlete cannot decide unaided. Modelling that as data
 * lets a test pin it, and a mutation of it fail.
 *
 * NOTHING IS ADDED. Every string comes from the scenario or from the manual's
 * own delivery rules in pf001Scenario.ts. This file chooses order, grouping and
 * gating only: no prompt is rewritten, none is skipped, and none is invented to
 * fill a gap (Round 3 has no corner note, so it gets no corner segment).
 */

import { MANUAL_DELIVERY_RULES, type ScenarioRound, type VisualizationScenario } from './pf001Scenario';

/** 1 — Guided, 2 — Decision, 3 — Adaptive / Scored, as the manual names them. */
export type DeliveryLevel = 1 | 2 | 3;

export type SegmentKind =
  | 'opponent'
  | 'cues'
  | 'mistakes'
  | 'round-purpose'
  | 'opponent-action'
  | 'coach-question'
  | 'coach-guidance'
  | 'continue'
  | 'reduced-cues'
  | 'cue-only'
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

function roundSegments(round: ScenarioRound, ordinal: number, level: DeliveryLevel): SessionSegment[] {
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

  if (level === 1) {
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

  if (level === 2) {
    return [
      purpose,
      segment({
        key: `${round.key}-reduced-cues`,
        kind: 'reduced-cues',
        phase,
        title: 'Level 2 — Reduced Cues',
        body: [round.level2Cues],
        items: [],
      }),
      ...corner,
    ];
  }

  return [
    purpose,
    segment({
      key: `${round.key}-cue-only`,
      kind: 'cue-only',
      phase,
      title: 'Level 3 — Cue-Only Version',
      body: [round.level3Cues],
      items: [],
      note: MANUAL_DELIVERY_RULES.level3Note,
    }),
    ...corner,
  ];
}

/** One exposure of the whole scenario at one level, in the authored order. */
export function buildGuidedSession(scenario: VisualizationScenario, level: DeliveryLevel): SessionSegment[] {
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
    ...scenario.rounds.flatMap((round, index) => roundSegments(round, index + 1, level)),
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
