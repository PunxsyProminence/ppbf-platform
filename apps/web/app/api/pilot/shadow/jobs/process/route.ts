// POST /api/pilot/shadow/jobs/process — Job Processor (Recovery Round Engine)
// Claims and executes one pending job per invocation.
// Triggered by: scheduled Azure Function timer, or manual admin call.
// Protected: platform_owner or internal BOOTSTRAP_KEY only.
import { NextResponse, type NextRequest } from 'next/server';
import { jsonError } from '@/src/server/pilot/http';
import { claimNextJob, completeJob, failJob, type JobType } from '@/src/server/pilot/shadowJobQueue';
import { SHADOW_SYSTEM_PROMPT, validateShadowResponse } from '@/src/server/pilot/shadowChat';
import { buildAzureAiChatCompletionsUrl, getAzureAiRuntimeConfig } from '@/src/server/pilot/azureAiRuntime';

export const runtime = 'nodejs';
export const maxDuration = 60; // Allow up to 60s for heavy reasoning tasks

interface JobProcessorResult {
  processed: boolean;
  jobId?: string;
  jobType?: string;
  durationMs?: number;
  error?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Internal auth: either session cookie platform_owner OR bootstrap key
  const bootstrapKey = request.headers.get('x-bootstrap-key');
  const expectedKey = process.env.PPBF_PILOT_BOOTSTRAP_KEY;
  if (!bootstrapKey || bootstrapKey !== expectedKey) {
    // Try session cookie fallback
    try {
      const { requirePrincipal } = await import('@/src/server/pilot/http');
      const { requireRole } = await import('@/src/server/pilot/access');
      const principal = await requirePrincipal(request);
      requireRole(principal, ['platform_owner', 'admin']);
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const url = new URL(request.url);
  const jobTypeFilter = url.searchParams.get('type') as JobType | null;

  const start = Date.now();
  try {
    const job = await claimNextJob(jobTypeFilter ?? undefined);

    if (!job) {
      return NextResponse.json({ processed: false } satisfies JobProcessorResult);
    }

    try {
      const output = await executeJob(job.jobType, job.inputPayload);
      await completeJob(job.jobId, output);

      return NextResponse.json({
        processed: true,
        jobId: job.jobId,
        jobType: job.jobType,
        durationMs: Date.now() - start,
      } satisfies JobProcessorResult);
    } catch (execError) {
      const msg = execError instanceof Error ? execError.message : String(execError);
      await failJob(job.jobId, msg);
      return NextResponse.json({
        processed: true,
        jobId: job.jobId,
        jobType: job.jobType,
        durationMs: Date.now() - start,
        error: msg,
      } satisfies JobProcessorResult, { status: 200 }); // 200 — job ran but errored
    }
  } catch (error) {
    return jsonError(error);
  }
}

// ─── Job Execution Handlers ────────────────────────────────────────────────

async function executeJob(
  jobType: JobType,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (jobType) {
    case 'heavy_bag_session':
      return executeHeavyBagJob(payload);
    case 'scout_report':
      return executeScoutReportJob(payload);
    case 'board_summary':
      return executeBoardSummaryJob(payload);
    case 'learning_loop':
      return executeLearningLoopJob(payload);
    case 'library_update':
      return { skipped: true, reason: 'Library updates handled via admin upload pipeline' };
    case 'film_study':
      return { skipped: true, reason: 'Film study requires vision model — quota pending' };
    default:
      throw new Error(`Unknown job type: ${jobType}`);
  }
}

async function callAI(systemPrompt: string, userMessage: string, maxTokens = 4096): Promise<string> {
  const runtime = getAzureAiRuntimeConfig();
  if (!runtime.ok || !runtime.config) {
    throw new Error(`Azure AI runtime not configured. Missing: ${runtime.missing.join(', ')}`);
  }

  const response = await fetch(buildAzureAiChatCompletionsUrl(runtime.config), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': runtime.config.apiKey },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.5,
      max_completion_tokens: maxTokens,
    }),
  });

  if (!response.ok) {
    throw new Error(`AI API error ${response.status}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? '';
}

function payloadToText(value: unknown, fallback: string): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function extractJsonObjectText(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start === -1) {
    return null;
  }

  const end = raw.lastIndexOf('}');
  if (end === -1 || end <= start) {
    return null;
  }

  return raw.slice(start, end + 1);
}

async function executeHeavyBagJob(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const message = payloadToText(payload.message, '');
  const sessionType = payloadToText(payload.sessionType, 'heavy_bag');
  const topic = payloadToText(payload.topic, 'general');
  const profileTier = payloadToText(payload.profileTier, 'bronze');

  const systemPrompt = `${SHADOW_SYSTEM_PROMPT}

## Heavy Bag Session (Background Processing)
You are in a **Heavy Bag Session** — full reasoning mode.
- Session type: ${sessionType}
- Topic area: ${topic}
- User profile tier: ${profileTier}
- Think through this carefully and thoroughly before responding.
- Identify patterns, evidence gaps, and actionable recommendations.`;

  const generatedResponse = await callAI(systemPrompt, message, 4096);
  const validation = validateShadowResponse(generatedResponse);

  return {
    response: validation.message,
    filtered: validation.filtered,
    requiresHumanReview: validation.requiresHumanReview,
    sessionType,
    topic,
    profileTier,
    processedAt: new Date().toISOString(),
  };
}

async function executeScoutReportJob(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const interactionCount = Number(payload.interactionCount ?? 0);
  const recentTopics = (payload.recentTopics as string[]) ?? [];
  const openQuestions = (payload.openQuestions as string[]) ?? [];
  const communicationStyle = payloadToText(payload.communicationStyle, 'unknown');
  const rememberedFactCount = Number(payload.rememberedFactCount ?? 0);

  const systemPrompt = `${SHADOW_SYSTEM_PROMPT}

## Scout Report Generation
Generate a structured Scout Report — a user intelligence document that helps SHADOW personalize future interactions.
Format your response as valid JSON matching this structure:
{
  "summary": "2-3 sentence overview",
  "strengths": ["strength1", "strength2"],
  "growthAreas": ["area1", "area2"],
  "recommendedTopics": ["topic1", "topic2"],
  "openQuestions": ["question1"],
  "insightNotes": "free-form observations"
}`;

  const userMessage = `Generate a Scout Report for a user with:
- ${interactionCount} total interactions
- Communication style: ${communicationStyle}
- Recent topics: ${recentTopics.join(', ') || 'none recorded'}
- Open questions: ${openQuestions.join('; ') || 'none recorded'}
- ${rememberedFactCount} remembered facts on file
- Summary from recent session: ${payloadToText(payload.recentInteractionSummary, 'N/A')}`;

  const generatedResponse = await callAI(systemPrompt, userMessage, 2048);
  const validation = validateShadowResponse(generatedResponse);
  const raw = validation.message;

  let report: Record<string, unknown>;
  try {
    const jsonText = extractJsonObjectText(raw);
    report = jsonText ? JSON.parse(jsonText) : { summary: raw, strengths: [], growthAreas: [], recommendedTopics: [], openQuestions: [], insightNotes: '' };
  } catch {
    report = { summary: raw, strengths: [], growthAreas: [], recommendedTopics: [], openQuestions: [], insightNotes: '' };
  }

  return {
    ...report,
    filtered: validation.filtered,
    requiresHumanReview: validation.requiresHumanReview,
    generatedAt: new Date().toISOString(),
    profileTier: payloadToText(payload.profileTier, 'gold'),
  };
}

async function executeBoardSummaryJob(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const systemPrompt = `${SHADOW_SYSTEM_PROMPT}

## Board Summary Generation
You are generating a governance/compliance summary for board members.
Be concise, accurate, and highlight items requiring board attention.
Format as structured markdown with clear section headers.`;

  const userMessage = `Generate a board summary for:
${JSON.stringify(payload, null, 2)}`;

  const generatedSummary = await callAI(systemPrompt, userMessage, 2048);
  const validation = validateShadowResponse(generatedSummary);
  return {
    summary: validation.message,
    filtered: validation.filtered,
    requiresHumanReview: validation.requiresHumanReview,
    generatedAt: new Date().toISOString(),
  };
}

async function executeLearningLoopJob(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  // Learning loop jobs are already handled synchronously via the feedback endpoint
  // This is a no-op passthrough that returns the payload for audit purposes
  return { processed: true, payload, note: 'Learning signals processed at feedback time' };
}
