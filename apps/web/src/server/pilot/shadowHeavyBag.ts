// shadowHeavyBag.ts — Heavy Bag Session Handler
// Executes deep reasoning sessions using the best available model via The Corner.
// Supports both synchronous (inline response) and asynchronous (job queue) execution.

import type { PilotRole } from './contracts';
import type { ShadowUserProfileRow } from './shadowUserProfile';
import type { ShadowContextOutput } from './shadowContextBuilder';
import type { ShadowClassification } from './shadowClassifier';
import { routeRequest, type ShadowSessionType, type RoutingDecision } from './shadowRouter';
import { enqueueJob } from './shadowJobQueue';
import { buildPersonalizationPrompt } from './shadowProfiling';
import type { ProfileTierResult } from './shadowProfiling';

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
        { role: 'user', content: input.message },
      ],
      temperature: routing.temperature,
      max_completion_tokens: routing.maxTokens,
    }),
  });

  if (!apiResponse.ok) {
    throw new Error(`Heavy Bag API error ${apiResponse.status}`);
  }

  const data = await apiResponse.json();
  const response = data.choices?.[0]?.message?.content ?? '';

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
    role: input.role,
    inputPayload: {
      message: input.message,
      athleteId: input.athleteId,
      sessionType: input.sessionType,
      complexity: input.classification.complexity,
      topic: input.classification.topic,
      contextSummary: input.contextOutput.context.slice(0, 500), // Truncated for job payload
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
 * Gold users get sync heavy bag. Others get async for board/scout tasks.
 */
export function shouldRunAsync(
  sessionType: ShadowSessionType,
  profileTier: string,
): boolean {
  // Always async for background tasks
  if (sessionType === 'scout_report' || sessionType === 'board_summary') return true;

  // Heavy bag: sync for Gold users (they expect fast deep responses),
  // async for others
  if (sessionType === 'heavy_bag') {
    return profileTier !== 'gold';
  }

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

  // Personalization (Gold tier only)
  const personalization = buildPersonalizationPrompt(input.userProfile, input.tierResult);
  if (personalization) {
    sections.push(personalization);
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
