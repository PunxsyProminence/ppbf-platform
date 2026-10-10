// shadowContextBuilder.ts
// Builds SHADOW context adaptively based on tier (Quick Round vs Heavy Bag)
// Quick Round: Minimal context (role, recent interactions, basic profile)
// Heavy Bag: Full context (all 9 weighting dimensions)

import { humanizeContactLevel } from '../../lib/drillPresentation';
import { gymDayIso } from '../../lib/gymTime';

import type { AthleteContactCapRow } from './athleteContactCaps';
import type { AthleteMinorLimitRow, MinorLimitType } from './athleteMinorLimits';
import type { PilotRole } from './contracts';
import type { ShadowUserProfileRow, RememberedFact } from './shadowUserProfile';
import type { ShadowQueryType } from './shadowContextWeights';
import { detectQueryType } from './shadowContextWeights';
import { describeFactSupport } from './shadowPersonalizationGate';

export interface ShadowContextBuilderInput {
  tier: 'quick_round' | 'heavy_bag';
  userProfile: ShadowUserProfileRow;
  userMessage: string;
  userRole: PilotRole;
  organizationId: string;
  athleteId?: string;
  /**
   * Whether the `strong_personalization` feature is unlocked for this request.
   *
   * REQUIRED, not optional, and deliberately so. This builder used to take no
   * such argument and emitted the user's inferred communication style and their
   * remembered facts on every call -- while the chat route checked the flag
   * around a *different* prompt fragment and believed the feature gated. Making
   * it required means a caller that has not decided cannot compile, which is
   * the only version of this gate that a future call site cannot walk past.
   *
   * Resolve it with `personalizationAllowed(unlockState)`; do not re-derive it.
   */
  personalizationEnabled: boolean;
}

export interface ShadowContextOutput {
  context: string;
  metadata: {
    tier: 'quick_round' | 'heavy_bag';
    topicType: ShadowQueryType;
    contextItemCount: number;
    totalWeight: number;
    includesAthleteData: boolean;
    includesResearchRequirements: boolean;
  };
}

/**
 * How a stored `communication_style` is stated to the model.
 *
 * PREFERENCE LANGUAGE ONLY. These strings describe what a person appeared to
 * want from an answer. They must not describe how a person learns.
 *
 * 'example-heavy' read "Learns best through examples" until 2026-08-23. That is
 * a learning-style claim -- a contested construct with no support in the
 * evidence base, and one this platform has no instrument to measure. What the
 * system actually observed was answer-format feedback: someone rated replies
 * that opened with an example. "Wanted examples first" and "learns best through
 * examples" are not the same sentence, and the second one, said about a child,
 * is a claim about their mind rather than about their last few clicks.
 */
const STYLE_PREFERENCE: Record<string, string> = {
  concise: 'Has preferred brief, direct answers',
  detailed: 'Has preferred comprehensive explanations',
  'example-heavy': 'Has preferred answers that open with a concrete example',
  unknown: 'No preference recorded',
};

/**
 * Quick Round context: Minimal, fast-track
 * - User role (decision-making authority) — always
 * - Recent topics (avoid repetition, show continuity) — always
 * - Communication preference — ONLY when personalization is unlocked
 * - No athlete-specific data, no research context
 *
 * INTERACTION COUNT IS NOT EXPERTISE. This built a
 * novice/intermediate/expert label from `interaction_count` -- 50 turns made
 * someone an "expert" -- and put it in the prompt as a fact about the person.
 * Nothing about how often someone opens a chat window evidences what they know
 * about boxing, coaching, or a child in front of them, and a coach labelled
 * "novice" to the model gets different answers for having been busy. The raw
 * count stays, because it is a true and unremarkable fact; the grade is gone.
 */
function buildQuickRoundContext(input: ShadowContextBuilderInput): string {
  const profile = input.userProfile;

  const userProfileSection = [
    `## User Profile`,
    `- Authenticated Role: ${input.userRole}`,
    `- Interaction History: ${profile.interaction_count} previous interactions`,
  ];

  const communicationSection = input.personalizationEnabled
    && profile.communication_style && profile.communication_style !== 'unknown'
    ? [
        `## Communication Preference`,
        `- ${STYLE_PREFERENCE[profile.communication_style] || STYLE_PREFERENCE.unknown}`,
      ]
    : [];

  const topicsSection = profile.recent_topics && profile.recent_topics.length > 0
    ? [`## Recent Discussion Topics`, `- ${profile.recent_topics.slice(-5).join(', ')}`]
    : [];

  const sections = [
    ...userProfileSection,
    '',
    ...communicationSection,
    ...(communicationSection.length > 0 ? [''] : []),
    ...topicsSection,
    ...(topicsSection.length > 0 ? [''] : []),
  ];

  return sections.join('\n');
}

/**
 * Heavy Bag context: deeper user-owned context for reasoning.
 * Athlete records and research evidence are supplied only by separately
 * authorized retrieval paths; this builder never implies that they exist.
 */
function buildHeavyBagContext(input: ShadowContextBuilderInput): string {
  const profile = input.userProfile;
  const queryType = detectQueryType(input.userMessage);

  const sections = buildHeavyBagSections(profile, input, queryType);
  return sections.join('\n');
}

function buildHeavyBagSections(profile: ShadowUserProfileRow, input: ShadowContextBuilderInput, queryType: ShadowQueryType): string[] {
  const userContextSection = [
    `## User Context`,
    `- Authenticated Role: ${input.userRole}`,
    `- Organization: ${input.organizationId}`,
    `- Interaction Count: ${profile.interaction_count}`,
    `- Last Interaction: ${profile.last_interaction_at || 'Never'}`,
  ];

  const communicationSection = buildCommunicationSection(profile, input.personalizationEnabled);
  const factsSection = buildFactsSection(profile, input.personalizationEnabled);
  const topicsSection = buildTopicsSection(profile);
  const athleteSection = buildAthleteSection(profile, input);
  const querySection = buildQuerySection(queryType);
  const authoritySection = buildAuthoritySection(input.userRole);

  return [
    ...userContextSection,
    '',
    ...communicationSection,
    ...(communicationSection.length > 0 ? [''] : []),
    ...factsSection,
    ...(factsSection.length > 0 ? [''] : []),
    ...topicsSection,
    ...(topicsSection.length > 0 ? [''] : []),
    ...athleteSection,
    ...(athleteSection.length > 0 ? [''] : []),
    ...querySection,
    '',
    ...authoritySection,
    '',
  ];
}

function buildCommunicationSection(
  profile: ShadowUserProfileRow,
  personalizationEnabled: boolean,
): string[] {
  if (!personalizationEnabled) return [];
  return profile.communication_style && profile.communication_style !== 'unknown'
    ? [
        `## Answer Format Preference`,
        `- ${STYLE_PREFERENCE[profile.communication_style] || STYLE_PREFERENCE.unknown}`,
      ]
    : [];
}

/**
 * Remembered facts, described by how often they were observed.
 *
 * NOT A PROBABILITY. This rendered `(confidence: 80%)` from a stored 0.8 that a
 * developer typed into a switch statement -- see `describeFactSupport`. An
 * ordinal word replaces it, derived from the observation count rather than the
 * weight, because the count is the only part of a remembered fact that was ever
 * actually counted.
 */
function buildFactsSection(
  profile: ShadowUserProfileRow,
  personalizationEnabled: boolean,
): string[] {
  if (!personalizationEnabled) return [];
  if (!profile.remembered_facts || !Array.isArray(profile.remembered_facts) || profile.remembered_facts.length === 0) {
    return [];
  }
  return [
    `## Observed Preferences For This User`,
    `- These are observations, not settings this person chose, and not claims about them.`,
    ...profile.remembered_facts.slice(0, 10).map((fact: RememberedFact) => {
      return `- ${fact.key}: ${fact.value} (support: ${describeFactSupport(fact.observationCount)})`;
    }),
  ];
}

function buildTopicsSection(profile: ShadowUserProfileRow): string[] {
  return profile.recent_topics && profile.recent_topics.length > 0
    ? [`## Discussion Topics`, `- Recent topics: ${profile.recent_topics.slice(0, 10).join(', ')}`]
    : [];
}

function buildAthleteSection(profile: ShadowUserProfileRow, input: ShadowContextBuilderInput): string[] {
  return input.athleteId && profile.athlete_ids_discussed?.includes(input.athleteId)
    ? [
        `## Authorized Subject Reference`,
        `- Subject identifier: ${input.athleteId}`,
        `- No athlete record data is present in this profile context.`,
      ]
    : [];
}

function buildQuerySection(queryType: ShadowQueryType): string[] {
  return [
    `## Query Classification`,
    `- Type: ${queryType}`,
    `- Tier: Heavy Bag (full reasoning enabled)`,
  ];
}

function buildAuthoritySection(userRole: PilotRole): string[] {
  const authorityMap: Record<PilotRole, string> = {
    coach: 'May use records only for athletes currently assigned to this coach; may provide coaching guidance but not medical diagnosis or clearance',
    admin: 'Organization-scoped administration; athlete records require a separate successful subject authorization check',
    athlete: 'May use only the authenticated athlete’s own record when separately authorized',
    parent: 'May use only records for an athlete linked to this parent when separately authorized',
    board: 'Aggregate governance only; SHADOW chat and athlete-record context are not authorized for this role',
    organization_admin: 'Organization-scoped administration; athlete records require a separate successful subject authorization check',
    platform_owner: 'Platform governance only; organization-private athlete records are denied by default',
    volunteer: 'General organization support only; no athlete-record access by default',
    staff: 'General organization operations only; no athlete-record access by default',
  };
  return [
    `## Role-Based Decision Authority`,
    `- ${authorityMap[userRole] || 'Standard access'}`,
  ];
}

/* ---------------------------------------------------------------------------
 * Coach-set limits, as coach-facing SHADOW is told them (lane P4, PR 2).
 *
 * COACH-SET DATA, NEVER AN APP NUMBER (OD-2026-10-06-024 ruling 2). This
 * section states what a coach recorded and nothing else: a limit that is not
 * set is said as exactly "No limit set", and the model is told to ask the
 * coach to set it, never to propose, estimate or default one.
 *
 * STAFF ONLY (OD-2026-10-08-007, minors' limits questions Q5 and Q6). This
 * file only FORMATS a reading it is handed. Who may be handed one is decided
 * where the reading is loaded -- loadShadowAthleteLimits in shadowChat.ts,
 * behind retrieveShadowContext's decision-loop gate -- and athlete and parent
 * chats never reach that line. buildShadowContext below does not call this.
 *
 * Three limits come from pilot.athlete_minor_limits; contact level lives only
 * in pilot.athlete_contact_caps and is read from there (one home per limit).
 * ------------------------------------------------------------------------- */

/** The page a coach sets heat, weight-cut and supervision limits on. */
export const ATHLETE_LIMITS_PAGE = '/coach/athlete-limits';
/** The page the contact cap is set on; the limits page shows it read-only. */
export const SPARRING_CAPS_PAGE = '/coach/sparring-caps';

/** Said for every limit that is not set, in exactly these words. */
export const NO_LIMIT_SET = 'No limit set';

export type ShadowLimitInForce = Pick<AthleteMinorLimitRow, 'limit_id' | 'value_number' | 'value_text' | 'set_at'>;
export type ShadowContactCapInForce = Pick<
  AthleteContactCapRow,
  'cap_id' | 'highest_allowed_stage' | 'max_hard_open_sessions_per_7_days' | 'set_at'
>;

/**
 * What was read for one athlete. 'unavailable' is a read that FAILED: it is
 * said as unknown, never as "No limit set" -- the two must not read alike.
 */
export interface ShadowAthleteLimits {
  athleteId: string;
  minorLimits:
    | {
        /** From pilot.athletes.dob at read time; an unknown date of birth reads as a minor. */
        athleteIsMinor: boolean;
        /** The limit in force per type; null = no limit set. */
        limits: Record<MinorLimitType, ShadowLimitInForce | null>;
      }
    | 'unavailable';
  /** The cap in force; null = no cap set. */
  contactCap: ShadowContactCapInForce | null | 'unavailable';
}

export interface ShadowAthleteLimitsSection {
  lines: string[];
  /**
   * The limit and cap rows stated in `lines`, so an answer that repeats a
   * coach-set number can cite it. validateShadowResponse withholds an uncited
   * percentage, and the weight-cut limit is one.
   */
  evidenceIds: string[];
}

const CITABLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function limitDay(setAt: unknown): string {
  return gymDayIso(setAt instanceof Date ? setAt : String(setAt)) ?? 'date not recorded';
}

/** The coach's own words on one line, so stored text cannot start a new context line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/"/g, "'");
}

/**
 * The coach-set limits as prompt lines. EVERY limit is listed, set or not:
 * the instruction to ask is attached to the gap, and a gap the model is not
 * shown is a gap it fills on its own.
 */
export function buildAthleteLimitsSection(reading: ShadowAthleteLimits): ShadowAthleteLimitsSection {
  const evidenceIds: string[] = [];
  const stated = (id: string, setAt: unknown): string => {
    // The response validator accepts only UUID citations, so an id that is
    // not one is not offered as citable.
    if (!CITABLE_ID.test(id)) return `(coach-set, ${limitDay(setAt)})`;
    if (!evidenceIds.includes(id)) evidenceIds.push(id);
    return `[E:${id}] (coach-set, ${limitDay(setAt)})`;
  };

  const lines: string[] = [`COACH-SET LIMITS for this athlete (${reading.athleteId}), read from the gym's records:`];

  if (reading.minorLimits === 'unavailable') {
    lines.push(
      '- Heat exposure, weight cut and supervision: these limits could not be read for this request. '
        + `They are UNKNOWN, which is not "${NO_LIMIT_SET}".`,
    );
  } else {
    const { athleteIsMinor, limits } = reading.minorLimits;
    const heat = limits.heat_exposure_minutes_per_session;
    const cut = limits.weight_cut_max_percent_body_weight;
    const supervision = limits.supervision;
    lines.push(
      athleteIsMinor
        ? '- This athlete is a MINOR (an unknown date of birth counts as a minor).'
        : '- This athlete is an ADULT; limits are recorded the same way and labelled adult.',
      `- Heat exposure, minutes per session: ${heat && heat.value_number !== null
        ? `at most ${heat.value_number} minutes per session ${stated(heat.limit_id, heat.set_at)}`
        : NO_LIMIT_SET}`,
      `- Weight cut, most percent of body weight: ${cut && cut.value_number !== null
        ? `at most ${cut.value_number} percent of body weight ${stated(cut.limit_id, cut.set_at)}`
        : NO_LIMIT_SET}`,
      `- Supervision the coach requires: ${supervision && supervision.value_text !== null
        ? `"${oneLine(supervision.value_text)}" ${stated(supervision.limit_id, supervision.set_at)}`
        : NO_LIMIT_SET}`,
    );
  }

  if (reading.contactCap === 'unavailable') {
    lines.push(
      '- Contact level (sparring cap): the cap could not be read for this request. '
        + `It is UNKNOWN, which is not "${NO_LIMIT_SET}".`,
    );
  } else {
    const cap = reading.contactCap;
    lines.push(
      `- Contact level, highest stage (sparring cap): ${cap && cap.highest_allowed_stage !== null
        ? `${humanizeContactLevel(cap.highest_allowed_stage)} ${stated(cap.cap_id, cap.set_at)}`
        : NO_LIMIT_SET}`,
      `- Hard or open sparring sessions in any 7 days (sparring cap): ${cap && cap.max_hard_open_sessions_per_7_days !== null
        ? `at most ${cap.max_hard_open_sessions_per_7_days} ${stated(cap.cap_id, cap.set_at)}`
        : NO_LIMIT_SET}`,
    );
  }

  lines.push(
    'Limits directive: these are the coach\'s limits, recorded as data; you did not set them and you do not change them. '
      + 'When you state one, give the value as written above and cite its id. '
      + 'Keep anything you draft for this athlete inside every limit that is set. '
      + `When the question depends on a limit marked "${NO_LIMIT_SET}", say that it is not set and ask the coach to set it `
      + `on the Athlete Limits page (${ATHLETE_LIMITS_PAGE}); the contact cap is set on the Sparring Caps page (${SPARRING_CAPS_PAGE}). `
      + 'Never propose, estimate, assume or default a number or a rule for a limit that is not set. '
      + 'When a limit is marked UNKNOWN, say the record could not be read and ask the coach to check that page. '
      + 'The coach decides.',
  );

  return { lines, evidenceIds };
}

/**
 * Main context builder: selects Quick or Heavy context based on tier
 */
export function buildShadowContext(input: ShadowContextBuilderInput): ShadowContextOutput {
  const tier = input.tier;

  // Board accounts use the dedicated, aggregate-only Board workspace. If this
  // context helper is reached outside the guarded chat route, return no
  // profile, athlete, coaching, or remembered-fact context.
  if (input.userRole === 'board') {
    return {
      context: buildAuthoritySection('board').join('\n'),
      metadata: {
        tier,
        topicType: 'general',
        contextItemCount: 1,
        totalWeight: 0,
        includesAthleteData: false,
        includesResearchRequirements: false,
      },
    };
  }

  const queryType = detectQueryType(input.userMessage);

  let context: string;
  let contextItemCount: number;
  let totalWeight: number;

  if (tier === 'quick_round') {
    context = buildQuickRoundContext(input);
    contextItemCount = 4; // Approximate: role, style, topics, questions
    totalWeight = 0.4; // Light weighting
  } else {
    context = buildHeavyBagContext(input);
    contextItemCount = 10; // Full: user, facts, topics, questions, athlete, query type, etc.
    totalWeight = 0.85; // Heavy weighting
  }

  return {
    context,
    metadata: {
      tier,
      topicType: queryType,
      contextItemCount,
      totalWeight,
      includesAthleteData: false,
      includesResearchRequirements: false,
    },
  };
}

/**
 * Get concise stats on context for logging/telemetry
 */
export function getContextStats(output: ShadowContextOutput) {
  return {
    tier: output.metadata.tier,
    itemCount: output.metadata.contextItemCount,
    totalWeight: output.metadata.totalWeight,
    topicType: output.metadata.topicType,
  };
}
