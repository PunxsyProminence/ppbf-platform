export type ShadowConfidenceTier = 'PROVEN' | 'EMERGING' | 'EXPERIMENTAL' | 'RESEARCH_NEEDED';
export type ShadowSafetyCategory = 'none' | 'diagnosis' | 'prescription' | 'clearance' | 'emergency' | 'privacy' | 'authority';

export interface StructuredShadowResponse {
  observation: string;
  guidance: string[];
  confidenceTier: ShadowConfidenceTier;
  evidenceIds: string[];
  unknowns: string[];
  humanAuthority: string | null;
  medicalDeferral: boolean;
  urgentEscalation: boolean;
}

export interface StructuredParseResult {
  value: StructuredShadowResponse;
  schemaValid: boolean;
  issues: string[];
}

export interface SemanticSafetyDecision {
  riskLevel: 'low' | 'moderate' | 'high' | 'critical';
  category: ShadowSafetyCategory;
  allowedMode: 'answer' | 'education_only' | 'defer' | 'block';
  requiresHumanReview: boolean;
  reasons: string[];
}

export interface EvidenceDescriptor {
  sourceId: string;
  authorityTier: number;
  publicationDate: string | null;
}

export interface EvidenceConfidenceResult {
  score: number;
  level: 'high' | 'moderate' | 'low' | 'insufficient';
  factors: string[];
}

const CONFIDENCE_TIERS = new Set<ShadowConfidenceTier>([
  'PROVEN', 'EMERGING', 'EXPERIMENTAL', 'RESEARCH_NEEDED',
]);

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stringArray(value: unknown, maxItems: number, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null;
  return value.slice(0, maxItems)
    .map((item) => item.trim().slice(0, maxLength))
    .filter(Boolean);
}

export function parseStructuredShadowResponse(raw: string, availableEvidenceIds: readonly string[]): StructuredParseResult {
  const parsed = extractJsonObject(raw);
  const issues: string[] = [];
  const allowedEvidence = new Set(availableEvidenceIds);

  if (!parsed) {
    return {
      value: {
        observation: raw.trim().slice(0, 12_000),
        guidance: [],
        confidenceTier: 'RESEARCH_NEEDED',
        evidenceIds: [],
        unknowns: ['The model did not return the required structured response.'],
        humanAuthority: null,
        medicalDeferral: false,
        urgentEscalation: false,
      },
      schemaValid: false,
      issues: ['Malformed or missing JSON object'],
    };
  }

  const observation = typeof parsed.observation === 'string' ? parsed.observation.trim().slice(0, 8_000) : '';
  const guidance = stringArray(parsed.guidance, 10, 1_000);
  const unknowns = stringArray(parsed.unknowns, 10, 1_000);
  const requestedEvidence = stringArray(parsed.evidenceIds, 20, 200);
  const confidenceTier = typeof parsed.confidenceTier === 'string' && CONFIDENCE_TIERS.has(parsed.confidenceTier as ShadowConfidenceTier)
    ? parsed.confidenceTier as ShadowConfidenceTier
    : 'RESEARCH_NEEDED';
  const humanAuthority = parsed.humanAuthority === null || typeof parsed.humanAuthority === 'string'
    ? parsed.humanAuthority as string | null
    : null;
  const medicalDeferral = typeof parsed.medicalDeferral === 'boolean' ? parsed.medicalDeferral : false;
  const urgentEscalation = typeof parsed.urgentEscalation === 'boolean' ? parsed.urgentEscalation : false;

  if (!observation) issues.push('observation must be a non-empty string');
  if (!guidance) issues.push('guidance must be a string array');
  if (!unknowns) issues.push('unknowns must be a string array');
  if (!requestedEvidence) issues.push('evidenceIds must be a string array');
  if (parsed.confidenceTier !== confidenceTier) issues.push('confidenceTier was invalid');
  if (parsed.humanAuthority !== humanAuthority) issues.push('humanAuthority was invalid');
  if (typeof parsed.medicalDeferral !== 'boolean') issues.push('medicalDeferral must be boolean');
  if (typeof parsed.urgentEscalation !== 'boolean') issues.push('urgentEscalation must be boolean');

  const evidenceIds = (requestedEvidence ?? []).filter((id) => allowedEvidence.has(id));
  if (requestedEvidence && evidenceIds.length !== requestedEvidence.length) {
    issues.push('One or more unverified evidence IDs were removed');
  }

  return {
    value: {
      observation: observation || 'SHADOW could not produce a valid observation.',
      guidance: guidance ?? [],
      confidenceTier,
      evidenceIds,
      unknowns: unknowns ?? ['Structured output validation failed.'],
      humanAuthority: humanAuthority?.slice(0, 300) ?? null,
      medicalDeferral,
      urgentEscalation,
    },
    schemaValid: issues.length === 0,
    issues,
  };
}

export function renderStructuredShadowResponse(value: StructuredShadowResponse): string {
  const sections = [value.observation];
  if (value.guidance.length > 0) {
    sections.push('Guidance:\n' + value.guidance.map((item) => '- ' + item).join('\n'));
  }
  sections.push('Confidence: ' + value.confidenceTier);
  if (value.evidenceIds.length > 0) sections.push('Evidence: ' + value.evidenceIds.join(', '));
  if (value.unknowns.length > 0) {
    sections.push('Unknowns:\n' + value.unknowns.map((item) => '- ' + item).join('\n'));
  }
  if (value.humanAuthority) sections.push('Human authority: ' + value.humanAuthority);
  if (value.medicalDeferral) sections.push('Medical decisions require an appropriately licensed or certified healthcare professional.');
  if (value.urgentEscalation) sections.push('Urgent escalation: stop participation and contact local emergency services or an onsite licensed medical professional now.');
  return sections.filter(Boolean).join('\n\n');
}

export function classifySemanticSafety(text: string): SemanticSafetyDecision {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ');
  const reasons: string[] = [];
  const emergency = /\b(chest pain|cannot breathe|can't breathe|loss of consciousness|unresponsive|seizure|immediate danger)\b/.test(normalized)
    && /\b(now|currently|urgent|emergency|immediate|worsening)\b/.test(normalized);
  if (emergency) {
    return { riskLevel: 'critical', category: 'emergency', allowedMode: 'defer', requiresHumanReview: true, reasons: ['Potential emergency language detected'] };
  }

  const diagnosis = /\b(you|your symptoms|the athlete|this)\b.{0,40}\b(have|has|definitely|confirm|confirms|proves|means)\b.{0,60}\b(concussion|fracture|injury|disease|syndrome|disorder|condition)\b/.test(normalized);
  if (diagnosis) reasons.push('Output reaches or strongly implies a personal diagnosis');
  const prescription = /\b(take|start|stop|increase|decrease|double|dose|use)\b.{0,40}\b(medication|medicine|drug|pill|ibuprofen|acetaminophen|supplement|injection)\b/.test(normalized);
  if (prescription) reasons.push('Output gives a treatment, medication, or dosage directive');
  const clearance = /\b(you are|the athlete is|safe to|may now|can now)\b.{0,40}\b(cleared|return to play|return to training|resume contact|compete)\b/.test(normalized);
  if (clearance) reasons.push('Output grants or implies participation clearance');
  const privacy = /\b(system prompt|api key|secret|password|other organization|another tenant)\b.{0,80}\b(is|equals|contains|show|reveal|access)\b/.test(normalized);
  if (privacy) reasons.push('Output may disclose protected instructions, secrets, or cross-tenant information');
  const authority = /\b(ignore|disregard|override|do not contact)\b.{0,50}\b(doctor|physician|clinician|medical professional|coach|policy)\b/.test(normalized);
  if (authority) reasons.push('Output attempts to override human authority');

  if (diagnosis || prescription || clearance || privacy || authority) {
    const category: ShadowSafetyCategory = diagnosis ? 'diagnosis' : prescription ? 'prescription' : clearance ? 'clearance' : privacy ? 'privacy' : 'authority';
    return { riskLevel: 'high', category, allowedMode: 'block', requiresHumanReview: true, reasons };
  }

  const medicalEducation = /\b(symptom|medical|injury|concussion|medication|clearance|treatment)\b/.test(normalized);
  return {
    riskLevel: medicalEducation ? 'moderate' : 'low',
    category: 'none',
    allowedMode: medicalEducation ? 'education_only' : 'answer',
    requiresHumanReview: medicalEducation,
    reasons: medicalEducation ? ['Medical content limited to education-only mode'] : [],
  };
}

export function calculateEvidenceConfidence(
  status: 'supported' | 'weak' | 'unsupported',
  evidence: readonly EvidenceDescriptor[],
): EvidenceConfidenceResult {
  if (status === 'unsupported' || evidence.length === 0) {
    return { score: 0.05, level: 'insufficient', factors: ['No qualifying evidence was retrieved'] };
  }

  const factors: string[] = [];
  const distinctSources = new Set(evidence.map((item) => item.sourceId)).size;
  const base = status === 'supported' ? 0.45 : 0.12;
  const diversity = Math.min(0.2, distinctSources * 0.07);
  const authority = evidence.reduce(
    (sum, item) => sum + Math.max(0, Math.min(1, (6 - item.authorityTier) / 5)),
    0,
  ) / evidence.length * 0.2;
  const currentYear = new Date().getUTCFullYear();
  const years = evidence
    .map((item) => item.publicationDate ? Number.parseInt(item.publicationDate.slice(0, 4), 10) : Number.NaN)
    .filter(Number.isFinite);
  const recency = years.length > 0 && years.some((year) => currentYear - year <= 5) ? 0.1 : 0.03;

  factors.push(evidence.length + ' evidence item(s) from ' + distinctSources + ' distinct source(s)');
  factors.push('Average authority contribution ' + authority.toFixed(2));
  factors.push(recency >= 0.1 ? 'At least one source is recent' : 'Source recency is limited or unknown');
  if (distinctSources >= 2) factors.push('Multiple sources reduce single-source dependence');

  const score = Math.min(0.95, Number((base + diversity + authority + recency).toFixed(2)));
  const level = score >= 0.8 ? 'high' : score >= 0.6 ? 'moderate' : score >= 0.35 ? 'low' : 'insufficient';
  return { score, level, factors };
}
