// POST /api/pilot/shadow/chat endpoint
// Core chat interface for SHADOW with doctrine enforcement, tier-aware routing, and audit logging
// Implements dual-mode architecture: Quick Round (fast/sync) vs Heavy Bag (deep/async)

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/src/server/pilot/db';
import { requirePrincipal, jsonError } from '@/src/server/pilot/http';
import { requireRole } from '@/src/server/pilot/access';
import {
  validateShadowRequest,
  validateShadowResponse,
  retrieveShadowContext,
  SHADOW_SYSTEM_PROMPT,
} from '@/src/server/pilot/shadowChat';
import {
  getOrCreateShadowUserProfile,
  updateShadowUserProfile,
} from '@/src/server/pilot/shadowUserProfile';
import { classifyRequest, type ShadowTier } from '@/src/server/pilot/shadowClassifier';
import { buildShadowContext } from '@/src/server/pilot/shadowContextBuilder';
import { routeRequest, tierToSessionType, isAsyncSession } from '@/src/server/pilot/shadowRouter';
import { classifyProfileTier, buildPersonalizationPrompt } from '@/src/server/pilot/shadowProfiling';
import { executeHeavyBagSync, executeHeavyBagAsync, shouldRunAsync } from '@/src/server/pilot/shadowHeavyBag';

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
  error?: string;
}

// Fallback responses for critical topics
const FALLBACK_RESPONSES: Record<string, string> = {
  concussion: 'For concussion concerns, contact your medical team immediately. SHADOW can help you understand concussion recovery protocols and organizational best practices.',
  weight_cutting: 'Rapid weight loss carries significant health risks. Consult with your medical team and sports nutritionist. SHADOW can provide information on safe weight management practices.',
  return_to_play: 'Return-to-play decisions require medical professional evaluation. SHADOW can help you understand RTP protocols and evidence-based recovery frameworks.',
  medical_clearance: 'Medical clearance decisions are made by qualified medical professionals. SHADOW can help you understand what clearance evaluations typically include.',
};

async function callAzureOpenAI(systemPrompt: string, userMessage: string): Promise<{ response: string; success: boolean }> {
  try {
    const endpoint = process.env.AZURE_AI_ENDPOINT;
    const apiKey = process.env.AZURE_AI_KEY;
    const deploymentName = process.env.AZURE_AI_DEPLOYMENT_NAME;
    const apiVersion = process.env.AZURE_AI_API_VERSION || '2024-12-01-preview';

    if (!endpoint || !apiKey || !deploymentName) {
      console.error('Azure AI credentials not configured');
      return { response: '', success: false };
    }

    // Format: https://[resource].cognitiveservices.azure.com/openai/deployments/[deployment]/chat/completions?api-version=2024-12-01-preview
    const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${deploymentName}/chat/completions?api-version=${apiVersion}`;

    const azureResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.7,
        max_completion_tokens: 4096,
      }),
    });

    if (!azureResponse.ok) {
      const errorText = await azureResponse.text();
      console.error('Azure API error:', azureResponse.status, errorText);
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
}

async function routeLlmCall(ctx: LlmRouteContext): Promise<LlmRouteResult> {
  const { sessionType, effectiveTier, preferAsync, highRiskClassification,
    userProfile, tierResult, contextOutput, classification,
    message, userId, organizationId, userRole, athleteId } = ctx;
  if (highRiskClassification && highRiskClassification in FALLBACK_RESPONSES) {
    return { llmResponse: FALLBACK_RESPONSES[highRiskClassification], resolvedAsync: false };
  }

  if (isAsyncSession(sessionType) || (shouldRunAsync(sessionType, tierResult.tier) && preferAsync)) {
    const asyncResult = await executeHeavyBagAsync({
      message, userId, organizationId, role: userRole as any, userProfile, tierResult,
      contextOutput, classification, sessionType, athleteId, systemPromptBase: SHADOW_SYSTEM_PROMPT,
    });
    return {
      llmResponse: `Your ${sessionType.replaceAll('_', ' ')} has been queued. Job ID: ${asyncResult.jobId}`,
      resolvedAsync: true,
      asyncJobId: asyncResult.jobId,
    };
  }

  const personalization = buildPersonalizationPrompt(userProfile, tierResult);
  const prompt = SHADOW_SYSTEM_PROMPT + personalization;

  if (effectiveTier === 'heavy_bag') {
    try {
      const result = await executeHeavyBagSync(
        { message, userId, organizationId, role: userRole as any, userProfile, tierResult,
          contextOutput, classification, sessionType: 'heavy_bag', athleteId, systemPromptBase: prompt },
        process.env.AZURE_AI_ENDPOINT ?? '',
        process.env.AZURE_AI_KEY ?? '',
      );
      return { llmResponse: result.response ?? 'SHADOW Heavy Bag response unavailable.', resolvedAsync: false };
    } catch {
      return { llmResponse: 'SHADOW is currently unavailable. Please contact your organization for support.', resolvedAsync: false };
    }
  }

  const azureResult = await callAzureOpenAI(prompt, message);
  return {
    llmResponse: azureResult.success ? azureResult.response : 'SHADOW is currently unavailable. Please contact your organization for support.',
    resolvedAsync: false,
  };
}

export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<NextResponse<ShadowChatResponse>> {
  try {
    // Authenticate via session cookie (consistent with all other SHADOW routes)
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'coach', 'athlete', 'parent', 'organization_admin', 'staff', 'volunteer', 'platform_owner']);
    const userId = principal.accountId;
    const userRole = principal.role;
    const organizationId = principal.organizationId;

    const body: ShadowChatRequest = await request.json();
    const { message, athleteId, tier: userRequestedTier, preferAsync = false } = body;

    // Step 1: Classify request + route via The Corner
    const classification = classifyRequest(message, userRole as any, userRequestedTier);
    const effectiveTier = classification.tier;
    const isManualOverride = userRequestedTier !== undefined;
    const sessionType = tierToSessionType(effectiveTier, userRole as any, isManualOverride);

    // Step 2: Validate request first (blocks diagnosis, clearance, prescription for non-educational queries)
    const requestValidation = await validateShadowRequest(message, userRole, organizationId);
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
    const userProfile = await getOrCreateShadowUserProfile(userId, organizationId, userRole as 'coach' | 'admin' | 'athlete' | 'parent' | 'organization_admin');
    const tierResult = classifyProfileTier(userProfile);
    const routing = routeRequest(sessionType, userRole as any, classification.complexity);

    // Step 4: Build tier-aware context (Quick Round = lightweight, Heavy Bag = full)
    const contextOutput = buildShadowContext({
      tier: effectiveTier,
      userProfile,
      userMessage: message,
      userRole: userRole as any,
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

    // Step 6: Route to correct model via The Corner
    const { llmResponse, resolvedAsync, asyncJobId } = await routeLlmCall({
      sessionType, effectiveTier, preferAsync,
      highRiskClassification: requestValidation.classification ?? undefined,
      userProfile, tierResult, contextOutput, classification,
      message, userId, organizationId, userRole, athleteId,
    });

    // Step 7: Validate response BEFORE displaying to user
    const responseValidation = validateShadowResponse(llmResponse);
    const finalResponse = responseValidation.message;

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
          message,
          finalResponse,
          responseValidation.filtered,
          createdAt.toISOString(),
        ],
      );
    } catch (auditError) {
      // Log error but don't fail the request
      console.error('Audit logging failed:', auditError);
    }

    return NextResponse.json({
      success: true,
      response: finalResponse,
      messageId,
      createdAt: createdAt.toISOString(),
      filtered: responseValidation.filtered,
      requiresHumanReview: responseValidation.requiresHumanReview,
      highRiskTopic: requestValidation.topic || undefined,
      tier: effectiveTier,
      complexity: classification.complexity,
      sessionType,
      profileTier: tierResult.tier,
      modelUsed: routing.model.displayName,
      async: resolvedAsync,
      jobId: asyncJobId,
    });
  } catch (error) {
    return jsonError(error) as NextResponse<ShadowChatResponse>;
  }
}
