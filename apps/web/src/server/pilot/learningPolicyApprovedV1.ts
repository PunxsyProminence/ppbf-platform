import type {
  AthleteLessonBar,
  Citation,
  ObserverCalibrationBar,
  PatternFormationBar,
} from './learningPolicies';

// The first bars Jason approved (2026-10-18), relayed by Overwatch: the
// threshold research at Documents\PPBF-overwatch\research\HABIT-AND-LESSON-
// THRESHOLDS-2026-10-18.md, sections 1-8, with his picks
//   1 "A: Adopt as written (Rec.)"   Emerging / Pattern / Established = the
//                                    minimum / default / strict columns
//   2 "A: Those three (Rec.)"        Improved after lesson / Likely worked /
//                                    Worked, replicated
//   3 "A: Not until calibrated (Rec.)"
// Row ids (P1-P6, W1-W6, R1-R4, C1-C5) are the report's section 1 table.
//
// NOTHING HERE IS IN FORCE. These are the payloads a gym admin ratifies through
// /api/pilot/admin/learning-policies; until then the evaluators read no bar and
// abstain. The report is a RESEARCH DRAFT: the citations below name what each
// number leans on, and no study figure may be quoted in app copy without
// re-opening the source (report section 9).

export const APPROVED_PATTERN_FORMATION_V1: PatternFormationBar = {
  currentWithinDays: 84, // P4: evidence older than 12 weeks drops out of "current"
  tiers: {
    emerging: {
      minimumSessions: 3, // P1 minimum
      minimumCodedChances: 5, // P2 minimum
      minimumShare: 0.8,
      minimumContexts: 1, // P3 minimum: shown as context-specific
      minimumSpanDays: 7, // P4 minimum
      observers: { minimumCoaches: 1, orDoubleCodedShare: null, minimumSessionsPerCoach: null, agreementRequired: false }, // P5 minimum: flagged "single observer"
      lapseAfterMisses: 5, // P6 minimum
    },
    pattern: {
      minimumSessions: 5, // P1 default
      minimumCodedChances: 8, // P2 default
      minimumShare: 0.8,
      minimumContexts: 2, // P3 default
      minimumSpanDays: 14, // P4 default
      observers: { minimumCoaches: 2, orDoubleCodedShare: 0.2, minimumSessionsPerCoach: null, agreementRequired: true }, // P5 default
      lapseAfterMisses: 3, // P6 default
    },
    established: {
      minimumSessions: 7, // P1 strict
      minimumCodedChances: 12, // P2 strict
      minimumShare: 0.9,
      minimumContexts: 3, // P3 strict
      minimumSpanDays: 28, // P4 strict
      observers: { minimumCoaches: 2, orDoubleCodedShare: null, minimumSessionsPerCoach: 3, agreementRequired: true }, // P5 strict
      lapseAfterMisses: 2, // P6 strict
    },
  },
};

export const APPROVED_ATHLETE_LESSON_V1: AthleteLessonBar = {
  baselinePoints: 5, // W1 default
  afterPoints: 5, // W2 default
  effectRule: { method: 'conservative_dual_criterion', shiftSd: 0.25, alpha: 0.05, immediacyFirstPoints: 3 }, // W4 default
  baselineTrendScreenMaxNap: 0.85, // W6 default
  requireDeliveryRecorded: true, // W6 default: delivery tick-box
  delayedProbe: { minimumHours: 24, withinDays: 7 }, // C1 default
  labels: {
    improved_after: { demonstrations: 1, staggered: false, delayedProbe: false }, // W3 minimum, decision 2
    likely_worked: { demonstrations: 2, staggered: true, delayedProbe: true }, // W3 default, decision 2
    // W3 strict, decision 2. Staggered starts and the probe carry up from
    // likely_worked: a stronger label keeps the weaker one's conditions.
    worked_replicated: { demonstrations: 3, staggered: true, delayedProbe: true },
  },
  followUpWeeks: [1, 4, 12], // C2 default; passing all three = stuck (C5 default)
  regressionAfterConsecutive: 3, // C3 default
  recheckAfterAbsenceDays: 14, // C4 default (injury return, new weight class, new coach are events, not numbers)
};

export const APPROVED_OBSERVER_CALIBRATION_V1: ObserverCalibrationBar = {
  minimumAgreement: 0.8, // R1 default, with kappa
  minimumKappa: 0.6,
  minimumPairedJudgments: 30, // R2 default
  ongoingDoubleCodedShare: 0.2, // R3 default
  belowBar: 'stop_counting', // R4 default
  uncalibrated: 'unverified', // decision 3
};

const REPORT: Citation = {
  source: 'PPBF research draft: Evidence for the behaviour-pattern engine thresholds (2026-10-18), '
    + 'Documents/PPBF-overwatch/research/HABIT-AND-LESSON-THRESHOLDS-2026-10-18.md; approved by Jason 2026-10-18',
  note: 'Sections 1-8; most numbers are professional conventions or PPBF design choices, as the report says.',
};

const WWC_2010: Citation = {
  source: 'Kratochwill, T. R., et al. (2010). Single-case designs technical documentation (Version 1.0, Pilot). What Works Clearinghouse, IES.',
};
const WWC_2022: Citation = {
  source: 'What Works Clearinghouse (2022). Procedures and Standards Handbook, Version 5.0, Chapter VI. IES/NCEE.',
};
const HORNER_2005: Citation = {
  source: 'Horner, R. H., et al. (2005). The use of single-subject research to identify evidence-based practice in special education. Exceptional Children, 71(2), 165-179.',
};

export const APPROVED_CITATIONS_V1 = {
  pattern_formation: [
    REPORT,
    { ...WWC_2010, note: 'P1, P5, P6' },
    { ...WWC_2022, note: 'P1, P5' },
    { ...HORNER_2005, note: 'P1, P3' },
    {
      source: 'Lally, P., et al. (2010). How are habits formed: Modelling habit formation in the real world. European Journal of Social Psychology, 40(6), 998-1009.',
      note: 'P4 timing (secondary-level in the report)',
    },
  ],
  athlete_lesson: [
    REPORT,
    { ...WWC_2010, note: 'W3' },
    { ...WWC_2022, note: 'W1, W2, W3, W6' },
    { ...HORNER_2005, note: 'W1, W3, W6' },
    {
      source: 'Fisher, W. W., Kelley, M. E., & Lomas, J. E. (2003). Visual aids and structured criteria for improving visual inspection and interpretation of single-case designs. Journal of Applied Behavior Analysis, 36(3), 387-406.',
      note: 'W4 conservative dual-criterion (abstract-level in the report)',
    },
    {
      source: 'Kantak, S. S., & Winstein, C. J. (2012). Learning-performance distinction and memory processes for motor skills. Behavioural Brain Research, 228(1), 219-231.',
      note: 'C1 (abstract-level)',
    },
    {
      source: 'Cepeda, N. J., et al. (2008). Spacing effects in learning: A temporal ridgeline of optimal retention. Psychological Science, 19(11), 1095-1102.',
      note: 'C2 shape (abstract-level)',
    },
  ],
  observer_calibration: [
    REPORT,
    { ...WWC_2022, note: 'R1, R3, R4' },
    { ...HORNER_2005, note: 'R1, R3' },
    {
      source: 'McHugh, M. L. (2012). Interrater reliability: the kappa statistic. Biochemia Medica, 22(3), 276-282.',
      note: 'R1, R2 (re-check against the page before quoting)',
    },
  ],
} satisfies Record<string, Citation[]>;
