// shadowExplainability.ts — Confidence chains and reasoning explanations
// Provides "Why?" for every SHADOW recommendation with evidence links and confidence scoring

import type { ShadowUserProfileRow } from './shadowUserProfile';
import type { ProfileTierResult } from './shadowProfiling';

export interface EvidenceLink {
  type: 'assessment' | 'historical' | 'library' | 'biometric' | 'pattern' | 'profile';
  label: string;
  value?: string;
  weight: number; // 0-1, contribution to final confidence
  source?: string;
  sourceId: string;
  verificationState: 'verified';
}

export interface VerifiedEvidenceDescriptor {
  type: EvidenceLink['type'];
  label: string;
  sourceId: string;
  verificationState: 'verified';
  confidence: number; // 0-1, supplied by the verified evidence record
  weight?: number; // 0-1, defaults to 1
  value?: string;
  source?: string;
}

export interface ExplanationChain {
  recommendation: string;
  confidence: number | null; // 0-100 when verified evidence exists; otherwise unavailable
  confidenceLevel: '🟢 High' | '🟡 Moderate' | '🟠 Low' | '🔴 Speculative' | '⚪ Unavailable';
  reasoning: string; // One-sentence explanation
  evidenceLinks: EvidenceLink[];
  alternatives?: Array<{ recommendation: string; confidence: number | null; reason: string }>;
  disclaimers: string[];
}

/**
 * Build a full explanation chain for a recommendation
 * Combines evidence signals into a confidence score with reasoning
 */
export async function buildExplanationChain(
  recommendation: string,
  _userProfile: ShadowUserProfileRow,
  tierResult: ProfileTierResult,
  evidenceDescriptors: VerifiedEvidenceDescriptor[] = [],
): Promise<ExplanationChain> {
  const verifiedDescriptors = evidenceDescriptors.filter((descriptor) => (
    descriptor.verificationState === 'verified'
    && descriptor.sourceId.trim().length > 0
    && Number.isFinite(descriptor.confidence)
    && descriptor.confidence >= 0
    && descriptor.confidence <= 1
    && (descriptor.weight === undefined || (
      Number.isFinite(descriptor.weight)
      && descriptor.weight > 0
      && descriptor.weight <= 1
    ))
  ));

  const evidence: EvidenceLink[] = verifiedDescriptors.map((descriptor) => ({
    type: descriptor.type,
    label: descriptor.label,
    value: descriptor.value,
    weight: descriptor.weight ?? 1,
    source: descriptor.source,
    sourceId: descriptor.sourceId,
    verificationState: 'verified',
  }));
  const totalWeight = verifiedDescriptors.reduce((sum, descriptor) => sum + (descriptor.weight ?? 1), 0);
  const finalConfidence = totalWeight > 0
    ? Math.min(
        95,
        Math.max(
          0,
          verifiedDescriptors.reduce(
            (sum, descriptor) => sum + descriptor.confidence * (descriptor.weight ?? 1),
            0,
          ) / totalWeight * 100,
        ),
      )
    : null;
  const reasoning = finalConfidence === null
    ? 'RESEARCH NEEDED — no verified evidence descriptors with source IDs were supplied.'
    : generateReasoning(tierResult.tier, evidence.length, finalConfidence);
  const disclaimers: string[] = [];
  if (finalConfidence === null) {
    disclaimers.push('Confidence unavailable until verified evidence is linked.');
  } else if (finalConfidence < 50) {
    disclaimers.push('⚠️ Low confidence: Consider seeking additional perspectives');
  }
  if (tierResult.tier === 'bronze') {
    disclaimers.push('Tip: Complete your profile to get more tailored recommendations');
  }
  if (tierResult.tier === 'silver') {
    disclaimers.push('Tip: Enable biometric signals for enhanced insights (Phase 4)');
  }
  disclaimers.push('SHADOW recommendations are educational only and not diagnostic');
  const alternatives = generateAlternatives();

  return {
    recommendation,
    confidence: finalConfidence,
    confidenceLevel: finalConfidence === null ? '⚪ Unavailable' : getConfidenceLevel(finalConfidence),
    reasoning,
    evidenceLinks: evidence,
    alternatives,
    disclaimers,
  };
}

// ─── Confidence Level Emoji ────────────────────────────────────────────────

function getConfidenceLevel(confidence: number): ExplanationChain['confidenceLevel'] {
  if (confidence >= 75) return '🟢 High';
  if (confidence >= 60) return '🟡 Moderate';
  if (confidence >= 40) return '🟠 Low';
  return '🔴 Speculative';
}

// ─── Reasoning Generator ──────────────────────────────────────────────────

function generateReasoning(tier: string, evidenceCount: number, confidence: number): string {
  if (evidenceCount === 0) {
    return 'Based on general knowledge and organizational patterns.';
  }

  const timerNote = tier === 'gold' ? ' (enhanced by your profile data)' : '';

  if (confidence >= 80) {
    return `Well-supported by ${evidenceCount} evidence source(s)${timerNote}.`;
  }
  if (confidence >= 60) {
    return `Supported by your history and library patterns${timerNote}.`;
  }
  return `Suggested based on ${evidenceCount} available signal(s); consider cross-checking.`;
}

// ─── Alternative Suggestions ──────────────────────────────────────────────

function generateAlternatives(): ExplanationChain['alternatives'] {
  return [
    {
      recommendation: 'Create a research requirement and link reviewed evidence',
      confidence: null,
      reason: 'Alternative confidence is unavailable until that alternative has its own verified evidence',
    },
    {
      recommendation: 'Consult the responsible coach or qualified professional',
      confidence: null,
      reason: 'Human review is appropriate when an alternative has not been independently evaluated',
    },
  ];
}

// ─── Format for User Display ──────────────────────────────────────────────

/**
 * Format explanation chain as markdown for user display
 */
export function formatExplanation(chain: ExplanationChain, brief = false): string {
  const confidenceText = chain.confidence === null
    ? chain.confidenceLevel
    : `${chain.confidenceLevel} (${Math.round(chain.confidence)}%)`;
  const lines: string[] = [
    `**${chain.recommendation}**`,
    `\n**Confidence:** ${confidenceText}`,
    `\n**Why:** ${chain.reasoning}\n`
  ];

  if (!brief && chain.evidenceLinks.length > 0) {
    lines.push('**Evidence:**');
    for (const link of chain.evidenceLinks.slice(0, 3)) {
      const valueStr = link.value ? `: ${link.value}` : '';
      lines.push(`- ${link.label}${valueStr} [source: ${link.sourceId}]`);
    }
    lines.push('');
  }

  if (!brief && chain.alternatives && chain.alternatives.length > 0) {
    lines.push('**Alternatives:**');
    for (const alt of chain.alternatives.slice(0, 2)) {
      lines.push(`- ${alt.recommendation}`);
    }
    lines.push('');
  }

  if (chain.disclaimers.length > 0) {
    lines.push('**Note:**');
    for (const disclaimer of chain.disclaimers) {
      lines.push(`${disclaimer}`);
    }
  }

  return lines.join('\n');
}

/**
 * Attach explanation chain to a response for API consumers
 * (API response will include this as optional JSON field)
 */
export interface ShadowResponseWithExplainability {
  response: string;
  explainability?: {
    confidence: number | null;
    confidenceLevel: string;
    reasoning: string;
    evidenceCount: number;
    disclaimers: string[];
  };
}

export function attachExplainability(
  response: string,
  chain: ExplanationChain,
  includeFullChain = false
): ShadowResponseWithExplainability {
  return {
    response,
    explainability: includeFullChain
      ? {
          confidence: chain.confidence,
          confidenceLevel: chain.confidenceLevel,
          reasoning: chain.reasoning,
          evidenceCount: chain.evidenceLinks.length,
          disclaimers: chain.disclaimers,
        }
      : undefined,
  };
}
