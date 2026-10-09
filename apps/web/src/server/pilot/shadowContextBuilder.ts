// shadowContextBuilder.ts
// Builds SHADOW context adaptively based on tier (Quick Round vs Heavy Bag)
// Quick Round: Minimal context (role, recent interactions, basic profile)
// Heavy Bag: Full context (all 9 weighting dimensions)

import type { ActorIdentity } from './access';
import { type AthleteContactCapRow, getCurrentContactCap, isCapSet } from './athleteContactCaps';
import {
  type AthleteMinorLimitRow,
  MINOR_LIMIT_TYPES,
  type MinorLimitType,
  readAthleteMinorLimits,
} from './athleteMinorLimits';
import type { PilotRole } from './contracts';
import { DECISION_LOOP_ROLES } from './shadowRoleSets';
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
  /**
   * The coach-set limits for the athlete in scope, loaded by
   * loadAthleteLimitsForShadow BEFORE this builder runs (the builder itself
   * is pure). Null or undefined = nothing loaded, and the context says nothing
   * about limits: an athlete's or parent's chat, an org-scoped question, or a
   * role the loader refuses.
   */
  athleteLimits?: AthleteLimitsForShadow | null;
}

/**
 * The limits a COACH set for one athlete, as SHADOW's context sees them
 * (OD-2026-10-06-024 ruling 2: limits are data; OD-2026-09-21-001: a missing
 * limit means ASK THE COACH, never a default). Three types from
 * pilot.athlete_minor_limits plus the contact level, which lives in
 * pilot.athlete_contact_caps and is read from there (one home per limit).
 *
 * 'unavailable' is a read that failed or was refused for a role the loader
 * admits: said as unknown, never as "none set" -- the two must not read alike
 * (the near-miss retrieval in shadowChat.ts follows the same rule).
 */
export type AthleteLimitsForShadow =
  | {
      status: 'loaded';
      athleteId: string;
      /** From pilot.athletes.dob at read time; unknown counts as a minor. */
      athleteIsMinor: boolean;
      limits: Record<MinorLimitType, Pick<AthleteMinorLimitRow, 'value_number' | 'value_text' | 'set_at'> | null>;
      contactCap: Pick<AthleteContactCapRow, 'highest_allowed_stage' | 'max_hard_open_sessions_per_7_days' | 'set_at'> | null;
    }
  | { status: 'unavailable'; athleteId: string };

type LoadedLimits = Extract<AthleteLimitsForShadow, { status: 'loaded' }>['limits'];

/**
 * Who SHADOW reads a child's limits for: the coach-facing roles only
 * (OD-2026-10-08-007 Q5/Q6: a child's limits are visible to staff; only
 * coach-facing SHADOW reads them and asks the coach for a missing one;
 * athlete and parent chats keep "defer to the coach"). The same set the
 * near-miss records use, so the two athlete-safety reads admit the same
 * people. The limits module refuses every other role on its own; this gate
 * runs BEFORE the read, so an excluded role causes no read and learns
 * nothing from the shape of a refusal.
 */
export const SHADOW_LIMITS_ROLES: readonly PilotRole[] = DECISION_LOOP_ROLES;

/**
 * Loads the limits in force for the athlete in scope, for a coach-facing
 * chat. Null when there is no athlete in scope or the role is not admitted
 * (nothing is read). Never throws: a failed read is reported as
 * 'unavailable' so the model treats the limits as unknown rather than absent.
 */
export async function loadAthleteLimitsForShadow(params: {
  userRole: PilotRole;
  userId: string;
  organizationId: string;
  actorAthleteId?: string | null;
  athleteId?: string;
}): Promise<AthleteLimitsForShadow | null> {
  const { userRole, userId, organizationId, actorAthleteId = null, athleteId } = params;
  if (!athleteId) return null;
  if (!SHADOW_LIMITS_ROLES.includes(userRole)) return null;
  const actor: ActorIdentity = { accountId: userId, role: userRole, organizationId, athleteId: actorAthleteId };
  try {
    const [reading, cap] = await Promise.all([
      readAthleteMinorLimits(actor, athleteId),
      getCurrentContactCap(actor, athleteId),
    ]);
    const limits = {} as LoadedLimits;
    for (const type of MINOR_LIMIT_TYPES) {
      const row = reading.limits[type];
      limits[type] = row ? { value_number: row.value_number, value_text: row.value_text, set_at: row.set_at } : null;
    }
    return {
      status: 'loaded',
      athleteId,
      athleteIsMinor: reading.athlete_is_minor,
      limits,
      contactCap: isCapSet(cap)
        ? {
            highest_allowed_stage: cap.highest_allowed_stage,
            max_hard_open_sessions_per_7_days: cap.max_hard_open_sessions_per_7_days,
            set_at: cap.set_at,
          }
        : null,
    };
  } catch (error) {
    // Fail honest: a limit that could not be read is unknown, not absent.
    console.error('SHADOW athlete limits unavailable', {
      errorClass: error instanceof Error ? error.name : typeof error,
    });
    return { status: 'unavailable', athleteId };
  }
}

const NOT_SET = 'NOT SET -- no limit is recorded; ask the coach for it';

function describeNumber(row: { value_number: number | null; set_at: string } | null, unit: string): string {
  return row && row.value_number !== null ? `${row.value_number} ${unit} (set ${String(row.set_at).slice(0, 10)})` : NOT_SET;
}

/**
 * The coach-set limits as prompt lines. Every type is listed, set or not,
 * because the instruction to ASK is attached to the gap, and a gap the model
 * is not shown is a gap it fills on its own.
 */
export function buildAthleteLimitsSection(limits: AthleteLimitsForShadow | null | undefined): string[] {
  if (!limits) return [];
  const heading = `## Coach-Set Limits For This Athlete (${limits.athleteId})`;
  if (limits.status === 'unavailable') {
    return [
      heading,
      `- The limits could not be read for this request. Treat every limit -- heat exposure, weight cut, supervision, contact level -- as UNKNOWN, not as unset: ask the coach what is in force before any guidance on those, and say the record could not be read.`,
    ];
  }
  const supervision = limits.limits.supervision;
  const cap = limits.contactCap;
  const capParts: string[] = [];
  if (cap?.highest_allowed_stage) capParts.push(`highest contact stage ${cap.highest_allowed_stage}`);
  if (cap && cap.max_hard_open_sessions_per_7_days !== null) {
    capParts.push(`at most ${cap.max_hard_open_sessions_per_7_days} hard or open sparring sessions in any 7 days`);
  }
  return [
    heading,
    `- Athlete: ${limits.athleteIsMinor ? 'MINOR (date-of-birth rule; an unknown date of birth counts as a minor)' : 'adult (limits recorded the same way, labelled adult)'}`,
    `- Heat exposure, minutes per session: ${describeNumber(limits.limits.heat_exposure_minutes_per_session, 'minutes')}`,
    `- Weight cut, most percent of body weight: ${describeNumber(limits.limits.weight_cut_max_percent_body_weight, 'percent of body weight')}`,
    `- Supervision the coach requires: ${supervision?.value_text ? `${supervision.value_text} (set ${String(supervision.set_at).slice(0, 10)})` : NOT_SET}`,
    `- Contact level (sparring cap): ${capParts.length > 0 ? `${capParts.join('; ')} (set ${String(cap?.set_at).slice(0, 10)})` : NOT_SET}`,
    `- Directive: these are the coach's limits, recorded as data. A limit marked NOT SET has no value: never propose, assume, infer or default one -- say plainly that none is recorded and ask the coach what it should be. Never suggest training that goes past a limit that is set. The coach decides training.`,
  ];
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

  // The one athlete datum that reaches the quick tier: a coach's limits must
  // be in EVERY answer about that athlete, however short -- a heat question
  // answered in one line without the heat limit is the answer the limits
  // exist to prevent. Present only when the loader admitted the role.
  const limitsSection = buildAthleteLimitsSection(input.athleteLimits);

  const sections = [
    ...userProfileSection,
    '',
    ...communicationSection,
    ...(communicationSection.length > 0 ? [''] : []),
    ...topicsSection,
    ...(topicsSection.length > 0 ? [''] : []),
    ...limitsSection,
    ...(limitsSection.length > 0 ? [''] : []),
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
  const limitsSection = buildAthleteLimitsSection(input.athleteLimits);
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
    ...limitsSection,
    ...(limitsSection.length > 0 ? [''] : []),
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
      // True only when the coach-set limits section is in the string: the
      // builder still supplies no other athlete record.
      includesAthleteData: Boolean(input.athleteLimits),
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
