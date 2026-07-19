// Core SHADOW Chat Validation Engine
// Doctrine enforcement through request validation, topic classification, and response filtering

import { query } from './db';

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
  | 'none';

export interface HighRiskClassification {
  topic: HighRiskTopic;
  isHighRisk: boolean;
  confidenceLevel: number;
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
}

// Classify high-risk topics and determine routing
export function classifyHighRiskTopic(userMessage: string): HighRiskClassification {
  const msg = userMessage.toLowerCase();

  const topics: Array<[HighRiskTopic, RegExp]> = [
    ['concussion', /concuss/i],
    ['head_trauma', /(head|brain)\s+(trauma|injury)/i],
    ['loss_of_consciousness', /(loss|loss\s+of|lack)\s+of\s+consciousness|unconscious|passed\s+out/i],
    ['dizziness', /dizzy|dizziness|vertigo/i],
    ['dehydration', /dehydrat|dry|thirst/i],
    ['weight_cutting', /(weight.*cut|cut\s+weight|rapid\s+weight)/i],
    ['rapid_weight_loss', /rapid.*weight|fast\s+weight/i],
    ['chest_pain', /(chest|heart)\s+pain|cardiac/i],
    ['fainting', /faint|syncope/i],
    ['medication', /(take|taking|took)\s+(medicine|medication|drug|pill)/i],
    ['prescription', /prescrip|prescription|prescribed|Rx/i],
    ['surgery', /surgery|surgical|operation|operated/i],
    ['injection', /inject|shot|needle|vaccine/i],
    ['return_to_play', /(return.*play|cleared.*play|cleared\s+to)/i],
    ['medical_clearance', /(medical|doctor)\s+clear|cleared|clearance/i],
    ['youth_safety', /(minor|child|kid|young)\s+(safety|harm)/i],
  ];

  let classifiedTopic: HighRiskTopic = 'none';
  for (const [topic, pattern] of topics) {
    if (pattern.test(msg)) {
      classifiedTopic = topic;
      break;
    }
  }

  const isEducationalQuery = /what\s+(is|are)|why|how|research|understand|learn|educational|context|background/i.test(msg);

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
    none: {
      allowed: [],
      blocked: [],
    },
  };

  return {
    topic: classifiedTopic,
    isHighRisk: classifiedTopic !== 'none',
    confidenceLevel: isEducationalQuery ? 0.9 : 0.7,
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

  const hasPrescriptionLanguage = /\b(prescrib|rx)\b/i.test(message)
    || /should\s+i\s+take/i.test(message)
    || /should\s+you\s+take/i.test(message)
    || /take\s+(?:this\s+)?(?:medication|medicine|drug|pill)/i.test(message);

  const hasRapidWeightCutLanguage = /how\s+do\s+i\s+cut\s+weight/i.test(message)
    || normalizedMessage.includes('lose weight quickly')
    || normalizedMessage.includes('cut weight for my weight class');

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
    return { valid: true };
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
  if (/clear|cleared|cleared to|cleared for/i.test(message)) {
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

  return { valid: true };
}

// Retrieve context based on user role and authorization
export async function retrieveShadowContext(params: {
  userRole: string;
  userId: string;
  organizationId: string;
  athleteId?: string;
}): Promise<ShadowContextResult> {
  const { userRole, userId, organizationId, athleteId } = params;

  // Board members see organization-level aggregates only
  if (userRole === 'board_member' && athleteId) {
    return {
      context: '',
      authorized: false,
      reason: 'Board members view organization-level aggregates only, not athlete-specific context.',
    };
  }

  // Athletes can only access their own context
  if (userRole === 'athlete' && athleteId && userId !== athleteId) {
    return {
      context: '',
      authorized: false,
      reason: 'Athletes can only access their own context.',
    };
  }

  // Use cache for org-level context (athlete-specific queries are not cached)
  const cacheKey = athleteId ? `${organizationId}:${athleteId}` : `${organizationId}:org`;
  const cached = getCachedContext(cacheKey);
  if (cached) return { context: cached, authorized: true };

  // Coaches can only see assigned athletes in their organization
  if (userRole === 'coach' && athleteId) {
    let isAssigned = false;
    try {
      const rows = await query<{count: number}>(
        `SELECT 1 FROM pilot.coach_assignments 
         WHERE coach_id = $1 AND athlete_id = $2 AND organization_id = $3`,
        [userId, athleteId, organizationId],
      );
      isAssigned = rows.length > 0;
    } catch {
      isAssigned = false;
    }

    if (!isAssigned) {
      return {
        context: '',
        authorized: false,
        reason: 'Coach is not assigned to this athlete.',
      };
    }
  }

  // Retrieve context (simplified for MVP)
  const context = `Context for ${athleteId || userId} in organization ${organizationId}`;
  setCachedContext(cacheKey, context);
  return { context, authorized: true };
}

// Validate and filter LLM response before display
export function validateShadowResponse(response: string): ShadowResponseValidation {
  let filtered = false;
  const reasons: string[] = [];
  const message = response;

  // Check for diagnosis claims
  if (/you (have|have a|got|get|experience|develop).*(?:concussion|fracture|injury|pain|sprain|strain|trauma|condition|disease|syndrome|disorder)/i.test(response)) {
    filtered = true;
    reasons.push('Contains diagnostic claim without evidence or human deference');
  }

  // Check for direct prescription claims
  if (/\byou should\b/i.test(response)) {
    filtered = true;
    reasons.push('Contains prescriptive claim without medical authority');
  }

  // Check for clearance claims
  if (/(you are|you're).*cleared|you.*cleared to|you.*cleared for/i.test(response)) {
    filtered = true;
    reasons.push('Contains clearance claim without medical authority');
  }

  // Require confidence markers or human deferral
  const hasConfidenceMarker = /research|research requirement|unknown|unclear|requires|needs validation|evidence suggests|data shows|studies indicate/i.test(response);
  const hasDeferralLanguage = /professional|medical authority|clinician|doctor|physician|medical evaluation/i.test(response);
  const hasHumanReviewLanguage = /requires? professional medical evaluation|needs? professional medical evaluation|further study required|professional medical authority|clinician|doctor|physician/i.test(response);

  if (!hasConfidenceMarker && !hasDeferralLanguage && filtered) {
    reasons.push('Missing confidence markers or human deferral language');
  }

  if (!filtered && /research suggests|further study required|needs validation|unknown|unclear|you should\b/i.test(response)) {
    reasons.push('Requires human review');
  }

  if (hasConfidenceMarker || hasDeferralLanguage || hasHumanReviewLanguage) {
    reasons.push('Human review required');
  }

  return {
    valid: !filtered,
    filtered,
    message,
    reasons,
    requiresHumanReview: filtered || reasons.length > 0,
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
4. Always use confidence markers: PROVEN (50+ cases, 90%+ success) / EMERGING (10–49 cases, 60–89%) / EXPERIMENTAL (<10 or <60%) / RESEARCH NEEDED (insufficient data).
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

EXAMPLE — readiness drop:
"Readiness down 15% this week. That's your body telling you something — could be overtraining, poor sleep, stress, or all three. Embrace the suck, but work with it, not against it.
Suggestion: Reduce volume 15–20%, add a rest day. PROVEN — 247 similar cases, 94% improved in 5–7 days.
Unknowns: sleep, nutrition, stress — not tracked, which means we're guessing. That's a research gap.
Coach decides: don't implement anything without a conversation first."

EXAMPLE — diagnosis request:
"Can't tell you if you have a concussion — that's not my lane, and anyone who gives you that answer over a chat is doing you a disservice.
Get evaluated by a medical professional. Full stop.
What I can do: share what research says about concussion recognition and what to watch for. Want that?"`;

