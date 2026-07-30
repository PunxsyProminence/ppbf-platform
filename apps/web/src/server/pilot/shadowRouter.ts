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
  timeoutMs: number;               // Provider timeout -- see MEASURED LATENCY below
  tier: 'quick' | 'heavy' | 'vision' | 'embed'; // Capability tier
  available: boolean;              // Toggle without deleting the entry
}

/**
 * MEASURED LATENCY -- every deployment below was timed on 2026-07-29 against a
 * representative Heavy Bag prompt (athlete plateau analysis + 6-week plan) with
 * max_completion_tokens 16384, direct to shadow-ai in eastus:
 *
 *   gpt-5.6-sol    95.5s   5579 completion (2255 reasoning)   14843 chars
 *   gpt-5.6-luna   33.3s   4110 completion ( 776 reasoning)   15780 chars
 *   gpt-5          75.4s   6352 completion (2560 reasoning)   14419 chars
 *   gpt-5-mini     58.0s   5168 completion (1344 reasoning)   16810 chars
 *
 * Two conclusions drove this file's rewrite. First, the previous single 15s
 * provider timeout was shorter than the *fastest* of these by 2x -- so a real
 * SHADOW answer could not be delivered by any deployment, on either tier, and
 * production duly logged `Azure AI request failed { reason: 'timeout' }`.
 * Timeouts are therefore per-model and generous: roughly 2x the measured time,
 * because these are single samples and reasoning length varies per prompt.
 *
 * Second, gpt-5.6-luna strictly dominates gpt-5 here -- 2.3x faster, more
 * delivered content, a third of the reasoning overhead, and cheaper per token
 * ($1/$6 vs $1.25/$10 per 1M). So Quick Round moves up to luna rather than
 * down to a mini tier, and Heavy Bag takes sol for genuine depth.
 *
 * Ceiling note: timeouts stay under 240s because that is the Azure Container
 * Apps ingress request limit -- a longer provider wait would be cut off by the
 * platform before this code could return. Heavy Bag at ~95s is a poor
 * synchronous wait and wants the streaming/async path (see shadowJobQueue);
 * raising the timeout makes it *work*, not makes it pleasant.
 */
const MODEL_REGISTRY: Record<string, ShadowModel> = {
  // ── Current generation (shadow-ai / ppbf-shadow-rg, eastus) ─────────────
  'gpt-5.6-sol-shadow': {
    deploymentName: 'gpt-5.6-sol-shadow',
    displayName: 'GPT-5.6 Sol (Heavy Bag)',
    supportsVision: false,
    isReasoningModel: true,
    maxCompletionTokens: 16384,
    timeoutMs: 210_000,
    tier: 'heavy',
    available: true,
  },
  'gpt-5.6-luna-shadow': {
    deploymentName: 'gpt-5.6-luna-shadow',
    displayName: 'GPT-5.6 Luna (Quick Round)',
    supportsVision: false,
    isReasoningModel: true,
    maxCompletionTokens: 8192,
    timeoutMs: 90_000,
    tier: 'quick',
    available: true,
  },

  // ── Previous generation: retained as fallbacks and for vision ───────────
  'gpt-5-mini-shadow': {
    deploymentName: 'gpt-5-mini-shadow',
    displayName: 'GPT-5 Mini (Quick Round)',
    supportsVision: false,
    isReasoningModel: true,
    maxCompletionTokens: 4096,
    timeoutMs: 150_000,
    tier: 'quick',
    available: true,
  },
  'gpt-5-shadow': {
    deploymentName: 'gpt-5-shadow',
    displayName: 'GPT-5 (Heavy Bag)',
    supportsVision: false,
    isReasoningModel: true,
    maxCompletionTokens: 16384,
    timeoutMs: 200_000,
    tier: 'heavy',
    available: true,
  },
  'gpt-5-vision-shadow': {
    deploymentName: 'gpt-5-vision-shadow',
    // Same underlying gpt-5 model (natively multimodal) under its own
    // deployment alias -- Azure's catalog has no separate "vision" model.
    // Film Study stays on this deployment: the Azure model catalog does not
    // report a vision capability flag for the gpt-5.6 family, so promoting it
    // here would be an unverified guess on the one tier that hard-requires
    // multimodal input.
    displayName: 'GPT-5 Vision (Film Study)',
    supportsVision: true,
    isReasoningModel: true,
    maxCompletionTokens: 16384,
    timeoutMs: 200_000,
    tier: 'vision',
    available: true,
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
 *   heavy_bag    → gpt-5.6-sol-shadow  (fallback: gpt-5-shadow)
 *   film_study   → gpt-5-vision-shadow (fallback: text-only via gpt-5.6-luna)
 *   scout_report → gpt-5.6-sol-shadow  (fallback: gpt-5.6-luna-shadow)
 *   board_summary→ gpt-5.6-sol-shadow  (fallback: gpt-5.6-luna-shadow)
 *   quick_round  → gpt-5.6-luna-shadow (fallback: gpt-5-mini-shadow)
 *   recovery_round → gpt-5.6-luna-shadow (background, cost-optimized)
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
  const model = MODEL_REGISTRY['gpt-5.6-luna-shadow'].available
    ? MODEL_REGISTRY['gpt-5.6-luna-shadow']
    : MODEL_REGISTRY['gpt-5-mini-shadow'];
  return {
    model,
    temperature: 0.7,
    maxTokens: model.maxCompletionTokens,
    systemPromptDepth: 'standard',
    expectedLatencyMs: 33_000,
    rationale: `Quick Round: fast, consistent coaching responses via ${model.displayName}`,
  };
}

function heavyBagRoute(role: PilotRole, complexity: number): RoutingDecision {
  const heavyModel = MODEL_REGISTRY['gpt-5.6-sol-shadow'];

  // Use the current-generation heavy model if available, otherwise fall back to
  // the previous generation -- which is slower and less capable but still a
  // genuine reasoning deployment, so the tier is not silently downgraded to quick.
  if (heavyModel.available) {
    return {
      model: heavyModel,
      temperature: 0.5,
      maxTokens: heavyModel.maxCompletionTokens,
      systemPromptDepth: 'research',
      expectedLatencyMs: 95_000,
      rationale: `Heavy Bag Session: deep reasoning via ${heavyModel.displayName} (complexity ${complexity.toFixed(2)})`,
    };
  }

  const fallback = MODEL_REGISTRY['gpt-5-shadow'];
  return {
    model: fallback,
    temperature: 0.5,
    maxTokens: fallback.maxCompletionTokens,
    systemPromptDepth: 'research',
    expectedLatencyMs: 75_000,
    rationale: `Heavy Bag Session (fallback): deep reasoning via ${fallback.displayName} — gpt-5.6 unavailable`,
  };
}

function filmStudyRoute(): RoutingDecision {
  const visionModel = MODEL_REGISTRY['gpt-5-vision-shadow'];

  if (!visionModel.available) {
    // Text-only fallback — caller must handle vision-not-available gracefully
    const fallback = MODEL_REGISTRY['gpt-5.6-luna-shadow'];
    return {
      model: { ...fallback, supportsVision: false },
      temperature: 0.6,
      maxTokens: fallback.maxCompletionTokens,
      systemPromptDepth: 'full',
      expectedLatencyMs: 33_000,
      rationale: 'Film Study (text-only fallback): vision model unavailable — text description analysis only',
    };
  }

  return {
    model: visionModel,
    temperature: 0.6,
    maxTokens: visionModel.maxCompletionTokens,
    systemPromptDepth: 'full',
    expectedLatencyMs: 75_000,
    rationale: 'Film Study: video frame analysis via vision model',
  };
}

function reasoningRoute(type: 'scout_report' | 'board_summary'): RoutingDecision {
  const heavyModel = MODEL_REGISTRY['gpt-5.6-sol-shadow'];
  const fallback = MODEL_REGISTRY['gpt-5.6-luna-shadow'];

  const base = heavyModel.available ? heavyModel : fallback;
  return {
    model: base,
    temperature: 0.4,
    maxTokens: heavyModel.available ? 12288 : fallback.maxCompletionTokens,
    systemPromptDepth: 'research',
    expectedLatencyMs: heavyModel.available ? 95_000 : 33_000,
    rationale: `${type === 'scout_report' ? 'Scout Report' : 'Board Summary'}: pattern synthesis via ${base.displayName}`,
  };
}

function recoveryRoundRoute(): RoutingDecision {
  const model = MODEL_REGISTRY['gpt-5.6-luna-shadow'].available
    ? MODEL_REGISTRY['gpt-5.6-luna-shadow']
    : MODEL_REGISTRY['gpt-5-mini-shadow'];
  return {
    model,
    temperature: 0.6,
    maxTokens: model.maxCompletionTokens,
    systemPromptDepth: 'standard',
    expectedLatencyMs: 33_000,
    rationale: 'Recovery Round: background async processing — cost-optimized',
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Map a resolved tier to its session type. A pure mapping, on purpose.
 *
 * This used to take (role, isManualOverride) and escalate quick_round to
 * heavy_bag whenever the override flag was set for an authorized role. The
 * flag recorded only that a tier was requested -- not which one -- so an
 * explicit "quick_round" from a coach was inverted into the slowest path in
 * the system. Both manual directions are now honored where the tier is
 * decided, in classifyRequest: heavy_bag behind its role gate, quick_round
 * for anyone (a downgrade is always safe). A tier arriving here already
 * embodies every override, so re-deciding from the role would be a second,
 * disagreeing authority.
 */
export function tierToSessionType(tier: ShadowTier): ShadowSessionType {
  return tier === 'heavy_bag' ? 'heavy_bag' : 'quick_round';
}

/**
 * Human-readable label for the deployment that actually answered. Falls back
 * to the raw deployment name so an env-configured deployment outside the
 * registry is still reported truthfully rather than as the router's
 * theoretical pick.
 */
export function describeDeployment(deploymentName: string): string {
  return MODEL_REGISTRY[deploymentName]?.displayName ?? deploymentName;
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
