// POST /api/pilot/shadow/chat endpoint
// Core chat interface for SHADOW with doctrine enforcement and audit logging

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/src/server/pilot/db';
import {
  validateShadowRequest,
  validateShadowResponse,
  retrieveShadowContext,
  SHADOW_SYSTEM_PROMPT,
} from '@/src/server/pilot/shadowChat';
import {
  getOrCreateShadowUserProfile,
  buildUserShadowContext,
  updateShadowUserProfile,
} from '@/src/server/pilot/shadowUserProfile';

export interface ShadowChatRequest {
  message: string;
  athleteId?: string;
  context?: string;
  organizationId: string;
}

export interface ShadowChatResponse {
  success: boolean;
  response: string;
  messageId: string;
  createdAt: string;
  filtered: boolean;
  requiresHumanReview: boolean;
  highRiskTopic?: string;
  error?: string;
}

// Fallback responses for critical topics
const FALLBACK_RESPONSES: Record<string, string> = {
  concussion: 'For concussion concerns, contact your medical team immediately. SHADOW can help you understand concussion recovery protocols and organizational best practices.',
  weight_cutting: 'Rapid weight loss carries significant health risks. Consult with your medical team and sports nutritionist. SHADOW can provide information on safe weight management practices.',
  return_to_play: 'Return-to-play decisions require medical professional evaluation. SHADOW can help you understand RTP protocols and evidence-based recovery frameworks.',
  medical_clearance: 'Medical clearance decisions are made by qualified medical professionals. SHADOW can help you understand what clearance evaluations typically include.',
};

async function callOllama(systemPrompt: string, userMessage: string): Promise<{ response: string; success: boolean }> {
  try {
    const ollamaResponse = await fetch('http://localhost:11434/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mistral',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        stream: false,
        temperature: 0.7,
      }),
    });

    if (!ollamaResponse.ok) {
      return { response: '', success: false };
    }

    const data = await ollamaResponse.json();
    const response = data.choices?.[0]?.message?.content || '';
    return { response, success: true };
  } catch {
    return { response: '', success: false };
  }
}

export async function POST(request: NextRequest): Promise<NextResponse<ShadowChatResponse>> {
  try {
    // Extract headers for authentication
    const userId = request.headers.get('x-user-id');
    const userRole = request.headers.get('x-user-role');
    const organizationId = request.headers.get('x-org-id');

    if (!userId || !userRole || !organizationId) {
      return NextResponse.json(
        {
          success: false,
          response: '',
          messageId: '',
          createdAt: '',
          filtered: false,
          requiresHumanReview: false,
          error: 'Missing authentication headers',
        },
        { status: 401 },
      );
    }

    const body: ShadowChatRequest = await request.json();
    const { message, athleteId } = body;

    // FIX 4: Validate request first (blocks diagnosis, clearance, prescription for non-educational queries)
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
          error: requestValidation.error,
        },
        { status: 400 },
      );
    }

    // FIX 2: Retrieve context with role-based authorization
    const contextResult = await retrieveShadowContext({
      userRole,
      userId,
      organizationId,
      athleteId,
    });

    // Load personal user shadow profile and inject into context
    const userProfile = await getOrCreateShadowUserProfile(userId, organizationId, userRole as any);
    const userShadowContext = buildUserShadowContext(userProfile, message);
    const enrichedContext = contextResult.authorized
      ? { ...contextResult, context: contextResult.context + userShadowContext }
      : contextResult;

    if (!enrichedContext.authorized) {
      return NextResponse.json(
        {
          success: false,
          response: enrichedContext.reason || 'Not authorized to access this context',
          messageId: `msg_${Date.now()}`,
          createdAt: new Date().toISOString(),
          filtered: true,
          requiresHumanReview: false,
          error: enrichedContext.reason,
        },
        { status: 403 },
      );
    }

    const messageId = `msg_${Date.now()}`;
    const createdAt = new Date();

    // Determine if high-risk topic and use fallback if needed
    let llmResponse: string;
    const { classification } = requestValidation;
    if (classification && classification in FALLBACK_RESPONSES) {
      llmResponse = FALLBACK_RESPONSES[classification];
    } else {
      // FIX 1: Get full response from Ollama BEFORE validation (buffered, non-streaming)
      const ollamaResult = await callOllama(SHADOW_SYSTEM_PROMPT, message);

      if (!ollamaResult.success) {
        // Fallback to safe educational response
        llmResponse = 'SHADOW is currently unavailable. Please contact your organization for support.';
      } else {
        llmResponse = ollamaResult.response;
      }
    }

    // FIX 1: Validate response BEFORE displaying to user
    const responseValidation = validateShadowResponse(llmResponse);
    const finalResponse = responseValidation.message;

    // Update user's personal shadow after successful interaction (async, don't block)
    updateShadowUserProfile(userId, organizationId, {
      topicAdded: requestValidation.topic || undefined,
      athleteIdDiscussed: athleteId || undefined,
    }).catch(() => {});

    // Audit logging
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
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        response: 'An error occurred processing your request',
        messageId: `msg_${Date.now()}`,
        createdAt: new Date().toISOString(),
        filtered: false,
        requiresHumanReview: true,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
