import { query, withTransaction } from './db';
import { ValidationError } from './errors';

// The bars the learning loop's evaluators read (lane L49). Jason 2026-10-18,
// Q3 "Needs to be backed by research", then his approval of the threshold
// research (Documents\PPBF-overwatch\research\HABIT-AND-LESSON-THRESHOLDS-
// 2026-10-18.md, sections 1-8; picks "A: Adopt as written", "A: Those three",
// "A: Not until calibrated"). Three kinds:
//   pattern_formation     when a behaviour is emerging, a pattern, established
//   athlete_lesson        when a lesson improved, likely worked, worked
//   observer_calibration  when a coach pair's reports are trusted to count
// A bar is stored only with its cited sources, and only a gym admin's
// ratification puts one in force (the working default, pending Overwatch's
// confirmation with Jason). Each version keeps who signed which numbers, when,
// on what evidence; a new version supersedes the last rather than editing it.
// The approved numbers are in learningPolicyApprovedV1.ts, waiting to be
// ratified; nothing here applies them.

export const POLICY_KINDS = ['pattern_formation', 'athlete_lesson', 'observer_calibration'] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];

export const PATTERN_TIERS = ['emerging', 'pattern', 'established'] as const;
export type PatternTier = (typeof PATTERN_TIERS)[number];

export const LESSON_LABELS = ['improved_after', 'likely_worked', 'worked_replicated'] as const;
export type LessonLabel = (typeof LESSON_LABELS)[number];

export interface PatternTierBar {
  /** Sessions with a coded chance (present or absent), one data point each (P1). */
  minimumSessions: number;
  /** Coded chances in all, misses counted (P2). */
  minimumCodedChances: number;
  /** Share of coded chances where the behaviour showed, 0-1 (P2). */
  minimumShare: number;
  /** Distinct contexts (drill, bag, pads, sparring); 1 = context-specific (P3). */
  minimumContexts: number;
  /** First-to-last day span of the evidence (P4). */
  minimumSpanDays: number;
  /** Who must have seen it (P5): coaches, or a double-coded share in their place, or sessions per coach. */
  observers: {
    minimumCoaches: number;
    orDoubleCodedShare: number | null;
    minimumSessionsPerCoach: number | null;
    agreementRequired: boolean;
  };
  /** The pattern lapses when this many latest coded chances in a row all missed (P6). */
  lapseAfterMisses: number;
}

export interface PatternFormationBar {
  /** Evidence older than this stops counting as current (P4). */
  currentWithinDays: number;
  tiers: Record<PatternTier, PatternTierBar>;
}

export interface AthleteLessonBar {
  /** Points before the lesson (W1) and after it (W2). */
  baselinePoints: number;
  afterPoints: number;
  /** The effect rule on the numbers (W4). */
  effectRule: { method: 'conservative_dual_criterion'; shiftSd: number; alpha: number; immediacyFirstPoints: number };
  /** Baseline already improving: its trend screen (W6). */
  baselineTrendScreenMaxNap: number;
  /** The lesson was delivered as planned before anything is credited to it (W6). */
  requireDeliveryRecorded: boolean;
  /** The first delayed probe: at least this long after, within this many days (C1). */
  delayedProbe: { minimumHours: number; withinDays: number };
  /** Demonstrations each label needs, and whether staggered starts and the probe are required (W3). */
  labels: Record<LessonLabel, { demonstrations: number; staggered: boolean; delayedProbe: boolean }>;
  /** Follow-up re-checks after a lesson, in weeks (C2); passing them all counts it stuck (C5). */
  followUpWeeks: number[];
  /** Regression: this many coded chances in a row back inside the baseline range (C3). */
  regressionAfterConsecutive: number;
  /** A re-check is due after this many days away (C4). */
  recheckAfterAbsenceDays: number;
}

export interface ObserverCalibrationBar {
  /** Per behaviour, per coach pair (R1). */
  minimumAgreement: number;
  minimumKappa: number;
  /** Paired judgments before the figure is trusted (R2). */
  minimumPairedJudgments: number;
  /** Ongoing double-coded share of sessions (R3). */
  ongoingDoubleCodedShare: number;
  /** A pair below the bar (R4) and a pair never calibrated (Jason 2026-10-18, 3A): visible, building nothing. */
  belowBar: 'stop_counting';
  uncalibrated: 'unverified';
}

export type LearningBar = PatternFormationBar | AthleteLessonBar | ObserverCalibrationBar;

export interface Citation {
  source: string;
  note?: string;
}

export interface LearningPolicyRow {
  policy_id: string;
  policy_kind: PolicyKind;
  version: number;
  parameters: LearningBar;
  citations: Citation[];
  ratified_by_account_id: string;
  ratified_by_role: string;
  ratified_at: string;
  status: 'active' | 'superseded';
  supersedes_policy_id: string | null;
}

const MAX_CITATIONS = 20;

/** The cited sources, each naming one; refused with the reason otherwise. */
export function citationsFrom(raw: unknown): Citation[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ValidationError('A bar needs at least one cited source.');
  }
  if (raw.length > MAX_CITATIONS) throw new ValidationError(`A bar cites at most ${MAX_CITATIONS} sources.`);
  return raw.map((item) => {
    const source = typeof item?.source === 'string' ? item.source.trim() : '';
    if (!source || source.length > 500) {
      throw new ValidationError('Each citation names its source, in at most 500 characters.');
    }
    if (item.note !== undefined && (typeof item.note !== 'string' || item.note.length > 1000)) {
      throw new ValidationError('A citation note is text of at most 1000 characters.');
    }
    return item.note ? { source, note: item.note.trim() } : { source };
  });
}

// ── shape checks: exact keys, and each value of its kind ────────────────────

type Check = (value: unknown, at: string) => void;

function fail(at: string, what: string): never {
  throw new ValidationError(`${at} must be ${what}.`);
}

const wholeAtLeast = (minimum: number): Check => (value, at) => {
  if (!Number.isInteger(value) || (value as number) < minimum) fail(at, `a whole number of at least ${minimum}`);
};
const positive: Check = (value, at) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) fail(at, 'a positive number');
};
const share: Check = (value, at) => {
  if (typeof value !== 'number' || !(value > 0 && value <= 1)) fail(at, 'a share above 0 and at most 1');
};
const shareOrNull: Check = (value, at) => {
  if (value !== null) share(value, at);
};
const wholeOrNull: Check = (value, at) => {
  if (value !== null) wholeAtLeast(1)(value, at);
};
const flag: Check = (value, at) => {
  if (typeof value !== 'boolean') fail(at, 'true or false');
};
const literal = (expected: string): Check => (value, at) => {
  if (value !== expected) fail(at, `'${expected}'`);
};

function object(spec: Record<string, Check>): Check {
  return (value, at) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(at, 'an object');
    const given = Object.keys(value as object);
    const expected = Object.keys(spec);
    const missing = expected.filter((key) => !given.includes(key));
    const extra = given.filter((key) => !expected.includes(key));
    if (missing.length > 0 || extra.length > 0) {
      fail(at, `exactly ${expected.join(', ')}`
        + (missing.length > 0 ? ` (missing ${missing.join(', ')})` : '')
        + (extra.length > 0 ? ` (not a field: ${extra.join(', ')})` : ''));
    }
    for (const key of expected) spec[key]((value as Record<string, unknown>)[key], `${at}.${key}`);
  };
}

const ascendingWeeks: Check = (value, at) => {
  if (!Array.isArray(value) || value.length === 0) fail(at, 'a list of weeks');
  (value as unknown[]).forEach((week, index) => wholeAtLeast(1)(week, `${at}[${index}]`));
  const weeks = value as number[];
  if (weeks.some((week, index) => index > 0 && week <= weeks[index - 1])) fail(at, 'weeks in rising order');
};

const TIER: Check = object({
  minimumSessions: wholeAtLeast(1),
  minimumCodedChances: wholeAtLeast(1),
  minimumShare: share,
  minimumContexts: wholeAtLeast(1),
  minimumSpanDays: wholeAtLeast(0),
  observers: object({
    minimumCoaches: wholeAtLeast(1),
    orDoubleCodedShare: shareOrNull,
    minimumSessionsPerCoach: wholeOrNull,
    agreementRequired: flag,
  }),
  lapseAfterMisses: wholeAtLeast(1),
});

const SHAPES: Record<PolicyKind, Check> = {
  pattern_formation: object({
    currentWithinDays: wholeAtLeast(1),
    tiers: object(Object.fromEntries(PATTERN_TIERS.map((tier) => [tier, TIER]))),
  }),
  athlete_lesson: object({
    baselinePoints: wholeAtLeast(1),
    afterPoints: wholeAtLeast(1),
    effectRule: object({
      method: literal('conservative_dual_criterion'),
      shiftSd: positive,
      alpha: share,
      immediacyFirstPoints: wholeAtLeast(1),
    }),
    baselineTrendScreenMaxNap: share,
    requireDeliveryRecorded: flag,
    delayedProbe: object({ minimumHours: wholeAtLeast(1), withinDays: wholeAtLeast(1) }),
    labels: object(Object.fromEntries(LESSON_LABELS.map((label) => [
      label, object({ demonstrations: wholeAtLeast(1), staggered: flag, delayedProbe: flag }),
    ]))),
    followUpWeeks: ascendingWeeks,
    regressionAfterConsecutive: wholeAtLeast(1),
    recheckAfterAbsenceDays: wholeAtLeast(1),
  }),
  observer_calibration: object({
    minimumAgreement: share,
    minimumKappa: share,
    minimumPairedJudgments: wholeAtLeast(2),
    ongoingDoubleCodedShare: share,
    belowBar: literal('stop_counting'),
    uncalibrated: literal('unverified'),
  }),
};

/** Each harder tier asks at least as much as the one below it, and lapses no slower. */
function assertTiersRise(bar: PatternFormationBar): void {
  const rising: (keyof PatternTierBar)[] = [
    'minimumSessions', 'minimumCodedChances', 'minimumShare', 'minimumContexts', 'minimumSpanDays',
  ];
  for (let index = 1; index < PATTERN_TIERS.length; index += 1) {
    const lower = bar.tiers[PATTERN_TIERS[index - 1]];
    const higher = bar.tiers[PATTERN_TIERS[index]];
    for (const field of rising) {
      if ((higher[field] as number) < (lower[field] as number)) {
        fail(`tiers.${PATTERN_TIERS[index]}.${field}`, `at least the ${PATTERN_TIERS[index - 1]} tier's`);
      }
    }
    if (higher.lapseAfterMisses > lower.lapseAfterMisses) {
      fail(`tiers.${PATTERN_TIERS[index]}.lapseAfterMisses`, `at most the ${PATTERN_TIERS[index - 1]} tier's`);
    }
  }
}

/** Each stronger label needs more demonstrations than the one below it. */
function assertLabelsRise(bar: AthleteLessonBar): void {
  for (let index = 1; index < LESSON_LABELS.length; index += 1) {
    if (bar.labels[LESSON_LABELS[index]].demonstrations <= bar.labels[LESSON_LABELS[index - 1]].demonstrations) {
      fail(`labels.${LESSON_LABELS[index]}.demonstrations`, `more than ${LESSON_LABELS[index - 1]}'s`);
    }
  }
}

/** The bar exactly as its kind is shaped, with its tiers and labels in order; refused with the reason. */
export function barFor(kind: PolicyKind, raw: unknown): LearningBar {
  SHAPES[kind](raw, 'parameters');
  if (kind === 'pattern_formation') assertTiersRise(raw as PatternFormationBar);
  if (kind === 'athlete_lesson') assertLabelsRise(raw as AthleteLessonBar);
  return raw as LearningBar;
}

const FIELDS = `policy_id, policy_kind, version, parameters, citations, ratified_by_account_id, ratified_by_role,
  ratified_at, status, supersedes_policy_id`;

/** Every version of every bar this gym has ratified, newest first per kind. */
export async function listLearningPolicies(organizationId: string): Promise<LearningPolicyRow[]> {
  return query<LearningPolicyRow>(
    `select ${FIELDS} from pilot.learning_policies
      where organization_id = $1
      order by policy_kind, version desc`,
    [organizationId],
  );
}

export async function ratifyLearningPolicy(input: {
  organizationId: string;
  kind: string;
  parameters: unknown;
  citations: unknown;
  ratifiedByAccountId: string;
  ratifiedByRole: string;
}): Promise<LearningPolicyRow> {
  if (!(POLICY_KINDS as readonly string[]).includes(input.kind)) {
    throw new ValidationError(`kind must be one of: ${POLICY_KINDS.join(', ')}.`);
  }
  const kind = input.kind as PolicyKind;
  const parameters = barFor(kind, input.parameters);
  const citations = citationsFrom(input.citations);
  try {
    return await withTransaction(async (client) => {
      // The latest version of this kind, locked: two admins saving at once
      // cannot both build on it.
      const latest = await client.query<{ policy_id: string; version: number; status: string }>(
        `select policy_id, version, status from pilot.learning_policies
          where organization_id = $1 and policy_kind = $2
          order by version desc limit 1
          for update`,
        [input.organizationId, kind],
      );
      const previous = latest.rows[0] ?? null;
      if (previous?.status === 'active') {
        await client.query(
          `update pilot.learning_policies set status = 'superseded'
            where organization_id = $1 and policy_id = $2 and status = 'active'`,
          [input.organizationId, previous.policy_id],
        );
      }
      const inserted = await client.query<LearningPolicyRow>(
        `insert into pilot.learning_policies
           (organization_id, policy_kind, version, parameters, citations, ratified_by_account_id,
            ratified_by_role, supersedes_policy_id)
         values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)
         returning ${FIELDS}`,
        [
          input.organizationId, kind, (previous?.version ?? 0) + 1, JSON.stringify(parameters),
          JSON.stringify(citations), input.ratifiedByAccountId, input.ratifiedByRole, previous?.policy_id ?? null,
        ],
      );
      return inserted.rows[0];
    });
  } catch (error) {
    const pgError = error as { code?: string; constraint?: string };
    if (pgError.code === '23505') {
      throw new ValidationError('The bar was just changed by someone else. Reload and try again.');
    }
    if (pgError.code === '23514' && pgError.constraint === 'pilot_learning_policies_ratifier_of_this_gym') {
      throw new ValidationError('Only an admin of this gym can ratify a bar.');
    }
    if (pgError.code === '23514' && pgError.constraint === 'pilot_learning_policies_citation_source') {
      throw new ValidationError('Each citation names its source.');
    }
    throw error;
  }
}
