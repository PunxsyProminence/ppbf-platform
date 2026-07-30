// POST /api/pilot/shadow/chat endpoint
// Core chat interface for SHADOW with doctrine enforcement, tier-aware routing, and audit logging
// Implements dual-mode architecture: Quick Round (fast/sync) vs Heavy Bag (deep/async)

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/src/server/pilot/db';
import { isUuid, requirePrincipal, jsonError } from '@/src/server/pilot/http';
import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import type { PilotRole } from '@/src/server/pilot/contracts';
import {
  validateShadowRequest,
  validateShadowResponse,
  retrieveShadowContext,
  composeShadowSystemPrompt,
} from '@/src/server/pilot/shadowChat';
import { buildAzureAiChatCompletionsUrl, getAzureAiRuntimeConfig } from '@/src/server/pilot/azureAiRuntime';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import {
  getOrCreateShadowUserProfile,
  updateShadowUserProfile,
} from '@/src/server/pilot/shadowUserProfile';
import { classifyRequest, type ShadowTier } from '@/src/server/pilot/shadowClassifier';
import { buildShadowContext } from '@/src/server/pilot/shadowContextBuilder';
import { routeRequest, tierToSessionType } from '@/src/server/pilot/shadowRouter';
import { classifyProfileTier, buildPersonalizationPrompt } from '@/src/server/pilot/shadowProfiling';
import { executeHeavyBagSync } from '@/src/server/pilot/shadowHeavyBag';
import {
  evaluateShadowUnlockState,
  isFeatureEnabled,
  buildShadowUnlockHints,
  type ShadowUnlockState,
  type ShadowUnlockHint,
} from '@/src/server/pilot/shadowUnlocks';
import { deriveEvidenceTier, type ShadowEvidenceTier } from '@/src/server/pilot/shadowEvidenceTier';
import {
  appendConversationExchange,
  assertConversationAccess,
  loadConversationMessages,
  queueHumanReview,
  resolveConversation,
} from '@/src/server/pilot/shadowConversations';
import {
  enforceShadowRateLimit,
  resolveShadowRateLimit,
  shadowRateLimitMessage,
  ShadowRateLimitExceeded,
} from '@/src/server/pilot/shadowRateLimit';
import { getShadowChatCapabilities } from '@/src/server/pilot/shadowChatCapabilities';
import { MANUAL_OVERRIDE_ROLES as MANUAL_OVERRIDE_ROLE_LIST } from '@/src/server/pilot/shadowRoleSets';
import {
  PLATFORM_SCOPE_UNAVAILABLE_CONTEXT,
  formatPlatformRollup,
  getPlatformRollup,
  mentionsCrossOrganizationScope,
  platformRollupEvidenceIds,
} from '@/src/server/pilot/omegaPlatformContext';
import { budgetConversationHistory } from '@/src/server/pilot/shadowConversationHistory';
import {
  publicEvidenceCitations,
  retrieveShadowEvidenceBundle,
  unavailableShadowEvidenceBundle,
  type ShadowEvidenceCitation,
} from '@/src/server/pilot/shadowEvidence';

export interface ShadowChatRequest {
  message: string;
  conversationId?: string;
  athleteId?: string;
  context?: string;
  organizationId?: string; // Ignored: organization scope is always resolved from the authenticated session
  tier?: ShadowTier; // Optional manual tier override (coaches/admins only)
  sessionType?: string; // Optional: 'film_study' | 'scout_report' | 'board_summary'
  preferAsync?: boolean; // Client can request async for heavy sessions
}

export type ShadowResponseState = 'ok' | 'filtered' | 'degraded' | 'queued';

export interface ShadowChatResponse {
  success: boolean;
  state: ShadowResponseState;
  response: string;
  messageId: string;
  conversationId?: string;
  createdAt: string;
  filtered: boolean;
  requiresHumanReview: boolean;
  highRiskTopic?: string;
  tier?: ShadowTier; // Which tier was used for this response
  complexity?: number; // Complexity score (0–1) for debugging
  sessionType?: string; // The Corner routing decision
  profileTier?: string; // Bronze/Silver/Gold
  modelUsed?: string; // Which model handled this request
  async?: boolean; // True if response is async (jobId instead of response)
  jobId?: string; // Present when async=true — poll /api/pilot/shadow/jobs/[jobId]
  citations?: ShadowEvidenceCitation[];
  evidenceTier: ShadowEvidenceTier;
  handoff?: string;
  unlockHints?: ShadowUnlockHint[];
  error?: string;
}

// Fallback responses for critical topics
const FALLBACK_RESPONSES: Record<string, string> = {
  concussion: 'For concussion concerns, contact your medical team immediately. SHADOW can help you understand concussion recovery protocols and organizational best practices.',
  weight_cutting: 'Rapid weight loss carries significant health risks. Consult with your medical team and sports nutritionist. SHADOW can provide information on safe weight management practices.',
  return_to_play: 'Return-to-play decisions require medical professional evaluation. SHADOW can help you understand RTP protocols and evidence-based recovery frameworks.',
  medical_clearance: 'Medical clearance decisions are made by qualified medical professionals. SHADOW can help you understand what clearance evaluations typically include.',
};

// Human-handoff guidance for specific high-risk topics. Anything not listed
// here still gets a non-empty handoff via DEFAULT_HANDOFF_MESSAGE below --
// handoff must never be empty when a response requires human review.
const HANDOFF_MESSAGES: Record<string, string> = {
  concussion: 'Loop in your medical staff before any return-to-activity decision.',
  weight_cutting: 'Talk to your medical team and sports nutritionist before changing any weight-cut plan.',
  return_to_play: 'Return-to-play calls belong to a qualified medical professional -- bring this to them directly.',
  medical_clearance: 'Medical clearance is a licensed professional\'s call, not SHADOW\'s -- follow up with them directly.',
};
const DEFAULT_HANDOFF_MESSAGE = 'This needs a human coach, medical professional, or your organization admin to weigh in directly -- please follow up with them.';

function resolveHandoff(input: { requiresHumanReview: boolean; topic: string | undefined }): string | undefined {
  if (!input.requiresHumanReview && !input.topic) {
    return undefined;
  }
  if (input.topic && HANDOFF_MESSAGES[input.topic]) {
    return HANDOFF_MESSAGES[input.topic];
  }
  return DEFAULT_HANDOFF_MESSAGE;
}

/**
 * Provider timeout for the Quick Round path. This was a flat 15s, which no
 * available deployment could meet: timed on 2026-07-29 against a representative
 * SHADOW prompt, gpt-5-mini took 58.0s and gpt-5.6-luna 33.3s (full figures in
 * shadowRouter.ts). Production logged the consequence as
 * `Azure AI request failed { reason: 'timeout' }`.
 *
 * Reasoning-token spend varies per prompt, so this is deliberately generous
 * rather than fitted to the measurement, and configurable so it can be retuned
 * without a deploy. The ceiling sits below the Azure Container Apps ingress
 * request limit (240s) -- past that the platform cuts the request off and a
 * larger value here would be a lie.
 */
const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;
const PROVIDER_TIMEOUT_FLOOR_MS = 5_000;
const PROVIDER_TIMEOUT_CEILING_MS = 230_000;

/**
 * Backstop for the Heavy Bag path only. The real per-model limit is
 * MODEL_REGISTRY[...].timeoutMs, applied as an AbortSignal inside
 * executeHeavyBagSync; this outer race only catches a promise that never
 * settles at all, so it sits at the ceiling rather than competing with it.
 */
const PROVIDER_TIMEOUT_BACKSTOP_MS = PROVIDER_TIMEOUT_CEILING_MS;

export function resolveShadowProviderTimeoutMs(
  rawValue: string | undefined = process.env.PPBF_SHADOW_PROVIDER_TIMEOUT_MS,
): number {
  if (rawValue === undefined || rawValue.trim() === '') return DEFAULT_PROVIDER_TIMEOUT_MS;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return DEFAULT_PROVIDER_TIMEOUT_MS;
  return Math.max(PROVIDER_TIMEOUT_FLOOR_MS, Math.min(PROVIDER_TIMEOUT_CEILING_MS, Math.trunc(parsed)));
}

const MAX_MESSAGE_LENGTH = 12_000;
const DEGRADED_RESPONSE = 'SHADOW is temporarily unavailable. No generated guidance was returned. Please try again later or contact your organization for support.';

/**
 * A reasoning deployment spends completion budget on reasoning tokens before it
 * emits a single visible character, and Azure counts both against
 * max_completion_tokens. Measured against the configured gpt-5-mini deployment on
 * real SHADOW prompts:
 *
 *   budget 1024 -- finish_reason "length", reasoning_tokens 1024, NO content, on
 *                  three attempts out of three. Empty content is read as failure
 *                  here, so every turn answered with DEGRADED_RESPONSE. That is
 *                  every role, not one tier: SHADOW chat could not answer at all.
 *   budget 2048 -- delivered sometimes, truncated mid-sentence at others.
 *   budget 8192 -- delivered 3/3, spending 964 / 1682 / 2054 completion tokens.
 *
 * The default is therefore twice the observed peak, so an unusually long answer
 * finishes rather than truncating, and the ceiling leaves room for a longer prompt
 * or a heavier-reasoning deployment without a code change. Nothing is charged for
 * headroom -- billing follows tokens actually produced, not the budget. The floor
 * stays low for a non-reasoning deployment, where it is purely a cost control.
 */
const DEFAULT_MAX_COMPLETION_TOKENS = 4_096;
const MAX_COMPLETION_TOKENS_CEILING = 8_192;

export function resolveShadowMaxCompletionTokens(
  rawValue: string | undefined = process.env.PPBF_SHADOW_MAX_COMPLETION_TOKENS,
): number {
  if (rawValue === undefined || rawValue.trim() === '') return DEFAULT_MAX_COMPLETION_TOKENS;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_COMPLETION_TOKENS;
  return Math.max(256, Math.min(MAX_COMPLETION_TOKENS_CEILING, Math.trunc(parsed)));
}

async function withProviderTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('provider_timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function callAzureOpenAI(
  systemPrompt: string,
  userMessage: string,
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [],
): Promise<{ response: string; success: boolean }> {
  try {
    const runtime = getAzureAiRuntimeConfig();
    if (!runtime.ok || !runtime.config) {
      console.error('Azure AI runtime is not configured');
      return { response: '', success: false };
    }

    const url = buildAzureAiChatCompletionsUrl(runtime.config);

    const azureResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': runtime.config.apiKey,
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          ...budgetConversationHistory(conversationHistory).map((message) => ({
            role: message.role,
            content: message.content,
          })),
          { role: 'user', content: userMessage },
        ],
        max_completion_tokens: resolveShadowMaxCompletionTokens(),
      }),
      signal: AbortSignal.timeout(resolveShadowProviderTimeoutMs()),
    });

    if (!azureResponse.ok) {
      console.error('Azure AI request failed', { status: azureResponse.status });
      return { response: '', success: false };
    }

    const data = await azureResponse.json() as {
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
      usage?: {
        completion_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    const response = typeof data.choices?.[0]?.message?.content === 'string'
      ? data.choices[0].message.content.trim()
      : '';
    // An HTTP 200 carrying no content is the failure mode a reasoning deployment
    // produces when it exhausts max_completion_tokens on reasoning. Without this
    // it logged nothing at all -- the turn simply came back degraded, which reads
    // as a provider outage and took a live probe to identify.
    if (!response) {
      console.error('Azure AI returned no content', {
        finishReason: data.choices?.[0]?.finish_reason,
        completionTokens: data.usage?.completion_tokens,
        reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens,
        budget: resolveShadowMaxCompletionTokens(),
      });
    }
    return { response, success: response.length > 0 };
  } catch (error) {
    const reason = error instanceof Error && (
      error.name === 'TimeoutError'
      || error.name === 'AbortError'
      || error.message === 'provider_timeout'
    )
      ? 'timeout'
      : 'request_failed';
    console.error('Azure AI request failed', { reason });
    return { response: '', success: false };
  }
}

interface LlmRouteResult {
  llmResponse: string;
  resolvedAsync: boolean;
  asyncJobId?: string;
  state: ShadowResponseState;
}

interface LlmRouteContext {
  sessionType: import('@/src/server/pilot/shadowRouter').ShadowSessionType;
  effectiveTier: import('@/src/server/pilot/shadowClassifier').ShadowTier;
  highRiskClassification: string | undefined;
  userProfile: import('@/src/server/pilot/shadowUserProfile').ShadowUserProfileRow;
  tierResult: import('@/src/server/pilot/shadowProfiling').ProfileTierResult;
  contextOutput: import('@/src/server/pilot/shadowContextBuilder').ShadowContextOutput;
  classification: import('@/src/server/pilot/shadowClassifier').ShadowClassification;
  message: string;
  userId: string;
  organizationId: string;
  userRole: string;
  athleteId: string | undefined;
  unlockState: ShadowUnlockState | null;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
}

async function routeLlmCall(ctx: LlmRouteContext): Promise<LlmRouteResult> {
  const { sessionType, highRiskClassification,
    userProfile, tierResult, contextOutput, classification,
    message, userId, organizationId, userRole, athleteId, unlockState,
    conversationHistory } = ctx;
  // Length budget and audience register are composed per request: the quick
  // tiers get a ~150-word budget (the base prompt has none, and every
  // deployment measured 14-17k characters per answer without one), and the
  // register follows the authenticated role -- athletes are assumed minors, so
  // their register drops the dark humor and holds an ~8th-grade reading level.
  const trustBoundaryPrompt = `${composeShadowSystemPrompt({ role: userRole, sessionType })}

## EVIDENCE BOUNDARY
Only describe a claim as supported, proven, or evidence-based when verified evidence for that claim is present in the authorized request context. Never invent citations, case counts, confidence values, or outcomes. When verified evidence is absent, label the claim RESEARCH NEEDED.`;
  if (highRiskClassification && highRiskClassification in FALLBACK_RESPONSES) {
    return {
      llmResponse: FALLBACK_RESPONSES[highRiskClassification],
      resolvedAsync: false,
      state: 'filtered',
    };
  }

  const personalization = unlockState && isFeatureEnabled(unlockState, 'strong_personalization')
    ? buildPersonalizationPrompt(userProfile, tierResult)
    : '';
  const capabilityAuthorizedPrompt = `${trustBoundaryPrompt}${personalization}`;

  // Background generation remains fail-closed until the worker can carry the
  // exact server-owned evidence bundle through completion and persist its
  // citations. Heavy Bag therefore runs synchronously even when preferAsync is
  // requested. Unsupported async-only session types are rejected before this
  // function is reached.

  const prompt = `${capabilityAuthorizedPrompt}

## AUTHORIZED REQUEST CONTEXT
${contextOutput.context}

Use only this authorized role and scope. Do not infer or disclose data outside it.`;

  if (sessionType === 'heavy_bag') {
    try {
      const runtime = getAzureAiRuntimeConfig();
      if (!runtime.ok || !runtime.config) {
        console.error('Heavy Bag runtime is not configured');
        return { llmResponse: DEGRADED_RESPONSE, resolvedAsync: false, state: 'degraded' };
      }

      const result = await withProviderTimeout(executeHeavyBagSync(
        { message, userId, organizationId, role: userRole as PilotRole, userProfile, tierResult,
          contextOutput, classification, sessionType: 'heavy_bag', athleteId, systemPromptBase: prompt,
          conversationHistory },
        runtime.config.endpoint,
        runtime.config.apiKey,
      ), PROVIDER_TIMEOUT_BACKSTOP_MS);
      if (!result.response?.trim()) {
        return { llmResponse: DEGRADED_RESPONSE, resolvedAsync: false, state: 'degraded' };
      }
      return { llmResponse: result.response, resolvedAsync: false, state: 'ok' };
    } catch {
      return { llmResponse: DEGRADED_RESPONSE, resolvedAsync: false, state: 'degraded' };
    }
  }

  const azureResult = await callAzureOpenAI(prompt, message, conversationHistory);
  return {
    llmResponse: azureResult.success ? azureResult.response : DEGRADED_RESPONSE,
    resolvedAsync: false,
    state: azureResult.success ? 'ok' : 'degraded',
  };
}

export const runtime = 'nodejs';

// Sourced from shadowRoleSets.ts rather than restated here. This route
// previously kept its own literal copy of the same four roles, which is exactly
// the divergence hazard that file's header warns about: a copy that drifts is
// invisible in review.
const MANUAL_OVERRIDE_ROLES = new Set<PilotRole>(MANUAL_OVERRIDE_ROLE_LIST);
const SESSION_TYPE_OVERRIDES = new Set<import('@/src/server/pilot/shadowRouter').ShadowSessionType>([
  'quick_round',
  'heavy_bag',
  'film_study',
  'scout_report',
  'board_summary',
  'recovery_round',
]);

function resolveSessionType(input: {
  userRequestedTier: ShadowTier | undefined;
  requestedSessionType: string | undefined;
  effectiveTier: ShadowTier;
  role: PilotRole;
}): import('@/src/server/pilot/shadowRouter').ShadowSessionType {
  const canOverride = MANUAL_OVERRIDE_ROLES.has(input.role);
  if (canOverride && input.requestedSessionType) {
    const candidate = input.requestedSessionType as import('@/src/server/pilot/shadowRouter').ShadowSessionType;
    if (SESSION_TYPE_OVERRIDES.has(candidate)) {
      return candidate;
    }
  }

  return tierToSessionType(input.effectiveTier, input.role, input.userRequestedTier !== undefined);
}

export async function POST(request: NextRequest): Promise<NextResponse<ShadowChatResponse>> {
  try {
    // Authenticate via session cookie (consistent with all other SHADOW routes)
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'coach', 'athlete', 'parent', 'organization_admin', 'staff', 'volunteer', 'platform_owner']);
    const userId = principal.accountId;
    const userRole = principal.role;
    const organizationId = principal.organizationId;

    let body: ShadowChatRequest;
    try {
      const parsed = await request.json() as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('invalid_body');
      }
      body = parsed as ShadowChatRequest;
    } catch {
      return NextResponse.json(
        {
          success: false,
          state: 'filtered',
          response: 'SHADOW could not process that request.',
          messageId: `msg_${Date.now()}`,
          createdAt: new Date().toISOString(),
          filtered: true,
          requiresHumanReview: false,
          evidenceTier: 'RESEARCH_NEEDED',
          handoff: resolveHandoff({ requiresHumanReview: false, topic: undefined }),
          error: 'Request body must be valid JSON.',
        },
        { status: 400 },
      );
    }
    const {
      message: rawMessage,
      conversationId: requestedConversationId,
      athleteId,
      tier: userRequestedTier,
      sessionType: requestedSessionType,
      preferAsync = false,
    } = body;

    if (
      typeof rawMessage !== 'string'
      || rawMessage.trim().length === 0
      || rawMessage.length > MAX_MESSAGE_LENGTH
      || (requestedConversationId !== undefined
        && !isUuid(requestedConversationId))
      || (athleteId !== undefined
        && (typeof athleteId !== 'string' || !athleteId.trim() || athleteId.length > 200))
      || (userRequestedTier !== undefined
        && userRequestedTier !== 'quick_round' && userRequestedTier !== 'heavy_bag')
      || (requestedSessionType !== undefined
        && (typeof requestedSessionType !== 'string' || !SESSION_TYPE_OVERRIDES.has(
          requestedSessionType as import('@/src/server/pilot/shadowRouter').ShadowSessionType,
        )))
      || typeof preferAsync !== 'boolean'
    ) {
      return NextResponse.json(
        {
          success: false,
          state: 'filtered',
          response: 'Enter a question for SHADOW.',
          messageId: `msg_${Date.now()}`,
          createdAt: new Date().toISOString(),
          filtered: true,
          requiresHumanReview: false,
          evidenceTier: 'RESEARCH_NEEDED',
          handoff: resolveHandoff({ requiresHumanReview: false, topic: undefined }),
          error: 'Request fields are invalid or exceed their allowed size.',
        },
        { status: 400 },
      );
    }
    const message = rawMessage.trim();

    // Chat was the only SHADOW route without a readiness guard, which is why an
    // unmigrated environment surfaced here as an opaque 500 rather than a 503
    // naming the missing tables. Every table listed below is written on a path
    // that is NOT wrapped in a local catch, so its absence fails the request:
    // rate limiting inserts a bucket before anything else runs, and the
    // conversation write happens after a successful model response -- which
    // would otherwise discard an answer the user already paid for.
    // Tables used only by best-effort, catch-wrapped writes (the human-review
    // queue, the evidence bundle, the chat audit row) are deliberately omitted
    // so that a partially migrated environment can still serve chat.
    await assertShadowRuntimeReadiness({
      requiredTables: [
        'shadow_rate_limit_buckets',
        'shadow_user_profiles',
        'shadow_chat_sessions',
        'shadow_chat_messages',
      ],
    });

    await enforceShadowRateLimit({
      organizationId,
      accountId: userId,
      ...resolveShadowRateLimit('chat'),
    });
    await enforceShadowRateLimit({
      organizationId,
      accountId: userId,
      ...resolveShadowRateLimit('chat_daily'),
    });

    if (athleteId) {
      await assertActorCanAccessAthlete(principal, athleteId);
    }
    if (requestedConversationId) {
      await assertConversationAccess({
        actor: principal,
        conversationId: requestedConversationId,
        athleteId,
        requireExactSubject: true,
      });
    }

    const canUseManualOverride = MANUAL_OVERRIDE_ROLES.has(userRole as PilotRole);
    const sanitizedTier = canUseManualOverride ? userRequestedTier : undefined;

    // Step 1: Classify request + route via The Corner
    const classification = classifyRequest(message, userRole as PilotRole, sanitizedTier);
    const effectiveTier = classification.tier;
    const sessionType = resolveSessionType({
      userRequestedTier: sanitizedTier,
      requestedSessionType,
      effectiveTier,
      role: userRole as PilotRole,
    });

    if (sessionType === 'film_study' || sessionType === 'recovery_round') {
      return NextResponse.json(
        {
          success: false,
          state: 'filtered',
          response: sessionType === 'film_study'
            ? 'Film Study is not available in text chat. Use the dedicated video-analysis workflow.'
            : 'Recovery Round is an internal background workflow and cannot be started from chat.',
          messageId: `msg_${Date.now()}`,
          createdAt: new Date().toISOString(),
          filtered: true,
          requiresHumanReview: false,
          evidenceTier: 'RESEARCH_NEEDED',
          handoff: resolveHandoff({ requiresHumanReview: false, topic: undefined }),
          tier: effectiveTier,
          complexity: classification.complexity,
          error: 'The requested SHADOW session type is not available from chat.',
        },
        { status: 400 },
      );
    }
    if (sessionType === 'scout_report' || sessionType === 'board_summary') {
      return NextResponse.json(
        {
          success: false,
          state: 'degraded',
          response: 'This background SHADOW mode is not active until the secure job worker is configured.',
          messageId: `msg_${Date.now()}`,
          createdAt: new Date().toISOString(),
          filtered: false,
          requiresHumanReview: false,
          evidenceTier: 'RESEARCH_NEEDED',
          handoff: resolveHandoff({ requiresHumanReview: false, topic: undefined }),
          tier: effectiveTier,
          complexity: classification.complexity,
          error: 'Background worker unavailable.',
        },
        { status: 503 },
      );
    }

    // Step 2: Validate request first (blocks diagnosis, clearance, prescription for non-educational queries)
    const requestValidation = validateShadowRequest(message, userRole, organizationId);
    if (!requestValidation.valid) {
      const messageId = `msg_${Date.now()}`;
      await queueHumanReview({
        organizationId,
        accountId: userId,
        conversationId: requestedConversationId,
        category: requestValidation.topic ?? 'safety_boundary',
        severity: ['chest_pain', 'fainting', 'loss_of_consciousness', 'urgent_personal_symptom']
          .includes(requestValidation.classification ?? '')
          ? 'critical'
          : 'high',
        summary: 'A SHADOW chat request was withheld by the pre-generation safety boundary.',
        metadata: {
          sessionType,
          athleteScoped: Boolean(athleteId),
          validationClassification: requestValidation.classification ?? null,
        },
      }).catch(() => {
        console.error('SHADOW human-review queue write failed');
      });
      return NextResponse.json(
        {
          success: false,
          state: 'filtered',
          response: requestValidation.error || 'Request validation failed',
          messageId,
          createdAt: new Date().toISOString(),
          filtered: true,
          requiresHumanReview: true,
          highRiskTopic: requestValidation.topic,
          evidenceTier: 'RESEARCH_NEEDED',
          handoff: resolveHandoff({ requiresHumanReview: true, topic: requestValidation.topic }),
          tier: effectiveTier,
          complexity: classification.complexity,
          error: requestValidation.error,
        },
        { status: 400 },
      );
    }

    const interactionTopic = requestValidation.topic && requestValidation.topic !== 'none'
      ? requestValidation.topic
      : (classification.topic || 'general');

    // Step 3: Load personal user shadow profile + classify profiling tier
    const userProfile = await getOrCreateShadowUserProfile(userId, organizationId, userRole as PilotRole);
    const tierResult = classifyProfileTier(userProfile);
    const unlockState = await evaluateShadowUnlockState({ organizationId, accountId: userId }).catch(() => null);
    const routing = routeRequest(sessionType, userRole as PilotRole, classification.complexity);

    // Step 4: Build tier-aware context (Quick Round = lightweight, Heavy Bag = full)
    const contextOutput = buildShadowContext({
      tier: effectiveTier,
      userProfile,
      userMessage: message,
      userRole: userRole as PilotRole,
      organizationId,
      athleteId,
    });

    // Step 5: Retrieve role-based context and merge with tier-aware context
    const roleBasedContext = await retrieveShadowContext({
      userRole,
      userId,
      organizationId,
      actorAthleteId: principal.athleteId,
      athleteId,
    });

    if (!roleBasedContext.authorized) {
      return NextResponse.json(
        {
          success: false,
          state: 'filtered',
          response: roleBasedContext.reason || 'Not authorized to access this context',
          messageId: `msg_${Date.now()}`,
          createdAt: new Date().toISOString(),
          filtered: true,
          requiresHumanReview: false,
          evidenceTier: 'RESEARCH_NEEDED',
          handoff: resolveHandoff({ requiresHumanReview: false, topic: undefined }),
          tier: effectiveTier,
          complexity: classification.complexity,
          error: roleBasedContext.reason,
        },
        { status: 403 },
      );
    }

    const transientMessageId = `msg_${Date.now()}`;
    const createdAt = new Date();
    const evidenceBundle = await retrieveShadowEvidenceBundle({
      actor: principal,
      subjectId: athleteId,
      queryText: message,
    }).catch(() => {
      console.error('SHADOW evidence retrieval unavailable');
      return unavailableShadowEvidenceBundle();
    });
    // Omega breadth: the platform tier may draw on aggregate operational
    // counters from every gym, but only when the question is actually about
    // more than one gym. crossOrganizationRead is the switch -- it is false for
    // every other role, so no other role's turn changes shape. The trigger is a
    // fixed pattern match, so an unrecognized phrasing simply falls through to
    // the single-organization behavior that shipped before this existed.
    //
    // Depth is unaffected: this adds aggregate counters only. Per-athlete access
    // is still refused upstream by assertActorCanAccessAthlete, which throws
    // unconditionally for platform_owner, and the evidence bundle below stays
    // scoped to the caller's own organization.
    const chatCapabilities = getShadowChatCapabilities(userRole as PilotRole);
    const wantsPlatformScope = chatCapabilities.crossOrganizationRead
      && mentionsCrossOrganizationScope(message);
    const platformRollup = wantsPlatformScope
      ? await getPlatformRollup().catch((error) => {
          console.error('SHADOW platform rollup unavailable', error);
          return null;
        })
      : null;
    // Falling back to '' here would drop the block and leave the model answering
    // a cross-gym question from its single-gym persona with nothing to signal the
    // gap -- which the platform owner reads as a real answer about the whole
    // platform. Naming the gap keeps a failed rollup degraded instead of
    // confidently wrong. Covers an empty render too, not only a thrown rollup.
    const platformContext = wantsPlatformScope
      ? (platformRollup ? formatPlatformRollup(platformRollup) : '') || PLATFORM_SCOPE_UNAVAILABLE_CONTEXT
      : '';
    // Rollup figures are quantities, and validateShadowResponse discards a stated
    // quantity that carries no authorized citation. Rather than exempt this path
    // from that rule -- the same rule that stops an uncited clinical claim -- each
    // rendered gym carries a server-derived evidence id, authorized here.
    const platformEvidenceIds = platformRollup ? platformRollupEvidenceIds(platformRollup) : [];

    const authorizedContextOutput = {
      ...contextOutput,
      context: [
        roleBasedContext.context,
        contextOutput.context,
        platformContext,
        evidenceBundle.context,
      ].filter(Boolean).join('\n\n'),
    };
    const conversationHistory = requestedConversationId
      ? (await loadConversationMessages({
          actor: principal,
          conversationId: requestedConversationId,
          limit: 10,
        })).map((historyMessage) => ({
          role: historyMessage.role,
          content: historyMessage.content,
        }))
      : [];

    // Step 6: Route to correct model via The Corner
    const { llmResponse, resolvedAsync, asyncJobId, state: providerState } = await routeLlmCall({
      sessionType, effectiveTier,
      highRiskClassification: requestValidation.classification ?? undefined,
      userProfile, tierResult, contextOutput: authorizedContextOutput, classification,
      message, userId, organizationId, userRole, athleteId, unlockState, conversationHistory,
    });

    // Step 7: Validate response BEFORE displaying to user
    const responseValidation = validateShadowResponse(llmResponse, {
      allowedEvidenceIds: [...evidenceBundle.allowedEvidenceIds, ...platformEvidenceIds],
    });
    // Platform-rollup ids are authorized for validation but are not library
    // evidence, so they are kept out of the bundle's own citation record rather
    // than persisted against a bundle they do not belong to.
    const platformEvidenceIdSet = new Set(platformEvidenceIds);
    const bundleCitationIds = responseValidation.citationIds
      .filter((citationId) => !platformEvidenceIdSet.has(citationId));
    const finalResponse = responseValidation.message;
    const citations = publicEvidenceCitations(evidenceBundle, responseValidation.citationIds);
    const state: ShadowResponseState = responseValidation.filtered ? 'filtered' : providerState;
    let messageId = transientMessageId;
    let conversationId: string | undefined;

    // Computed before persistence so the stored row and the response body carry
    // identical values -- a restored conversation has to replay what the user
    // was shown, not a recomputed approximation of it.
    const persistedEvidenceTier = deriveEvidenceTier({
      isAnsweredState: state === 'ok',
      evidenceAvailability: evidenceBundle.availability,
      citationCount: responseValidation.citationIds.length,
    });
    const persistedRequiresHumanReview = responseValidation.requiresHumanReview || state === 'filtered';
    const persistedHandoff = resolveHandoff({
      requiresHumanReview: persistedRequiresHumanReview,
      // The response's own topic wins. A benign question can still draw an
      // answer that volunteers weight-cut guidance, and resolving the handoff
      // only from the request gave that answer the generic banner instead of
      // the weight-cut one naming the medical team.
      topic: responseValidation.topic
        ?? (requestValidation.topic && requestValidation.topic !== 'none'
          ? requestValidation.topic
          : undefined),
    });

    if (state === 'ok' || state === 'filtered') {
      conversationId = await resolveConversation({
        actor: principal,
        conversationId: requestedConversationId,
        athleteId,
        sessionType,
        firstMessage: message,
      });
      messageId = await appendConversationExchange({
        actor: principal,
        conversationId,
        userMessage: message,
        assistantMessage: finalResponse,
        sessionType,
        topic: interactionTopic,
        responseState: state,
        evidenceTier: persistedEvidenceTier,
        handoff: persistedHandoff,
        evidence: evidenceBundle.bundleId
          ? {
              bundleId: evidenceBundle.bundleId,
              availability: evidenceBundle.availability,
              citationIds: bundleCitationIds,
            }
          : undefined,
      });
      if (state === 'filtered' || responseValidation.requiresHumanReview) {
        await queueHumanReview({
          organizationId,
          accountId: userId,
          conversationId,
          category: interactionTopic,
          severity: ['chest_pain', 'fainting', 'loss_of_consciousness', 'urgent_personal_symptom']
            .includes(requestValidation.classification ?? '')
            ? 'critical'
            : 'high',
          summary: 'A generated SHADOW response was replaced by the post-generation safety boundary.',
          metadata: {
            assistantMessageId: messageId,
            sessionType,
            athleteScoped: Boolean(athleteId),
            safetyReasons: responseValidation.reasons.slice(0, 10),
          },
        }).catch(() => {
          console.error('SHADOW human-review queue write failed');
        });
      }
    }

    // Step 8: Durably update the personal profile before the request lifecycle ends.
    if (state === 'ok' || state === 'queued') {
      try {
        await updateShadowUserProfile(userId, organizationId, {
          topicAdded: interactionTopic,
          athleteIdDiscussed: athleteId || undefined,
        });
      } catch {
        console.error('SHADOW profile update failed', { errorClass: 'ProfileUpdateError' });
      }
    }

    // Step 9: Audit logging with tier information
    try {
      await query(
        `INSERT INTO pilot.shadow_chat_audit 
         (organization_id, user_id, user_role, athlete_id, user_message, shadow_response, was_filtered, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          organizationId,
          userId,
          userRole,
          athleteId || null,
          `<redacted:${interactionTopic}>`,
          `<state:${state}>`,
          state === 'filtered',
          createdAt.toISOString(),
        ],
      );
    } catch {
      // Audit failures must not expose database or user content in logs.
      console.error('SHADOW audit logging failed');
    }

    const responseTopic = requestValidation.topic && requestValidation.topic !== 'none'
      ? requestValidation.topic
      : undefined;
    const responseRequiresHumanReview = persistedRequiresHumanReview;

    return NextResponse.json({
      success: state === 'ok' || state === 'queued',
      state,
      response: finalResponse,
      messageId,
      conversationId,
      createdAt: createdAt.toISOString(),
      filtered: responseValidation.filtered,
      requiresHumanReview: responseRequiresHumanReview,
      highRiskTopic: responseTopic,
      evidenceTier: persistedEvidenceTier,
      handoff: persistedHandoff,
      unlockHints: buildShadowUnlockHints(unlockState),
      tier: effectiveTier,
      complexity: classification.complexity,
      sessionType,
      profileTier: tierResult.tier,
      modelUsed: state === 'degraded' ? undefined : routing.model.displayName,
      async: resolvedAsync,
      jobId: asyncJobId,
      citations,
    });
  } catch (error) {
    if (error instanceof ShadowRateLimitExceeded) {
      return NextResponse.json(
        {
          success: false,
          state: 'filtered',
          response: shadowRateLimitMessage(error.retryAfterSeconds),
          messageId: `msg_${Date.now()}`,
          createdAt: new Date().toISOString(),
          filtered: true,
          requiresHumanReview: false,
          evidenceTier: 'RESEARCH_NEEDED',
          handoff: resolveHandoff({ requiresHumanReview: false, topic: undefined }),
          error: 'Rate limit exceeded.',
        },
        {
          status: 429,
          headers: { 'Retry-After': String(error.retryAfterSeconds) },
        },
      );
    }
    if (error instanceof Error && error.message === 'SHADOW_CONVERSATION_NOT_FOUND') {
      return NextResponse.json(
        {
          success: false,
          state: 'filtered',
          response: 'SHADOW could not process that request.',
          messageId: `msg_${Date.now()}`,
          createdAt: new Date().toISOString(),
          filtered: true,
          requiresHumanReview: false,
          evidenceTier: 'RESEARCH_NEEDED',
          handoff: resolveHandoff({ requiresHumanReview: false, topic: undefined }),
          error: 'Not found',
        },
        { status: 404 },
      );
    }
    const mappedError = jsonError(error);
    const status = mappedError.status;
    const payload = await mappedError.json().catch(() => ({ error: 'Request failed' })) as { error?: string };
    const state: ShadowResponseState = status >= 500 ? 'degraded' : 'filtered';
    return NextResponse.json(
      {
        success: false,
        state,
        response: status === 401
          ? 'Your session is no longer valid. Sign in again.'
          : status === 403
            ? 'You are not authorized to use this SHADOW scope.'
            : status >= 500
              ? DEGRADED_RESPONSE
              : 'SHADOW could not process that request.',
        messageId: `msg_${Date.now()}`,
        createdAt: new Date().toISOString(),
        filtered: state === 'filtered',
        requiresHumanReview: false,
        evidenceTier: 'RESEARCH_NEEDED',
        handoff: resolveHandoff({ requiresHumanReview: false, topic: undefined }),
        error: payload.error,
      },
      { status },
    );
  }
}
