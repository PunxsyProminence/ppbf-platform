/**
 * THE ADULT PATHWAY — four stages an adult boxer may move through.
 *
 * Owner decision (Jason, 2026-10-03, asked in the adult-pathway lane): stage
 * names Foundation / Intermediate / Advanced / Elite "Use as-is"; goals and
 * caveat wording "Approve", each goal "ticked only by a coach"; stage is
 * "Coach-set". Source material: the elite-boxing research synthesis
 * (overwatch lane-inbox file dated 2026-10-04; adult scope; youth out of scope
 * until a separate youth pass).
 *
 * THREE RULES THIS FILE OBEYS
 *
 * 1. ADULTS ONLY. The synthesis this comes from is scoped to healthy adults.
 *    Nothing here is shown for, or applied to, a minor.
 *
 * 2. TIME RANGES ARE ROUGH ESTIMATES. The synthesis tags every timeline
 *    [AI-H] — an uncited heuristic. They are stored as ranges and always shown
 *    beside ADULT_PATHWAY_CAVEAT, never as a single number or a due date.
 *
 * 3. NOTHING HERE PROMOTES ANYONE. A stage holds no hours, sessions, levels,
 *    dates or thresholds, so nothing can compute "this athlete is now
 *    Intermediate" from it. Each goal is a checkpoint a coach confirms; a coach
 *    decides when a stage is reached. adultPathwayStages.test.ts fails if a
 *    stage or goal gains a field outside the allowed set.
 */

export const ADULT_PATHWAY_CAVEAT =
  'These time ranges are rough estimates, not research-backed. Everyone moves at their own pace; '
  + 'a coach decides when a stage is reached.';

export const ADULT_PATHWAY_SCOPE = 'For adult members only. Youth athletes are not placed on this pathway.';

export const ADULT_PATHWAY_STAGE_KEYS = ['foundation', 'intermediate', 'advanced', 'elite'] as const;
export type AdultPathwayStageKey = (typeof ADULT_PATHWAY_STAGE_KEYS)[number];

export interface AdultPathwayGoal {
  /** Stable key, so a coach's confirmation can name the goal it confirms. */
  readonly key: string;
  readonly text: string;
}

export interface AdultPathwayStage {
  readonly key: AdultPathwayStageKey;
  readonly name: string;
  /** A rough range in plain words. Never a single number, never a date. */
  readonly typicalRange: string;
  readonly goals: readonly AdultPathwayGoal[];
}

export const ADULT_PATHWAY_STAGES: readonly AdultPathwayStage[] = [
  {
    key: 'foundation',
    name: 'Foundation',
    typicalRange: 'About the first 12 to 18 months',
    goals: [
      { key: 'stance_guard', text: 'Stance and guard' },
      { key: 'footwork', text: 'Footwork' },
      { key: 'straight_punches', text: 'Straight punches' },
      { key: 'basic_defence', text: 'Basic defence (block, parry, slip, roll)' },
      { key: 'aerobic_base', text: 'Aerobic base' },
      { key: 'controlled_touch_sparring', text: 'Controlled touch sparring after defence is solid' },
    ],
  },
  {
    key: 'intermediate',
    name: 'Intermediate',
    typicalRange: 'About 1.5 to 3 or more years',
    goals: [
      { key: 'hooks_uppercuts_combinations', text: 'Hooks, uppercuts, combinations' },
      { key: 'distance_timing', text: 'Distance and timing' },
      { key: 'strength_then_power', text: 'Strength then power blocks' },
      { key: 'hard_sparring_weekly', text: 'Hard sparring kept to about once a week' },
    ],
  },
  {
    key: 'advanced',
    name: 'Advanced',
    typicalRange: 'About 3 to 6 or more years',
    goals: [
      { key: 'own_style', text: 'Own style' },
      { key: 'film_study', text: 'Film study' },
      { key: 'planned_strength_conditioning', text: 'Planned strength and conditioning' },
    ],
  },
  {
    key: 'elite',
    name: 'Elite',
    typicalRange: 'About 6 to 10 or more years, and not guaranteed',
    goals: [
      { key: 'elite_competition', text: 'Competing at elite level — not guaranteed for anyone' },
    ],
  },
];

export function isAdultPathwayStageKey(value: unknown): value is AdultPathwayStageKey {
  return typeof value === 'string' && (ADULT_PATHWAY_STAGE_KEYS as readonly string[]).includes(value);
}

export function adultPathwayStage(key: AdultPathwayStageKey): AdultPathwayStage {
  const stage = ADULT_PATHWAY_STAGES.find((s) => s.key === key);
  if (!stage) throw new Error(`Unknown adult pathway stage: ${key}`);
  return stage;
}
