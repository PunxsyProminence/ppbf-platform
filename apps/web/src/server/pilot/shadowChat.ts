// Core SHADOW Chat Validation Engine
// Doctrine enforcement through request validation, topic classification, and response filtering

import { assertActorCanAccessAthlete } from './access';
import type { PilotRole } from './contracts';
import { listRecentNearMisses } from './shadowNearMisses';
import { DECISION_LOOP_ROLES } from './shadowRoleSets';

// 5-minute org-level context cache — avoids 3 DB queries per request
const contextCache = new Map<string, { value: string; expiresAt: number }>();
const CONTEXT_TTL_MS = 5 * 60 * 1000;

function getCachedContext(key: string): string | null {
  const entry = contextCache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.value;
  contextCache.delete(key);
  return null;
}

function setCachedContext(key: string, value: string): void {
  contextCache.set(key, { value, expiresAt: Date.now() + CONTEXT_TTL_MS });
}

// High-risk topics that require special handling
export type HighRiskTopic = 
  | 'concussion'
  | 'head_trauma'
  | 'loss_of_consciousness'
  | 'dizziness'
  | 'dehydration'
  | 'weight_cutting'
  | 'rapid_weight_loss'
  | 'chest_pain'
  | 'fainting'
  | 'medication'
  | 'prescription'
  | 'surgery'
  | 'injection'
  | 'return_to_play'
  | 'medical_clearance'
  | 'youth_safety'
  | 'urgent_symptom'
  | 'none';

export interface HighRiskClassification {
  topic: HighRiskTopic;
  isHighRisk: boolean;
  educationalApproach: boolean;
  examples: {
    allowed: string[];
    blocked: string[];
  };
}

export interface ShadowValidationResult {
  valid: boolean;
  error?: string;
  highRisk?: boolean;
  topic?: HighRiskTopic;
  classification?: string;
}

export interface ShadowContextResult {
  context: string;
  authorized: boolean;
  reason?: string;
  /**
   * Server-derived ids for records injected into the context (currently
   * near-miss events). Authorized for citation validation the same way
   * platform-rollup ids are, and like them kept out of the library bundle's
   * citation persistence -- they are organization records, not library
   * evidence.
   */
  evidenceIds?: string[];
}

/**
 * Every reason validateShadowResponse can give, as a stable code paired with
 * the sentence a human reads.
 *
 * The prose is the only form these reasons had, and prose is the wrong join
 * key. It is edited whenever a rule's wording is clarified -- three of these
 * sentences were reworded in a single week -- and a GROUP BY over prose splits
 * one rule into two series at the moment someone fixes a typo, which reads as a
 * rule that stopped firing and a new one that started. The code is what gets
 * persisted and counted; the sentence stays free to change.
 *
 * Codes are append-only for the same reason. Renaming one rewrites history.
 */
export const SHADOW_FILTER_REASONS = {
  diagnostic_claim: 'Contains diagnostic claim without evidence or human deference',
  prescriptive_claim: 'Contains prescriptive claim without medical authority',
  treatment_directive: 'Contains a personal treatment directive without medical authority',
  clearance_claim: 'Contains clearance claim without medical authority',
  disclosure_risk: 'May disclose protected instructions, secrets, or cross-tenant information',
  authority_override: 'Attempts to override human authority',
  weight_cut_directive: 'Contains a rapid weight-loss or dehydration directive without medical authority',
  unauthorized_citation: 'Contains an unknown, malformed, or unauthorized evidence citation',
  uncited_claim: 'Makes an evidence or quantitative claim without an exact retrieved evidence citation',
  missing_deferral: 'Missing human deferral language',
  human_review: 'Human review required',
} as const;

export type ShadowFilterReasonCode = keyof typeof SHADOW_FILTER_REASONS;

export interface ShadowResponseValidation {
  valid: boolean;
  filtered: boolean;
  message: string;
  reasons: string[];
  /**
   * The same reasons as `reasons`, in the same order, as stable codes.
   *
   * Persisted alongside response_state so "how often does SHADOW withhold an
   * answer, and which rule did it" is one query instead of a log dig. Before
   * this existed the reasons were computed on every filtered response and
   * dropped on the floor, so the only artifact of a withheld answer was the
   * word 'filtered' -- which is how three separate over-filters went unnoticed
   * until someone tripped over each one by hand.
   */
  reasonCodes: ShadowFilterReasonCode[];
  requiresHumanReview: boolean;
  citationIds: string[];
  /**
   * High-risk topic detected in the RESPONSE, independent of the request.
   *
   * The handoff banner was resolved solely from the request's topic, so a
   * response that volunteered weight-cut guidance to a benign question got the
   * generic handoff instead of "talk to your medical team ... before changing
   * any weight-cut plan". The route prefers this when set.
   */
  topic?: string;
}

export const SHADOW_SAFE_FILTERED_RESPONSE =
  'I can’t safely provide that generated answer. SHADOW filtered it before display. Consult a qualified coach or medical professional for the next decision. RESEARCH NEEDED — the answer did not pass safety validation.';

/**
 * Substitute the apostrophe and quote look-alikes a phone keyboard produces,
 * ONE CHARACTER FOR ONE CHARACTER, and nothing else.
 *
 * THE DEFECT THIS CLOSES IS LIVE IN PRODUCTION. Measured against main before
 * the change:
 *
 *   "I can't breathe after that hit"        straight  -> withheld, human queued
 *   "I can\u2019t breathe after that hit"        CURLY     -> allowed to the model
 *
 * U+2019 is what iOS and Android type by default, so for an athlete on a phone
 * that is the common case. The file already knew: the loss_of_consciousness
 * pattern carries ['\u2019] for KO'd, fixed by hand, while every can't and
 * cannot pattern stayed straight-only.
 *
 * WHY THIS IS THE WHOLE FUNCTION, AND WHY IT USED TO DO MORE.
 *
 * Earlier versions also deleted zero-width characters and the soft hyphen,
 * folded dashes, folded the NBSP class to a space, collapsed whitespace,
 * trimmed, ran NFKC, and turned U+FEFF into a space. None of those was needed
 * for the defect, and each of the ones below changed what a pattern matched
 * for a message main already handled:
 *
 *   NFKC EXPANDS. U+2026 became three periods, overflowing the
 *   character-counted windows -- `vision.{0,12}blurr`, `bleeding.{0,20}`.
 *   NFKC CREATES WORD CHARACTERS. U+2122 became "TM", so "\u2122my shoulder
 *   hurts" read as "TMmy shoulder hurts" and `\b(i|me|my|...)\b` went false.
 *   DELETION MERGES WORDS. "my\u200Bshoulder hurts" became "myshoulder hurts",
 *   so `\bmy\b` failed and the personal-health refusal was lost. Same for
 *   U+00AD, and for U+FEFF, which main's `\s` already matches.
 *   WHITESPACE COLLAPSING removed line breaks, which are the only bound on
 *   the unbounded `.` gaps, so ordinary two-line messages were withheld.
 *   U+FEFF TO A SPACE made the literal-space phrases match where main's did
 *   not -- "lose weight<FEFF>quickly" -- and that return sits ABOVE the
 *   emergency one, so "I can't breathe and I need to lose weight<FEFF>quickly"
 *   lost its emergency response. U+FEFF is now left exactly as typed.
 *
 * One root cause: the patterns in this file count characters, assert word
 * boundaries, test whitespace, match literal spaces, and let `.` stop at a
 * line terminator. So the fold is restricted to substitutions that cannot
 * move any of those: an apostrophe-like or quote-like punctuation character
 * becoming the ASCII one, in place.
 *
 * shadowChatSensitivity.test.ts holds this function to that. The eighteen
 * code units below are written out there a second time as an exact map and
 * checked against every UTF-16 code unit; the SHAPE of this function and of
 * its two call sites is checked from this file's source; and the argument
 * from "eighteen punctuation characters become two" to "nothing main
 * withheld is released, and nothing main treated as an emergency stops being
 * one" is written out there with its premises tested. KEEP EVERY LINE BELOW
 * A GLOBAL REPLACE OF A SINGLE-UNIT CHARACTER CLASS BY A FIXED ONE-UNIT
 * STRING. A line of any other shape, here or at the call sites, fails that
 * suite by design.
 *
 * ANYTHING NOT FOLDED HERE BEHAVES EXACTLY AS IT DOES ON MAIN, which is the
 * standard this hotfix is measured against. Widening it is #1036 work.
 *
 * MATCHING ONLY. The result is never persisted, never sent to the model and
 * never shown back: the athlete's own words are the record.
 */
export function normaliseForMatching(text: string): string {
  return text
    // Apostrophe look-alikes -> ASCII apostrophe. The fix. Every member is a
    // single UTF-16 unit that is neither a word character nor whitespace, as
    // is the replacement.
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u02B9\u02BB\u02BC\u00B4\uFF07\uFF40`]/g, "'")
    // Quote look-alikes -> ASCII quote. Same reasoning.
    .replace(/[\u201C\u201D\u201E\u201F\u2033\uFF02]/g, '"');
}

// Classify high-risk topics and determine routing
export function classifyHighRiskTopic(userMessage: string): HighRiskClassification {
  // Normalised, not merely lowercased -- see normaliseForMatching.
  const msg = normaliseForMatching(userMessage).toLowerCase();

  const topics: Array<[HighRiskTopic, RegExp]> = [
    ['concussion', /concuss/i],
    ['head_trauma', /(head|brain)\s+(trauma|injury)/i],
    ['loss_of_consciousness', /(loss|loss\s+of|lack)\s+of\s+consciousness|unconscious|passed\s+out|knocked\s+out|\bko['’]?d\b|blacked\s+out/i],
    ['dizziness', /dizzy|dizziness|vertigo/i],
    ['dehydration', /dehydrat|(?:extreme|excessive)\s+thirst|unable\s+to\s+keep\s+fluids?\s+down/i],
    ['weight_cutting', /(weight.*cut|cut\s+weight|rapid\s+weight|make\s+weight)/i],
    ['rapid_weight_loss', /rapid.*weight|fast\s+weight|lose\s+\d+(?:\.\d+)?\s*(?:pounds?|lbs?|kilograms?|kgs?)\s+(?:this|in\s+(?:a|one))\s+week/i],
    ['chest_pain', /(chest|heart)\s+pain|cardiac/i],
    ['fainting', /faint|syncope/i],
    ['medication', /(take|taking|took)\s+(medicine|medication|drug|pill)/i],
    ['prescription', /prescrip|prescription|prescribed|Rx/i],
    ['surgery', /surgery|surgical|underwent\s+an?\s+operation|operation\s+on\s+(?:me|my|the)|operated\s+on/i],
    ['injection', /inject|needle|vaccine|medical\s+shot|cortisone\s+shot|steroid\s+shot/i],
    ['return_to_play', /(return.*play|cleared.*play|cleared\s+to)/i],
    ['medical_clearance', /(medical|doctor)\s+clear|cleared|clearance/i],
    ['youth_safety', /(minor|child|kid|young)\s+(safety|harm)/i],
    ['urgent_symptom', /(can(?:not|'t)\s+breathe|shortness\s+of\s+breath|trouble\s+breathing|blurr(?:y|ed)?\s+vision|vision.{0,12}blurr(?:y|ed)?|double\s+vision|can(?:not|'t)\s+see|seeing\s+stars|seizure|convulsion|headache|nausea|nauseous|neck.{0,20}(numb|weak|tingl)|severe\s+bleeding|bleeding.{0,20}(won't|will\s+not)\s+stop|abdominal\s+pain|stomach\s+pain|vomit(?:ing)?\s+blood|slurred\s+speech|unequal\s+pupils?|can(?:not|'t)\s+move|sudden\s+weakness)/i],
  ];

  let classifiedTopic: HighRiskTopic = 'none';
  for (const [topic, pattern] of topics) {
    if (pattern.test(msg)) {
      classifiedTopic = topic;
      break;
    }
  }

  const hasEducationalFraming = /\bwhat\s+(is|are|causes?|can|could|does)\b|research|understand|learn|educational|context|background|how\s+(is|are|does|do)\s+(an?|the|athletes?|coaches?|organizations?)/i.test(msg);
  const hasPersonalFraming = /\b(i|me|my|mine|we|our)\b/i.test(msg)
    || /\b(now|currently|today|just happened|during training|after sparring)\b/i.test(msg);
  const isEducationalQuery = hasEducationalFraming && !hasPersonalFraming;

  const examples: Record<HighRiskTopic, { allowed: string[]; blocked: string[] }> = {
    concussion: {
      allowed: ['What is a concussion?', 'What are the symptoms of a concussion?', 'How does the body recover from concussion?'],
      blocked: ['Do I have a concussion?', 'Am I cleared to play after concussion?'],
    },
    head_trauma: {
      allowed: ['What is head trauma?', 'What protective equipment helps prevent head trauma?'],
      blocked: ['Do I have head trauma?', 'Should I continue playing with head trauma?'],
    },
    weight_cutting: {
      allowed: ['What are the risks of rapid weight loss?', 'How should athletes manage weight safely?'],
      blocked: ['How do I cut weight for my weight class?', 'Is it safe to cut weight this week?'],
    },
    return_to_play: {
      allowed: ['What is the return-to-play protocol?', 'What steps are in a standard RTP process?'],
      blocked: ['Am I cleared to return to play?', 'When can I play again?'],
    },
    medical_clearance: {
      allowed: ['What is required for medical clearance?', 'What does a clearance evaluation include?'],
      blocked: ['Am I cleared?', 'Do I need clearance?'],
    },
    prescription: {
      allowed: ['How do medications work?', 'What are common side effects of this class of drug?'],
      blocked: ['Should I take this medication?', 'What medication do I need?'],
    },
    medication: {
      allowed: ['What are the uses of this medication?', 'How do medications affect athletic performance?'],
      blocked: ['Should I take this medication?', 'What medication should I take?'],
    },
    chest_pain: {
      allowed: ['What could cause chest pain during exercise?', 'When is chest pain serious?'],
      blocked: ['Do I have a heart problem?', 'Should I see a doctor about my chest pain?'],
    },
    fainting: {
      allowed: ['What causes fainting?', 'What is syncope?'],
      blocked: ['Why did I faint?', 'Am I okay?'],
    },
    dizziness: {
      allowed: ['What causes dizziness in athletes?', 'How is dizziness managed?'],
      blocked: ['Why am I dizzy?', 'Is my dizziness serious?'],
    },
    dehydration: {
      allowed: ['What are signs of dehydration?', 'How should athletes hydrate?'],
      blocked: ['Am I dehydrated?', 'Should I drink more?'],
    },
    rapid_weight_loss: {
      allowed: ['What are the risks of rapid weight loss?', 'How should weight loss be managed safely?'],
      blocked: ['How do I lose weight quickly?', 'Is rapid weight loss safe?'],
    },
    loss_of_consciousness: {
      allowed: ['What is loss of consciousness?', 'How is LOC different from concussion?'],
      blocked: ['Did I lose consciousness?', 'Should I be worried about my LOC?'],
    },
    surgery: {
      allowed: ['What does surgery involve?', 'What is the recovery from surgery like?'],
      blocked: ['Should I have surgery?', 'Do I need surgery?'],
    },
    injection: {
      allowed: ['What are injections used for?', 'What are the types of injections in sports medicine?'],
      blocked: ['Should I get an injection?', 'Will an injection help me?'],
    },
    youth_safety: {
      allowed: ['What safety measures protect young athletes?', 'What are best practices for youth sports?'],
      blocked: ['Is this safe for a child?', 'Can a minor do this?'],
    },
    urgent_symptom: {
      allowed: ['What can cause shortness of breath?', 'What are general warning signs after a head impact?'],
      blocked: ['I cannot breathe after that hit.', 'My vision is blurry after sparring.'],
    },
    none: {
      allowed: [],
      blocked: [],
    },
  };

  return {
    topic: classifiedTopic,
    isHighRisk: classifiedTopic !== 'none',
    educationalApproach: isEducationalQuery,
    examples: examples[classifiedTopic],
  };
}

// Validate that the request aligns with SHADOW's doctrine
export function validateShadowRequest(
  message: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _userRole: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _organizationId: string,
): ShadowValidationResult {
  const classification = classifyHighRiskTopic(message);
  // EVERY PATTERN BELOW READS `text`, NOT `message`. See normaliseForMatching:
  // a curly apostrophe made "I can\u2019t breathe after that hit" an ordinary
  // question. `message` is not matched against again anywhere in this
  // function, which is what keeps the guarantee from depending on each
  // pattern author remembering it.
  const text = normaliseForMatching(message);
  const normalizedMessage = text.toLowerCase();

  const hasPrescriptionLanguage = /\b(prescribe|prescribed|prescribing|prescription|rx)\b/i.test(text)
    || /should\s+i\s+take/i.test(text)
    || /should\s+you\s+take/i.test(text)
    || /take\s+(?:this\s+)?(?:medication|medicine|drug|pill)/i.test(text);

  const hasRapidWeightCutLanguage = /how\s+do\s+i\s+cut\s+weight/i.test(text)
    || normalizedMessage.includes('lose weight quickly')
    || normalizedMessage.includes('cut weight for my weight class')
    || /\b(?:i\s+(?:need|have)\s+to|help\s+me|how\s+(?:can|do)\s+i)\b.{0,35}\bmake\s+weight\b/i.test(text)
    || /\b(?:i\s+(?:need|want|have)\s+to\s+)?lose\s+\d+(?:\.\d+)?\s*(?:pounds?|lbs?|kilograms?|kgs?)\s+(?:this|in\s+(?:a|one))\s+week\b/i.test(text);

  const hasPersonalContext = /\b(i|me|my|mine|we|our)\b/i.test(text)
    || /\b(now|currently|today|just happened|during training|after sparring|after (?:a|that|the) hit)\b/i.test(text);
  const hasUrgentSymptom = /(can(?:not|'t)\s+breathe|shortness\s+of\s+breath|trouble\s+breathing|blurr(?:y|ed)?\s+vision|vision.{0,12}blurr(?:y|ed)?|double\s+vision|can(?:not|'t)\s+see|seeing\s+stars|seizure|convulsion|headache|nausea|nauseous|neck.{0,20}(numb|weak|tingl)|severe\s+bleeding|bleeding.{0,20}(won't|will\s+not)\s+stop|abdominal\s+pain|stomach\s+pain|vomit(?:ing)?\s+blood|slurred\s+speech|unequal\s+pupils?|can(?:not|'t)\s+move|sudden\s+weakness)/i.test(text);
  const hasAcuteImpactConcern = /(?:after|from).{0,30}(?:hit|blow|punch|fall).{0,60}(?:pain|numb|weak|tingl|blur|bleed|dizz|confus|vomit|can(?:not|'t))/i.test(text);
  const hasPersonalHealthConcern = /\b(hurt|hurts|hurting|pain|painful|sore|soreness|swollen|swelling|injured|injury|sprain(?:ed|ing)?|strain(?:ed|ing)?|bruised|bruising|numb|numbness|tingling|stiff|stiffness)\b/i.test(text);

  // Direct prescription or weight-cutting directives are blocked even when phrased as questions.
  if (hasPrescriptionLanguage || hasRapidWeightCutLanguage) {
    return {
      valid: false,
      error: 'Medication and prescription recommendations require prescription authority and professional medical oversight.',
      highRisk: true,
      topic: classification.topic,
    };
  }

  // Educational queries are allowed
  if (classification.educationalApproach) {
    return {
      valid: true,
      highRisk: classification.isHighRisk,
      topic: classification.topic,
      classification: classification.isHighRisk ? classification.topic : undefined,
    };
  }

  if (hasPersonalContext && (hasUrgentSymptom || hasAcuteImpactConcern)) {
    return {
      valid: false,
      error: 'Potential emergency: stop participation and contact local emergency services or an onsite licensed medical professional now.',
      highRisk: true,
      topic: classification.topic === 'none' ? 'urgent_symptom' : classification.topic,
      classification: 'urgent_personal_symptom',
    };
  }

  if (hasPersonalContext && hasPersonalHealthConcern) {
    return {
      valid: false,
      error: 'Personal pain, injury, and treatment questions require evaluation by a qualified medical professional. SHADOW can only provide general educational information.',
      highRisk: true,
      topic: classification.topic,
      classification: 'personal_health_concern',
    };
  }

  // Check for diagnosis claims
  if (/(do|does|did|am|is|have)\s+(i|you)\s+(have|have a|get|got|experience).*(concussion|fracture|injury|condition|disease|syndrome|disorder)/i.test(text)) {
    return {
      valid: false,
      error: 'Diagnosis and personal health assessment require professional medical evaluation.',
      highRisk: true,
      topic: classification.topic,
    };
  }

  // Check for clearance claims
  if (
    /\bmedical\s+clear(?:ed|ance)?\b/i.test(text)
    || /\bclear(?:ed|ance)?\b.{0,40}\b(play|train|training|compete|competition|return|contact|spar|sparring)\b/i.test(text)
    || /\b(play|train|training|compete|competition|return|contact|spar|sparring)\b.{0,40}\bclear(?:ed|ance)?\b/i.test(text)
  ) {
    return {
      valid: false,
      error: 'Medical clearance decisions require professional medical authority.',
      highRisk: true,
      topic: classification.topic,
    };
  }

  // Check for prescription claims
  if (/(should|do|can|need)\s+(i|you)\s+(take|use|try|get).*(medicine|medication|drug|pill|injection)/i.test(text)) {
    return {
      valid: false,
      error: 'Medication and prescription recommendations require professional medical oversight.',
      highRisk: true,
      topic: classification.topic,
    };
  }

  if (classification.isHighRisk) {
    const emergencyTopic = (
      classification.topic === 'chest_pain'
      || classification.topic === 'fainting'
      || classification.topic === 'loss_of_consciousness'
    );
    return {
      valid: false,
      error: emergencyTopic
        ? 'Potential emergency: stop participation and contact local emergency services or an onsite licensed medical professional now.'
        : 'Personal high-risk health and safety concerns require immediate human evaluation. SHADOW can only provide general educational information.',
      highRisk: true,
      topic: classification.topic,
      classification: classification.topic,
    };
  }

  return { valid: true, highRisk: false, topic: 'none' };
}

// The one line excluded roles get in place of near-miss records.
//
// It is a statement about THIS CONTEXT, never about the athlete's records,
// and it is returned identically whether or not events exist. The three
// strings below it are all traps if reused here: "No near-miss events
// recorded" is a false statement for an athlete who has them; the
// retrieval-failed line is worse, because its conservative-progression
// directive would appear only when there was something to withhold, so the
// model's own caution would signal that events exist. Withholding that
// leaks by implication is not withholding.
const NEAR_MISS_CONTEXT_WITHHELD =
  'Recorded safety events are not available in this context. For intensity, contact, or progression questions, defer to the athlete\'s coach.';

// Retrieve context based on user role and authorization
export async function retrieveShadowContext(params: {
  userRole: PilotRole;
  userId: string;
  organizationId: string;
  actorAthleteId?: string | null;
  athleteId?: string;
}): Promise<ShadowContextResult> {
  const { userRole, userId, organizationId, actorAthleteId = null, athleteId } = params;

  if (athleteId) {
    try {
      await assertActorCanAccessAthlete(
        {
          accountId: userId,
          role: userRole,
          organizationId,
          athleteId: actorAthleteId,
        },
        athleteId,
      );
    } catch {
      return {
        context: '',
        authorized: false,
        reason: 'Not authorized to access this athlete context.',
      };
    }
  }

  if (!athleteId) {
    // Org-scoped context is a static authorization statement; safe to cache.
    const cacheKey = `${organizationId}:${userRole}:org`;
    const cached = getCachedContext(cacheKey);
    if (cached) return { context: cached, authorized: true };
    const context = `Authorized role: ${userRole}. Authorized organization scope: ${organizationId}. Athlete-specific data is not authorized for this request.`;
    setCachedContext(cacheKey, context);
    return { context, authorized: true };
  }

  // Athlete-scoped context is NOT cached (a comment used to claim this while
  // the code cached it anyway; with only a static string inside, the lie was
  // harmless -- with safety records inside, it is not): a near miss flagged a
  // minute ago must be in the very next answer about that athlete.
  //
  // Near misses are the one athlete record where silence is dangerous: an
  // intensity question answered blind to yesterday's critical event is the
  // repeat incident the table exists to prevent. SCOPE OF THAT SENTENCE
  // CHANGED 2026-09-26 and it is no longer true of every caller: under
  // OD-2026-09-26-002 athletes and parents no longer receive these records,
  // so for them the model IS answering blind, by owner decision, and gets a
  // fixed instruction to defer to the coach instead. The reasoning below
  // still governs the roles that do receive them. Each event carries its
  // near_miss_id as a citable evidence id, mirroring the platform-rollup
  // pattern, so the model can reference recorded events without the response
  // validator discarding them as uncited claims.
  const header = `Authorized role: ${userRole}. Authorized organization: ${organizationId}. Authorized athlete scope: ${athleteId}.`;

  // AUDIENCE GATE -- owner decision 2026-09-26, recorded open since 2026-08-28.
  //
  // Near-miss `description` is unsanitised coach free text about a youth
  // roster. Every role that cleared assertActorCanAccessAthlete above used to
  // reach the read below, so the path COULD place that text into athlete and
  // parent prompt context even though GET /api/pilot/shadow/near-misses
  // denies those roles -- the same records, the same organization, one
  // surface gated and the other not. Whether it ever actually did is not
  // asserted here and was not measured: no conversation, database or log was
  // read, and the owner states none was sent.
  //
  // DECISION_LOOP_ROLES is the list that route already requires, so neither
  // surface carries its own literal. That is worth something, but it is NOT
  // proof the two cannot diverge: the route decides membership with
  // requireRole, which treats legacy `admin` and `organization_admin` as one
  // role, while this uses a strict .includes. Sharing a constant is not
  // sharing a decision. An executable test runs this gate for every role and
  // compares the observed result with the real requireRole, so rewriting the
  // condition below breaks it. What no test here catches is the route
  // swapping in a DIFFERENT list -- both sides would move together.
  // The gate refuses every role outside the set.
  // access.ts
  // additionally refuses platform_owner and board before this point, which is
  // READ FROM that module rather than exercised here -- which is why the
  // tests enumerate the whole PilotRole union instead of relying on it.
  //
  // The gate is BEFORE the query, not a filter after it: an excluded role
  // must not cause the read, carry an evidence id, or learn from the shape of
  // the answer whether anything is on file. Their ACCESS is unchanged -- this
  // removes the safety records, not the athlete scope -- but their context
  // string is not: an athlete with no events on record used to be told so
  // explicitly, and now gets the same deferral line as everyone excluded.
  // Only the authorization header survives untouched.
  if (!DECISION_LOOP_ROLES.includes(userRole)) {
    return {
      context: `${header}\n${NEAR_MISS_CONTEXT_WITHHELD}`,
      authorized: true,
      evidenceIds: [],
    };
  }

  try {
    const nearMisses = await listRecentNearMisses(organizationId, athleteId);
    if (nearMisses.length === 0) {
      return {
        context: `${header}\nNo near-miss events recorded for this athlete in the last 90 days.`,
        authorized: true,
        evidenceIds: [],
      };
    }
    const lines = nearMisses.map((nearMiss) => {
      const date = String(nearMiss.created_at).slice(0, 10);
      const description = nearMiss.description.replace(/\s+/g, ' ').slice(0, 240);
      return `- [E:${nearMiss.near_miss_id}] ${date} ${nearMiss.severity.toUpperCase()}: ${description}`;
    });
    const hasSevere = nearMisses.some(
      (nearMiss) => nearMiss.severity === 'high' || nearMiss.severity === 'critical',
    );
    return {
      context: [
        header,
        `RECORDED NEAR-MISS EVENTS for this athlete (organization records, last 90 days, most severe first):`,
        ...lines,
        'Safety directive: factor these recorded events into any intensity, contact, or progression guidance, and cite the event id when referencing one.'
          + (hasSevere
            ? ' A HIGH or CRITICAL event is on record: recommend the coach reviews it before any increase in load or contact.'
            : ''),
      ].join('\n'),
      authorized: true,
      evidenceIds: nearMisses.map((nearMiss) => nearMiss.near_miss_id),
    };
  } catch (error) {
    // Fail honest, not silent: answering as if the record had been checked
    // when it could not be read is the unsafe outcome. The model is told the
    // history is unknown so its guidance stays conservative.
    console.error('SHADOW near-miss retrieval unavailable', {
      errorClass: error instanceof Error ? error.name : typeof error,
    });
    return {
      context: `${header}\nNear-miss records could not be retrieved for this request. Treat this athlete's recorded-incident history as unknown and advise conservative progression.`,
      authorized: true,
      evidenceIds: [],
    };
  }
}

// Validate and filter LLM response before display
export function validateShadowResponse(
  response: string,
  options: { allowedEvidenceIds?: string[]; verifiedSourceIds?: string[] } = {},
): ShadowResponseValidation {
  let filtered = false;
  const reasons: string[] = [];
  const reasonCodes: ShadowFilterReasonCode[] = [];
  // One call site per rule, so the code and the sentence cannot drift apart --
  // the previous shape had the sentence written inline at eleven separate
  // pushes, which is exactly how a reworded duplicate gets introduced.
  const flag = (code: ShadowFilterReasonCode) => {
    reasonCodes.push(code);
    reasons.push(SHADOW_FILTER_REASONS[code]);
  };
  let message = response;
  const normalized = response.toLowerCase().replace(/\s+/g, ' ');

  // Check for diagnosis claims.
  //
  // The second pattern's gap was an unbounded `.*`, so prevention advice --
  // "warm up so you don't get a shoulder strain", the opposite of a diagnosis
  // -- matched "you ... get ... strain" across the whole line and withheld the
  // answer. Measured live on 2026-07-30, this was the largest source of
  // filtered benign answers (a warm-up answer that never mentions injury
  // prevention is a bad warm-up answer). The gap is now bounded, and a match
  // immediately preceded by prevention or negation language is not treated as
  // a diagnosis. Real diagnoses still filter -- "you have a concussion" is
  // also caught by the first pattern, which is untouched.
  // The first pattern also fired on conditional deferral -- "If you have
  // shoulder pain or a recent injury, get cleared by a medical professional"
  // is DOCTRINE-mandated language, and it was withheld as a diagnostic claim
  // (measured live 2026-07-30: half of all filtered warm-up answers were the
  // model saying exactly this). A match whose subject is introduced by a
  // conditional is hypothetical, not an assertion about this athlete.
  // The subject alternation was second-person plus 'the athlete', so a
  // third-person diagnosis passed clean. Measured 2026-07-31:
  //   'The athlete has a rotator cuff injury.'    -> filtered
  //   'He has a concussion.'                      -> NOT filtered
  //   'She has a fracture in the left wrist.'     -> NOT filtered
  // Same claim, same harm, different pronoun. This became load-bearing with
  // Film Study (#128): a vision model describing a child in frames writes
  // 'he' and 'she' by default, so the surface most likely to produce a
  // diagnosis was the one the filter did not read.
  //
  // Widened only -- the exemptions below are untouched, because loosening
  // them for existing subjects would be a weakening this fix has no mandate
  // for.
  let makesDiagnosisClaim = false;
  const assertedDiagnosisPattern = /\b(you|your symptoms|his symptoms|her symptoms|their symptoms|the athlete|the boxer|the fighter|the kid|this|he|she|they)\b.{0,40}\b(have|has|definitely|confirm|confirms|proves|means)\b.{0,60}\b(concussion|fracture|injury|disease|syndrome|disorder|condition)\b/g;
  // Clause-scoped: a conditional anywhere earlier in the same clause makes the
  // subject hypothetical ("if at any point you have sharp pain, stop"). The
  // window stops at sentence punctuation so a conditional in a PREVIOUS
  // sentence cannot excuse an assertion in this one. "should" is deliberately
  // not a cue: "you should see a doctor because you have a concussion" is an
  // asserted diagnosis and must keep filtering.
  const conditionalCue = (preceding: string) => {
    const clause = preceding.split(/[.!?;\n]/).pop() ?? '';
    return /\b(if|when|whenever|unless|in case)\b/.test(clause);
  };
  // The prevention exemption belongs to BOTH patterns, not just the second.
  //
  // It was written for the second pattern and deliberately not extended here
  // ("widened only -- the exemptions below are untouched"), which left this one
  // filtering the same prevention advice the other one forgives, purely because
  // of which subject the sentence used. Measured 2026-08-01:
  //   'so you do not get a strain'              -> passed (second pattern, exempt)
  //   'this means a higher injury risk'         -> FILTERED
  //   'they have a higher injury risk off balance' -> FILTERED
  // All three are injury-PREVENTION coaching, and the last two are what "name a
  // common fault to watch for" produces. Asserted diagnoses are unaffected: "he
  // has a concussion" carries no prevention cue and still filters.
  const preventionCue = /(reduc|lower|prevent|avoid|risk|chance|less\s+likely|protect|keep\w*\s+you\s+from|don.?t|do\s+not|won.?t|shouldn.?t|without)/i;
  for (const match of normalized.matchAll(assertedDiagnosisPattern)) {
    const preceding = normalized.slice(Math.max(0, (match.index ?? 0) - 60), match.index ?? 0);
    // The prevention word usually lands AFTER the ailment, because the pattern
    // stops at it: "a higher injury| risk". So the window runs past the match as
    // well, and stops at sentence punctuation for the same reason conditionalCue
    // does -- "the athlete has a rotator cuff injury." ends immediately and stays
    // filtered, while "...a higher injury risk landing off balance" does not.
    const following = normalized
      .slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 40)
      .split(/[.!?;\n]/)[0] ?? '';
    if (!conditionalCue(preceding) && !preventionCue.test(preceding + match[0] + following)) {
      makesDiagnosisClaim = true;
      break;
    }
  }
  if (!makesDiagnosisClaim) {
    const diagnosisPattern = /you (have|have a|got|get|experience|develop)\b.{0,30}?\b(?:concussion|fracture|injury|pain|sprain|strain|trauma|condition|disease|syndrome|disorder)/gi;
    for (const match of response.matchAll(diagnosisPattern)) {
      const preceding = response.slice(Math.max(0, (match.index ?? 0) - 60), match.index ?? 0);
      if (!preventionCue.test(preceding) && !conditionalCue(preceding.toLowerCase())) {
        makesDiagnosisClaim = true;
        break;
      }
    }
  }
  // CL-C8 (2026-10-05 audit, measured by Codex at 6736bac7). Both patterns
  // above name a fixed subject, a fixed verb and seven ailments, so the same
  // diagnosis passed clean when the model used a name ("Example Athlete has a
  // concussion"), a copula ("That's a concussion", "This is a sprained
  // ankle"), a contraction ("You've torn your ACL") or an ailment off the list
  // ("You have tendinitis"). Under the ruling that in-app AI is never
  // diagnostic, the shape of the sentence is not the boundary.
  //
  // Added, never loosened: the two patterns above are untouched, and these
  // carry the same conditional and prevention exemptions, so "If you have
  // tendinitis, a clinician should evaluate it" and "a higher injury risk"
  // still pass. Generic framing is kept out structurally rather than by
  // listing sentences: a gap word that turns the noun into a category ("a
  // COMMON injury", "a sign OF"), a relative or generic subject ("an athlete
  // WHO has", "EVERYONE has"), and a record-keeping noun after the ailment
  // ("an injury LOG") each stop the match.
  if (!makesDiagnosisClaim) {
    const folded = normaliseForMatching(response).toLowerCase().replace(/\s+/g, ' ');
    const ailment = String.raw`(?:concussion|fracture|injury|disease|syndrome|disorder|condition|sprain(?:ed)?|strain(?:ed)?|tear|torn|ruptured?|dislocat\w*|separated\s+shoulder|hernia|herniat\w*|whiplash|contusion|[a-z]+itis|stress\s+reaction|shin\s+splints|broken|fractured)\b`;
    const notARecord = String.raw`(?!\s*(?:risk|prevention|protocol|log|report|record|history|rate|policy|plan|program|management|screen|check|form|list|data|database|question|topic|test|assessment|education|awareness)\b)`;
    const gap = String.raw`(?:(?!(?:what|how|why|where|which|about|of|for|on|in|to|with|from|at|by|question|topic|common|typical|type|kind|form|sign|example|risk|part|way|reason|cause|reported|recorded|logged|documented|previous|prior|past|different)\b)[a-z'-]+\s+){0,3}?`;
    const determiner = String.raw`(?:(?:a|an|the|some|your|his|her|their)\s+)?`;
    const widenedPatterns = [
      // Copula: "that's a concussion", "this sounds like a torn rotator cuff".
      new RegExp(String.raw`(?:\b(?:that|this)(?:'s|\s+is|\s+(?:looks|sounds|seems)\s+like)|\b(?:looks|sounds|seems)\s+like)\s+${determiner}${gap}${ailment}${notARecord}`, 'g'),
      // Any singular subject, a name included: "Jake has a concussion".
      new RegExp(String.raw`\b(?!(?:who|that|which|one|anyone|someone|everyone|nobody|whoever|each|every|gym|program)\b)[a-z][a-z-]*(?:\s+has|'s\s+got|\s+has\s+got)\s+(?:(?:probably|likely|definitely|clearly|already)\s+)*${determiner}${gap}${ailment}${notARecord}`, 'g'),
      // Injury verbs: "you've torn your ACL", "he sprained his wrist".
      /\b(?:you|he|she|they|the\s+(?:athlete|boxer|fighter|kid))(?:'ve|\s+have|\s+has|'s)?\s+(?:(?:probably|likely|definitely|clearly|just|already)\s+)*(?:torn|tore|sprained|strained|broke|broken|fractured|dislocated|ruptured|herniated|separated|pulled|concussed)\s+(?:your|his|her|their)\b(?!\s+(?:personal\s+)?(?:record|best|pr|weight)\b)/g,
      // The second pattern's own shape, with the ailments it did not list.
      new RegExp(String.raw`\byou(?:'ve|\s+have|\s+got)\s+${determiner}${gap}${ailment}${notARecord}`, 'g'),
    ];
    for (const pattern of widenedPatterns) {
      for (const match of folded.matchAll(pattern)) {
        const index = match.index ?? 0;
        const preceding = folded.slice(Math.max(0, index - 60), index);
        const following = folded.slice(index + match[0].length, index + match[0].length + 40).split(/[.!?;\n]/)[0] ?? '';
        if (!conditionalCue(preceding) && !preventionCue.test(preceding + match[0] + following)) {
          makesDiagnosisClaim = true;
          break;
        }
      }
      if (makesDiagnosisClaim) break;
    }
  }
  if (makesDiagnosisClaim) {
    filtered = true;
    flag('diagnostic_claim');
  }

  // Check for direct prescription claims. The drug list named two generics
  // and no brand, so "Take two Advil" passed (CL-C8); the common
  // over-the-counter names and the supplements athletes are told to take
  // are listed now.
  if (
    /\b(take|taking|start|stop|increase|decrease|double|dose|use)\b.{0,40}\b(medication|medicine|drug|pill|ibuprofen|acetaminophen|supplement|injection|advil|motrin|aleve|naproxen|aspirin|tylenol|paracetamol|nsaids?|painkillers?|pain\s+relievers?|melatonin|creatine|caffeine|antibiotics?|prednisone|steroids?)\b/.test(normalized)
  ) {
    filtered = true;
    flag('prescriptive_claim');
  }

  // Minute-scale rest is training vocabulary, not a medical directive.
  //
  // This rule exists for "rest for two weeks" after an injury. It also fired on
  // "work 3 minutes, rest 1 minute before rotating" -- the ordinary way to write
  // a bag circuit -- and withheld the whole answer as a treatment directive.
  // Measured 2026-08-01 against the staging E2E gate's own question ("plan a
  // four-station heavy bag circuit for a 60-minute youth class"), which cannot
  // be answered well without stating rest intervals.
  //
  // The tell that this was wrong: "rest 20 seconds" passed and "rest 1 minute"
  // did not, because `seconds` was never in the unit list. The same coaching
  // instruction filtered or not depending on which unit the model chose, which
  // is a coin flip, not a safety boundary.
  //
  // Injury rest that needs medical authority is measured in hours, days or
  // weeks, so those keep filtering. Icing keeps `minutes` on its own rule below,
  // because ice genuinely is a minute-scale medical instruction.
  if (
    /\b(?:rest|avoid\s+training)\s+(?:for\s+)?\d+(?:\.\d+)?\s*(?:hours?|days?|weeks?)\b/.test(normalized)
    || /\b(?:ice|apply\s+ice)\b.{0,30}\b\d+(?:\.\d+)?\s*(?:minutes?|hours?)\b/.test(normalized)
    || /\b(?:start|begin|do|perform)\b.{0,25}\b(?:rehab|rehabilitation|therapeutic)\b/.test(normalized)
    || /\b(?:you\s+(?:should|need\s+to|must)|i\s+recommend(?:\s+that)?\s+you)\b.{0,60}\b(?:ice|immobilize|tape|compress|elevate|massage|rehab|treat)\b/.test(normalized)
  ) {
    filtered = true;
    flag('treatment_directive');
  }

  // Check for clearance claims
  if (
    /(you are|you're).*cleared|you.*cleared to|you.*cleared for/i.test(response)
    || /\b(you are|the athlete is|safe to|may now|can now)\b.{0,40}\b(cleared|return to play|return to training|resume contact|compete)\b/.test(normalized)
  ) {
    filtered = true;
    flag('clearance_claim');
  }

  if (
    /\b(system prompt|api key|secret|password|other organization|another tenant)\b.{0,80}\b(is|equals|contains|show|reveal|access)\b/.test(normalized)
  ) {
    filtered = true;
    flag('disclosure_risk');
  }

  if (
    /\b(ignore|disregard|override|do not contact)\b.{0,50}\b(doctor|physician|clinician|medical professional|coach|policy)\b/.test(normalized)
  ) {
    filtered = true;
    flag('authority_override');
  }

  // Weight cutting was gated on the REQUEST only. A response that volunteered a
  // weight-cut directive -- to a question that never mentioned weight -- passed
  // with no filter, and because the handoff topic was taken from the request,
  // no weight-cut handoff banner either. Rapid weight loss in a youth combat
  // sport is exactly the guidance that must not reach an athlete unreviewed, so
  // the response is now gated on the same topic as the request.
  //
  // Scoped to directives and dehydration methods rather than the words "weight
  // loss", so educational answers about risks and safe management -- which the
  // request validator explicitly allows -- are not swept up.
  const makesWeightCutDirective = (
    /\b(?:cut|cutting|drop|shed|lose)\b.{0,30}\b(?:water\s+weight|\d+(?:\.\d+)?\s*(?:pounds?|lbs?|kilograms?|kgs?))\b/i.test(response)
    || /\b(?:sauna|sweat\s*suit|water\s+load(?:ing)?|dehydrat(?:e|ing)|restrict(?:ing)?\s+(?:fluids?|water))\b/i.test(response)
    || /\b(?:you\s+(?:should|can|need\s+to|must)|i\s+recommend(?:\s+that)?\s+you|to\s+make\s+weight)\b.{0,60}\b(?:cut\s+weight|make\s+weight|drop\s+(?:a|to)\s+.{0,20}weight\s+class)\b/i.test(response)
  );
  if (makesWeightCutDirective) {
    filtered = true;
    flag('weight_cut_directive');
  }

  const allowedEvidenceIds = new Set(
    (options.allowedEvidenceIds ?? options.verifiedSourceIds ?? [])
      .filter((evidenceId) => (
        typeof evidenceId === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(evidenceId)
      )),
  );
  const citationMatches = [...response.matchAll(/\[E:([^\]\r\n]{1,200})\]/gi)];
  const citationIds: string[] = [];
  let hasInvalidCitation = false;
  let validCitationOccurrences = 0;
  for (const match of citationMatches) {
    const evidenceId = match[1]?.trim() ?? '';
    if (!allowedEvidenceIds.has(evidenceId)) {
      hasInvalidCitation = true;
      continue;
    }
    validCitationOccurrences += 1;
    if (!citationIds.includes(evidenceId)) citationIds.push(evidenceId);
  }
  if (/\[E:/i.test(response) && citationMatches.length === 0) {
    hasInvalidCitation = true;
  }
  if (hasInvalidCitation) {
    filtered = true;
    flag('unauthorized_citation');
  }
  const makesEvidenceClaim = (
    /\b(research|studies?|data|evidence|clinical guidance|literature)\s+(suggests?|shows?|indicates?|demonstrates?|proves?|supports?)\b/i.test(response)
    // "proven" asserts the platform's TOP evidence tier, and DOCTRINE item 4
    // forbids using it without verified evidence ids for the exact claim. It
    // was not a trigger at all, so "this drill is proven to increase punch
    // power" passed while the same claim framed as "data shows" was filtered --
    // the framing was policed, the assertion was not.
    //
    // \bproven\b does not match "unproven" (no boundary after "un"), so hedged
    // language stays allowed.
    || /\b(?:clinically|scientifically|medically)?\s*proven\b/i.test(response)
  );
  // The trailing \b after % could never match: '%' and whatever follows it are
  // both non-word characters, so no boundary exists there. Every percentage in
  // every response therefore slipped this check -- "94% of athletes improve"
  // passed, and only the separate "data shows" framing above caught the variant
  // that happened to carry it.
  //
  // Not every percentage is an evidence claim, though. Two forms of coaching
  // speech were measured live (2026-07-30) tripping this rule and withholding
  // benign answers:
  //   * intensity instruction -- "round 1 at 50% effort", "build to 80%"
  //   * the platform's own KEY PHRASE, "10% coach, 90% athlete", which the
  //     system prompt tells the model to use naturally
  // Those are stripped before the test. The strip is deliberately narrow:
  // "at/to N%" (optionally followed by an effort word) and "N% effort/
  // intensity/power/speed/pace/max/capacity". Quantified assertions -- "94% of
  // athletes", "raises heart rate by 20%" -- do not match either form and
  // still filter without a citation.
  const quantSource = response
    .replace(/\b10\s*%\s*coach\b[^.\n]{0,10}\b90\s*%\s*athlete\b/gi, '')
    .replace(/\b(?:at|to)\s+\d+(?:\.\d+)?\s*%(?:\s*(?:of\s+max(?:imum)?|effort|intensity|power|speed|pace|capacity))?(?!\s*of\b)/gi, '')
    .replace(/\b\d+(?:\.\d+)?\s*%\s*(?:effort|intensity|power|speed|pace|max(?:imum)?|capacity)\b/gi, '');
  // The count-noun branch was one alternation over cases/athletes/participants/
  // studies, which read every roster count as a sample size. 'cases' and
  // 'studies' are inherently evidentiary -- counting them IS stating a sample.
  // 'athletes' and 'participants' are not: in a session plan they are how many
  // people stand where. Measured 2026-08-01, this is what withheld the
  // background Heavy Bag answer and failed the staging gate on 0f47b35 --
  // step 14 asks for a four-station circuit for a 60-minute youth class, and
  // no good answer to that avoids saying how many athletes go to a station
  // ("split the 12 athletes into four groups", "3 athletes per station").
  // Both retries filtered because the trigger is in the question, not in the
  // phrasing, so the retry policy could never clear it.
  //
  // Handled in two layers, because one alone leaks in a direction that matters.
  //
  // The first fix here stripped known allocation phrasings and kept filtering
  // any count that survived. That is the safe direction for an unrecognized
  // phrasing, but a sweep of 34 realistic benign answers (2026-08-02) still
  // found 3 withheld -- "keep the beginner class to 8 athletes", "one coach for
  // every 6 athletes", "with only 5 bags and 14 athletes". Planning speech is
  // unbounded, so a strip will always trail it, and every miss is a coach told
  // SHADOW withheld an answer to a fair question. Nobody reports those; they
  // just stop trusting it.
  //
  // Asserting a population count, by contrast, IS enumerable. So layer 2
  // inverts: a people-count only reads as evidence inside an assertion frame --
  // possession/existence ("Alpha Boxing has 12 athletes", "there are 30
  // athletes enrolled"), a sample draw ("7 out of 10 athletes", "247 similar
  // athletes"), or an observed outcome ("300 athletes improved"). Anything else
  // is somebody planning a session.
  //
  // Layer 1 is kept in front of it so an allocation that happens to sit near an
  // assertion verb ("there are 3 athletes at each station") is removed before
  // layer 2 ever reads it. Neither layer alone gets both cases right.
  const peopleCountSource = quantSource
    // "3 athletes per bag", "4 athletes per station"
    .replace(/\b\d+\s+(?:athletes?|participants?)\s+per\b/gi, '')
    // "groups of 3 athletes", "pairs of 2 participants"
    .replace(/\b(?:groups?|pairs?|teams?|waves?|lines?|rotations?)\s+of\s+\d+\s+(?:athletes?|participants?)\b/gi, '')
    // "3 athletes at each station", "4 athletes to every bag". Deliberately
    // only each/every -- widening this to a/the swallowed "45 athletes in the
    // program", which is a rollup, not an allocation.
    .replace(/\b\d+\s+(?:athletes?|participants?)\s+(?:at|to|on|in)\s+(?:each|every)\b/gi, '')
    // "for every 6 athletes", "per 8 participants"
    .replace(/\b(?:for\s+)?(?:every|each|per)\s+\d+\s+(?:athletes?|participants?)\b/gi, '')
    // Instruction-led allocation: "split the 12 athletes", "keep the beginner
    // class to 8 athletes". The window is wide because the noun phrase between
    // the verb and the count is arbitrary ("the beginner class to").
    .replace(/\b(?:split|divide|put|place|pair|group|assign|rotate|send|line|keep|cap|limit|run|start|stagger|alternate|bring|take|fit|seat|host)\b[^.\n]{0,40}?\b\d+\s+(?:athletes?|participants?)\b/gi, '')
    // "4 athletes rotate through", "3 athletes work the bag"
    .replace(/\b\d+\s+(?:athletes?|participants?)\s+(?:rotate|work|go|move|start|begin|switch|cycle|share|train|hit|shadowbox|spar|wait|line)\b/gi, '')
    // Planning conditional: "with 8 participants you can run two stations",
    // "with only 5 bags and 14 athletes"
    .replace(/\bwith\s+(?:only\s+)?[^.\n]{0,30}?\b\d+\s+(?:athletes?|participants?)\b/gi, '');
  // Frames in which a people-count is an assertion about a population rather
  // than a plan for one.
  const assertsPopulationCount = (
    // "247 similar athletes" -- 'similar' is itself the comparison frame.
    /\b\d+\s+similar\s+(?:athletes?|participants?)\b/i.test(peopleCountSource)
    // "7 out of 10 athletes"
    || /\b\d+\s+out\s+of\s+\d+\s+(?:athletes?|participants?)\b/i.test(peopleCountSource)
    // "Alpha Boxing has 12 athletes", "there are 30 athletes enrolled",
    // "we tracked 40 participants"
    || /\b(?:has|have|had|there\s+(?:are|is|were|was)|serves?|served|enrolled|registered|tracked|surveyed|studied|observed|sampled)\b[^.\n]{0,30}?\b\d+\s+(?:athletes?|participants?)\b/i.test(peopleCountSource)
    // "300 athletes improved their guard". Deliberately excludes the copulas --
    // "6 athletes is what lets you correct faults" is a coaching ratio, not a
    // finding.
    || /\b\d+\s+(?:athletes?|participants?)\b[^.\n]{0,60}?\b(?:improv|show|report|demonstrat|experienc|recover|reduc|increas|decreas|respond|sustain|avoid|gain|drop)\w*\b/i.test(peopleCountSource)
  );
  const makesQuantifiedEvidenceClaim = (
    /\b\d+(?:\.\d+)?\s*%/i.test(quantSource)
    // 'cases' and 'studies' are inherently evidentiary -- counting them IS
    // stating a sample, in any sentence. Untouched.
    || /\b\d+\s+(?:similar\s+)?(?:cases?|studies?)\b/i.test(quantSource)
    || assertsPopulationCount
  );
  // Everything above this line only detects WHETHER the response makes an
  // evidence or quantitative claim at all -- it is intentionally untouched, so
  // none of the false-positive exemptions measured and tuned against it above
  // (percent-effort, roster allocation, prevention framing, etc.) change.
  //
  // The gate below used to stop at that yes/no: "citationIds.length === 0"
  // treated one valid citation anywhere in the response as license for every
  // evidence/quantitative claim in it, not just the one the citation actually
  // sits next to. "Attendance is 94% across the gym [E:<real-id>]. Also, 250
  // similar athletes fully recovered using this exact protocol with no
  // setbacks." has exactly one real citation, so citationIds.length was 1 --
  // already ">= 1" -- and the second sentence's fabricated case count and
  // outcome, which cites nothing, rode through uninspected. Counting
  // occurrences on both sides closes that: each claim-shaped phrase now needs
  // its own citation occurrence, though the same evidence id can still be
  // cited more than once to back more than one claim it actually supports.
  //
  // The counts below re-run the exact patterns already used for detection
  // above (globalized), so they can only disagree with makesEvidenceClaim /
  // makesQuantifiedEvidenceClaim on HOW MANY, never on whether -- a response
  // with zero claims still takes zero citations, unchanged from before.
  //
  // The people-count frames are summed by POSITION, not by frame. Summing the
  // frames independently double-counted a single claim phrase that satisfies
  // more than one of them, and that was called the safe direction to be wrong
  // in -- it is not. Measured 2026-08-10, three correctly-cited answers were
  // withheld by it:
  //   "There are 30 athletes enrolled who improved their guard [E:id]"
  //   "The gym serves 60 athletes and 40 improved this season [E:id]"
  //   "We tracked 40 participants who reported less soreness [E:id]"
  // Each is one claim wearing two frames ("there are"/"serves"/"tracked" plus
  // an outcome verb), so each demanded two citation occurrences and had one.
  // These are the organizational-rollup-with-an-outcome shape -- the most
  // useful answer an administrator can ask SHADOW for -- so over-counting here
  // withholds honest, sourced work.
  //
  // Keying on the offset of the count token itself makes one phrase cost one
  // citation however many frames cover it. #300's rider case is unaffected:
  // the fabricated "250 similar athletes" sits at a different offset from the
  // cited percentage, so it is still its own claim and still needs its own
  // citation.
  const countMatches = (source: string, pattern: RegExp) => [...source.matchAll(pattern)].length;
  const evidenceClaimCount = (
    countMatches(response, /\b(research|studies?|data|evidence|clinical guidance|literature)\s+(suggests?|shows?|indicates?|demonstrates?|proves?|supports?)\b/gi)
    + countMatches(response, /\b(?:clinically|scientifically|medically)?\s*proven\b/gi)
  );
  const PEOPLE_COUNT_FRAMES = [
    /\b\d+\s+similar\s+(?:athletes?|participants?)\b/gi,
    /\b\d+\s+out\s+of\s+\d+\s+(?:athletes?|participants?)\b/gi,
    /\b(?:has|have|had|there\s+(?:are|is|were|was)|serves?|served|enrolled|registered|tracked|surveyed|studied|observed|sampled)\b[^.\n]{0,30}?\b\d+\s+(?:athletes?|participants?)\b/gi,
    /\b\d+\s+(?:athletes?|participants?)\b[^.\n]{0,60}?\b(?:improv|show|report|demonstrat|experienc|recover|reduc|increas|decreas|respond|sustain|avoid|gain|drop)\w*\b/gi,
  ];
  // The token that identifies the claim is the count attached to the noun.
  // 'similar' has to be optional here or the comparison-population frame
  // ("247 similar athletes") yields no token at all and the claim stops being
  // counted -- which silently reopens #300's rider case. The trailing
  // lookahead takes the RIGHTMOST such token, because the 'out of' frame spans
  // two numbers ("7 out of 10 athletes") and the second is the one that counts.
  const COUNT_TOKEN =
    /\d+\s+(?:similar\s+)?(?:athletes?|participants?)(?![\s\S]*?\d+\s+(?:similar\s+)?(?:athletes?|participants?))/i;
  const claimedCountOffsets = new Set<number>();
  for (const frame of PEOPLE_COUNT_FRAMES) {
    for (const match of peopleCountSource.matchAll(frame)) {
      const inner = COUNT_TOKEN.exec(match[0]);
      if (!inner) continue;
      claimedCountOffsets.add((match.index ?? 0) + (inner.index ?? 0));
    }
  }
  const quantifiedClaimCount = (
    countMatches(quantSource, /\b\d+(?:\.\d+)?\s*%/gi)
    + countMatches(quantSource, /\b\d+\s+(?:similar\s+)?(?:cases?|studies?)\b/gi)
    + claimedCountOffsets.size
  );
  const totalEvidenceClaims = evidenceClaimCount + quantifiedClaimCount;
  if ((makesEvidenceClaim || makesQuantifiedEvidenceClaim) && validCitationOccurrences < totalEvidenceClaims) {
    filtered = true;
    flag('uncited_claim');
  }

  const hasDeferralLanguage = /professional|medical authority|clinician|doctor|physician|medical evaluation/i.test(response);
  const hasHumanReviewLanguage = /requires? professional medical evaluation|needs? professional medical evaluation|further study required|professional medical authority|clinician|doctor|physician/i.test(response);

  if (filtered && !hasDeferralLanguage) {
    flag('missing_deferral');
  }
  if (hasHumanReviewLanguage) {
    flag('human_review');
  }

  if (filtered) {
    message = SHADOW_SAFE_FILTERED_RESPONSE;
  }

  return {
    valid: !filtered,
    filtered,
    message,
    reasons,
    reasonCodes,
    requiresHumanReview: filtered || reasons.length > 0,
    citationIds: filtered ? [] : citationIds,
    ...(makesWeightCutDirective ? { topic: 'weight_cutting' } : {}),
  };
}

// SHADOW System Prompt — Punxsy Prominence Boxing & Fitness identity
export const SHADOW_SYSTEM_PROMPT = `You are SHADOW, the organizational intelligence system for Punxsy Prominence Boxing & Fitness.

PRIMARY ROLE:
Your primary role is organizational learning, not automatic knowledge or canned recommendations.
Recommendations are NOT your primary purpose.
Observations are the atomic unit of learning, not automatic knowledge.
Metrics inform decisions. Metrics do NOT make decisions.

CORE IDENTITY:
You are a tough but caring mentor who leads from the front.
You believe in building smart fighters, not short-career punching bags.
You value fight IQ, mental toughness, decision-making, and longevity over flashy technique.
Leadership is a service — you hold high standards while genuinely caring about your people.
You speak with dry, sarcastic, and occasionally dark humor when delivering reality checks.
Real growth comes from embracing discomfort.

CORE PHILOSOPHY:
- Smart fighters beat flashy fighters over time.
- Mental toughness and psychology matter more than physical talent.
- The coach's job: work hard enough that the athlete cannot outwork them 9-to-1.
- Discomfort is part of the process. "Embrace the suck."
- Real leaders get in the trenches with their people.

TONE:
- Tough but caring. Direct. Never sugarcoat or use toxic positivity.
- Use dry, sarcastic, or dark humor as a reality check when appropriate.
- Support after being direct — show you have their back.
- When speaking to younger athletes or kids, use cleaner language automatically.
- Vary your language every response. Never repeat the same joke, metaphor, or line you've
  used recently — if a phrase feels like a tag line you reach for by habit, that's the one
  to avoid this time. Personality comes from reacting specifically to what's in front of
  you, not from a signature line.

FLAVOR PHRASES (rare seasoning, not a script):
The lines below exist to show the register, not to be recited. Use at most one of them in
a response, only when it's the most natural way to say the thing — never as an opener or a
closer, and never in back-to-back responses.
"Smart fighters, not flashy ones" / "Embrace the suck" / "Get comfortable being uncomfortable"
"We're not building short-career punching bags here" / "10% coach, 90% athlete"
"Lead from the front" / "That's the sport"

DOCTRINE — NON-NEGOTIABLE:
1. Never diagnose a condition — redirect to a professional medical authority or clinician.
2. Never prescribe treatment or medication.
3. Never grant medical clearance or return-to-play approval.
4. Use PROVEN, EMERGING, or EXPERIMENTAL only when the authorized context supplies verified evidence IDs and an approved classification for the exact claim. Otherwise use RESEARCH NEEDED. Never invent case counts, success percentages, citations, confidence values, or outcomes.
5. Flag unknowns as research requirements — not guesses.
6. Defer all final decisions to coaches, athletes, or medical professionals.

TEACH FIRST — PAIN, INJURY, HEAD KNOCKS AND RECOVERY QUESTIONS:
Education creates safety. Answer these in this order:
1. Teach the thing. What it is, how it happens in boxing, what normal looks like, and what the warning signs look like. This is most of the answer.
2. Say what to tell the coach, and when. The coach decides training.
3. Last, in one sentence, say what you cannot do (diagnose, treat, clear) and who does.
Never open with what you cannot do. Never answer with only "see a professional". Do not reach for "stop and see a doctor" for every ache: teach the difference between worked-muscle soreness and the warning signs, then say plainly that warning signs mean stop and get it looked at. Do not prescribe exercises, stretches, ice, heat or medication as treatment.

PHRASING — A RESPONSE FILTER ENFORCES THIS:
Every answer you write passes through a safety filter before display. Unless the exact claim carries a verified evidence citation supplied in your authorized context, the filter WITHHOLDS your entire answer if it:
- phrases any claim as research/studies/data/evidence "shows", "suggests", "indicates", "demonstrates", "proves", or "supports"
- uses the word "proven" in any form
- states a percentage, or a count of cases, athletes, participants, or studies
Without a supplied evidence ID, explain WHY in plain coaching terms — mechanics, experience, first principles ("warming up raises muscle temperature so you can move faster with less strain") — never by appeal to research or numbers. A withheld answer reaches the athlete as "SHADOW filtered it before display", which teaches them nothing. Write so your answer can be delivered.

MEDICAL SAFETY:
Professional medical authority makes the final call on diagnosis, prescription, and clearance.

RESPONSE STRUCTURE:
1. Direct observation or reality check
2. Practical guidance (mindset first, technique second unless technique is the question)
3. Supporting pattern or reasoning in plain coaching language (see PHRASING — no uncited data claims)
4. Clear deferral to human authority when needed
5. Offer to dig deeper if appropriate

EXAMPLE — incomplete readiness data:
"The available readiness observation is below the recorded personal baseline, but the current inputs do not establish why.
Unknowns: sleep, soreness, nutrition, stress, session duration, and post-session RPE are incomplete or unverified. RESEARCH NEEDED.
Discuss the observation with the athlete and coach. If symptoms or a medical concern are present, defer to an appropriately qualified medical professional. Do not prescribe a training change from this observation alone."

EXAMPLE — diagnosis request ("I got hit and my head hurts, do I have a concussion?"):
"A concussion is a brain injury: a hit or a jolt makes the brain move fast inside the skull, and for a while it does not work right. You do not have to be knocked out. A headache after a head shot is one of the signs. So are feeling dizzy or foggy, trouble remembering the round, feeling sick, or light and noise bothering you. Signs can show up hours later.
Fighters sit out for a reason: a brain that is still healing gets hurt worse by the next hit.
Tell your coach today exactly what happened and how you feel, and stay out of sparring until you have been checked. I can't tell you whether you have one. A doctor does that."

EXAMPLE — soreness after training ("my shoulder is sore after sparring"):
"Shoulders do a lot in sparring: every punch, and every second you hold your guard. Worked-muscle soreness is dull and achy, often on both sides, and it eases as you warm up over a day or two.
These are different: sharp pain, pain in one exact spot, pain when you lift your arm, a pop you felt, weakness, numbness or tingling, or it getting worse instead of better. Those mean stop and get it looked at.
Tell your coach before your next session which one it sounds like and when it started. They decide what you do in training. I can't tell you what is wrong with it; a doctor or athletic trainer does that."

EXAMPLE — athlete phoned it in on bag work:
"You ghosted through that round and we both know it. Bag work isn't a breather between the rounds that count — it is one of the rounds that counts.
Reset and give me the next three like they're the ones someone's watching on tape. I'm not mad, I've just seen this movie before and it doesn't end with a good fighter.
What's actually going on — tired, bored, or just checked out today?"

EXAMPLE — routine technique question, no safety angle:
"Your rear hand drops an inch before the hook fires, which is basically mailing the other guy a postcard that it's coming.
Keep it tucked at your chin, load the turn from the hip, let your shoulder do the telegraphing your hand shouldn't. Drill it slow for a week before you try to make it look pretty — pretty comes after correct, not before.
Want a rep count to build that into this week's rounds?"`;


/**
 * Per-tier response budget, appended to the system prompt at call time.
 *
 * The base prompt carries no length guidance at all, and the measured result
 * was 14,000-17,000 characters per answer on every deployment (see the latency
 * table in shadowRouter.ts) -- an essay per chat turn, delivered after 33-95
 * seconds. Completion length is the one knob that improves readability,
 * latency, and token cost together, so the quick tiers get a hard word budget
 * while the deep-dive tiers keep long-form.
 *
 * The budget must never outrank doctrine: the prompt says so explicitly,
 * because a model told to be brief will otherwise trim the deferral first.
 */
export function buildResponseLengthPrompt(sessionType: string): string {
  if (sessionType === 'quick_round' || sessionType === 'recovery_round') {
    return `## RESPONSE LENGTH
- Keep the entire reply under about 150 words.
- Lead with the answer: one direct observation, one practical next step, then stop.
- Safety text always wins over the budget. Never shorten or drop a required medical deferral, handoff, or RESEARCH NEEDED label to save words.
- If the topic genuinely needs depth, give the short answer and offer a Heavy Bag Session for the deep dive.`;
  }

  return `## RESPONSE LENGTH
- Long-form is appropriate for this session type. Structure it with clear sections.
- Depth is not padding: every paragraph must add information. No restating the question, no filler summaries.`;
}

/**
 * Audience register, appended to the system prompt at call time.
 *
 * The base persona is written for one audience and protects younger readers
 * with a single line ("use cleaner language automatically"). The server knows
 * exactly who is asking -- the authenticated role arrives with every request --
 * so the register is selected here rather than left to the model's judgment.
 *
 * The athlete register assumes a minor. Athlete accounts in this organization
 * are predominantly youth boxers and the server does not know the requester's
 * age, so the plain reading level and clean language hold for every athlete.
 *
 * Humor is for every audience (owner, 2026-10-01: "dark humor for everyone
 * that part of the gym identity"). The athlete register used to forbid it,
 * which contradicted the base persona sitting above it in the same prompt.
 * What it carries instead is where the joke points -- at the mistake, not the
 * kid -- and that the kid still owns the mistake ("it should not take
 * responsibility away from the kid or make excuses for them"). Being treated badly by
 * someone else is the one thing named as not theirs to own; he kept hurt and
 * pain out of that sentence ("Hurt and pain go with boxing").
 */
export function buildRegisterPrompt(role: string): string {
  if (role === 'athlete') {
    return `## AUDIENCE REGISTER
You are speaking with an athlete. Assume they may be a minor.
- The gym's dry, dark, sarcastic humor is part of how this place talks. Use it the way a coach who likes the kid would: aim it at the mistake, the excuse or the situation, not at the kid. Keep the language clean.
- Hold them to it. Do not make excuses for them or take the responsibility off them: the mistake is theirs to own and theirs to fix. Being treated badly by someone else is not a mistake and not an excuse.
- Short sentences. Plain words -- about an 8th-grade reading level.
- Define any training or medical term in a few words the first time you use it.
- Point them toward their coach for decisions rather than toward long theory.`;
  }

  if (role === 'parent') {
    return `## AUDIENCE REGISTER
You are speaking with a parent or guardian. Assume no boxing or sports-science background.
- Plain language. Explain any technical or platform term the first time it appears, including evidence labels like RESEARCH NEEDED.
- Respectful. The gym's dry, dark humor is welcome: aim it at the situation, never at the parent or their child. Put the plain meaning beside any gym slang.
- Be clear about what needs a coach or medical professional, and how to reach one.`;
  }

  // Coaches, organization admins, staff, volunteers, board, platform owner:
  // the full technical register the base persona defines.
  return `## AUDIENCE REGISTER
You are speaking with staff. Use the full technical register: precise terminology, direct analysis, and the complete persona defined above.`;
}

/**
 * The system prompt as it should actually be sent: base doctrine and persona,
 * then the per-tier length budget, then the per-audience register.
 *
 * Callers pass the resolved session type and the authenticated role. The base
 * SHADOW_SYSTEM_PROMPT export stays untouched -- tests pin its contents, and
 * the doctrine must never vary by audience; only length and register do.
 */
export function composeShadowSystemPrompt(input: { role: string; sessionType: string }): string {
  return `${SHADOW_SYSTEM_PROMPT}

${buildResponseLengthPrompt(input.sessionType)}

${buildRegisterPrompt(input.role)}`;
}
