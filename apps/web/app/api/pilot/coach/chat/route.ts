// POST /api/pilot/coach/chat endpoint
// Chat interface for coaches with role-based access control
// Supports coaching-specific queries around athlete development, assessment, and strategy

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import { requireRole } from '@/src/server/pilot/access';
import { buildAzureAiChatCompletionsUrl, getAzureAiRuntimeConfig } from '@/src/server/pilot/azureAiRuntime';

export interface CoachChatRequest {
  message: string;
  athleteId?: string;
  context?: string;
  organizationId?: string;
}

export interface CoachChatResponse {
  success: boolean;
  response: string;
  messageId: string;
  createdAt: string;
  error?: string;
}

const COACH_SYSTEM_PROMPT = `You are an AI assistant designed to support sports coaches. Your role is to:
- Provide coaching strategies and athlete development insights
- Offer guidance on training methodologies, periodization, and performance optimization
- Help analyze athlete data and progression patterns
- Suggest assessment frameworks and communication strategies
- Support decision-making for athlete development, roster management, and team dynamics

Always maintain a professional coaching perspective. If asked about medical diagnosis or treatment, redirect to medical professionals.`;

async function callAzureOpenAI(systemPrompt: string, userMessage: string): Promise<{ response: string; success: boolean }> {
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
          { role: 'user', content: userMessage },
        ],
        max_completion_tokens: 2048,
      }),
    });

    if (!azureResponse.ok) {
      const errorText = await azureResponse.text();
      console.error('Azure API error:', azureResponse.status, errorText);
      return { response: '', success: false };
    }

    const data = await azureResponse.json();
    const response = data.choices?.[0]?.message?.content || '';
    return { response, success: !!response };
  } catch (error) {
    console.error('Error calling Azure OpenAI:', error);
    return { response: '', success: false };
  }
}

export async function POST(request: NextRequest): Promise<NextResponse<CoachChatResponse>> {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach']);

    const body: CoachChatRequest = await request.json();
    const { message, athleteId, organizationId } = body;

    if (!message || !message.trim()) {
      return NextResponse.json(
        { success: false, response: '', messageId: '', createdAt: '', error: 'Message is required' },
        { status: 400 }
      );
    }

    const messageId = `msg_${Date.now()}`;
    const createdAt = new Date().toISOString();
    const org = organizationId || principal.organizationId;

    // Call Azure OpenAI
    const { response, success } = await callAzureOpenAI(COACH_SYSTEM_PROMPT, message);

    if (!success) {
      return NextResponse.json(
        {
          success: false,
          response: '',
          messageId,
          createdAt,
          error: 'Failed to generate response from AI service',
        },
        { status: 500 }
      );
    }

    // Log to coach_chat_audit table (create if doesn't exist)
    try {
      await query(
        `INSERT INTO pilot.coach_chat_audit (
          coach_chat_audit_id, organization_id, coach_id, athlete_id, message, response, created_at
        ) VALUES (
          DEFAULT, $1, $2, $3, $4, $5, $6
        )`,
        [org, principal.accountId, athleteId || null, message, response, new Date()]
      );
    } catch (auditError) {
      console.warn('Failed to log coach chat:', auditError);
      // Continue even if audit logging fails
    }

    return NextResponse.json({
      success: true,
      response,
      messageId,
      createdAt,
    });
  } catch (error) {
    console.error('Error in coach chat:', error);
    return NextResponse.json(
      {
        success: false,
        response: '',
        messageId: '',
        createdAt: new Date().toISOString(),
        error: 'Internal server error',
      },
      { status: 500 }
    );
  }
}
