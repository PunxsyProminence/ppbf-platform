// POST /api/pilot/athlete/chat endpoint
// Chat interface for athletes with role-based access control
// Supports athlete-specific queries around training, progression, and performance
// Personalized SHADOW: each athlete gets their own AI tuned to their goals and progress

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import { requireRole } from '@/src/server/pilot/access';
import { buildAzureAiChatCompletionsUrl, getAzureAiRuntimeConfig } from '@/src/server/pilot/azureAiRuntime';
import { buildPersonalShadowPrompt } from '@/src/server/pilot/shadowPersonalization';
import { updateShadowUserProfile } from '@/src/server/pilot/shadowUserProfile';

export interface AthleteChatRequest {
  message: string;
  context?: string;
  organizationId?: string;
}

export interface AthleteChatResponse {
  success: boolean;
  response: string;
  messageId: string;
  createdAt: string;
  error?: string;
}

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

export async function POST(request: NextRequest): Promise<NextResponse<AthleteChatResponse>> {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'athlete']);

    const body: AthleteChatRequest = await request.json();
    const { message, organizationId } = body;

    if (!message || !message.trim()) {
      return NextResponse.json(
        { success: false, response: '', messageId: '', createdAt: '', error: 'Message is required' },
        { status: 400 }
      );
    }

    const messageId = `msg_${Date.now()}`;
    const createdAt = new Date().toISOString();
    const org = organizationId || principal.organizationId;

    // Build personalized SHADOW prompt for this athlete
    const { systemPrompt } = await buildPersonalShadowPrompt(
      principal.accountId,
      org,
      'athlete',
      message,
    );

    // Call Azure OpenAI with personalized prompt
    const { response, success } = await callAzureOpenAI(systemPrompt, message);

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

    // Log to athlete_chat_audit table
    try {
      await query(
        `INSERT INTO pilot.athlete_chat_audit (
          athlete_chat_audit_id, organization_id, athlete_id, message, response, created_at
        ) VALUES (
          DEFAULT, $1, $2, $3, $4, $5
        )`,
        [org, principal.accountId, message, response, new Date()]
      );
    } catch (auditError) {
      console.warn('Failed to log athlete chat:', auditError);
      // Continue even if audit logging fails
    }

    // Update athlete's SHADOW profile
    try {
      const topicMatch = /\b(training|goal|performance|progress|recovery|strength)\b/i.exec(message);
      const topic = topicMatch ? topicMatch[1] : 'training';

      await updateShadowUserProfile(principal.accountId, org, {
        topicAdded: topic,
      });
    } catch (profileError) {
      console.warn('Failed to update SHADOW profile:', profileError);
      // Continue even if profile update fails
    }

    return NextResponse.json({
      success: true,
      response,
      messageId,
      createdAt,
    });
  } catch (error) {
    console.error('Error in athlete chat:', error);
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
