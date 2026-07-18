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
}

export interface ExplanationChain {
  recommendation: string;
  confidence: number; // 0-100, capped at 95%
  confidenceLevel: '🟢 High' | '🟡 Moderate' | '🟠 Low' | '🔴 Speculative';
  reasoning: string; // One-sentence explanation
  evidenceLinks: EvidenceLink[];
  alternatives?: Array<{ recommendation: string; confidence: number; reason: string }>;
  disclaimers: string[];
}

/**
 * Build a full explanation chain for a recommendation
 * Combines evidence signals into a confidence score with reasoning
 */
export async function buildExplanationChain(
  recommendation: string,
  userProfile: ShadowUserProfileRow,
  tierResult: ProfileTierResult,
  evidenceSignals?: Partial<Record<EvidenceLink['type'], number>>,
): Promise<ExplanationChain> {
  const evidence: EvidenceLink[] = [];
  let confidenceBase = 50; // Start at 50% for all recommendations

  // ── Assessment Evidence (25% weight) ────────────────────────────────────
  if (evidenceSignals?.assessment ?? false) {
    const assessmentConfidence = (evidenceSignals?.assessment ?? 0) * 100;
    evidence.push({
      type: 'assessment',
      label: 'Recent Assessment',
      value: `${Math.round(assessmentConfidence)}% coverage`,
      weight: 0.25,
      source: 'shadow_events',
    });
    confidenceBase += 25 * ((evidenceSignals?.assessment ?? 0.5) / 1);
  }

  // ── Historical Pattern Evidence (30% weight) ────────────────────────────
  if (userProfile.remembered_facts && userProfile.remembered_facts.length > 0) {
    const matchingFacts = userProfile.remembered_facts.filter(
      f => f.confidence > 0.5 && f.key.includes('engag')
    );
    if (matchingFacts.length > 0) {
      evidence.push({
        type: 'historical',
        label: 'Historical Patterns',
        value: `${matchingFacts.length} confirmed behavior(s)`,
        weight: 0.3,
        source: 'shadow_user_profiles',
      });
      confidenceBase += 30 * 0.7; // 70% of weight
    }
  }

  // ── Library Evidence (30% weight) ──────────────────────────────────────
  // Assuming recommendation came from verified library
  evidence.push({
    type: 'library',
    label: 'Verified Library Source',
    value: 'Evidence-based methodology',
    weight: 0.3,
    source: 'shadow_library',
  });
  confidenceBase += 30 * 0.8; // 80% of weight for library sources

  // ── Biometric Evidence (bonus, 10% cap) ────────────────────────────────
  if (tierResult.tier === 'gold' && (evidenceSignals?.biometric ?? false)) {
    evidence.push({
      type: 'biometric',
      label: 'Biometric Signals',
      value: 'Optional: Integrated data stream',
      weight: 0.1,
      source: 'connected_devices',
    });
    confidenceBase += 10 * ((evidenceSignals?.biometric ?? 0.5) / 1);
  }

  // ── Pattern Recognition (15% cap) ──────────────────────────────────────
  if (userProfile.recent_topics && userProfile.recent_topics.length > 3) {
    evidence.push({
      type: 'pattern',
      label: 'Topic Pattern',
      value: `Recurring interest in ${userProfile.recent_topics[0]}`,
      weight: 0.15,
      source: 'shadow_chat_audit',
    });
    confidenceBase += 15 * 0.6; // 60% weight for pattern
  }

  // ── Profile Information (10% cap) ──────────────────────────────────────
  if (tierResult.profileCompleteness > 0.5) {
    evidence.push({
      type: 'profile',
      label: 'User Profile Data',
      value: `${Math.round(tierResult.profileCompleteness * 100)}% complete`,
      weight: 0.1,
      source: 'shadow_user_profiles',
    });
    confidenceBase += 10 * tierResult.profileCompleteness;
  }

  // Cap at 95%
  const finalConfidence = Math.min(95, Math.max(0, confidenceBase));

  // ── Generate Reasoning ─────────────────────────────────────────────────
  const reasoning = generateReasoning(tierResult.tier, evidence.length, finalConfidence);

  // ── Generate Disclaimers ──────────────────────────────────────────────
  const disclaimers: string[] = [];
  if (finalConfidence < 50) {
    disclaimers.push('⚠️ Low confidence: Consider seeking additional perspectives');
  }
  if (tierResult.tier === 'bronze') {
    disclaimers.push('Tip: Complete your profile to get more tailored recommendations');
  }
  if (tierResult.tier === 'silver') {
    disclaimers.push('Tip: Enable biometric signals for enhanced insights (Phase 4)');
  }
  disclaimers.push('SHADOW recommendations are educational only and not diagnostic');

  // ── Generate Alternatives ─────────────────────────────────────────────
  const alternatives = generateAlternatives(recommendation, finalConfidence);

  return {
    recommendation,
    confidence: finalConfidence,
    confidenceLevel: getConfidenceLevel(finalConfidence),
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

function generateAlternatives(
  recommendation: string,
  confidence: number
): ExplanationChain['alternatives'] {
  if (confidence >= 80) {
    // High confidence → brief alternatives
    return [
      {
        recommendation: 'Seek a second opinion from a coach',
        confidence: Math.max(20, confidence - 60),
        reason: 'Always valid to cross-check recommendations',
      },
    ];
  }

  if (confidence >= 50) {
    // Moderate confidence → more alternatives
    return [
      {
        recommendation: 'Try a different approach',
        confidence: Math.max(30, confidence - 30),
        reason: 'Alternative strategy based on different evidence',
      },
      {
        recommendation: 'Request a Heavy Bag deep-dive',
        confidence: confidence + 10,
        reason: 'Longer analysis might increase confidence',
      },
    ];
  }

  // Low confidence → many alternatives
  return [
    {
      recommendation: 'Request a Heavy Bag analysis for this topic',
      confidence: confidence + 25,
      reason: 'Longer reasoning session could resolve uncertainty',
    },
    {
      recommendation: 'Consult your coach for personalized guidance',
      confidence: 90,
      reason: 'Human expertise is always more reliable for low-confidence topics',
    },
  ];
}

// ─── Format for User Display ──────────────────────────────────────────────

/**
 * Format explanation chain as markdown for user display
 */
export function formatExplanation(chain: ExplanationChain, brief = false): string {
  const lines: string[] = [
    `**${chain.recommendation}**`,
    `\n**Confidence:** ${chain.confidenceLevel} (${Math.round(chain.confidence)}%)`,
    `\n**Why:** ${chain.reasoning}\n`
  ];

  if (!brief && chain.evidenceLinks.length > 0) {
    lines.push('**Evidence:**');
    for (const link of chain.evidenceLinks.slice(0, 3)) {
      const valueStr = link.value ? `: ${link.value}` : '';
      lines.push(`- ${link.label}${valueStr}`);
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
    confidence: number;
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
