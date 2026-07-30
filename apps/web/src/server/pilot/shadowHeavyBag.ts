// shadowHeavyBag.ts — Heavy Bag Session Handler
// Executes deep reasoning sessions using the best available model via The Corner.
// Supports both synchronous (inline response) and asynchronous (job queue) execution.

import type { PilotRole } from './contracts';
import type { ShadowUserProfileRow } from './shadowUserProfile';
import type { ShadowContextOutput } from './shadowContextBuilder';
import type { ShadowClassification } from './shadowClassifier';
import { routeRequest, type ShadowSessionType, type RoutingDecision } from './shadowRouter';
import { enqueueJob } from './shadowJobQueue';
import type { ProfileTierResult } from './shadowProfiling';
import { budgetConversationHistory } from './shadowConversationHistory';

// Provider timeout is per-model and lives on the routing decision
// (MODEL_REGISTRY[...].timeoutMs in shadowRouter.ts), because the deployments
// differ by more than 3x in measured latency. A single shared constant here was
// previously 15s -- shorter than every available deployment's real response
// time, so Heavy Bag could not return a generated answer at all.

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HeavyBagInput {
  message: string;
  userId: string;
  organizationId: string;
  role: PilotRole;
  userProfile: ShadowUserProfileRow;
  tierResult: ProfileTierResult;
  contextOutput: ShadowContextOutput;
  classification: ShadowClassification;
  sessionType: ShadowSessionType;
  athleteId?: string;
  systemPromptBase: string;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface HeavyBagResult {
  mode: 'sync' | 'async';
  // Sync: full response inline
  response?: string;
  // Async: job ID for polling
  jobId?: string;
  routing: RoutingDecision;
  sessionType: ShadowSessionType;
}

// ─── Sync Execution ───────────────────────────────────────────────────────────

/**
 * Execute a Heavy Bag Session synchronously.
 * Used when the user is waiting for a response (< 15s acceptable wait).
 */
export async function executeHeavyBagSync(
  input: HeavyBagInput,
  azureEndpoint: string,
  azureApiKey: string,
): Promise<HeavyBagResult> {
  const routing = routeRequest(input.sessionType, input.role, input.classification.complexity);

  const systemPrompt = buildHeavyBagSystemPrompt(input, routing);

  const url = `${azureEndpoint.replace(/\/$/, '')}/openai/deployments/${routing.model.deploymentName}/chat/completions?api-version=${process.env.AZURE_AI_API_VERSION ?? '2024-12-01-preview'}`;

  const apiResponse = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': azureApiKey,
    },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt },
        ...budgetConversationHistory(input.conversationHistory ?? []).map((message) => ({
          role: message.role,
          content: message.content,
        })),
        { role: 'user', content: input.message },
      ],
      // Reasoning deployments reject any non-default temperature outright:
      //   HTTP 400 "Unsupported value: 'temperature' does not support 0.5 with
      //   this model. Only the default (1) value is supported." (measured
      //   0.5s, gpt-5.6-sol, 2026-07-30)
      // The catch in the chat route turns that into DEGRADED_RESPONSE, so
      // Heavy Bag failed instantly on every request -- independent of the
      // provider-timeout defect that used to mask it. The quick-round path
      // never sent temperature, which is why it worked and this didn't.
      ...(routing.model.isReasoningModel ? {} : { temperature: routing.temperature }),
      max_completion_tokens: routing.maxTokens,
    }),
    signal: AbortSignal.timeout(routing.model.timeoutMs),
  });

  if (!apiResponse.ok) {
    throw new Error(`Heavy Bag API request failed with status ${apiResponse.status}`);
  }

  const data = await apiResponse.json() as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const response = typeof data.choices?.[0]?.message?.content === 'string'
    ? data.choices[0].message.content.trim()
    : '';

  return {
    mode: 'sync',
    response,
    routing,
    sessionType: input.sessionType,
  };
}

/**
 * Execute a Heavy Bag Session asynchronously.
 * Used for scout reports, board summaries, library updates — long-running tasks.
 * Returns a jobId immediately; client polls /api/pilot/shadow/jobs/[jobId] for result.
 */
export async function executeHeavyBagAsync(input: HeavyBagInput): Promise<HeavyBagResult> {
  const routing = routeRequest(input.sessionType, input.role, input.classification.complexity);

  const jobId = await enqueueJob({
    jobType: sessionTypeToJobType(input.sessionType),
    organizationId: input.organizationId,
    accountId: input.userId,
    subjectId: input.athleteId ?? null,
    role: input.role,
    inputPayload: {
      requestMode: 'chat',
      message: input.message,
      athleteId: input.athleteId,
      sessionType: input.sessionType,
      complexity: input.classification.complexity,
      topic: input.classification.topic,
      authenticatedRole: input.role,
      authorizedContext: input.contextOutput.context.slice(0, 12_000),
      profileTier: input.tierResult.tier,
    },
    priority: priorityForSessionType(input.sessionType),
  });

  return {
    mode: 'async',
    jobId,
    routing,
    sessionType: input.sessionType,
  };
}

/**
 * Decide whether to run sync or async based on session type + profile tier.
 * Interactive Heavy Bag remains synchronous until a secure scheduled worker
 * is configured. Dedicated board/scout producers may still enqueue jobs once
 * that worker is enabled.
 */
export function shouldRunAsync(
  sessionType: ShadowSessionType,
  profileTier: string,
): boolean {
  // Always async for background tasks
  if (sessionType === 'scout_report' || sessionType === 'board_summary') return true;

  // Never strand an interactive Heavy Bag request in an unserviced queue.
  if (sessionType === 'heavy_bag') return false;

  void profileTier;
  return false;
}

// ─── Prompt Builders ──────────────────────────────────────────────────────────

function buildHeavyBagSystemPrompt(
  input: HeavyBagInput,
  routing: RoutingDecision,
): string {
  const sections: string[] = [input.systemPromptBase];

  // Depth instruction based on routing
  if (routing.systemPromptDepth === 'research') {
    sections.push(`
## Heavy Bag Session Instructions
You are in a **Heavy Bag Session** — full reasoning mode.
- Think step by step before answering
- Identify patterns, exceptions, and edge cases
- Reference evidence-based practices where applicable
- Surface open questions and research gaps
- Be thorough, not brief — the user has explicitly requested deep analysis`);
  } else if (routing.systemPromptDepth === 'full') {
    sections.push(`
## Extended Session Instructions
You are in an **extended coaching session**.
- Provide detailed, nuanced responses
- Consider multiple angles before recommending
- Note uncertainty where it exists`);
  }

  // Context block
  if (input.contextOutput.context) {
    sections.push(`\n## Session Context\n${input.contextOutput.context}`);
  }

  // Session metadata
  sections.push(`
## Request Metadata
- Session Type: ${input.sessionType.replaceAll('_', ' ')}
- Complexity Score: ${input.classification.complexity.toFixed(2)}
- Topic: ${input.classification.topic}
- Model: ${routing.model.displayName}
- Profile Tier: ${input.tierResult.config.label}`);

  return sections.join('\n');
}

// ─── Scout Report Generator ───────────────────────────────────────────────────

export interface ScoutReportInput {
  userId: string;
  organizationId: string;
  role: PilotRole;
  profile: ShadowUserProfileRow;
  tierResult: ProfileTierResult;
  recentInteractionSummary?: string;
}

export interface ScoutReport {
  userId: string;
  generatedAt: string;
  profileTier: string;
  summary: string;
  strengths: string[];
  growthAreas: string[];
  recommendedTopics: string[];
  openQuestions: string[];
  insightNotes: string;
}

/**
 * Generate a Scout Report — deep user intelligence document.
 * Eligibility: Gold tier users only.
 * Execution: Always async (enqueued as a recovery round job).
 */
export async function generateScoutReport(input: ScoutReportInput): Promise<{ jobId: string }> {
  const jobId = await enqueueJob({
    jobType: 'scout_report',
    organizationId: input.organizationId,
    accountId: input.userId,
    role: input.role,
    inputPayload: {
      requestMode: 'profile',
      authenticatedRole: input.role,
      profileTier: input.tierResult.tier,
      interactionCount: input.profile.interaction_count,
      recentTopics: input.profile.recent_topics,
      openQuestions: input.profile.open_questions,
      communicationStyle: input.profile.communication_style,
      rememberedFactCount: input.profile.remembered_facts?.length ?? 0,
      recentInteractionSummary: input.recentInteractionSummary ?? null,
    },
    priority: 2,
    ttlHours: 72,
  });

  return { jobId };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sessionTypeToJobType(
  sessionType: ShadowSessionType,
): import('./shadowJobQueue').JobType {
  const map: Record<ShadowSessionType, import('./shadowJobQueue').JobType> = {
    heavy_bag: 'heavy_bag_session',
    scout_report: 'scout_report',
    board_summary: 'board_summary',
    film_study: 'film_study',
    recovery_round: 'learning_loop',
    quick_round: 'heavy_bag_session',
  };
  return map[sessionType] ?? 'heavy_bag_session';
}

function priorityForSessionType(sessionType: ShadowSessionType): number {
  const priorities: Record<ShadowSessionType, number> = {
    heavy_bag: 1,      // User is waiting — high priority
    scout_report: 2,
    board_summary: 3,
    film_study: 2,
    recovery_round: 4,
    quick_round: 1,
  };
  return priorities[sessionType] ?? 3;
}
