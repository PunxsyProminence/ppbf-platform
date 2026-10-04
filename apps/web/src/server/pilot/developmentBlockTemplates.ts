import { type ActorIdentity, assertActorCanAccessAthlete } from './access';
import { queryOne } from './db';
import { isMinor } from './wallDisplay';

// Development block TEMPLATES: optional starting text a coach can pick when
// writing a block, then edit. Owner decision 2026-10-04 (Jason, map item 22):
// templates a coach chooses lift the earlier "no periodization label / never
// autocompleted" refusal; %1RM ranges may be shown, labelled [AI-H]; minors are
// hidden by default and a coach may opt in per athlete with an unsaved
// checkbox.
//
// WHAT THIS DOES NOT DO. Nothing here is stored. Picking a template fills the
// create form on /coach/development-blocks; what is saved is whatever the coach
// left in the title and emphasis boxes, through the ordinary block write. The
// app never picks a template, never infers one from dates, and computes no load
// for any athlete -- the %1RM figures are fixed text, not numbers derived from
// anyone's lifts.
//
// EVIDENCE LABELS, from the elite-boxing research synthesis (2026-10-04, AI
// generated, owner review pending): [SR/MA] systematic review / meta-analysis,
// [PS] primary study, [AI-H] AI heuristic, uncited. Every set, rep, %1RM and
// week count below is [AI-H] and says so in the text a coach sees and saves.

export const DEVELOPMENT_BLOCK_TEMPLATE_IDS = [
  'aerobic_base',
  'general_strength',
  'maximal_strength',
  'power',
  'fight_specific_conditioning',
] as const;

export type DevelopmentBlockTemplateId = (typeof DEVELOPMENT_BLOCK_TEMPLATE_IDS)[number];

export interface EvidenceNote {
  tag: 'SR/MA' | 'PS' | 'AI-H';
  text: string;
}

export interface DevelopmentBlockTemplate {
  id: DevelopmentBlockTemplateId;
  name: string;
  /** Prefills the Title box. */
  title: string;
  /** Prefills the Training emphasis box. The coach edits it; this is a start. */
  emphasis: string;
  /** Shown beside the picker; not saved with the block. */
  evidence: EvidenceNote[];
}

const AI_H = '[AI-H] AI rule of thumb, not from a cited study. Adjust to the athlete.';

const CONCURRENT_TRAINING: EvidenceNote = {
  tag: 'SR/MA',
  text:
    'Strength and endurance in the same program interfere less than feared (Schumann et al. meta-analysis, '
    + '43 studies; Wilson et al. 2012). Mitigations: strength before endurance in a session, hard endurance '
    + '3 times a week or fewer, hard sessions of each kind at least 6 hours apart.',
};

const MODELS_EQUIVALENT: EvidenceNote = {
  tag: 'SR/MA',
  text:
    'Periodization models are roughly equivalent: linear vs undulating differ by about nothing (SMD ~ -0.02), '
    + 'block periodization studied by Painter et al. Tactical '
    + 'periodization has no empirical studies.',
};

const STRENGTH_PUNCH: EvidenceNote = {
  tag: 'PS',
  text:
    'Strength and power measures are associated with punch force in small studies (Loturco et al., n=15; '
    + 'Dunn et al. 2022, n=28: IMTP and CMJ). Few causal studies, and almost none in women.',
};

export const DEVELOPMENT_BLOCK_TEMPLATES: readonly DevelopmentBlockTemplate[] = [
  {
    id: 'aerobic_base',
    name: 'Aerobic base',
    title: 'Aerobic base block',
    emphasis: [
      'Build the aerobic engine that recovery between rounds and sessions runs on.',
      `${AI_H}`,
      '- 4-6 weeks.',
      '- 3-4 sessions a week of 30-60 min steady work at a conversational pace (about RPE 3-4 of 10): roadwork, bike, skipping.',
      '- Keep strength twice a week at a maintenance dose: 2-3 sets of 5-8 reps at about 65-75% 1RM.',
    ].join('\n'),
    evidence: [
      CONCURRENT_TRAINING,
      MODELS_EQUIVALENT,
      { tag: 'AI-H', text: 'The synthesis lists neglecting the aerobic base as a common pitfall; that line is uncited.' },
    ],
  },
  {
    id: 'general_strength',
    name: 'General strength',
    title: 'General strength block',
    emphasis: [
      'Build general strength and movement quality across squat, hinge, push, pull, carry and trunk.',
      `${AI_H}`,
      '- 4-6 weeks.',
      '- 2-3 full-body sessions a week.',
      '- 3-4 sets of 8-12 reps at about 60-75% 1RM, stopping 2-3 reps short of failure.',
    ].join('\n'),
    evidence: [CONCURRENT_TRAINING, MODELS_EQUIVALENT, STRENGTH_PUNCH],
  },
  {
    id: 'maximal_strength',
    name: 'Maximal strength',
    title: 'Maximal strength block',
    emphasis: [
      'Raise maximal strength on a few main lifts while technique stays clean.',
      `${AI_H}`,
      '- 3-6 weeks, usually after a general strength block.',
      '- 2-3 sessions a week.',
      '- 3-5 sets of 3-6 reps at about 80-90% 1RM, 2-4 min rest between sets.',
    ].join('\n'),
    evidence: [CONCURRENT_TRAINING, MODELS_EQUIVALENT, STRENGTH_PUNCH],
  },
  {
    id: 'power',
    name: 'Power',
    title: 'Power block',
    emphasis: [
      'Turn strength into speed: move light-to-moderate loads and the body as fast as possible.',
      `${AI_H}`,
      '- 3-4 weeks, usually after a strength block.',
      '- 2-3 sessions a week: jumps, med-ball throws, loaded jumps or explosive pulls.',
      '- 3-6 sets of 1-5 reps at about 30-60% 1RM, full rest (2-3 min); end the set when speed drops.',
    ].join('\n'),
    evidence: [
      STRENGTH_PUNCH,
      { tag: 'PS', text: 'A boxing strike contraction can happen in under 300 ms.' },
      CONCURRENT_TRAINING,
      MODELS_EQUIVALENT,
    ],
  },
  {
    id: 'fight_specific_conditioning',
    name: 'Fight-specific conditioning',
    title: 'Fight-specific conditioning block',
    emphasis: [
      'Condition for the bout format: rounds, pace and recovery between rounds.',
      `${AI_H}`,
      '- The 4-8 weeks before a bout.',
      '- 2-3 sessions a week of bag or pad rounds matching the bout format (for example 3 x 3 min, 1 min rest) at fight pace.',
      '- Repeat-effort intervals: 10-30 s hard, rest 1-3 times as long, 6-12 repeats.',
      '- Keep strength 1-2 times a week at reduced volume: 2-3 sets of 3-5 reps at about 75-85% 1RM.',
    ].join('\n'),
    evidence: [CONCURRENT_TRAINING, MODELS_EQUIVALENT],
  },
];

export type TemplatesWithheldReason = 'minor_or_no_date_of_birth';

export interface DevelopmentBlockTemplatesForAthlete {
  /** False for a minor AND for an athlete with no date of birth on file. */
  athlete_is_adult: boolean;
  templates: readonly DevelopmentBlockTemplate[];
  withheld_reason: TemplatesWithheldReason | null;
}

/**
 * Pure: the templates to offer for one athlete. Adults get them; anyone else
 * gets none unless the coach ticked the per-athlete opt-in.
 */
export function templatesFor(athleteIsAdult: boolean, minorOptIn: boolean): DevelopmentBlockTemplatesForAthlete {
  if (athleteIsAdult || minorOptIn) {
    return { athlete_is_adult: athleteIsAdult, templates: DEVELOPMENT_BLOCK_TEMPLATES, withheld_reason: null };
  }
  return { athlete_is_adult: false, templates: [], withheld_reason: 'minor_or_no_date_of_birth' };
}

/**
 * The templates for one athlete, behind the same gate every development-block
 * read uses. Reads dob only to decide adult vs not; never returns it.
 * A missing dob counts as a minor (wallDisplay.isMinor), so the default fails
 * toward hiding.
 */
export async function listDevelopmentBlockTemplatesForAthlete(
  actor: ActorIdentity,
  athleteId: string,
  options: { minorOptIn?: boolean; now?: Date } = {},
): Promise<DevelopmentBlockTemplatesForAthlete> {
  await assertActorCanAccessAthlete(actor, athleteId);
  // dob cast to text in SQL: a driver Date is built in the process timezone and
  // would shift a birthday by a day west of UTC (competenceCohorts.ts does the same).
  const athlete = await queryOne<{ dob: string | null }>(
    `select to_char(dob, 'YYYY-MM-DD') as dob
     from pilot.athletes
     where organization_id = $1 and athlete_id = $2`,
    [actor.organizationId, athleteId],
  );
  const athleteIsAdult = athlete !== null && !isMinor(athlete.dob, options.now ?? new Date());
  return templatesFor(athleteIsAdult, options.minorOptIn === true);
}
