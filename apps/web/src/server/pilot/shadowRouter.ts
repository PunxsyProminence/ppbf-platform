// shadowRouter.ts — The Corner
// Model routing layer for the SHADOW dual-mode AI system.
// Selects the right model and call parameters for each request tier.
// Designed to be extended as new models become available (gpt-5, o1, vision, etc.)

import type { ShadowTier } from './shadowClassifier';
import type { PilotRole } from './contracts';

// ─── Model Registry ──────────────────────────────────────────────────────────

/**
 * All models available to SHADOW. Add new deployments here when quota is granted.
 * Each model has a declared capability set so The Corner can route intelligently.
 */
export interface ShadowModel {
  deploymentName: string;          // Azure OpenAI deployment name
  displayName: string;             // Human-readable label
  supportsVision: boolean;         // Can analyze images/video frames
  isReasoningModel: boolean;       // Uses chain-of-thought / reasoning tokens
  maxCompletionTokens: number;     // Safe ceiling for this model
  tier: 'quick' | 'heavy' | 'vision' | 'embed'; // Capability tier
  available: boolean;              // Toggle without deleting the entry
}

const MODEL_REGISTRY: Record<string, ShadowModel> = {
  // ── Currently deployed ───────────────────────────────────────────────────
  'gpt-5-mini-shadow': {
    deploymentName: 'gpt-5-mini-shadow',
    displayName: 'GPT-5 Mini (Quick Round)',
    supportsVision: false,
    isReasoningModel: true,
    maxCompletionTokens: 4096,
    tier: 'quick',
    available: true,
  },

  // ── Add when quota is granted ────────────────────────────────────────────
  'gpt-5-shadow': {
    deploymentName: 'gpt-5-shadow',
    displayName: 'GPT-5 (Heavy Bag)',
    supportsVision: false,
    isReasoningModel: true,
    maxCompletionTokens: 16384,
    tier: 'heavy',
    available: false, // Flip to true after: az cognitiveservices account deployment create ...
  },
  'gpt-5-vision-shadow': {
    deploymentName: 'gpt-5-vision-shadow',
    displayName: 'GPT-5 Vision (Film Study)',
    supportsVision: true,
    isReasoningModel: false,
    maxCompletionTokens: 4096,
    tier: 'vision',
    available: false,
  },
};

// ─── Routing Config ───────────────────────────────────────────────────────────

export interface RoutingDecision {
  model: ShadowModel;
  temperature: number;
  maxTokens: number;
  systemPromptDepth: 'minimal' | 'standard' | 'full' | 'research';
  expectedLatencyMs: number;
  rationale: string;
}

export type ShadowSessionType =
  | 'quick_round'      // Normal chat — fast, consistent
  | 'heavy_bag'        // Deep reasoning — complex tasks
  | 'film_study'       // Vision analysis — video/image
  | 'scout_report'     // Profile synthesis — user intelligence
  | 'board_summary'    // Governance summaries — high-level insights
  | 'recovery_round';  // Background processing — async jobs

/**
 * The Corner — Route a request to the best available model.
 *
 * Priority order for each session type:
 *   heavy_bag    → gpt-5-shadow   (fallback: gpt-5-mini-shadow with extended tokens)
 *   film_study   → gpt-5-vision-shadow (fallback: error — vision required)
 *   scout_report → gpt-5-shadow   (fallback: gpt-5-mini-shadow)
 *   board_summary→ gpt-5-shadow   (fallback: gpt-5-mini-shadow)
 *   quick_round  → gpt-5-mini-shadow (no fallback needed)
 *   recovery_round → gpt-5-mini-shadow (background, cost-optimized)
 */
export function routeRequest(
  sessionType: ShadowSessionType,
  userRole: PilotRole,
  complexity: number,
): RoutingDecision {
  switch (sessionType) {
    case 'quick_round':
      return quickRoundRoute();

    case 'heavy_bag':
      return heavyBagRoute(userRole, complexity);

    case 'film_study':
      return filmStudyRoute();

    case 'scout_report':
    case 'board_summary':
      return reasoningRoute(sessionType);

    case 'recovery_round':
      return recoveryRoundRoute();

    default:
      return quickRoundRoute();
  }
}

// ─── Route Builders ───────────────────────────────────────────────────────────

function quickRoundRoute(): RoutingDecision {
  const model = MODEL_REGISTRY['gpt-5-mini-shadow'];
  return {
    model,
    temperature: 0.7,
    maxTokens: 4096,
    systemPromptDepth: 'standard',
    expectedLatencyMs: 2500,
    rationale: 'Quick Round: fast, consistent coaching responses',
  };
}

function heavyBagRoute(role: PilotRole, complexity: number): RoutingDecision {
  const heavyModel = MODEL_REGISTRY['gpt-5-shadow'];

  // Use heavy model if available, otherwise fall back to mini with extended budget
  if (heavyModel.available) {
    return {
      model: heavyModel,
      temperature: 0.5,
      maxTokens: 16384,
      systemPromptDepth: 'research',
      expectedLatencyMs: 8000,
      rationale: `Heavy Bag Session: deep reasoning via ${heavyModel.displayName} (complexity ${complexity.toFixed(2)})`,
    };
  }

  // Fallback: mini with heavier context and extended token budget
  const fallback = MODEL_REGISTRY['gpt-5-mini-shadow'];
  return {
    model: fallback,
    temperature: 0.5,
    maxTokens: 4096,
    systemPromptDepth: 'full',
    expectedLatencyMs: 5000,
    rationale: `Heavy Bag Session (fallback): extended context via ${fallback.displayName} — gpt-5 quota pending`,
  };
}

function filmStudyRoute(): RoutingDecision {
  const visionModel = MODEL_REGISTRY['gpt-5-vision-shadow'];

  if (!visionModel.available) {
    // Return mini as fallback — caller must handle vision-not-available gracefully
    const fallback = MODEL_REGISTRY['gpt-5-mini-shadow'];
    return {
      model: { ...fallback, supportsVision: false },
      temperature: 0.6,
      maxTokens: 4096,
      systemPromptDepth: 'full',
      expectedLatencyMs: 4000,
      rationale: 'Film Study (text-only fallback): vision model quota pending — text description analysis only',
    };
  }

  return {
    model: visionModel,
    temperature: 0.6,
    maxTokens: 4096,
    systemPromptDepth: 'full',
    expectedLatencyMs: 6000,
    rationale: 'Film Study: video frame analysis via vision model',
  };
}

function reasoningRoute(type: 'scout_report' | 'board_summary'): RoutingDecision {
  const heavyModel = MODEL_REGISTRY['gpt-5-shadow'];
  const fallback = MODEL_REGISTRY['gpt-5-mini-shadow'];

  const base = heavyModel.available ? heavyModel : fallback;
  return {
    model: base,
    temperature: 0.4,
    maxTokens: heavyModel.available ? 12288 : 4096,
    systemPromptDepth: 'research',
    expectedLatencyMs: heavyModel.available ? 10000 : 5000,
    rationale: `${type === 'scout_report' ? 'Scout Report' : 'Board Summary'}: pattern synthesis via ${base.displayName}`,
  };
}

function recoveryRoundRoute(): RoutingDecision {
  const model = MODEL_REGISTRY['gpt-5-mini-shadow'];
  return {
    model,
    temperature: 0.6,
    maxTokens: 4096,
    systemPromptDepth: 'standard',
    expectedLatencyMs: 3000,
    rationale: 'Recovery Round: background async processing — cost-optimized',
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Map ShadowTier + role to the best session type.
 * Coaches/admins can escalate boundary cases to heavy_bag.
 */
export function tierToSessionType(
  tier: ShadowTier,
  role: PilotRole,
  isManualOverride: boolean,
): ShadowSessionType {
  if (tier === 'quick_round' && !isManualOverride) return 'quick_round';
  if (tier === 'heavy_bag') return 'heavy_bag';

  // Manual override from coach/admin
  const canOverride: PilotRole[] = ['coach', 'admin', 'organization_admin', 'platform_owner'];
  if (isManualOverride && canOverride.includes(role)) return 'heavy_bag';

  return 'quick_round';
}

/** Check if a session type will require async processing */
export function isAsyncSession(sessionType: ShadowSessionType): boolean {
  return sessionType === 'recovery_round' ||
    sessionType === 'scout_report' ||
    sessionType === 'board_summary';
}

/** Get all available models for status/health reporting */
export function getModelStatus(): Record<string, Pick<ShadowModel, 'displayName' | 'available' | 'tier'>> {
  return Object.fromEntries(
    Object.entries(MODEL_REGISTRY).map(([key, m]) => [
      key,
      { displayName: m.displayName, available: m.available, tier: m.tier },
    ]),
  );
}
