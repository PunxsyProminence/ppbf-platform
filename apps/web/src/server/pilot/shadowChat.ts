// Core SHADOW Chat Validation Engine
// Doctrine enforcement through request validation, topic classification, and response filtering

import { assertActorCanAccessAthlete } from './access';
import type { PilotRole } from './contracts';
import { listRecentNearMisses } from './shadowNearMisses';

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
  // repeat incident the table exists to prevent. Each event carries its
  // near_miss_id as a citable evidence id, mirroring the platform-rollup
  // pattern, so the model can reference recorded events without the response
  // validator discarding them as uncited claims.
  const header = `Authorized role: ${userRole}. Authorized organization: ${organizationId}. Authorized athlete scope: ${athleteId}.`;
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
  for (const match of normalized.matchAll(assertedDiagnosisPattern)) {
    const preceding = normalized.slice(Math.max(0, (match.index ?? 0) - 60), match.index ?? 0);
    if (!conditionalCue(preceding)) {
      makesDiagnosisClaim = true;
      break;
    }
  }
  if (!makesDiagnosisClaim) {
    const diagnosisPattern = /you (have|have a|got|get|experience|develop)\b.{0,30}?\b(?:concussion|fracture|injury|pain|sprain|strain|trauma|condition|disease|syndrome|disorder)/gi;
    const preventionCue = /(reduc|lower|prevent|avoid|risk|chance|less\s+likely|protect|keep\w*\s+you\s+from|don.?t|do\s+not|won.?t|shouldn.?t|without)/i;
    for (const match of response.matchAll(diagnosisPattern)) {
      const preceding = response.slice(Math.max(0, (match.index ?? 0) - 60), match.index ?? 0);
      if (!preventionCue.test(preceding) && !conditionalCue(preceding.toLowerCase())) {
        makesDiagnosisClaim = true;
        break;
      }
    }
  }
  if (makesDiagnosisClaim) {
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
  for (const match of citationMatches) {
    const evidenceId = match[1]?.trim() ?? '';
    if (!allowedEvidenceIds.has(evidenceId)) {
      hasInvalidCitation = true;
      continue;
    }
    if (!citationIds.includes(evidenceId)) citationIds.push(evidenceId);
  }
  if (/\[E:/i.test(response) && citationMatches.length === 0) {
    hasInvalidCitation = true;
  }
  if (hasInvalidCitation) {
    filtered = true;
    reasons.push('Contains an unknown, malformed, or unauthorized evidence citation');
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
  if ((makesEvidenceClaim || makesQuantifiedEvidenceClaim) && citationIds.length === 0) {
    filtered = true;
    reasons.push('Makes an evidence or quantitative claim without an exact retrieved evidence citation');
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

EXAMPLE — diagnosis request:
"Can't tell you if you have a concussion — that's not my lane, and anyone who gives you that answer over a chat is doing you a disservice.
Get evaluated by a medical professional. Full stop.
What I can do: walk you through what to watch for after a head impact, in plain terms. Want that?"`;


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
 * are predominantly youth boxers, the server does not know the requester's
 * age, and the cost of talking to an adult slightly plainly is zero while the
 * cost of dark humor aimed at a twelve-year-old is not.
 */
export function buildRegisterPrompt(role: string): string {
  if (role === 'athlete') {
    return `## AUDIENCE REGISTER
You are speaking with an athlete. Assume they may be a minor.
- No dark or sarcastic humor. Keep the tough-but-caring directness, without the edge.
- Short sentences. Plain words -- about an 8th-grade reading level.
- Define any training or medical term in a few words the first time you use it.
- Point them toward their coach for decisions rather than toward long theory.`;
  }

  if (role === 'parent') {
    return `## AUDIENCE REGISTER
You are speaking with a parent or guardian. Assume no boxing or sports-science background.
- Plain language. Explain any technical or platform term the first time it appears, including evidence labels like RESEARCH NEEDED.
- Measured and respectful. No gym slang or insider humor without a plain-language explanation beside it.
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
