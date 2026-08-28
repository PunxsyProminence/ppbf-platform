// What each number on an athlete check-in actually means.
//
// Owner decision (2026-08-28): every wellness self-report is a 1-5 whole
// number, and "they need a description on what each number represents".
// This module is that description, and it is SHARED on purpose -- the server
// validates against it and the athlete's screen labels from it, so the anchor
// a child reads when they pick 4 is the same anchor the stored 4 means. A
// scale defined once on a screen and separately in a column is two scales.
//
// WHY 1-5 RATHER THAN THE PANEL'S 1-10. energy, soreness and focus already
// ship as `integer check (between 1 and 5)` and are live in production.
// Widening them would leave any existing row's `3` silently reinterpreted
// from three-out-of-five to three-out-of-ten -- the same laundering of a
// number's meaning that pilot_slice_postgres_session_rpe_semantics_migration
// exists to end. Narrowing the new controls to 1-5 changes no stored meaning
// and needs no ALTER on a live constrained column.
//
// DIRECTION IS RECORDED, NOT ASSUMED. Most of these read "higher is better",
// but soreness and stress do not: a 5 there is a bad day, not a good one.
// Nothing today averages or ranks these values, and this field exists so that
// whatever does it first has to look at the direction rather than assume one.
// Mixing the two silently is how an aggregate ends up saying the opposite of
// what the athletes said.
//
// NOT A READINESS SCORE. docs/design/CHECKIN_API_CONTRACT.md: "Never display
// these values on any GREEN/YELLOW/RED scale or blend them with the readiness
// board." Nothing here feeds getReadinessLevel, and the anchors are written as
// plain descriptions rather than as verdicts for that reason.

/** Which end of a scale is the good end. Recorded, never inferred. */
export type WellnessDirection = 'higher_is_better' | 'higher_is_worse';

export interface WellnessScale {
  /** The column on pilot.athlete_check_ins, and the API field name. */
  readonly key: WellnessScaleKey;
  /** The question as an athlete reads it. */
  readonly question: string;
  /** What 1, 2, 3, 4 and 5 each mean, in that order. */
  readonly anchors: readonly [string, string, string, string, string];
  readonly direction: WellnessDirection;
}

export type WellnessScaleKey =
  | 'energy'
  | 'soreness'
  | 'focus'
  | 'motivation'
  | 'hydration'
  | 'mental_clarity'
  | 'stress'
  | 'nutrition_compliance';

export const WELLNESS_SCALE_MIN = 1;
export const WELLNESS_SCALE_MAX = 5;

export const WELLNESS_SCALES: readonly WellnessScale[] = [
  {
    key: 'energy',
    question: 'How much energy do you have?',
    anchors: ['Running on empty', 'Low', 'Enough to train', 'Good', 'Full tank'],
    direction: 'higher_is_better',
  },
  {
    key: 'soreness',
    question: 'How sore are you?',
    anchors: ['Not sore', 'A little stiff', 'Noticeably sore', 'Very sore', 'Too sore to train normally'],
    direction: 'higher_is_worse',
  },
  {
    key: 'focus',
    question: 'How focused do you feel?',
    anchors: ['Scattered', 'Distracted', 'Okay', 'Sharp', 'Locked in'],
    direction: 'higher_is_better',
  },
  {
    key: 'motivation',
    question: 'How much do you want to train today?',
    anchors: ["Really don't", 'Not much', 'Neutral', 'Want to', "Can't wait"],
    direction: 'higher_is_better',
  },
  {
    key: 'hydration',
    question: 'How well have you hydrated today?',
    anchors: ['Barely drank', 'Not enough', 'Some', 'Good', 'Well hydrated'],
    direction: 'higher_is_better',
  },
  {
    key: 'mental_clarity',
    question: 'How clear is your head?',
    anchors: ['Foggy', 'Hazy', 'Okay', 'Clear', 'Very clear'],
    direction: 'higher_is_better',
  },
  {
    key: 'stress',
    question: 'How stressed do you feel?',
    anchors: ['Not stressed', 'A little', 'Some', 'Stressed', 'Very stressed'],
    direction: 'higher_is_worse',
  },
  {
    key: 'nutrition_compliance',
    question: 'How well have you eaten today?',
    anchors: ['Barely ate', 'Not great', 'Okay', 'Good', 'Ate well'],
    direction: 'higher_is_better',
  },
];

export const WELLNESS_SCALE_KEYS: readonly WellnessScaleKey[] = WELLNESS_SCALES.map((scale) => scale.key);

/** The anchor text for a stored value, or null when the value is absent or
 * out of range. Absent stays absent -- this never invents a middle. */
export function wellnessAnchor(key: WellnessScaleKey, value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const scale = WELLNESS_SCALES.find((entry) => entry.key === key);
  if (!scale || !Number.isInteger(value) || value < WELLNESS_SCALE_MIN || value > WELLNESS_SCALE_MAX) return null;
  return scale.anchors[value - WELLNESS_SCALE_MIN];
}

// Sleep is not a rating, so it is deliberately not one of the scales above:
// hours are a quantity an athlete reports, not a 1-5 judgement, and giving it
// anchors would turn a measurement into an opinion.
export const SLEEP_HOURS_MIN = 0;
export const SLEEP_HOURS_MAX = 24;
/** The control's usable span. Storage permits the full 0-24 above; this is
 * only what the slider offers, and it is not a validation bound. */
export const SLEEP_HOURS_TYPICAL_MIN = 4;
export const SLEEP_HOURS_TYPICAL_MAX = 12;
