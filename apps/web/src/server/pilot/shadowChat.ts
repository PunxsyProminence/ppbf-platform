// Core SHADOW Chat Validation Engine
// Doctrine enforcement through request validation, topic classification, and response filtering

import { assertActorCanAccessAthlete } from './access';
import type { PilotRole } from './contracts';

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
}

export interface ShadowResponseValidation {
  valid: boolean;
  filtered: boolean;
  message: string;
  reasons: string[];
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

// Classify high-risk topics and determine routing
export function classifyHighRiskTopic(userMessage: string): HighRiskClassification {
  const msg = userMessage.toLowerCase();

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
  const normalizedMessage = message.toLowerCase();

  const hasPrescriptionLanguage = /\b(prescribe|prescribed|prescribing|prescription|rx)\b/i.test(message)
    || /should\s+i\s+take/i.test(message)
    || /should\s+you\s+take/i.test(message)
    || /take\s+(?:this\s+)?(?:medication|medicine|drug|pill)/i.test(message);

  const hasRapidWeightCutLanguage = /how\s+do\s+i\s+cut\s+weight/i.test(message)
    || normalizedMessage.includes('lose weight quickly')
    || normalizedMessage.includes('cut weight for my weight class')
    || /\b(?:i\s+(?:need|have)\s+to|help\s+me|how\s+(?:can|do)\s+i)\b.{0,35}\bmake\s+weight\b/i.test(message)
    || /\b(?:i\s+(?:need|want|have)\s+to\s+)?lose\s+\d+(?:\.\d+)?\s*(?:pounds?|lbs?|kilograms?|kgs?)\s+(?:this|in\s+(?:a|one))\s+week\b/i.test(message);

  const hasPersonalContext = /\b(i|me|my|mine|we|our)\b/i.test(message)
    || /\b(now|currently|today|just happened|during training|after sparring|after (?:a|that|the) hit)\b/i.test(message);
  const hasUrgentSymptom = /(can(?:not|'t)\s+breathe|shortness\s+of\s+breath|trouble\s+breathing|blurr(?:y|ed)?\s+vision|vision.{0,12}blurr(?:y|ed)?|double\s+vision|can(?:not|'t)\s+see|seeing\s+stars|seizure|convulsion|headache|nausea|nauseous|neck.{0,20}(numb|weak|tingl)|severe\s+bleeding|bleeding.{0,20}(won't|will\s+not)\s+stop|abdominal\s+pain|stomach\s+pain|vomit(?:ing)?\s+blood|slurred\s+speech|unequal\s+pupils?|can(?:not|'t)\s+move|sudden\s+weakness)/i.test(message);
  const hasAcuteImpactConcern = /(?:after|from).{0,30}(?:hit|blow|punch|fall).{0,60}(?:pain|numb|weak|tingl|blur|bleed|dizz|confus|vomit|can(?:not|'t))/i.test(message);
  const hasPersonalHealthConcern = /\b(hurt|hurts|hurting|pain|painful|sore|soreness|swollen|swelling|injured|injury|sprain(?:ed|ing)?|strain(?:ed|ing)?|bruised|bruising|numb|numbness|tingling|stiff|stiffness)\b/i.test(message);

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
  if (/(do|does|did|am|is|have)\s+(i|you)\s+(have|have a|get|got|experience).*(concussion|fracture|injury|condition|disease|syndrome|disorder)/i.test(message)) {
    return {
      valid: false,
      error: 'Diagnosis and personal health assessment require professional medical evaluation.',
      highRisk: true,
      topic: classification.topic,
    };
  }

  // Check for clearance claims
  if (
    /\bmedical\s+clear(?:ed|ance)?\b/i.test(message)
    || /\bclear(?:ed|ance)?\b.{0,40}\b(play|train|training|compete|competition|return|contact|spar|sparring)\b/i.test(message)
    || /\b(play|train|training|compete|competition|return|contact|spar|sparring)\b.{0,40}\bclear(?:ed|ance)?\b/i.test(message)
  ) {
    return {
      valid: false,
      error: 'Medical clearance decisions require professional medical authority.',
      highRisk: true,
      topic: classification.topic,
    };
  }

  // Check for prescription claims
  if (/(should|do|can|need)\s+(i|you)\s+(take|use|try|get).*(medicine|medication|drug|pill|injection)/i.test(message)) {
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

  // Use cache for org-level context (athlete-specific queries are not cached)
  const cacheKey = `${organizationId}:${userRole}:${athleteId ?? 'org'}`;
  const cached = getCachedContext(cacheKey);
  if (cached) return { context: cached, authorized: true };

  const context = athleteId
    ? `Authorized role: ${userRole}. Authorized organization: ${organizationId}. Authorized athlete scope: ${athleteId}.`
    : `Authorized role: ${userRole}. Authorized organization scope: ${organizationId}. Athlete-specific data is not authorized for this request.`;
  setCachedContext(cacheKey, context);
  return { context, authorized: true };
}

// Validate and filter LLM response before display
export function validateShadowResponse(
  response: string,
  options: { allowedEvidenceIds?: string[]; verifiedSourceIds?: string[] } = {},
): ShadowResponseValidation {
  let filtered = false;
  const reasons: string[] = [];
  let message = response;
  const normalized = response.toLowerCase().replace(/\s+/g, ' ');

  // Check for diagnosis claims
  if (
    /\b(you|your symptoms|the athlete|this)\b.{0,40}\b(have|has|definitely|confirm|confirms|proves|means)\b.{0,60}\b(concussion|fracture|injury|disease|syndrome|disorder|condition)\b/.test(normalized)
    || /you (have|have a|got|get|experience|develop).*(?:concussion|fracture|injury|pain|sprain|strain|trauma|condition|disease|syndrome|disorder)/i.test(response)
  ) {
    filtered = true;
    reasons.push('Contains diagnostic claim without evidence or human deference');
  }

  // Check for direct prescription claims
  if (
    /\b(take|start|stop|increase|decrease|double|dose|use)\b.{0,40}\b(medication|medicine|drug|pill|ibuprofen|acetaminophen|supplement|injection)\b/.test(normalized)
  ) {
    filtered = true;
    reasons.push('Contains prescriptive claim without medical authority');
  }

  if (
    /\b(?:rest|avoid\s+training)\s+(?:for\s+)?\d+(?:\.\d+)?\s*(?:minutes?|hours?|days?|weeks?)\b/.test(normalized)
    || /\b(?:ice|apply\s+ice)\b.{0,30}\b\d+(?:\.\d+)?\s*(?:minutes?|hours?)\b/.test(normalized)
    || /\b(?:start|begin|do|perform)\b.{0,25}\b(?:rehab|rehabilitation|therapeutic)\b/.test(normalized)
    || /\b(?:you\s+(?:should|need\s+to|must)|i\s+recommend(?:\s+that)?\s+you)\b.{0,60}\b(?:ice|immobilize|tape|compress|elevate|massage|rehab|treat)\b/.test(normalized)
  ) {
    filtered = true;
    reasons.push('Contains a personal treatment directive without medical authority');
  }

  // Check for clearance claims
  if (
    /(you are|you're).*cleared|you.*cleared to|you.*cleared for/i.test(response)
    || /\b(you are|the athlete is|safe to|may now|can now)\b.{0,40}\b(cleared|return to play|return to training|resume contact|compete)\b/.test(normalized)
  ) {
    filtered = true;
    reasons.push('Contains clearance claim without medical authority');
  }

  if (
    /\b(system prompt|api key|secret|password|other organization|another tenant)\b.{0,80}\b(is|equals|contains|show|reveal|access)\b/.test(normalized)
  ) {
    filtered = true;
    reasons.push('May disclose protected instructions, secrets, or cross-tenant information');
  }

  if (
    /\b(ignore|disregard|override|do not contact)\b.{0,50}\b(doctor|physician|clinician|medical professional|coach|policy)\b/.test(normalized)
  ) {
    filtered = true;
    reasons.push('Attempts to override human authority');
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
    reasons.push('Contains a rapid weight-loss or dehydration directive without medical authority');
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
    reasons.push('Contains an unknown, malformed, or unauthorized evidence citation');
  }
  const evidenceClaimPattern = /\b(research|studies?|data|evidence|clinical guidance|literature)\s+(suggests?|shows?|indicates?|demonstrates?|proves?|supports?)\b|\b(?:clinically|scientifically|medically)?\s*proven\b/gi;
  // The trailing \b after % could never match: '%' and whatever follows it are
  // both non-word characters, so no boundary exists there. Every percentage in
  // every response therefore slipped this check -- "94% of athletes improve"
  // passed, and only the separate "data shows" framing above caught the variant
  // that happened to carry it.
  //
  // \bproven\b does not match "unproven" (no boundary after "un"), so hedged
  // language stays allowed. "proven" asserts the platform's TOP evidence tier,
  // and DOCTRINE item 4 forbids using it without verified evidence ids for the
  // exact claim -- it was not a trigger at all, so "this drill is proven to
  // increase punch power" passed while the same claim framed as "data shows"
  // was filtered. The framing was policed, the assertion was not.
  const quantifiedClaimPattern = /\b\d+(?:\.\d+)?\s*%|\b\d+\s+(?:similar\s+)?(cases?|athletes?|participants?|studies?)\b/gi;
  // Counted per occurrence, not just a yes/no over the whole response: a
  // single real citation used to "unlock" the rest of the message, so one
  // legitimate cited percentage rode alongside an unrelated, completely
  // fabricated case count with no citation of its own -- e.g. "Attendance is
  // 94% [E:<real-id>]. Also, 250 similar athletes fully recovered with no
  // setbacks." had citationIds.length === 1, which was already ">= 1", so
  // nothing caught the second, uncited claim. Requiring one valid citation
  // occurrence per claim occurrence closes that gap while still letting the
  // same evidence id be cited more than once for more than one claim it
  // actually backs.
  const evidenceClaimCount = [...response.matchAll(evidenceClaimPattern)].length;
  const quantifiedClaimCount = [...response.matchAll(quantifiedClaimPattern)].length;
  const totalEvidenceClaims = evidenceClaimCount + quantifiedClaimCount;
  if (totalEvidenceClaims > 0 && validCitationOccurrences < totalEvidenceClaims) {
    filtered = true;
    reasons.push('Makes more evidence or quantitative claims than it provides exact retrieved evidence citations for');
  }

  const hasDeferralLanguage = /professional|medical authority|clinician|doctor|physician|medical evaluation/i.test(response);
  const hasHumanReviewLanguage = /requires? professional medical evaluation|needs? professional medical evaluation|further study required|professional medical authority|clinician|doctor|physician/i.test(response);

  if (filtered && !hasDeferralLanguage) {
    reasons.push('Missing human deferral language');
  }
  if (hasHumanReviewLanguage) {
    reasons.push('Human review required');
  }

  if (filtered) {
    message = SHADOW_SAFE_FILTERED_RESPONSE;
  }

  return {
    valid: !filtered,
    filtered,
    message,
    reasons,
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

KEY PHRASES (use naturally):
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

MEDICAL SAFETY:
Professional medical authority makes the final call on diagnosis, prescription, and clearance.

RESPONSE STRUCTURE:
1. Direct observation or reality check
2. Practical guidance (mindset first, technique second unless technique is the question)
3. Supporting data, pattern, or reasoning with confidence marker
4. Clear deferral to human authority when needed
5. Offer to dig deeper if appropriate

EXAMPLE — incomplete readiness data:
"The available readiness observation is below the recorded personal baseline, but the current inputs do not establish why.
Unknowns: sleep, soreness, nutrition, stress, session duration, and post-session RPE are incomplete or unverified. RESEARCH NEEDED.
Discuss the observation with the athlete and coach. If symptoms or a medical concern are present, defer to an appropriately qualified medical professional. Do not prescribe a training change from this observation alone."

EXAMPLE — diagnosis request:
"Can't tell you if you have a concussion — that's not my lane, and anyone who gives you that answer over a chat is doing you a disservice.
Get evaluated by a medical professional. Full stop.
What I can do: share what research says about concussion recognition and what to watch for. Want that?"`;

