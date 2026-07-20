// POST /api/pilot/shadow/chat endpoint
// Core chat interface for SHADOW with doctrine enforcement, tier-aware routing, and audit logging
// Implements dual-mode architecture: Quick Round (fast/sync) vs Heavy Bag (deep/async)

import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/src/server/pilot/db';
import { requirePrincipal, jsonError } from '@/src/server/pilot/http';
import { requireRole } from '@/src/server/pilot/access';
import type { PilotRole } from '@/src/server/pilot/contracts';
import {
  validateShadowRequest,
  validateShadowResponse,
  retrieveShadowContext,
  SHADOW_SYSTEM_PROMPT,
  MEDICAL_EDUCATION_NOTICE,
  SAFE_FILTERED_RESPONSE,
  type HighRiskTopic,
} from '@/src/server/pilot/shadowChat';
import { buildAzureAiChatCompletionsUrl, getAzureAiRuntimeConfig } from '@/src/server/pilot/azureAiRuntime';
import {
  getOrCreateShadowUserProfile,
  updateShadowUserProfile,
} from '@/src/server/pilot/shadowUserProfile';
import { classifyRequest, type ShadowTier } from '@/src/server/pilot/shadowClassifier';
import { buildShadowContext } from '@/src/server/pilot/shadowContextBuilder';
import { routeRequest, tierToSessionType, isAsyncSession } from '@/src/server/pilot/shadowRouter';
import { classifyProfileTier, buildPersonalizationPrompt } from '@/src/server/pilot/shadowProfiling';
import { executeHeavyBagSync, executeHeavyBagAsync, shouldRunAsync } from '@/src/server/pilot/shadowHeavyBag';
import { evaluateShadowUnlockState, isFeatureEnabled, type ShadowUnlockState } from '@/src/server/pilot/shadowUnlocks';
import { createShadowLibraryClaim, type ShadowLibraryClaimResult } from '@/src/server/pilot/shadowLibrary';
import {
  calculateEvidenceConfidence,
  classifySemanticSafety,
  parseStructuredShadowResponse,
  renderStructuredShadowResponse,
  type SemanticSafetyDecision,
  type StructuredShadowResponse,
} from '@/src/server/pilot/shadowResponsePolicy';

export interface ShadowChatRequest {
  message: string;
  athleteId?: string;
  context?: string;
  organizationId?: string; // Resolved from session cookie — optional override
  tier?: ShadowTier; // Optional manual tier override (coaches/admins only)
  sessionType?: string; // Optional: 'film_study' | 'scout_report' | 'board_summary'
  preferAsync?: boolean; // Client can request async for heavy sessions
}

export interface ShadowChatResponse {
  success: boolean;
  response: string;
  messageId: string;
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
  explainability?: {
    confidence: number; // 0-100, capped at 95%
    confidenceLevel: '🟢 High' | '🟡 Moderate' | '🟠 Low' | '🔴 Speculative';
    reasoning: string;
    evidenceCount: number;
    disclaimers: string[];
  };
  structured?: StructuredShadowResponse;
  safety?: SemanticSafetyDecision;
  evidence?: {
    status: 'supported' | 'weak' | 'unsupported';
    sources: Array<{ sourceId: string; title: string; documentName: string; publicationDate: string | null }>;
    researchRequirementId: number | null;
  };
  correlationId?: string;
  error?: string;
}

const PROMPT_VERSION = 'shadow-chat-2026-07-20.1';
const SAFETY_POLICY_VERSION = 'medical-education-2026-07-20.1';

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

const FALLBACK_RESPONSES: Partial<Record<HighRiskTopic, string>> = {
  concussion: `${MEDICAL_EDUCATION_NOTICE}\n\nConcussion signs can include headache, dizziness, confusion, balance problems, memory difficulty, nausea, vision changes, or unusual behavior. These signs could be consistent with concussion, but they may have other causes and do not establish a diagnosis. Stop participation and arrange evaluation by a physician or other appropriately licensed healthcare professional. If there was loss of consciousness, repeated vomiting, seizure, slurred speech, unequal pupils, worsening symptoms, or difficulty waking, seek emergency help now.`,
  weight_cutting: `${MEDICAL_EDUCATION_NOTICE}\n\nRapid weight loss may be associated with dehydration, electrolyte disturbance, heat illness, impaired judgment, reduced performance, and other serious complications. Do not use this information to decide that a weight-cut method is safe. Discuss weight management with a physician and registered dietitian who understand combat sports.`,
  return_to_play: `${MEDICAL_EDUCATION_NOTICE}\n\nReturn-to-participation protocols commonly use staged activity, symptom monitoring, and reassessment. This describes the process; it does not clear any individual. A licensed healthcare professional with authority under the applicable policy must make the return decision.`,
  medical_clearance: `${MEDICAL_EDUCATION_NOTICE}\n\nA clearance evaluation may review symptoms, examination findings, recovery progress, functional testing, and sport-specific risk. This information cannot determine whether a person is cleared. That decision belongs to an appropriately licensed healthcare professional.`,
};

const URGENT_MEDICAL_RESPONSE = `${MEDICAL_EDUCATION_NOTICE}\n\nThe symptoms described could require urgent or emergency evaluation. Stop participation. Contact local emergency services or an onsite licensed medical professional now, especially for chest pain, severe breathing difficulty, loss of consciousness, inability to wake, seizure, worsening symptoms after a head injury, or immediate danger. Do not delay emergency care to continue this chat.`;

function evidenceToPromptContext(claim: ShadowLibraryClaimResult | null): string {
  if (!claim) return 'No evidence retrieval result was available. Mark substantive claims RESEARCH NEEDED.';
  if (claim.status === 'unsupported') {
    return `Evidence status: UNSUPPORTED. Do not improvise a factual claim. Research requirement: ${claim.researchRequirementId ?? "not created"}.`;
  }
  const items = claim.evidence.slice(0, 5).map((item) => ({
    sourceId: item.source_id,
    title: item.source_title,
    document: item.document_name,
    publicationDate: item.publication_date,
    authorityTier: item.authority_tier,
    excerpt: item.text_content.slice(0, 800),
  }));
  return `Evidence status: ${claim.status.toUpperCase()}\n${JSON.stringify(items)}`;
}

async function loadRecentConversation(organizationId: string, userId: string, athleteId?: string): Promise<ChatTurn[]> {
  try {
    const rows = athleteId
      ? await query<{ user_message: string; shadow_response: string }>(
          `SELECT user_message, shadow_response FROM pilot.shadow_chat_audit
           WHERE organization_id = $1 AND user_id = $2 AND athlete_id = $3
           ORDER BY created_at DESC LIMIT 6`,
          [organizationId, userId, athleteId],
        )
      : await query<{ user_message: string; shadow_response: string }>(
          `SELECT user_message, shadow_response FROM pilot.shadow_chat_audit
           WHERE organization_id = $1 AND user_id = $2 AND athlete_id IS NULL
           ORDER BY created_at DESC LIMIT 6`,
          [organizationId, userId],
        );

    return rows.reverse().flatMap((row) => [
      { role: 'user' as const, content: row.user_message.slice(0, 2000) },
      { role: 'assistant' as const, content: row.shadow_response.slice(0, 3000) },
    ]);
  } catch (error) {
    console.error('SHADOW conversation history retrieval failed:', error);
    return [];
  }
}

async function callAzureOpenAI(systemPrompt: string, userMessage: string, recentConversation: ChatTurn[]): Promise<{ response: string; success: boolean }> {
  try {
    const runtime = getAzureAiRuntimeConfig();
    if (!runtime.ok || !runtime.config) {
      console.error(`Azure AI runtime is not configured. Missing: ${runtime.missing.join(', ')}`);
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
          ...recentConversation,
          { role: 'user', content: userMessage },
        ],
        max_completion_tokens: 4096,
      }),
    });

    if (!azureResponse.ok) {
      console.error('Azure API error:', azureResponse.status);
      return { response: '', success: false };
    }

    const data = await azureResponse.json();
    const response = data.choices?.[0]?.message?.content || '';
    return { response, success: true };
  } catch (error) {
    console.error('Azure OpenAI call failed:', error);
    return { response: '', success: false };
  }
}

interface LlmRouteResult {
  llmResponse: string;
  resolvedAsync: boolean;
  asyncJobId?: string;
}

interface LlmRouteContext {
  sessionType: import('@/src/server/pilot/shadowRouter').ShadowSessionType;
  effectiveTier: import('@/src/server/pilot/shadowClassifier').ShadowTier;
  preferAsync: boolean;
  highRiskTopic: HighRiskTopic | undefined;
  urgent: boolean;
  recentConversation: ChatTurn[];
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
}

async function routeLlmCall(ctx: LlmRouteContext): Promise<LlmRouteResult> {
  const { sessionType, effectiveTier, preferAsync, highRiskTopic, urgent, recentConversation,
    userProfile, tierResult, contextOutput, classification,
    message, userId, organizationId, userRole, athleteId, unlockState } = ctx;
  if (urgent) {
    return { llmResponse: URGENT_MEDICAL_RESPONSE, resolvedAsync: false };
  }
  if (highRiskTopic && FALLBACK_RESPONSES[highRiskTopic]) {
    return { llmResponse: FALLBACK_RESPONSES[highRiskTopic]!, resolvedAsync: false };
  }

  if (isAsyncSession(sessionType) || (shouldRunAsync(sessionType, tierResult.tier) && preferAsync)) {
    const asyncResult = await executeHeavyBagAsync({
      message, userId, organizationId, role: userRole as PilotRole, userProfile, tierResult,
      contextOutput, classification, sessionType, athleteId, systemPromptBase: SHADOW_SYSTEM_PROMPT,
    });
    return {
      llmResponse: `Your ${sessionType.replaceAll('_', ' ')} has been queued. Job ID: ${asyncResult.jobId}`,
      resolvedAsync: true,
      asyncJobId: asyncResult.jobId,
    };
  }

  const personalization = unlockState && isFeatureEnabled(unlockState, 'strong_personalization')
    ? buildPersonalizationPrompt(userProfile, tierResult)
    : '';
  const prompt = [
    SHADOW_SYSTEM_PROMPT,
    personalization,
    contextOutput.context ? `\n## Authorized Context\n${contextOutput.context}` : '',
    `\n## Runtime Policy Versions\n- Prompt: ${PROMPT_VERSION}\n- Safety: ${SAFETY_POLICY_VERSION}`,
  ].filter(Boolean).join('\n');

  if (effectiveTier === 'heavy_bag') {
    try {
      const runtime = getAzureAiRuntimeConfig();
      if (!runtime.ok || !runtime.config) {
        console.error(`Heavy Bag runtime unavailable. Missing Azure AI config: ${runtime.missing.join(', ')}`);
        return { llmResponse: 'SHADOW is currently unavailable. Please contact your organization for support.', resolvedAsync: false };
      }

      const result = await executeHeavyBagSync(
        { message, userId, organizationId, role: userRole as PilotRole, userProfile, tierResult,
          contextOutput, classification, sessionType: 'heavy_bag', athleteId, systemPromptBase: prompt },
        runtime.config.endpoint,
        runtime.config.apiKey,
      );
      return { llmResponse: result.response ?? 'SHADOW Heavy Bag response unavailable.', resolvedAsync: false };
    } catch {
      return { llmResponse: 'SHADOW is currently unavailable. Please contact your organization for support.', resolvedAsync: false };
    }
  }

  const azureResult = await callAzureOpenAI(prompt, message, recentConversation);
  return {
    llmResponse: azureResult.success ? azureResult.response : 'SHADOW is currently unavailable. Please contact your organization for support.',
    resolvedAsync: false,
  };
}

export const runtime = 'nodejs';

const MANUAL_OVERRIDE_ROLES = new Set<PilotRole>(['coach', 'admin', 'organization_admin', 'platform_owner']);
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

    const correlationId = randomUUID();
    const body: ShadowChatRequest = await request.json();
    const { message, athleteId, tier: userRequestedTier, sessionType: requestedSessionType, preferAsync = false } = body;
    if (typeof message !== 'string' || message.trim().length === 0 || message.length > 10_000) {
      return NextResponse.json({
        success: false,
        response: 'Message must be a non-empty string no longer than 10,000 characters.',
        messageId: `msg_${Date.now()}`,
        createdAt: new Date().toISOString(),
        filtered: true,
        requiresHumanReview: false,
        correlationId,
        error: 'Invalid message',
      }, { status: 400 });
    }
    if (athleteId !== undefined && (typeof athleteId !== 'string' || athleteId.length > 200)) {
      return NextResponse.json({
        success: false,
        response: 'Athlete context identifier is invalid.',
        messageId: `msg_${Date.now()}`,
        createdAt: new Date().toISOString(),
        filtered: true,
        requiresHumanReview: false,
        correlationId,
        error: 'Invalid athlete context',
      }, { status: 400 });
    }

    const normalizedMessage = message.trim();
    const canUseManualOverride = MANUAL_OVERRIDE_ROLES.has(userRole as PilotRole);
    const sanitizedTier = canUseManualOverride ? userRequestedTier : undefined;

    // Step 1: Classify request + route via The Corner
    const classification = classifyRequest(normalizedMessage, userRole as PilotRole, sanitizedTier);
    const effectiveTier = classification.tier;
    const sessionType = resolveSessionType({
      userRequestedTier: sanitizedTier,
      requestedSessionType,
      effectiveTier,
      role: userRole as PilotRole,
    });

    // Step 2: Validate request first (blocks diagnosis, clearance, prescription for non-educational queries)
    const requestValidation = validateShadowRequest(normalizedMessage, userRole, organizationId);
    if (!requestValidation.valid) {
      const messageId = `msg_${Date.now()}`;
      return NextResponse.json(
        {
          success: false,
          response: requestValidation.error || 'Request validation failed',
          messageId,
          createdAt: new Date().toISOString(),
          filtered: true,
          requiresHumanReview: true,
          highRiskTopic: requestValidation.topic,
          tier: effectiveTier,
          complexity: classification.complexity,
          error: requestValidation.error,
        },
        { status: 400 },
      );
    }

    // Step 3: Load personal user shadow profile + classify profiling tier
    const userProfile = await getOrCreateShadowUserProfile(userId, organizationId, userRole as PilotRole);
    const tierResult = classifyProfileTier(userProfile);
    const unlockState = await evaluateShadowUnlockState({ organizationId, accountId: userId }).catch(() => null);
    const routing = routeRequest(sessionType, userRole as PilotRole, classification.complexity);

    // Step 4: Build tier-aware context (Quick Round = lightweight, Heavy Bag = full)
    const contextOutput = buildShadowContext({
      tier: effectiveTier,
      userProfile,
      userMessage: normalizedMessage,
      userRole: userRole as PilotRole,
      organizationId,
      athleteId,
    });

    // Step 5: Retrieve role-based context and merge with tier-aware context
    const roleBasedContext = await retrieveShadowContext({
      userRole,
      userId,
      organizationId,
      athleteId,
    });

    if (!roleBasedContext.authorized) {
      return NextResponse.json(
        {
          success: false,
          response: roleBasedContext.reason || 'Not authorized to access this context',
          messageId: `msg_${Date.now()}`,
          createdAt: new Date().toISOString(),
          filtered: true,
          requiresHumanReview: false,
          tier: effectiveTier,
          complexity: classification.complexity,
          error: roleBasedContext.reason,
        },
        { status: 403 },
      );
    }

    const messageId = `msg_${Date.now()}`;
    const createdAt = new Date();
    const evidenceClaim = requestValidation.urgent
      ? null
      : await createShadowLibraryClaim({
          organizationId,
          actorAccountId: userId,
          actorRole: userRole,
          athleteId: userRole === 'athlete' ? athleteId ?? null : null,
          scope: athleteId ? 'subject' : (['admin', 'organization_admin', 'platform_owner'].includes(userRole) ? 'master' : 'scoped'),
          subjectId: athleteId ?? null,
          question: normalizedMessage,
          limit: 5,
        }).catch((error) => {
          console.error('SHADOW evidence retrieval failed:', error);
          return null;
        });
    const recentConversation = await loadRecentConversation(organizationId, userId, athleteId);
    const authorizedContextOutput = {
      ...contextOutput,
      context: [
        contextOutput.context,
        roleBasedContext.context,
        `## Retrieved Evidence\n${evidenceToPromptContext(evidenceClaim)}`,
        sessionType !== 'quick_round' && recentConversation.length > 0
          ? `## Recent Conversation\n${JSON.stringify(recentConversation)}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n## Role-authorized context\n'),
    };

    // Step 6: Route to correct model via The Corner
    const { llmResponse, resolvedAsync, asyncJobId } = await routeLlmCall({
      sessionType, effectiveTier, preferAsync,
      highRiskTopic: requestValidation.topic,
      urgent: requestValidation.urgent === true,
      recentConversation,
      userProfile, tierResult, contextOutput: authorizedContextOutput, classification,
      message: normalizedMessage, userId, organizationId, userRole, athleteId, unlockState,
    });

    // Step 7: Enforce structured output, then run semantic and deterministic post-generation checks.
    const availableEvidenceIds = evidenceClaim?.evidence.map((item) => item.chunk_id) ?? [];
    const structuredResult = parseStructuredShadowResponse(llmResponse, availableEvidenceIds);
    const structuredResponse = renderStructuredShadowResponse(structuredResult.value);
    const semanticSafety = classifySemanticSafety(structuredResponse);
    const responseValidation = validateShadowResponse(structuredResponse);
    const semanticBlocked = semanticSafety.allowedMode === 'block';
    const finalResponse = semanticBlocked ? SAFE_FILTERED_RESPONSE : responseValidation.message;
    const wasFiltered = semanticBlocked || responseValidation.filtered;
    const requiresHumanReview = semanticSafety.requiresHumanReview || responseValidation.requiresHumanReview || !structuredResult.schemaValid;
    const evidenceConfidence = evidenceClaim
      ? calculateEvidenceConfidence(
          evidenceClaim.status,
          evidenceClaim.evidence.map((item) => ({
            sourceId: item.source_id,
            authorityTier: item.authority_tier,
            publicationDate: item.publication_date,
          })),
        )
      : null;

    // Step 8: Update user's personal shadow after successful interaction (async, don't block)
    updateShadowUserProfile(userId, organizationId, {
      topicAdded: requestValidation.topic || undefined,
      athleteIdDiscussed: athleteId || undefined,
    }).catch(() => {});

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
          normalizedMessage,
          finalResponse,
          wasFiltered,
          createdAt.toISOString(),
        ],
      );
      await query(
        `INSERT INTO pilot.shadow_telemetry_events
         (organization_id, metric_name, actor_account_id, actor_role, dimensions, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, CURRENT_TIMESTAMP)`,
        [organizationId, 'shadow_chat_response', userId, userRole, JSON.stringify({
          correlationId,
          messageId,
          tier: effectiveTier,
          sessionType,
          complexity: classification.complexity,
          filtered: wasFiltered,
          requiresHumanReview,
          semanticRiskLevel: semanticSafety.riskLevel,
          semanticCategory: semanticSafety.category,
          semanticAllowedMode: semanticSafety.allowedMode,
          structuredSchemaValid: structuredResult.schemaValid,
          structuredIssueCount: structuredResult.issues.length,
          promptVersion: PROMPT_VERSION,
          safetyPolicyVersion: SAFETY_POLICY_VERSION,
          model: routing.model.displayName,
          conversationTurnCount: recentConversation.length,
          authorizedContextIncluded: Boolean(roleBasedContext.context),
          evidenceStatus: evidenceClaim?.status ?? 'unavailable',
          evidenceCount: evidenceClaim?.evidence.length ?? 0,
          researchRequirementId: evidenceClaim?.researchRequirementId ?? null,
        })],
      );
    } catch (auditError) {
      // Log error but don't fail the request
      console.error('Audit logging failed:', auditError);
    }

    const confidenceLevelMap: Record<string, ShadowChatResponse['explainability'] extends infer T ? string : never> = {};
    void confidenceLevelMap;
    const explainability: ShadowChatResponse['explainability'] | undefined = evidenceConfidence ? {
      confidence: Math.round(evidenceConfidence.score * 100),
      confidenceLevel: evidenceConfidence.level === 'high'
        ? '🟢 High'
        : evidenceConfidence.level === 'moderate'
          ? '🟡 Moderate'
          : evidenceConfidence.level === 'low'
            ? '🟠 Low'
            : '🔴 Speculative',
      reasoning: evidenceConfidence.factors.join('; '),
      evidenceCount: evidenceClaim?.evidence.length ?? 0,
      disclaimers: evidenceClaim?.status === 'supported'
        ? []
        : ['Evidence is incomplete; treat the answer as educational and subject to human review.'],
    } : undefined;

    return NextResponse.json({
      success: true,
      response: finalResponse,
      messageId,
      createdAt: createdAt.toISOString(),
      filtered: wasFiltered,
      requiresHumanReview,
      highRiskTopic: requestValidation.topic || undefined,
      tier: effectiveTier,
      complexity: classification.complexity,
      sessionType,
      profileTier: tierResult.tier,
      modelUsed: routing.model.displayName,
      async: resolvedAsync,
      jobId: asyncJobId,
      explainability,
      structured: structuredResult.value,
      safety: semanticSafety,
      evidence: evidenceClaim ? {
        status: evidenceClaim.status,
        sources: evidenceClaim.evidence.slice(0, 5).map((item) => ({
          sourceId: item.source_id,
          title: item.source_title,
          documentName: item.document_name,
          publicationDate: item.publication_date,
        })),
        researchRequirementId: evidenceClaim.researchRequirementId,
      } : undefined,
      correlationId,
    });
  } catch (error) {
    return jsonError(error) as NextResponse<ShadowChatResponse>;
  }
}
