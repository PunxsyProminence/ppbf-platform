// POST /api/pilot/individual/chat endpoint
// Chat interface for individual users (parent/guardian) with role-based access control
// Supports general queries around youth athletics, family engagement, and player development
// Personalized SHADOW: each parent/guardian gets their own AI tuned to their family's journey

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import { requireRole } from '@/src/server/pilot/access';
import { buildAzureAiChatCompletionsUrl, getAzureAiRuntimeConfig } from '@/src/server/pilot/azureAiRuntime';
import { buildPersonalShadowPrompt } from '@/src/server/pilot/shadowPersonalization';
import { updateShadowUserProfile } from '@/src/server/pilot/shadowUserProfile';

export interface IndividualChatRequest {
  message: string;
  context?: string;
}

export interface IndividualChatResponse {
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

export async function POST(request: NextRequest): Promise<NextResponse<IndividualChatResponse>> {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'parent']);

    const body: IndividualChatRequest = await request.json();
    const { message } = body;

    if (!message?.trim()) {
      return NextResponse.json(
        { success: false, response: '', messageId: '', createdAt: '', error: 'Message is required' },
        { status: 400 }
      );
    }

    const messageId = `msg_${Date.now()}`;
    const createdAt = new Date().toISOString();
    // Tenant identity is always derived from the authenticated principal --
    // never from client input -- so a caller cannot attribute chat activity
    // or SHADOW profile writes to an organization they don't belong to.
    const org = principal.organizationId;

    // Build personalized SHADOW prompt for this parent/individual
    const { systemPrompt } = await buildPersonalShadowPrompt(
      principal.accountId,
      org,
      'parent',
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

    // Log to individual_chat_audit table
    try {
      await query(
        `INSERT INTO pilot.individual_chat_audit (
          individual_chat_audit_id, organization_id, user_id, message, response, created_at
        ) VALUES (
          DEFAULT, $1, $2, $3, $4, $5
        )`,
        [org, principal.accountId, message, response, new Date()]
      );
    } catch (auditError) {
      console.warn('Failed to log individual chat:', auditError);
      // Continue even if audit logging fails
    }

    // Update parent/individual's SHADOW profile
    try {
      const topicMatch = /\b(athlete|development|support|progress|family|training)\b/i.exec(message);
      const topic = topicMatch ? topicMatch[1] : 'family-engagement';

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
    console.error('Error in individual chat:', error);
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
